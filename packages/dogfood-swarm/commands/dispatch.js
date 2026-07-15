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
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { getDomains, aredomainsFrozen, freezeDomains, takeDomainSnapshot } from '../lib/domains.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from '../lib/templates.js';
import { buildPriorMap } from '../lib/fingerprint.js';
import { createWorktree, runShortOf } from '../lib/worktree.js';
import { findingsForDomain } from '../lib/findings-filter.js';
import { transitionAgent } from '../lib/state-machine.js';
import { IsolationError, DispatchPreconditionError } from '../lib/errors.js';
import { logStage } from '../lib/log-stage.js';
import { mintCorrelationId } from '../lib/correlation-id.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { AUDIT_PHASES, AMEND_PHASES, renderPhaseList } from '../lib/phases.js';

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
export const SKIP_VERIFY_DIRECTIVE = `

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
 * Derive the would-create worktree path + branch for a domain WITHOUT creating
 * anything. Mirrors lib/worktree.js#createWorktree's naming byte-for-byte so
 * the `--dry-run --isolate` preview names the exact path the apply path would
 * write. A change to createWorktree's naming must change here.
 *
 * @param {string} repoPath — run.local_path
 * @param {number} waveNumber
 * @param {string} domainName
 * @param {string} runId
 * @returns {{ worktreePath: string, branch: string }}
 */
function previewWorktree(repoPath, waveNumber, domainName, runId) {
  const runShort = runShortOf(runId);
  const branch = `swarm/${runShort}/w${waveNumber}-${domainName}`;
  // F-527dc73e: run-short slug in the directory name — must stay byte-for-byte
  // with lib/worktree.js#createWorktree.
  const worktreePath = join(repoPath, '.swarm', 'worktrees', `w${waveNumber}-${domainName}-${runShort}`);
  return { worktreePath, branch };
}

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
 * @param {boolean} [opts.dryRun] — preview the wave shape (which domains become
 *   agents, the prompt paths that WOULD be written, per-domain approved-finding
 *   routing counts for amend phases, and the worktrees that WOULD be created
 *   under --isolate) WITHOUT any control-plane write, file write, or worktree
 *   creation. Returns a report with `dryRun: true` and `waveId: null`.
 * @returns {object} — { waveId, waveNumber, agents, promptDir, dryRun? }
 *
 * Atomicity contract (D3B-002, Wave A2 Stage C):
 *   The wave-build DB writes — INSERT INTO waves, UPDATE runs SET status,
 *   and the per-domain INSERT INTO agent_runs + transitionAgent loop — all
 *   run inside a single `db.transaction()`. On any throw the entire DB
 *   state rolls back to pre-dispatch (no half-built wave, no orphan
 *   agent_runs rows, no runs.status flip).
 *
 *   F-5b0996e4: filesystem-side effects split ACROSS the tx boundary, and
 *   the two halves are NOT symmetric — worktree creation (createWorktree,
 *   called inside the per-domain loop below) runs INSIDE the tx; prompt-
 *   file writes (atomicWriteFileSync, the loop after buildWave() returns)
 *   run OUTSIDE it. This corrects an earlier version of this header, which
 *   claimed BOTH were "EXPLICITLY outside the tx" — worktree creation never
 *   was; the inline note at the createWorktree call site (below) already
 *   described the true behavior ('a thrown IsolationError now propagates
 *   OUT of the surrounding db.transaction(), triggering full DB rollback.
 *   Worktrees successfully created before the failure remain on disk as FS
 *   orphans') ten lines apart from the header's contradicting claim.
 *
 *   Neither half is rolled back by a DB-tx abort: better-sqlite3 undoes SQL
 *   writes on a thrown transaction function, not filesystem writes a
 *   thrown IsolationError already performed. The trade-off: on a mid-loop
 *   IsolationError, every DB row rolls back (waves/agent_runs never
 *   existed), but worktrees already created for earlier domains in the
 *   SAME failed loop remain on disk as FS orphans — THIS is the actual
 *   source of the FS-orphan case, not the prompt loop (prompts are written
 *   only AFTER the tx has already committed, so a prompt-write failure
 *   never coincides with a DB rollback in the first place). The operator
 *   reclaims stranded worktrees with `swarm clean <run-id> --apply`, or
 *   finds any FS-orphaned prompt files from a later, successful-tx failure
 *   path with `find <outputDir> -name '*.md'` and re-dispatches. FS orphans
 *   are the better failure than a DB row that promises agents which never
 *   got their prompts.
 *
 *   Evaluated and deliberately NOT done in this pass: hoisting the
 *   createWorktree loop above buildWave() so the tx only ever INSERTs rows
 *   referencing already-created worktrees (which would make the header's
 *   original claim true, and shrink the write-lock hold time — the tx
 *   would no longer pay for N git subprocesses). Rejected here because it
 *   does not change the orphan-risk SHAPE (a hoisted loop that fails on
 *   domain K still leaves worktrees 1..K-1 on disk with no DB rows
 *   referencing them — same class of orphan, different phase) and it is a
 *   structural reorder that touches every dispatch-tx regression pin
 *   (amend2-d3b-002-dispatch-tx, dispatch-state-machine, dispatch-amend-
 *   filter, dispatch-prompt-schema) — a follow-up with its own dedicated
 *   verification pass, not a LOW-severity doc fix.
 *
 *   better-sqlite3 nests transactions cleanly — the inner
 *   `transitionAgent → executeTransition` self-wrap from Wave-A1 H9
 *   becomes a SAVEPOINT inside the outer wave-build tx.
 */
export function dispatch(opts) {
  const db = openDb(opts.dbPath);

  // 0. Validate phase BEFORE anything touches the control plane.
  //
  // d5-swarm-cli-001 (HIGH): a phase typo (e.g. `helth-audit-a`) used to slip
  // past every guard here — AUDIT_PHASES / AMEND_PHASES were only consulted
  // later to set isAudit/isAmend (both false on a bad phase) — so buildWave()
  // INSERTed the waves row, flipped runs.status to the typo string, INSERTed
  // agent_runs, and COMMITTED. Only the prompt-render loop (lib/templates.js)
  // then threw a plain untyped `Unknown audit phase` Error, AFTER the commit.
  // That left the exact "DB row that promises agents which never got their
  // prompts" state this function's header (below) promises NEVER to create,
  // and surfaced as the flat `ERROR:` form instead of the structured
  // DISPATCH_* envelope its sibling preconditions get. Gate it here as a
  // pre-commit precondition: no DB mutation, structured error + actionable
  // hint listing the valid phases. This is the same emitPreconditionFailed +
  // typed-throw shape as the run-not-found / domains-not-frozen / no-domains
  // guards below.
  if (!AUDIT_PHASES.includes(opts.phase) && !AMEND_PHASES.includes(opts.phase)) {
    const validPhases = renderPhaseList();
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_INVALID_PHASE',
      message: `Unknown phase: ${opts.phase}`,
    });
    throw new DispatchPreconditionError(`Unknown phase: ${opts.phase}`, {
      code: 'DISPATCH_INVALID_PHASE',
      runId: opts.runId,
      phase: opts.phase,
      hint: `valid phases: ${validPhases}`,
    });
  }

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

  // Check domains are frozen (or auto-freeze). In dry-run, --auto-freeze is a
  // mutation, so we do NOT freeze — a dry-run against a draft map still
  // previews the shape against the current draft domains. Only the
  // non-auto-freeze precondition (operator forgot to freeze AND did not ask to)
  // throws, which is the same fail-loud signal the apply path gives.
  if (!aredomainsFrozen(db, opts.runId)) {
    if (opts.autoFreeze && !opts.dryRun) {
      freezeDomains(db, opts.runId);
    } else if (opts.autoFreeze && opts.dryRun) {
      // dry-run + auto-freeze: skip the mutation, proceed with draft domains.
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

  // F-3c8a62f1: the guard above checks the PRE-filter domain list; the
  // per-domain loop below (and the dry-run preview mirror of it) acts on
  // the POST-filter list — `shared` is a zone, not an agent, and is
  // `continue`d past every place an agent gets created. A domain map that
  // is non-empty but ALL `shared` (a real `swarm init` outcome on a repo
  // with no .md/src/lib/packages/tests — see F-6a78ffdd's reachability
  // note) sailed past `domains.length === 0`, then the loop created ZERO
  // agents, committed a wave with agentCount: 0, and exited 0 reporting
  // success — the exact same class of bug as this wave's own
  // F-a5f6b585 (redrive.js): a guard that polices a DIFFERENT set than the
  // one the code actually acts on. The wedge compounds: the next dispatch
  // then throws DISPATCH_WAVE_IN_FLIGHT ('still dispatched') PERMANENTLY,
  // since the zero-agent wave can never collect. Distinct code from
  // DISPATCH_NO_DOMAINS — two different causes ('no domains at all' vs
  // 'domains exist but none are agent-bearing') get two different
  // diagnostics, so the message names the real condition instead of
  // collapsing back into the same "doesn't name the actual cause" failure
  // one layer up.
  const agentBearingDomains = domains.filter(d => d.ownership_class !== 'shared');
  if (agentBearingDomains.length === 0) {
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_NO_AGENT_DOMAINS',
      message: `Every domain in the frozen map (${domains.length}) is class 'shared'; shared is a zone, not an agent`,
    });
    throw new DispatchPreconditionError(
      `Every domain in the frozen map (${domains.length}) is class 'shared' — shared is a zone, not an agent. ` +
      `Dispatching would create zero agent_runs, commit a wave reporting success, and permanently block future ` +
      `dispatch on DISPATCH_WAVE_IN_FLIGHT (the zero-agent wave can never collect).`,
      {
        code: 'DISPATCH_NO_AGENT_DOMAINS',
        runId: opts.runId,
        phase: opts.phase,
        hint: `run \`swarm domains ${opts.runId} --edit <name> --ownership owned\` (or --add a new owned/bridge domain) so at least one domain can carry an agent`,
      }
    );
  }

  // F-cf8b7a6c: refuse to open a NEW wave while another wave of this run is
  // still in flight. collect/resume/advance all operate on the LATEST wave
  // only, so an older 'dispatched' wave would be stranded forever: it
  // permanently satisfies hasActiveWave (blocking `swarm domains --unfreeze`),
  // its agents run until timeout, and its outputs can never be collected. The
  // classic trigger is an operator retry after a slow first dispatch.
  const inFlightWave = db.prepare(`
    SELECT id, wave_number, phase, status FROM waves
    WHERE run_id = ? AND status IN ('dispatched', 'collecting')
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);
  if (inFlightWave) {
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_WAVE_IN_FLIGHT',
      message: `Wave ${inFlightWave.wave_number} (${inFlightWave.phase}) is still '${inFlightWave.status}'`,
    });
    throw new DispatchPreconditionError(
      `Wave ${inFlightWave.wave_number} (${inFlightWave.phase}) is still '${inFlightWave.status}' — dispatching a new wave would strand it.`,
      {
        code: 'DISPATCH_WAVE_IN_FLIGHT',
        runId: opts.runId,
        phase: opts.phase,
        hint: `finish the in-flight wave first: \`swarm collect ${opts.runId}\` (or \`swarm resume ${opts.runId}\` / \`swarm redrive ${inFlightWave.id}\` / \`swarm rewind\` if it is unrecoverable)`,
      }
    );
  }

  // F-7970a30b: dispatching over a FAILED wave with blocked agents is a
  // legitimate abandon-and-retry choice (the in-flight guard above only
  // covers dispatched/collecting), but it silently closes the `swarm
  // revalidate` window — revalidate reads the LATEST wave regardless of
  // status, so the failed wave's invalid_output / ownership_violation agents
  // become unreachable by the lawful repair verb the moment this dispatch
  // lands. Warn loudly at dispatch time; `swarm redrive <wave-id>` (explicit
  // wave id) remains the surviving recovery path. Observability only — never
  // a gate.
  let supersededFailedWave = null;
  {
    const latestWave = db.prepare(`
      SELECT id, wave_number, phase, status FROM waves
      WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1
    `).get(opts.runId);
    if (latestWave && latestWave.status === 'failed') {
      const blockedRows = db.prepare(`
        SELECT ar.id FROM agent_runs ar
        WHERE ar.wave_id = ?
          ${LATEST_AGENT_RUN_PER_DOMAIN}
          AND ar.status IN ('invalid_output', 'ownership_violation')
      `).all(latestWave.id);
      if (blockedRows.length > 0) {
        supersededFailedWave = {
          waveId: latestWave.id,
          waveNumber: latestWave.wave_number,
          phase: latestWave.phase,
          blockedAgents: blockedRows.length,
          message:
            `wave ${latestWave.wave_number} (id ${latestWave.id}) is 'failed' with ` +
            `${blockedRows.length} blocked agent_run(s). Once this dispatch lands, ` +
            `\`swarm revalidate\` (which reads the LATEST wave) can no longer reach it — ` +
            `post-dispatch recovery narrows to \`swarm redrive ${latestWave.id} --reason "<text>" --apply\` or manual repair.`,
        };
        logStage('dispatch_supersedes_failed_wave', {
          component: 'dogfood-swarm',
          correlation_id: mintCorrelationId(),
          runId: opts.runId,
          phase: opts.phase,
          failedWaveId: latestWave.id,
          failedWaveNumber: latestWave.wave_number,
          blockedAgents: blockedRows.length,
          hint: `swarm redrive ${latestWave.id} --reason "<text>" --apply`,
        });
      }
    }
  }

  // 2. Take domain snapshot (read-side prep; no commits here yet).
  const snapshot = takeDomainSnapshot(db, opts.runId);

  const lastWave = db.prepare(
    'SELECT MAX(wave_number) as n FROM waves WHERE run_id = ?'
  ).get(opts.runId);
  const waveNumber = (lastWave?.n || 0) + 1;

  // 3. Classify phase. The prompt dir + prior context are FS/read-side prep;
  // the dry-run branch below short-circuits before either is materialized.
  const isAudit = AUDIT_PHASES.includes(opts.phase);
  const isAmend = AMEND_PHASES.includes(opts.phase);

  const promptDirPath = join(opts.outputDir, `wave-${waveNumber}`);

  // F-aa32371b: approved findings that route to NO domain agent — a finding
  // with no file_path (repo-level finding), or whose path matches no owned
  // glob, is excluded from every amend prompt by findingsForDomain and would
  // otherwise be silently unfixable while its OPEN 'approved' status blocks
  // the finding-severity gate forever. Surface them loudly at dispatch time
  // (report field + NDJSON event; the CLI prints the warning) with the
  // recovery paths named.
  let unroutedApprovedFindings = [];
  if (isAmend) {
    const approved = db.prepare(
      "SELECT finding_id, severity, file_path FROM findings WHERE run_id = ? AND status = 'approved'"
    ).all(opts.runId);
    const routedIds = new Set();
    for (const domain of domains) {
      if (domain.ownership_class === 'shared') continue;
      for (const f of findingsForDomain(db, opts.runId, domain)) routedIds.add(f.finding_id);
    }
    unroutedApprovedFindings = approved
      .filter(f => !routedIds.has(f.finding_id))
      .map(f => ({ finding_id: f.finding_id, severity: f.severity, file_path: f.file_path }));
    if (unroutedApprovedFindings.length > 0) {
      logStage('unrouted_approved_findings', {
        component: 'dogfood-swarm',
        correlation_id: mintCorrelationId(),
        runId: opts.runId,
        phase: opts.phase,
        waveNumber,
        count: unroutedApprovedFindings.length,
        finding_ids: unroutedApprovedFindings.map(f => f.finding_id),
        hint: 'these findings block the severity gate but are routed to zero agents. To CLOSE them: land the fix and use the coordinator_resolved path (for anchorless findings attach coordinator_resolved:true + verified_via_evidence so `swarm verify-fixed <run-id>` classifies the closure as allowlist); or DISPOSE without a fix via `swarm defer <run-id> --ids F-001,F-002 --reason "<text>"` (accepted/postponed) / `swarm reject <run-id> --ids F-001,F-002 --reason "<text>"` (not-a-defect) — both close the finding for the gate.',
      });
    }
  }

  // 3a. Dry-run / preview: compute the wave shape with ZERO side effects — no
  // DB write (waves/agent_runs/runs.status), no prompt files, no worktree
  // creation. Owned + bridge domains become agents; shared is a zone, not an
  // agent. For amend phases each agent carries its approved-finding routing
  // count (the same findingsForDomain filter the apply path uses). Under
  // --isolate the would-create worktree path + branch are derived
  // deterministically from createWorktree's naming (NOT created here). This
  // branch is the operator's "what will this dispatch do?" preview and is the
  // reason it sits before the buildWave transaction.
  if (opts.dryRun) {
    const previewAgents = [];
    for (const domain of domains) {
      if (domain.ownership_class === 'shared') continue;
      const agent = {
        domain: domain.name,
        domainId: domain.id,
        ownershipClass: domain.ownership_class,
        promptPath: join(promptDirPath, `${domain.name}.md`),
        worktreePath: null,
        worktreeBranch: null,
      };
      if (isAmend) {
        agent.approvedFindingCount = findingsForDomain(db, opts.runId, domain).length;
      }
      if (opts.isolate) {
        const wt = previewWorktree(run.local_path, waveNumber, domain.name, opts.runId);
        agent.worktreePath = wt.worktreePath;
        agent.worktreeBranch = wt.branch;
      }
      previewAgents.push(agent);
    }
    return {
      dryRun: true,
      waveId: null,
      waveNumber,
      phase: opts.phase,
      isolate: !!opts.isolate,
      skipVerify: !!opts.skipVerify,
      domainSnapshotId: snapshot.snapshotId,
      promptDir: promptDirPath,
      agents: previewAgents,
      unroutedApprovedFindings,
      supersededFailedWave,
    };
  }

  // 3b. Build prompt dir + prep prior context (FS / read-side prep only — none
  // of this writes to the DB).
  const promptDir = promptDirPath;
  if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });

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
  // F-0e55b5ca: capture the repo HEAD as this wave's diff base BEFORE the
  // wave-build tx (an FS read, not a DB write). runs.commit_sha is stamped
  // once at `swarm init` and goes stale as waves land commits; using it as
  // the non-isolated collect probe base attributed every prior wave's edits
  // to THIS wave's agents. NULL when the probe fails (bare dir in tests,
  // git unavailable) — collect falls back to runs.commit_sha, its legacy
  // behavior.
  let dispatchSha = null;
  try {
    dispatchSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: run.local_path, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch { dispatchSha = null; }

  const agents = [];
  let waveId;
  const buildWave = db.transaction(() => {
    const waveResult = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id, dispatch_sha)
      VALUES (?, ?, ?, 'dispatched', ?, ?)
    `).run(opts.runId, opts.phase, waveNumber, snapshot.snapshotId, dispatchSha);
    waveId = waveResult.lastInsertRowid;

    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(opts.phase, opts.runId);

    // F-ec97601a: persist the --skip-verify discipline choice on the wave so
    // `swarm resume` can re-render redispatch prompts WITH the
    // SKIP_VERIFY_DIRECTIVE. Pre-fix the choice lived only in the originally
    // rendered prompt text — a redispatched amend agent in a
    // serial-final-verify wave would run `npm test` against the cumulative
    // in-motion tree (the exact measurement artifact Item 5 prevents).
    if (opts.skipVerify && isAmend) {
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
        .run(`wave:${waveId}:skip_verify`, '1');
    }

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
    unroutedApprovedFindings,
    supersededFailedWave,
  };
}
