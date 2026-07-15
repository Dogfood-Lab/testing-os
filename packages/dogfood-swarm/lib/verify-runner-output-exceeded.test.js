/**
 * verify-runner-output-exceeded.test.js — F-8d355b64: a maxBuffer overflow
 * must never be reported as a timeout.
 *
 * THE BUG. execFileSync's default stdout/stderr capture ceiling (Node's own
 * ~1 MiB) throws when exceeded with `e.code === 'ENOBUFS'` — and, empirically
 * confirmed on this rig (Node v22.22.3), `e.signal === 'SIGTERM'`
 * UNCONDITIONALLY, even though the child ran for milliseconds. runStep's
 * pre-fix `timedOut` check was `e.signal === 'SIGTERM' || e.killed === true
 * || duration_ms >= timeoutMs - 50` — the first clause fires on ANY overflow
 * regardless of duration_ms, so an instant capture overflow was reported as
 * `step \`test\` timed out after 300000ms`: a categorically false diagnosis
 * that sends an operator toward raising timeoutMs, which does nothing for an
 * output-size overflow.
 *
 * THE FIX. (1) MAX_BUFFER_BYTES raises execFileSync's maxBuffer from Node's
 * ~1 MiB default to 64 MB, reducing how often the overflow is reachable at
 * all — this repo's own `npm test` output was already at ~86% of the old
 * default when ve-trunc-001 measured it. (2) `e.code === 'ENOBUFS'` is
 * detected explicitly as `outputExceeded` BEFORE `timedOut` is computed, and
 * excluded from the timedOut OR-chain, so the shared SIGTERM cannot be
 * folded into a false timeout. Both changes are independent: (1) narrows
 * when the bug in (2) is reachable but does not fix it — a large enough
 * capture can still exceed any finite ceiling, so (2) is what actually
 * corrects the diagnosis.
 *
 * WHY THE FIXTURE IS ~70 MB, NOT A MOCK. CLAUDE.md rule #6 (real fixtures,
 * not mocks) plus this package's own precedent
 * (verify-runner-measure-before-truncate.test.js spawns a real subprocess
 * rather than fabricating an error object) — a hand-built `{code:'ENOBUFS'}`
 * object would only prove the classification arithmetic, not that Node
 * actually throws this shape for this scenario. The fixture must exceed
 * MAX_BUFFER_BYTES (64 MB) or it proves nothing, mirroring the sibling
 * file's "fixtures must exceed the bound" discipline. Measured locally: a
 * 70 MB overflow throws in ~300ms, so this stays a fast test.
 *
 * WHY THIS FILE LIVES FLAT IN lib/, NOT lib/verify/. package.json's test
 * script is `node --test "*.test.js" "lib/*.test.js"` — non-recursive, so a
 * file at lib/verify/*.test.js would be silently undiscovered (confirmed:
 * zero lib/**\/*.test.js files exist below one level of nesting anywhere in
 * this package today). wave2-4091637-5127-swarm-cp-pins.test.js documents
 * the sibling problem for commands/**\ tests (forced to package root, out of
 * that wave's domain, with an explicit cross_domain_notes entry). This file
 * avoids that entirely by staying flat in lib/ — inside this domain's owned
 * glob (packages/dogfood-swarm/lib/**\) AND inside the discovery glob
 * (lib/*.test.js), so no cross-domain note is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStep, runSteps } from './verify/runner.js';

const CWD = tmpdir();
const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // mirrors verify/runner.js

/**
 * A step that writes `bytes` bytes of 'x' to stdout via a real `node` child
 * process (not an inline `-e` arg — the payload is large enough to blow a
 * command-line length limit, same reasoning as the sibling file's echoStep).
 */
function bigOutputStep(name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-overflow-'));
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
  return { name, cmd: 'node', args: [emitFile] };
}

/** A step that sleeps `ms` before exiting — used to force a GENUINE timeout. */
function sleepStep(name, ms) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-sleep-'));
  const emitFile = join(dir, 'sleep.cjs').replace(/\\/g, '/');
  writeFileSync(emitFile, `setTimeout(() => process.stdout.write('done\\n'), ${ms});`, 'utf-8');
  return { name, cmd: 'node', args: [emitFile] };
}

describe('runStep — output-exceeded is distinguished from timed-out (F-8d355b64)', () => {
  it('a capture overflow past MAX_BUFFER_BYTES is reported as output_exceeded, NOT timed_out', () => {
    const step = bigOutputStep('test', MAX_BUFFER_BYTES + (5 * 1024 * 1024)); // 5 MB past the ceiling
    const result = runStep(CWD, step);

    assert.equal(result.passed, false, 'an overflowed capture is a failed step');
    assert.equal(result.output_exceeded, true, 'must be classified as output_exceeded');
    assert.equal(result.timed_out, false, 'must NOT be classified as timed_out — this is the F-8d355b64 defect');
    assert.ok(
      result.duration_ms < 10_000,
      `an overflow is a fast failure (measured ${result.duration_ms}ms) — anywhere near STEP_TIMEOUT_MS would mean this fixture accidentally exercised a different path`,
    );
    assert.match(
      result.reason,
      /output exceeded/i,
      'the reason must name the real cause, not claim a timeout',
    );
    assert.doesNotMatch(
      result.reason,
      /timed out/i,
      'the reason must never say "timed out" for a capture overflow — that sends an operator toward raising timeoutMs, which does nothing here',
    );
  });

  it('a genuine timeout (short timeoutMs, slow child) is still reported as timed_out, NOT output_exceeded', () => {
    const step = { ...sleepStep('test', 3000), timeoutMs: 200 };
    const result = runStep(CWD, step);

    assert.equal(result.passed, false);
    assert.equal(result.timed_out, true, 'a real hang must still be classified as timed_out — the F-8d355b64 fix must not have broken this');
    assert.equal(result.output_exceeded, false, 'a real hang never sets e.code === ENOBUFS');
    assert.match(result.reason, /timed out after 200ms/);
  });

  it('an ordinary small failure is neither timed_out nor output_exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-fail-'));
    const emitFile = join(dir, 'fail.cjs').replace(/\\/g, '/');
    writeFileSync(emitFile, `process.stdout.write('boom\\n'); process.exit(1);`, 'utf-8');

    const result = runStep(CWD, { name: 'test', cmd: 'node', args: [emitFile] });

    assert.equal(result.passed, false);
    assert.equal(result.timed_out, false);
    assert.equal(result.output_exceeded, false);
    assert.equal(result.reason, undefined, 'an ordinary failure needs no instrument-level reason — exit_code/stdout already explain it');
  });
});

describe('runSteps — output_exceeded aggregates correctly and wins the wave-level reason', () => {
  it('a required step that overflows fails the wave with an output_exceeded reason, not a timed-out one', () => {
    const step = bigOutputStep('build', MAX_BUFFER_BYTES + (5 * 1024 * 1024));
    const res = runSteps(CWD, [step]);

    assert.equal(res.verdict, 'fail');
    assert.equal(res.output_exceeded, true, 'the run-level aggregate must surface the overflow');
    assert.equal(res.timed_out, false);
    assert.match(res.reason, /output exceeded/i);
    assert.doesNotMatch(res.reason, /timed out/i);
  });
});
