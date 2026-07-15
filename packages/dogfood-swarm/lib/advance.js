/**
 * advance.js — Advancement law for the swarm control plane.
 *
 * Formalizes what blocks advance, what requires amend, what permits promotion.
 * Every advancement is recorded as a promotion with gate results and override trail.
 *
 * Phase progression:
 *   health-audit-a  → health-amend-a  → health-audit-a (repeat) OR health-audit-b
 *   health-audit-b  → health-amend-b  → health-audit-b (repeat) OR health-audit-c
 *   health-audit-c  → health-amend-c  → health-audit-c (repeat) OR stage-d-audit
 *   stage-d-audit   → stage-d-amend   → stage-d-audit (repeat)  OR feature-audit
 *   feature-audit   → feature-execute → feature-audit (repeat)  OR test
 *   test            → treatment
 *   treatment       → complete
 *
 * Amend phases advance back to their audit phase:
 *   health-amend-a  → health-audit-a (re-audit)
 *   health-amend-b  → health-audit-b (re-audit)
 *   health-amend-c  → health-audit-c (re-audit)
 *   stage-d-amend   → stage-d-audit  (re-audit)
 *   feature-execute → feature-audit  (re-audit)
 *
 * Gate verdicts:
 *   BLOCK   — hard gate failure, cannot advance
 *   AMEND   — findings need fixing before advancing to next stage
 *   VERIFY  — wave collected but not verified yet
 *   ADVANCE — all gates passed, ready for next phase
 */

import { openDb } from '../db/connection.js';
import { isBlocked, isInFlight } from './state-machine.js';
import { transitionWave } from './wave-state-machine.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from './queries/latest-agent-runs.js';
import { cleanupRunWorktrees } from './worktree.js';
import { logStage } from './log-stage.js';
import { CLOSED_FINDING_STATUSES_SQL } from './finding-status.js';
import { getLatestAdjudication } from './adjudication-store.js';

/**
 * Phase progression map.
 * Each phase maps to: { amend: phase to amend, next: phase after clean pass, reaudit: phase after amend }
 */
const PHASE_MAP = {
  'health-audit-a':  { amend: 'health-amend-a',  next: 'health-audit-b', reaudit: null },
  'health-amend-a':  { amend: null,               next: 'health-audit-a', reaudit: null },
  'health-audit-b':  { amend: 'health-amend-b',  next: 'health-audit-c', reaudit: null },
  'health-amend-b':  { amend: null,               next: 'health-audit-b', reaudit: null },
  'health-audit-c':  { amend: 'health-amend-c',  next: 'stage-d-audit',  reaudit: null },
  'health-amend-c':  { amend: null,               next: 'health-audit-c', reaudit: null },
  'stage-d-audit':   { amend: 'stage-d-amend',   next: 'feature-audit',  reaudit: null },
  'stage-d-amend':   { amend: null,               next: 'stage-d-audit',  reaudit: null },
  'feature-audit':   { amend: 'feature-execute',  next: 'test',           reaudit: null },
  'feature-execute': { amend: null,               next: 'feature-audit',  reaudit: null },
  'test':            { amend: null,               next: 'treatment',      reaudit: null },
  'treatment':       { amend: null,               next: 'complete',       reaudit: null },
};

/**
 * Phases where HIGH/CRITICAL findings block advancement to next stage.
 *
 * Stage D (Visual Polish) is finding-gated alongside the health-audit-a/b/c
 * stages: per dogfood-swarm.md, "polish IS quality" — visual findings are
 * triaged with the same severity rigor as bug fixes, so HIGH/CRITICAL must
 * resolve before advance.
 */
const FINDING_GATED_PHASES = new Set([
  'health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit',
]);

/**
 * Check all advancement gates for a wave.
 *
 * @param {Database} db
 * @param {string} runId
 * @returns {object} — { verdict, nextPhase, gates, overridable, reason }
 */
