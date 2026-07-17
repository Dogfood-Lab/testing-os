/**
 * verify-runner-max-buffer-env-override.test.js — F-014c22f0: F-3a098ded's
 * `step.maxBufferBytes` override is real and correctly wired into
 * execFileSync's `maxBuffer` — but it is reachable ONLY from a hand-written
 * Node script calling runStep()/runVerification() directly. Grepping the
 * whole package found zero references to `maxBufferBytes` in any adapter,
 * commands/verify.js, or cli.js — `swarm verify` (the actual terminal
 * surface an operator reads an output_exceeded reason from) has no flag for
 * it anywhere on the three-layer path (runStep ← adapter commands(overrides)
 * ← registry.js#runVerification's commandOverrides). The output_exceeded
 * message told that operator to "set step.maxBufferBytes" — advice exactly
 * as unreachable in practice as the pre-F-3a098ded text it replaced.
 *
 * THE FIX. `SWARM_VERIFY_MAX_BUFFER_BYTES` — an environment-variable
 * override, read fresh per call (mirrors log-stage.js#shouldEmitHuman's
 * per-call env read, not a module-load-time constant, so it stays testable
 * within one process) — sits between `step.maxBufferBytes` and the module
 * constant in the same "most-specific-wins" SHAPE `step.timeoutMs` already
 * established: `step.maxBufferBytes ?? env override ?? MAX_BUFFER_BYTES`.
 * `SWARM_VERIFY_MAX_BUFFER_BYTES=<n> swarm verify` now genuinely raises the
 * ceiling for every step in the run from the terminal, with no source edit
 * and no CLI flag needed. The output_exceeded message now names this as the
 * primary, reachable remedy; `step.maxBufferBytes` is still mentioned as the
 * programmatic-caller equivalent (that override itself is unchanged, still
 * real, still honored — this finding is about the message's audience, not
 * about the override's correctness, which verify-runner-max-buffer-
 * override.test.js already proved).
 *
 * A CLI flag on `swarm verify` (cli.js) would be the more DISCOVERABLE half
 * of this fix — `--help` text, tab-completion, no env-var lookup required —
 * but cli.js is out of this domain's owned globs; recorded as a skipped item
 * in this wave's output for a future feature-pass slice.
 *
 * Pinned per this package's gate non-vacuity + "actually honored, not just
 * accepted" convention (mirrors verify-runner-max-buffer-override.test.js):
 *   1. the env override actually lowers/raises the EFFECTIVE ceiling
 *      execFileSync enforces (real subprocess, not a mocked ENOBUFS object).
 *   2. step.maxBufferBytes still wins when BOTH are set — most-specific-wins,
 *      unchanged.
 *   3. the message names the env var as the reachable remedy; a malformed
 *      env value degrades to the module default rather than crashing.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStep } from './verify/runner.js';

const CWD = tmpdir();
const MODULE_DEFAULT = 64 * 1024 * 1024; // mirrors verify/runner.js's MAX_BUFFER_BYTES
const ENV_VAR = 'SWARM_VERIFY_MAX_BUFFER_BYTES';

afterEach(() => {
  delete process.env[ENV_VAR];
});

/**
 * A step that writes exactly `bytes` bytes of 'x' to stdout via a real
 * `node` child process. Mirrors verify-runner-max-buffer-override.test.js's
 * own fixture builder exactly (real subprocess, not a mocked ENOBUFS object
 * — a hand-built error object would only prove the classification
 * arithmetic, not that execFileSync actually received and enforced the
 * override this finding is about).
 */
function bigOutputStep(name, bytes, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-maxbuffer-env-'));
  const emitFile = join(dir, 'emit.cjs').replace(/\\/g, '/');
  writeFileSync(
    emitFile,
    `const chunk = 'x'.repeat(1024 * 1024);\n` +
      `let remaining = ${bytes};\n` +
      `while (remaining > 0) {\n` +
      `  const n = Math.min(remaining, chunk.length);\n` +
      `  process.stdout.write(chunk.slice(0, n));\n` +
      `  remaining -= n;\n` +
      `}\n`,
    'utf-8',
  );
  return { name, cmd: 'node', args: [emitFile], ...extra };
}

