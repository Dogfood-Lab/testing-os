/**
 * verify.js — `swarm verify <run-id>`
 *
 * Runs verification using the adapter registry, persists the result
 * into the control plane as a verification_receipt on the current wave.
 *
 * This is a wave gate: status uses the receipt to recommend ADVANCE vs FIX.
 */

import { randomBytes } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { runVerification, probeAll, selectAdapter, listAdapters } from '../lib/verify/registry.js';
import { transitionWave } from '../lib/wave-state-machine.js';
import { logStage } from '../lib/log-stage.js';

/**
 * Mint a synthetic correlation_id for the verify wave-gate. Mirrors the
 * `coord-<base36-ts>-<rand4>` pattern used in commands/dispatch.js +
 * collect.js so a single grep ties a `verify_start`/`verify_complete`
 * pair to the run+wave it gated (ve-p-004).
 */
function mintCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `coord-${ts}-${rand}`;
}

/**
 * Run verification for a swarm run.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} [opts.override] — force a specific adapter
 * @param {object} [opts.commandOverrides] — override specific steps
 * @returns {object} — verification result + receipt id
 */
export function verify(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Find current wave
  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ?
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);
  if (!wave) throw new Error('No waves found');

  const correlationId = mintCorrelationId();
  logStage('verify_start', {
    component: 'dogfood-swarm',
    correlation_id: correlationId,
    runId: opts.runId,
    wave: wave.wave_number,
    adapter: opts.override || 'auto',
  });

  // Run verification
  const result = runVerification(run.local_path, {
    override: opts.override,
    commandOverrides: opts.commandOverrides,
  });

  // ve-p-003: the runtime verdict vocabulary (whatever lib/verify/runner.js's
  // runSteps() can assign — named here rather than enumerated so this
  // comment can't re-drift the way it did when runner.js grew
  // 'unmeasured_tests' as a sixth verdict distinct from 'no_tests') and its
  // `reason` would otherwise flatten to a single passed=0/1 bit at
  // persistence — verification_receipts has no verdict
  // column, so a real FAIL, a no_tests skip, and a no-adapter skip become
  // indistinguishable in the durable record. Until that schema gains a
  // verdict/reason column, fold the disambiguation into the stdout the
  // receipt already stores: a header line carries the verdict + reason so
  // the truth survives in the persisted artifact, not just on the console.
  const verdictHeader = `=== verify verdict: ${result.verdict}${result.reason ? ` — ${result.reason}` : ''} ===`;
  const persistedStdout = [
    verdictHeader,
    ...result.steps.map(s => `=== ${s.name} (${s.passed ? 'PASS' : 'FAIL'}) ===\n${s.stdout}`),
  ].join('\n\n');

  // Persist to verification_receipts
  const receiptResult = db.prepare(`
    INSERT INTO verification_receipts
      (wave_id, repo_type, commands_run, exit_code, stdout, stderr, passed, test_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wave.id,
    result.adapter || 'none',
    JSON.stringify(result.steps.map(s => s.command)),
    result.steps.find(s => !s.passed && !s.optional)?.exit_code ?? 0,
    persistedStdout,
    result.steps.filter(s => s.stderr).map(s => `=== ${s.name} ===\n${s.stderr}`).join('\n\n'),
    result.verdict === 'pass' ? 1 : 0,
    result.test_count,
  );

  // Update wave status to 'verified' if verification passed and wave was
  // 'collected'. Phase 5A: route through transitionWave so the transition
  // lands in wave_state_events with the verify-receipt id in the reason,
  // making the audit trail self-referential to the verification artifact.
  if (result.verdict === 'pass' && wave.status === 'collected') {
    transitionWave(
      db,
      wave.id,
      'verified',
      `verify: receipt #${Number(receiptResult.lastInsertRowid)} verdict=pass (${result.adapter || 'none'})`
    );
  }

  const receiptId = Number(receiptResult.lastInsertRowid);

  logStage('verify_complete', {
    component: 'dogfood-swarm',
    correlation_id: correlationId,
    runId: opts.runId,
    wave: wave.wave_number,
    adapter: result.adapter || 'none',
    verdict: result.verdict,
    reason: result.reason,
    test_count: result.test_count,
    duration_ms: result.duration_ms,
    receiptId,
  });

  return {
    receiptId,
    adapter: result.adapter,
    probe: result.probe,
    verdict: result.verdict,
    // td-p-004 / ve-p-002: forward the adapter's `reason` (and the
    // `no_tests` flag) so the CLI can both EXPLAIN a non-pass verdict to
    // the operator (formatVerify) and gate its exit code on it (cmdVerify).
    // The runner/registry compute these precisely; dropping them here is
    // exactly what left the operator staring at a bare `NO_TESTS` token.
    reason: result.reason,
    no_tests: result.no_tests,
    duration_ms: result.duration_ms,
    test_count: result.test_count,
    steps: result.steps.map(s => ({
      name: s.name,
      command: s.command,
      passed: s.passed,
      exit_code: s.exit_code,
      duration_ms: s.duration_ms,
      optional: s.optional,
    })),
  };
}

/**
 * Probe a repo without running verification.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @returns {Array} — ranked probe results
 */
export function probeRepo(opts) {
  const db = openDb(opts.dbPath);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  return probeAll(run.local_path);
}

/**
 * Format verification result for CLI output.
 */
export function formatVerify(result) {
  const lines = [];

  lines.push(`Verification: ${result.verdict.toUpperCase()}`);
  // ve-p-002 / td-p-004: a non-pass verdict (no_tests, skip, fail) carries a
  // `reason` the adapter/registry constructed precisely — surface it so the
  // operator sees WHY, not just a bare verdict token. Mirrors the
  // `if (result.reason)` print already used by cmdPromote/cmdGate in cli.js.
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  lines.push(`Adapter: ${result.adapter || 'none'}`);
  if (result.probe) {
    lines.push(`Probe: score ${result.probe.score} — ${result.probe.reason}`);
  }
  lines.push(`Duration: ${result.duration_ms}ms`);
  if (result.test_count != null) {
    lines.push(`Tests: ${result.test_count}`);
  }
  lines.push('');

  lines.push('Steps:');
  for (const s of result.steps) {
    const icon = s.passed ? 'PASS' : (s.optional ? 'SKIP' : 'FAIL');
    const opt = s.optional ? ' (optional)' : '';
    lines.push(`  [${icon.padEnd(4)}] ${s.name}${opt} — ${s.command} (${s.duration_ms}ms, exit ${s.exit_code})`);
  }

  return lines.join('\n');
}

/**
 * Format probe results for CLI output.
 */
export function formatProbe(probes) {
  const lines = ['Adapter probes:', ''];
  for (const p of probes) {
    const bar = '#'.repeat(Math.round(p.score / 5));
    lines.push(`  ${p.name.padEnd(8)} ${String(p.score).padStart(3)}/100 ${bar}`);
    lines.push(`           ${p.reason}`);
  }
  return lines.join('\n');
}
