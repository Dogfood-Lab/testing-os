/**
 * redrive.js — `swarm redrive <wave-id> --reason "<text>" [--apply]`
 *
 * Phase 5B-2 — the lawful Redrive verb. Step Functions Redrive semantics:
 * same wave_id, completed work preserved byte-identical, only the failure
 * tail made re-dispatchable.
 *
 * Architectural grounding:
 *
 *   - Rewind erases (status → aborted_for_rewind), Redrive resumes (status →
 *     dispatched). They are siblings, not synonyms. The load-bearing property
 *     of Redrive is that completed receipts SURVIVE byte-identical so the
 *     operator's effort isn't wasted — only the unfinished portion gets a
 *     second chance.
 *
 *   - Same wave_id, NOT a new wave. A fresh wave at the next phase would
 *     lose the audit trail that ties the redriven portion to the original
 *     dispatch. The wave row is mutated through transitionWave with the
 *     `redrive:` reason prefix; the prior history rows in wave_state_events
 *     and agent_state_events survive byte-identical (append-only audit
 *     trail; redrive only adds new rows).
 *
 *   - Receipt-byte-identity contract: every `complete` agent_run is treated
 *     as immutable. The pre-apply pass computes a sha256 hash over the
 *     identity-carrying fields (status, output_path, completed_at) for every
 *     complete agent_run in the wave; post-apply, the same hash is
 *     recomputed and equality is asserted. The test pins this; a future
 *     regression that accidentally writes to a complete row will trip this
 *     gate.
 *
 *   - Eligibility table (each refused case names the recovery verb):
 *
 *       complete            → PRESERVED (informational — receipt unchanged)
 *       dispatched, pending → ELIGIBLE — redriven to dispatched (no-op for
 *                                        already-dispatched: source == target)
 *       failed              → ELIGIBLE — redriven via the NORMAL path
 *                                        (failed→dispatched is a legal edge in
 *                                        the AGENT machine; only the WAVE-level
 *                                        'failed' is BLOCKED and needs override)
 *       timed_out           → ELIGIBLE — redriven (normal path; `timed_out`
 *                                        is NOT in BLOCKED_STATUSES but the
 *                                        edge timed_out→dispatched already exists)
 *       invalid_output      → REFUSED — wrong verb (use `swarm revalidate`)
 *       ownership_violation → REFUSED — wrong fix (operator unblocks ownership)
 *       aborted_for_rewind  → REFUSED (TERMINAL — deliberately aborted)
 *
 *   - Wave-level eligibility:
 *
 *       advanced            → REFUSED (TERMINAL — promotion is immutable)
 *       aborted_for_rewind  → REFUSED (TERMINAL)
 *       collected, verified, dispatched → ELIGIBLE (normal path)
 *       failed              → ELIGIBLE (override path — BLOCKED source)
 *
 *   - Dry-run by default; --apply required to mutate. Same posture as
 *     `swarm rewind` and `swarm revalidate`.
 *
 *   - All status mutations go through transition helpers; zero raw `UPDATE`
 *     of `waves.status` or `agent_runs.status`. The Pattern #10 guard in
 *     wave-state-machine.test.js scans for raw writers across the package.
 *
 *   - Append-only audit trail: prior agent_state_events / wave_state_events
 *     rows survive redrive byte-identical. New rows are appended carrying
 *     the `redrive:` reason prefix so a future inspector can grep the audit
 *     trail for the verb that wrote each row (mirrors `rewind:` / `revalidate:`).
 *
 * Design calls surfaced (each documented in the report):
 *
 *   1. Agent target status on redrive: `dispatched`. Simplest path for the
 *      operator (re-run the agent, then `swarm collect`) and reuses the
 *      existing TRANSITIONS shape — every redrive-eligible source already
 *      had `→ dispatched` as a legal edge. A new `redrove` status would
 *      add schema surface for no operational benefit (the redrive event in
 *      agent_state_events already carries the audit context).
 *
 *   2. Wave target status on redrive: `dispatched`. Mirrors the agent target;
 *      operator's `swarm status` clearly shows "this wave is back in
 *      dispatch state for the redriven agents." Required four new edges in
 *      wave-state-machine.js (pending|collected|verified|failed → dispatched).
 *      The `failed → dispatched` edge fires via override because `failed` is
 *      BLOCKED at the wave level.
 *
 *   3. Stale output JSON files on disk: leave in place. The point of this
 *      slice is the lawful DB-level resume; output_path on disk is operator-
 *      managed scratch space. Operator's re-execution overwrites; redrive
 *      stays out of the filesystem-move business. The audit trail (agent_runs
 *      row carries `output_path` to the stale file; agent_state_events row
 *      carries the redrive event with the operator reason) is sufficient to
 *      reconstruct what was overwritten. Archive-to-redrive-N/ is a possible
 *      Slice-2 enhancement if operators surface a need.
 *
 *   4. Wave's `serial_verify_required` flag on redrive: preserved. The flag
 *      is a discipline marker (was the wave dispatched with --skip-verify?)
 *      not a state-machine status, so it survives redrive. Operator running
 *      `npm run verify` after the redrive's collect remains the correct
 *      ground-truth check.
 */

