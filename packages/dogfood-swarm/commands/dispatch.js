/**
 * dispatch.js — `swarm dispatch <phase>`
 *
 * Creates a wave, generates agent prompts for each domain, records agent_runs.
 *
 * Steps:
 * 1. Validate run exists and domains are frozen
 * 2. Create wave record
 * 3. Create agent_run records (one per domain)
 * 4. Generate prompts from templates
 * 5. Write prompts to disk for coordinator to dispatch
 * 6. Mark wave as dispatched
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { getDomains, aredomainsFrozen, freezeDomains, takeDomainSnapshot } from '../lib/domains.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from '../lib/templates.js';
import { buildPriorMap } from '../lib/fingerprint.js';
import { createWorktree } from '../lib/worktree.js';
import { findingsForDomain } from '../lib/findings-filter.js';
import { transitionAgent } from '../lib/state-machine.js';
import { IsolationError, DispatchPreconditionError } from '../lib/errors.js';
import { logStage } from '../lib/log-stage.js';

const AUDIT_PHASES = ['health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit'];
const AMEND_PHASES = ['health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute'];

/**
 * Mint a synthetic correlation_id for a coordination stage. Mirrors the
 * `coord-<base36-ts>-<rand4>` pattern used in commands/collect.js — a single
 * grep across stderr ties the dispatch failure to the resume / receipt path.
 */
function mintCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `coord-${ts}-${rand}`;
}

/**
 * D3B-003 (Wave A2 Stage C): emit a structured NDJSON event for a
 * dispatch precondition failure. Called BEFORE the typed throw so the
 * operator sees the failure as a coded event independent of whether the
 * top-level CLI handler manages to print the error envelope.
 */
function emitPreconditionFailed({ runId, phase, code, message }) {
  const correlationId = mintCorrelationId();
  logStage('dispatch_precondition_failed', {
    component: 'dogfood-swarm',
    correlation_id: correlationId,
    code,
    message,
    runId: runId || null,
    phase: phase || null,
  });
}

/**
 * Item 5 (Phase 2-B verification-discipline): the parallel-wave discipline
 * directive appended to amend prompts when --skip-verify is set. Tells the
 * agent NOT to run `npm test` / `npm run verify` (those reads observe the
 * cumulative tree as other parallel agents are still landing edits — a
 * Class #14 verifier-vantage-point limit). Agent emits
 * `verification_skipped: true` in its output JSON to mark the contract;
 * `commands/collect.js` propagates this into `report.serial_verify_required`
 * and the CLI surfaces the Next-step hint.
 */
const SKIP_VERIFY_DIRECTIVE = `

## Verification discipline (parallel-wave)

This wave is running under the **serial-final-verify** discipline. Other agents are landing edits in parallel; running \`npm test\` / \`npm run verify\` from your worktree right now would observe a cumulative tree that is still in motion, producing measurement artifacts (e.g. a test that fails because a sibling agent hasn't yet landed its half of a coordinated fix).

**Do NOT run per-agent verification.** Make your edits, write your output JSON, and stop. The coordinator runs ONE \`npm run verify\` against the cumulative tree after \`swarm collect\` (PROTOCOL.md §Serial final verification).

Set \`verification_skipped: true\` at the top level of your output JSON to make the contract explicit:

\`\`\`json
{
  "domain": "...",
  "summary": "...",
  "fixes": [...],
  "files_changed": [...],
  "verification_skipped": true
}
\`\`\`
`;

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.phase
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — where to write prompt files
 * @param {boolean} [opts.autoFreeze] — freeze domains if still draft
 * @param {boolean} [opts.isolate] — create per-agent worktrees
 * @param {boolean} [opts.skipVerify] — append the parallel-wave serial-final-
 *   verify directive to amend prompts (Item 5; tells agents not to run
 *   per-agent npm test, coordinator runs one verify at end)
 * @returns {object} — { waveId, waveNumber, agents, promptDir }
 *
 * Atomicity contract (D3B-002, Wave A2 Stage C):
 *   The wave-build DB writes — INSERT INTO waves, UPDATE runs SET status,
 *   and the per-domain INSERT INTO agent_runs + transitionAgent loop — all
 *   run inside a single `db.transaction()`. On any throw the entire DB
 *   state rolls back to pre-dispatch (no half-built wave, no orphan
 *   agent_runs rows, no runs.status flip).
 *
 *   Filesystem-side effects (worktree creation via createWorktree + prompt
 *   files via atomicWriteFileSync) are EXPLICITLY outside the tx and are
 *   NOT rolled back on failure. The trade-off: on rollback any prompts /
 *   worktrees written for already-completed iterations become FS orphans
 *   the operator can grep with `find <outputDir> -name '*.md'` and re-
 *   dispatch (or clean with `git worktree prune`). FS orphans are the
 *   better failure than a DB row that promises agents which never got
 *   their prompts.
 *
 *   better-sqlite3 nests transactions cleanly — the inner
 *   `transitionAgent → executeTransition` self-wrap from Wave-A1 H9
 *   becomes a SAVEPOINT inside the outer wave-build tx.
 */
