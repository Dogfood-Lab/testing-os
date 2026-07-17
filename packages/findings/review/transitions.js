/**
 * Status transition law for findings.
 *
 * Lawful transitions:
 *   candidate -> reviewed, accepted, rejected
 *   reviewed  -> accepted, rejected
 *   accepted  -> reviewed (via reopen/invalidate only)
 *   accepted  -> rejected (via invalidation/reversal only)
 *   rejected  -> reviewed (via reopen only)
 *
 * Forbidden:
 *   rejected -> candidate (no rewinding to machine output)
 *   any status -> candidate (except initial creation)
 */

/**
 * F-271b4661 (wave 39, feature-pass integration finding) — cross-reference:
 * this package's reopen/close guard vs. the swarm control-plane's C1/C2 verbs.
 *
 * docs/trajectory-and-closure.dispatch.md's Feature 2 (Closure Verbs) designs
 * a FRESH guarded-reopen-with-mandatory-reason mechanism for the swarm's own
 * per-run findings table: `swarm reopen` (C1) moves fixed|deferred|rejected
 * -> recurring, requiring a non-empty reason AND evidence; `swarm close` (C2)
 * closes a finding as fixed|rejected|deferred with a required `verified_how`.
 * That is the SAME shape of guard this file already enforces, one package
 * over, for a DIFFERENT 'finding':
 *
 *   - REQUIRES_CLOSED (below)     ~ C1's precondition that reopen is only
 *     legal from a closed status (accepted/rejected here; fixed/deferred/
 *     rejected on the control-plane side).
 *   - REASON_REQUIRED (below)     ~ C2's mandatory `--reason` on `swarm
 *     close`. NOT C1: `swarm close`'s closing dispositions are the local
 *     analogue of this file's reject/invalidate/merge/supersede —
 *     REASON_REQUIRED's actual members — but `swarm reopen` (C1) mandates
 *     `--reason` AND `--evidence` while this file's own `reopen` action
 *     carries NEITHER. That asymmetry is real, not a documentation gap; see
 *     "NOT SHARED" below rather than assuming symmetry from this line alone.
 *   - ACTION_TARGET_STATUS.reopen ~ C1's `recurring` target status — both
 *     land a reopened item back in an amendable, non-terminal state
 *     (`reviewed` here, `recurring` there), never in the original pre-review
 *     state.
 *   - lineage.superseded_by (dogfood-finding.schema.json) ~ T5's 'versions
 *     supersede, nothing rewrites' — the same non-destructive-history
 *     principle, expressed as a schema field here and as roadmap sequence
 *     numbers + immutable finding_events rows on the control-plane side.
 *
 * SHARED DISCIPLINE (the same principle, independently earned in each place):
 *   - a closed/terminal state is a PRECONDITION for reopening, never a target
 *     (REQUIRES_CLOSED here; C1's own source-status check on the
 *     control-plane side);
 *   - history is additive — nothing here mutates a prior review-event-log
 *     entry, nothing on the control-plane side edits a prior finding_events
 *     row or a prior roadmap sequence; every reopen/close is itself a new,
 *     evidence-bearing record layered on top of what came before.
 *
 * NOT SHARED, DISCLOSED (F-B40-002 — wave-41 rider; this cross-reference
 * comment previously listed the next line as shared discipline, which
 * overclaimed): the control-plane's C1 `swarm reopen` requires a non-empty
 * `--reason` (and `--evidence`) as a hard CLI-layer precondition — cli.js's
 * cmdReopen refuses before any DB write (packages/dogfood-swarm/cli.js).
 * THIS file's own `reopen` action carries no such requirement:
 * REASON_REQUIRED (above) is {reject, invalidate, merge, supersede} —
 * 'reopen' is deliberately absent, so performAction (review-engine.js) and
 * reviewArtifact (review-artifacts.js, which reuses the same REASON_REQUIRED
 * set) both accept a reopen with no reason at all. review.test.js's own
 * 'Review actions: reopen' suite is live evidence of the gap: its
 * 'requires reason' case calls performAction with action:'reopen' and NO
 * reason field, and asserts success — the test's name promised the opposite
 * of what its body proves, which is exactly the kind of drift this note
 * exists to stop happening again at the comment level. Silently-reopenable
 * was never a deliberate design choice on this side, and this note does not
 * argue it should stay that way — only that a cross-reference asserting
 * false symmetry is worse than one naming the gap outright, per this repo's
 * own honesty-is-a-feature ethos (swarms/CLAUDE.md). Adding 'reopen' to
 * REASON_REQUIRED is a behavior change out of scope for a comment-only fix
 * (F-271b4661's own precedent) and belongs to a follow-up finding.
 *
 * DELIBERATELY DISTINCT (do not converge these — they answer different
 * questions for two different concepts that both happen to be named
 * 'finding'):
 *   - Granularity. This file's 'finding' is a distilled, reviewed,
 *     cross-repo lesson (dogfood-finding.schema.json) — the synthesis
 *     layer's output. The control-plane's 'finding' is a single dogfood-swarm
 *     wave's raw defect row, scoped to one run. Merging the two vocabularies
 *     would blur a reusable lesson with a per-run defect ticket.
 *   - Status vocabulary. candidate/reviewed/accepted/rejected (TRANSITIONS,
 *     below) vs. open/deferred/approved/fixed/rejected/recurring
 *     (packages/dogfood-swarm/lib/finding-status.js). No 1:1 mapping is
 *     attempted — reopen here targets 'reviewed' (an in-review state), C1
 *     targets 'recurring' (an explicitly-reopened state distinct from a
 *     fresh 'open' finding), because the two systems track different things
 *     at different points in their lifecycle.
 *   - Evidence shape. This file's REASON_REQUIRED actions attach a free-text
 *     `decision_reason` (event-log.js) plus, for reject, a structured
 *     `review.reject_reason` enum. C2 additionally requires `verified_how`
 *     (independent|self_attested|operator_evidence) — a THIRD 'how do we
 *     know' axis alongside this schema's own evidence[].evidence_kind (see
 *     that property's own cross-reference note, F-936c83f4) and
 *     packages/verify's --provenance=stub|github (see
 *     validators/provenance.js's file header). Not the same question:
 *     verified_how asks how a CLOSURE was verified; evidence_kind asks what
 *     backs a distilled lesson; --provenance asks whether a submitted CI run
 *     really happened.
 *
 * NO BEHAVIOR CHANGE. This is a comment-only fix (F-271b4661's recommendation
 * option (a)) — it exists so a reader of either mechanism can find the other
 * without re-deriving the comparison, and so the two vocabularies stay
 * deliberately-distinct BY DECISION rather than accidentally-distinct because
 * nobody had looked. C1/C2 are implemented in the swarm control plane
 * (packages/dogfood-swarm — core/verbs domain, out of this package's scope);
 * this file's own TRANSITIONS/REQUIRES_CLOSED/REASON_REQUIRED machinery is
 * unchanged by this note.
 */

