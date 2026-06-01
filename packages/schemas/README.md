<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/schemas

> JSON schemas for the testing-os contract spine — record, finding, pattern, recommendation, doctrine, policy, scenario, submission.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

This package ships the 8 canonical JSON Schemas (2020-12 dialect) that the testing-os contract spine validates against. Every record, finding, pattern, recommendation, doctrine artifact, policy file, scenario definition, and submission envelope produced by the rest of the monorepo conforms to one of these schemas. Consumer packages (`@dogfood-lab/verify`, `@dogfood-lab/findings`, `@dogfood-lab/report`) load the schemas via the `./json/*` subpath export and compile them with `ajv`.

## Install

```bash
npm install @dogfood-lab/schemas
```

## The 8 Schemas

| Schema file | Purpose |
|---|---|
| `dogfood-record.schema.json` | Persisted test/audit record produced by dogfood runs |
| `dogfood-record-submission.schema.json` | Envelope shape `repository_dispatch` payloads must match |
| `dogfood-finding.schema.json` | Evidence-bound finding contract — anchored to source line + severity + status |
| `dogfood-pattern.schema.json` | Reusable pattern derived from findings (synthesis layer) |
| `dogfood-recommendation.schema.json` | Recommendation derived from patterns |
| `dogfood-doctrine.schema.json` | Doctrine artifact synthesized from patterns + recommendations |
| `policy.schema.json` | Per-repo policy YAML shape (gate accumulation, severity thresholds) |
| `scenario.schema.json` | Scenario definition shape (what gets tested + how) |

## Usage — TypeScript surface

The package exports `validatePayload` and the compiled validators. `validatePayload(name, payload)` takes the **schema name first** (one of `record`, `recordSubmission`, `finding`, `pattern`, `recommendation`, `doctrine`, `policy`, `scenario` — all camelCase, NOT the file basename) and the payload second. The return shape is `{ valid: boolean, errors: ValidationError[] }` — each error carries `path`, `message`, `keyword` (the Ajv rule that fired, e.g. `required` / `pattern` / `enum`), and optional `params`.

```ts
import { validatePayload } from '@dogfood-lab/schemas';

const result = validatePayload('recordSubmission', submission);
if (!result.valid) {
  console.error('schema mismatch:', result.errors);
  process.exit(1);
}
```

`compileSchema(name)` returns the raw Ajv `ValidateFunction` for advanced cases (custom error formatting, direct `validate.errors` inspection). Sibling packages (`@dogfood-lab/verify`, `@dogfood-lab/findings`, `@dogfood-lab/ingest`, `@dogfood-lab/report`) all delegate to `validatePayload` — collapsing N Ajv instances to one per schema per process via the module-scope `validatorCache`.

## Usage — Raw JSON schemas

The raw schema files are available via the `./json/*` subpath export. Use `createRequire` to load them at runtime:

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const recordSchema = require('@dogfood-lab/schemas/json/dogfood-record.schema.json');
const findingSchema = require('@dogfood-lab/schemas/json/dogfood-finding.schema.json');
```

Or with import attributes (Node 22+):

```js
import recordSchema from '@dogfood-lab/schemas/json/dogfood-record.schema.json' with { type: 'json' };
```

## Compatibility

| | Constraint |
|---|---|
| JSON Schema dialect | 2020-12 |
| Node | ≥ 20 |
| `$id` form | `https://github.com/dogfood-lab/testing-os/packages/schemas/src/json/<name>.schema.json` |

`$id` is a contract field. Changes that consumers should treat as contract changes bump the monorepo's lockstep version.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
