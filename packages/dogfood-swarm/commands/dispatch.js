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

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/connection.js';
import { getDomains, aredomainsFrozen, freezeDomains, takeDomainSnapshot } from '../lib/domains.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from '../lib/templates.js';
import { buildPriorMap } from '../lib/fingerprint.js';
import { createWorktree } from '../lib/worktree.js';

const AUDIT_PHASES = ['health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit'];
const AMEND_PHASES = ['health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute'];

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.phase
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — where to write prompt files
 * @param {boolean} [opts.autoFreeze] — freeze domains if still draft
 * @param {boolean} [opts.isolate] — create per-agent worktrees
 * @returns {object} — { waveId, waveNumber, agents, promptDir }
 */
export function dispatch(opts) {
  const db = openDb(opts.dbPath);

  // 1. Validate run
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Check domains are frozen (or auto-freeze)
  if (!aredomainsFrozen(db, opts.runId)) {
    if (opts.autoFreeze) {
      freezeDomains(db, opts.runId);
    } else {
      throw new Error('Domains are not frozen. Review and freeze before dispatching, or pass --auto-freeze.');
    }
  }

  const domains = getDomains(db, opts.runId);
  if (domains.length === 0) throw new Error('No domains defined for this run');

  // 2. Take domain snapshot + create wave
  const snapshot = takeDomainSnapshot(db, opts.runId);

  const lastWave = db.prepare(
    'SELECT MAX(wave_number) as n FROM waves WHERE run_id = ?'
  ).get(opts.runId);
  const waveNumber = (lastWave?.n || 0) + 1;

  const waveResult = db.prepare(`
    INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES (?, ?, ?, 'dispatched', ?)
  `).run(opts.runId, opts.phase, waveNumber, snapshot.snapshotId);
  const waveId = waveResult.lastInsertRowid;

  // Update run status
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(opts.phase, opts.runId);

  // 3. Create agent_runs + generate prompts
  const promptDir = join(opts.outputDir, `wave-${waveNumber}`);
  if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });

  const agents = [];
  const isAudit = AUDIT_PHASES.includes(opts.phase);
  const isAmend = AMEND_PHASES.includes(opts.phase);

  // Build prior context for dedup
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

  for (const domain of domains) {
    // Only dispatch owned + bridge domains as agents (shared is a zone, not an agent)
    if (domain.ownership_class === 'shared') continue;

    // Create worktree if isolation is enabled
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
        // Worktree creation failed — continue without isolation
        worktreePath = null;
        worktreeBranch = null;
      }
    }

    const agentResult = db.prepare(`
      INSERT INTO agent_runs (wave_id, domain_id, status, worktree_path, worktree_branch)
      VALUES (?, ?, 'dispatched', ?, ?)
    `).run(waveId, domain.id, worktreePath, worktreeBranch);

    let prompt;
    const agentWorkDir = worktreePath || run.local_path;
    const promptOpts = {
      repoPath: agentWorkDir,
      repo: run.repo,
      domainName: domain.name,
      globs: domain.globs,
      phase: opts.phase,
      waveNumber,
    };

    if (isAudit) {
      if (opts.phase === 'feature-audit') {
        prompt = buildFeatureAuditPrompt(promptOpts);
      } else {
        prompt = buildAuditPrompt({ ...promptOpts, priorContext });
      }
    } else if (isAmend) {
      // Get approved findings for this domain
      const findings = db.prepare(`
        SELECT * FROM findings
        WHERE run_id = ? AND status = 'approved'
        AND file_path IN (
          SELECT fc.file_path FROM file_claims fc
          JOIN agent_runs ar ON fc.agent_run_id = ar.id
          WHERE ar.domain_id = ?
        )
      `).all(opts.runId, domain.id);

      // Fallback: get all approved findings that match domain globs
      const allApproved = findings.length > 0 ? findings :
        db.prepare(`
          SELECT * FROM findings WHERE run_id = ? AND status = 'approved'
        `).all(opts.runId);

      prompt = buildAmendPrompt({ ...promptOpts, findings: allApproved });
    } else {
      prompt = buildAuditPrompt(promptOpts); // generic fallback
    }

    const promptPath = join(promptDir, `${domain.name}.md`);
    writeFileSync(promptPath, prompt, 'utf-8');

    agents.push({
      agentRunId: agentResult.lastInsertRowid,
      domain: domain.name,
      domainId: domain.id,
      promptPath,
      worktreePath,
      worktreeBranch,
    });
  }

  return {
    waveId,
    waveNumber,
    phase: opts.phase,
    agents,
    promptDir,
  };
}
