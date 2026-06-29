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
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { logStage } from '../lib/log-stage.js';
import { mintCorrelationId } from '../lib/correlation-id.js';

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
  // wave-9 latest-per-domain filter picks the latest row per domain so each
  // domain's current state drives at most one redispatch per resume call.
  // F-H6/H7/H8 (Wave A1 D3): SQL fragment now lives in
  // lib/queries/latest-agent-runs.js (shared with read-side callers).
  const agentRuns = db.prepare(`
    SELECT ar.*, d.name as domain_name, d.globs
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
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

  // Stage 1 — classify each agent_run and stash redispatch candidates so the
  // DB-mutation loop runs inside a single db.transaction() (D3B-002 sibling
  // to commands/dispatch.js). On any throw the whole redispatch wave rolls
  // back: zero new agent_runs, zero new agent_state_events. FS-side prompt
  // files for any iterations that already completed are NOT rolled back —
  // they become FS orphans (operator can grep + clean), same trade-off as
  // dispatch documents.
  const redispatchCandidates = [];
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

    if (isRedispatchable(ar.status)) {
      redispatchCandidates.push(ar);
    }
  }

  // Stage 2 — wrap the per-candidate INSERT agent_runs + transitionAgent
  // pair in one tx so the redispatch wave is all-or-nothing at the DB
  // level. better-sqlite3 nests the inner executeTransition self-wrap as a
  // SAVEPOINT inside this outer tx.
  const redispatched = [];
  const buildRedispatch = db.transaction(() => {
    for (const ar of redispatchCandidates) {
      const newAr = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'pending')
      `).run(wave.id, ar.domain_id);
      const newArId = Number(newAr.lastInsertRowid);

      transitionAgent(db, newArId, 'dispatched',
        `Redispatch: previous agent ${ar.id} was "${ar.status}"`);

      redispatched.push({ ar, newArId });
    }
  });
  buildRedispatch();

  // Stage 3 — FS-side prompt rendering. Outside the tx by design; a throw
  // here leaves the new agent rows committed (operator can re-render with
  // the prompt helpers; the redispatched wave is recoverable).
  for (const { ar, newArId } of redispatched) {
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
    atomicWriteFileSync(promptPath, prompt, 'utf-8');

    report.redispatch.push({
      domain: ar.domain_name,
      oldAgentRunId: ar.id,
      newAgentRunId: newArId,
      promptPath,
      previousStatus: ar.status,
    });
    report.prompts.push(promptPath);
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

    // d5-swarm-cli-B003 (Stage C): this is the ONE genuinely "I don't know what
    // state this wave is in" terminal case — reached only by a state-combination
    // the classifier did not anticipate (e.g. an agent_run carrying a
    // non-canonical status outside the 9-status set). Unlike every sibling
    // failure path (dispatch.js emitPreconditionFailed → logStage, collect.js
    // transition_skipped / upsert_findings_failed), it previously emitted NO
    // structured event — an operator grepping the NDJSON stream (the package's
    // own observability surface) got nothing for the case that most warrants a
    // forensic breadcrumb. Emit one greppable, correlated event before
    // returning so the 'inspect manually' dead-end ties to any follow-up the
    // operator runs. Purely additive: the report shape + return are unchanged.
    logStage('resume_unknown_state', {
      component: 'dogfood-swarm',
      correlation_id: mintCorrelationId(),
      runId: opts.runId,
      waveId: wave.id,
      waveNumber: wave.wave_number,
      phase: wave.phase,
      reason: report.reason,
      // The exact status set that fell through every classifier branch — the
      // payload an operator needs to see WHY this hit the unknown dead-end.
      agentStatuses: agentRuns.map(ar => ({
        domain: ar.domain_name,
        agentRunId: ar.id,
        status: ar.status,
      })),
    });
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
    lines.push(`Blocked — manual fix or \`swarm revalidate\` required (${r.manual_fix.length}):`);
    for (const a of r.manual_fix) {
      lines.push(`  [STOP] ${a.domain} — ${a.status}: ${a.error || 'no details'}`);
    }
    lines.push(`  Recovery: \`swarm revalidate <run-id> --reason "<text>" --domain=<domain>:<corrected.json> --apply\` (lawful override; dry-run without --apply).`);
  }

  return lines.join('\n');
}
