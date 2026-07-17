/**
 * roadmap.js — `swarm roadmap compile <run-id>` / `swarm roadmap show <run-id>`
 * (T1's CLI surface, F-338c8c46).
 *
 * Thin CLI wrapper + rendering (this domain's, swarm-cp-verbs', responsibility)
 * delegating the actual query/compile logic to a core-owned
 * `lib/roadmap/compiler.js` (swarm-cp-core's domain) — matching this
 * package's established commands/*.js-wraps-lib/*.js layering (verify.js
 * wraps lib/verify/registry.js; history.js wraps lib/wave-state-machine.js;
 * clean.js wraps lib/worktree.js).
 *
 * ============================================================================
 * SEAM (wave 39) — read before touching this file at merge time
 * ============================================================================
 * `../lib/roadmap/compiler.js` does NOT exist in this worktree. swarm-cp-core
 * lands `lib/roadmap/` in its OWN worktree this same wave (per this wave's
 * dispatch). This file is coded against the CONTRACT below, derived directly
 * from the dispatch doc's own T1/T2/T5/T6 language — not against a real,
 * mergeable module today. It is red-in-isolation (any invocation of `swarm
 * roadmap compile|show` throws Cannot-find-module) until core's module
 * lands; cli.js loads this file via a DYNAMIC import inside cmdRoadmap so
 * the seam is contained to invocation time and never breaks module-load for
 * any OTHER verb (see cli.js's cmdRoadmap for the isolation mechanism, and
 * this repo's own wave-35 cli-smoke precedent for the red-in-isolation/
 * green-at-merge pattern this mirrors).
 *
 * Expected exports from `lib/roadmap/compiler.js`:
 *
 *   compileRoadmapSections(db, runId, { gitRoot }) -> {
 *     openFindings: object[], deferredFindings: object[],
 *     approvedFindings: object[], drainQueue: object[],
 *     recurrenceStats: object, attention: { file: string, score: number }[]
 *   }
 *     The T1 factual sections (queries executed AT COMPILE TIME against the
 *     control-plane DB + git alone — never authored) plus T2's advisory,
 *     labeled, ranked top-K attention list and T6's drain-queue rollup.
 *     MUST be pure/side-effect-free (no writes) — this function only reads.
 *
 *   writeRoadmapArtifact(runId, artifact, { dbPath }) -> {
 *     path: string, latestPath: string, sequence: number
 *   }
 *     T5: versions supersede, nothing rewrites. Writes `dogfood/roadmap/
 *     <run-id>.json` (+ `latest.json`); recompiling within a run supersedes
 *     with a new sequence number. `dbPath` (not a pre-resolved directory) is
 *     passed through DELIBERATELY: F-338c8c46 itself flags the exact repo-
 *     namespacing shape of this path as an OPEN QUESTION for the coordinator/
 *     schemas domain to resolve, not swarm-cp-verbs to decide unilaterally —
 *     so this CLI layer hands over the raw ingredient (mirroring how
 *     `getOutputDir(runId)` derives ITS base dir from `dirname(getDbPath())`
 *     rather than a hardcoded repo-relative default, so a run against a
 *     custom SWARM_DB/test temp DB never pollutes the real tree) and lets
 *     core's compiler own the actual directory-resolution decision, exactly
 *     the same authority split as `compileRoadmapSections` above.
 *
 *   loadRoadmapArtifact(runId, { version, dbPath }) -> object | null
 *     Read-only. `version` omitted = latest. Returns null when nothing has
 *     been compiled yet for this run (NOT an error — `swarm roadmap show`
 *     on a fresh run is a legitimate, common state).
 *
 * If core's real module differs from this contract, reconciling THIS file
 * (not the note-validation logic in commands/lib/roadmap-notes.js, which has
 * no dependency on it at all) is the merge follow-up.
 * ============================================================================
 */

