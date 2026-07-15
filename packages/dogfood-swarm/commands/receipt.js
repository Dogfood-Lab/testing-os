/**
 * receipt.js — `swarm receipt <run-id> [wave-number]`
 *
 * Export a durable wave receipt derived from DB truth.
 * Produces JSON + markdown. Stores receipt path in the control plane.
 *
 * Receipt contains:
 *   - run id, wave id, phase
 *   - frozen domain snapshot id
 *   - per-agent status + output artifact paths
 *   - ownership violations
 *   - invalid outputs
 *   - merged findings (new / recurring / fixed counts)
 *   - redispatch history
 *   - recommendation / advance hint
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { FINDING_GATED_PHASES } from '../lib/advance.js';
import { isOpenFinding } from '../lib/finding-status.js';

/**
 * Build a receipt object from DB truth.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {number} [opts.waveNumber] — specific wave (default: latest)
 * @param {string} opts.dbPath
 * @returns {object} — receipt data
 */
export function buildReceipt(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Find wave
  let wave;
  if (opts.waveNumber) {
    wave = db.prepare('SELECT * FROM waves WHERE run_id = ? AND wave_number = ?')
      .get(opts.runId, opts.waveNumber);
  } else {
    wave = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1')
      .get(opts.runId);
  }
  if (!wave) throw new Error('No waves found');

  // Agent runs — F-H6 (Wave A1 D3): wave-9 latest-per-(wave, domain) filter
  // via the shared helper. Without the filter the receipt surfaced stale
  // failed agent_run rows alongside the redispatched complete row, making a
  // recovered wave's receipt show 4 agents (3 domains + 1 stale) instead of
  // 3. The downstream queries at :62-91 (state events, artifacts, ownership
  // violations) join through the filtered agent_runs id list so they
  // inherit the wave-9 discipline for free.
  const agentRuns = db.prepare(`
    SELECT ar.*, d.name as domain_name, d.ownership_class
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
    ORDER BY d.name
  `).all(wave.id);

  // Agent state events for this wave's agents
  const agentIds = agentRuns.map(a => a.id);
  const stateEvents = agentIds.length > 0
    ? db.prepare(`
        SELECT ase.*, d.name as domain_name
        FROM agent_state_events ase
        JOIN agent_runs ar ON ase.agent_run_id = ar.id
        JOIN domains d ON ar.domain_id = d.id
        WHERE ase.agent_run_id IN (${agentIds.map(() => '?').join(',')})
        ORDER BY ase.created_at
      `).all(...agentIds)
    : [];

  // Artifacts
  const artifacts = agentIds.length > 0
    ? db.prepare(`
        SELECT a.*, d.name as domain_name
        FROM artifacts a
        JOIN agent_runs ar ON a.agent_run_id = ar.id
        JOIN domains d ON ar.domain_id = d.id
        WHERE a.agent_run_id IN (${agentIds.map(() => '?').join(',')})
      `).all(...agentIds)
    : [];

  // Ownership violations
  const violations = agentIds.length > 0
    ? db.prepare(`
        SELECT fc.*, d.name as domain_name
        FROM file_claims fc
        JOIN agent_runs ar ON fc.agent_run_id = ar.id
        JOIN domains d ON ar.domain_id = d.id
        WHERE fc.violation = 1 AND fc.agent_run_id IN (${agentIds.map(() => '?').join(',')})
      `).all(...agentIds)
    : [];

  // Findings summary
  const allFindings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(opts.runId);
  const findingsBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const openBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const findingsByStatus = {};
  for (const f of allFindings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
    findingsByStatus[f.status] = (findingsByStatus[f.status] || 0) + 1;
    if (isOpenFinding(f.status)) {
      openBySeverity[f.severity] = (openBySeverity[f.severity] || 0) + 1;
    }
  }

  // Wave-specific finding counts
  const waveNew = allFindings.filter(f => f.first_seen_wave === wave.id && f.status === 'new').length;
  const waveRecurring = allFindings.filter(f => f.last_seen_wave === wave.id && f.status === 'recurring').length;
  const waveFixed = allFindings.filter(f => f.last_seen_wave === wave.id && f.status === 'fixed').length;

  // Wave-delta severity: severity of findings first seen in THIS wave
  const waveNewCrit = allFindings.filter(
    f => f.first_seen_wave === wave.id && f.status === 'new' && f.severity === 'CRITICAL'
  ).length;
  const waveNewHigh = allFindings.filter(
    f => f.first_seen_wave === wave.id && f.status === 'new' && f.severity === 'HIGH'
  ).length;
  const totalFixed = (findingsByStatus.fixed || 0);

  // Verification receipt for this wave — LATEST row (F-b9a8f684). Without the
  // ORDER BY, .get() returned the OLDEST receipt while lib/advance.js's Gate 4
  // reads the newest: after a fail-then-pass verify sequence the durable
  // receipt rendered FAIL while `swarm advance` passed. Ordering mirrors
  // checkVerification so both operator surfaces read the same DB truth.
  const verification = db.prepare(
    'SELECT * FROM verification_receipts WHERE wave_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ).get(wave.id);

  // Compute advance recommendation from OPEN findings (not historical aggregate).
  // The wave-scoped verification receipt is threaded in so the serial-verify
  // obligation is visible to the recommendation (V2-CONTRACT-002).
  const recommendation = computeRecommendation(wave, agentRuns, openBySeverity, {
    waveNew,
    waveNewCrit,
    waveNewHigh,
    totalFixed,
  }, verification);

  return {
    receipt_version: '1.0.0',
    generated_at: new Date().toISOString(),
    run: {
      id: run.id,
      repo: run.repo,
      branch: run.branch,
      commit_sha: run.commit_sha,
      status: run.status,
      timeout_policy_ms: run.timeout_policy_ms,
    },
    wave: {
      id: wave.id,
      number: wave.wave_number,
      phase: wave.phase,
      status: wave.status,
      domain_snapshot_id: wave.domain_snapshot_id,
      created_at: wave.created_at,
      completed_at: wave.completed_at,
      // TRUTH-003: persisted serial-verify discipline signal. Surfacing
      // here rather than collapsing under `verification` keeps the receipt
      // an honest read of DB truth even when no verification_receipts row
      // exists for the wave (the legacy `verification: null` shape hid
      // exactly the situation the operator needs to see).
      serial_verify_required: !!wave.serial_verify_required,
      // FT-d: persisted ownership-attribution-degraded signal. When a
      // non-isolated amend wave narrowed its independent ownership probe to
      // each agent's own globs, a silent cross-domain edit the agent also
      // omits from `files_changed` is no longer independently caught. Surfacing
      // it here makes the weakened guarantee visible to a post-hoc receipt
      // reader who never saw the collect-time NDJSON/stdout hint. Observability
      // only — never a gate; the operator's action is to re-dispatch with
      // --isolate. Mirrors serial_verify_required directly above.
      ownership_probe_degraded: !!wave.ownership_probe_degraded,
    },
    agents: agentRuns.map(ar => ({
      domain: ar.domain_name,
      ownership_class: ar.ownership_class,
      status: ar.status,
      started_at: ar.started_at,
      completed_at: ar.completed_at,
      output_path: ar.output_path,
      error: ar.error_message,
      // TRUTH-003: per-agent verify-skipped truth for forensic readers.
      verification_skipped: !!ar.verification_skipped,
    })),
    state_transitions: stateEvents.map(e => ({
      domain: e.domain_name,
      from: e.from_status,
      to: e.to_status,
      reason: e.reason,
      at: e.created_at,
    })),
    artifacts: artifacts.map(a => ({
      domain: a.domain_name,
      type: a.artifact_type,
      path: a.path,
      hash: a.content_hash,
    })),
    ownership_violations: violations.map(v => ({
      domain: v.domain_name,
      file: v.file_path,
      claim_type: v.claim_type,
    })),
    findings: {
      total: allFindings.length,
      by_severity: findingsBySeverity,
      by_status: findingsByStatus,
      this_wave: { new: waveNew, recurring: waveRecurring, fixed: waveFixed },
    },
    verification: verification ? {
      passed: !!verification.passed,
      repo_type: verification.repo_type,
      test_count: verification.test_count,
      exit_code: verification.exit_code,
    } : null,
    recommendation,
  };
}

/**
 * Export receipt as JSON + markdown.
 *
 * @param {object} receipt
 * @param {string} outputDir
 * @returns {{ jsonPath: string, mdPath: string }}
 */
export function exportReceipt(receipt, outputDir) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const base = `wave-${receipt.wave.number}-receipt`;
  const jsonPath = join(outputDir, `${base}.json`);
  const mdPath = join(outputDir, `${base}.md`);

  atomicWriteFileSync(jsonPath, JSON.stringify(receipt, null, 2) + '\n', 'utf-8');
  atomicWriteFileSync(mdPath, formatReceiptMarkdown(receipt) + '\n', 'utf-8');

  return { jsonPath, mdPath };
}

