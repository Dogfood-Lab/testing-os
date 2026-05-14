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
  for (const reason of result.rejection_reasons) {
    console.error(`[${reason.code}] ${reason.message}`);
    if (reason.hint) console.error(`  hint: ${reason.hint}`);
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

Each `rejection_reasons[]` entry follows the testing-os structured error shape:

```ts
{
  code: 'POLICY_GATE_FAILED' | 'SCHEMA_MISMATCH' | 'PROVENANCE_UNVERIFIED' | ...,
  message: string,
  path: string,        // JSON path to the offending field
  hint?: string,       // operator-facing remediation hint
}
```

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
