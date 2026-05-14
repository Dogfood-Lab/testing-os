/**
 * revalidate.js — `swarm revalidate`
 *
 * Lawful operator-facing recovery path for agent_run rows in BLOCKED statuses
 * (invalid_output, ownership_violation). Wraps the canonical override primitive
 * (transitionAgent(... 'complete', reason, override=true)) which exists in
 * lib/state-machine.js but has had no CLI surface until now.
 *
 * Architectural grounding (study-swarm 2026-05-14):
 *
 *   - "Executed but produced invalid output" is REPAIRABLE, not terminal. AWS
 *     Step Functions Redrive 2023; Temporal workflow reset; Airflow
 *     clear/set-state; Argo retry; GitHub Actions rerun --failed. All ship an
 *     operator-initiated verb separate from automatic transient retry. The
 *     repair mutates the original row in place; input is immutable; the
 *     mandatory reason becomes part of audit history.
 *
 *   - Direct DB intervention is universally last-resort. Stripe Ledger 2024,
 *     pg_resetwal, etcdctl snapshot restore, kubectl, Modern Treasury all
 *     mediate state mutation through tooled commands that emit an
 *     event-sourced audit row alongside the UPDATE. The repair lives in the
 *     codebase, has tests, ships with a release — versioned operation, not
 *     ad-hoc fix.
 *
 *   - Dry-run by default, --apply to mutate. pg_resetwal -n; kubectl
 *     --dry-run=server. Operator previews what would change before any state
 *     leaves disk.
 *
 *   - Reason is non-optional. SOX §404 attributability; Stripe two-phase
 *     review collapses to single-phase + reason for single-operator systems.
 *
 *   - Wave-level rollback in the same transaction. collect.js:373-377
 *     unconditionally sets waves.status='failed' when validation_errors > 0.
 *     The wave has no law engine (raw UPDATEs scattered across dispatch.js,
 *     collect.js, verify.js, advance.js — see empirical state-machine trace
 *     2026-05-14). Once every agent_run in the wave reaches 'complete', the
 *     same direct UPDATE collect.js would have written flips the wave back
 *     to 'collected'. Same transaction prevents torn state (agents complete
 *     but wave still failed) if the process crashes mid-flight.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { openDb } from '../db/connection.js';
import { getDomains, checkOwnership } from '../lib/domains.js';
import { validateAuditOutput, validateFeatureOutput, validateAmendOutput } from '../lib/output-schema.js';
import { validateAgentOutput, AgentOutputValidationError } from '../lib/validate-agent-output.js';
import { transitionAgent, isBlocked } from '../lib/state-machine.js';
import { logStage } from '../lib/log-stage.js';

const AUDIT_PHASES = ['health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit'];
const AMEND_PHASES = ['health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute'];

function mintCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `coord-${ts}-${rand}`;
}

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {Object<string, string>} [opts.outputs] — domain → corrected output JSON path
 * @param {string} opts.reason — required, non-empty; recorded in agent_state_events
 * @param {boolean} [opts.apply] — without this, dry-run only (no mutation)
 * @returns {object} — report
 */
