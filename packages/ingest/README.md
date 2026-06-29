<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/ingest

> Ingestion pipeline for testing-os. Thin glue: dispatch → verifier → persist → indexes.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

Runs on the receiving side of the dogfood loop. Receives a submission (from a `repository_dispatch` payload or a file), validates it through `@dogfood-lab/verify`, persists the resulting record under `records/`, and rebuilds the read-side indexes (`latest-by-repo.json`, `failing.json`, `stale.json`).

## Install

```bash
npm install @dogfood-lab/ingest
```

## Usage — programmatic

The package exports two functions: `ingest` (verify + persist + rebuild indexes) and `verifyOnly` (verify + report where it *would* land, write nothing).

```js
import { ingest, verifyOnly } from '@dogfood-lab/ingest';
import { githubProvenance } from '@dogfood-lab/verify';

const submission = JSON.parse(/* the dispatch payload's submission object */);

const result = await ingest(submission, {
  repoRoot: process.cwd(),                  // testing-os repo root the record is written under
  provenance: githubProvenance(process.env.GITHUB_TOKEN), // provider adapter from @dogfood-lab/verify
});

result.record;     // the verified record (null if rejected or a duplicate)
result.path;       // where it was written (null if not written)
result.written;    // boolean — did a new record land on disk?
result.duplicate;  // boolean — was this run_id already persisted?
```

`verifyOnly(submission, options)` runs the same verification but never writes:

```js
const { record, would_persist_to, verify_only } = await verifyOnly(submission, { repoRoot, provenance });
// verify_only === true; would_persist_to is the path ingest() would have used.
```

## Usage — CLI

```bash
node packages/ingest/run.js --provenance=github --file submission.json
```

Flags:

- `--file <path>` / `--payload <path>` — the submission JSON to ingest (both spellings accepted).
- `--provenance=github` — confirm provenance against the GitHub Actions API (requires `GITHUB_TOKEN` / `GH_TOKEN`). **Production.**
- `--provenance=stub` — accept the claimed provenance without an API call. **Test/dev only — refused in CI.**
- `--verify-only` — verify and report, write nothing.

Standalone audit verb (no submission, no stdin, no `--provenance` — fully offline):

- `--verify-chain` — verify the append-only tamper-evident ledger at `indexes/integrity/chain.jsonl`: every record's recomputed digest matches both the ledger's claim and the record's self-claim, the `prev_digest` links are intact, and `seq` is monotonic. Exits `0` when the chain verifies, `1` on the first break (operator-legible output, no raw stack traces).
  - `--reconcile` — also walk `records/` and flag any record file whose `run_id`/`seq` is absent from the ledger (a torn persist that wrote the record but missed the ledger append). An orphan makes the audit exit `1` even with zero chain breaks.
  - `--all` — continue past the first per-record-independent break (digest-mismatch, missing-file) and report every break in one pass. A structural break (non-monotonic `seq`, broken `prev_digest`) still stops the walk. The default stops at the first break — the fail-fast CI gate.

Exit codes:

- `0` — the record was accepted (and, without `--verify-only`, persisted).
- `1` — the submission was verified but **not accepted** (rejected by a validator gate).
- `2` — an operator/runtime fault (missing/unreadable `--file`, missing `--provenance`, missing token in CI, downstream I/O failure). Every exit-2 path emits a structured `logStage('error', …)` event first so a log grep finds the cause.

There is no exit code 3.

## Pipeline stages

| Stage | Module | Output |
|---|---|---|
| 1. Load context | `load-context.js` | Reads existing `records/`, `policies/`, and prior indexes into memory |
| 2. Verify | delegates to `@dogfood-lab/verify` | A verdict: `accepted`, or `rejection_reasons[]` |
| 3. Persist | `persist.js` | Atomic write to `records/<org>/<repo>/YYYY/MM/DD/run-<run_id>.json` |
| 4. Rebuild indexes | `rebuild-indexes.js` | Regenerates `latest-by-repo.json`, `failing.json`, `stale.json` with crash-safe journaling |

Each stage emits a structured NDJSON event via `lib/log-stage.js` (carrying a `correlation_id`) so the ingest loop is observable end to end. Operator-facing faults carry a `code` / `message` / `hint` per the testing-os [error contract](https://dogfood-lab.github.io/testing-os/handbook/error-codes/).

## Concurrency + crash safety

- **Race-safe record claim:** `persist.js` claims the canonical record path with `openSync(path, 'wx')` (`O_EXCL`). The first writer wins; a concurrent writer for the same `run_id` loses the race and surfaces a `DuplicateRunIdError` — no torn or double-written record.
- **Atomic publication:** records and indexes are written to a temp file and `renameWithRetry`'d into place (the retry absorbs the Windows AV-scanner / lock handle-release window).
- **Crash-recovery for the index group:** the 3-index rebuild is a journaled commit-group; a crash mid-promote is reconciled by the next rebuild. A transiently-unreadable `records/` root or an empty scan over a previously-non-empty corpus is **refused** rather than allowed to overwrite good indexes with empty content (it emits an `index_rebuild_skipped` event instead).

## What testing-os ingest does NOT touch

- Consumer source code beyond what's referenced in the dispatch envelope
- Secrets beyond the dispatch payload's own fields
- Anything outside the testing-os repo's working tree

The receiver workflow runs with `contents: write` scoped to the testing-os repo only.

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
