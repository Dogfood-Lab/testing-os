/**
 * predicate-attested-equivalence.test.js — VERIFY-F1 FORCED CORRECTNESS PROOF.
 *
 * This is a RELEASE GATE, not a nice-to-have. v1.7.0 migrates exactly one built-in
 * rule — `attested-if-human` — from a hardcoded `switch` arm to a declarative
 * `when` predicate evaluated by the engine. This test proves the migration is
 * BYTE-FOR-BYTE behavior-preserving: the declarative rule (loaded from the REAL
 * production `policies/global-policy.yaml`) must produce identical verdicts AND
 * identical reason strings to the old arm, across an adversarial fixture matrix.
 *
 * `attestedIfHumanReference` below is the old switch arm, lifted VERBATIM from
 * pre-v1.7.0 `validators/policy.js`. It is the oracle. If the engine and the oracle
 * ever diverge, the migration is unsafe and the rule's behavior must NOT be bent to
 * make them agree — the DSL must be fixed instead.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { validatePolicy } from './validators/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_POLICY_PATH = resolve(__dirname, '../../policies/global-policy.yaml');

/**
 * The REFERENCE ORACLE — the pre-v1.7.0 `attested-if-human` switch arm, verbatim.
 * Produces the un-prefixed `errors[]` entries (index.js adds the `policy: ` prefix
 * downstream identically for both paths, so comparing the un-prefixed errors is the
 * faithful comparison).
 */
function attestedIfHumanReference(submission) {
  const rule = { id: 'attested-if-human' };
  const errors = [];
  for (const sr of submission.scenario_results || []) {
    if ((sr.execution_mode === 'human' || sr.execution_mode === 'mixed') && !sr.attested_by) {
      errors.push(
        `[${rule.id}] scenario "${sr.scenario_id}": execution_mode is "${sr.execution_mode}" but attested_by is missing`
      );
    }
  }
  return errors;
}

let attestedRule;

before(() => {
  // Extract the ACTUAL production rule — this gate guards the file that ships.
  const globalPolicy = yaml.load(readFileSync(GLOBAL_POLICY_PATH, 'utf-8'));
  attestedRule = (globalPolicy.global_rules || []).find(r => r.id === 'attested-if-human');
  assert.ok(attestedRule, 'attested-if-human must exist in policies/global-policy.yaml');
  assert.ok(attestedRule.when, 'attested-if-human must be DECLARATIVE (carry a `when`) in v1.7.0');
});

/** Run validatePolicy with ONLY the production attested-if-human rule active. */
function declarativeErrors(submission) {
  const { valid, errors } = validatePolicy(submission, {
    globalPolicy: { defaults: {}, global_rules: [attestedRule] },
    repoPolicy: null,
  });
  return { valid, errors };
}

const SR = (over = {}) => ({ scenario_id: 's', product_surface: 'cli', execution_mode: 'human', verdict: 'pass', ...over });

// The contract fixture matrix (docs/policy-dsl.md → "The forced proof").
const MATRIX = [
  { label: 'human + attested', scenario_results: [SR({ scenario_id: 's1', execution_mode: 'human', attested_by: 'alice' })] },
  { label: 'human, no attested_by', scenario_results: [SR({ scenario_id: 's1', execution_mode: 'human' })] },
  { label: 'mixed, no attested_by', scenario_results: [SR({ scenario_id: 's2', execution_mode: 'mixed' })] },
  { label: 'bot only', scenario_results: [SR({ scenario_id: 's3', execution_mode: 'bot' })] },
  { label: 'empty scenario_results', scenario_results: [] },
  {
    label: 'multiple scenarios, only some attested',
    scenario_results: [
      SR({ scenario_id: 's1', execution_mode: 'human', attested_by: 'alice' }),
      SR({ scenario_id: 's2', execution_mode: 'mixed' }),
      SR({ scenario_id: 's3', execution_mode: 'bot' }),
      SR({ scenario_id: 's4', execution_mode: 'human' }),
    ],
  },
  { label: 'scenario with no execution_mode', scenario_results: [SR({ scenario_id: 's5', execution_mode: undefined })] },
  { label: 'attested_by empty string', scenario_results: [SR({ scenario_id: 's6', execution_mode: 'human', attested_by: '' })] },
  { label: 'scenario_id with literal quote + backslash', scenario_results: [SR({ scenario_id: 's"7\\x', execution_mode: 'mixed' })] },
];

describe('VERIFY-F1 differential-equivalence gate: declarative attested-if-human === old switch arm', () => {
  for (const fixture of MATRIX) {
    it(`byte-identical for: ${fixture.label}`, () => {
      const submission = structuredClone(fixture);
      const oracle = attestedIfHumanReference(submission);
      const { valid, errors } = declarativeErrors(submission);

      // Verdict equivalence.
      assert.equal(valid, oracle.length === 0, `verdict mismatch for "${fixture.label}"`);
      // Reason equivalence — same strings, same order, byte-for-byte.
      assert.deepEqual(errors, oracle, `reason strings diverged for "${fixture.label}"`);
    });
  }

  it('emits one reason PER offending scenario, in scenario_results array order', () => {
    const submission = structuredClone(MATRIX.find(m => m.label.startsWith('multiple')));
    const { errors } = declarativeErrors(submission);
    // s2 (mixed, unattested) and s4 (human, unattested) offend; s1 + s3 do not.
    assert.equal(errors.length, 2);
    assert.match(errors[0], /scenario "s2"/);
    assert.match(errors[1], /scenario "s4"/);
  });
});