import { openDb } from '../db/connection.js';
import { readOperatorNotes, splitExpiredNotes, roadmapError } from './lib/roadmap-notes.js';
import { escapeReasonForDisplay, escapePathForDisplay } from './lib/escape-reason.js';
// SEAM: see this file's header. Does not exist in this worktree yet.
import { compileRoadmapSections, writeRoadmapArtifact, loadRoadmapArtifact } from '../lib/roadmap/compiler.js';
// F-1cd5de59's authored, run-ordinal drain-state half — additive to (never a
// replacement for) core's own two-halves compileDrainQueue, which lives
// inside compileRoadmapSections above and is left untouched.
import { compileAuthoredDrainState } from '../lib/roadmap/drain.js';

function requireRun(db, runId) {
  // created_at is load-bearing (deterministicNow below) — omitting it here
  // silently falls back to a live `new Date()` clock, exactly the wall-clock
  // non-determinism T1/F-feeaef78 exist to catch.
  const run = db.prepare('SELECT id, repo, local_path, created_at FROM runs WHERE id = ?').get(runId);
  if (!run) {
    throw roadmapError(
      'ROADMAP_RUN_NOT_FOUND',
      `roadmap: run not found: ${runId}`,
      'check `swarm runs` for the correct run id',
      { runId }
    );
  }
  return run;
}

/**
 * A deterministic stand-in for "now", derived from the run's OWN DB row
 * rather than the wall clock. T1's determinism promise ("same DB state ->
 * byte-identical artifact", pinned by F-feeaef78's cross-process test) is
 * incompatible with a live `new Date()` timestamp: two separate `swarm
 * roadmap compile` processes against the identical DB, run moments apart,
 * would otherwise never agree byte-for-byte. `runs.created_at` is fixed the
 * moment the row is inserted and never changes across repeated compiles of
 * the same run, so it is a legitimate "compiled at" stand-in that is still
 * genuinely DB-derived, not authored (F-feeaef78's own guidance: "derived
 * from the DB's own data... never datetime('now')"). Falls back to a live
 * clock only if the column is somehow unparseable — a defensive, undocumented
 * corner, not the normal path.
 */
function deterministicNow(run) {
  const parsed = new Date(run.created_at);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * `swarm roadmap compile <run-id>`
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} [opts.notesPath] — override for the operator-notes seed path
 * @returns {object} report — the compiled artifact + { sequence, path, currentPath, latestPath }
 */
export function compileRoadmap(opts) {
  const { runId, dbPath } = opts;
  if (!runId) throw new Error('roadmap compile: <run-id> is required');

  const db = openDb(dbPath);
  const run = requireRun(db, runId);
  const now = deterministicNow(run);

  // T3: fail-loud, CLI-layer note validation — BEFORE any core compile work,
  // matching this package's "validate every flag/input up front" discipline
  // (cmdAdjudicate's F-a7eb2d09 precedent).
  const { notesPath, notes } = readOperatorNotes(run.local_path, { notesPath: opts.notesPath });
  const { active, expired } = splitExpiredNotes(notes, now);

  const sections = compileRoadmapSections(db, runId, { gitRoot: run.local_path, now });
  const drainState = compileAuthoredDrainState(db, run);

  const artifact = {
    runId,
    repo: run.repo,
    compiledAt: now.toISOString(),
    // Flat, CLI-facing sections (F-1cd5de59/F-74ba2c79/F-8a97a700's own
    // pinned wire shape) — projections of the richer `sections` object
    // below, not a second independent compile. `sections` is kept
    // alongside for any consumer that wants core's full internal shape
    // (attention factors, both drain-queue halves, recurrence stats).
    notes: active,
    expired,
    attention: flattenAttention(sections.attention),
    drain: { entries: drainState.entries, overdue_ids: drainState.overdue_ids },
    sections,
    notesPath,
  };

  const written = writeRoadmapArtifact(runId, artifact, { dbPath });

  return {
    ...artifact,
    sequence: written.sequence,
    path: written.path,
    currentPath: written.currentPath,
    latestPath: written.latestPath,
  };
}

