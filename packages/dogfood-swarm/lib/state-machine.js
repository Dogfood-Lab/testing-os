/**
 * state-machine.js — Agent state transition law.
 *
 * Every agent_run status change MUST go through this module.
 * Illegal transitions throw. Every legal transition is logged.
 *
 * Canonical statuses:
 *   pending             — created, not yet dispatched
 *   dispatched          — prompt generated, waiting for agent to start
 *   running             — agent actively working
 *   complete            — agent finished successfully
 *   failed              — agent crashed or produced no output
 *   timed_out           — exceeded timeout policy (deterministic, not guessed)
 *   invalid_output      — output failed schema validation (manual fix required)
 *   ownership_violation — agent touched files outside its domain (manual fix required)
 *   aborted_for_rewind  — agent_run was orphaned by a `swarm rewind` against a save-point
 *                         tag whose tree predates this run (Phase 5B-1; terminal — the
 *                         row + its prior audit chain survive the tree reset).
 *
 * Transition rules:
 *   pending            → dispatched, aborted_for_rewind
 *   dispatched         → running, complete, failed, timed_out, aborted_for_rewind
 *   running            → complete, failed, timed_out, aborted_for_rewind
 *   complete           → (terminal)
 *   failed             → dispatched (redispatch), aborted_for_rewind
 *   timed_out          → dispatched (redispatch), aborted_for_rewind
 *   invalid_output     → (blocked — manual fix only, no auto-retry; rewind only via override)
 *   ownership_violation → (blocked — manual fix only, no auto-retry; rewind only via override)
 *   aborted_for_rewind  → (terminal)
 *
 * Blocked statuses can only transition via explicit coordinator override.
 * `aborted_for_rewind` is written by `swarm rewind --apply` via the override path
 * (transitionAgent(... override=true, reason)) for any non-terminal source so the
 * operator's --reason text becomes the audit row in agent_state_events.
 */

import { StateMachineRejectionError } from './errors.js';
import { logStage } from './log-stage.js';

/**
 * Allowed transitions: from → [to, to, ...]
 */
const TRANSITIONS = {
  pending:              ['dispatched', 'aborted_for_rewind'],
  dispatched:           ['running', 'complete', 'failed', 'timed_out', 'invalid_output', 'ownership_violation', 'aborted_for_rewind'],
  running:              ['complete', 'failed', 'timed_out', 'invalid_output', 'ownership_violation', 'aborted_for_rewind'],
  complete:             [],
  failed:               ['dispatched', 'aborted_for_rewind'],
  timed_out:            ['dispatched', 'aborted_for_rewind'],
  invalid_output:       [],
  ownership_violation:  [],
  aborted_for_rewind:   [],
};

/**
 * Statuses that block automatic retry.
 * Only coordinator override (with reason) can move these.
 */
const BLOCKED_STATUSES = new Set(['invalid_output', 'ownership_violation']);

/**
 * Terminal statuses — cannot transition out.
 *
 * `aborted_for_rewind` joins `complete` as terminal so a future redrive (5B-2)
 * cannot accidentally re-animate an agent_run that was lawfully abandoned by a
 * rewind. The redrive verb's contract is to dispatch a FRESH agent_run row, not
 * to flip an aborted one back into flight.
 */
const TERMINAL_STATUSES = new Set(['complete', 'aborted_for_rewind']);

/**
 * Statuses eligible for automatic redispatch.
 */
const REDISPATCHABLE = new Set(['pending', 'failed', 'timed_out']);

/**
 * Statuses considered "in-flight" (subject to timeout).
 */
const IN_FLIGHT = new Set(['dispatched', 'running']);

/**
 * Check if a transition is allowed.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canTransition(from, to) {
  if (!TRANSITIONS[from]) {
    return { allowed: false, reason: `Unknown status: "${from}"` };
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
  return { allowed: false, reason: `Transition "${from}" → "${to}" is not allowed` };
}

/**
 * Perform a state transition on an agent_run.
 * Validates the transition, updates the DB, and logs the event.
 *
 * @param {Database} db
 * @param {number} agentRunId
 * @param {string} toStatus
 * @param {string} [reason] — required for blocked overrides
 * @param {boolean} [override] — allow transitioning out of blocked states
 * @returns {{ from: string, to: string, eventId: number }}
 */
