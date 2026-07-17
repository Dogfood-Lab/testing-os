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
import { escapeReasonForDisplay } from './lib/escape-reason.js';

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
 * F-59f22202: sentinel persisted to verification_receipts.exit_code when the
 * wave verdict is non-'pass' but no REQUIRED step failed — no_tests,
 * unmeasured_tests, or a future verdict shaped the same way (a test step
 * that genuinely ran and returned 0, with no positive evidence the runner
 * could count). lib/verify/runner.js guarantees a failing required step
 * always carries a real exit code (a genuine nonzero, or -127 for
 * tool_missing — see runStep's catch branch), so this value can never
 * collide with a real step's exit code. verification_receipts.exit_code is
 * `INTEGER NOT NULL` (db/schema.js), so NULL is not an option; -127 already
 * means "tool not found" in this vocabulary, so -1 is the free, conventional
 * "not applicable" slot. Mirrors runner.js's own sentinel-exit-code
 * discipline one layer up.
 */
const NO_FAILING_STEP_EXIT_CODE = -1;

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

  // F-59f22202: exit_code was derived purely from per-step pass/fail via
  // `.find(...)?.exit_code ?? 0`. That default was silently wrong whenever
  // EVERY step exited 0 (nothing to .find()) but the wave verdict was still
  // non-'pass' (no_tests / unmeasured_tests) — the receipt then persisted
  // the self-contradictory pair exit_code=0 / passed=0, which
  // commands/receipt.js's PASS/FAIL rendering displays as e.g.
  // "FAIL (node, exit 0)" — reads as a rendering bug (exit 0 conventionally
  // means success) rather than the real signal (zero tests were measured).
  // A genuine pass keeps exit_code=0 (a required step actually returned
  // success); a real failing step is unaffected (`.find()` still finds it,
  // its own real/sentinel exit code wins, same as before).
  const persistedExitCode =
    result.steps.find(s => !s.passed && !s.optional)?.exit_code
    ?? (result.verdict === 'pass' ? 0 : NO_FAILING_STEP_EXIT_CODE);

  // Persist to verification_receipts
  const receiptResult = db.prepare(`
    INSERT INTO verification_receipts
      (wave_id, repo_type, commands_run, exit_code, stdout, stderr, passed, test_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wave.id,
    result.adapter || 'none',
    JSON.stringify(result.steps.map(s => s.command)),
    persistedExitCode,
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
    // F-1997e7c8: forward the run-level output_exceeded/timed_out aggregates
    // (lib/verify/runner.js's runSteps()) the same way reason/no_tests are
    // forwarded above — registry.js's runVerification() already spreads
    // `...result` unchanged, so this file was the SOLE point in the chain
    // dropping them. `reason` already carries the disambiguated text for the
    // human-readable path (cmdVerify), but a --format=json caller or any
    // other structured consumer had no machine-readable way to distinguish
    // an output-overflow failure from an ordinary one without string-parsing
    // `reason`.
    output_exceeded: result.output_exceeded,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
    test_count: result.test_count,
    steps: result.steps.map(s => ({
      name: s.name,
      command: s.command,
      passed: s.passed,
      exit_code: s.exit_code,
      duration_ms: s.duration_ms,
      optional: s.optional,
      // F-1997e7c8: per-step classification flags (lib/verify/runner.js's
      // runStep() sets these in its catch branch; a passing step leaves them
      // undefined, which is the correct "not applicable" shape). Dropped
      // here pre-fix alongside the run-level aggregates above.
      timed_out: s.timed_out,
      output_exceeded: s.output_exceeded,
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
  //
  // F-4773fb77 (wave 20): deliberately NOT escaped, unlike result.probe.reason
  // below. result.reason is runner.js's own runSteps()/adapters' run() output
  // — every value it can take is a fixed template string interpolating only
  // internal literals (step names, step.cmd — both hardcoded per-adapter, never
  // target-repo content — see lib/verify/runner.js's own SECURITY comment),
  // counts, durations, and byte sizes. It never embeds target-repo manifest
  // content the way probe.reason does (verified by reading every runSteps()
  // and adapter run() branch that assigns `reason`). Escaping it anyway would
  // suggest a trust distinction that does not exist and would misdirect a
  // future reader auditing this file's escaping discipline.
  //
  // F-26adaf33 (LOW, wave 22): this same result.reason value has a SECOND,
  // independent render site — cli.js's non-pass exit path
  // (`swarm verify: ${result.verdict.toUpperCase()} — ${why}`, where `why`
  // falls back to result.reason) — which carries a mirrored comment citing
  // this one. If the safety argument above ever stops holding (e.g. a
  // future runner.js change starts interpolating real content into
  // `reason`), both render sites need to be checked, not just this one.
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  lines.push(`Adapter: ${result.adapter || 'none'}`);
  if (result.probe) {
    // F-4773fb77 (wave 20): result.probe.reason, unlike result.reason above,
    // is a ZERO-PRIVILEGE trust boundary — it embeds the AUDITED TARGET
    // REPO's own manifest content verbatim (node.js's probe() reads
    // package.json's `name` via plain JSON.parse with no character
    // restriction; rust.js's probe() extracts Cargo.toml's `name` via a
    // regex whose `[^"]` class matches raw newlines and ANSI bytes alike).
    // Reachable by simply being the repo `swarm verify` audits — no
    // operator --reason flag involved anywhere in this package. Neither
    // `swarm verify` nor `swarm verify --probe-only` supports
    // `--format=json`, so this text render is the ONLY surface this value
    // reaches; there is no lossless escape hatch to fall back on the way
    // there is for every other reason-render site in this package.
    lines.push(`Probe: score ${result.probe.score} — ${escapeReasonForDisplay(result.probe.reason)}`);
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
    // F-d231b91e: p.score is the untrusted adapter-contract return (lib/
    // verify/registry.js's own JSDoc promises `probe(repoPath) -> { score:
    // 0-100, ... }`, but nothing validates it before it reaches here). Left
    // unclamped: a negative score crashes '#'.repeat with an uncaught
    // RangeError (Math.round(-10/5) = -2, and String.prototype.repeat
    // throws on a negative count) — taking down the whole `swarm verify
    // --probe-only` invocation instead of rendering one degraded-but-visible
    // row; a >100 score renders a bar longer than the printed "/100" scale
    // promises (score=200 -> a 40-character bar, twice the 20-character
    // max). Clamp ONLY the bar's input to [0, 100] and fall back to 0 for a
    // non-finite score (NaN) — the printed score label keeps the RAW,
    // unclamped `p.score` so an out-of-contract adapter value stays visible
    // to the operator instead of being silently normalized away.
    const clampedScore = Math.max(0, Math.min(100, Number.isFinite(p.score) ? p.score : 0));
    const bar = '#'.repeat(Math.round(clampedScore / 5));
    lines.push(`  ${p.name.padEnd(8)} ${String(p.score).padStart(3)}/100 ${bar}`);
    // F-4773fb77 (wave 20): p.reason is the same untrusted, target-repo-derived
    // value as formatVerify's result.probe.reason above (probeAll() in
    // lib/verify/registry.js spreads each adapter's own probe() return
    // directly — `{ name, ...probe }` — so p.reason IS probe.reason, reached
    // here via `swarm verify --probe-only` instead of the default invocation).
    // Same zero-privilege trust boundary, same fix.
    lines.push(`           ${escapeReasonForDisplay(p.reason)}`);
  }
  return lines.join('\n');
}
