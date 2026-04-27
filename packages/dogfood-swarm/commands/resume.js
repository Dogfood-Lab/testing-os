/**
 * resume.js — `swarm resume`
 *
 * Reads agent-level state from the control plane and dispatches only incomplete work.
 * Never re-runs complete agents. Never reconstructs from disk heuristics.
 *
 * All state transitions go through the state machine. No ad-hoc status updates.
 *
 * Agent states and what resume does:
 *   complete            → skip
 *   dispatched/running  → apply timeout policy; if timed out, redispatch
 *   pending             → dispatch
 *   failed              → redispatch
 *   timed_out           → redispatch
 *   invalid_output      → BLOCKED — report, do not redispatch
 *   ownership_violation → BLOCKED — report, do not redispatch
 */

import { openDb } from '../db/connection.js';
import { getDomains } from '../lib/domains.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from '../lib/templates.js';
import { findingsForDomain } from '../lib/findings-filter.js';
import {
  applyTimeoutPolicy, getTimeoutPolicy,
  isBlocked, isTerminal, isRedispatchable, isInFlight,
  transitionAgent,
} from '../lib/state-machine.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — where to write re-dispatch prompts
 * @param {number} [opts.nowMs] — override current time for testing
 * @returns {object} — resume report
 */
export function resume(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  if (run.status === 'complete') {
    return { action: 'none', reason: 'Run is already complete' };
  }

  // Find the latest wave
  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ?
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);

  if (!wave) {
    return { action: 'none', reason: 'No waves found — run `swarm dispatch` first' };
  }

  // Step 1: Apply timeout policy to in-flight agents (deterministic)
  const timeoutMs = getTimeoutPolicy(db, opts.runId);
  const timedOutAgents = applyTimeoutPolicy(db, wave.id, timeoutMs, opts.nowMs);

  // Step 2: Read the LATEST agent_run per domain (after timeout policy applied).
  //
  // Repeated `swarm resume` invocations create new agent_run rows per
  // redispatch (see line 116-119 below). Iterating ALL rows on a second
  // resume call would re-process the original failed row and INSERT another
  // redispatch for the same domain, growing agent_runs without bound. The
  // window function picks the latest row per domain so each domain's current
  // state drives at most one redispatch per resume call.
  const agentRuns = db.prepare(`
    SELECT ar.*, d.name as domain_name, d.globs
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
      AND ar.id = (
        SELECT MAX(ar2.id) FROM agent_runs ar2
        WHERE ar2.wave_id = ar.wave_id AND ar2.domain_id = ar.domain_id
      )
  `).all(wave.id);

  const report = {
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    timeoutPolicy: `${Math.round(timeoutMs / 1000)}s`,
    complete: [],
    redispatch: [],
    manual_fix: [],
    timed_out: timedOutAgents,
    still_running: [],
    prompts: [],
  };

  for (const ar of agentRuns) {
    // Terminal: skip
    if (isTerminal(ar.status)) {
      report.complete.push({ domain: ar.domain_name, agentRunId: ar.id });
      continue;
    }

    // Blocked: report, no redispatch
    if (isBlocked(ar.status)) {
      report.manual_fix.push({
        domain: ar.domain_name,
        agentRunId: ar.id,
        status: ar.status,
        error: ar.error_message,
      });
      continue;
    }

    // In-flight but not timed out: still running, leave alone
    if (isInFlight(ar.status)) {
      report.still_running.push({
        domain: ar.domain_name,
        agentRunId: ar.id,
        status: ar.status,
        started: ar.started_at,
      });
      continue;
    }

    // Redispatchable: create new agent_run via state machine
    if (isRedispatchable(ar.status)) {
      // Create a new agent_run for this domain
      const newAr = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'pending')
      `).run(wave.id, ar.domain_id);
      const newArId = Number(newAr.lastInsertRowid);

      // Transition new agent to dispatched
      transitionAgent(db, newArId, 'dispatched',
        `Redispatch: previous agent ${ar.id} was "${ar.status}"`);

      // Generate prompt
      const globs = JSON.parse(ar.globs);
      const promptOpts = {
        repoPath: run.local_path,
        repo: run.repo,
        domainName: ar.domain_name,
        globs,
        phase: wave.phase,
        waveNumber: wave.wave_number,
      };

      let prompt;
      if (wave.phase === 'feature-audit') {
        prompt = buildFeatureAuditPrompt(promptOpts);
      } else if (wave.phase.includes('amend') || wave.phase.includes('execute')) {
        // Same domain-glob filter as dispatch — see lib/findings-filter.js.
        // The previous code unconditionally sent every approved finding to
        // every redispatched agent (F-742440-003).
        const findings = findingsForDomain(db, opts.runId, { globs });
        prompt = buildAmendPrompt({ ...promptOpts, findings });
      } else {
        prompt = buildAuditPrompt(promptOpts);
      }

      const promptDir = join(opts.outputDir, `wave-${wave.wave_number}-resume`);
      if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
      const promptPath = join(promptDir, `${ar.domain_name}.md`);
      writeFileSync(promptPath, prompt, 'utf-8');

      report.redispatch.push({
        domain: ar.domain_name,
        oldAgentRunId: ar.id,
        newAgentRunId: newArId,
        promptPath,
        previousStatus: ar.status,
      });
      report.prompts.push(promptPath);
    }
  }

  // Determine overall action
  const totalAgents = agentRuns.length;
  if (report.complete.length === totalAgents) {
    report.action = 'all_complete';
    report.reason = 'All agents complete. Ready for collect.';
  } else if (report.manual_fix.length > 0 && report.redispatch.length === 0 && report.still_running.length === 0) {
    report.action = 'blocked';
    report.reason = `${report.manual_fix.length} agents blocked (${report.manual_fix.map(m => `${m.domain}: ${m.status}`).join(', ')})`;
  } else if (report.redispatch.length > 0) {
    report.action = 'redispatched';
    report.reason = `Redispatched ${report.redispatch.length} agents`;
  } else if (report.still_running.length > 0) {
    report.action = 'waiting';
    report.reason = `${report.still_running.length} agents still in-flight`;
  } else {
    report.action = 'unknown';
    report.reason = 'Unexpected state — inspect manually';
  }

  return report;
}

/**
 * Format resume report as human-readable text.
 */
export function formatResume(r) {
  const lines = [];

  lines.push(`Resume — Wave ${r.waveNumber} (${r.phase})`);
  lines.push(`Timeout policy: ${r.timeoutPolicy}`);
  lines.push(`Action: ${r.action} — ${r.reason}`);
  lines.push('');

  if (r.complete.length > 0) {
    lines.push(`Complete (${r.complete.length}):`);
    for (const a of r.complete) lines.push(`  [OK  ] ${a.domain}`);
  }

  if (r.still_running.length > 0) {
    lines.push(`In-flight (${r.still_running.length}):`);
    for (const a of r.still_running) lines.push(`  [RUN ] ${a.domain} — since ${a.started || '?'}`);
  }

  if (r.timed_out.length > 0) {
    lines.push(`Timed out (${r.timed_out.length}):`);
    for (const a of r.timed_out) lines.push(`  [TIME] ${a.domain}`);
  }

  if (r.redispatch.length > 0) {
    lines.push(`Redispatched (${r.redispatch.length}):`);
    for (const a of r.redispatch) {
      lines.push(`  [>>  ] ${a.domain} (was: ${a.previousStatus}) → ${a.promptPath}`);
    }
  }

  if (r.manual_fix.length > 0) {
    lines.push(`Blocked — manual fix required (${r.manual_fix.length}):`);
    for (const a of r.manual_fix) {
      lines.push(`  [STOP] ${a.domain} — ${a.status}: ${a.error || 'no details'}`);
    }
  }

  return lines.join('\n');
}