export function dispatch(opts) {
  const db = openDb(opts.dbPath);

  // 1. Validate run
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    // D3B-003 (Wave A2 Stage C): structured precondition failure with a
    // stable .code so the CLI top-level handler can render an actionable
    // hint, and a logStage event emitted BEFORE the throw so NDJSON
    // consumers see the precondition failure as an explicit signal.
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_RUN_NOT_FOUND',
      message: `Run not found: ${opts.runId}`,
    });
    throw new DispatchPreconditionError(`Run not found: ${opts.runId}`, {
      code: 'DISPATCH_RUN_NOT_FOUND',
      runId: opts.runId,
      phase: opts.phase,
      hint: `check \`swarm runs\` for the correct run id, or \`swarm init <repo>\` to create one`,
    });
  }

  // Check domains are frozen (or auto-freeze)
  if (!aredomainsFrozen(db, opts.runId)) {
    if (opts.autoFreeze) {
      freezeDomains(db, opts.runId);
    } else {
      emitPreconditionFailed({
        runId: opts.runId,
        phase: opts.phase,
        code: 'DISPATCH_DOMAINS_NOT_FROZEN',
        message: 'Domains are not frozen. Review and freeze before dispatching, or pass --auto-freeze.',
      });
      throw new DispatchPreconditionError(
        'Domains are not frozen. Review and freeze before dispatching, or pass --auto-freeze.',
        {
          code: 'DISPATCH_DOMAINS_NOT_FROZEN',
          runId: opts.runId,
          phase: opts.phase,
          hint: `run \`swarm domains ${opts.runId} --freeze\` after reviewing, or re-run dispatch with --auto-freeze`,
        }
      );
    }
  }

  const domains = getDomains(db, opts.runId);
  if (domains.length === 0) {
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_NO_DOMAINS',
      message: 'No domains defined for this run',
    });
    throw new DispatchPreconditionError('No domains defined for this run', {
      code: 'DISPATCH_NO_DOMAINS',
      runId: opts.runId,
      phase: opts.phase,
      hint: `run \`swarm domains ${opts.runId} --add <name> --globs "[...]"\` then --freeze`,
    });
  }

  // 2. Take domain snapshot (read-side prep; no commits here yet).
  const snapshot = takeDomainSnapshot(db, opts.runId);

  const lastWave = db.prepare(
    'SELECT MAX(wave_number) as n FROM waves WHERE run_id = ?'
  ).get(opts.runId);
  const waveNumber = (lastWave?.n || 0) + 1;

  // 3. Build prompt dir + classify phase + prep prior context (FS / read-side
  // prep only — none of this writes to the DB).
  const promptDir = join(opts.outputDir, `wave-${waveNumber}`);
  if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });

  const isAudit = AUDIT_PHASES.includes(opts.phase);
  const isAmend = AMEND_PHASES.includes(opts.phase);

  let priorContext = '';
  if (isAudit) {
    const priorMap = buildPriorMap(db, opts.runId);
    if (priorMap.size > 0) {
      const lines = [];
      for (const [fp, f] of priorMap) {
        lines.push(`- [${f.status}] ${f.finding_id}: ${f.description} (${f.file_path || '?'})`);
      }
      priorContext = lines.join('\n');
    }
  }

  // 4. Wave-build tx (D3B-002): waves INSERT + runs UPDATE + per-domain
  // INSERT agent_runs + transitionAgent ALL land or none do. Prompts and
  // worktrees are FS-side and stay outside the tx — see header for the
  // FS-orphan trade-off.
  const agents = [];
  let waveId;
  const buildWave = db.transaction(() => {
    const waveResult = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES (?, ?, ?, 'dispatched', ?)
    `).run(opts.runId, opts.phase, waveNumber, snapshot.snapshotId);
    waveId = waveResult.lastInsertRowid;

    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(opts.phase, opts.runId);

    for (const domain of domains) {
      // Only dispatch owned + bridge domains as agents (shared is a zone, not an agent)
      if (domain.ownership_class === 'shared') continue;

      // Create worktree if isolation is enabled.
      //
      // F-693631-001 (wave-12): the prior bare catch silently fell back to
      // running the agent in the main repo while the operator believed
      // --isolate was in effect. Re-emergence of F-742440-007 from wave-1.
      // Isolation is a contract — fail loud. The CLI is responsible for
      // catching IsolationError and exiting non-zero.
      //
      // D3B-002 (Wave A2): a thrown IsolationError now propagates OUT of
      // the surrounding db.transaction(), triggering full DB rollback.
      // Worktrees successfully created before the failure remain on disk
      // as FS orphans (documented FS-degradation in the function header).
      let worktreePath = null;
      let worktreeBranch = null;
      if (opts.isolate) {
        try {
          const wt = createWorktree(run.local_path, {
            runId: opts.runId,
            waveNumber,
            domainName: domain.name,
          });
          worktreePath = wt.worktreePath;
          worktreeBranch = wt.branch;
        } catch (e) {
          // FT-PIPELINE-004 cross-fix-dep: correlation_id pins the dispatch
          // failure across stderr, the rendered IsolationError, and any
          // resume-path follow-up. Wave-22 wrapper-strip pattern preserved by
          // calling logStage directly with the id at the outer envelope.
          const correlationId = mintCorrelationId();
          logStage('isolate_failed', {
            correlation_id: correlationId,
            err: e.message,
            runId: opts.runId,
            waveNumber,
            domain: domain.name,
            repoPath: run.local_path,
          });
          throw new IsolationError(
            `--isolate requested but worktree creation failed for domain=${domain.name}: ${e.message}`,
            { cause: e }
          );
        }
      }

      // Insert at 'pending' then transition to 'dispatched' through the state
      // machine. This is the canonical path used by resume.js — it writes
      // started_at via executeTransition() and emits a `pending → dispatched`
      // event to agent_state_events, satisfying the state-machine.js header
      // invariant that "Every agent_run status change MUST go through this
      // module" / "Every legal transition is logged". Direct INSERT with
      // status='dispatched' bypassed both, leaving started_at NULL and silently
      // breaking applyTimeoutPolicy() (F-002109-003 / F-002 symptom).
      const agentResult = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status, worktree_path, worktree_branch)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(waveId, domain.id, worktreePath, worktreeBranch);
      const agentRunId = Number(agentResult.lastInsertRowid);
      transitionAgent(db, agentRunId, 'dispatched', 'initial dispatch');

      // Stash the agent record so the prompt-write loop below can run
      // outside the tx (FS work stays out of the DB tx by design — see
      // D3B-002 header trade-off).
      agents.push({
        agentRunId,
        domain,
        worktreePath,
        worktreeBranch,
      });
    }
  });
  buildWave();

  // 5. Prompt rendering + atomicWriteFileSync — FS-side, intentionally
  // outside the DB tx. A throw here leaves DB state intact (agents are
  // already committed) and the operator can re-render with the prompt-
  // generator helpers; the wave is recoverable via `swarm resume` because
  // the agent rows exist with status=dispatched.
  const builtAgents = [];
  for (const a of agents) {
    const domain = a.domain;
    const agentWorkDir = a.worktreePath || run.local_path;
    const promptOpts = {
      repoPath: agentWorkDir,
      repo: run.repo,
      domainName: domain.name,
      globs: domain.globs,
      ownershipClass: domain.ownership_class,
      domainSnapshotId: snapshot.snapshotId,
      phase: opts.phase,
      waveNumber,
    };

    let prompt;
    if (isAudit) {
      if (opts.phase === 'feature-audit') {
        prompt = buildFeatureAuditPrompt(promptOpts);
      } else {
        prompt = buildAuditPrompt({ ...promptOpts, priorContext });
      }
    } else if (isAmend) {
      // Filter approved findings by the agent's owned globs. An empty result is
      // the correct answer (this domain has no work in this wave) — do NOT fall
      // back to all-approved, which would feed every fix to every agent and
      // defeat exclusive file ownership (Law #1). See lib/findings-filter.js.
      const findings = findingsForDomain(db, opts.runId, domain);
      prompt = buildAmendPrompt({ ...promptOpts, findings });
      // Item 5: amend prompts are the verification-discipline carrier — audit
      // prompts don't run tests anyway. Append the parallel-wave directive
      // when --skip-verify is set so the agent skips per-agent verify and
      // marks `verification_skipped: true` in its output JSON.
      if (opts.skipVerify) prompt += SKIP_VERIFY_DIRECTIVE;
    } else {
      prompt = buildAuditPrompt(promptOpts); // generic fallback
    }

    const promptPath = join(promptDir, `${domain.name}.md`);
    atomicWriteFileSync(promptPath, prompt, 'utf-8');

    builtAgents.push({
      agentRunId: a.agentRunId,
      domain: domain.name,
      domainId: domain.id,
      promptPath,
      worktreePath: a.worktreePath,
      worktreeBranch: a.worktreeBranch,
    });
  }

  // 6. Dispatch-success observability (D3B-016): emit a structured
  // wave_dispatched event so NDJSON consumers see the success path as
  // explicitly as they see isolate_failed. Symmetric with the failure-
  // emit at the createWorktree catch above.
  const dispatchCorrelationId = mintCorrelationId();
  logStage('wave_dispatched', {
    correlation_id: dispatchCorrelationId,
    runId: opts.runId,
    waveId,
    waveNumber,
    phase: opts.phase,
    agentCount: builtAgents.length,
    isolated: !!opts.isolate,
    skipVerify: !!opts.skipVerify,
  });

  return {
    waveId,
    waveNumber,
    phase: opts.phase,
    agents: builtAgents,
    promptDir,
  };
}