import { createHash } from 'node:crypto';

import { openDb } from '../db/connection.js';
import {
  transitionAgent,
  TERMINAL_STATUSES as AGENT_TERMINAL_STATUSES,
  BLOCKED_STATUSES as AGENT_BLOCKED_STATUSES,
} from '../lib/state-machine.js';
import {
  transitionWave,
  TERMINAL_STATUSES as WAVE_TERMINAL_STATUSES,
} from '../lib/wave-state-machine.js';
import { logStage } from '../lib/log-stage.js';
import { mintCorrelationId } from '../lib/correlation-id.js';

const REDRIVE_TARGET_STATUS = 'dispatched';

// Agent source statuses that are PRESERVED (informational; not redriven, not
// refused). `complete` is the canonical case — the receipt is immutable.
const AGENT_PRESERVED_SOURCES = new Set(['complete']);

// Agent source statuses ELIGIBLE for redrive to `dispatched`.
//   - `pending` and `dispatched` are pre-execution states (re-dispatch is a
//     no-op when source == target; we still surface the row in output).
//   - `failed` redispatches via the NORMAL failed→dispatched edge — at the
//     AGENT level 'failed' is not in BLOCKED_STATUSES (only invalid_output /
//     ownership_violation are). It is the WAVE-level 'failed' that is BLOCKED
//     and requires the override path (F-e241fa61 doc correction).
//   - `timed_out` is non-blocked; the timed_out→dispatched edge already
//     exists in TRANSITIONS.
//
// `running` is deliberately NOT eligible in 5B-2 — a running agent is
// in-flight by the timeout policy; operator should let timeout fire (and
// then redrive the resulting `timed_out`) rather than yank an agent that
// might still be doing work. Conservative posture; Slice-2 widen if needed.
const AGENT_ELIGIBLE_SOURCES = new Set([
  'pending', 'dispatched', 'failed', 'timed_out',
]);

// Agent source statuses REFUSED with named verb. Each refusal points at the
// specific recovery verb that applies so the operator never has to
// rediscover. The taxonomy is empirical: every status the agent state
// machine knows is classified here, complete + eligible + refused = the
// full enum.
const AGENT_REFUSED_SOURCES = {
  invalid_output: {
    reason: 'invalid_output is a schema mismatch — use `swarm revalidate <run-id> --reason "<text>" --domain=<domain>:<corrected.json> --apply` instead',
    correct_verb: 'revalidate',
  },
  ownership_violation: {
    reason: 'ownership_violation requires operator to unblock ownership first; not a redrive case',
    correct_verb: 'manual',
  },
  aborted_for_rewind: {
    reason: 'aborted_for_rewind is terminal — agent run was deliberately aborted; either run a fresh wave or surface to coordinator decision',
    correct_verb: 'fresh-wave',
  },
  running: {
    reason: 'running is in-flight — let the timeout policy fire (then redrive the resulting `timed_out`) rather than yank an agent that may still be doing work',
    correct_verb: 'wait-or-timeout',
  },
};

