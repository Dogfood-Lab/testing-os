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
 *
 * COORD-002 — compensators table (workflow-standards NAMED_COMPENSATORS; no
 * skip allowed for an irreversible action):
 *
 *   Irreversible action: redispatching a candidate whose predecessor ran
 *   --isolate calls createWorktree() (lib/worktree.js), which does
 *   `git worktree remove <path> --force` (discards uncommitted/untracked
 *   edits) then `git branch -D` (force-deletes the branch) before
 *   recreating both fresh from HEAD.
 *
 *   Command-to-undo: NONE. Once --force proceeds over a dirty/unmerged
 *   worktree, the destroyed content is gone — untracked files never enter
 *   git's object store, so `git fsck` finds nothing to recover (this is not
 *   hypothetical: it is exactly how this wave's own prior salvage attempt
 *   was lost). There is no compensator for THIS action; the only lever is
 *   PREVENTION, which is what the guard below is. This is stated plainly
 *   per the standing rule rather than skipped.
 *
 *   Post-refusal state: nothing is touched — no DB row, no FS write. The
 *   refusal is checked and thrown before the db.transaction() below opens.
 *
 *   Owner: the operator invoking `swarm resume`. --force (opts.force) is
 *   the explicit, named escape hatch (mirrors `swarm rewind`'s
 *   --force-on-top-of---apply contract for the same blast radius); the
 *   operator accepts the loss by passing it after inspecting the named
 *   at-risk worktree(s) in the refusal error.
 */

import { openDb } from '../db/connection.js';
import { getDomains } from '../lib/domains.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from '../lib/templates.js';
import { findingsForDomain } from '../lib/findings-filter.js';
import { createWorktree, worktreeDisposition } from '../lib/worktree.js';
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
import { escapeReasonForDisplay } from './lib/escape-reason.js';
import { pluralize } from './lib/pluralize.js';

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — where to write re-dispatch prompts
 * @param {number} [opts.nowMs] — override current time for testing
 * @param {boolean} [opts.force] — COORD-002: proceed even when a redispatch
 *   candidate's existing --isolate worktree has uncommitted or unmerged
 *   work that createWorktree() would force-destroy. Without this, resume
 *   REFUSES (touching nothing) and names the at-risk worktree(s).
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
  // F-6d0e966c: d.ownership_class is selected here (alongside the
  // pre-existing d.name / d.globs) so the redispatch prompt below can carry
  // it forward — dispatch.js's promptOpts already includes it (cli.js/
  // dispatch.js:560), and lib/templates.js#renderDomainContract silently
  // omits the `## Your domain` block's ownership-class line when it is
  // undefined, rather than failing loud.
  const agentRuns = db.prepare(`
    SELECT ar.*, d.name as domain_name, d.globs, d.ownership_class
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

  // COORD-002: refuse BEFORE any mutation when a redispatch candidate's
  // existing --isolate worktree has uncommitted or unmerged work that
  // createWorktree() (below) would force-destroy on recreation. Checked for
  // every candidate up front — a pure read-only git probe, no DB write, no
  // FS write — so a refusal is total and atomic: either every candidate is
  // safe to recreate, or NOTHING happens and the operator sees exactly
  // which worktree(s) are at risk. This mirrors dispatch.js's in-flight
  // precondition (checked before its own tx) and rewind's
  // --force-on-top-of---apply contract for the identical blast radius —
  // resume previously had NEITHER a dry-run/--apply split NOR this gate,
  // making it the only work-destroying verb in the package with no gate at
  // all (see the module header's compensators note: there is no undo once
  // --force proceeds, so prevention is the only lever).
  if (!opts.force) {
    const atRisk = [];
    for (const ar of redispatchCandidates) {
      if (!ar.worktree_path) continue;
      const disposition = worktreeDisposition(run.local_path, ar.worktree_path, ar.worktree_branch, run.branch);
      if (disposition.dirty || disposition.unmerged) {
        atRisk.push({ domain: ar.domain_name, agentRunId: ar.id, worktreePath: ar.worktree_path, ...disposition });
      }
    }
    if (atRisk.length > 0) {
      const err = new Error(
        `resume: ${atRisk.length} worktree(s) have uncommitted or unmerged work that redispatch's ` +
        `worktree recreation would DESTROY: ` +
        atRisk.map(a => `${a.domain} (${a.worktreePath}${a.dirty ? ', dirty' : ''}${a.unmerged ? ', unmerged' : ''})`).join('; ') +
        `. Nothing was mutated. Salvage the work first (commit + push from inside the worktree, or copy it out), ` +
        `then either re-run \`swarm resume\` (clean now) or pass { force: true } (CLI: --force) to proceed anyway ` +
        `and accept the loss — there is no undo once --force destroys uncommitted work.`
      );
      err.code = 'RESUME_WORKTREE_AT_RISK';
      err.atRisk = atRisk;
      throw err;
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
      // F-6d0e966c: dispatch.js's promptOpts (cli.js's dispatch call site)
      // always includes both of these; resume's redispatch prompt dropped
      // them, so a resumed wave's agent contract read "the snapshot ID
      // below is the audit anchor for this wave" with no snapshot ID below
      // it — self-contradictory prose handed to an LLM agent on exactly the
      // recovery path (timeout/failure) most likely to already be degraded.
      ownershipClass: ar.ownership_class,
      domainSnapshotId: wave.domain_snapshot_id,
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
      //
      // F-7793276e: `name` is REQUIRED alongside `globs` — findingsForDomain's
      // own JSDoc says a bare `{ globs }` (no name) "degrades silently to the
      // pre-fallback behavior for file-less findings only", i.e. every
      // file-less approved finding filed by/for this domain (C3's
      // filed_by_domain fallback) becomes invisible to the redispatched
      // agent's rebuilt prompt, with no error or log line marking the gap.
      // `ar.domain_name` is already in scope two lines below (`domain:
      // ar.domain_name`) — this was an unwired parameter, not a missing-data
      // problem.
      const findings = findingsForDomain(db, opts.runId, { name: ar.domain_name, globs });
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
    report.reason = `${pluralize(report.manual_fix.length, 'agent')} blocked (${report.manual_fix.map(m => `${m.domain}: ${m.status}`).join(', ')})`;
  } else if (report.redispatch.length > 0) {
    report.action = 'redispatched';
    report.reason = `Redispatched ${pluralize(report.redispatch.length, 'agent')}`;
  } else if (report.still_running.length > 0) {
    report.action = 'waiting';
    report.reason = `${pluralize(report.still_running.length, 'agent')} still in-flight`;
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
      // F-f1dae277 (wave 22): a.error is agent_runs.error_message (set at
      // resume.js's report.manual_fix.push site above from ar.error_message
      // verbatim), which for an 'ownership_violation' status agent is
      // collect.js's `violMsg` — unescaped joined ownership.violations[].file
      // paths. `swarm resume` has no --format=json branch, so this text
      // render is the only surface this value reaches; escaped at render
      // regardless, matching this package's uniform convention rather than
      // relying on that absence to stay true.
      const detail = a.error ? escapeReasonForDisplay(a.error) : 'no details';
      lines.push(`  [STOP] ${a.domain} — ${a.status}: ${detail}`);
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
