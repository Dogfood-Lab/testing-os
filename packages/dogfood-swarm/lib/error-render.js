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

import { renderPhaseList } from './phases.js';
import { displayWidth, sliceToDisplayWidth } from './display-width.js';

/**
 * F-14ee286b: fold a prefix+body pair to a TTY column budget with hanging
 * indent so soft-wrap continuations stay children of the ERROR header /
 * detail label instead of restarting at column 0 mid-path.
 *
 * @param {string} prefix — e.g. `ERROR [CODE]: ` or `  Next: `
 * @param {string} body
 * @param {number} [budget] — defaults to process.stderr.columns || 80
 */
export function foldErrorLine(prefix, body, budget) {
  if (budget == null || !Number.isFinite(budget) || budget <= 0) {
    // TTY: hang at the live column budget. Non-TTY (tests, piped logs): one
    // line so matchers and log-grep still see the full ERROR [CODE]: line.
    budget = (process.stderr?.isTTY && process.stderr.columns) || Number.POSITIVE_INFINITY;
  }
  const hangWidth = displayWidth(prefix);
  const hang = ' '.repeat(Math.max(hangWidth, 2));
  // Embedded newlines would otherwise leave only the first line carrying the
  // ERROR [CODE]: / detail label — flatten into one visual block under the hang.
  const flat = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');

  if (!flat) {
    console.error(prefix.replace(/\s+$/, '') || prefix);
    return;
  }

  let remaining = flat;
  let first = true;
  while (remaining.length > 0) {
    const lead = first ? prefix : hang;
    const avail = Math.max(1, budget - displayWidth(lead));
    if (displayWidth(remaining) <= avail) {
      console.error(lead + remaining);
      return;
    }

    let chunk = sliceToDisplayWidth(remaining, avail);
    const sp = chunk.lastIndexOf(' ');
    // Prefer a word break when the chunk is not tiny (avoids orphaning a
    // single character onto its own hang line).
    if (sp > 0 && displayWidth(chunk.slice(0, sp)) >= Math.min(8, avail)) {
      chunk = chunk.slice(0, sp);
    }
    if (!chunk) {
      chunk = [...remaining][0] || '';
    }
    console.error(lead + chunk);
    remaining = remaining.slice(chunk.length).replace(/^\s+/, '');
    first = false;
  }
}

/**
 * Render a thrown error to stderr at the CLI top-level seam.
 * @param {*} e — anything thrown
 */
export function renderTopLevelError(e, opts = {}) {
  if (!e || !e.code) {
    console.error(`ERROR: ${e?.message || String(e)}`);
    return;
  }

  const budget = opts.budget;
  // F-14ee286b: hang continuations under the column after `]: `.
  foldErrorLine(`ERROR [${e.code}]: `, e.message ?? '', budget);

  // F-76fc969b: path identity is a structured detail line, not header prose.
  if (e.path != null && e.path !== '') {
    foldErrorLine('  Path: ', String(e.path), budget);
  }

  const hint = e.hint || deriveHintForCode(e);
  if (hint) foldErrorLine('  Next: ', hint, budget);

  if (e.cause && e.cause.message) {
    foldErrorLine('  Caused by: ', e.cause.message, budget);
  }

  if (e.runId != null) foldErrorLine('  Run: ', String(e.runId), budget);
  if (e.waveId != null) foldErrorLine('  Wave: ', String(e.waveId), budget);
  if (e.agentRunId != null) foldErrorLine('  Agent run: ', String(e.agentRunId), budget);
  if (e.findingsAttempted != null) {
    foldErrorLine('  Findings attempted: ', String(e.findingsAttempted), budget);
  }
}