/**
 * @param {object} opts
 * @param {number|string} opts.waveId — required, positive integer (string accepted from CLI)
 * @param {string} opts.reason — required, non-empty audit text
 * @param {string} opts.dbPath — control-plane DB path (required, no implicit default)
 * @param {boolean} [opts.apply] — without this, dry-run only (no mutation)
 * @returns {object} — report
 */
export function redrive(opts) {
  const { reason, dbPath, apply } = opts;

  // ── Input validation ──
  if (opts.waveId == null || opts.waveId === '' || opts.waveId === undefined) {
    throw new Error('redrive: <wave-id> is required (positive integer)');
  }
  const waveId = Number(opts.waveId);
  if (!Number.isInteger(waveId) || waveId <= 0) {
    throw new Error(`redrive: <wave-id> must be a positive integer (got ${JSON.stringify(opts.waveId)})`);
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('redrive: --reason "<text>" is required (non-empty string)');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('redrive: dbPath is required (no implicit default)');
  }

  const db = openDb(dbPath);

  // ── Resolve wave ──
  const wave = db.prepare(
    'SELECT id, run_id, phase, wave_number, status, serial_verify_required FROM waves WHERE id = ?'
  ).get(waveId);
  if (!wave) {
    const err = new Error(`redrive: wave not found: ${waveId}`);
    err.code = 'WAVE_NOT_FOUND';
    throw err;
  }

  // ── Wave-level eligibility ──
  if (WAVE_TERMINAL_STATUSES.has(wave.status)) {
    const verb = wave.status === 'advanced'
      ? 'wave is `advanced` — promotion is immutable; dispatch a fresh wave at the next phase instead'
      : 'wave is `aborted_for_rewind` — terminal; run a fresh wave at the same phase';
    const err = new Error(`redrive: wave ${waveId} cannot be redriven: ${verb}`);
    err.code = 'WAVE_TERMINAL';
    throw err;
  }

  // ── Collect every agent_run on the wave ──
  const agentRuns = db.prepare(`
    SELECT ar.id, ar.wave_id, ar.status, ar.output_path, ar.completed_at, d.name AS domain_name
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
    ORDER BY ar.id
  `).all(waveId);

  // ── Classify each agent_run into preserved / eligible / refused ──
  const preserved = [];
  const eligible = [];
  const refused = [];

  for (const ar of agentRuns) {
    const src = ar.status;
    if (AGENT_PRESERVED_SOURCES.has(src)) {
      preserved.push({
        agent_run_id: ar.id,
        domain: ar.domain_name,
        from_status: src,
        note: 'preserved (complete) — receipt unchanged',
      });
      continue;
    }
    if (AGENT_REFUSED_SOURCES[src]) {
      const ref = AGENT_REFUSED_SOURCES[src];
      refused.push({
        agent_run_id: ar.id,
        domain: ar.domain_name,
        from_status: src,
        reason: ref.reason,
        correct_verb: ref.correct_verb,
      });
      continue;
    }
    if (AGENT_ELIGIBLE_SOURCES.has(src)) {
      const note = (src === REDRIVE_TARGET_STATUS)
        ? 'redriven (no-op — already dispatched; audit row still appended)'
        : (AGENT_BLOCKED_STATUSES.has(src) ? 'redriven via override' : 'redriven');
      eligible.push({
        agent_run_id: ar.id,
        domain: ar.domain_name,
        from_status: src,
        to_status: REDRIVE_TARGET_STATUS,
        applied: false,
        note,
      });
      continue;
    }
    // Unknown source — surface as refused so the operator gets a clear
    // message rather than a silent skip. A future status the enum doesn't
    // cover hits this path.
    refused.push({
      agent_run_id: ar.id,
      domain: ar.domain_name,
      from_status: src,
      reason: `unknown agent_run status '${src}'; redrive's taxonomy does not cover it — file a bug`,
      correct_verb: 'bug',
    });
  }

  // ── Pre-apply: receipt-byte-identity hash for every `complete` agent_run ──
  // Receipt-byte-identity contract: the test pins this hash, asserting it
  // unchanged after --apply. We hash the identity-carrying agent_run fields
  // plus the agent_state_events history for each complete agent.
  //
  // F-a5f6b585: the watch-set is re-queried directly from the DB by
  // (wave_id, status='complete') — NOT derived from the `preserved` array
  // above. `preserved` is a product of the SAME classification
  // (AGENT_PRESERVED_SOURCES) this gate exists to police; hashing only what
  // the classification calls "preserved" makes the gate structurally unable
  // to see a classification bug (move 'complete' into
  // AGENT_ELIGIBLE_SOURCES and `preserved` silently becomes [] — the gate
  // would then compare {} to {} and report `true` in exactly the run where
  // every complete receipt was about to be destroyed). Querying the DB
  // independently means the before-hash captures whatever is ACTUALLY
  // 'complete' right now, regardless of what the classifier above believes.
  const preservedReceiptHashesBefore = computeReceiptHashes(db, waveId);
  const receiptsChecked = Object.keys(preservedReceiptHashesBefore).length;

  // ── Plan the wave transition ──
  // If there are eligible agent_runs OR if the wave is currently in a
  // non-`dispatched` non-terminal state, we transition the wave to
  // `dispatched`. If the wave is already at `dispatched` AND every agent_run
  // is already at `dispatched` (no-op redrive), we still write the wave-level
  // audit row so the operator's intent is recorded.
  const waveNeedsTransition = wave.status !== REDRIVE_TARGET_STATUS;
  const waveFromStatus = wave.status;

  const reasonPrefixed = `redrive: ${reason}`;

  const report = {
    waveId,
    runId: wave.run_id,
    phase: wave.phase,
    waveNumber: wave.wave_number,
    waveStatusBefore: wave.status,
    serialVerifyRequiredPreserved: !!wave.serial_verify_required,
    dbPath,
    dryRun: !apply,
    apply: !!apply,
    reason,
    reasonRecorded: reasonPrefixed,
    preserved,
    eligible,
    refused,
    planned_wave_transition: {
      wave_id: waveId,
      from_status: waveFromStatus,
      to_status: REDRIVE_TARGET_STATUS,
      needs_transition: waveNeedsTransition,
      applied: false,
    },
    db_transaction_done: false,
    summary: null,
    preserved_receipt_hashes_before: preservedReceiptHashesBefore,
    preserved_receipt_hashes_after: null,
    // F-a5f6b585: three-state contract, never a vacuous `true`.
    //   false          — dry-run (or apply never reached the tx) — nothing
    //                    was verified yet, distinct from "verified and ok".
    //   'not_applicable' — apply ran, the independent watch-set was EMPTY
    //                    (zero 'complete' agent_runs in this wave) — there
    //                    was nothing to check, so we refuse to call that a
    //                    passing verification.
    //   true           — apply ran, the watch-set was non-empty, and the
    //                    in-tx byte-identity check (below) passed. Any
    //                    failure of that check throws and rolls back the
    //                    tx (F-ad3004f4) — a `report` documenting `false`
    //                    for a non-empty, failed check is never returned;
    //                    the caller gets a thrown Error instead.
    receipt_byte_identity_verified: false,
    receipts_checked: receiptsChecked,
    design_calls_surfaced: [
      {
        name: 'agent_target_status_on_redrive',
        choice_made: 'reuse_dispatched',
        alternatives_considered: ['new_pending_status', 'new_redrove_status'],
        reasoning:
          'Simplest operator path: re-run the agent, then `swarm collect`. ' +
          'Reuses the existing TRANSITIONS shape — every redrive-eligible source ' +
          '(pending, failed, timed_out) already had `→ dispatched` as a legal edge. ' +
          'A new `redrove` status would add schema surface (status enum, terminal ' +
          'classification, UI rendering) for no operational benefit; the redrive ' +
          'event in agent_state_events already carries the audit context that ' +
          'distinguishes "dispatched-fresh" from "redrive-dispatched".',
      },
      {
        name: 'wave_target_status_on_redrive',
        choice_made: 'reuse_dispatched',
        alternatives_considered: ['keep_current_status_audit_only', 'new_redrove_wave_status'],
        reasoning:
          'Mirrors the agent target. Operator scanning `swarm status` sees the ' +
          'wave back in dispatch state for the redriven agents, which matches ' +
          'their mental model of Step Functions Redrive. Required four new edges ' +
          'in wave-state-machine.js (pending|collected|verified|failed → dispatched). ' +
          'The failed→dispatched edge fires via override because `failed` is ' +
          'BLOCKED at the wave level. Audit-only (no status change) was rejected ' +
          'because it would leave the wave reading as collected/failed/verified ' +
          'in steady-state status output while agent_runs are actually back in ' +
          'flight — confusing scan-mode signal.',
      },
      {
        name: 'stale_output_json_files_on_disk',
        choice_made: 'leave_in_place',
        alternatives_considered: ['delete_stale_files', 'archive_to_redrive_n_subdir'],
        reasoning:
          'output_path on disk is operator-managed scratch space; redrive is the ' +
          'lawful DB-level resume primitive and stays out of the filesystem-move ' +
          'business. Operator re-executes the redriven agent (their tooling, their ' +
          'rules) and the next `swarm collect` reads the refreshed output. The ' +
          'audit trail is sufficient: agent_runs.output_path still points at the ' +
          'stale file; agent_state_events carries the redrive: reason. Archive-to-' +
          'redrive-N/ was considered but rejected for this slice — it would couple ' +
          'this verb to swarms/<run>/wave-N/ layout (currently implicit) and add ' +
          'filesystem-move failure modes. Slice 2 enhancement if operators surface ' +
          'a need.',
      },
      {
        name: 'serial_verify_required_flag_on_redrive',
        choice_made: 'preserve',
        alternatives_considered: ['reset_to_false', 'reconsider_per_redrive'],
        reasoning:
          'The flag marks discipline (this wave was dispatched with --skip-verify) ' +
          'not state-machine status. It survives redrive because the obligation it ' +
          'represents — operator runs `npm run verify` against the cumulative tree ' +
          'after collect — still applies once the redriven agents land. Resetting ' +
          'would erase the discipline signal and silently re-arm the cumulative-tree ' +
          'measurement-artifact bug the flag exists to prevent.',
      },
    ],
  };

  // ── Dry-run early exit ──
  if (!apply) {
    report.summary = formatPlanSummary(report);
    return report;
  }

  // ── Apply: single DB transaction so partial-write cannot leave the wave ──
  // in an inconsistent state. transitionAgent / transitionWave each do their
  // own UPDATE + INSERT, and better-sqlite3 nests transactions cleanly under
  // a single outer tx().
  //
  // F-ad3004f4: `preservedReceiptHashesAfter` / `receiptByteIdentityVerified`
  // are declared here (outer scope) so the transaction body below can write
  // them via closure — the actual byte-identity CHECK runs INSIDE the tx,
  // not after it commits. See the comment at the bottom of the tx body.
  let preservedReceiptHashesAfter = null;
  let receiptByteIdentityVerified = false;
  const tx = db.transaction(() => {
    // Transition each eligible agent_run. override=true is harmless for
    // non-blocked sources (the override branch only fires when from is in
    // BLOCKED_STATUSES); the audit row lands with the redrive: reason prefix
    // either way.
    for (const ar of eligible) {
      if (ar.from_status === REDRIVE_TARGET_STATUS) {
        // No-op: source already at target. Audit row still appended so the
        // operator's intent is recorded. We append it manually via a same-
        // status write through transitionAgent's override path — but
        // dispatched is NOT in BLOCKED_STATUSES, so the override branch is
        // skipped. canTransition('dispatched', 'dispatched') is false (no
        // self-loop). We therefore append a direct audit row through the
        // raw INSERT into agent_state_events — this is the ONE special-case
        // exception and is documented here so a future scan understands why.
        //
        // Rejected alternative: add 'dispatched' to TRANSITIONS.dispatched
        // as a self-loop. That would erode the state machine's "every
        // transition is movement" property and let unrelated callers write
        // a same-status row. Keeping the exception localized is the lesser
        // evil.
        db.prepare(`
          INSERT INTO agent_state_events (agent_run_id, from_status, to_status, reason)
          VALUES (?, ?, ?, ?)
        `).run(ar.agent_run_id, ar.from_status, REDRIVE_TARGET_STATUS, reasonPrefixed);
      } else {
        transitionAgent(
          db,
          ar.agent_run_id,
          REDRIVE_TARGET_STATUS,
          reasonPrefixed,
          /* override */ true,
        );
      }
      ar.applied = true;
    }

    // Transition the wave. If already at dispatched, append a same-status
    // audit row via the same direct-insert exception (see above).
    if (waveNeedsTransition) {
      transitionWave(
        db,
        waveId,
        REDRIVE_TARGET_STATUS,
        reasonPrefixed,
        /* override */ true,
      );
    } else {
      db.prepare(`
        INSERT INTO wave_state_events (wave_id, from_status, to_status, reason)
        VALUES (?, ?, ?, ?)
      `).run(waveId, waveFromStatus, REDRIVE_TARGET_STATUS, reasonPrefixed);
    }
    report.planned_wave_transition.applied = true;

    // ── F-ad3004f4: receipt-byte-identity check runs INSIDE the tx ──
    // Re-query the SAME independent watch-set (wave_id + status='complete')
    // used for the before-hash, now that the transitions above have landed.
    // If the classification above wrongly routed a still-'complete' row into
    // `eligible` (the F-a5f6b585 mutant: 'complete' moved into
    // AGENT_ELIGIBLE_SOURCES), that row no longer satisfies status='complete'
    // post-transition, so it drops out of the after-set — the key-count
    // mismatch trips hashesAreEqual. Throwing HERE, before this function
    // returns, means better-sqlite3 rolls back every write the tx body just
    // made: the violation is PREVENTED (the destructive transition never
    // durably lands), not merely detected after the fact. Pre-fix this same
    // check ran after tx() had already returned, so by the time a mismatch
    // was observed the mutation was already committed and irreversible — the
    // thrown error's only remedy was 'Inspect manually', with no compensator
    // possible (the pre-tx hashes are opaque digests, not row values; they
    // cannot restore anything). Prevention removes the need for a
    // compensator here entirely.
    preservedReceiptHashesAfter = computeReceiptHashes(db, waveId);
    receiptByteIdentityVerified = hashesAreEqual(preservedReceiptHashesBefore, preservedReceiptHashesAfter);
    if (!receiptByteIdentityVerified) {
      const err = new Error(
        `redrive: receipt-byte-identity contract violated — a 'complete' agent_run's ` +
        `identity-carrying fields changed during this redrive. Transaction rolled back; ` +
        `nothing was mutated. wave_id=${waveId}.`,
      );
      err.code = 'RECEIPT_BYTE_IDENTITY_VIOLATION';
      throw err;
    }
  });

  try {
    tx();
    report.db_transaction_done = true;
  } catch (e) {
    const correlationId = mintCorrelationId();
    const isReceiptViolation = e?.code === 'RECEIPT_BYTE_IDENTITY_VIOLATION';
    logStage(isReceiptViolation ? 'redrive_receipt_violation' : 'redrive_db_tx_failed', {
      component: 'dogfood-swarm',
      correlation_id: correlationId,
      waveId,
      dbPath,
      eligibleCount: eligible.length,
      preservedCount: preserved.length,
      refusedCount: refused.length,
      receiptsChecked,
      err: e?.message,
    });
    // The receipt-byte-identity violation is a distinct, actionable failure
    // mode (a state-machine/classification bug) from a generic DB error (a
    // busy lock, a constraint violation) — preserve its `.code` and message
    // rather than flattening both into the same generic wrapper, so a
    // caller (or a test) can branch on `err.code`.
    if (isReceiptViolation) {
      const wrapped = new Error(`${e.message} (correlation_id=${correlationId})`);
      wrapped.code = e.code;
      // F-67908e23: waveId + hint for parity with this file's sibling typed
      // errors (and DISPATCH_NO_AGENT_DOMAINS / COLLECT_UNKNOWN_DOMAIN /
      // CLEAN_WAVE_IN_FLIGHT) — renderTopLevelError prints dedicated lines
      // for both when present. waveId is already resolved in this function's
      // outer scope, so setting it here is free.
      wrapped.waveId = waveId;
      wrapped.hint = 'inspect wave_state_events / agent_state_events for this wave; ' +
        'this indicates a classification or state-machine regression, not an operator mistake';
      throw wrapped;
    }
    throw new Error(
      `redrive: DB transaction failed (correlation_id=${correlationId}): ${e?.message || e}.`,
    );
  }

  // ── Post-apply reporting only — the CHECK already ran inside the tx ──
  // Reaching this line means tx() returned without throwing, which means
  // (F-ad3004f4) the in-tx byte-identity check already passed. F-a5f6b585:
  // an EMPTY watch-set (zero 'complete' agent_runs this wave — the common
  // redrive case, since redrive exists to recover a wave whose agents
  // failed) is reported `not_applicable`, never `true` — hashesAreEqual({},
  // {}) is trivially true, and rendering that as a verified pass would be
  // exactly the vacuous claim this finding closes.
  report.preserved_receipt_hashes_after = preservedReceiptHashesAfter;
  report.receipt_byte_identity_verified = receiptsChecked === 0 ? 'not_applicable' : true;

  report.summary = formatPlanSummary(report);
  return report;
}

