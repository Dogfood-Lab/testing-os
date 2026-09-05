/**
 * `SWARM_VERIFY_STEP_TIMEOUT_MS` — an environment-variable override for the
 * per-step timeout, the same shape as `SWARM_VERIFY_MAX_BUFFER_BYTES`
 * (verify-runner-max-buffer-env-override.test.js).
 *
 * Earned 2026-09-05 on the armature run (swarm-1788481819-3690, wave 20): the
 * repo's suite grew past 5,600 tests and its full run took 384 s, so the 300 s
 * module default recorded receipt #291 as FAIL — "step `test` timed out after
 * 300000ms" — for a suite whose direct run had just passed 5684 / 64 / 0. No CLI
 * flag existed; the only remedy was a source edit. A process-wide env override
 * is the smallest fix that keeps the default and the per-step property intact.
 *
 * Pinned per this package's "actually honored, not just accepted" convention:
 *   1. the env override actually LOWERS the effective timeout execFileSync
 *      enforces (a real sleeping subprocess, not a mocked timeout object).
 *   2. step.timeoutMs still wins when BOTH are set — most-specific-wins.
 *   3. a malformed or non-positive env value degrades to the module default
 *      rather than crashing or producing a zero timeout.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStep } from './verify/runner.js';

const CWD = tmpdir();
const ENV_VAR = 'SWARM_VERIFY_STEP_TIMEOUT_MS';

afterEach(() => {
  delete process.env[ENV_VAR];
});

/** A step that sleeps `ms` in a real `node` child process, then exits 0. */
function sleepingStep(name, ms, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-step-timeout-env-'));
  const sleepFile = join(dir, 'sleep.cjs').replace(/\\/g, '/');
  writeFileSync(sleepFile, `setTimeout(() => process.exit(0), ${ms});\n`, 'utf-8');
  return { name, cmd: 'node', args: [sleepFile], ...extra };
}

describe('runStep — SWARM_VERIFY_STEP_TIMEOUT_MS env override', () => {
  it('the env override LOWERS the effective timeout — actually enforced on a real sleeping subprocess', () => {
    process.env[ENV_VAR] = '400';
    const result = runStep(CWD, sleepingStep('test', 3000));

    assert.equal(result.timed_out, true, 'a 3 s sleep under a 400 ms override must time out');
    assert.match(result.reason, /timed out after 400ms/, 'the reported timeout must be the override, not the module default');
  });

  it('step.timeoutMs still WINS over the env var when both are set — most-specific-wins is unchanged', () => {
    process.env[ENV_VAR] = '400';
    const result = runStep(CWD, sleepingStep('test', 3000, { timeoutMs: 5000 }));

    assert.ok(!result.timed_out, 'the per-step 5 s timeout must govern, not the 400 ms env override');
    assert.equal(result.passed, true);
  });

  it('a malformed env value (non-numeric) degrades to the module default rather than crashing or timing out at once', () => {
    process.env[ENV_VAR] = 'not-a-number';
    const result = runStep(CWD, sleepingStep('test', 300));

    assert.ok(!result.timed_out, 'a malformed override must fall back to the 300 s default, under which a 300 ms sleep passes');
    assert.equal(result.passed, true);
  });

  it('a non-positive env value (0) degrades to the module default rather than producing a zero timeout', () => {
    process.env[ENV_VAR] = '0';
    const result = runStep(CWD, sleepingStep('test', 300));

    assert.ok(!result.timed_out);
    assert.equal(result.passed, true);
  });
});
