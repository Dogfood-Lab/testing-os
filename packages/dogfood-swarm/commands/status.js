/**
 * status.js — `swarm status`
 *
 * Query the control plane and produce a structured status report.
 * Shows: run state, current wave, domain snapshot, agent states,
 * finding counts (new/recurring/fixed), manual intervention needs,
 * wave resumability, and a "next action" recommendation.
 */

import { openDb } from '../db/connection.js';
import { isBlocked, isInFlight, getTimeoutPolicy } from '../lib/state-machine.js';

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @returns {object} — structured status
 */
export function status(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Domains
  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ?').all(opts.runId);

  // All waves
  const waves = db.prepare(
    'SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number'
  ).all(opts.runId);

  // Current wave (latest)
  const currentWave = waves[waves.length - 1] || null;

  // Agent runs for current wave
  let currentAgents = [];
  if (currentWave) {
    currentAgents = db.prepare(`
      SELECT ar.*, d.name as domain_name
      FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
    `).all(currentWave.id);
  }

  // Finding totals
  const allFindings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(opts.runId);

  const findingsBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const findingsByStatus = {};
  const openBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

  for (const f of allFindings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
    findingsByStatus[f.status] = (findingsByStatus[f.status] || 0) + 1;
    if (f.status !== 'fixed' && f.status !== 'rejected') {
      openBySeverity[f.severity] = (openBySeverity[f.severity] || 0) + 1;
    }
  }

  // Wave-specific finding counts
  let waveFindingCounts = { new: 0, recurring: 0, fixed: 0 };
  if (currentWave) {
    waveFindingCounts = {
      new: allFindings.filter(f => f.first_seen_wave === currentWave.id && f.status === 'new').length,
      recurring: allFindings.filter(f => f.last_seen_wave === currentWave.id && f.status === 'recurring').length,
      fixed: allFindings.filter(f => f.last_seen_wave === currentWave.id && f.status === 'fixed').length,
    };
  }

  // Violations across all waves
  const violations = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_claims
    WHERE violation = 1 AND agent_run_id IN (
      SELECT ar.id FROM agent_runs ar
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id = ?
    )
  `).get(opts.runId);

  // Verification receipts
  const lastReceipt = db.prepare(`
    SELECT vr.* FROM verification_receipts vr
    JOIN waves w ON vr.wave_id = w.id
    WHERE w.run_id = ?
    ORDER BY vr.created_at DESC LIMIT 1
  `).get(opts.runId);

  // Wave receipt
  const waveReceipt = currentWave
    ? db.prepare('SELECT * FROM wave_receipts WHERE wave_id = ?').get(currentWave.id)
    : null;

  // Agents needing manual intervention
  const blockedAgents = currentAgents.filter(a => isBlocked(a.status));
  const inFlightAgents = currentAgents.filter(a => isInFlight(a.status));
  const completeAgents = currentAgents.filter(a => a.status === 'complete');

  // Timeout policy
  const timeoutPolicy = getTimeoutPolicy(db, opts.runId);

  // Compute advanceability + next action
  const assessment = computeAssessment(
    currentWave, currentAgents, openBySeverity, blockedAgents, inFlightAgents,
    { runId: opts.runId }
  );

  return {
    run: {
      id: run.id,
      repo: run.repo,
      status: run.status,
      branch: run.branch,
      commitSha: run.commit_sha,
      savePointTag: run.save_point_tag,
      created: run.created_at,
      timeoutPolicy: `${Math.round(timeoutPolicy / 1000)}s`,
    },
    domains: domains.map(d => ({
      name: d.name,
      ownership: d.ownership_class,
      frozen: !!d.frozen,
      description: d.description,
    })),
    waves: {
      total: waves.length,
      current: currentWave ? {
        number: currentWave.wave_number,
        phase: currentWave.phase,
        status: currentWave.status,
        domainSnapshotId: currentWave.domain_snapshot_id,
      } : null,
    },
    agents: currentAgents.map(a => ({
      domain: a.domain_name,
      status: a.status,
      started: a.started_at,
      completed: a.completed_at,
      error: a.error_message,
    })),
    agentSummary: {
      total: currentAgents.length,
      complete: completeAgents.length,
      inFlight: inFlightAgents.length,
      blocked: blockedAgents.length,
    },
    findings: {
      total: allFindings.length,
      bySeverity: findingsBySeverity,
      byStatus: findingsByStatus,
      open: openBySeverity,
      thisWave: waveFindingCounts,
    },
    violations: violations?.cnt || 0,
    lastVerification: lastReceipt ? {
      passed: !!lastReceipt.passed,
      repoType: lastReceipt.repo_type,
      testCount: lastReceipt.test_count,
    } : null,
    waveReceipt: waveReceipt ? { json: waveReceipt.json_path, md: waveReceipt.md_path } : null,
    assessment,
  };
}

/**
 * Format status as human-readable text.
 */
export function formatStatus(s) {
  const lines = [];

  lines.push(`+------------------------------------------+`);
  lines.push(`|  SWARM CONTROL PLANE                     |`);
  lines.push(`+------------------------------------------+`);
  lines.push('');
  lines.push(`Run:     ${s.run.id}`);
  lines.push(`Repo:    ${s.run.repo}`);
  lines.push(`Status:  ${s.run.status}`);
  lines.push(`Branch:  ${s.run.branch} @ ${s.run.commitSha?.slice(0, 8)}`);
  lines.push(`Timeout: ${s.run.timeoutPolicy}`);
  lines.push('');

  // Domains
  const allFrozen = s.domains.every(d => d.frozen);
  lines.push(`Domains [${allFrozen ? 'FROZEN' : 'DRAFT'}]:`);
  for (const d of s.domains) {
    const cls = d.ownership.padEnd(6);
    lines.push(`  ${cls}  ${d.name}${d.description ? ' — ' + d.description : ''}`);
  }
  lines.push('');

  // Current wave
  if (s.waves.current) {
    const w = s.waves.current;
    lines.push(`Wave ${w.number}/${s.waves.total} — ${w.phase} [${w.status}]`);
    if (w.domainSnapshotId) lines.push(`  Snapshot: ${w.domainSnapshotId}`);
    lines.push('');

    // Agent table
    lines.push('Agents:');
    for (const a of s.agents) {
      const icon = STATUS_ICONS[a.status] || a.status;
      const detail = a.error ? ` — ${a.error}` : '';
      lines.push(`  [${icon}] ${a.domain}${detail}`);
    }
    lines.push(`  (${s.agentSummary.complete} complete, ${s.agentSummary.inFlight} in-flight, ${s.agentSummary.blocked} blocked)`);
    lines.push('');
  }

  // Findings
  const f = s.findings;
  lines.push('Findings:');
  lines.push(`  Open:  CRIT ${f.open.CRITICAL}  HIGH ${f.open.HIGH}  MED ${f.open.MEDIUM}  LOW ${f.open.LOW}  (${f.total} total)`);
  lines.push(`  Wave:  ${f.thisWave.new} new  ${f.thisWave.recurring} recurring  ${f.thisWave.fixed} fixed`);
  if (Object.keys(f.byStatus).length > 0) {
    lines.push(`  All:   ${Object.entries(f.byStatus).map(([k, v]) => `${k}: ${v}`).join('  ')}`);
  }
  lines.push('');

  if (s.violations > 0) {
    lines.push(`Ownership violations: ${s.violations}`);
    lines.push('');
  }

  if (s.lastVerification) {
    const v = s.lastVerification;
    lines.push(`Verify: ${v.passed ? 'PASS' : 'FAIL'} (${v.repoType}${v.testCount ? `, ${v.testCount} tests` : ''})`);
    lines.push('');
  }

  if (s.waveReceipt) {
    lines.push(`Receipt: ${s.waveReceipt.md}`);
    lines.push('');
  }

  // Assessment
  lines.push(`--- ${s.assessment.state} ---`);
  if (s.assessment.blockers.length > 0) {
    for (const b of s.assessment.blockers) lines.push(`  BLOCKER: ${b}`);
  }
  lines.push(`Next: ${s.assessment.nextAction}`);

  return lines.join('\n');
}

const STATUS_ICONS = {
  complete: 'OK  ',
  dispatched: '..  ',
  running: 'RUN ',
  pending: 'WAIT',
  failed: 'FAIL',
  timed_out: 'TIME',
  invalid_output: 'BAD ',
  ownership_violation: 'VIOL',
};

/**
 * F-091578-010 (wave-17): build a status-specific actionable hint when a
 * blocked agent has no `error_message`. The bare 'needs manual fix' fallback
 * was Mike's textbook "wrong shape" anti-pattern — this surfaces what's
 * known (status, domain, run, wave) and a copy-pasteable next step.
 *
 * Exported for direct unit testing without spinning up an entire wave.
 */
export function blockerHintForStatus(status, ctx = {}) {
  const { runId, waveNumber, domain } = ctx;
  switch (status) {
    case 'invalid_output':
      return [
        `output JSON failed schema validation`,
        runId && waveNumber && domain
          ? `re-run with the prompt at swarms/${runId}/wave-${waveNumber}/${domain}.md and ensure required fields are present`
          : `re-run with the agent prompt and ensure required fields are present`,
        `inspect parse errors with \`swarm receipt ${runId ?? '<run>'} ${waveNumber ?? '<wave>'}\``,
      ].join('; ');
    case 'ownership_violation':
      return [
        `agent edited files outside its domain`,
        `revert out-of-domain edits in the agent worktree, then re-collect`,
      ].join('; ');
    default:
      return `agent in '${status}' with no recoverable error — inspect with \`swarm receipt ${runId ?? '<run>'} ${waveNumber ?? '<wave>'}\``;
  }
}