export function checkGates(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1
  `).get(runId);
  if (!wave) return { verdict: 'BLOCK', gates: [], reason: 'No waves found' };

  const phaseInfo = PHASE_MAP[wave.phase];
  if (!phaseInfo) return { verdict: 'BLOCK', gates: [], reason: `Unknown phase: ${wave.phase}` };

  // Read the LATEST agent_run per (wave_id, domain_id). After `swarm resume`
  // runs, the wave gains a new agent_run row per redispatched domain (resume.js
  // INSERTs at status='pending', then transitions to 'dispatched'); the OLD
  // failed/timed_out row remains. Iterating ALL rows would surface the stale
  // row to checkAgentCompletion() and report "BLOCK: <N> agent(s) not complete"
  // even when every redispatched agent finished cleanly — silently blocking
  // `swarm advance` after every successful resume cycle.
  //
  // F-W1-BACK-005 / F-084568-005 (mutation-side fix). F-H6/H7/H8 (Wave A1 D3):
  // SQL fragment now lives in lib/queries/latest-agent-runs.js.
  const agents = db.prepare(`
    SELECT ar.*, d.name as domain_name
    FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
  `).all(wave.id);

  // F-feb78e7b (DESIGN RULING): evaluate ALL six gates unconditionally and
  // return the full array. The pre-fix code returned at the FIRST failing
  // gate, so gateResult.gates never contained the gates after it — and the
  // override branch in advance() then promoted past EVERY unevaluated gate,
  // including the NON-overridable serial-verify gate (F-d12da6ea). The
  // override master-key hole and the permanently-incomplete gates_checked
  // audit trail were the same defect: verdicts computed from a truncated
  // gate set. Each gate now carries its own `overridable` flag so advance()
  // can mask ONLY individually-overridable failures.
  const waveGate = { ...checkWaveStatus(wave), overridable: false };
  const agentGate = { ...checkAgentCompletion(agents), overridable: false };
  const violationGate = { ...checkViolations(db, runId), overridable: true };
  const verifyGateRaw = checkVerification(db, wave);
  // The serial-verify obligation (verdict:'VERIFY') is the one deliberately
  // NON-overridable verification failure; a plain failed receipt stays
  // overridable (matches the pre-fix BLOCK/overridable:true branch).
  const verifyGate = { ...verifyGateRaw, overridable: verifyGateRaw.verdict !== 'VERIFY' };
  const findingGate = { ...checkFindingSeverity(db, runId, wave.phase), overridable: true };
  // v9: the cross-family jury gate. ADVISORY — evidence, not law — so it is
  // overridable: an absent adjudication does not block (like verification), and a
  // present NON-corroborate verdict blocks only until Director disposition
  // (--override --reason). Only the deterministic verify floor is non-overridable.
  const adjudicationGate = { ...checkAdjudication(db, wave), overridable: true };
  const gates = [waveGate, agentGate, violationGate, verifyGate, findingGate, adjudicationGate];

  // Verdict precedence (F-feb78e7b): the first NON-overridable failure
  // dominates — BLOCK for gates 1-2, VERIFY for the serial-verify
  // obligation — then AMEND for the finding gate in gated phases, then the
  // overridable BLOCKs (ownership, failed receipt) in gate order.
  if (!waveGate.passed) {
    return { verdict: waveGate.verdict || 'BLOCK', nextPhase: null, gates, overridable: false, reason: waveGate.reason };
  }
  if (!agentGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: false, reason: agentGate.reason };
  }
  if (!verifyGate.passed && verifyGate.verdict === 'VERIFY') {
    return { verdict: 'VERIFY', nextPhase: null, gates, overridable: false, reason: verifyGate.reason };
  }
  if (!findingGate.passed && FINDING_GATED_PHASES.has(wave.phase)) {
    // Findings need amending — go to amend phase
    return {
      verdict: 'AMEND',
      nextPhase: phaseInfo.amend,
      gates,
      overridable: true,
      reason: findingGate.reason,
    };
  }
  if (!violationGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: true, reason: violationGate.reason };
  }
  if (!verifyGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: true, reason: verifyGate.reason };
  }
  // The advisory jury gate is LAST among the overridable blocks — the
  // deterministic floor (verifyGate) outranks it, because the jury is evidence
  // and the floor is law. A non-corroborate verdict surfaces here for Director
  // disposition; an --override --reason on advance consents to it.
  if (!adjudicationGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: true, reason: adjudicationGate.reason };
  }

  // All gates passed — advance to next phase
  return {
    verdict: 'ADVANCE',
    nextPhase: phaseInfo.next,
    gates,
    overridable: false,
    reason: `All gates passed. Next: ${phaseInfo.next}`,
  };
}

/**
 * Record a promotion (advancement from one phase to the next).
 *
 * @param {Database} db
 * @param {string} runId
 * @param {number} waveId
 * @param {string} fromPhase
 * @param {string} toPhase
 * @param {object} opts
 * @param {string} [opts.authorizedBy]
 * @param {Array} opts.gates — gate check results
 * @param {Array} [opts.overrides] — override reasons
 * @returns {number} — promotion id
 */
export function recordPromotion(db, runId, waveId, fromPhase, toPhase, opts) {
  // Snapshot current finding state
  const findings = db.prepare('SELECT severity, status FROM findings WHERE run_id = ?').all(runId);
  const snapshot = {
    total: findings.length,
    bySeverity: {},
    byStatus: {},
  };
  for (const f of findings) {
    snapshot.bySeverity[f.severity] = (snapshot.bySeverity[f.severity] || 0) + 1;
    snapshot.byStatus[f.status] = (snapshot.byStatus[f.status] || 0) + 1;
  }

  // sm-003: a promotion records an IRREVERSIBLE gate decision, so its three
  // durable writes — INSERT promotions, transitionWave(...,'advanced'), and the
  // runs.status UPDATE — must land together or not at all. Pre-fix they ran
  // unwrapped: a throw in transitionWave (e.g. a concurrent collect moved the
  // wave out of collected/verified → STATE_MACHINE_INVALID) left a promotion
  // row with no wave transition and a stale runs.status — a half-applied
  // advancement that corrupts the gate-evidence trail. Mirror the D3B-002
  // pattern in dispatch.js: one outer db.transaction(); better-sqlite3 collapses
  // transitionWave's own executeTransition self-wrap into a SAVEPOINT, so the
  // promotion row, the wave_state_events audit row, and the runs.status update
  // commit or roll back as a unit.
  const promote = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO promotions (wave_id, run_id, from_phase, to_phase, authorized_by, gates_checked, overrides, finding_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      waveId, runId, fromPhase, toPhase,
      opts.authorizedBy || 'coordinator',
      JSON.stringify(opts.gates),
      opts.overrides ? JSON.stringify(opts.overrides) : null,
      JSON.stringify(snapshot),
    );

    const promotionId = Number(result.lastInsertRowid);

    // Mark wave as advanced via the lawful state machine (Phase 5A). The
    // promotion row above is the contractual evidence of the gate-check
    // outcome; the wave_state_events row below records the wave-status
    // transition itself with the promotion id in the reason for forensic
    // linkage. Legal source states are 'collected' (verify skipped or not yet
    // run) and 'verified' (verify passed).
    transitionWave(
      db,
      waveId,
      'advanced',
      `advance: promotion #${promotionId} ${fromPhase} → ${toPhase}`
    );

    // Update run status
    if (toPhase === 'complete') {
      db.prepare("UPDATE runs SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(runId);
    } else {
      db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(toPhase, runId);
    }

    return promotionId;
  });

  const promotionId = promote();

  // d4-swarm-core-B001: wire the cleanup half of the documented worktree
  // lifecycle (lib/worktree.js header: dispatch creates → collect merges →
  // cleanup removes). dispatch.js creates per-agent worktrees under --isolate
  // and persists worktree_path/worktree_branch, collect.js reads them, but
  // NOTHING tore them down — so every --isolate wave stranded its
  // .swarm/worktrees/w<N>-<domain>/ dir + swarm/* branch on disk forever.
  // The run's LAWFUL terminal transition (toPhase === 'complete') is the
  // right place to reclaim them: by then no further wave will read from any
  // worktree of this run.
  //
  // This runs AFTER the promotion transaction has COMMITTED, on purpose: the
  // gate decision (promotion row + wave transition + runs.status) is the
  // load-bearing, atomic write; the filesystem teardown is an advisory
  // side-effect that must never roll the gate decision back. It is also
  // best-effort — cleanupAllWorktrees is itself internally hardened (each
  // removeWorktree swallows "already gone"; the `worktree prune` step emits
  // its own worktree_prune_failed breadcrumb) — and the extra try/catch here
  // guarantees that even a wholly-unexpected throw cannot sink the wave. A
  // failure leaves a worktree_cleanup_failed row naming the run + path so the
  // operator can `git worktree prune` manually. Mirrors the B002 rewind-path
  // cleanup and dispatch.js's documented FS-orphan trade-off.
  if (toPhase === 'complete') {
    const run = db.prepare('SELECT local_path, branch FROM runs WHERE id = ?').get(runId);
    if (run && run.local_path) {
      try {
        // F-e7369293: scope the sweep to THIS run's worktrees (run-short
        // branch prefix, same filter as `swarm clean`). cleanupAllWorktrees
        // is repo-wide and would tear down a concurrent run's in-flight
        // --isolate worktrees in the same repo.
        //
        // F-1ab3fd1f: the run branch is the merged-check baseline — the
        // cleanup skips (and loudly names) any worktree with uncommitted
        // edits or unmerged commits instead of force-destroying agent work
        // that never merged. `swarm clean --apply` is the only verb that may
        // remove preserved work.
        cleanupRunWorktrees(run.local_path, runId, { mainBranch: run.branch });
      } catch (e) {
        logStage('worktree_cleanup_failed', {
          component: 'dogfood-swarm',
          runId,
          repoPath: run.local_path,
          promotionId,
          err: e?.message,
        });
      }
    }
  }

  return promotionId;
}

