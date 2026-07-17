/**
 * compile.js — T1 roadmap compiler (F-874c0683,
 * docs/trajectory-and-closure.dispatch.md).
 *
 * "The roadmap is compiled, never authored." `compileRoadmap` is a PURE
 * function over an already-open db handle (matching lib/queries/cross-run-
 * analytics.js's own discipline) plus a `repoPath`/`repoRoot` for the
 * git-alone churn/drain signals. It performs no writes — no INSERT, no
 * filesystem write. The CLI verb that wraps this (commands/roadmap.js,
 * swarm-cp-verbs' domain) handles the artifact file write, `latest.json`
 * pointer, and the roadmap_artifacts DB row (see ./artifacts.js).
 *
 * Each T1 "factual section" maps to an already-built, independently-tested
 * piece — this module composes, it does not re-derive:
 *   - open/deferred/approved findings   -> direct SELECTs against `findings`
 *   - recurrence stats ("swarm trends internals") -> lib/queries/cross-run-
 *     analytics.js's queryRecurringFindings/queryFindingRecurrenceRate,
 *     called EXACTLY as cli.js's existing `swarm trends` verb already does
 *     (unfiltered by repo — matching that shipped convention, not a new one)
 *   - per-file process signals (T2)     -> ./attention.js#computeAttentionScores
 *   - grandfathered-manifest drain state (T6) -> ./drain.js#compileDrainQueue
 *   - operator notes (T3, the ONLY human-authored section) ->
 *     ./notes.js#validateOperatorNotes
 *
 * DETERMINISM (T1: "same DB state -> byte-identical artifact", pinned by
 * F-feeaef78's own planned cross-process test). Every SQL query below that
 * feeds an array into the artifact carries an explicit ORDER BY — SQLite
 * does not guarantee row order without one, and a JOIN/GROUP BY's physical
 * plan can vary even against byte-identical data. The single-row `runs`
 * lookup does not need one (.get() returns at most one row). The ONLY value
 * anywhere in the artifact that is a direct, unfiltered echo of `now` is
 * `run_anchored_at` (see its own field doc below for the rename and the
 * honesty fix, F-fdcf6c9b) — every other field is a pure function of (db
 * state, git state, operator notes, `now`). `now` is ALWAYS accepted as an
 * explicit, injectable parameter (never a bare `Date.now()`/`new Date()`
 * buried in a callee) specifically so a caller that needs two compiles to
 * agree byte-for-byte (the cross-process determinism proof, or a test) can
 * pin it to one identical value; the default `new Date()` only applies when
 * the caller supplies nothing.
 *
 * DEAD-CODE CLAIM, FACT-CHECKED AND REJECTED (F-e02e5bfd rider / F-c7b0f47b):
 * two wave-41 findings independently asserted this module is "imported only
 * by its own test... dead code in production besides" because
 * commands/roadmap.js imports compileRoadmapSections from ./compiler.js
 * rather than compileRoadmap from here directly. Verified false by reading
 * compiler.js itself: compileRoadmapSections is a two-line delegation that
 * calls compileRoadmap (this file, line ~58 of compiler.js) and forwards its
 * result. This module is one indirection layer, not zero callers — deleting
 * it would delete the only place T1's actual query logic lives. Do not
 * repeat this investigation a third time without re-reading compiler.js
 * first.
 */

