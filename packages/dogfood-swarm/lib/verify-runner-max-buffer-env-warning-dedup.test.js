/**
 * verify-runner-max-buffer-env-warning-dedup.test.js — F-d6cfc2ad:
 * F-80beae0e's `verify_max_buffer_env_malformed` diagnostic
 * (readEnvMaxBufferBytes, lib/verify/runner.js) is correct in VALUE — the
 * fallback to the module default is right whether the env var is unset or
 * set-but-unparseable — but it is a per-CALL side effect, and
 * readEnvMaxBufferBytes runs once per runStep() call with no memoization
 * (`step.maxBufferBytes ?? readEnvMaxBufferBytes() ?? MAX_BUFFER_BYTES`,
 * runner.js:167 — deliberately fresh per call, per that function's own
 * "read fresh on every call" contract). runSteps() calls runStep() once per
 * step in a plain `for` loop with no dedup around the warning, so an N-step
 * `swarm verify` run with ONE process-wide misconfigured value emitted N
 * byte-identical NDJSON `verify_max_buffer_env_malformed` lines — one per
 * step — even though the misconfiguration is a single fact an operator only
 * needs to see once. This repo's own real `npm run verify` chain has more
 * distinct steps still, so the spam scales with pipeline size.
 *
 * Rated LOW: pure log-noise, not a functional or security defect — the
 * fallback VALUE is identical and correct in both the unset and malformed
 * cases regardless of how many times the warning fires, and no information
 * is lost or misrepresented (every emitted line is identical and accurate).
 *
 * THE FIX. readEnvMaxBufferBytes now caches the malformed RAW VALUE in a
 * module-level Set (warnedMalformedMaxBufferValues) and only logs on that
 * value's first observation — the env is still read fresh every call (the
 * existing verify-runner-max-buffer-env-warning.test.js "picks up a newly
 * set value on the very next call" pin still holds unmodified), only the
 * LOG is gated on whether that exact raw string was already warned about.
 *
 * PROOF METHOD. Exercises runSteps() (not just runStep(), which the sibling
 * file already covers) with a 3-step lint/build/test-shaped pipeline of
 * trivial always-passing commands, mirroring the finding's own
 * reproduction. Stderr capture mirrors the sibling file's own
 * captureStderrLines + ndjsonEvents helpers exactly (itself mirroring
 * ds-proac-03-collect-lifecycle.test.js), forcing DOGFOOD_LOG_HUMAN=0 so the
 * human-readable companion banner doesn't interfere with NDJSON parsing.
 * Raw env values used in this file are distinct from every value the
 * sibling file (verify-runner-max-buffer-env-warning.test.js) uses, and
 * distinct across this file's own tests too — node's test runner isolates
 * EACH TEST FILE in its own process by default, but `it()` blocks WITHIN one
 * file share the same module instance, so the dedup Set persists across
 * them; reusing a raw value across tests would make a later test's
 * "must warn" assertion fail on stale state from an earlier one, not on a
 * defect in the fix.
 *
 * FOLLOW-UP — F-d535bde5. The paragraph above ("the dedup Set persists
 * across [it() blocks]") described a module-level Set with process-lifetime
 * scope, correct for the one-shot `swarm verify` CLI but not for
 * `lib/verify/runner.js`'s other supported entry point: the package's
 * `"./lib/*"` export, which lets a long-running host embed runStep/runSteps
 * across many independent calls in one process. There, module-lifetime dedup
 * meant a persistently-misconfigured tenant was warned about ONCE, EVER, not
 * once per verify batch. The fix scopes runSteps()'s dedup to its OWN
 * invocation (a fresh Set threaded into every runStep() call within that one
 * runSteps() loop) rather than the module-level default — see the new
 * describe block below. The tests ABOVE this point are unaffected: within a
 * single runSteps() call the dedup still collapses repeats across all of
 * that call's steps exactly as before, and two DIFFERENT raw values across
 * two separate runSteps() calls always warned independently regardless of
 * scope. What changes is the SAME raw value across two SEPARATE runSteps()
 * calls: pre-fix, silent on the second call (module-level Set); post-fix,
 * warns again (fresh per-invocation Set) — proven below.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runSteps, runStep } from './verify/runner.js';

const ENV_VAR = 'SWARM_VERIFY_MAX_BUFFER_BYTES';
const trivialStep = (name) => ({ name, cmd: 'node', args: ['-e', 'console.log(1)'] });
const THREE_STEP_PIPELINE = [trivialStep('lint'), trivialStep('build'), trivialStep('test')];

afterEach(() => {
  delete process.env[ENV_VAR];
});

/** Mirrors verify-runner-max-buffer-env-warning.test.js's captureStderrLines exactly. */
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

/** Mirrors verify-runner-max-buffer-env-warning.test.js's ndjsonEvents exactly. */
function ndjsonEvents(lines) {
  const out = [];
  for (const ln of lines) {
    if (!ln.startsWith('{')) continue;
    try { const obj = JSON.parse(ln); if (obj && obj.stage) out.push(obj); } catch { /* */ }
  }
  return out;
}