/**
 * Compute a sha256 hash over the identity-carrying fields of every agent_run
 * currently 'complete' in this wave (status, output_path, completed_at) PLUS
 * the full agent_state_events row chain for that agent. Any byte-level
 * change to a complete row trips this gate.
 *
 * F-a5f6b585: queries the DB directly by (wave_id, status='complete') —
 * deliberately NOT parameterized by the caller's `preserved` classification
 * array. The watch-set must be independent of the classification the gate
 * exists to police, or a classification bug (routing a 'complete' row into
 * `eligible`) silently narrows the watch-set to nothing instead of tripping
 * it. Called once before the tx (captures whatever is complete now) and once
 * inside the tx after the transitions land (captures what is complete
 * after) — both calls use this same independent query.
 *
 * Returns an object keyed by agent_run_id so a mismatch can be localized to
 * a specific row (the test asserts this shape).
 */
function computeReceiptHashes(db, waveId) {
  const completeIds = db.prepare(
    `SELECT id FROM agent_runs WHERE wave_id = ? AND status = 'complete'`
  ).all(waveId).map(r => r.id);

  const out = {};
  for (const id of completeIds) {
    const ar = db.prepare(
      'SELECT id, status, output_path, completed_at FROM agent_runs WHERE id = ?'
    ).get(id);
    const events = db.prepare(
      'SELECT id, agent_run_id, from_status, to_status, reason, created_at ' +
      'FROM agent_state_events WHERE agent_run_id = ? ORDER BY id'
    ).all(id);
    const payload = JSON.stringify({ ar, events });
    out[id] = createHash('sha256').update(payload).digest('hex');
  }
  return out;
}

