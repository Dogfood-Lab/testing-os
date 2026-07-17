/**
 * verify-runner-max-buffer-env-warning.test.js — F-80beae0e:
 * readEnvMaxBufferBytes() (F-014c22f0) could not distinguish "the operator
 * never set SWARM_VERIFY_MAX_BUFFER_BYTES" from "the operator set it, but
 * the value doesn't parse" — both `!raw` (unset/empty) and an invalid parse
 * (`!Number.isFinite(n) || n <= 0`) returned the same bare `null`, silently
 * falling back to the module default with zero feedback either way. The one
 * confirmed misconfiguration an operator could actually hit:
 * `Number('100_000_000')` — JS source-level numeric-separator syntax, a
 * reasonable guess for a JS-literate operator — is NaN, since Number() does
 * not support underscore separators. Because output_exceeded's message
 * always reads "set SWARM_VERIFY_MAX_BUFFER_BYTES above N" regardless of
 * which case produced the fallback, an operator who DID set the var (with a
 * typo or an unsupported format) saw the identical advice as one who never
 * set it at all — no signal that their existing setting was ignored.
 *
 * THE FIX. The two null cases now diverge in OBSERVABILITY, not in the
 * returned value (falling back to the module default is still correct for
 * both): unset stays completely silent (the ordinary, overwhelmingly common
 * case), while SET-but-unparseable logs one structured `logStage` warning —
 * the same NDJSON-on-stderr channel every other diagnostic in this package
 * uses — naming the env var and the raw value that failed to parse.
 *
 * PROOF METHOD. readEnvMaxBufferBytes is module-private by design (every
 * caller of the effective maxBuffer value goes through runStep). Proven
 * through the public runStep surface with a trivial, fast, always-passing
 * step — readEnvMaxBufferBytes runs unconditionally at the top of runStep,
 * before the pass/fail branch, so no large-output overflow fixture is
 * needed here (verify-runner-max-buffer-env-override.test.js already proves
 * the override is honored by a real subprocess; this file is only about the
 * diagnostic, not the ceiling arithmetic). Stderr capture mirrors
 * ds-proac-03-collect-lifecycle.test.js's own captureStderrLines +
 * ndjsonEvents helpers exactly, forcing DOGFOOD_LOG_HUMAN=0 so the
 * human-readable companion banner doesn't interfere with NDJSON parsing.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runStep } from './verify/runner.js';

const ENV_VAR = 'SWARM_VERIFY_MAX_BUFFER_BYTES';
// Inner quotes required: shell:true joins cmd+args into one string, so an
// unquoted `(` is a /bin/sh subshell metachar (POSIX-fatal, cmd.exe-tolerant).
const TRIVIAL_STEP = { name: 'test', cmd: 'node', args: ['-e', '"console.log(1)"'] };

afterEach(() => {
  delete process.env[ENV_VAR];
});

/** Mirrors ds-proac-03-collect-lifecycle.test.js's captureStderrLines exactly. */
function captureStderrLines(fn) {
  const prev = process.env.DOGFOOD_LOG_HUMAN;
  process.env.DOGFOOD_LOG_HUMAN = '0';
  const orig = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  let result;
  try { result = fn(); } finally {
    console.error = orig;
    if (prev === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
    else process.env.DOGFOOD_LOG_HUMAN = prev;
  }
  return { result, lines };
}

/** Mirrors ds-proac-03-collect-lifecycle.test.js's ndjsonEvents exactly. */
function ndjsonEvents(lines) {
  const out = [];
  for (const ln of lines) {
    if (!ln.startsWith('{')) continue;
    try { const obj = JSON.parse(ln); if (obj && obj.stage) out.push(obj); } catch { /* */ }
  }
  return out;
}

describe('readEnvMaxBufferBytes (via runStep) — malformed vs unset are now distinguishable in observability (F-80beae0e)', () => {
  it('unset: produces NO verify_max_buffer_env_malformed diagnostic at all', () => {
    delete process.env[ENV_VAR];
    const { lines } = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 0, 'the ordinary unset case must stay completely silent — no change from pre-fix behavior');
  });

  it("SET but non-numeric ('not-a-number'): logs a structured warning naming the var and the raw value", () => {
    process.env[ENV_VAR] = 'not-a-number';
    const { lines } = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 1, 'a SET-but-unparseable value must be reported exactly once');
    assert.equal(malformedEvents[0].env_var, ENV_VAR);
    assert.equal(malformedEvents[0].raw_value, 'not-a-number', 'the malformed value itself must be visible, not just "something was wrong"');
  });

  it("SET using JS numeric-separator syntax ('100_000_000') — the exact operator-typo scenario the finding proved is reachable — logs the warning", () => {
    process.env[ENV_VAR] = '100_000_000';
    const { lines } = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 1,
      "Number('100_000_000') is NaN (no underscore-separator support) — this must no longer be silently indistinguishable from unset");
    assert.equal(malformedEvents[0].raw_value, '100_000_000');
  });

  it("SET but non-positive ('0'): logs the warning too — non-positive is malformed input, not a legitimate zero override", () => {
    process.env[ENV_VAR] = '0';
    const { lines } = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 1);
    assert.equal(malformedEvents[0].raw_value, '0');
  });

  it('SET and VALID: no warning is logged — the diagnostic must not spam a correctly-configured operator', () => {
    process.env[ENV_VAR] = '2000000';
    const { lines } = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 0, 'a well-formed override must never be reported as malformed');
  });

  it('the same test process distinguishes unset from malformed across consecutive calls — per-call env read, not cached', () => {
    delete process.env[ENV_VAR];
    const first = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    assert.equal(ndjsonEvents(first.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed').length, 0);

    process.env[ENV_VAR] = 'garbage';
    const second = captureStderrLines(() => runStep(process.cwd(), TRIVIAL_STEP));
    assert.equal(ndjsonEvents(second.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed').length, 1,
      'the SAME process must pick up the newly-set malformed value on the very next call — confirms the env is read fresh per call, not memoized from the first (unset) call');
  });
});
