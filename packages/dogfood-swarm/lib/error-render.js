/**
 * error-render.js — Top-level CLI error rendering for typed errors.
 *
 * F-091578-001 (wave-17): the wave-12 typed-error infrastructure
 * (IsolationError, CollectUpsertError, plus wave-17 StateMachineRejectionError
 * and any RecordValidationError / DuplicateRunIdError that surface from
 * @dogfood-lab/ingest) carried structured fields — `code`, `cause`, `hint`,
 * `runId`, `waveId`, `findingsAttempted` — but the bare
 * `console.error('ERROR: ${e.message}')` flattened them all back to a single
 * line. Operators saw the symptom and lost every actionable hint.
 *
 * This renderer surfaces:
 *   - `e.code`     — stable identifier (e.g. ISOLATION_FAILED)
 *   - `e.message`  — operator-facing prose
 *   - `e.hint`     — what-to-do (StateMachineRejectionError sets this)
 *   - per-code derived hints for legacy errors that lack `.hint`
 *   - `e.cause`    — underlying error message (Caused by: ...)
 *   - `e.runId` / `e.waveId` / `e.agentRunId` — identity for log correlation
 *
 * Untyped errors keep the original loud single-line shape so log-grep
 * rituals still work.
 *
 * Lives in lib/ (not cli.js) so tests can import without triggering the
 * CLI's argv dispatch on module load.
 */

/**
 * Render a thrown error to stderr at the CLI top-level seam.
 * @param {*} e — anything thrown
 */
export function renderTopLevelError(e) {
  if (!e || !e.code) {
    console.error(`ERROR: ${e?.message || String(e)}`);
    return;
  }

  console.error(`ERROR [${e.code}]: ${e.message}`);

  const hint = e.hint || deriveHintForCode(e);
  if (hint) console.error(`  Next: ${hint}`);

  if (e.cause && e.cause.message) {
    console.error(`  Caused by: ${e.cause.message}`);
  }

  if (e.runId != null) console.error(`  Run: ${e.runId}`);
  if (e.waveId != null) console.error(`  Wave: ${e.waveId}`);
  if (e.agentRunId != null) console.error(`  Agent run: ${e.agentRunId}`);
  if (e.findingsAttempted != null) {
    console.error(`  Findings attempted: ${e.findingsAttempted}`);
  }
}

function deriveHintForCode(e) {
  switch (e.code) {
    case 'ISOLATION_FAILED':
      return 'run `git worktree list` to inspect existing worktrees, or re-dispatch without --isolate';
    case 'COLLECT_UPSERT_FAILED':
      return `wave ${e.waveId ?? '?'} has artifacts persisted but findings missing — inspect with \`swarm status\`, then re-run \`swarm collect\` once the underlying SQLite issue is resolved (busy_timeout or fingerprint UNIQUE collision)`;
    case 'RECORD_SCHEMA_INVALID':
      return 'inspect the failing record against packages/schemas/src/json/dogfood-record.schema.json and fix the invalid fields before re-ingesting';
    case 'DUPLICATE_RUN_ID':
      return 'a run with this id already exists — use a fresh run id or `swarm runs` to inspect the existing one';
    default:
      return null;
  }
}
