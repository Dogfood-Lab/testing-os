/**
 * F-ad98b5ac (defensive) — validateRequiredSteps' map build was unguarded.
 *
 * `new Map(step_results.map(s => [s.step_id, s]))` dereferences `s.step_id` on
 * every element with no per-element guard. A null / non-object element throws a
 * TypeError that `runValidator('steps', ...)` mislabels as an operational
 * `VALIDATOR_FAULT_STEPS` — the submission-bad→ops inversion the F-efe4f893
 * family fought: a MALFORMED SUBMISSION is a caller problem (reject the
 * submission), not an operator fault (page the pipeline owner).
 *
 * The sibling `validateStepResults` already applies this floor (its verify-B-004
 * comment guards `s != null`). Fix: build the map defensively, admitting only
 * `{ ...typeof s === 'object', typeof s.step_id === 'string' }` elements. This
 * only stops the map build from throwing; structural malformed-step *reporting*
 * stays validateStepResults' job.
 *
 * Pin: RED = a `step_results: [null]` (or non-object element) input throws a
 * TypeError before the fix; GREEN = it builds the map without throwing after.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateRequiredSteps } from './steps.js';

describe('F-ad98b5ac: validateRequiredSteps map build tolerates malformed elements', () => {
  it('POSITIVE: a null element in step_results does not throw a TypeError', () => {
    const scenarioResult = {
      scenario_id: 'sc-1',
      verdict: 'pass',
      step_results: [null],
    };
    // Before the fix: `s.step_id` on null throws
    // `TypeError: Cannot read properties of null (reading 'step_id')`.
    assert.doesNotThrow(
      () => validateRequiredSteps(scenarioResult, ['step-a']),
      'a null element must not throw — the map build must guard per element'
    );
  });

  it('POSITIVE: a non-object element (string/number) does not throw', () => {
    const scenarioResult = {
      scenario_id: 'sc-2',
      verdict: 'fail',
      step_results: ['not-an-object', 42],
    };
    assert.doesNotThrow(
      () => validateRequiredSteps(scenarioResult, ['step-a']),
      'a non-object element must not throw'
    );
  });

  it('POSITIVE: an object element missing a string step_id does not throw', () => {
    const scenarioResult = {
      scenario_id: 'sc-3',
      verdict: 'pass',
      step_results: [{ status: 'pass' }],
    };
    assert.doesNotThrow(
      () => validateRequiredSteps(scenarioResult, ['step-a']),
      'an object without a string step_id must not throw'
    );
  });

  it('NEGATIVE: well-formed step_results still enforce required-step presence + verdict consistency', () => {
    // A malformed element must not silently disable the real checks. A valid
    // step keyed correctly still participates; a missing required step is still
    // reported.
    const scenarioResult = {
      scenario_id: 'sc-ok',
      verdict: 'pass',
      step_results: [
        null,                                   // tolerated, ignored
        { step_id: 'step-a', status: 'pass' },  // valid, keyed into the map
      ],
    };
    const errors = validateRequiredSteps(scenarioResult, ['step-a', 'step-missing']);
    // step-a is present + passing → no error for it.
    assert.ok(!errors.some(e => e.includes('"step-a"')),
      `a present, passing required step must not error; got: ${JSON.stringify(errors)}`);
    // step-missing has no result → the presence rule still fires.
    assert.ok(errors.some(e => e.includes('step-missing')),
      `a missing required step must still be reported; got: ${JSON.stringify(errors)}`);
  });
});
