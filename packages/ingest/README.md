# @dogfood-lab/ingest

> Ingestion pipeline for testing-os. Thin glue: dispatch → verifier → persist → indexes.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

Runs on the receiving side of the dogfood loop. Receives `repository_dispatch` payloads from consumer repos, validates them through `@dogfood-lab/verify`, persists records under `records/`, and rebuilds the read-side indexes (`latest-by-repo.json`, `failing.json`, `stale.json`) atomically.

## Install

```bash
npm install @dogfood-lab/ingest
```

## Usage — programmatic

```js
import { run } from '@dogfood-lab/ingest';

const result = await run({
  payloadPath: './incoming.json',
  repoRoot: process.cwd(),
  provenance: 'github',
});

console.log(result.persisted_records);  // count of new records written
console.log(result.indexes_rebuilt);    // boolean
console.log(result.rejected);           // array of rejection reasons (if any)
```

## Usage — CLI

```bash
npx @dogfood-lab/ingest run --payload incoming.json --repo-root .
```

The CLI exits with structured exit codes:

- `0` — ok, all records persisted
- `1` — user error (bad payload shape, missing files, invalid args)
- `2` — runtime error (downstream validator failure, I/O failure)
- `3` — partial success (some records persisted, some rejected)

## Pipeline stages

| Stage | Module | Output |
|---|---|---|
| 1. Load context | `load-context.js` | Reads existing `records/`, `policies/`, prior indexes into memory |
| 2. Validate | delegates to `@dogfood-lab/verify` | Verdict per record: `ok` or `rejection_reasons[]` |
| 3. Persist | `persist.js` | Two-phase atomic write to `records/<repo>/<record-id>.yaml` |
| 4. Rebuild indexes | `rebuild-indexes.js` | Regenerates `latest-by-repo.json`, `failing.json`, `stale.json` with crash-safe journaling |

Each stage emits a structured event via `lib/log-stage.js` so the ingest loop is observable end-to-end. Failures at any stage carry a `code`, `message`, and `hint` per the testing-os structured error contract.

## Concurrency + crash safety

- **Per-repo locking**: advisory file lock via `@dogfood-lab/findings/lib/file-lock.js` — Windows-compatible (uses `linkSync` CAS, not `flock`).
- **Atomic two-phase commit**: `lib/atomic-write.js` writes to a `.tmp-<pid>.json` shadow first, then renames into place with `renameWithRetry` for Windows AV scanner handle-release windows.
- **Idempotent crash recovery**: `cleanupCrashedJournals` runs at every entry point; partial writes from previous crashes are detected and either completed or rolled back.

## What testing-os ingest does NOT touch

- Consumer source code beyond what's referenced in the dispatch envelope
- Secrets beyond the dispatch payload's own fields
- Anything outside the testing-os repo's working tree

The receiver workflow runs with `contents: write` scoped to the testing-os repo only.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
