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
 *   - Wave-level rollback in the same transaction. collect.js routes through
 *     transitionWave (Phase 5A wave state machine) when validation_errors > 0,
 *     emitting a dispatched → failed transition with audit row. Once every
 *     agent_run in the wave reaches 'complete', revalidate flips the wave
 *     back via transitionWave(... 'failed' → 'collected', reason, override=true).
 *     Override is required because 'failed' is BLOCKED in the wave state
 *     machine — the operator's --reason text becomes the audit-row reason in
 *     wave_state_events. Same transaction prevents torn state (agents complete
 *     but wave still failed) if the process crashes mid-flight.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';

import { minimatch } from 'minimatch';

import { openDb } from '../db/connection.js';
import { getDomains, checkOwnership, narrowToExclusivelyOwned } from '../lib/domains.js';
import { validateAuditOutput, validateFeatureOutput, validateAmendOutput } from '../lib/output-schema.js';
import { validateAgentOutput, AgentOutputValidationError } from '../lib/validate-agent-output.js';
import { transitionAgent, isBlocked } from '../lib/state-machine.js';
import { transitionWave } from '../lib/wave-state-machine.js';
import { logStage } from '../lib/log-stage.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { readBoundedJson } from '../lib/bounded-json-read.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings } from '../lib/fingerprint.js';
import { getActualTouchedFiles, resolveWorktreeBaseRef } from '../lib/git-touched-files.js';

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

  // F-H6/H7/H8 (Wave A1 D3): wave-9 latest-per-(wave, domain) filter via the
  // shared helper. The fragment is identical across mutation + read callers.
  const agentRuns = db.prepare(`
    SELECT ar.* FROM agent_runs ar
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
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
      // F-f35352cb: the 'failed'/'timed_out' tail (the common F-aba6fa9d
      // missing-output route) has a lawful verb — name it here instead of
      // making the operator rediscover it. redrive.js's own refusal taxonomy
      // already names revalidate for the inverse case.
      const redriveHint = (ar.status === 'failed' || ar.status === 'timed_out')
        ? `; use \`swarm redrive ${wave.id} --reason "<text>" --apply\` to put the failure tail back into flight`
        : '';
      report.refusals.push({
        domain: domainName,
        agent_run_id: ar.id,
        reason: `agent_run is in '${ar.status}' (not blocked) — revalidate only repairs invalid_output / ownership_violation${redriveHint}`,
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

    // F-H5 (Wave A1 D3): operator-supplied --domain=name:path JSON read goes
    // through the shared bounded helper. This is exactly the recovery case
    // where a pathological / oversized input matters most — a misnamed path
    // pointing at a multi-GB log would otherwise block the coordinator.
    let output;
    try {
      output = readBoundedJson(outputPath);
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
    //
    // F-7d2f60e0: the check runs against the UNION of the operator-supplied
    // files_changed AND the independently-observed git touched set (mirroring
    // collect.js's VD-NEW-1 posture). Pre-fix, only files_changed was
    // re-checked — an agent_run blocked as ownership_violation could be
    // flipped to 'complete' by simply EDITING files_changed to drop the
    // offending path while the out-of-domain edit remained in the working
    // tree. Same isolated/non-isolated narrowing as collect: without
    // --isolate the shared-tree diff cannot be attributed per-agent, so the
    // independent contribution is restricted to the files this domain
    // EXCLUSIVELY OWNS (wave2-live-001 / V2-INVARIAN-002: the shared
    // narrowToExclusivelyOwned helper — the same specificity arbitration as
    // checkOwnership; bare glob membership over-collects when globs overlap
    // and phantom-flags sibling agents' in-domain edits).
    let ownership = null;
    let baseDiffNote = null;
    if (isAmend && Array.isArray(output.files_changed)) {
      const isolated = !!ar.worktree_path;
      const worktree = ar.worktree_path || run.local_path;
      // F-0e55b5ca (mirrors collect.js): per-wave dispatch-time base; the
      // init-time runs.commit_sha is the legacy fallback only.
      const baseRef = isolated
        ? resolveWorktreeBaseRef(worktree, run.branch)
        : (wave.dispatch_sha || run.commit_sha);
      const actualTouched = getActualTouchedFiles(worktree, { baseRef });
      // V2-CONTRACT-003 / V2-INVARIAN-006 (mirrors collect.js): a failed base
      // diff or an unresolvable fork point makes committed edits invisible —
      // say so instead of silently narrowing to status + self-report coverage.
      if (!actualTouched.unavailable && (actualTouched.baseDiffUnavailable || (isolated && !baseRef))) {
        baseDiffNote = {
          reason: isolated && !baseRef
            ? 'worktree fork point unresolved (merge-base failed) — committed edits are invisible; probe coverage is status + self-report only'
            : 'base diff failed (bad ref or shallow clone) — committed edits are invisible; probe coverage is status + self-report only',
        };
        logStage('ownership_probe_degraded', {
          correlation_id: mintCorrelationId(),
          domain: domainName,
          runId,
          waveId: wave.id,
          waveNumber: wave.wave_number,
          isolated,
          reason: 'base_diff_unavailable',
          remediation: isolated
            ? 'ensure the run branch and the worktree fork point are resolvable (full clone, valid runs.branch)'
            : 'ensure runs.commit_sha is a resolvable ref in the local repo',
        });
      }
      const independentTouched = isolated
        ? actualTouched.all
        : narrowToExclusivelyOwned(domains, domainName, actualTouched.all);
      const unionSet = new Set([
        ...output.files_changed.map(p => String(p).replace(/\\/g, '/')),
        ...independentTouched,
      ]);
      const filesForOwnership = Array.from(unionSet);
      if (filesForOwnership.length > 0) {
        const check = checkOwnership(db, runId, domainName, filesForOwnership);
        if (check.violations.length > 0) {
          report.refusals.push({
            domain: domainName,
            agent_run_id: ar.id,
            reason: `ownership (reported + git-observed): ${check.violations.map(v => v.file).join(', ')}` +
              ' — revert the out-of-domain edits in the working tree; editing files_changed alone cannot clear an ownership_violation',
            violations: check.violations,
            ...(baseDiffNote ? { base_diff_unavailable: baseDiffNote } : {}),
          });
          continue;
        }
        ownership = check;
      }
    }

    report.repairs.push({
      domain: domainName,
      agent_run_id: ar.id,
      from: ar.status,
      to: 'complete',
      output_path: outputPath,
      ownership,
      ...(baseDiffNote ? { base_diff_unavailable: baseDiffNote } : {}),
      applied: false,
      // Carried for the mutation pass: the corrected output's findings are
      // ingested there (F-8efffdd1) and its verification_skipped flag is
      // propagated (F-5811d6df). Stripped before the report is returned.
      output,
      agent_run: ar,
    });
  }

  // fp-p-005 sourceText cache for the repaired-findings fingerprint pass
  // (F-8efffdd1). MUST mirror collect.js's sourceText-based fingerprinting —
  // a repaired finding fingerprinted WITHOUT the context snippet would mint a
  // different fingerprint than the same finding rediscovered by a later
  // re-audit, and the recurrence would misclassify as new. Same containment
  // guard + size cap as collect.js (finding.file is attacker-adjacent).
  const REVALIDATE_MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
  const sourceCache = new Map();
  const readFindingSource = (root, file) => {
    if (!root || !file) return null;
    const rootResolved = resolve(root);
    const resolved = resolve(root, String(file));
    if (sourceCache.has(resolved)) return sourceCache.get(resolved);
    let text = null;
    const contained = resolved === rootResolved || resolved.startsWith(rootResolved + sep);
    if (contained) {
      try {
        const st = statSync(resolved);
        if (st.isFile() && st.size <= REVALIDATE_MAX_SOURCE_FILE_BYTES) {
          text = readFileSync(resolved, 'utf-8');
        }
      } catch { text = null; }
    }
    sourceCache.set(resolved, text);
    return text;
  };

  // ── Mutation pass — only with --apply, single transaction ──
  if (apply && report.repairs.length > 0) {
    const tx = db.transaction(() => {
      // F-8efffdd1 (CRITICAL): findings inside a corrected AUDIT output must
      // be ingested into the control plane. Pre-fix, the repair transitioned
      // the agent to 'complete' and flipped the wave to 'collected' but never
      // ran the fingerprint/classify/upsert pipeline — collect() cannot be
      // re-run afterwards (requires wave.status='dispatched'), so every
      // HIGH/CRITICAL finding in the corrected output was absent from the
      // findings table, checkFindingSeverity counted zero open findings, and
      // the release gate silently ADVANCEd.
      const repairedFindings = [];

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

        // F-8efffdd1: stage the corrected audit output's findings for the
        // collect-parity ingestion below. Fingerprints use the same
        // sourceText path as collect.js (see the cache above).
        if (isAudit) {
          const findings = r.output.findings || r.output.features || [];
          const sourceRoot = r.agent_run.worktree_path || run.local_path;
          for (const f of findings) {
            const sourceText = readFindingSource(sourceRoot, f.file);
            f.fingerprint = computeFingerprint(f, { sourceText });
            repairedFindings.push(f);
          }
        }

        // F-5811d6df: propagate the serial-verify discipline signal exactly
        // as collect.js does. A --skip-verify wave recovered via revalidate
        // otherwise loses the TRUTH-001/TRUTH-003 signal entirely — status
        // and the receipt would report no serial-verify obligation for a
        // wave in which no agent ran tests.
        if (r.output.verification_skipped === true) {
          db.prepare('UPDATE agent_runs SET verification_skipped = 1 WHERE id = ?')
            .run(r.agent_run_id);
          db.prepare('UPDATE waves SET serial_verify_required = 1 WHERE id = ?')
            .run(wave.id);
        }

        r.applied = true;
      }

      // F-8efffdd1: collect-parity ingestion. upsertFindings' inner
      // db.transaction nests as a SAVEPOINT inside this outer tx (the L3-003
      // precedent), so the repair + its findings land atomically. Only the
      // inserted/recurring buckets are applied: revalidate is a POINT repair
      // of specific agents' outputs, not a whole-wave re-audit, so the
      // absence of a prior finding from ONE corrected output is NOT evidence
      // it was fixed or unverified — sibling agents' same-wave findings were
      // already ingested by the failed collect and must keep their statuses.
      if (isAudit && repairedFindings.length > 0) {
        const priorMap = buildPriorMap(db, runId);
        const classified = classifyFindings(repairedFindings, priorMap);
        const stats = upsertFindings(db, runId, wave.id, {
          new: classified.new,
          recurring: classified.recurring,
          fixed: [],
          unverified: [],
        });
        report.findings = {
          new: stats.inserted,
          recurring: stats.updated,
        };
      }

      // Wave-level rollback: collect.js:373-377 sets the wave to 'failed' on any
      // validation_errors. Mirror its inverse — if every latest agent_run is now
      // 'complete' AND the wave is 'failed', flip back to 'collected'. Same
      // transaction prevents the torn-state regression (Stripe Ledger pattern).
      // F-H6/H7/H8 (Wave A1 D3): shared wave-9 filter.
      const remaining = db.prepare(`
        SELECT ar.id, ar.status FROM agent_runs ar
        WHERE ar.wave_id = ?
          ${LATEST_AGENT_RUN_PER_DOMAIN}
          AND ar.status != 'complete'
      `).all(wave.id);

      if (remaining.length === 0 && wave.status === 'failed') {
        // Phase 5A: 'failed' is BLOCKED in the wave state machine.
        // transitionWave with override=true writes the audit row to
        // wave_state_events with the operator-supplied reason — this is the
        // canonical recovery primitive (failed → collected) wired to its
        // first CLI surface (`swarm revalidate --apply`).
        transitionWave(
          db,
          wave.id,
          'collected',
          `revalidate: ${reason}`,
          true,
        );
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

  // Strip the mutation-pass carriers (parsed output + agent_run row) so the
  // returned report keeps its pre-existing serializable shape.
  for (const r of report.repairs) {
    delete r.output;
    delete r.agent_run;
  }

  // Build summary
  const repairCount = report.repairs.filter(r => r.applied).length;
  const plannedCount = report.repairs.length;
  const refusalCount = report.refusals.length;
  const skipCount = report.skipped.length;

  if (apply) {
    // TRUTH-002: when the wave stays `failed`, the operator's natural read of
    // `Repaired: N` + clean exit code is "wave recovered." That is false when
    // any latest agent_run remains in a blocked status. Surface the
    // wave-stays-failed contract explicitly (mirror the dry-run summary's
    // `collected (only if ALL agents repaired)` rule disclosure) and count
    // any blocked agent_runs the operator did NOT pass via --domain so the
    // unaddressed bucket is visible.
    const partialNotRecovered =
      report.waveStatusBefore === 'failed' && report.waveStatusAfter === 'failed';
    let stillBlockedCount = 0;
    let unaddressedCount = 0;
    if (partialNotRecovered) {
      const repairedIds = new Set(report.repairs.filter(r => r.applied).map(r => r.agent_run_id));
      const submittedDomains = new Set(Object.keys(outputs || {}));
      // F-H6/H7/H8 (Wave A1 D3): shared wave-9 filter.
      const stillBlocked = db.prepare(`
        SELECT ar.id, d.name as domain_name, ar.status FROM agent_runs ar
        JOIN domains d ON ar.domain_id = d.id
        WHERE ar.wave_id = ?
          ${LATEST_AGENT_RUN_PER_DOMAIN}
          AND ar.status != 'complete'
      `).all(wave.id);
      stillBlockedCount = stillBlocked.length;
      unaddressedCount = stillBlocked.filter(
        b => !submittedDomains.has(b.domain_name) && !repairedIds.has(b.id)
      ).length;
    }

    const recoveryClause = partialNotRecovered
      ? `\n  Wave NOT recovered: ${stillBlockedCount} agent_run(s) remain blocked. ` +
        `(Wave flips to collected only when every latest agent_run is complete; ` +
        `${unaddressedCount} blocked agent_run(s) were not in the --domain set — ` +
        `inspect with \`swarm status ${runId}\`.)`
      : '';

    report.summary =
      `Revalidate (APPLIED) — Wave ${wave.wave_number} (${wave.phase}):\n` +
      `  Repaired: ${repairCount} agent_run(s)\n` +
      `  Refused:  ${refusalCount}\n` +
      `  Skipped:  ${skipCount}\n` +
      `  Wave status: ${report.waveStatusBefore} → ${report.waveStatusAfter}${recoveryClause}\n` +
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
