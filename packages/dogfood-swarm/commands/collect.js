/**
 * collect.js — `swarm collect`
 *
 * Collects agent outputs, validates schemas, enforces ownership, deduplicates findings.
 *
 * Steps:
 * 1. Find the current wave's agent_runs
 * 2. For each agent: read output JSON, validate schema
 * 3. Check file ownership (diff against domain globs)
 * 4. Fingerprint + dedup findings against prior waves
 * 5. Upsert findings into the control plane
 * 6. Generate wave summary
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { getDomains, checkOwnership } from '../lib/domains.js';
import { validateAuditOutput, validateFeatureOutput, validateAmendOutput } from '../lib/output-schema.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings } from '../lib/fingerprint.js';
import { transitionAgent } from '../lib/state-machine.js';

const AUDIT_PHASES = ['health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit'];
const AMEND_PHASES = ['health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute'];

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {Object<string, string>} opts.outputs — domain → output JSON path
 * @returns {object} — collection report
 */
export function collect(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Find current wave (most recent dispatched)
  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ? AND status = 'dispatched'
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);
  if (!wave) throw new Error('No dispatched wave found. Run `swarm dispatch` first.');

  const isAudit = AUDIT_PHASES.includes(wave.phase);
  const isAmend = AMEND_PHASES.includes(wave.phase);

  const agentRuns = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').all(wave.id);
  const domains = getDomains(db, opts.runId);
  const domainMap = new Map(domains.map(d => [d.name, d]));

  const report = {
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    agents: [],
    findings: { new: 0, recurring: 0, fixed: 0 },
    violations: [],
    validation_errors: [],
    summary: null,
  };

  const allFindings = [];

  for (const ar of agentRuns) {
    const domain = domains.find(d => d.id === ar.domain_id);
    if (!domain) continue;

    const outputPath = opts.outputs?.[domain.name];
    const agentReport = {
      domain: domain.name,
      agentRunId: ar.id,
      status: 'complete',
      findings_count: 0,
      errors: [],
      violations: [],
    };

    // Check if output exists
    if (!outputPath || !existsSync(outputPath)) {
      agentReport.status = 'failed';
      agentReport.errors.push('Output file not found');
      try {
        transitionAgent(db, ar.id, 'failed', 'Output file not found');
      } catch { /* may already be in failed state */ }
      db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
        .run('Output file not found', ar.id);
      report.agents.push(agentReport);
      continue;
    }

    // Read and parse output
    let output;
    try {
      output = JSON.parse(readFileSync(outputPath, 'utf-8'));
    } catch (e) {
      agentReport.status = 'invalid_output';
      agentReport.errors.push(`JSON parse error: ${e.message}`);
      try {
        transitionAgent(db, ar.id, 'invalid_output', `JSON parse error: ${e.message}`);
      } catch { /* transition may not be allowed from current state */ }
      db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
        .run(e.message, ar.id);
      report.agents.push(agentReport);
      report.validation_errors.push({ domain: domain.name, error: e.message });
      continue;
    }

    // Validate schema
    let validation;
    if (isAudit && wave.phase !== 'feature-audit') {
      validation = validateAuditOutput(output);
    } else if (wave.phase === 'feature-audit') {
      validation = validateFeatureOutput(output);
    } else if (isAmend) {
      validation = validateAmendOutput(output);
    } else {
      validation = { valid: true, errors: [] };
    }

    if (!validation.valid) {
      agentReport.status = 'invalid_output';
      agentReport.errors = validation.errors;
      try {
        transitionAgent(db, ar.id, 'invalid_output', `Schema validation: ${validation.errors.join('; ')}`);
      } catch { /* transition may not be allowed from current state */ }
      db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
        .run(validation.errors.join('; '), ar.id);
      report.agents.push(agentReport);
      report.validation_errors.push({ domain: domain.name, errors: validation.errors });
      continue;
    }

    // Record artifact
    const contentHash = createHash('sha256')
      .update(readFileSync(outputPath))
      .digest('hex')
      .slice(0, 16);

    db.prepare(`
      INSERT INTO artifacts (agent_run_id, artifact_type, path, content_hash)
      VALUES (?, ?, ?, ?)
    `).run(ar.id, isAudit ? 'audit_output' : 'amend_output', outputPath, contentHash);

    // Check ownership for amend waves
    if (isAmend && output.files_changed?.length > 0) {
      const ownership = checkOwnership(db, opts.runId, domain.name, output.files_changed);
      if (ownership.violations.length > 0) {
        agentReport.status = 'ownership_violation';
        agentReport.violations = ownership.violations;
        const violMsg = `Out-of-domain edits: ${ownership.violations.map(v => v.file).join(', ')}`;
        try {
          transitionAgent(db, ar.id, 'ownership_violation', violMsg);
        } catch { /* transition may not be allowed from current state */ }
        db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
          .run(violMsg, ar.id);

        // Record file claims with violations
        for (const v of ownership.violations) {
          db.prepare(`
            INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
            VALUES (?, ?, 'edit', ?, 1)
          `).run(ar.id, v.file, domain.id);
        }
        report.violations.push(...ownership.violations);
      }

      // Record valid file claims
      for (const v of (ownership.valid || [])) {
        db.prepare(`
          INSERT OR IGNORE INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
          VALUES (?, ?, 'edit', ?, 0)
        `).run(ar.id, v.file, domain.id);
      }
    }

    // Collect findings for dedup
    const findings = isAudit
      ? (output.findings || output.features || [])
      : [];

    for (const f of findings) {
      f.fingerprint = computeFingerprint(f);
      allFindings.push(f);
    }

    agentReport.findings_count = findings.length;
    if (agentReport.status === 'complete') {
      try {
        transitionAgent(db, ar.id, 'complete', 'Output collected and validated');
      } catch { /* may already be complete */ }
      db.prepare('UPDATE agent_runs SET output_path = ? WHERE id = ?')
        .run(outputPath, ar.id);
    }

    report.agents.push(agentReport);
  }

  // Fingerprint + dedup
  if (allFindings.length > 0) {
    const priorMap = buildPriorMap(db, opts.runId);
    const classified = classifyFindings(allFindings, priorMap);
    const stats = upsertFindings(db, opts.runId, wave.id, classified);

    report.findings = {
      new: stats.inserted,
      recurring: stats.updated,
      fixed: stats.fixed,
    };
  }

  // Update wave status
  const hasViolations = report.violations.length > 0;
  const hasErrors = report.validation_errors.length > 0;
  const waveStatus = hasViolations || hasErrors ? 'failed' : 'collected';
  db.prepare('UPDATE waves SET status = ?, completed_at = datetime(?) WHERE id = ?')
    .run(waveStatus, 'now', wave.id);

  // Generate summary
  report.summary = buildSummary(db, opts.runId, wave, report);

  return report;
}

/**
 * Build a human-readable wave summary.
 */
function buildSummary(db, runId, wave, report) {
  const allFindings = db.prepare(
    "SELECT severity, status FROM findings WHERE run_id = ?"
  ).all(runId);

  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byStatus = { new: 0, recurring: 0, approved: 0, fixed: 0, deferred: 0 };
  for (const f of allFindings) {
    if (bySeverity[f.severity] != null) bySeverity[f.severity]++;
    if (byStatus[f.status] != null) byStatus[f.status]++;
  }

  const agentSummary = report.agents
    .map(a => `  ${a.domain}: ${a.status}${a.findings_count ? ` (${a.findings_count} findings)` : ''}${a.errors.length ? ` [ERRORS: ${a.errors.length}]` : ''}`)
    .join('\n');

  return `Wave ${wave.wave_number} (${wave.phase}):
  CRITICAL: ${bySeverity.CRITICAL}  HIGH: ${bySeverity.HIGH}  MEDIUM: ${bySeverity.MEDIUM}  LOW: ${bySeverity.LOW}
  New: ${report.findings.new}  Recurring: ${report.findings.recurring}  Fixed: ${report.findings.fixed}
  Violations: ${report.violations.length}

Agents:
${agentSummary}`;
}
