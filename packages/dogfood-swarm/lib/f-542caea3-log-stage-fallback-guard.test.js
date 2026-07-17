/**
 * f-542caea3-log-stage-fallback-guard.test.js — F-542caea3 (MEDIUM, wave 37):
 * F-36fdebca guarded the ORDINARY successful-serialization console.error
 * (`console.error(serialized)`), but the pre-existing serialization-FAILURE
 * fallback branch has its own unguarded gap one level deeper: the
 * fallback's OWN last-resort literal —
 *   `catch { console.error('{"stage":"log_stage_serialization_failed",...}'); }`
 * — had no try/catch of its own. A PERSISTENTLY (not merely transiently)
 * broken stderr — the realistic EPIPE condition, which breaks every
 * subsequent write, not just the first — made that last-resort write ALSO
 * throw, escaping logStage() entirely from its own deepest fallback.
 *
 * Guard-discipline enumeration (this fix's brief required unifying the
 * discipline across every console write in the file, not patching one
 * branch): log-stage.js has exactly FOUR console.error call sites, and
 * after this fix every one of them is independently wrapped in its own
 * try/catch —
 *   1. the serialization-failure fallback's structured attempt (this file)
 *   2. that fallback's OWN last-resort literal (F-542caea3, this fix)
 *   3. the ordinary successful-serialization write (F-36fdebca, pinned in
 *      f-36fdebca-log-stage-write-guard.test.js)
 *   4. the human-banner companion write (pre-existing)
 * — so no branch can be the next leak.
 *
 * Drives the REAL, unmutated logStage() (dynamic per-test console.error
 * monkey-patch, restored in afterEach) — never a reimplementation.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { logStage } from './log-stage.js';

const ORIGINAL_CONSOLE_ERROR = console.error;
const ORIGINAL_DOGFOOD_LOG_HUMAN = process.env.DOGFOOD_LOG_HUMAN;

afterEach(() => {
  console.error = ORIGINAL_CONSOLE_ERROR;
  if (ORIGINAL_DOGFOOD_LOG_HUMAN === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
  else process.env.DOGFOOD_LOG_HUMAN = ORIGINAL_DOGFOOD_LOG_HUMAN;
});

/** A circular reference fails JSON.stringify, forcing the serialization-failure branch. */
function forceSerializationFailure() {
  const circular = {};
  circular.self = circular;
  return circular;
}

describe('F-542caea3 — the serialization-failure fallback\'s OWN last-resort console.error must not escape logStage', () => {
  /** @pins F-542caea3 */
  it('GATE: a PERSISTENTLY broken console.error (every call throws) does not escape logStage even from the deepest fallback', () => {
    process.env.DOGFOOD_LOG_HUMAN = '0';
    let calls = 0;
    console.error = () => {
      calls += 1;
      throw new Error('EPIPE: simulated persistently broken stderr');
    };

    assert.doesNotThrow(
      () => logStage('dispatch_received', { component: 'dogfood-swarm', bad: forceSerializationFailure() }),
      'pre-fix: the fallback\'s own last-resort console.error had no try/catch, so a persistently broken ' +
      'stderr threw straight out of logStage from its deepest fallback branch',
    );
    assert.equal(calls, 2,
      'both the fallback\'s structured attempt AND its own last-resort literal must have been attempted');
  });

  it('control: a TRANSIENTLY broken console.error (throws once, then recovers) already did not escape (unaffected by this fix)', () => {
    process.env.DOGFOOD_LOG_HUMAN = '0';
    let calls = 0;
    const lines = [];
    console.error = (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('EPIPE: simulated transient broken stderr');
      lines.push(args.join(' '));
    };

    assert.doesNotThrow(
      () => logStage('dispatch_received', { component: 'dogfood-swarm', bad: forceSerializationFailure() }),
    );
    assert.equal(calls, 2, 'the structured attempt throws once, then the last-resort literal succeeds');
    assert.equal(lines.length, 1, 'the last-resort literal was actually written once console.error stopped throwing');
  });

  it('non-regression: a healthy console.error still emits the structured fallback line exactly once', () => {
    process.env.DOGFOOD_LOG_HUMAN = '0';
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));

    logStage('dispatch_received', { component: 'dogfood-swarm', bad: forceSerializationFailure() });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.stage, 'log_stage_serialization_failed');
    assert.equal(parsed.kind, 'log_stage_serialization_failed');
  });

  it('non-regression: the ordinary (non-serialization-failure) path is untouched by this fix', () => {
    process.env.DOGFOOD_LOG_HUMAN = '0';
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));

    logStage('dispatch_received', { component: 'dogfood-swarm', runId: 'r1' });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.stage, 'dispatch_received');
    assert.equal(parsed.runId, 'r1');
  });
});
