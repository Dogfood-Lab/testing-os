/**
 * compile.js — T1 roadmap compiler (F-874c0683,
 * docs/trajectory-and-closure.dispatch.md), conformed to Amendment 3
 * (wave 42/43) — "the schema is the contract."
 *
 * "The roadmap is compiled, never authored." `compileRoadmap` is a PURE
 * function over an already-open db handle (matching lib/queries/cross-run-
 * analytics.js's own discipline) plus a `repoPath`/`repoRoot` for the
 * git-alone churn/drain signals. It performs no writes — no INSERT, no
 * filesystem write. The CLI verb that wraps this (commands/roadmap.js,
 * swarm-cp-verbs' domain) handles the artifact file write, `latest.json`
 * pointer, and the roadmap_artifacts DB row (see ./artifacts.js).
 *
 * Each schema-required section maps to an already-built, independently-tested
 * piece — this module composes, it does not re-derive:
 *   - open_summary                      -> COUNT(*) against `findings`
 *   - compiled_from.commit_sha          -> runs.commit_sha (one SELECT,
 *     the same row already fetched for run_id/repo below)
 *   - recurrence_stats                  -> lib/queries/cross-run-
 *     analytics.js's queryRecurringFindings/queryFindingRecurrenceRate,
 *     called EXACTLY as cli.js's existing `swarm trends` verb already does
 *     (unfiltered by repo — matching that shipped convention, not a new one)
 *   - attention (T2)                    -> ./attention.js#computeAttentionScores
 *   - drain_queue (T6)                  -> ./drain.js#compileAuthoredDrainState
 *   - grandfathered_drain (A3.2b)       -> ./drain.js#compileGrandfatherManifestDrainState
 *
 * OPERATOR NOTES (A3.4, coordinator relay wave 43 — precision pass over an
 * earlier, too-broad reading of this same instruction). `commands/lib/
 * roadmap-notes.js` (the LIVE, fail-closed, F-74ba2c79-pinned path, and —
 * verified this wave — the direct import target of ~17 further pinned
 * subtests in wave39-4091637-5127-swarm-cp-pins.test.js) is the ONE
 * surviving notes-VALIDATION module: `readOperatorNotes` reads the seed file
 * and throws on any malformed note (bad kind, missing text, invariant with
 * no enforced_by, an enforced_by that doesn't resolve on disk, >7 notes) —
 * VERIFIED this wave by direct re-read of that file (out of this domain's
 * globs, read-only). Everything past that point — accept an
 * ALREADY-VALIDATED array, split active vs. expired — is what T3 assigns
 * to the COMPILE layer ("compile MUST drop expired notes LOUDLY"), so it
 * stays here. This file previously carried a SECOND, fail-open, full
 * REVALIDATING implementation (./notes.js#validateOperatorNotes, deleted
 * this wave) — THAT duplication, not notes participation in general, is
 * what A3.4 ends. `splitExpiredNotes` below is a necessary, minimal,
 * behavior-matched duplicate of commands/lib/roadmap-notes.js's own
 * same-named function (lib/** may never import commands/**, so an identical
 * leaf-level expiry check on both sides of that layering boundary is
 * unavoidable, not a second validation engine) — same lenient `Date.parse`
 * boundary, same `now >= parsed` inclusivity, verified against that file's
 * source text this wave. The `note.text`-guard on the loop below is a THIN
 * defensive shape check, not re-validation — every note the CLI's own
 * readOperatorNotes has already passed is well-formed by construction; the
 * guard exists only for a direct caller of `compileRoadmap` (a test, or a
 * future non-CLI caller) that does not route through that validator first.
 *
 * ALSO NOT this module's concern (A3.5): the 36-entry allowlist overdue
 * listing (drain.js#compileGrandfatheredManifestDrain) and the unroutable-
 * approved advisory (drain.js#compileUnroutableApprovedDrain) are named
 * residuals — surfaced by `swarm roadmap show` + the T4 digest, never
 * persisted into this artifact.
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
 * state, git state, `now`). `now` is ALWAYS accepted as an explicit,
 * injectable parameter (never a bare `Date.now()`/`new Date()` buried in a
 * callee) specifically so a caller that needs two compiles to agree
 * byte-for-byte (the cross-process determinism proof, or a test) can pin it
 * to one identical value; the default `new Date()` only applies when the
 * caller supplies nothing.
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
import { compileAuthoredDrainState, compileGrandfatherManifestDrainState } from './drain.js';

/**
 * Split ALREADY-VALIDATED notes into active vs. expired. Deliberately NOT a
 * re-export of commands/lib/roadmap-notes.js#splitExpiredNotes (lib/** may
 * never import commands/**\ — see this module's header) but IS
 * behavior-matched to it: same lenient `Date.parse(note.expires)`, same
 * `now.getTime() >= parsed` inclusive boundary (an expires date of exactly
 * today is already expired, matching that file's own docstring: "an entry
 * whose date is TODAY is already due"). A note whose `expires` does not
 * parse (missing, or the disclosed-unimplemented "<N runs>" form) is
 * treated as non-expiring — never silently misread as expired or dropped.
 *
 * @param {object[]} notes
 * @param {Date} now
 * @returns {{ active: object[], expired: object[] }}
 */
