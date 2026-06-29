/**
 * Stage C amend-wave regression guard for .github/workflows/ingest.yml
 * (PB-CI-003 stale-index annotation).
 *
 * Why this file exists:
 *
 * When packages/ingest/run.js persists a record but the subsequent index
 * rebuild throws, run.js does NOT fail — it logs a structured
 * `"failed_stage":"rebuild_indexes"` NDJSON event to STDERR and a
 * `console.error` "indexes/ may be stale until next ingest" warning, then
 * still returns `written:true` / `status:accepted`. (Confirmed by reading
 * run.js; the result JSON it prints to stdout carries no staleness field, so
 * the workflow cannot detect this from /tmp/ingest-result.json alone.)
 *
 * Consequence pre-amend: the ingest workflow commits the new record with a
 * STALE indexes/ tree and goes green with no operator signal. That is exactly
 * the "a partial/degraded run must SAY it degraded" humanization failure.
 *
 * Fix (workflow-side only — run.js is owned by another agent and must not be
 * edited): the ingestion steps capture run.js's stderr to a file, and a
 * dedicated step scans that capture for the rebuild-failure signal and emits a
 * `::warning::` so the stale-index commit shows on the run summary — mirroring
 * the push-retry `::warning::` discipline already in this file.
 *
 * Text-token assertions (no YAML parse), same rationale as the sibling
 * stage-check tests. Goes RED if the stderr capture or the staleness
 * `::warning::` annotation is dropped.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ingestPath = resolve(repoRoot, '.github/workflows/ingest.yml');

test('ingest.yml exists', () => {
  assert.ok(existsSync(ingestPath), `expected workflow at ${ingestPath}`);
});

test('PB-CI-003: run.js stderr is captured so the rebuild-failure signal survives for inspection', () => {
  const text = readFileSync(ingestPath, 'utf8');
  // The result JSON only captures stdout via `tee`; the staleness event is on
  // stderr. The workflow must capture stderr to a file so it can be scanned.
  assert.match(
    text,
    /ingest-stderr\.log/,
    'ingest.yml must capture run.js stderr to /tmp/ingest-stderr.log so the rebuild_indexes failure event can be detected (PB-CI-003) — the stdout result JSON carries no staleness field.',
  );
});

test('PB-CI-003: a step emits a ::warning:: when run.js signals a stale index (degraded run must SAY it degraded)', () => {
  const text = readFileSync(ingestPath, 'utf8');
  // The scan keys on the signal run.js actually emits: a structured
  // failed_stage:"rebuild_indexes" event and/or the "may be stale" warning.
  assert.match(
    text,
    /rebuild_indexes|may be stale/,
    'ingest.yml must scan for run.js\'s rebuild_indexes / "may be stale" staleness signal (PB-CI-003).',
  );
  assert.match(
    text,
    /::warning::[^\n]*stale|::warning::[^\n]*index/i,
    'ingest.yml must emit a ::warning:: when the stale-index signal is present so the degraded run shows on the summary (PB-CI-003) — mirroring the push-retry ::warning:: discipline.',
  );
});
