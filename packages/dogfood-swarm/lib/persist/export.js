/**
 * export.js — Canonical export from the swarm control plane.
 *
 * Builds review-worthy truth from the DB. Does not export raw agent chatter,
 * transient events, or intermediate state. Only canonical, provenance-attached artifacts.
 *
 * Export units:
 *   - Run summary
 *   - Wave receipts (with findings + verification + advancement)
 *   - Finding set (deduplicated, with lifecycle)
 *   - Verification outcomes
 *   - Promotion trail
 *   - Final handoff state
 */

import { openDb } from '../../db/connection.js';
import { createHash } from 'node:crypto';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../queries/latest-agent-runs.js';

/**
 * Build a canonical run export from DB truth.
 *
 * @param {Database} db
 * @param {string} runId
 * @returns {object} — canonical export
 */
export function buildRunExport(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const waves = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number').all(runId);
  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? ORDER BY name').all(runId);
  const findings = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY severity, finding_id').all(runId);
  const promotions = db.prepare('SELECT * FROM promotions WHERE run_id = ? ORDER BY created_at').all(runId);

  // Build wave summaries
  const waveSummaries = waves.map(w => {
    // F-H8 (Wave A1 D3): wave-9 latest-per-(wave, domain) filter via the
    // shared helper. The bug shape: after `swarm resume` redispatches a
    // failed agent, the original failed row remains in agent_runs. Iterating
    // all rows surfaced the stale failed row to the audit-DB ground truth,
    // flipping the dogfood-bridge `every(complete)` check to non-pass for
    // recovered waves. See lib/queries/latest-agent-runs.js header.
    const agents = db.prepare(`
      SELECT ar.*, d.name as domain_name
      FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    `).all(w.id);

    const verification = db.prepare(
      'SELECT * FROM verification_receipts WHERE wave_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(w.id);

    // F-H8-sibling (advisor-surfaced, Wave A1 D3): the violations subquery
    // is the OTHER read site in export.js that lacked the wave-9 filter. A
    // violation recorded against a stale failed agent_run row would surface
    // here even after a clean redispatch. Apply the same filter so the
    // audit-DB export shows only the surviving agent_run's violations.
    const violations = db.prepare(`
      SELECT fc.file_path, d.name as domain_name
      FROM file_claims fc
      JOIN agent_runs ar ON fc.agent_run_id = ar.id
      JOIN domains d ON ar.domain_id = d.id
      WHERE fc.violation = 1 AND ar.wave_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    `).all(w.id);

    return {
      number: w.wave_number,
      phase: w.phase,
      status: w.status,
      domain_snapshot_id: w.domain_snapshot_id,
      agents: agents.map(a => ({
        domain: a.domain_name,
        status: a.status,
        worktree: a.worktree_branch || null,
      })),
      verification: verification ? {
        passed: !!verification.passed,
        adapter: verification.repo_type,
        test_count: verification.test_count,
        exit_code: verification.exit_code,
      } : null,
      violations: violations.map(v => ({ file: v.file_path, domain: v.domain_name })),
      created: w.created_at,
      completed: w.completed_at,
    };
  });

  // Finding set
  const findingSet = findings.map(f => ({
    id: f.finding_id,
    fingerprint: f.fingerprint,
    severity: f.severity,
    category: f.category,
    file: f.file_path,
    line: f.line_number,
    symbol: f.symbol,
    description: f.description,
    recommendation: f.recommendation,
    status: f.status,
    first_seen_wave: f.first_seen_wave,
    last_seen_wave: f.last_seen_wave,
  }));

  // Finding summary
  const findingSummary = {
    total: findings.length,
    by_severity: {},
    by_status: {},
  };
  for (const f of findings) {
    findingSummary.by_severity[f.severity] = (findingSummary.by_severity[f.severity] || 0) + 1;
    findingSummary.by_status[f.status] = (findingSummary.by_status[f.status] || 0) + 1;
  }

  // Promotion trail
  const promotionTrail = promotions.map(p => ({
    from: p.from_phase,
    to: p.to_phase,
    authorized_by: p.authorized_by,
    gates: JSON.parse(p.gates_checked),
    overrides: p.overrides ? JSON.parse(p.overrides) : null,
    finding_snapshot: p.finding_snapshot ? JSON.parse(p.finding_snapshot) : null,
    at: p.created_at,
  }));

  // Compute content hash for provenance
  const exportPayload = {
    export_version: '1.0.0',
    exported_at: new Date().toISOString(),
    provenance: {
      system: 'swarm-control-plane',
      schema_version: 3,
      run_id: runId,
    },
    run: {
      id: run.id,
      repo: run.repo,
      branch: run.branch,
      commit_sha: run.commit_sha,
      status: run.status,
      save_point_tag: run.save_point_tag,
      created: run.created_at,
      completed: run.completed_at,
    },
    domains: domains.map(d => ({
      name: d.name,
      ownership_class: d.ownership_class,
      description: d.description,
    })),
    waves: waveSummaries,
    findings: {
      summary: findingSummary,
      items: findingSet,
    },
    verification: waveSummaries
      .filter(w => w.verification)
      .map(w => ({ wave: w.number, phase: w.phase, ...w.verification })),
    promotions: promotionTrail,
  };

  // Content hash for integrity
  const hash = createHash('sha256')
    .update(JSON.stringify(exportPayload))
    .digest('hex')
    .slice(0, 16);
  exportPayload.provenance.content_hash = hash;

  return exportPayload;
}

/**
 * Compute the overall verdict for a run export.
 * Used by downstream systems to determine pass/fail/partial.
 */
export function computeRunVerdict(exportData) {
  if (exportData.run.status === 'complete') return 'pass';
  if (exportData.run.status === 'aborted') return 'fail';

  const findings = exportData.findings.summary;
  const openCritical = (findings.by_status?.new || 0) + (findings.by_status?.recurring || 0);
  const hasCritical = (findings.by_severity?.CRITICAL || 0) > 0;

  if (hasCritical) return 'fail';
  if (openCritical > 0) return 'partial';
  return 'pass';
}
