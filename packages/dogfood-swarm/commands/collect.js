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
import { transitionAgent, canTransition } from '../lib/state-machine.js';
import { CollectUpsertError } from '../lib/errors.js';
import { logStage } from '../lib/log-stage.js';

/**
 * tryTransition — observability-friendly wrapper around transitionAgent.
 *
 * The state machine is the law engine for agent_run status changes
 * (state-machine.js header). collect.js historically wrapped every
 * transitionAgent() call in a bare `try { ... } catch { /* comment *\/ }` —
 * silently swallowing the no-op case ("already in target state") AND any real
 * regression (FK violation, prepared-statement crash, future state-machine
 * change introducing a newly-illegal transition). The two were
 * indistinguishable at the call site, defeating the auditability the state
 * machine exists to provide (F-178610-005).
 *
 * Behaviour:
 *   - If the agent_run is already in `to`, returns `{ skipped: true }`
 *     silently. This is the explicit no-op path — replaces the rationalising
 *     comments in the old bare catches.
 *   - If `canTransition(from, to)` says the transition is allowed, performs
 *     it via transitionAgent() and returns `{ transitioned: true }`.
 *   - Anything else is logged to stderr with full context (agent run id,
 *     domain hint, from/to, reason) so an operator can distinguish a real
 *     regression from the expected already-in-target case. The error is
 *     swallowed (collect must keep processing other agents) but is NOT
 *     silent — that's the entire point of the wave-10 fix.
 */
function tryTransition(db, agentRunId, to, reason, domainHint) {
  const ar = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunId);
  if (!ar) {
    console.warn(
      `collect: tryTransition skipped — agent_run ${agentRunId} not found ` +
      `(domain=${domainHint || '?'}, attempted to=${to})`
    );
    return { skipped: true };
  }
  if (ar.status === to) {
    return { skipped: true };
  }
  const check = canTransition(ar.status, to);
  if (!check.allowed) {
    console.warn(
      `collect: state-machine rejected transition for agent_run=${agentRunId} ` +
      `(domain=${domainHint || '?'}, from=${ar.status}, to=${to}): ${check.reason}`
    );
    return { skipped: true, rejected: true, reason: check.reason };
  }
  try {
    transitionAgent(db, agentRunId, to, reason);
    return { transitioned: true };
  } catch (e) {
    console.warn(
      `collect: transitionAgent threw for agent_run=${agentRunId} ` +
      `(domain=${domainHint || '?'}, from=${ar.status}, to=${to}): ${e.message}`
    );
    return { skipped: true, error: e.message };
  }
}

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

  // Read the LATEST agent_run per (wave_id, domain_id). After `swarm resume`
  // runs, the wave gains a new agent_run row per redispatched domain (resume.js
  // INSERTs at status='pending', then transitions to 'dispatched'); the OLD
  // failed/timed_out row remains. Iterating ALL rows would (a) double-count
  // findings if the old outputPath still exists on disk, (b) silently call
  // transitionAgent('failed' → 'failed') on the stale row (illegal — the
  // state machine throws), and (c) flip wave.status back to 'failed' even
  // when every redispatched agent succeeded, blocking advance.js. Mirrors the
  // wave-9 latest-per-domain pattern in resume.js. F-375053-002.
  const agentRuns = db.prepare(`
    SELECT ar.* FROM agent_runs ar
    WHERE ar.wave_id = ?
      AND ar.id = (
        SELECT MAX(ar2.id) FROM agent_runs ar2
        WHERE ar2.wave_id = ar.wave_id AND ar2.domain_id = ar.domain_id
      )
  `).all(wave.id);
  const domains = getDomains(db, opts.runId);
  const domainMap = new Map(domains.map(d => [d.name, d]));

  const report = {
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    agents: [],
    findings: { new: 0, recurring: 0, fixed: 0, unverified: 0 },
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
      tryTransition(db, ar.id, 'failed', 'Output file not found', domain.name);
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
      tryTransition(db, ar.id, 'invalid_output', `JSON parse error: ${e.message}`, domain.name);
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
      tryTransition(db, ar.id, 'invalid_output', `Schema validation: ${validation.errors.join('; ')}`, domain.name);
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
        tryTransition(db, ar.id, 'ownership_violation', violMsg, domain.name);
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
      tryTransition(db, ar.id, 'complete', 'Output collected and validated', domain.name);
      db.prepare('UPDATE agent_runs SET output_path = ? WHERE id = ?')
        .run(outputPath, ar.id);
    }

    report.agents.push(agentReport);
  }

  // Fingerprint + dedup.
  //
  // Note: classifyFindings is called WITHOUT a `scope` argument here — that is
  // the strictly-safe default per B-BACK-003. Without scope info, every prior
  // finding not rediscovered this wave is classified `unverified` rather than
  // `fixed`. A follow-up wave will wire wave-bound domain globs into a scope
  // descriptor (minimatch → path-prefix conversion is non-trivial and out of
  // scope for the wave 8 self-inspection slice). Until then, the digest will
  // surface `unverified` counts so operators have an explicit "agent did not
  // look at this" signal instead of a silent false-fix claim.
  // F-693631-002 (wave-12): upsertFindings was previously unguarded. Its
  // inner db.transaction() guarantees atomicity at the SQLite level — a
  // throw rolls back every INSERT/UPDATE inside the tx — but that throw
  // then escaped collect AFTER artifact rows + file_claims + agent state
  // transitions had been committed, leaving the wave-status UPDATE below
  // unrun. Result: artifacts persisted, agents `complete`, wave still
  // `dispatched`, findings missing — a state `swarm resume` couldn't
  // recover. The wrapper here logs structured context, surfaces a typed
  // error so the CLI can exit non-zero, and lets atomicity stay where it
  // belongs (inside upsertFindings).
  if (allFindings.length > 0) {
    const priorMap = buildPriorMap(db, opts.runId);
    const classified = classifyFindings(allFindings, priorMap);
    let stats;
    try {
      stats = upsertFindings(db, opts.runId, wave.id, classified);
    } catch (e) {
      logStage('upsert_findings_failed', {
        err: e.message,
        runId: opts.runId,
        waveId: wave.id,
        waveNumber: wave.wave_number,
        findingsAttempted: allFindings.length,
      });
      throw new CollectUpsertError(
        `upsertFindings failed for wave=${wave.wave_number} (${allFindings.length} findings attempted): ${e.message}`,
        { cause: e, waveId: wave.id, findingsAttempted: allFindings.length }
      );
    }

    report.findings = {
      new: stats.inserted,
      recurring: stats.updated,
      fixed: stats.fixed,
      unverified: stats.unverified || 0,
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
