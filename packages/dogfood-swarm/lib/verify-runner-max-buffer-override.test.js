/**
 * verify-runner-max-buffer-override.test.js — F-3a098ded: the F-8d355b64
 * output_exceeded message told the operator to "raise MAX_BUFFER_BYTES or
 * reduce step output" — but MAX_BUFFER_BYTES was a hardcoded module-level
 * constant with NO configuration surface anywhere. The sibling `timeoutMs`
 * DOES have a real, documented per-step override (`step.timeoutMs ??
 * STEP_TIMEOUT_MS`); no equivalent `step.maxBufferBytes ?? MAX_BUFFER_BYTES`
 * existed, so the FIRST of the message's two remedies was not something any
 * caller could actually do — the only way to "raise MAX_BUFFER_BYTES" was to
 * edit runner.js's source and republish.
 *
 * THE FIX. `step.maxBufferBytes` mirrors `step.timeoutMs`'s override pattern
 * exactly — an optional per-step property threaded straight into
 * execFileSync's `maxBuffer` option — and the output_exceeded message now
 * names the real, reachable remedy (`step.maxBufferBytes`) instead of the
 * module constant, using the EFFECTIVE ceiling for THIS step in the byte
 * count it reports.
 *
 * Two independent properties, each pinned in both directions per this
 * package's gate non-vacuity convention:
 *   1. the override is actually HONORED by execFileSync (not just accepted
 *      and ignored) — both lowering and raising the effective ceiling.
 *   2. the message names the real remedy and reports the EFFECTIVE ceiling,
 *      not the stale unreachable constant.
 *
 * WHY REAL SUBPROCESSES, NOT MOCKS. Mirrors this package's own precedent
 * (verify-runner-output-exceeded.test.js, verify-runner-measure-before-
 * truncate.test.js) — a hand-built `{code:'ENOBUFS'}` object would only prove
 * the classification arithmetic, not that execFileSync actually received and
 * enforced the override this finding says was missing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStep } from './verify/runner.js';

const CWD = tmpdir();
const MODULE_DEFAULT = 64 * 1024 * 1024; // mirrors verify/runner.js's MAX_BUFFER_BYTES

/**
 * A step that writes exactly `bytes` bytes of 'x' to stdout via a real
 * `node` child process (not an inline `-e` arg — the payload is large enough
 * to blow a command-line length limit).
 */
function bigOutputStep(name, bytes, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-maxbuffer-'));
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

describe('runStep — step.maxBufferBytes override surface (F-3a098ded)', () => {
  it('a step-level maxBufferBytes LOWERS the effective ceiling — the override is actually honored, not just accepted', () => {
    const OVERRIDE = 2 * 1024 * 1024; // 2 MB — far below the 64 MB module default
    const step = bigOutputStep('test', OVERRIDE + (512 * 1024), { maxBufferBytes: OVERRIDE });
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true,
      'a 2.5 MB capture must overflow a 2 MB override even though it is far under the 64 MB module default — ' +
      'proves execFileSync actually received the override, not the constant');
  });

  it('a step-level maxBufferBytes RAISES the effective ceiling above the module default', () => {
    const OVERRIDE = MODULE_DEFAULT + (8 * 1024 * 1024); // 72 MB
    const bytes = MODULE_DEFAULT + (4 * 1024 * 1024); // 68 MB — between the default and the override
    const step = bigOutputStep('test', bytes, { maxBufferBytes: OVERRIDE });
    const result = runStep(CWD, step);

    assert.equal(result.passed, true,
      'a 68 MB capture must NOT overflow a 72 MB override even though it exceeds the 64 MB module default — ' +
      'proves the override actually raises the ceiling execFileSync enforces, not just the message text');
    // The success path omits output_exceeded entirely (undefined), rather
    // than setting it false — matching runStep's existing success-branch
    // shape (only the catch branch sets timed_out/output_exceeded keys).
    assert.ok(!result.output_exceeded);
  });

  it('without an override, an overflow still happens at the 64 MB module default (baseline unchanged)', () => {
    const step = bigOutputStep('test', MODULE_DEFAULT + (5 * 1024 * 1024));
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true);
  });

  it('without an override, the message names the real remedy (step.maxBufferBytes) instead of the unreachable "raise MAX_BUFFER_BYTES"', () => {
    const step = bigOutputStep('test', MODULE_DEFAULT + (5 * 1024 * 1024));
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true);
    assert.match(result.reason, /step\.maxBufferBytes/,
      'the message must point at the actual override surface a caller can set — mirrors the timeoutMs message pattern');
    assert.doesNotMatch(result.reason, /raise MAX_BUFFER_BYTES/,
      'the old clause told the operator to edit a module constant with no configuration surface (F-3a098ded)');
  });

  it('with an override in effect, the message cites the EFFECTIVE ceiling actually used, not the stale 64 MB module constant', () => {
    const OVERRIDE = 2 * 1024 * 1024; // 2 MB
    const step = bigOutputStep('test', OVERRIDE + (512 * 1024), { maxBufferBytes: OVERRIDE });
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true);
    assert.ok(result.reason.includes(OVERRIDE.toLocaleString()),
      `the byte count in the message must reflect the step-level override actually in effect (${OVERRIDE.toLocaleString()}), ` +
      `not the 64 MB module default — got: ${result.reason}`);
    assert.ok(!result.reason.includes(MODULE_DEFAULT.toLocaleString()),
      'the message must not cite the stale module-default byte count when a step-level override was in effect');
  });

  it('maxBufferBytes does not interfere with the sibling timeoutMs override — both can be set independently', () => {
    const OVERRIDE = 2 * 1024 * 1024;
    const step = bigOutputStep('test', OVERRIDE + (512 * 1024), { maxBufferBytes: OVERRIDE, timeoutMs: 10_000 });
    const result = runStep(CWD, step);

    assert.equal(result.output_exceeded, true);
    assert.equal(result.timed_out, false, 'an output-overflow must still be excluded from timed_out even with a custom timeoutMs in play');
  });
});
