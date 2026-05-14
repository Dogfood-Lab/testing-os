/**
 * wave-state-machine.js — Wave state transition law.
 *
 * Phase 5A: promote scattered raw `UPDATE waves SET status = ...` writes into
 * a lawful, audited state machine with the same shape as
 * lib/state-machine.js (the agent-run state machine). Infrastructure for the
 * Phase 5B `swarm rewind` / `swarm redrive` verbs and the Phase 5C
 * contrastive-close verbs, which will depend on the override primitive
 * + audit trail this module ships.
 *
 * Every wave status change SHOULD go through transitionWave(). Legal
 * transitions are derived empirically from the production callsites:
 *
 *   commands/dispatch.js     — INSERT-time at 'dispatched' (initial state).
 *                              No transition pair; the wave is born at
 *                              'dispatched'. Tracked here for documentation
 *                              but NOT enforced as a transition.
 *   commands/collect.js      — 'dispatched' → 'collected'   (success path)
 *                              'dispatched' → 'failed'      (validation_errors > 0
 *                                                            or ownership violations)
 *   commands/verify.js       — 'collected'  → 'verified'    (verification passed)
 *   lib/advance.js           — 'collected'  → 'advanced'    (promotion)
 *                              'verified'   → 'advanced'    (promotion)
 *   commands/revalidate.js   — 'failed'     → 'collected'   (recovery — REQUIRES override)
 *
 * The recovery transition ('failed' → 'collected' via revalidate) is the
 * canonical override path: it leaves a permanent audit row in
 * wave_state_events with the operator's --reason text, so a future inspector
 * can prove the wave was rescued lawfully rather than rolled forward by raw
 * SQL.
 *
 * Phase 5A SCOPE: ship the override primitive even though no CLI surface
 * calls it yet. Phase 5B verbs (`swarm rewind` / `swarm redrive`) will depend
 * on transitionWave(... override=true) existing. Phase 5A leaves the verbs
 * unbuilt by design.
 *
 * Legacy-state notes (kept for documentation; explicit design call):
 *   - 'pending' is the SQL DEFAULT for waves.status but no production writer
 *     ever transitions a wave TO 'pending'. dispatch.js INSERTs new waves
 *     directly at 'dispatched'. Some test fixtures still rely on the default
 *     (the column accepts whatever the DEFAULT clause emits at INSERT time).
 *     We KEEP 'pending' as a known source state with no outbound edges in
 *     TRANSITIONS so a legacy fixture-driven wave is observable but immovable
 *     without explicit override. Migrating fixtures is out of scope for 5A.
 *   - 'collecting' is in STATUS.wave but no writer uses it. Same KEEP/document
 *     stance; no outbound edges.
 *
 * BLOCKED_STATUSES require explicit override + reason to leave. 'failed' is
 * the canonical blocked source — recovery to 'collected' MUST carry an
 * operator-supplied reason via revalidate's --reason flag (Stage A recovery
 * contract pinned by revalidate.test.js).
 *
 * Phase 5B-1 (rewind) addition: 'aborted_for_rewind' is a new terminal status
 * applied to every non-terminal wave affected by `swarm rewind --apply`. Every
 * non-terminal source can reach it (the normal path covers non-blocked sources;
 * the override path covers `failed`). Terminal `advanced` waves are SKIPPED by
 * rewind — promotion records are immutable history and the new aborted status
 * would corrupt the gate-evidence trail. The audit row in wave_state_events
 * carries the `rewind:` reason prefix (mirroring `revalidate:` on the recovery
 * path), so an inspector can prove the wave was lawfully torn down rather than
 * silently dropped when the working tree was reset.
 */

import { StateMachineRejectionError } from './errors.js';

/**
 * Allowed transitions: from → [to, to, ...]
 *
 * Empirically derived from production writers. Test-fixture writes (raw
 * INSERT INTO waves ... at status='collected'/'advanced'/'verified') do NOT
 * factor into the enum — those are fixture setup, not state transitions.
 */
const TRANSITIONS = {
  pending:    ['aborted_for_rewind'],
  dispatched: ['collected', 'failed', 'aborted_for_rewind'],
  collected:  ['verified', 'advanced', 'aborted_for_rewind'],
  verified:   ['advanced', 'aborted_for_rewind'],
  advanced:   [],
  failed:     ['aborted_for_rewind'],
  collecting: ['aborted_for_rewind'],
  aborted_for_rewind: [],
};

/**
 * Statuses that require explicit coordinator override to leave.
 *
 * 'failed' is the canonical recovery source: only the documented revalidate
 * pathway (operator reviewed failed agent outputs, hand-corrected them,
 * supplied a --reason) is allowed to flip a failed wave back to collected.
 * Forcing override here surfaces any raw SQL workaround attempt as a
 * StateMachineRejectionError instead of silently flipping wave status.
 */
const BLOCKED_STATUSES = new Set(['failed']);

/**
 * Terminal statuses — no outbound transitions, even with override.
 *
 * Once a wave is 'advanced' the promotion is recorded in the promotions
 * table and downstream gates have been checked. Reopening an advanced wave
 * would corrupt the gate-evidence record; the correct recovery is to
 * dispatch a fresh wave at the next phase.
 *
 * 'aborted_for_rewind' is terminal so a future redrive (5B-2) cannot
 * accidentally re-animate a wave that was lawfully torn down by `swarm rewind`.
 * The redrive verb's contract is to dispatch a FRESH wave at the same phase,
 * not to flip an aborted wave back into the dispatched state.
 */
const TERMINAL_STATUSES = new Set(['advanced', 'aborted_for_rewind']);

