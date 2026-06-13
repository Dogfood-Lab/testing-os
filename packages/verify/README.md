<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/verify

> Central verifier for testing-os. Validates submissions against schema and policy, produces persisted records.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

The verifier sits between dispatch and persist: every dogfood submission passes through here before it's written to `records/`. Returns a structured verdict (`ok` / `rejection_reasons[]`) so callers — including the `@dogfood-lab/ingest` pipeline — can decide whether to persist the record or surface the rejection to the operator.

## Install

```bash
npm install @dogfood-lab/verify
```

## Usage

```js
import { verify } from '@dogfood-lab/verify';

const result = verify(submission, {
  policy,
  schemas,        // from @dogfood-lab/schemas
  provenance: 'github',
});

if (!result.ok) {
  // rejection_reasons is an array of STRINGS with stable prefixes (see
  // "Error shape" below). Operators discriminate failure class via the
  // prefix; the rest of the string carries the human-readable detail.
  for (const reason of result.rejection_reasons) {
    console.error(reason);
  }
  process.exit(1);
}

// result.record is the persistable artifact
```

## Validators

`@dogfood-lab/verify/validators/*` ships discrete validators that can be composed or called directly:

| Validator | Purpose |
|---|---|
| `validators/schema.js` | JSON Schema check against `@dogfood-lab/schemas` (SHAPE gate) |
| `validators/schema-version.js` | `schema_version` VALUE gate — refuses an incompatible MAJOR against `SUPPORTED_SCHEMA_VERSIONS` |
| `validators/policy.js` | Per-repo policy compliance (prototype-pollution-safe deep merge) |
| `validators/provenance.js` | GitHub Actions run-ID confirmation via API (with timeout guard) |
| `validators/steps.js` | Step-by-step contract checks (gate accumulation, ordering) |
| `validators/verdict.js` | Final verdict synthesis from upstream validator results |

Import a single validator:

```js
import { validateSchema } from '@dogfood-lab/verify/validators/schema.js';
import { validateProvenance } from '@dogfood-lab/verify/validators/provenance.js';
```

## Submission envelope

The full envelope shape is defined by `@dogfood-lab/schemas` (`dogfood-record-submission.schema.json`). Minimum required fields:

```json
{
  "repo": "org/repo",
  "commit": "<git-sha>",
  "submitted_at": "2026-05-14T15:00:00Z",
  "records": [/* one or more dogfood-record envelopes */]
}
```

Provenance fields (`github_run_id`, `github_workflow_ref`) are required when `provenance: 'github'` is set. The verifier confirms the run ID against the GitHub Actions API before accepting.

## Error shape

`rejection_reasons[]` is an array of **strings** — the persisted-record schema (`dogfood-record.schema.json` → `verification.rejection_reasons`) enforces `items: { type: 'string' }`. Machine-readable discrimination happens via **stable string prefixes**.

### Prefix taxonomy

The verifier emits two prefix classes:

Discrimination happens by **class**, surfaced by `parseRejectionReason` (below). Every prefix maps to one of four classes: **submission-bad** (the submitter fixes the payload), **operational** (the verifier/tooling faulted), **ingest** (an ingest-side load fault), or **unknown** (unrecognized prefix).

**Submission-bad** — `class: 'submission-bad'` (the submitter's payload failed a validator gate; fix the submission and resubmit):

| Prefix | Source | Meaning |
|---|---|---|
| `schema:` | `validators/schema.js` | JSON Schema check on the submission/record envelope failed. The rest of the string carries the AJV path + message. |
| `policy:` | `validators/policy.js` | Per-repo policy gate failed (forbidden tags, missing required fields, surface evidence/CI requirements, etc.). |
| `steps[<id>]:` | `validators/steps.js` | Step-level contract check failed on a specific step id (gate accumulation, ordering, evidence shape). |
| `provenance:` | `validators/provenance.js` | The GitHub run-id confirmation could not match the submitted commit/repo at the GitHub API. |
| `repo:` | `index.js` cross-field guard | `submission.repo` does not match the owner/repo encoded in `source.run_url` (anti-forgery guard). Emitted as `repo:mismatch: …`. |
| `submission-contains-verifier-field:` | `index.js` | The submission carried a verifier-owned field (`policy_version`, `verification`, or an object `overall_verdict`) it must not author. |
| `CONTRACT_SCHEMA_TOO_NEW:` | `validators/schema-version.js` | The submission's `schema_version` declares a MAJOR **above** what this build supports (see `SUPPORTED_SCHEMA_VERSIONS` in `@dogfood-lab/schemas`). This build cannot understand a future contract — **the operator must upgrade testing-os**, but the routing class stays submission-bad (the payload as-shipped cannot be accepted by THIS build). |
| `CONTRACT_SCHEMA_TOO_OLD:` | `validators/schema-version.js` | The submission's `schema_version` declares a MAJOR **below** the supported floor. **The submitter must re-emit** against the current contract. A patch/minor delta inside the supported major range is NOT rejected. |

**Operational** — `class: 'operational'` (the validator itself threw an internal error; investigate the verifier, do NOT bounce to the submitter):

| Prefix | Source | Meaning |
|---|---|---|
| `VALIDATOR_FAULT_SCHEMA:` | `runValidator('schema', …)` catch | Internal exception inside the schema validator. The rest of the string carries the thrown `.message`. |
| `VALIDATOR_FAULT_POLICY:` | `runValidator('policy', …)` catch | Internal exception inside the policy validator. |
| `VALIDATOR_FAULT_STEPS:` | `runValidator('steps', …)` catch | Internal exception inside the steps validator. |
| `VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION:` | `runValidator('contract_schema_version', …)` catch | The version gate was called with an unknown contract key (a programmer error at the call site, not a submission fault). |

Any future `VALIDATOR_FAULT_<NEW>:` prefix is classified `operational` by family — `parseRejectionReason` matches the `VALIDATOR_FAULT_` head, so a new validator class needs no parser edit.

**Ingest** — `class: 'ingest'` (an ingest-side load fault, not a verifier gate):

| Prefix | Source | Meaning |
|---|---|---|
| `scenario-load:` | `packages/ingest/run.js` | A scenario referenced by `scenario_results` could not be loaded from the source repo (typed-reason: `timeout` / `not_found` / `parse_error` / `invalid_id`). |

### Operator hygiene

Discriminate by **class**, not by hand-rolled `.startsWith()` chains. `parseRejectionReason(reason)` returns `{ class, prefix, detail }`:

```js
import { parseRejectionReason } from '@dogfood-lab/verify';

for (const r of result.rejection_reasons) {
  const { class: cls, prefix, detail } =
    parseRejectionReason(r);
  switch (cls) {
    case 'operational':
      // Verifier-side fault. Page ops; do NOT bounce
      // back to the submitter as "fix your payload".
      notifyOps(prefix, detail);
      break;
    case 'submission-bad':
      // The payload failed a gate — surface to the
      // submitter so they fix it and resubmit.
      surfaceToSubmitter(prefix, detail);
      break;
    case 'ingest':
      // Ingest-side scenario fetch. The typed reason in
      // `detail` (timeout vs not_found/…) decides triage.
      triageScenarioLoad(detail);
      break;
    default: // 'unknown'
      // Unrecognized prefix — log + surface raw text.
      log.warn('unknown rejection_reason', r);
  }
}
```

Persistence note: every entry above is round-tripped verbatim through `verification.rejection_reasons` in the persisted-record JSON; the schema enforces `array of string` so any consumer of the audit-DB ground truth sees the same prefix vocabulary.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