// F-937733ee: family sibling of F-2965699b/F-7ce07baa/verdict.js's
// VERDICT_RANK. Object.create(null) removes the prototype chain, so
// `TRANSITIONS['constructor']` is `undefined` rather than
// `Object.prototype.constructor` (a truthy function) — the `if (!allowed)`
// / `if (!TRANSITIONS[from])` unknown-status guards below fire correctly for
// every Object.prototype key instead of going on to call `.has()` on a
// built-in method and throwing a raw TypeError. `from` is currently always a
// schema-enum-constrained finding status, so this is defense-in-depth for a
// caller that skips that gate, not a live vector.
const TRANSITIONS = Object.assign(Object.create(null), {
  candidate: new Set(['reviewed', 'accepted', 'rejected']),
  reviewed:  new Set(['accepted', 'rejected']),
  accepted:  new Set(['reviewed', 'rejected']),
  rejected:  new Set(['reviewed'])
});

/**
 * Check if a status transition is lawful.
 * @param {string} from - Current status.
 * @param {string} to - Desired status.
 * @returns {boolean}
 */
export function isLawfulTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Validate a transition and return error if invalid.
 * @param {string} from
 * @param {string} to
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTransition(from, to) {
  if (!TRANSITIONS[from]) {
    return { valid: false, error: `Unknown status: "${from}"` };
  }
  if (!isLawfulTransition(from, to)) {
    const allowed = [...TRANSITIONS[from]].join(', ');
    return { valid: false, error: `Cannot transition from "${from}" to "${to}". Allowed: ${allowed}` };
  }
  return { valid: true };
}

/**
 * Map review actions to their target statuses.
 */
export const ACTION_TARGET_STATUS = {
  review: 'reviewed',
  accept: 'accepted',
  reject: 'rejected',
  edit: null,        // edit preserves current status
  merge: 'rejected', // merged sources become rejected (merged_into_canonical)
  reopen: 'reviewed',
  invalidate: 'reviewed', // invalidated accepted → back to reviewed with invalidation metadata
  supersede: 'rejected'   // superseded finding becomes rejected
};

/**
 * Actions that require a reason.
 */
export const REASON_REQUIRED = new Set(['reject', 'invalidate', 'merge', 'supersede']);

/**
 * Actions that require from_status to be accepted.
 */
export const REQUIRES_ACCEPTED = new Set(['invalidate']);

/**
 * Actions that require from_status to be accepted or rejected.
 */
export const REQUIRES_CLOSED = new Set(['reopen']);