function splitExpiredNotes(notes, now) {
  const active = [];
  const expired = [];
  for (const note of notes) {
    // Thin shape guard, not re-validation (see this module's header) — a
    // note this malformed should never reach here through the real CLI
    // path (readOperatorNotes already refused it), but a direct
    // compileRoadmap caller that skips validation gets a defensive skip
    // rather than a raw TypeError on `note.expires`.
    if (!note || typeof note !== 'object') continue;
    const parsed = typeof note.expires === 'string' ? Date.parse(note.expires) : NaN;
    if (!Number.isNaN(parsed) && now.getTime() >= parsed) {
      expired.push(note);
    } else {
      active.push(note);
    }
  }
  return { active, expired };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — absolute repo path, used for the git
 *   churn probe (attention.js) and the grandfather-manifest read
 *   (drain.js). Omitted → both degrade to their own documented
 *   unavailable/zero-signal shape rather than throwing.
 * @param {Array<object>} [opts.operatorNotes] — ALREADY-VALIDATED operator
 *   notes (commands/lib/roadmap-notes.js#readOperatorNotes is the fail-closed
 *   validator every real CLI compile routes through first; see this
 *   module's own header). This function only splits active vs. expired —
 *   it does not re-validate kind/text/enforced_by.
 * @param {number} [opts.sinceDays] — forwarded to computeAttentionScores /
 *   getChurnStats
 * @param {number} [opts.topK] — forwarded to computeAttentionScores
 * @param {Date} [opts.now] — injectable clock; see this module's own
 *   determinism note above.
 * @returns {{
 *   run_id: string,
 *   repo: string,
 *   run_anchored_at: string,
 *   compiled_from: { commit_sha: string },
 *   open_summary: { open: number, deferred: number, approved: number },
 *   recurrence_stats: { top_recurring: object[], recurrence_rate: object },
 *   attention: { advisory: true, items: object[] },
 *   grandfathered_drain: { frozen_total: number, drained: number, outstanding: object[] },
 *   drain_queue: { entries: object[], overdue_ids: string[] },
 *   operator_notes: object[],
 *   expired_notes: object[],
 * }}
 * @throws {Error} if `runId` does not exist in `runs`.
 */
export function compileRoadmap(db, runId, opts = {}) {
  const {
    repoRoot,
    operatorNotes = [],
    sinceDays,
    topK,
    now = new Date(),
  } = opts;

  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
  if (!run) {
    throw new Error(`compileRoadmap: no run found with id ${JSON.stringify(runId)}`);
  }

  // A3.1: counts, not the finding rows themselves — no consumer (grepped,
  // production code only) ever read the pre-Amendment-3 `findings.open/
  // deferred/approved` arrays this replaced; the schema's `open_summary`
  // section is integers only (additionalProperties:false, three required
  // keys), so a COUNT query is both the schema-exact shape and less work
  // than fetching-then-discarding full rows.
  const openCount = db.prepare(`
    SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND status IN ('new', 'recurring', 'unverified')
  `).get(runId).n;
  const deferredCount = db.prepare(`
    SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND status = 'deferred'
  `).get(runId).n;
  const approvedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND status = 'approved'
  `).get(runId).n;

  const recurrenceStats = {
    // Cross-run, unfiltered by repo — matches the existing `swarm trends`
    // verb's own call shape (cli.js) exactly. No new SQL, per F-874c0683's
    // own instruction. `top_recurring` is the schema's chosen name
    // (dogfood-roadmap.schema.json's own description: "Mirrors
    // queryRecurringFindings()'s actual return shape... rather than
    // redefining it independently") — renamed from this field's
    // pre-Amendment-3 `recurring_findings` name, same query, same shape.
    // `recurrence_rate` is additive (the section is additionalProperties:
    // true) — kept because `swarm trends` already surfaces both together.
    top_recurring: queryRecurringFindings(db),
    recurrence_rate: queryFindingRecurrenceRate(db),
  };

  // attention.js's own return is intentionally richer than the schema's
  // `attention` object (`churn_available`/`truncated`/`total_candidates`
  // stay useful for other callers, e.g. `swarm roadmap show` — see that
  // module's header). Narrowed here to the schema-exact `{advisory, items}`
  // pair for the persisted artifact — the same "richer raw function,
  // narrower artifact wiring" pattern used for drain_queue below.
  const attentionResult = computeAttentionScores(db, runId, { repoPath: repoRoot, sinceDays, topK });

  // A3.2a: drain_queue = {entries, overdue_ids}, sourced directly from
  // compileAuthoredDrainState (T6's runs-ordinal cadence mechanism) —
  // dropping that function's own `available` flag, which has no home in
  // the schema's drain_queue shape (additionalProperties:false, exactly
  // entries + overdue_ids). compileDrainQueue's OLDER 4-part composition
  // (grandfathered_manifest[36-entry allowlist] / deferred_findings /
  // deferred_findings_scope_note / unroutable_approved) is deliberately NOT
  // called here anymore — per A3.5 those three are named residuals for
  // `swarm roadmap show` + the digest, never persisted. compileDrainQueue
  // itself is untouched and still exported for that use.
  const authoredDrainState = compileAuthoredDrainState(db, run);

  // A3.2b: grandfathered_drain = {frozen_total, drained, outstanding} over
  // the 256-entry FROZEN manifest (scripts/grandfathered-pins.json) — NOT
  // the 36-entry allowlist compileDrainQueue reads. See
  // compileGrandfatherManifestDrainState's own doc comment (drain.js) for
  // the frozen_total constant and the EXPECTED_GRANDFATHER_MANIFEST_HASH
  // coverage proof this design depends on.
  const grandfatherDrainState = compileGrandfatherManifestDrainState(repoRoot);

  // A3.4: split, don't validate — see splitExpiredNotes' own doc comment
  // and this module's header.
  const notesResult = splitExpiredNotes(Array.isArray(operatorNotes) ? operatorNotes : [], now);

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
    //
    // A3.3: the schema's own top-level field is named `compiled_at`, but
    // this internal name (`run_anchored_at`) is PINNED and stays — the
    // envelope (commands/roadmap.js) derives `compiled_at` FROM this value
    // rather than recomputing `now.toISOString()` a second time, so the two
    // never drift apart.
    run_anchored_at: now.toISOString(),
    // A3.1: `compiled_from.commit_sha` from `runs.commit_sha` — the SAME row
    // already fetched above for run_id/repo, so this is genuinely "one
    // SELECT," not a second query. `runs.commit_sha` is `NOT NULL` and
    // always a full 40-hex `git rev-parse HEAD` value (commands/init.js) —
    // matches the schema's `^[0-9a-f]{40}$` pattern by construction.
    compiled_from: { commit_sha: run.commit_sha },
    open_summary: {
      open: openCount,
      deferred: deferredCount,
      approved: approvedCount,
    },
    recurrence_stats: recurrenceStats,
    attention: { advisory: attentionResult.advisory, items: attentionResult.items },
    grandfathered_drain: {
      frozen_total: grandfatherDrainState.frozen_total,
      drained: grandfatherDrainState.drained,
      outstanding: grandfatherDrainState.outstanding,
    },
    drain_queue: { entries: authoredDrainState.entries, overdue_ids: authoredDrainState.overdue_ids },
    // A3.4/A3.1: `operator_notes` is the ACTIVE list directly (matching the
    // schema's own array-of-note-objects shape, not a wrapper object).
    // `expired_notes` is the required (empty-allowed), renamed-from-`expired`
    // sibling section T3/F-74ba2c79 ask for — expired notes are surfaced
    // LOUDLY here, never silently dropped.
    operator_notes: notesResult.active,
    expired_notes: notesResult.expired,
  };
}
