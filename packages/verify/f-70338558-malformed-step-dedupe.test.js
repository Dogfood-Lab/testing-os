/**
 * F-70338558: two malformed step objects (no string step_id) both entered the
 * dedupe Set as `undefined`, so the submitter saw a spurious
 * `duplicate step_id: undefined` on top of the two legitimate 'malformed'
 * errors — misreporting how many distinct problems exist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateStepResults } from './validators/steps.js';

describe('F-70338558: malformed steps do not pollute duplicate-id detection', () => {
  it('two malformed steps yield two malformed errors and NO duplicate error', () => {
    const errors = validateStepResults({
      scenario_id: 's',
      verdict: 'fail',
      step_results: [{ status: 'pass' }, { status: 'fail' }]
    });
    const malformed = errors.filter(e => e.includes('malformed'));
    const dup = errors.filter(e => e.includes('duplicate'));
    assert.equal(malformed.length, 2);
    assert.deepEqual(dup, [], `no duplicate error expected, got: ${JSON.stringify(dup)}`);
  });

  it('real duplicate step_ids are still reported', () => {
    const errors = validateStepResults({
      scenario_id: 's',
      verdict: 'fail',
      step_results: [
        { step_id: 'a', status: 'pass' },
        { step_id: 'a', status: 'pass' }
      ]
    });
    assert.ok(errors.some(e => e.includes('duplicate step_id: a')));
  });
});