describe('runStep — SWARM_VERIFY_MAX_BUFFER_BYTES env override (F-014c22f0)', () => {
  it('the env override LOWERS the effective ceiling — actually honored by execFileSync, not just accepted', () => {
    process.env[ENV_VAR] = String(2 * 1024 * 1024); // 2 MB — far below the 64 MB module default
    const step = bigOutputStep('test', (2 * 1024 * 1024) + (512 * 1024));
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true,
      'a 2.5 MB capture must overflow a 2 MB env ceiling even though it is far under the 64 MB module default');
  });

  it('the env override RAISES the effective ceiling above the module default', () => {
    const override = MODULE_DEFAULT + (8 * 1024 * 1024); // 72 MB
    process.env[ENV_VAR] = String(override);
    const bytes = MODULE_DEFAULT + (4 * 1024 * 1024); // 68 MB — between the default and the override
    const step = bigOutputStep('test', bytes);
    const result = runStep(CWD, step);

    assert.equal(result.passed, true,
      'a 68 MB capture must NOT overflow a 72 MB env ceiling even though it exceeds the 64 MB module default');
    assert.ok(!result.output_exceeded);
  });

  it('without the env var set, an overflow still happens at the 64 MB module default (baseline unchanged)', () => {
    const step = bigOutputStep('test', MODULE_DEFAULT + (5 * 1024 * 1024));
    const result = runStep(CWD, step);
    assert.equal(result.output_exceeded, true);
  });

  it('step.maxBufferBytes still WINS over the env var when both are set — most-specific-wins is unchanged', () => {
    process.env[ENV_VAR] = String(MODULE_DEFAULT + (8 * 1024 * 1024)); // env says 72 MB — would NOT overflow
    const STEP_OVERRIDE = 2 * 1024 * 1024; // step says 2 MB — WOULD overflow
    const step = bigOutputStep('test', STEP_OVERRIDE + (512 * 1024), { maxBufferBytes: STEP_OVERRIDE });
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true,
      'step.maxBufferBytes (2 MB) must win over the env override (72 MB) — the per-step property is more specific than the process-wide env var');
    assert.ok(result.reason.includes(STEP_OVERRIDE.toLocaleString()),
      'the reported effective ceiling must be the step-level value, not the env value');
  });

  it('without any override, the message names SWARM_VERIFY_MAX_BUFFER_BYTES as the reachable remedy', () => {
    const step = bigOutputStep('test', MODULE_DEFAULT + (5 * 1024 * 1024));
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true);
    assert.match(result.reason, /SWARM_VERIFY_MAX_BUFFER_BYTES/,
      'the message must point at a remedy an operator can actually set from the terminal before running `swarm verify`');
  });

  it('a malformed env value (non-numeric) degrades to the module default rather than crashing', () => {
    process.env[ENV_VAR] = 'not-a-number';
    const step = bigOutputStep('test', MODULE_DEFAULT + (5 * 1024 * 1024));
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true, 'must still overflow at the module default, not throw or silently pass');
    assert.ok(result.reason.includes(MODULE_DEFAULT.toLocaleString()),
      'a malformed env value must not corrupt the reported ceiling — falls back to the real module default');
  });

  it('a non-positive env value (0 or negative) degrades to the module default rather than producing an unusable ceiling', () => {
    process.env[ENV_VAR] = '0';
    const step = bigOutputStep('test', MODULE_DEFAULT + (5 * 1024 * 1024));
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true);
    assert.ok(result.reason.includes(MODULE_DEFAULT.toLocaleString()),
      'a non-positive override must not be honored as the effective ceiling — execFileSync requires a positive maxBuffer');
  });
});