/**
 * Perform advancement: check gates, record promotion if allowed.
 *
 * @param {Database} db
 * @param {string} runId
 * @param {object} [opts]
 * @param {boolean} [opts.override] — force advancement past overridable gates
 * @param {string} [opts.overrideReason] — required if override is true
 * @param {string} [opts.authorizedBy]
 * @returns {object} — { promoted, verdict, fromPhase, toPhase, promotionId, gates }
 */
export function advance(db, runId, opts = {}) {
  const gateResult = checkGates(db, runId);

  if (gateResult.verdict === 'ADVANCE') {
    const wave = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1').get(runId);
    const promotionId = recordPromotion(db, runId, wave.id, wave.phase, gateResult.nextPhase, {
      authorizedBy: opts.authorizedBy,
      gates: gateResult.gates,
    });
    return {
      promoted: true,
      verdict: 'ADVANCE',
      fromPhase: wave.phase,
      toPhase: gateResult.nextPhase,
      promotionId,
      gates: gateResult.gates,
    };
  }

  // F-feb78e7b (DESIGN RULING): an override is consent to the NAMED,
  // individually-overridable gate failures — never a master key. checkGates
  // now evaluates all six gates, so the failure set here is complete; the
  // pre-fix branches keyed on the verdict of a TRUNCATED gate array and
  // promoted past every gate that was never evaluated (including the
  // non-overridable serial-verify gate). Any non-overridable failure refuses
  // the override outright; a lawful override records EVERY evaluated gate in
  // gates_checked with `overridden: true` on the masked ones.
  //
  // F-5a251061 semantics preserved: overriding a failed finding gate (the
  // AMEND verdict) promotes PAST the gate to the phase's `next` stage — not
  // into the amend loop the operator explicitly chose to skip.
  // F-1c0188c9: an override that is REFUSED because a non-overridable gate
  // dominates must be distinguishable at the operator surface from a plain
  // block where no override was attempted. Capture the refusal here so the
  // non-promoted returns below carry an explicit marker; cmdAdvance surfaces
  // it. Observability only — the promotion decision is unchanged.
  let refusal = null;
  if (opts.override && opts.overrideReason) {
    const failedGates = gateResult.gates.filter(g => !g.passed);
    const nonOverridable = failedGates.filter(g => !g.overridable);
    if (failedGates.length > 0 && nonOverridable.length === 0) {
      const wave = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1').get(runId);
      const toPhase = PHASE_MAP[wave.phase]?.next || wave.phase;
      const gatesChecked = gateResult.gates.map(g => (g.passed ? g : { ...g, overridden: true }));
      const promotionId = recordPromotion(db, runId, wave.id, wave.phase, toPhase, {
        authorizedBy: opts.authorizedBy,
        gates: gatesChecked,
        overrides: failedGates.map(g => ({ gate: g.name, reason: opts.overrideReason })),
      });
      return {
        promoted: true,
        verdict: 'ADVANCE (override)',
        fromPhase: wave.phase,
        toPhase,
        promotionId,
        gates: gatesChecked,
      };
    }
    if (nonOverridable.length > 0) {
      // A non-overridable gate outranked the override — refused. Fall through
      // to the non-promoted return, now carrying the refusal trail.
      refusal = { overrideRefused: true, refusedBy: nonOverridable.map(g => g.name) };
    }
  }

  if (gateResult.verdict === 'AMEND') {
    // AMEND means: approve findings, then dispatch amend wave
    return {
      promoted: false,
      verdict: 'AMEND',
      nextPhase: gateResult.nextPhase,
      reason: gateResult.reason,
      gates: gateResult.gates,
      ...refusal,
    };
  }

  return {
    promoted: false,
    verdict: gateResult.verdict,
    reason: gateResult.reason,
    gates: gateResult.gates,
    ...refusal,
  };
}

