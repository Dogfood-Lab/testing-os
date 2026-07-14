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
import { createWorktree } from '../lib/worktree.js';
import { IsolationError } from '../lib/errors.js';
import { SKIP_VERIFY_DIRECTIVE } from './dispatch.js';
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
    runId: opts.runId,
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    timeoutPolicy: `${Math.round(timeoutMs / 1000)}s`,
    complete: [],
    // ds-lib-002: aborted_for_rewind agents are terminal but NOT collectable —
    // kept in a distinct bucket so a rewound wave never masquerades as complete.
    rewound: [],
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
    // Terminal: skip redispatch. But ONLY `complete` is collectable —
    // ds-lib-002: isTerminal() also matches `aborted_for_rewind`, so bucketing
    // every terminal status as complete made a rewound wave report all_complete
    // and render its aborted agents as [OK], inviting a collect over a rewound
    // tree. Route aborted_for_rewind to its own bucket + action instead.
    if (ar.status === 'aborted_for_rewind') {
      report.rewound.push({ domain: ar.domain_name, agentRunId: ar.id });
      continue;
    }
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
  //
  // F-f405dbd9: redispatch CARRIES WORKTREE ISOLATION FORWARD. Pre-fix the
  // INSERT wrote only (wave_id, domain_id, status) — worktree_path/
  // worktree_branch were left NULL even when the timed-out predecessor had
  // them — and the prompt rendered against run.local_path, so the redispatched
  // agent edited the SHARED tree while siblings ran isolated (the same
  // silent-isolation-fallback class as F-693631-001/F-742440-007, fixed on
  // the dispatch path but not here; redrive.js funnels into the same INSERT
  // shape). Design call, documented: the worktree is RECREATED FRESH via
  // createWorktree (which force-removes and re-adds from HEAD) — a fresh
  // agent must not inherit the dead agent's partial edits, and collect's
  // diff-vs-branch-point attribution stays consistent because the new branch
  // point is the recreation-time HEAD. If the worktree cannot be recreated we
  // fail LOUD with IsolationError (isolation is a contract, never a silent
  // downgrade); the tx rolls back every redispatch row, and worktrees already
  // recreated for earlier candidates remain as FS orphans (the documented
  // D3B-002 trade-off).
  const redispatched = [];
  const buildRedispatch = db.transaction(() => {
    for (const ar of redispatchCandidates) {
      let worktreePath = null;
      let worktreeBranch = null;
      if (ar.worktree_path || ar.worktree_branch) {
        try {
          const wt = createWorktree(run.local_path, {
            runId: opts.runId,
            waveNumber: wave.wave_number,
            domainName: ar.domain_name,
          });
          worktreePath = wt.worktreePath;
          worktreeBranch = wt.branch;
        } catch (e) {
          logStage('isolate_failed', {
            component: 'dogfood-swarm',
            correlation_id: mintCorrelationId(),
            err: e.message,
            runId: opts.runId,
            waveNumber: wave.wave_number,
            domain: ar.domain_name,
            repoPath: run.local_path,
            context: 'resume_redispatch',
          });
          throw new IsolationError(
            `redispatch requires isolation (predecessor agent ${ar.id} ran isolated) but worktree recreation failed for domain=${ar.domain_name}: ${e.message}`,
            { cause: e }
          );
        }
      }

      const newAr = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status, worktree_path, worktree_branch)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(wave.id, ar.domain_id, worktreePath, worktreeBranch);
      const newArId = Number(newAr.lastInsertRowid);

      transitionAgent(db, newArId, 'dispatched',
        `Redispatch: previous agent ${ar.id} was "${ar.status}"`);

      redispatched.push({ ar, newArId, worktreePath });
    }
  });
  buildRedispatch();

  // F-ec97601a: the --skip-verify discipline choice is persisted by dispatch
  // on the wave's kv entry; redispatch prompts must carry the same directive
  // or the redispatched agent runs `npm test` against the cumulative
  // in-motion tree mid-wave.
  const skipVerify = !!db.prepare('SELECT value FROM kv WHERE key = ?')
    .get(`wave:${wave.id}:skip_verify`)?.value;

  // Stage 3 — FS-side prompt rendering. Outside the tx by design; a throw
  // here leaves the new agent rows committed (operator can re-render with
  // the prompt helpers; the redispatched wave is recoverable).
  for (const { ar, newArId, worktreePath } of redispatched) {
    const globs = JSON.parse(ar.globs);
    const promptOpts = {
      // F-f405dbd9: an isolated redispatch renders its prompt against the
      // recreated worktree, not the shared tree.
      repoPath: worktreePath || run.local_path,
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
      if (skipVerify) prompt += SKIP_VERIFY_DIRECTIVE;
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
      worktreePath: worktreePath || null,
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
  } else if (report.rewound.length > 0) {
    // ds-lib-002: every non-terminal agent is accounted for and the remainder
    // were aborted by `swarm rewind --apply`. The wave's tree was reset, so it
    // is NOT collectable — name a distinct action instead of falling through to
    // the 'unknown' dead-end, so the operator re-dispatches the phase rather
    // than collecting over a rewound tree.
    report.action = 'rewound';
    report.reason = `${report.rewound.length} agent(s) aborted for rewind — re-dispatch the phase; this wave is not collectable.`;
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

  // ds-lib-002: aborted_for_rewind agents render under their own marker, never
  // as [OK] — the wave was rewound and must not look collectable.
  if (r.rewound && r.rewound.length > 0) {
    lines.push(`Rewound — aborted by \`swarm rewind\`, not collectable (${r.rewound.length}):`);
    for (const a of r.rewound) lines.push(`  [RWND] ${a.domain}`);
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

  // F-1a094f15: `unknown` is the one terminal action that means "I cannot
  // classify this wave" (cmdResume exits 1 on it), yet it alone had no recovery
  // guidance — its `blocked` sibling names `swarm revalidate`, but the case that
  // most warrants a next verb got the least help. Hand the operator the same
  // paste-ready diagnostic chain the blocked branch does: `swarm status` (the
  // assessment + next-verb router), `swarm history` (the transition chain that
  // shows how the wave reached this state), and `swarm receipt` (the durable
  // wave artifact). Interpolate the run/wave ids so each line runs as-is.
  if (r.action === 'unknown') {
    lines.push('');
    lines.push(`Next: inspect with \`swarm status ${r.runId}\` (assessment + next verb), \`swarm history ${r.waveId}\` (transition chain), or \`swarm receipt ${r.runId} ${r.waveNumber}\`.`);
  }

  // ds-lib-002: the rewound wave is a known, recoverable state (unlike the
  // 'unknown' dead-end) — hand the operator the re-dispatch verb, and warn off
  // the collect that the pre-fix all_complete misclassification invited.
  if (r.action === 'rewound') {
    lines.push('');
    lines.push(`Next: the wave's tree was reset by \`swarm rewind\` — re-dispatch with \`swarm dispatch ${r.runId} ${r.phase}\`. Do NOT \`swarm collect\` this wave.`);
  }

  return lines.join('\n');
}
