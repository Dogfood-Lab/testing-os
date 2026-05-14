<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/findings

> Finding contract spine for testing-os. Validates, reads, lists, and queries evidence-bound findings — the fourth contract alongside record, scenario, and policy.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

Findings are the evidence-bound observations produced by dogfood runs. Each finding is anchored to a specific source line, carries severity (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`) and status (`open` / `fixed` / `regressed` / etc.) fields, and feeds the four-stage intelligence pipeline: **derive → review → synthesize → advise**.

## Install

```bash
npm install @dogfood-lab/findings
```

## CLI

```bash
npx @dogfood-lab/findings --help

# Derive findings from records
npx @dogfood-lab/findings derive --records-dir records/ --out findings/

# Review pipeline (apply state transitions, build event log)
npx @dogfood-lab/findings review --findings-dir findings/

# Synthesize patterns + recommendations + doctrine
npx @dogfood-lab/findings synthesize --findings-dir findings/

# Query / advise downstream consumers
npx @dogfood-lab/findings advise --topic <topic>
```

## Programmatic surface

```js
import { listFindings, readFinding } from '@dogfood-lab/findings/reader.js';
import { validateFinding } from '@dogfood-lab/findings/validate.js';

const findings = listFindings({ dir: './findings' });
const first = readFinding(findings[0].path);

const result = validateFinding(first);
if (!result.ok) {
  console.error(result.errors);
}
```

## Pipeline stages

| Stage | Module | Output |
|---|---|---|
| Derive | `derive/derive-findings.js` | New finding files under `findings/`; deduplication via `derive/dedupe.js` |
| Review | `review/review-engine.js` | Status transitions + `event-log.jsonl` audit trail |
| Synthesize | `synthesis/pattern-derivation.js`, `synthesis/recommendation-derivation.js`, `synthesis/doctrine-derivation.js` | Pattern, recommendation, doctrine artifacts |
| Advise | `advise/advice-bundle.js`, `advise/query.js` | Advisory bundles for downstream consumers (e.g., `@dogfood-lab/dogfood-swarm`) |

## Finding shape

```yaml
finding_id: F-XXXXXX-XXX
severity: HIGH
status: open
title: <short imperative-mood phrase>
evidence:
  source_pin: { file: <path>, line: <n>, snippet: <verbatim> }
  test_pin: { file: <path>, line: <n>, name: <test-name> }
remediation:
  approach: <strategy>
  rationale: <why>
```

Full shape: `@dogfood-lab/schemas/json/dogfood-finding.schema.json`.

## Atomic I/O (shared discipline)

Internal helpers under `lib/`:

- `atomic-write.js` — two-phase commit for finding-file writes (`writeFileSync` to shadow → `renameSync` to canonical)
- `file-lock.js` — cross-process advisory lock via `linkSync` CAS, Windows-compatible
- `rename-with-retry.js` — bounded retry on EPERM/EBUSY (Windows AV scanner handle-release window)

These helpers are intentionally shared cross-package discipline. They're exported via the `./lib/*` subpath so `@dogfood-lab/dogfood-swarm` and `@dogfood-lab/ingest` can reuse the same atomic-write semantics. The CLAUDE.md in the repo root documents the cycle this creates and why it's accepted.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
