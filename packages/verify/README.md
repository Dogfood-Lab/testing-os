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
| `validators/schema.js` | JSON Schema check against `@dogfood-lab/schemas` |
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

**Submission-bad** (the submitter's payload failed a validator gate — the operator should fix the submission and resubmit):

| Prefix | Source | Meaning |
|---|---|---|
| `schema:` | `validators/schema.js` | JSON Schema check on the submission/record envelope failed. The rest of the string carries the AJV path + message. |
| `policy:` | `validators/policy.js` | Per-repo policy gate failed (forbidden tags, missing required fields, version-floor violation, etc.). |
| `steps[<id>]:` | `validators/steps.js` | Step-level contract check failed on a specific step id (gate accumulation, ordering, evidence shape). |
| `provenance:` | `validators/provenance.js` | The GitHub run-id confirmation could not match the submitted commit/repo at the GitHub API. |
| `scenario-load:` | `packages/ingest/load-context.js` | A scenario referenced by `scenario_results` could not be loaded from the source repo (typed-reason: `timeout` / `not_found` / `parse_error` / `invalid_id`). |

**Validator-crashed** (the validator itself threw an internal error — this is an operational fault, NOT submission-bad; the operator should investigate the verifier itself):

| Prefix | Source | Meaning |
|---|---|---|
| `VALIDATOR_FAULT_SCHEMA:` | `runValidator('schema', …)` catch | Internal exception inside the schema validator. The rest of the string carries the thrown `.message`. |
| `VALIDATOR_FAULT_POLICY:` | `runValidator('policy', …)` catch | Internal exception inside the policy validator. |
| `VALIDATOR_FAULT_STEPS:` | `runValidator('steps', …)` catch | Internal exception inside the steps validator. |

### Operator hygiene

```js
// Discriminate by prefix
for (const r of result.rejection_reasons) {
  if (r.startsWith('VALIDATOR_FAULT_')) {
    // Operational incident — verifier-side. Page someone; do NOT route
    // back to the submitter as a "fix your payload" message.
    notifyOps(r);
  } else if (r.startsWith('schema:') || r.startsWith('policy:') || r.startsWith('steps[')) {
    // Submission-bad — surface to the submitter.
    surfaceToSubmitter(r);
  } else if (r.startsWith('provenance:')) {
    // May be either class — GitHub API timeouts are operational; a real
    // commit/repo mismatch is submission-bad. The string detail carries
    // the discriminator.
    triageProvenance(r);
  } else if (r.startsWith('scenario-load:')) {
    // Ingest-side: scenario fetch reason determines class. timeout is
    // operational; not_found / parse_error / invalid_id are submission-bad.
    triageScenarioLoad(r);
  } else {
    // Unknown prefix — log and surface as raw text.
    log.warn('unknown rejection_reason prefix', r);
  }
}
```

Persistence note: every entry above is round-tripped verbatim through `verification.rejection_reasons` in the persisted-record JSON; the schema enforces `array of string` so any consumer of the audit-DB ground truth sees the same prefix vocabulary.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