/**
 * Get promotion history for a run.
 */
export function getPromotions(db, runId) {
  return db.prepare('SELECT * FROM promotions WHERE run_id = ? ORDER BY created_at').all(runId)
    .map(p => ({
      ...p,
      gates_checked: JSON.parse(p.gates_checked),
      overrides: p.overrides ? JSON.parse(p.overrides) : null,
      finding_snapshot: p.finding_snapshot ? JSON.parse(p.finding_snapshot) : null,
    }));
}

// ── Gate check functions ──

function checkWaveStatus(wave) {
  if (wave.status === 'collected' || wave.status === 'verified') {
    return { name: 'wave_status', passed: true, reason: `Wave is ${wave.status}` };
  }
  if (wave.status === 'dispatched') {
    return { name: 'wave_status', passed: false, verdict: 'BLOCK', reason: 'Wave still dispatched — run `swarm collect` first' };
  }
  if (wave.status === 'failed') {
    return { name: 'wave_status', passed: false, verdict: 'BLOCK', reason: 'Wave failed — fix issues before advancing' };
  }
  return { name: 'wave_status', passed: false, verdict: 'BLOCK', reason: `Unexpected wave status: ${wave.status}` };
}

function checkAgentCompletion(agents) {
  const blocked = agents.filter(a => isBlocked(a.status));
  const inFlight = agents.filter(a => isInFlight(a.status));

  if (blocked.length > 0) {
    return {
      name: 'agent_completion',
      passed: false,
      reason: `${blocked.length} blocked agent(s): ${blocked.map(a => `${a.domain_name} (${a.status})`).join(', ')}`,
    };
  }
  if (inFlight.length > 0) {
    return {
      name: 'agent_completion',
      passed: false,
      reason: `${inFlight.length} agent(s) still in-flight`,
    };
  }

  const incomplete = agents.filter(a => a.status !== 'complete');
  if (incomplete.length > 0) {
    return {
      name: 'agent_completion',
      passed: false,
      reason: `${incomplete.length} agent(s) not complete: ${incomplete.map(a => a.domain_name).join(', ')}`,
    };
  }

  return { name: 'agent_completion', passed: true, reason: `All ${agents.length} agents complete` };
}