import { queryRecurringFindings, queryFindingRecurrenceRate } from '../queries/cross-run-analytics.js';
import { computeAttentionScores } from './attention.js';
import { compileDrainQueue } from './drain.js';
import { validateOperatorNotes } from './notes.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — absolute repo path, used for the git
 *   churn probe (attention.js) and the grandfathered-manifest read
 *   (drain.js). Omitted → both degrade to their own documented
 *   unavailable/zero-signal shape rather than throwing.
 * @param {Array<object>} [opts.operatorNotes] — raw operator notes to
 *   validate (T3). See notes.js's header for where these are expected to
 *   come from (a decision this pass explicitly defers to the CLI-verb
 *   layer).
 * @param {number} [opts.sinceDays] — forwarded to computeAttentionScores /
 *   getChurnStats
 * @param {number} [opts.topK] — forwarded to computeAttentionScores
 * @param {number} [opts.staleWaveThreshold] — forwarded to compileDrainQueue
 * @param {Date} [opts.now] — injectable clock; see this module's own
 *   determinism note above.
 * @returns {{
 *   run_id: string,
 *   repo: string,
 *   run_anchored_at: string,
 *   findings: { open: object[], deferred: object[], approved: object[] },
 *   recurrence: { recurring_findings: object[], recurrence_rate: object },
 *   attention: ReturnType<typeof computeAttentionScores>,
 *   drain_queue: ReturnType<typeof compileDrainQueue>,
 *   operator_notes: { active: object[], expired: object[], dropped_invalid: object[] },
 * }}
 * @throws {Error} if `runId` does not exist in `runs`, or if
 *   `opts.operatorNotes` exceeds T3's 7-note cap (validateOperatorNotes'
 *   own fail-closed check).
 */
export function compileRoadmap(db, runId, opts = {}) {
  const {
    repoRoot,
    operatorNotes = [],
    sinceDays,
    topK,
    staleWaveThreshold,
    now = new Date(),
  } = opts;

  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
  if (!run) {
    throw new Error(`compileRoadmap: no run found with id ${JSON.stringify(runId)}`);
  }

  const openFindings = db.prepare(`
    SELECT finding_id, severity, category, file_path, status, filed_by_domain
    FROM findings
    WHERE run_id = ? AND status IN ('new', 'recurring', 'unverified')
    ORDER BY finding_id ASC
  `).all(runId);

  const deferredFindings = db.prepare(`
    SELECT finding_id, severity, category, file_path, filed_by_domain
    FROM findings
    WHERE run_id = ? AND status = 'deferred'
    ORDER BY finding_id ASC
  `).all(runId);

  const approvedFindings = db.prepare(`
    SELECT finding_id, severity, category, file_path, filed_by_domain
    FROM findings
    WHERE run_id = ? AND status = 'approved'
    ORDER BY finding_id ASC
  `).all(runId);

  const recurrence = {
    // Cross-run, unfiltered by repo — matches the existing `swarm trends`
    // verb's own call shape (cli.js) exactly. No new SQL, per F-874c0683's
    // own instruction.
    recurring_findings: queryRecurringFindings(db),
    recurrence_rate: queryFindingRecurrenceRate(db),
  };

  const attention = computeAttentionScores(db, runId, { repoPath: repoRoot, sinceDays, topK });
  const drainQueue = compileDrainQueue(db, runId, { repoRoot, now, staleWaveThreshold });
  const notesResult = validateOperatorNotes(operatorNotes, { repoRoot, now });

  return {
    run_id: runId,
    repo: run.repo,
    // F-fdcf6c9b: renamed from `generated_at`. HONEST SEMANTICS — this is
    // `now` verbatim, and on the production callpath (compiler.js's
    // compileRoadmapSections -> commands/roadmap.js's deterministicNow) `now`
    // is `runs.created_at`, never a live wall-clock read, specifically so two
    // compiles of the same DB state agree byte-for-byte (F-feeaef78). The old
    // name claimed to be "a compile-time stamp" — it never was, by design.
    // The GENUINE wall-clock moment this artifact version was actually
    // written lives in db/schema.js's `roadmap_artifacts.created_at`
    // (`DEFAULT (datetime('now'))`), queryable via
    // lib/roadmap/artifacts.js#latestRoadmapArtifact — a DB lookup, not a
    // field on this object, because embedding a second, genuinely
    // non-deterministic timestamp INTO this pure-function's return value
    // would itself defeat T1's byte-identity promise for identical DB state.
    run_anchored_at: now.toISOString(),
    findings: {
      open: openFindings,
      deferred: deferredFindings,
      approved: approvedFindings,
    },
    recurrence,
    attention,
    drain_queue: drainQueue,
    operator_notes: {
      active: notesResult.accepted,
      expired: notesResult.expired,
      dropped_invalid: notesResult.dropped_invalid_notes,
    },
  };
}
