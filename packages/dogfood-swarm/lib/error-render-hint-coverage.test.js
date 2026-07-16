/**
 * error-render-hint-coverage.test.js — F-4b72faf9: CriterionIntentOverflowError
 * never set `.hint`, and error-render.js's deriveHintForCode() switch had no
 * case for 'CRITERION_INTENT_OVERFLOW' either — so renderTopLevelError printed
 * no "Next:" line at all for it, unlike every OTHER typed error in errors.js.
 *
 * INSTANCE FIX: CriterionIntentOverflowError's constructor now sets a default
 * `.hint` (the message's own remediation text, split into a dedicated field,
 * mirroring ControlPlaneSchemaTooNewError's `opts.hint || '<default>'`
 * pattern), AND deriveHintForCode() gained a matching CRITERION_INTENT_OVERFLOW
 * case (mirroring CONTROL_PLANE_SCHEMA_TOO_NEW's existing dual-coverage) —
 * doing BOTH covers both a directly-constructed error (has `.hint` already)
 * and a hand-shaped/JSON-round-tripped error object that kept `.code` but not
 * the real class's constructor logic.
 *
 * CLASS FIX (this file): the finding's own text asks "whether the missing
 * fallback is the real class defect" — a FUTURE typed error added to
 * errors.js with neither a constructor-set `.hint` NOR a deriveHintForCode()
 * case would silently lose its "Next:" line the exact same way
 * CriterionIntentOverflowError did, and nothing in the suite would catch it.
 * This file is that catch: it drives every exported typed error class from
 * errors.js through the real renderTopLevelError and asserts a "Next:" line
 * always prints. A negative control (a hint-less, code-only synthetic error)
 * proves the harness actually discriminates — a helper that always finds
 * SOME output line would rubber-stamp a broken class the same way the
 * pre-fix state went uncaught.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns packages/dogfood-swarm/lib/**\ only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IsolationError,
  CollectUpsertError,
  DispatchPreconditionError,
  CliInvalidGlobsError,
  ControlPlaneSchemaTooNewError,
  CriterionIntentOverflowError,
  StateMachineRejectionError,
} from './errors.js';
import { renderTopLevelError } from './error-render.js';

function nextLineFor(err) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    renderTopLevelError(err);
  } finally {
    console.error = orig;
  }
  return lines.find((l) => l.trim().startsWith('Next:'));
}

/** @pins F-4b72faf9 */
describe('errors.js — every typed error renders a "Next:" hint (F-4b72faf9 class-level gate)', () => {
  it('GATE (negative control): a hint-less error whose code has no deriveHintForCode case renders NO "Next:" line', () => {
    // Proves nextLineFor() actually discriminates. Without this control, a
    // broken helper that always returns something would make every positive
    // assertion below meaningless — the same blind spot that let
    // CriterionIntentOverflowError ship with no "Next:" line and no test
    // catching it.
    const e = Object.assign(new Error('msg'), { code: 'NO_HINT_ANYWHERE_TEST_CODE' });
    assert.equal(nextLineFor(e), undefined);
  });

  it('IsolationError', () => {
    const e = new IsolationError('worktree creation failed');
    assert.ok(nextLineFor(e), 'IsolationError must render a Next: hint');
  });

  it('CollectUpsertError', () => {
    const e = new CollectUpsertError('upsert failed', { waveId: 1 });
    assert.ok(nextLineFor(e), 'CollectUpsertError must render a Next: hint');
  });

  it('DispatchPreconditionError (all four documented codes)', () => {
    for (const code of [
      'DISPATCH_RUN_NOT_FOUND',
      'DISPATCH_DOMAINS_NOT_FROZEN',
      'DISPATCH_NO_DOMAINS',
      'DISPATCH_INVALID_PHASE',
    ]) {
      const e = new DispatchPreconditionError('precondition failed', { code });
      assert.ok(nextLineFor(e), `DispatchPreconditionError[${code}] must render a Next: hint`);
    }
  });

  it('CliInvalidGlobsError', () => {
    const e = new CliInvalidGlobsError('bad globs JSON');
    assert.ok(nextLineFor(e), 'CliInvalidGlobsError must render a Next: hint');
  });

  it('ControlPlaneSchemaTooNewError', () => {
    const e = new ControlPlaneSchemaTooNewError('schema too new', { onDiskVersion: 9, buildVersion: 8 });
    assert.ok(nextLineFor(e), 'ControlPlaneSchemaTooNewError must render a Next: hint');
  });

  it('CriterionIntentOverflowError — the instance this finding fixed', () => {
    const e = new CriterionIntentOverflowError('intent too long', {
      criterionId: 'c1', headLength: 4100, maxChars: 4000,
    });
    assert.ok(nextLineFor(e), 'CriterionIntentOverflowError must render a Next: hint (F-4b72faf9)');

    // Also pin the dual-coverage fallback directly: a hand-shaped error
    // object with the code but no constructor-set .hint must still get one
    // from deriveHintForCode's new case.
    const shaped = Object.assign(new Error('intent too long'), {
      code: 'CRITERION_INTENT_OVERFLOW', criterionId: 'c2', headLength: 4200, maxChars: 4000,
    });
    assert.ok(nextLineFor(shaped), 'a .hint-less CRITERION_INTENT_OVERFLOW must still get a fallback Next: hint');
  });

  it('StateMachineRejectionError (all three kinds)', () => {
    for (const kind of ['BLOCKED', 'TERMINAL', 'INVALID']) {
      const e = new StateMachineRejectionError('rejected', { kind, from: 'a', to: 'b', hint: 'do the thing' });
      assert.ok(nextLineFor(e), `StateMachineRejectionError[${kind}] must render a Next: hint`);
    }
  });
});
