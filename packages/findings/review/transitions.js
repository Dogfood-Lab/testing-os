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