export function revalidate(opts) {
  const { runId, dbPath, outputs, reason, apply } = opts;

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('revalidate: --reason is required and must be a non-empty string');
  }

  if (!outputs || Object.keys(outputs).length === 0) {
    throw new Error('revalidate: at least one --domain=name:path is required');
  }

  const db = openDb(dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  // Find the latest wave regardless of status. collect.js intentionally filters
  // WHERE status='dispatched'; revalidate widens that to recover from 'failed'.
  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ?
    ORDER BY wave_number DESC LIMIT 1
  `).get(runId);
  if (!wave) throw new Error('No wave found for this run');

  const isAudit = AUDIT_PHASES.includes(wave.phase);
  const isAmend = AMEND_PHASES.includes(wave.phase);

  const agentRuns = db.prepare(`
    SELECT ar.* FROM agent_runs ar
    WHERE ar.wave_id = ?
      AND ar.id = (
        SELECT MAX(ar2.id) FROM agent_runs ar2
        WHERE ar2.wave_id = ar.wave_id AND ar2.domain_id = ar.domain_id
      )
  `).all(wave.id);

  const domains = getDomains(db, runId);
  const domainByName = new Map(domains.map(d => [d.name, d]));

  const report = {
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    waveStatusBefore: wave.status,
    waveStatusAfter: wave.status,
    dryRun: !apply,
    reason,
    repairs: [],
    refusals: [],
    skipped: [],
    summary: null,
  };

  // ── Validation pass — no mutation yet ──
  for (const [domainName, rawPath] of Object.entries(outputs)) {
    const domain = domainByName.get(domainName);
    if (!domain) {
      report.refusals.push({
        domain: domainName,
        agent_run_id: null,
        reason: `unknown domain "${domainName}" for this run`,
      });
      continue;
    }

    const ar = agentRuns.find(r => r.domain_id === domain.id);
    if (!ar) {
      report.refusals.push({
        domain: domainName,
        agent_run_id: null,
        reason: `no agent_run found for domain "${domainName}" in wave ${wave.wave_number}`,
      });
      continue;
    }

    // Idempotent: already complete → no-op skip (still recorded for operator visibility).
    if (ar.status === 'complete') {
      report.skipped.push({
        domain: domainName,
        agent_run_id: ar.id,
        reason: `agent_run already 'complete' — no repair needed`,
      });
      continue;
    }

    if (!isBlocked(ar.status)) {
      report.refusals.push({
        domain: domainName,
        agent_run_id: ar.id,
        reason: `agent_run is in '${ar.status}' (not blocked) — revalidate only repairs invalid_output / ownership_violation`,
      });
      continue;
    }

    const outputPath = resolve(rawPath);

    if (!existsSync(outputPath)) {
      report.refusals.push({
        domain: domainName,
        agent_run_id: ar.id,
        reason: `output file not found: ${outputPath}`,
      });
      continue;
    }

    let output;
    try {
      output = JSON.parse(readFileSync(outputPath, 'utf-8'));
    } catch (e) {
      report.refusals.push({
        domain: domainName,
        agent_run_id: ar.id,
        reason: `JSON parse error: ${e.message}`,
      });
      continue;
    }

    // Envelope gate (canonical Ajv schema)
    try {
      validateAgentOutput(output, {
        domain: domainName,
        phase: wave.phase,
        outputPath,
      });
    } catch (e) {
      if (e instanceof AgentOutputValidationError) {
        report.refusals.push({
          domain: domainName,
          agent_run_id: ar.id,
          reason: `envelope schema gate: ${e.message}`,
          errors: e.errors.map(err => `${err.path || '/'} ${err.message}`),
        });
        continue;
      }
      throw e;
    }

    // Phase-specific legacy validator (same as collect.js:235-243)
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
      report.refusals.push({
        domain: domainName,
        agent_run_id: ar.id,
        reason: `schema validation: ${validation.errors.join('; ')}`,
        errors: validation.errors,
      });
      continue;
    }

    // Ownership check (amend only). The original ownership_violation may have
    // been the blocking status — if the corrected JSON has different
    // files_changed, ownership may now pass.
    let ownership = null;
    if (isAmend && Array.isArray(output.files_changed) && output.files_changed.length > 0) {
      const check = checkOwnership(db, runId, domainName, output.files_changed);
      if (check.violations.length > 0) {
        report.refusals.push({
          domain: domainName,
          agent_run_id: ar.id,
          reason: `ownership: ${check.violations.map(v => v.file).join(', ')}`,
          violations: check.violations,
        });
        continue;
      }
      ownership = check;
    }

    report.repairs.push({
      domain: domainName,
      agent_run_id: ar.id,
      from: ar.status,
      to: 'complete',
      output_path: outputPath,
      ownership,
      applied: false,
    });
  }

  // ── Mutation pass — only with --apply, single transaction ──
  if (apply && report.repairs.length > 0) {
    const tx = db.transaction(() => {
      for (const r of report.repairs) {
        // Override path. Requires reason. Writes agent_state_events row for
        // free via executeTransition — preserves audit trail (Stripe Ledger
        // pattern: corrective event appended alongside the UPDATE).
        transitionAgent(db, r.agent_run_id, 'complete', reason, /* override */ true);

        // Record artifact
        const contentHash = createHash('sha256')
          .update(readFileSync(r.output_path))
          .digest('hex')
          .slice(0, 16);
        db.prepare(`
          INSERT INTO artifacts (agent_run_id, artifact_type, path, content_hash)
          VALUES (?, ?, ?, ?)
        `).run(
          r.agent_run_id,
          isAudit ? 'audit_output' : 'amend_output',
          r.output_path,
          contentHash,
        );

        db.prepare('UPDATE agent_runs SET output_path = ?, error_message = NULL WHERE id = ?')
          .run(r.output_path, r.agent_run_id);

        // Record file claims for amend (mirrors collect.js:288-294)
        if (isAmend && r.ownership && Array.isArray(r.ownership.valid)) {
          for (const v of r.ownership.valid) {
            const domain = domainByName.get(r.domain);
            db.prepare(`
              INSERT OR IGNORE INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
              VALUES (?, ?, 'edit', ?, 0)
            `).run(r.agent_run_id, v.file, domain.id);
          }
        }

        r.applied = true;
      }

      // Wave-level rollback: collect.js:373-377 sets the wave to 'failed' on any
      // validation_errors. Mirror its inverse — if every latest agent_run is now
      // 'complete' AND the wave is 'failed', flip back to 'collected'. Same
      // transaction prevents the torn-state regression (Stripe Ledger pattern).
      const remaining = db.prepare(`
        SELECT ar.id, ar.status FROM agent_runs ar
        WHERE ar.wave_id = ?
          AND ar.id = (
            SELECT MAX(ar2.id) FROM agent_runs ar2
            WHERE ar2.wave_id = ar.wave_id AND ar2.domain_id = ar.domain_id
          )
          AND ar.status != 'complete'
      `).all(wave.id);

      if (remaining.length === 0 && wave.status === 'failed') {
        db.prepare(`UPDATE waves SET status = 'collected', completed_at = datetime('now') WHERE id = ?`)
          .run(wave.id);
        report.waveStatusAfter = 'collected';
      } else {
        report.waveStatusAfter = wave.status;
      }
    });

    try {
      tx();
    } catch (e) {
      const correlationId = mintCorrelationId();
      logStage('revalidate_failed', {
        correlation_id: correlationId,
        err: e.message,
        runId,
        waveId: wave.id,
        waveNumber: wave.wave_number,
        repairsAttempted: report.repairs.length,
      });
      throw new Error(`revalidate transaction failed (correlation_id=${correlationId}): ${e.message}`);
    }
  }

  // Build summary
  const repairCount = report.repairs.filter(r => r.applied).length;
  const plannedCount = report.repairs.length;
  const refusalCount = report.refusals.length;
  const skipCount = report.skipped.length;

  if (apply) {
    report.summary =
      `Revalidate (APPLIED) — Wave ${wave.wave_number} (${wave.phase}):\n` +
      `  Repaired: ${repairCount} agent_run(s)\n` +
      `  Refused:  ${refusalCount}\n` +
      `  Skipped:  ${skipCount}\n` +
      `  Wave status: ${report.waveStatusBefore} → ${report.waveStatusAfter}\n` +
      `  Reason: ${reason}`;
  } else {
    report.summary =
      `Revalidate (DRY-RUN) — Wave ${wave.wave_number} (${wave.phase}):\n` +
      `  Would repair: ${plannedCount} agent_run(s)\n` +
      `  Would refuse: ${refusalCount}\n` +
      `  Skipped:      ${skipCount}\n` +
      `  Wave status would: ${report.waveStatusBefore} → ` +
      `${plannedCount > 0 && report.waveStatusBefore === 'failed' ? 'collected (only if ALL agents repaired)' : report.waveStatusBefore}\n` +
      `  Re-run with --apply to mutate. Reason will be: "${reason}"`;
  }

  return report;
}

/**
 * Human-readable formatter for the report. Mirrors collect.js's print pattern.
 */
export function formatRevalidate(report) {
  let out = report.summary + '\n';

  if (report.repairs.length > 0) {
    out += '\nRepairs:\n';
    for (const r of report.repairs) {
      const tag = r.applied ? '[APPLIED]' : '[would]';
      out += `  ${tag} ${r.domain} (agent_run=${r.agent_run_id}): ${r.from} → ${r.to}\n`;
    }
  }

  if (report.refusals.length > 0) {
    out += '\nRefused:\n';
    for (const r of report.refusals) {
      out += `  [REFUSE] ${r.domain}: ${r.reason}\n`;
    }
  }

  if (report.skipped.length > 0) {
    out += '\nSkipped:\n';
    for (const s of report.skipped) {
      out += `  [SKIP] ${s.domain}: ${s.reason}\n`;
    }
  }

  return out;
}
