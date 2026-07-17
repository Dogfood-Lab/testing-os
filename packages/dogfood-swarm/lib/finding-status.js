/**
 * finding-status.js — Single source of truth for which finding statuses count
 * as CLOSED (resolved) versus OPEN for advancement-gate purposes.
 *
 * The advancement gate (lib/advance.js#checkFindingSeverity) and the two
 * operator-facing surfaces that mirror it — `swarm receipt`
 * (commands/receipt.js#computeRecommendation) and `swarm status`
 * (commands/status.js#computeAssessment) — must agree on this set. They
 * historically drifted: the gate excluded `deferred` (a deferred CRITICAL/HIGH
 * is closed, so advance ADVANCEs), while receipt and status only excluded
 * `fixed` and `rejected`, counting a deferred CRITICAL/HIGH as still open and
 * recommending AMEND. The result was `swarm advance` advancing while `swarm
 * status` and the receipt told the operator to amend the same DB state.
 *
 * Routing all three through this module — advance.js builds its SQL `NOT IN`
 * from CLOSED_FINDING_STATUSES, receipt.js and status.js build their JS filter
 * from isOpenFinding — makes the divergence impossible to reintroduce.
 */

/**
 * F-c0b12add: re-exported (not re-defined) from db/schema.js, which is the
 * ACTUAL single source of truth for finding_events.event_type's known
 * vocabulary (db/schema.js's own header comment: "This frozen array is the
 * single source of truth: STATUS.finding_event below is THIS array"). This
 * module is the established home for finding-LIFECYCLE vocabulary
 * (CLOSED_FINDING_STATUSES above already lives here), so callers/tests
 * reasonably look here first — re-exporting means there is still only ONE
 * array in memory (Object.freeze'd once, in schema.js), never a second,
 * independently-driftable copy.
 */
export { EVENT_TYPES } from '../db/schema.js';

/**
 * Finding statuses that are CLOSED for gate purposes: a finding in any of these
 * states does not block advancement, regardless of severity.
 *
 *   - fixed    — the finding was resolved by an amend.
 *   - rejected — the finding was triaged away as not-a-defect.
 *   - deferred — the finding was consciously accepted/postponed; the operator
 *                has decided it does not block this stage.
 */
export const CLOSED_FINDING_STATUSES = Object.freeze(['fixed', 'rejected', 'deferred']);

/**
 * SQL `IN (...)` list rendered from CLOSED_FINDING_STATUSES, ready to splice
 * into a `status NOT IN (...)` predicate. Values are literal-quoted (the set is
 * a fixed, code-owned enum — never user input), so this is safe to inline.
 */
export const CLOSED_FINDING_STATUSES_SQL =
  CLOSED_FINDING_STATUSES.map(s => `'${s}'`).join(', ');

/**
 * Whether a finding is OPEN (counts toward the severity gate).
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isOpenFinding(status) {
  return !CLOSED_FINDING_STATUSES.includes(status);
}
