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

  const agents = db.prepare(`
    SELECT ar.*, d.name as domain_name
    FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
  `).all(wave.id);

  const gates = [];

  // ── Gate 1: Wave must be collected or verified ──
  const waveGate = checkWaveStatus(wave);
  gates.push(waveGate);
  if (!waveGate.passed) {
    return { verdict: waveGate.verdict, nextPhase: null, gates, overridable: false, reason: waveGate.reason };
  }

  // ── Gate 2: All agents must be complete (no blocked, no in-flight) ──
  const agentGate = checkAgentCompletion(agents);
  gates.push(agentGate);
  if (!agentGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: false, reason: agentGate.reason };
  }

  // ── Gate 3: No ownership violations ──
  const violationGate = checkViolations(db, wave.id, agents);
  gates.push(violationGate);
  if (!violationGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: true, reason: violationGate.reason };
  }

  // ── Gate 4: Verification must pass (if receipt exists) ──
  const verifyGate = checkVerification(db, wave.id);
  gates.push(verifyGate);
  if (!verifyGate.passed && verifyGate.verdict === 'VERIFY') {
    return { verdict: 'VERIFY', nextPhase: null, gates, overridable: false, reason: verifyGate.reason };
  }
  if (!verifyGate.passed) {
    return { verdict: 'BLOCK', nextPhase: null, gates, overridable: true, reason: verifyGate.reason };
  }

  // ── Gate 5: Finding severity gate (for audit phases) ──
  const findingGate = checkFindingSeverity(db, runId, wave.phase);
  gates.push(findingGate);

  // Determine next phase based on finding gate
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

  // Mark wave as advanced
  db.prepare("UPDATE waves SET status = 'advanced' WHERE id = ?").run(waveId);

  // Update run status
  if (toPhase === 'complete') {
    db.prepare("UPDATE runs SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(runId);
  } else {
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(toPhase, runId);
  }

  return Number(result.lastInsertRowid);
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

  if (gateResult.verdict === 'AMEND') {
    // AMEND means: approve findings, then dispatch amend wave
    const wave = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1').get(runId);
    if (opts.override && opts.overrideReason) {
      const promotionId = recordPromotion(db, runId, wave.id, wave.phase, gateResult.nextPhase, {
        authorizedBy: opts.authorizedBy,
        gates: gateResult.gates,
        overrides: [{ gate: 'finding_severity', reason: opts.overrideReason }],
      });
      return {
        promoted: true,
        verdict: 'ADVANCE (override)',
        fromPhase: wave.phase,
        toPhase: gateResult.nextPhase,
        promotionId,
        gates: gateResult.gates,
      };
    }
    return {
      promoted: false,
      verdict: 'AMEND',
      nextPhase: gateResult.nextPhase,
      reason: gateResult.reason,
      gates: gateResult.gates,
    };
  }

  if (gateResult.overridable && opts.override && opts.overrideReason) {
    const wave = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1').get(runId);
    const phaseInfo = PHASE_MAP[wave.phase];
    const toPhase = phaseInfo?.next || wave.phase;
    const promotionId = recordPromotion(db, runId, wave.id, wave.phase, toPhase, {
      authorizedBy: opts.authorizedBy,
      gates: gateResult.gates,
      overrides: [{ gate: gateResult.gates.find(g => !g.passed)?.name || 'unknown', reason: opts.overrideReason }],
    });
    return {
      promoted: true,
      verdict: 'ADVANCE (override)',
      fromPhase: wave.phase,
      toPhase,
      promotionId,
      gates: gateResult.gates,
    };
  }

  return {
    promoted: false,
    verdict: gateResult.verdict,
    reason: gateResult.reason,
    gates: gateResult.gates,
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

function checkViolations(db, waveId, agents) {
  const agentIds = agents.map(a => a.id);
  if (agentIds.length === 0) return { name: 'ownership', passed: true, reason: 'No agents' };

  const count = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_claims
    WHERE violation = 1 AND agent_run_id IN (${agentIds.map(() => '?').join(',')})
  `).get(...agentIds);

  if (count.cnt > 0) {
    return {
      name: 'ownership',
      passed: false,
      reason: `${count.cnt} ownership violation(s) detected`,
    };
  }
  return { name: 'ownership', passed: true, reason: 'No ownership violations' };
}

function checkVerification(db, waveId) {
  const receipt = db.prepare(
    'SELECT * FROM verification_receipts WHERE wave_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(waveId);

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

function checkFindingSeverity(db, runId, phase) {
  if (!FINDING_GATED_PHASES.has(phase)) {
    return { name: 'finding_severity', passed: true, reason: 'Phase is not finding-gated' };
  }

  const open = db.prepare(`
    SELECT severity, COUNT(*) as cnt FROM findings
    WHERE run_id = ? AND status NOT IN ('fixed', 'rejected', 'deferred')
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