/**
 * Check if a transition is allowed.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canTransition(from, to) {
  if (!TRANSITIONS[from]) {
    return { allowed: false, reason: `Unknown wave status: "${from}"` };
  }
  if (TRANSITIONS[from].includes(to)) {
    return { allowed: true };
  }
  if (TERMINAL_STATUSES.has(from)) {
    return { allowed: false, reason: `"${from}" is terminal — no transitions allowed` };
  }
  if (BLOCKED_STATUSES.has(from)) {
    return { allowed: false, reason: `"${from}" is blocked — requires coordinator override` };
  }
  return { allowed: false, reason: `Wave transition "${from}" → "${to}" is not allowed` };
}

/**
 * Perform a state transition on a wave.
 * Validates the transition, updates the DB, and logs the event.
 *
 * @param {Database} db
 * @param {number} waveId
 * @param {string} toStatus
 * @param {string} [reason] — required for blocked overrides; recommended otherwise
 * @param {boolean} [override] — allow transitioning out of blocked states
 * @returns {{ from: string, to: string, eventId: number }}
 */
export function transitionWave(db, waveId, toStatus, reason, override = false) {
  const w = db.prepare('SELECT id, status FROM waves WHERE id = ?').get(waveId);
  if (!w) throw new Error(`Wave not found: ${waveId}`);

  const from = w.status;

  // Override path for blocked statuses
  if (override && BLOCKED_STATUSES.has(from)) {
    if (!reason) throw new Error(`Override requires a reason for wave "${from}" → "${toStatus}"`);
    return executeTransition(db, waveId, from, toStatus, reason);
  }

  // Normal path
  const check = canTransition(from, toStatus);
  if (!check.allowed) {
    if (TERMINAL_STATUSES.has(from)) {
      throw new StateMachineRejectionError(
        `Wave ${waveId} is '${from}' (terminal — no further transitions). ` +
        `transitionWave was invoked on an already-advanced wave; this indicates a caller bug.`,
        {
          kind: 'TERMINAL',
          from,
          to: toStatus,
          agentRunId: waveId,
          hint: `file a bug — check the call site for a missing 'wave is already advanced' guard before transitionWave(${waveId}, '${toStatus}')`,
        }
      );
    }
    if (BLOCKED_STATUSES.has(from)) {
      throw new StateMachineRejectionError(
        `Wave ${waveId} is in '${from}' (blocked status). ` +
        `Blocked waves require explicit coordinator override + reason to move.`,
        {
          kind: 'BLOCKED',
          from,
          to: toStatus,
          agentRunId: waveId,
          hint: `wave ${waveId} is blocked ('${from}'); the canonical recovery is \`swarm revalidate <run-id> --reason "<text>" --apply\`, which calls transitionWave(... override=true, reason) under the hood and writes the audit row.`,
        }
      );
    }
    const allowed = TRANSITIONS[from] || [];
    throw new StateMachineRejectionError(
      `Wave transition '${from}' → '${toStatus}' is not allowed. ` +
      `Legal transitions from '${from}': [${allowed.join(', ') || '(none)'}].`,
      {
        kind: 'INVALID',
        from,
        to: toStatus,
        agentRunId: waveId,
        allowedTransitions: allowed,
        hint: allowed.length > 0
          ? `pick a legal target: ${allowed.join(' | ')}`
          : `'${from}' has no outbound transitions; check if this status is BLOCKED or TERMINAL`,
      }
    );
  }

  return executeTransition(db, waveId, from, toStatus, reason);
}

// ── Queries ──

export function isBlocked(status) { return BLOCKED_STATUSES.has(status); }
export function isTerminal(status) { return TERMINAL_STATUSES.has(status); }

/**
 * Get the transition history for a wave.
 */
export function getWaveTransitionHistory(db, waveId) {
  return db.prepare(
    'SELECT * FROM wave_state_events WHERE wave_id = ? ORDER BY created_at, id'
  ).all(waveId);
}

// ── Internal ──

/**
 * Apply the UPDATE + INSERT audit row in a single transaction so a failure
 * partway through cannot leave the wave row updated with no corresponding
 * event row (Stripe Ledger pattern: state and its audit trail land together
 * or not at all). better-sqlite3#transaction() is synchronous; this mirrors
 * the pattern used in revalidate.js for the same reason.
 *
 * Side-effects on completed_at:
 *   - 'collected' / 'failed' set completed_at (terminal-for-this-wave-pass)
 *   - 'verified' / 'advanced' leave completed_at as-is (already set by the
 *     prior 'collected' / 'failed' transition)
 *
 * Matches the legacy raw-SQL behaviour in commands/collect.js (which set
 * completed_at when transitioning to 'collected' / 'failed') and
 * commands/revalidate.js (which set completed_at when flipping 'failed' →
 * 'collected'). lib/advance.js's raw SQL did NOT touch completed_at; we
 * preserve that.
 */
function executeTransition(db, waveId, from, to, reason) {
  const setCompletedAt = (to === 'collected' || to === 'failed');

  const tx = db.transaction(() => {
    if (setCompletedAt) {
      db.prepare(`UPDATE waves SET status = ?, completed_at = datetime('now') WHERE id = ?`)
        .run(to, waveId);
    } else {
      db.prepare('UPDATE waves SET status = ? WHERE id = ?').run(to, waveId);
    }
    const r = db.prepare(`
      INSERT INTO wave_state_events (wave_id, from_status, to_status, reason)
      VALUES (?, ?, ?, ?)
    `).run(waveId, from, to, reason || null);
    return Number(r.lastInsertRowid);
  });

  const eventId = tx();
  return { from, to, eventId };
}

export { TRANSITIONS, BLOCKED_STATUSES, TERMINAL_STATUSES };