/**
 * Store receipt artifact paths in the control plane.
 */
export function storeReceipt(db, waveId, jsonPath, mdPath) {
  const hash = createHash('sha256')
    .update(JSON.stringify({ jsonPath, mdPath }))
    .digest('hex')
    .slice(0, 16);

  db.prepare(`
    INSERT OR REPLACE INTO wave_receipts (wave_id, json_path, md_path, content_hash)
    VALUES (?, ?, ?, ?)
  `).run(waveId, jsonPath, mdPath, hash);
}

/**
 * F-59f22202: a verification_receipts row with `passed=0` (falsy) and
 * `exit_code` of 0 or -1 is never a real failing step — lib/verify/runner.js
 * guarantees a failing REQUIRED step always carries a genuine nonzero (or
 * -127 tool_missing) exit code, so that pairing can ONLY be a wave-verdict-
 * only case (no_tests / unmeasured_tests / skip) where no step failed at
 * all. Pre-fix persistence (commands/verify.js) stored a bare 0 for this
 * case, so historical rows carry 0; post-fix rows carry the -1 sentinel
 * (NO_FAILING_STEP_EXIT_CODE in verify.js) — both are handled here so this
 * renders coherently for old and new data alike. Printing either as a bare
 * "exit 0"/"exit -1" reads as a self-contradictory rendering bug to an
 * operator (0 conventionally means success); naming the real condition
 * avoids that misdiagnosis at exactly the moment the operator needs to
 * trust the diagnostic.
 */
