/**
 * f-36fdebca-log-stage-write-guard.test.js — F-36fdebca (MEDIUM): logStage()'s
 * ORDINARY, successful-serialization exit path — `console.error(serialized)`
 * — had no try/catch, unlike every other exit path in the same function (the
 * serialization-failure fallback wraps its own console.error calls; the
 * human-banner call is wrapped too, "Banner failure must not crash the
 * logger"). A closed/broken stderr pipe (EPIPE) throws synchronously from
 * console.error itself — proven for the identical shape at
 * packages/verify/validators/provenance.js's defaultOnRetryWarn (F-f50e779b),
 * which this repo's own history already fixed once. logStage is the
 * operator's last forensic channel and must never crash its caller over a
 * write it does not control.
 *
 * Drives the REAL, unmutated logStage() (dynamic import per test so each
 * test gets a fresh console.error monkey-patch without cross-test leakage) —
 * never a reimplementation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { logStage } from './log-stage.js';

const ORIGINAL_CONSOLE_ERROR = console.error;
const ORIGINAL_DOGFOOD_LOG_HUMAN = process.env.DOGFOOD_LOG_HUMAN;

afterEach(() => {
  console.error = ORIGINAL_CONSOLE_ERROR;
  if (ORIGINAL_DOGFOOD_LOG_HUMAN === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
  else process.env.DOGFOOD_LOG_HUMAN = ORIGINAL_DOGFOOD_LOG_HUMAN;
});

describe('F-36fdebca — logStage() must not throw when stderr itself is broken', () => {
  /** @pins F-36fdebca */
  it('GATE: a console.error that throws (simulated EPIPE) on the ordinary line does not escape logStage', () => {
    // DOGFOOD_LOG_HUMAN=0 isolates the ordinary NDJSON write (the line this
    // fix guards) from the human-banner call (already guarded before this
    // fix) — the banner branch must not even run for this test to prove
    // anything about the specific gap F-36fdebca closes.
    process.env.DOGFOOD_LOG_HUMAN = '0';
    console.error = () => {
      throw new Error('EPIPE: simulated broken stderr');
    };

    assert.doesNotThrow(
      () => logStage('dispatch_received', { component: 'dogfood-swarm', runId: 'r1' }),
      'logStage must swallow a broken-stderr write failure, not propagate it to its caller',
    );
  });

  it('GATE: a console.error that throws on EVERY call (NDJSON line AND human banner) still does not escape logStage', () => {
    // The realistic EPIPE condition breaks the fd for every subsequent
    // write, not just the first — so with DOGFOOD_LOG_HUMAN=1 (forcing the
    // banner branch to run too) BOTH console.error calls throw, and both
    // must be independently swallowed for logStage to return cleanly.
    process.env.DOGFOOD_LOG_HUMAN = '1';
    let calls = 0;
    console.error = () => {
      calls += 1;
      throw new Error('EPIPE: simulated broken stderr');
    };

    assert.doesNotThrow(
      () => logStage('verify_complete', { component: 'dogfood-swarm', runId: 'r1', status: 'pass' }),
      'logStage must swallow a broken-stderr write failure on both the NDJSON line and the human banner',
    );
    assert.equal(calls, 2, 'both the NDJSON line and the human banner must have been attempted');
  });

  it('non-regression: an ordinary (non-throwing) console.error still emits the NDJSON line', () => {
    process.env.DOGFOOD_LOG_HUMAN = '0';
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));

    logStage('dispatch_received', { component: 'dogfood-swarm', runId: 'r1' });

    assert.equal(lines.length, 1, 'exactly one NDJSON line (banner suppressed)');
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.stage, 'dispatch_received');
    assert.equal(parsed.runId, 'r1');
  });

  it('non-regression: the human banner still emits after a successful write (DOGFOOD_LOG_HUMAN=1)', () => {
    process.env.DOGFOOD_LOG_HUMAN = '1';
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));

    logStage('verify_complete', { component: 'dogfood-swarm', runId: 'r1', status: 'pass' });

    assert.equal(lines.length, 2, 'both the NDJSON line and the human banner must be emitted');
    JSON.parse(lines[0]); // NDJSON line must still be valid JSON
    assert.match(lines[1], /^\[dogfood-swarm:verify_complete\]/, 'second line is the human banner');
  });

  it('non-regression: the serialization-failure fallback branch is untouched by this fix', () => {
    // A circular reference fails JSON.stringify — this exercises the
    // EARLIER branch (lines 66-88), entirely separate from the line this fix
    // touches, and must still behave exactly as before.
    process.env.DOGFOOD_LOG_HUMAN = '0';
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));

    const circular = {};
    circular.self = circular;

    assert.doesNotThrow(() => logStage('dispatch_received', { component: 'dogfood-swarm', bad: circular }));
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.stage, 'log_stage_serialization_failed');
    assert.equal(parsed.kind, 'log_stage_serialization_failed');
    assert.equal(parsed.original_stage, 'dispatch_received');
  });
});