function computeAssessment(wave, agents, openBySeverity, blocked, inFlight, ctx = {}) {
  if (!wave) {
    return { state: 'NO WAVE', blockers: [], nextAction: 'Run `swarm dispatch <run-id> <phase>`' };
  }

  const blockers = [];
  const hintCtx = { runId: ctx.runId, waveNumber: wave.wave_number };

  // Blocked agents
  if (blocked.length > 0) {
    for (const a of blocked) {
      const reason = a.error_message
        ? a.error_message
        : blockerHintForStatus(a.status, { ...hintCtx, domain: a.domain_name });
      blockers.push(`${a.domain_name}: ${a.status} — ${reason}`);
    }
  }

  // In-flight agents
  if (inFlight.length > 0) {
    return {
      state: 'IN PROGRESS',
      blockers,
      nextAction: `Waiting on ${inFlight.length} agent(s). Run \`swarm resume\` to check timeouts.`,
    };
  }

  // All done but blocked
  if (blocked.length > 0) {
    return {
      state: 'BLOCKED',
      blockers,
      nextAction: 'Fix blocked agents, then run `swarm collect` again.',
    };
  }

  // Check if all complete
  const allComplete = agents.every(a => a.status === 'complete');
  if (!allComplete) {
    const incomplete = agents.filter(a => a.status !== 'complete');
    return {
      state: 'INCOMPLETE',
      blockers,
      nextAction: `Run \`swarm resume\` — ${incomplete.length} agent(s) not complete.`,
    };
  }

  // All complete — wave status check
  if (wave.status === 'dispatched') {
    return {
      state: 'READY TO COLLECT',
      blockers,
      nextAction: 'Run `swarm collect` to merge outputs.',
    };
  }

  if (wave.status === 'collected' || wave.status === 'verified') {
    // Check severity gates
    if (wave.phase.startsWith('health-audit-a') && (openBySeverity.CRITICAL > 0 || openBySeverity.HIGH > 0)) {
      return {
        state: 'AMEND NEEDED',
        blockers,
        nextAction: `${openBySeverity.CRITICAL} CRITICAL + ${openBySeverity.HIGH} HIGH open. Run \`swarm approve\` then \`swarm dispatch <run-id> health-amend-a\`.`,
      };
    }
    return {
      state: 'READY TO ADVANCE',
      blockers,
      nextAction: 'Wave complete. Export receipt, then dispatch next phase.',
    };
  }

  if (wave.status === 'failed') {
    return {
      state: 'WAVE FAILED',
      blockers,
      nextAction: 'Inspect failures. Fix and re-collect, or dispatch a new wave.',
    };
  }

  return {
    state: wave.status.toUpperCase(),
    blockers,
    nextAction: 'Inspect wave state.',
  };
}