describe('readEnvMaxBufferBytes (via runSteps) — the malformed-value warning is deduplicated per raw value, not emitted once per step (F-d6cfc2ad)', () => {
  it('a 3-step runSteps() pipeline with the SAME malformed value across every step logs the diagnostic exactly once', () => {
    process.env[ENV_VAR] = 'triple-step-not-a-number';
    const { result, lines } = captureStderrLines(() => runSteps(process.cwd(), THREE_STEP_PIPELINE));

    // Non-vacuity: the pipeline must have genuinely run all 3 steps — a
    // dedup bug that happened to also break the loop early (e.g. an
    // accidental `break`/`return`) would ALSO show "1 warning" for the
    // wrong reason.
    assert.equal(result.steps.length, 3, 'all 3 steps must actually run — the dedup must not be achieved by short-circuiting the pipeline');
    assert.ok(result.steps.every((s) => s.passed), 'fixture sanity: every trivial step must pass');

    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 1,
      'a 3-step run with ONE process-wide malformed value must log the diagnostic exactly once, not once per step');
    assert.equal(malformedEvents[0].raw_value, 'triple-step-not-a-number');
    assert.equal(malformedEvents[0].env_var, ENV_VAR);
  });

  it('a DIFFERENT malformed value in a later runSteps() call within the same process still gets its own warning — dedup is per-VALUE, not a permanent process-wide silence', () => {
    process.env[ENV_VAR] = 'first-distinct-bad-value';
    const first = captureStderrLines(() => runSteps(process.cwd(), THREE_STEP_PIPELINE));
    assert.equal(
      ndjsonEvents(first.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed').length, 1,
      'fixture sanity: the first value must warn once across its own 3-step run',
    );

    process.env[ENV_VAR] = 'second-distinct-bad-value';
    const second = captureStderrLines(() => runSteps(process.cwd(), THREE_STEP_PIPELINE));
    const secondEvents = ndjsonEvents(second.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(secondEvents.length, 1,
      'a genuinely NEW raw value must still be reported — the dedup Set must be keyed by value, not a single ever-warned flag');
    assert.equal(secondEvents[0].raw_value, 'second-distinct-bad-value');
  });

  it('BASELINE: an unset env var across a 3-step runSteps() pipeline logs no warning at all', () => {
    delete process.env[ENV_VAR];
    const { result, lines } = captureStderrLines(() => runSteps(process.cwd(), THREE_STEP_PIPELINE));

    assert.equal(result.steps.length, 3, 'fixture sanity: all 3 steps must still run with the env var unset');
    const malformedEvents = ndjsonEvents(lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(malformedEvents.length, 0, 'the ordinary unset case must stay completely silent across every step, exactly as a single runStep() call already does');
  });
});

describe('F-d535bde5 — the malformed-value dedup Set is scoped PER runSteps() invocation, not the life of the process', () => {
  it('the SAME malformed value across TWO SEPARATE runSteps() calls warns on EACH call — a persistent host gets one warning per batch, not one ever', () => {
    process.env[ENV_VAR] = 'same-value-two-batches';
    const first = captureStderrLines(() => runSteps(process.cwd(), THREE_STEP_PIPELINE));
    const firstEvents = ndjsonEvents(first.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(firstEvents.length, 1, 'fixture sanity: the first batch warns once across its own 3 steps');

    // A SECOND, SEPARATE runSteps() call — e.g. a persistent host (the
    // package's `"./lib/*"` export makes this a real, supported embedding,
    // not a purely theoretical one) verifying a second repo/tenant that
    // happens to share the same misconfigured env value. Pre-fix, the
    // module-level warnedMalformedMaxBufferValues Set persisted across BOTH
    // calls in this one process, so this second batch would have logged
    // ZERO events — the exact "warned once, ever, for the life of the host"
    // defect F-d535bde5 fixed.
    const second = captureStderrLines(() => runSteps(process.cwd(), THREE_STEP_PIPELINE));
    const secondEvents = ndjsonEvents(second.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(secondEvents.length, 1,
      'pre-fix: the module-level Set would have silenced this second, independent runSteps() batch entirely');
    assert.equal(secondEvents[0].raw_value, 'same-value-two-batches');
  });

  it('a bare runStep() call (no runSteps() wrapper) keeps the ORIGINAL module-level, process-lifetime dedup as its default', () => {
    process.env[ENV_VAR] = 'bare-runstep-same-value';
    const first = captureStderrLines(() => runStep(process.cwd(), trivialStep('solo-a')));
    const firstEvents = ndjsonEvents(first.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(firstEvents.length, 1, 'fixture sanity: the first bare call warns');

    // A second bare runStep() call with the SAME raw value and no `opts`:
    // this is the documented default for the low-level primitive, which has
    // no batch boundary of its own, and is UNCHANGED by F-d535bde5 — only
    // runSteps() (the actual `swarm verify`-equivalent batch entry point,
    // and the one every production adapter calls) got the new
    // per-invocation scoping.
    const second = captureStderrLines(() => runStep(process.cwd(), trivialStep('solo-b')));
    const secondEvents = ndjsonEvents(second.lines).filter((e) => e.stage === 'verify_max_buffer_env_malformed');
    assert.equal(secondEvents.length, 0,
      'a bare runStep() call must still dedupe against the module-level Set by default — this contract is unchanged');
  });
});
