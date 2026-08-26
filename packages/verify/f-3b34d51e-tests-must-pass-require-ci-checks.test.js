/**
 * F-3b34d51e — tests_must_pass must not be fail-open when ci_checks is omitted.
 *
 * Pre-fix the gate was `if (ciReqs.tests_must_pass && submission.ci_checks)`:
 * leaving optional ci_checks off the payload (or sending [] / no kind:'test')
 * skipped the branch and policy-validated clean under tests_must_pass:true.
 * Sibling coverage_min already rejects missing proof (d2-validation-001);
 * this pin mirrors that contract for tests_must_pass.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePolicy } from './validators/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

/** @pins F-3b34d51e */
describe('F-3b34d51e: tests_must_pass requires kind:test CI evidence', () => {
  const globalPolicy = {
    defaults: {
      ci_requirements: { tests_must_pass: true }
    }
  };
  const repoPolicy = null;

  function submissionWithCiChecks(ciChecks) {
    const sub = structuredClone(pilot0);
    if (ciChecks === undefined) {
      delete sub.ci_checks;
    } else {
      sub.ci_checks = ciChecks;
    }
    return sub;
  }

  it('REJECTS when ci_checks is omitted entirely under tests_must_pass:true (RED omit pin)', () => {
    const sub = submissionWithCiChecks(undefined);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false, 'omitted ci_checks must NOT pass tests_must_pass');
    assert.ok(
      result.errors.some(e => e.includes('tests_must_pass') && e.includes('no kind:test')),
      `expected missing-test-evidence error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('REJECTS when ci_checks is an empty array', () => {
    const sub = submissionWithCiChecks([]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('tests_must_pass') && e.includes('no kind:test')),
      `expected missing-test-evidence error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('REJECTS when ci_checks has no kind:test entries', () => {
    const sub = submissionWithCiChecks([
      { id: 'cov', kind: 'coverage', status: 'pass', value: 90 }
    ]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('tests_must_pass') && e.includes('no kind:test')),
      `expected missing-test-evidence error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('REJECTS when a kind:test check has status fail (existing failing-test pin kept)', () => {
    const sub = submissionWithCiChecks([
      { id: 'unit-tests', kind: 'test', status: 'fail', value: 20 }
    ]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('CI tests must pass')),
      `expected failing-test error; got: ${JSON.stringify(result.errors)}`
    );
  });

  it('ACCEPTS when at least one kind:test check is not fail', () => {
    const sub = submissionWithCiChecks([
      { id: 'unit-tests', kind: 'test', status: 'pass', value: 24 }
    ]);
    const result = validatePolicy(sub, { globalPolicy, repoPolicy });
    assert.equal(
      result.valid, true,
      `passing test evidence should satisfy tests_must_pass; got: ${JSON.stringify(result.errors)}`
    );
  });
});