function formatExitClause(passed, exitCode) {
  if (!passed && (exitCode === 0 || exitCode === -1)) return 'no required step failed';
  return `exit ${exitCode}`;
}

/**
 * Format receipt as markdown.
 */
export function formatReceiptMarkdown(r) {
  const lines = [];

  lines.push(`# Wave ${r.wave.number} Receipt — ${r.wave.phase}`);
  lines.push('');
  lines.push(`**Run:** ${r.run.id}`);
  lines.push(`**Repo:** ${r.run.repo} (${r.run.branch} @ ${r.run.commit_sha?.slice(0, 8)})`);
  lines.push(`**Wave status:** ${r.wave.status}`);
  lines.push(`**Domain snapshot:** ${r.wave.domain_snapshot_id || 'none'}`);
  // TRUTH-003: surface the wave-level discipline signal so the operator
  // reading the receipt sees the same truth `swarm status` did.
  lines.push(`**Serial verify required:** ${r.wave.serial_verify_required ? 'yes' : 'no'}`);
  // FT-d: render the persisted ownership-attribution-degraded signal. Like the
  // `REQUIRED` obligation marker in the Agents table, frame the degraded state
  // as an operator action (`DEGRADED — re-dispatch with --isolate`) rather than
  // a neutral boolean, so the weakened ownership guarantee reads pre-attentively
  // on a wave that ran without --isolate. The default-quiet state stays `no`.
  lines.push(
    `**Ownership probe:** ${
      r.wave.ownership_probe_degraded ? 'DEGRADED — re-dispatch with --isolate for full attribution' : 'full'
    }`,
  );
  lines.push(`**Generated:** ${r.generated_at}`);
  lines.push('');

  // Agents table — TRUTH-003 adds a `Verify skipped` column so the
  // per-agent identity (which agent skipped, which didn't) is not lost in
  // the wave aggregate.
  lines.push('## Agents');
  lines.push('');
  lines.push('| Domain | Ownership | Status | Verify skipped | Error |');
  lines.push('|--------|-----------|--------|----------------|-------|');
  for (const a of r.agents) {
    // D-STRUCT-002: render the cell as an OBLIGATION marker, not a neutral
    // boolean. `REQUIRED` (uppercase) reads pre-attentively as an open
    // coordinator obligation; `—` (em-dash) is the default-quiet state and
    // matches the convention already used in the Error column. Compare
    // with the prior shape (`yes` / `no`) where a wave-level discipline
    // gate collapsed into a passing-checkbox visual. The JSON layer's
    // `verification_skipped: boolean` is unchanged (machine consumers
    // parse the boolean); only the human-readable cell shifts to surface
    // the obligation.
    const skipped = a.verification_skipped ? 'REQUIRED' : '—';
    lines.push(`| ${a.domain} | ${a.ownership_class} | ${a.status} | ${skipped} | ${a.error || '—'} |`);
  }
  lines.push('');

  // State transitions
  if (r.state_transitions.length > 0) {
    lines.push('## State Transitions');
    lines.push('');
    for (const t of r.state_transitions) {
      lines.push(`- **${t.domain}**: ${t.from} → ${t.to}${t.reason ? ` — ${t.reason}` : ''}`);
    }
    lines.push('');
  }

  // Violations
  if (r.ownership_violations.length > 0) {
    lines.push('## Ownership Violations');
    lines.push('');
    for (const v of r.ownership_violations) {
      lines.push(`- **${v.domain}**: ${v.file} (${v.claim_type})`);
    }
    lines.push('');
  }

  // Findings
  lines.push('## Findings');
  lines.push('');
  const f = r.findings;
  lines.push(`Total: ${f.total} | CRIT: ${f.by_severity.CRITICAL} HIGH: ${f.by_severity.HIGH} MED: ${f.by_severity.MEDIUM} LOW: ${f.by_severity.LOW}`);
  lines.push(`This wave: ${f.this_wave.new} new, ${f.this_wave.recurring} recurring, ${f.this_wave.fixed} fixed`);
  if (Object.keys(f.by_status).length > 0) {
    lines.push(`By status: ${Object.entries(f.by_status).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  }
  lines.push('');

  // Verification
  if (r.verification) {
    lines.push('## Verification');
    lines.push('');
    const v = r.verification;
    lines.push(`${v.passed ? 'PASS' : 'FAIL'} (${v.repo_type}${v.test_count ? `, ${v.test_count} tests` : ''}, ${formatExitClause(v.passed, v.exit_code)})`);
    lines.push('');
  }

  // Recommendation
  lines.push('## Recommendation');
  lines.push('');
  lines.push(`**${r.recommendation.action}**${r.recommendation.reason ? ` — ${r.recommendation.reason}` : ''}`);

  return lines.join('\n');
}

export function computeRecommendation(wave, agentRuns, openBySeverity, waveDelta, verification) {
  const allComplete = agentRuns.every(a => a.status === 'complete');
  const hasBlocked = agentRuns.some(a => ['invalid_output', 'ownership_violation'].includes(a.status));
  const hasInFlight = agentRuns.some(a => ['dispatched', 'running'].includes(a.status));

  if (hasInFlight) {
    return { action: 'WAIT', reason: 'Agents still in-flight' };
  }
  if (hasBlocked) {
    return { action: 'FIX', reason: 'Blocked agents need manual intervention before advancing' };
  }
  // F-15fc601e (mirrors status.js#computeAssessment): a wave failed for
  // missing outputs leaves agents in 'failed'/'timed_out' — redispatchable,
  // not blocked — and the RESUME recommendation below was a dead-end (resume
  // never flips the wave out of 'failed'; collect and revalidate then both
  // refuse). Route the failure tail to `swarm redrive`, the verb that flips
  // wave AND agents back to dispatched.
  const failedTail = agentRuns.filter(a => a.status === 'failed' || a.status === 'timed_out');
  if (wave.status === 'failed' && failedTail.length > 0) {
    return {
      action: 'REDRIVE',
      reason:
        `wave failed with ${failedTail.length} failed/timed_out agent(s) — ` +
        `\`swarm redrive ${wave.id} --reason "<text>" --apply\` puts the failure tail back into flight ` +
        `(resume alone cannot flip the wave out of 'failed')`,
    };
  }
  if (!allComplete) {
    return { action: 'RESUME', reason: 'Some agents not complete — run `swarm resume`' };
  }

  // V2-CONTRACT-002: mirror lib/advance.js#checkVerification (F-d12da6ea). A
  // wave dispatched under --skip-verify ran zero tests by design; until a
  // PASSING wave-scoped verification receipt exists, the actual gate returns
  // the NON-overridable VERIFY verdict — so the receipt must recommend VERIFY,
  // not ADVANCE. Same branch position as Gate 4: after agent completion,
  // before the finding-severity gate.
  if (wave.serial_verify_required && !(verification && verification.passed)) {
    return {
      action: 'VERIFY',
      reason: verification
        ? `serial verify required (--skip-verify wave) — latest verification failed (${verification.repo_type}, ${formatExitClause(verification.passed, verification.exit_code)}); fix and re-run \`swarm verify\``
        : 'serial verify required (--skip-verify wave) — no verification receipt; run `swarm verify` first',
    };
  }

  const wavePart = `Wave: ${waveDelta.waveNew} new (${waveDelta.waveNewCrit} CRIT + ${waveDelta.waveNewHigh} HIGH)`;
  const runPart = `Run total: ${openBySeverity.CRITICAL} CRIT + ${openBySeverity.HIGH} HIGH open (fixed: ${waveDelta.totalFixed})`;

  // All complete — check OPEN severity. The CLOSED set (fixed/rejected/deferred)
  // is owned by lib/finding-status.js and applied where openBySeverity is
  // computed (buildReceipt above, via isOpenFinding), so a deferred CRITICAL/HIGH
  // is not counted as a blocker — matching lib/advance.js#checkFindingSeverity.
  // Gate on the same FINDING_GATED_PHASES set lib/advance.js enforces. Together
  // with the VERIFY branch above (Gate 4's serial-verify obligation), the
  // receipt's recommendation cannot say ADVANCE while `swarm advance` refuses —
  // the finding-gate half of that mismatch surfaced in health-audit-b/c and
  // stage-d-audit (finding-gated but missed by the old health-audit-a prefix
  // test); the verify half was V2-CONTRACT-002.
  if (FINDING_GATED_PHASES.has(wave.phase) && (openBySeverity.CRITICAL > 0 || openBySeverity.HIGH > 0)) {
    return {
      action: 'AMEND',
      reason: `${wavePart} | ${runPart} — approve and amend`,
    };
  }

  return { action: 'ADVANCE', reason: `${wavePart} | ${runPart} — all agents clean, ready to advance` };
}