function hashesAreEqual(a, b) {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (a[keysA[i]] !== b[keysB[i]]) return false;
  }
  return true;
}

/**
 * Human-readable plan summary. Used both for the dry-run preview and the
 * post-apply confirmation. Names what's preserved, what's redriven, what's
 * refused, plus the wave transition.
 *
 * 5B-1 fold-in (T4): preserved-count surface. Both rewind and redrive name
 * the preserved counts on dedicated lines.
 */
function formatPlanSummary(report) {
  const verb = report.apply ? 'Redrive (APPLIED)' : 'Redrive (DRY-RUN)';
  const lines = [];
  lines.push(`${verb} — wave_id: ${report.waveId} (run ${report.runId}, ${report.phase}, #${report.waveNumber})`);
  lines.push(`  Wave status: ${report.waveStatusBefore} -> ${REDRIVE_TARGET_STATUS}`);
  lines.push(`  Preserved: ${report.preserved.length} complete agent_runs (receipts unchanged)${formatByteIdentitySuffix(report)}`);
  lines.push(`  Redriven:  ${report.eligible.length} agent_runs to ${REDRIVE_TARGET_STATUS}`);
  lines.push(`  Refused:   ${report.refused.length} agent_runs (named recovery verb per row)`);
  if (report.apply) {
    lines.push(`  Reason recorded: "${report.reasonRecorded}"`);
  } else {
    lines.push(`  Reason would be: "redrive: ${report.reason}"`);
    lines.push('  Re-run with --apply to mutate.');
  }
  return lines.join('\n');
}