// F-4fa7e644: RUN-WIDE, not wave-scoped. The pre-fix query counted violations
// only among the CURRENT wave's agent_runs (the `agents` param, itself
// LATEST_AGENT_RUN_PER_DOMAIN-filtered for the current wave_id) — so once a
// run's latest wave advanced past a wave that recorded a real ownership
// violation (the normal AMEND -> dispatch-nextPhase sequence), that
// violation became permanently invisible to the gate, with no override and
// no log entry marking the loss. This mirrors commands/status.js's existing
// cross-wave `violations` aggregator (the one place that already queried
// run-wide) — same LATEST_AGENT_RUN_PER_DOMAIN-per-wave semantics, just
// applied to every wave of the run instead of one, so a stale/superseded
// agent_run from a `swarm resume` redispatch still cannot resurrect a row
// the surviving attempt doesn't have.
function checkViolations(db, runId) {
  const count = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_claims
    WHERE violation = 1 AND agent_run_id IN (
      SELECT ar.id FROM agent_runs ar
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    )
  `).get(runId);

  if (count.cnt > 0) {
    return {
      name: 'ownership',
      passed: false,
      reason: `${count.cnt} ownership violation(s) detected`,
    };
  }
  return { name: 'ownership', passed: true, reason: 'No ownership violations' };
}

function checkVerification(db, wave) {
  const receipt = db.prepare(
    'SELECT * FROM verification_receipts WHERE wave_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ).get(wave.id);

  // F-d12da6ea (TRUTH-001 enforcement): when the wave was dispatched under the
  // --skip-verify discipline, agents deliberately ran zero tests and the
  // coordinator's cumulative-tree verify is MANDATORY, not optional. Without
  // this branch a scripted `swarm advance` promoted the wave with zero
  // verification anywhere — `swarm status` refused (VERIFY REQUIRED) but the
  // actual gate did not. verdict:'VERIFY' lands in checkGates' NON-overridable
  // branch, matching the status surface.
  if (wave.serial_verify_required && !(receipt && receipt.passed)) {
    return {
      name: 'verification',
      passed: false,
      verdict: 'VERIFY',
      reason: receipt
        ? `serial verify required (--skip-verify wave) — latest verification failed (${receipt.repo_type}, exit ${receipt.exit_code}); fix and re-run \`swarm verify\``
        : 'serial verify required (--skip-verify wave) — no verification receipt; run `swarm verify` first',
    };
  }

  if (!receipt) {
    return {
      name: 'verification',
      passed: true, // verification is optional — absence is not a blocker
      verdict: null,
      reason: 'No verification run (optional)',
    };
  }
  if (receipt.passed) {
    return { name: 'verification', passed: true, reason: `Verification passed (${receipt.repo_type})` };
  }
  return {
    name: 'verification',
    passed: false,
    verdict: 'BLOCK',
    reason: `Verification failed (${receipt.repo_type}, exit ${receipt.exit_code})`,
  };
}

