import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateStepResults } from './validators/steps.js';
import { validatePolicy } from './validators/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

// ── d2-validation-002 — `partial` is a contract-blessed STEP status ──
//
// Both schemas (dogfood-record-submission.schema.json + dogfood-record.schema.json)
// list step_results[].status enum as ["pass","fail","blocked","skip","partial"].
// steps.js:28 VALID_STATUSES omitted `partial`, so a schema-valid submission using
// the documented `partial` step status was FALSELY REJECTED as "unknown status".
// No existing test exercised a `partial` STEP status (verify.test.js:100 sets a step
// to 'fail'), which is why the schema-vs-allowlist drift survived.

describe('d2-validation-002: validateStepResults accepts a `partial` step status', () => {
  it('does NOT reject a schema-valid `partial` step status', () => {
    const scenario = structuredClone(pilot0.scenario_results[0]);
    // Mutate a step to the contract-blessed `partial` status.
    scenario.step_results[0].status = 'partial';
    // Keep the scenario verdict non-pass so the pass/fail-step consistency
    // rule doesn't interfere — we're isolating the status-allowlist behavior.
    scenario.verdict = 'partial';

    const errors = validateStepResults(scenario);

    assert.ok(
      !errors.some(e => e.includes('unknown status')),
      `partial step status must not be flagged as unknown; got: ${JSON.stringify(errors)}`
    );
    assert.deepEqual(errors, [], `expected no errors for a partial step; got: ${JSON.stringify(errors)}`);
  });

  it('still rejects a genuinely unknown step status (allowlist not gutted)', () => {
    const scenario = structuredClone(pilot0.scenario_results[0]);
    scenario.step_results[0].status = 'bogus-status';
    const errors = validateStepResults(scenario);
    assert.ok(
      errors.some(e => e.includes('unknown status') && e.includes('bogus-status')),
      `an off-enum status must still be rejected; got: ${JSON.stringify(errors)}`
    );
  });

  it('accepts every contract-blessed step status', () => {
    for (const status of ['pass', 'fail', 'blocked', 'skip', 'partial']) {
      const scenario = structuredClone(pilot0.scenario_results[0]);
      // Single-step scenario; use a non-pass verdict so fail/blocked steps are
      // allowed and we test purely the status allowlist.
      scenario.verdict = 'partial';
      scenario.step_results = [{ step_id: 'only-step', status }];
      const errors = validateStepResults(scenario);
      assert.ok(
        !errors.some(e => e.includes('unknown status')),
        `status "${status}" must be a valid step status; got: ${JSON.stringify(errors)}`
      );
    }
  });
});

// ── d2-validation-001 — coverage_min gate must not be bypassable ──
//
// policy.js gated coverage only when a `kind === 'coverage'` ci_check existed AND
// compared `coverageCheck.value < coverage_min`. The submission schema makes
// ci_checks[].value OPTIONAL (only id/kind/status required), so a schema-valid
// value-less coverage check `{id,kind:'coverage',status:'pass'}` yielded
// `undefined < 80 === false` — the gate silently PASSED with no measured coverage.
// A value-less coverage check must be treated the same as a missing one: the
// verifier's job at the trust boundary is to reject incomplete proof.

describe('d2-validation-001: coverage_min gate requires a numeric coverage value', () => {
  // Minimal global policy that turns the coverage gate ON for the cli surface.
  const globalPolicy = {
    defaults: {
      ci_requirements: { coverage_min: 80, tests_must_pass: false }
    }
  };
  const repoPolicy = null;

  function submissionWithCiChecks(ciChecks) {
    const sub = structuredClone(pilot0);
    sub.ci_checks = ciChecks;
    return sub;
  }

  it('REJECTS a coverage check that omits its numeric value', () => {
    // Schema-valid: id/kind/status present, value absent.
    const sub = submissionWithCiChecks([
      { id: 'cov', kind: 'coverage', status: 'pass' }
    ]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false, 'value-less coverage check must NOT pass the gate');
    assert.ok(
      result.errors.some(e => e.includes('no coverage data provided')),
      `expected the no-coverage-data error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('REJECTS a coverage check whose value is non-numeric (NaN/null)', () => {
    // Defensive: a value of null is not schema-conforming (number type), but the
    // gate must not treat `null < 80 === true`-style coercion surprises as a pass
    // either. Both null and NaN must be treated as "no measured value".
    for (const value of [null, NaN]) {
      const sub = submissionWithCiChecks([
        { id: 'cov', kind: 'coverage', status: 'pass', value }
      ]);
      const result = validatePolicy(sub, { globalPolicy, repoPolicy });
      assert.equal(result.valid, false, `value=${String(value)} must NOT pass the gate`);
      assert.ok(
        result.errors.some(e => e.includes('no coverage data provided')),
        `value=${String(value)}: expected no-coverage-data error; got: ${JSON.stringify(result.errors)}`
      );
    }
  });

  it('REJECTS a measured coverage value below the minimum', () => {
    const sub = submissionWithCiChecks([
      { id: 'cov', kind: 'coverage', status: 'pass', value: 50 }
    ]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('below minimum')),
      `expected below-minimum error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('REJECTS when coverage_min is set but no coverage check exists at all', () => {
    const sub = submissionWithCiChecks([
      { id: 'unit', kind: 'test', status: 'pass', value: 24 }
    ]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('no coverage data provided')),
      `expected no-coverage-data error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('ACCEPTS a measured coverage value at or above the minimum (happy path intact)', () => {
    for (const value of [80, 95, 100]) {
      const sub = submissionWithCiChecks([
        { id: 'cov', kind: 'coverage', status: 'pass', value }
      ]);
      const result = validatePolicy(sub, { globalPolicy, repoPolicy });
      assert.equal(
        result.valid, true,
        `value=${value} should pass coverage gate; got: ${JSON.stringify(result.errors)}`
      );
    }
  });
});