function deriveHintForCode(e) {
  switch (e.code) {
    case 'ISOLATION_FAILED':
      return 'run `git worktree list` to inspect existing worktrees, or re-dispatch without --isolate';
    case 'COLLECT_UPSERT_FAILED':
      return `wave ${e.waveId ?? '?'} has artifacts persisted but findings missing — inspect with \`swarm status\`, then re-run \`swarm collect\` once the underlying SQLite issue is resolved (busy_timeout or fingerprint UNIQUE collision)`;
    // F4-CP-03 / F5-07: control-plane.db written by a newer build than this
    // one. The remedy is to upgrade the tool, NOT touch the DB. The thrown
    // ControlPlaneSchemaTooNewError usually carries its own `.hint`; this
    // derived fallback covers a CONTROL_PLANE_SCHEMA_TOO_NEW that surfaces
    // without one.
    case 'CONTROL_PLANE_SCHEMA_TOO_NEW':
      return `the on-disk control-plane.db is schema v${e.onDiskVersion ?? '?'} but this build understands v${e.buildVersion ?? '?'} — pull the latest @dogfood-lab/dogfood-swarm so your build SCHEMA_VERSION >= the on-disk version, then re-run. Do NOT hand-edit or delete the DB; its state is the newer build's correctly migrated state, not corruption.`;
    // F-b69e26b3: dual-coverage fallback for ControlPlaneSchemaCorruptError —
    // ctor sets `.hint`, but a hand-shaped/JSON-round-tripped `{code}` does not.
    case 'CONTROL_PLANE_SCHEMA_CORRUPT':
      return 'kv.schema_version is not a finite number — the control-plane.db is corrupted or was hand-edited, not merely older/newer. Restore control-plane.db from a known-good backup, or remove it to bootstrap a fresh one (only if this run\'s history is not needed) — do not hand-write schema_version without reading db/migrate.js\'s ledger first.';
    // F-4b72faf9: CriterionIntentOverflowError now sets its own `.hint` by
    // default (lib/errors.js) — this derived fallback mirrors
    // CONTROL_PLANE_SCHEMA_TOO_NEW's dual-coverage pattern immediately above,
    // covering a CRITERION_INTENT_OVERFLOW that surfaces without one (e.g. a
    // hand-constructed or JSON-round-tripped error object that kept `.code`
    // but not the real class's constructor-set `.hint`).
    case 'CRITERION_INTENT_OVERFLOW':
      return `criterion ${e.criterionId ?? '<id>'} intent is ${e.headLength ?? '?'} chars over the ${e.maxChars ?? '?'}-char cap — shorten rubric.objective, split the criterion, or trim out_of_scope`;
    case 'RECORD_SCHEMA_INVALID':
      return 'inspect the failing record against packages/schemas/src/json/dogfood-record.schema.json and fix the invalid fields before re-ingesting';
    case 'AGENT_OUTPUT_SCHEMA_INVALID':
      return `inspect ${e.outputPath || 'the agent output JSON'} against packages/schemas/src/json/agent-output.schema.json and fix the invalid fields. Required at top level: domain, summary. Audit outputs add findings[]; feature outputs add features[]; amend outputs add fixes[] + files_changed[]. Then \`swarm revalidate ${e.runId ?? '<run-id>'} --reason "<text>" --domain=${e.domain ?? '<domain>'}:${e.outputPath ?? '<corrected.json>'} --apply\` to repair the blocked agent_run lawfully (dry-run without --apply)`;
    case 'DUPLICATE_RUN_ID':
      return 'a run with this id already exists — use a fresh run id or `swarm runs` to inspect the existing one';
    // D3B-003 (Wave A2 Stage C): dispatch precondition codes.
    case 'DISPATCH_RUN_NOT_FOUND':
      return 'check `swarm runs` for the correct run id, or `swarm init <repo>` to create a fresh run';
    case 'DISPATCH_DOMAINS_NOT_FROZEN':
      return `run \`swarm domains ${e.runId ?? '<run-id>'} --freeze\` after reviewing the domain map, or re-run dispatch with --auto-freeze`;
    case 'DISPATCH_NO_DOMAINS':
      return `run \`swarm domains ${e.runId ?? '<run-id>'} --add <name> --globs "[...]"\` then --freeze`;
    // d5-swarm-cli-001 (Stage A): phase typo caught as a pre-commit precondition.
    // The thrown DispatchPreconditionError usually carries its own `.hint`
    // enumerating the valid phases (e.runId/e.phase too); this derived fallback
    // covers any DISPATCH_INVALID_PHASE error that surfaces without a `.hint`.
    case 'DISPATCH_INVALID_PHASE':
      return `\`${e.phase ?? '<phase>'}\` is not a known phase — valid phases: ${renderPhaseList()}`;
    // F-b69e26b3: the three newer DispatchPreconditionError codes (documented
    // in errors.js JSDoc + opts.code union) were missing from this switch —
    // live dispatch.js sets `.hint` at throw sites, but a hint-less shaped
    // object got no Next:. Fallbacks mirror the live throw-site hints.
    case 'DISPATCH_NO_AGENT_DOMAINS':
      return `run \`swarm domains ${e.runId ?? '<run-id>'} --edit <name> --ownership owned\` (or --add a new owned/bridge domain) so at least one domain can carry an agent`;
    case 'DISPATCH_WAVE_IN_FLIGHT':
      return `finish the in-flight wave first: \`swarm collect ${e.runId ?? '<run-id>'}\` (or \`swarm resume ${e.runId ?? '<run-id>'}\` / \`swarm redrive <wave-id>\` / \`swarm rewind\` if it is unrecoverable)`;
    case 'DISPATCH_ROADMAP_DIGEST_NOT_FOUND':
      return `run \`swarm roadmap compile ${e.runId ?? '<run-id>'}\` first, or check \`swarm roadmap show ${e.runId ?? '<run-id>'}\``;
    // F-e0eebfec: BoundedJsonError dual-coverage (ctor sets `.hint`; shaped
    // `{code}` objects without one still need a Next: line).
    case 'BOUNDED_JSON_SIZE_LIMIT':
      return 'inspect the file (logging loop / raw stdout / wrong path), lower the producer output, or raise maxBytes only after confirming the content is legitimate';
    case 'BOUNDED_JSON_READ_FAILED':
      return 'inspect the path (existence, permissions, not a directory) and retry';
    case 'BOUNDED_JSON_PARSE_FAILED':
      return 'fix the JSON at the path (truncated write, trailing commas, or non-JSON content) and retry';
    // D3B-004 (Wave A2 Stage C): CLI globs JSON parse / shape failure.
    case 'CLI_INVALID_GLOBS_JSON':
      return 'pass --globs \'["packages/foo/**"]\' — wrap the JSON in single quotes so the shell preserves it, and use double quotes for each glob string';
    // d5-swarm-cli-002 (Stage A): malformed --threshold (now symmetric across
    // the space- AND equals-form). The thrown Error usually carries its own
    // `.hint`; this is the fallback for a `.hint`-less CLI_INVALID_THRESHOLD.
    case 'CLI_INVALID_THRESHOLD':
      return 'pass an integer >= 0, e.g. `--threshold 0` or `--threshold=3`';
    // d5-swarm-cli-003 (Stage A): out-of-enum --format value (or a swallowed
    // following flag). Fallback hint for a `.hint`-less CLI_INVALID_FORMAT.
    case 'CLI_INVALID_FORMAT':
      return 'pass one of: text, markdown, json — e.g. `--format json` or `--format=markdown`';
    // F-969074b9: DomainsInvalidOwnershipError dual-coverage fallback.
    case 'DOMAINS_INVALID_OWNERSHIP_CLASS':
      return `pass one of ${(e.valid && e.valid.length) ? e.valid.join('|') : 'owned|shared|bridge|coordinator'} — e.g. \`--ownership owned\``;
    default:
      return null;
  }
}