export function transitionAgent(db, agentRunId, toStatus, reason, override = false) {
  const ar = db.prepare('SELECT id, status FROM agent_runs WHERE id = ?').get(agentRunId);
  if (!ar) throw new Error(`Agent run not found: ${agentRunId}`);

  const from = ar.status;

  // Override path for blocked statuses
  if (override && BLOCKED_STATUSES.has(from)) {
    if (!reason) throw new Error(`Override requires a reason for "${from}" → "${toStatus}"`);
    return executeTransition(db, agentRunId, from, toStatus, reason);
  }

  // Normal path
  const check = canTransition(from, toStatus);
  if (!check.allowed) {
    // F-091578-002: differentiate by source-status class so the CLI's
    // top-level handler can render a code-specific actionable hint.
    if (TERMINAL_STATUSES.has(from)) {
      throw new StateMachineRejectionError(
        `Agent run ${agentRunId} is '${from}' (terminal — no further transitions). ` +
        `transitionAgent was invoked on an already-completed agent; this indicates a caller bug.`,
        {
          kind: 'TERMINAL',
          from,
          to: toStatus,
          agentRunId,
          hint: `file a bug — check the call site for a missing 'is already complete' guard before transitionAgent(${agentRunId}, '${toStatus}')`,
        }
      );
    }
    if (BLOCKED_STATUSES.has(from)) {
      throw new StateMachineRejectionError(
        `Agent run ${agentRunId} is in '${from}' (blocked status). ` +
        `Blocked agents require explicit coordinator override to move.`,
        {
          kind: 'BLOCKED',
          from,
          to: toStatus,
          agentRunId,
          hint: `agent_run ${agentRunId} is blocked ('${from}'); correct the output JSON on disk, then run \`swarm revalidate <run-id> --reason "<text>" --domain=<domain>:<corrected.json> --apply\` to repair lawfully (dry-run without --apply). Library-level: transitionAgent(... override=true) writes the audit row to agent_state_events.`,
        }
      );
    }
    const allowed = TRANSITIONS[from] || [];
    throw new StateMachineRejectionError(
      `Transition '${from}' → '${toStatus}' is not allowed. ` +
      `Legal transitions from '${from}': [${allowed.join(', ') || '(none)'}].`,
      {
        kind: 'INVALID',
        from,
        to: toStatus,
        agentRunId,
        allowedTransitions: allowed,
        hint: allowed.length > 0
          ? `pick a legal target: ${allowed.join(' | ')}`
          : `'${from}' has no outbound transitions; check if this status is BLOCKED or TERMINAL`,
      }
    );
  }

  return executeTransition(db, agentRunId, from, toStatus, reason);
}

/**
 * Apply timeout policy to in-flight agents for a wave.
 * Deterministic: if started_at + timeout_ms < now, transition to timed_out.
 *
 * @param {Database} db
 * @param {number} waveId
 * @param {number} timeoutMs
 * @param {number} [nowMs] — override for testing (default: Date.now())
 * @returns {Array<{ agentRunId: number, domain: string }>}
 */
export function applyTimeoutPolicy(db, waveId, timeoutMs, nowMs) {
  const now = nowMs || Date.now();
  const agents = db.prepare(`
    SELECT ar.id, ar.status, ar.started_at, d.name as domain_name
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ? AND ar.status IN ('dispatched', 'running')
  `).all(waveId);

  const timedOut = [];

  for (const agent of agents) {
    // Defense in depth at the law engine: an agent_run with status in
    // ('dispatched','running') but a NULL started_at means the state machine
    // was bypassed somewhere (a direct INSERT, a manual SQL repair, a stale
    // fixture) — we cannot prove how long it has been running, so we MUST
    // NOT instant-time-out. Treat as "just dispatched": start the clock now.
    //
    // The wave-5 fix to dispatch.js (F-002109-003) closed the production
    // path that produced this state. This branch is the belt-and-suspenders
    // guard so a future regression cannot silently re-arm the bug.
    //
    // started_at is written by executeTransition() via Date#toISOString(),
    // which already terminates with 'Z'. Appending another 'Z' yielded NaN
    // and caused every timeout check to silently no-op. See F-742440-001.
    if (!agent.started_at) {
      // D3B-012 (Wave A2 Stage C): the prior console.warn was an
      // unstructured message buried inside stderr — operators tailing the
      // NDJSON stream had no way to detect it. Replace with a structured,
      // coded, greppable logStage event. The defensive skip stays — we
      // still cannot prove timing — but the operator now sees it.
      logStage('timeout_skip_null_started_at', {
        component: 'dogfood-swarm',
        agent_run_id: agent.id,
        agentRunId: agent.id,
        domain: agent.domain_name,
        status: agent.status,
        wave_id: waveId,
        waveId,
        reason: 'started_at NULL despite in-flight status — state-machine bypass somewhere; skipping timeout this pass',
      });
      continue;
    }
    const startedAt = new Date(agent.started_at).getTime();
    if (now - startedAt > timeoutMs) {
      transitionAgent(db, agent.id, 'timed_out',
        `Exceeded timeout policy: ${Math.round((now - startedAt) / 1000)}s > ${Math.round(timeoutMs / 1000)}s`);
      timedOut.push({ agentRunId: agent.id, domain: agent.domain_name });
    }
  }

  return timedOut;
}