/**
 * v9 adjudication gate — the cross-family jury verdict.
 *
 * ADVISORY by design (the jury is evidence, not law):
 *   - No adjudication run  → PASS. Absence is not a blocker, exactly like
 *     verification's optional-absence branch. Running `swarm adjudicate` is an
 *     opt-in; a wave that never invoked the jury advances on the floor + findings.
 *   - overall 'corroborate' → PASS. The family-different panel agrees the
 *     artifact meets its criteria.
 *   - overall refute / contested / insufficient_context → FAIL, OVERRIDABLE.
 *     The jury flagged a problem (a decided failure, a split panel, or a
 *     coverage gap). It never HARD-blocks — that would make the advisory jury
 *     into law — but it requires Director disposition (`swarm advance --override
 *     --reason "..."`) so the non-corroborate verdict is consciously dispositioned,
 *     not silently rolled past. A recurring insufficient_context is the
 *     abstention-as-signal loop: the case-file (or the spec) has a gap to fill.
 */
function checkAdjudication(db, wave) {
  const adj = getLatestAdjudication(db, wave.id);
  if (!adj) {
    return {
      name: 'adjudication',
      passed: true,
      verdict: null,
      reason: 'No adjudication run (advisory gate — the jury is evidence, not law)',
    };
  }
  if (adj.overall === 'corroborate') {
    return {
      name: 'adjudication',
      passed: true,
      reason: `Jury corroborates (advisory; ${adj.panel_size}-seat cross-family panel)`,
    };
  }
  return {
    name: 'adjudication',
    passed: false,
    verdict: 'BLOCK',
    reason:
      `Jury verdict '${adj.overall}' (advisory, ${adj.panel_size}-seat panel) needs Director disposition — ` +
      'address the flagged criteria, or `swarm advance --override --reason "..."` to dispose. ' +
      'The deterministic floor remains the only non-overridable gate.',
  };
}

function checkFindingSeverity(db, runId, phase) {
  if (!FINDING_GATED_PHASES.has(phase)) {
    return { name: 'finding_severity', passed: true, reason: 'Phase is not finding-gated' };
  }

  const open = db.prepare(`
    SELECT severity, COUNT(*) as cnt FROM findings
    WHERE run_id = ? AND status NOT IN (${CLOSED_FINDING_STATUSES_SQL})
    GROUP BY severity
  `).all(runId);

  const counts = { CRITICAL: 0, HIGH: 0 };
  for (const row of open) {
    if (counts[row.severity] != null) counts[row.severity] = row.cnt;
  }

  if (counts.CRITICAL > 0 || counts.HIGH > 0) {
    return {
      name: 'finding_severity',
      passed: false,
      reason: `${counts.CRITICAL} CRITICAL + ${counts.HIGH} HIGH findings still open`,
    };
  }
  return { name: 'finding_severity', passed: true, reason: '0 CRITICAL + 0 HIGH open' };
}

export { PHASE_MAP, FINDING_GATED_PHASES };