/**
 * Projects core's rich `{ advisory, churn_available, top: [{file,
 * attention_score, factors}], truncated, total_candidates }` shape (T2,
 * lib/roadmap/attention.js) down to the flat `[{file, score}]` list the
 * CLI-facing artifact and dispatch's roadmap-digest injection (F-8a97a700)
 * both consume. Never throws on a missing/malformed input — an absent
 * attention section (e.g. a artifact compiled before this field existed)
 * degrades to an empty list, matching this module's overall degrade-not-throw
 * posture for advisory-only content.
 */
function flattenAttention(attention) {
  if (!attention || !Array.isArray(attention.top)) return [];
  return attention.top.map((a) => ({ file: a.file, score: a.attention_score }));
}

/**
 * `swarm roadmap show <run-id> [--version=N]`
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {number} [opts.version]
 * @returns {object} report — `{ runId, compiled: false, version }` when
 *   nothing has been compiled yet, else `{ runId, compiled: true, ...artifact }`
 */
export function showRoadmap(opts) {
  const { runId, dbPath, version } = opts;
  if (!runId) throw new Error('roadmap show: <run-id> is required');

  const db = openDb(dbPath);
  requireRun(db, runId);

  const loaded = loadRoadmapArtifact(runId, { version, dbPath });
  if (!loaded) {
    return { runId, compiled: false, version: version ?? null };
  }
  return { runId, compiled: true, ...loaded };
}

function renderNotesSection(lines, notes) {
  if (!notes) return;
  if (notes.active && notes.active.length > 0) {
    lines.push('Operator notes:');
    for (const n of notes.active) {
      const enforcer = n.enforced_by ? ` (enforced_by: ${escapePathForDisplay(n.enforced_by)})` : '';
      lines.push(`  [${n.kind}] ${escapeReasonForDisplay(n.text)}${enforcer}`);
    }
    lines.push('');
  }
  // T3: "compile drops expired notes loudly (listed in output as EXPIRED,
  // not silently omitted)".
  if (notes.expired && notes.expired.length > 0) {
    lines.push('EXPIRED (dropped from this compile):');
    for (const n of notes.expired) {
      lines.push(`  [${n.kind}] ${escapeReasonForDisplay(n.text)} (expired ${escapeReasonForDisplay(String(n.expires))})`);
    }
    lines.push('');
  }
}

function renderAttentionSection(lines, attention) {
  if (!attention || attention.length === 0) return;
  // T2: "never a gate, never a predictor, never auto-blame" — the header is
  // unmissable in text (and JSON, per the pass contract's own refusal),
  // matching cmdRoadmap's --format=json branch, which emits the report
  // object (including this same `sections.attention` array) verbatim.
  lines.push('ADVISORY — NOT A GATE (per-file attention, top-K):');
  for (const a of attention) {
    lines.push(`  ${escapePathForDisplay(a.file)}  (score ${a.score})`);
  }
  lines.push('');
}

export function formatRoadmapCompile(report) {
  const lines = [];
  lines.push(`Roadmap compiled — run ${report.runId} (sequence ${report.sequence})`);
  lines.push(`  Artifact: ${escapePathForDisplay(report.path)}`);
  lines.push(`  Latest:   ${escapePathForDisplay(report.latestPath)}`);
  lines.push('');
  renderNotesSection(lines, { active: report.notes, expired: report.expired });
  renderAttentionSection(lines, report.attention);
  return lines.join('\n');
}

export function formatRoadmapShow(report) {
  if (!report.compiled) {
    const versionNote = report.version ? ` (version ${report.version})` : '';
    return `No roadmap compiled yet for run ${report.runId}${versionNote}.\n` +
      `Next: swarm roadmap compile ${report.runId}`;
  }
  const lines = [];
  lines.push(`Roadmap — run ${report.runId} (sequence ${report.sequence}, compiled ${report.compiledAt})`);
  lines.push('');
  renderNotesSection(lines, { active: report.notes, expired: report.expired });
  renderAttentionSection(lines, report.attention);
  return lines.join('\n');
}