/**
 * Get timeout policy for a run.
 */
export function getTimeoutPolicy(db, runId) {
  const run = db.prepare('SELECT timeout_policy_ms FROM runs WHERE id = ?').get(runId);
  return run?.timeout_policy_ms || 1800000; // default 30 min
}

/**
 * Set timeout policy for a run.
 */
export function setTimeoutPolicy(db, runId, timeoutMs) {
  db.prepare('UPDATE runs SET timeout_policy_ms = ? WHERE id = ?').run(timeoutMs, runId);
}

// ── Queries ──

export function isBlocked(status) { return BLOCKED_STATUSES.has(status); }
export function isTerminal(status) { return TERMINAL_STATUSES.has(status); }
export function isRedispatchable(status) { return REDISPATCHABLE.has(status); }
export function isInFlight(status) { return IN_FLIGHT.has(status); }

/**
 * Get the transition history for an agent_run.
 */
export function getTransitionHistory(db, agentRunId) {
  return db.prepare(
    'SELECT * FROM agent_state_events WHERE agent_run_id = ? ORDER BY created_at'
  ).all(agentRunId);
}

// ── Internal ──

/**
 * F-H9 (Wave A1 D3): wrap the UPDATE agent_runs + INSERT agent_state_events
 * pair in a single db.transaction() so a crash partway through cannot leave
 * the agent_runs row updated with no corresponding audit event (Stripe
 * Ledger pattern: state and its audit row land together or not at all).
 *
 * Mirrors wave-state-machine.js executeTransition (line 245-264) which
 * already used this shape for the same reason on the wave side.
 *
 * better-sqlite3 nests cleanly: callers already inside an outer transaction
 * (collect.js's upsertFindings batch, rewind.js, redrive.js,
 * revalidate.js's repair pass) keep working unchanged — better-sqlite3
 * collapses nested tx() into a SAVEPOINT.
 *
 * H9 sibling closure (applyTimeoutPolicy at line 184): the loop iterates and
 * calls transitionAgent per agent. Because transitionAgent goes through
 * executeTransition which now self-wraps, each per-agent UPDATE+INSERT
 * pair is atomic — even if the loop is interrupted mid-iteration, any agent
 * the loop already touched is either fully transitioned (UPDATE + audit
 * row) or untouched. No torn rows.
 *
 * H9 sibling closure (dispatch.js:195-200, resume.js:128-136 raw INSERT +
 * transitionAgent pairs): once executeTransition self-wraps, the
 * transitionAgent call inside those pairs is itself atomic. The outer
 * INSERT agent_runs is separate and explicitly outside the transition
 * audit-row contract (it creates the row that the transition will then
 * audit), which is by design.
 */
function executeTransition(db, agentRunId, from, to, reason) {
  const updates = { status: to };
  if (to === 'complete') updates.completed_at = new Date().toISOString();
  if (to === 'dispatched' || to === 'running') updates.started_at = new Date().toISOString();

  const setClauses = Object.entries(updates).map(([k, v]) => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), agentRunId];

  const tx = db.transaction(() => {
    db.prepare(`UPDATE agent_runs SET ${setClauses} WHERE id = ?`).run(...values);
    const eventResult = db.prepare(`
      INSERT INTO agent_state_events (agent_run_id, from_status, to_status, reason)
      VALUES (?, ?, ?, ?)
    `).run(agentRunId, from, to, reason || null);
    return Number(eventResult.lastInsertRowid);
  });

  const eventId = tx();
  return { from, to, eventId };
}

export { TRANSITIONS, BLOCKED_STATUSES, TERMINAL_STATUSES, REDISPATCHABLE, IN_FLIGHT };