/**
 * F-a5f6b585: render the VERIFIED byte-identity claim next to the Preserved:
 * line, instead of leaving the printed text to imply verification from the
 * classification alone (the pre-fix bug this closes). Dry-run renders
 * nothing extra — apply was never attempted, so there is no verified claim
 * to print yet; the Preserved: count there is a preview, not a claim.
 */
function formatByteIdentitySuffix(report) {
  if (!report.apply) return '';
  const v = report.receipt_byte_identity_verified;
  if (v === 'not_applicable') return ' — byte-identity: not_applicable (0 checked)';
  return ` — byte-identity: VERIFIED (${report.receipts_checked} checked)`;
}

/**
 * Human-readable formatter for the redrive report. Mirrors formatRewind.
 */
export function formatRedrive(report) {
  let out = report.summary + '\n';

  if (report.preserved.length > 0) {
    out += '\nPreserved (complete — receipts unchanged):\n';
    for (const p of report.preserved) {
      out += `  agent_run=${p.agent_run_id} (domain=${p.domain}): ${p.from_status} — ${p.note}\n`;
    }
  }

  if (report.eligible.length > 0) {
    out += '\nRedriven:\n';
    for (const a of report.eligible) {
      const tag = a.applied ? '[APPLIED]' : '[would]';
      out += `  ${tag} agent_run=${a.agent_run_id} (domain=${a.domain}): ${a.from_status} -> ${a.to_status} — ${a.note}\n`;
    }
  }

  if (report.refused.length > 0) {
    out += '\nRefused:\n';
    for (const r of report.refused) {
      out += `  agent_run=${r.agent_run_id} (domain=${r.domain}): ${r.from_status} — ${r.reason}\n`;
    }
  }

  out += '\nWave:\n';
  const wt = report.planned_wave_transition;
  const wtag = wt.applied ? '[APPLIED]' : (report.apply ? '[would]' : '[would]');
  if (wt.needs_transition) {
    out += `  ${wtag} wave_id=${wt.wave_id}: ${wt.from_status} -> ${wt.to_status}\n`;
  } else {
    out += `  ${wtag} wave_id=${wt.wave_id}: already at ${wt.to_status} — audit row only\n`;
  }

  return out;
}
