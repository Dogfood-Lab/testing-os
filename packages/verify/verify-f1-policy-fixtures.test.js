/**
 * verify-f1-policy-fixtures.test.js — the golden VERIFY-F1 policy fixtures ARE the
 * contract. This gate enforces them: every fixture in fixtures/policies/valid/ must
 * pass the policy schema, every fixture in fixtures/policies/invalid/ must be
 * rejected by it. The fixtures double as operator examples (docs/policy-dsl.md), so
 * a drift in either the schema or an example trips here.
 *
 * Mirrors the fixtures/findings/{valid,invalid} gate in packages/findings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { validatePayload } from '@dogfood-lab/schemas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(__dirname, '../../fixtures/policies');

const load = (p) => yaml.load(readFileSync(p, 'utf-8'));
const yamls = (dir) => readdirSync(resolve(POLICIES, dir)).filter(f => f.endsWith('.yaml'));

describe('VERIFY-F1 golden policy fixtures: valid fixtures pass the policy schema', () => {
  const files = yamls('valid');
  assert.ok(files.length >= 4, 'expected the valid golden fixtures to exist');
  for (const f of files) {
    it(`valid: ${f}`, () => {
      const res = validatePayload('policy', load(resolve(POLICIES, 'valid', f)));
      assert.equal(res.valid, true, `expected ${f} to pass but got: ${JSON.stringify(res.errors, null, 2)}`);
    });
  }
});

/**
 * F-e7faec0c: each invalid fixture must fail FOR THE REASON it exists to prove
 * (the F-742442-049 discipline from packages/findings/findings.test.js).
 * Asserting only `valid === false` is a vacuous gate: if the schema loosened
 * the specific check a fixture pins, the fixture would still fail on an
 * unrelated structural fault and the gate would stay green while the contract
 * regressed. The regex is matched against JSON.stringify(res.errors), so it
 * can anchor on path + message + keyword together.
 *
 * Adding a new invalid fixture REQUIRES adding its anchor here — the
 * every-fixture-has-an-anchor assertion below fails otherwise.
 */
const INVALID_FIXTURE_ANCHORS = {
  // No accept/except severity — the grammar to weaken a global gate must not exist.
  'custom-rule-accept-verb.yaml': /severity","message":"must be equal to one of the allowed values"/,
  // custom_rules under defaults is forbidden (origin-misclassification guard).
  'custom-rules-in-defaults.yaml': /\/defaults\/custom_rules","message":"boolean schema is false"/,
  // __proto__/constructor/prototype segments violate the field pattern.
  'predicate-banned-segment.yaml': /when\/field","message":"must match pattern/,
  // Combinators need at least one child (minItems: 1).
  'predicate-empty-all.yaml': /when\/all","message":"must NOT have fewer than 1 items"/,
  // exists/not_exists must not carry a value (the `not: required value` branch).
  'predicate-exists-with-value.yaml': /must NOT be valid","keyword":"not"/,
  // in/not_in comparand must be an array.
  'predicate-in-non-array.yaml': /when\/value","message":"must be array"/,
  // Leaf XOR combinator: the leaf branch rejects the combinator key as additional.
  'predicate-mixed-node.yaml': /"additionalProperty":"all"/,
  // Operator outside the closed enum (`matches` intentionally absent — ReDoS).
  'predicate-unknown-op.yaml': /when\/op","message":"must be equal to one of the allowed values"/,
};

describe('VERIFY-F1 golden policy fixtures: invalid fixtures are rejected at load', () => {
  const files = yamls('invalid');
  assert.ok(files.length >= 6, 'expected the invalid golden fixtures to exist');
  for (const f of files) {
    it(`invalid: ${f} (for the RIGHT reason)`, () => {
      const anchor = INVALID_FIXTURE_ANCHORS[f];
      assert.ok(anchor,
        `invalid fixture ${f} has no expected-error anchor in INVALID_FIXTURE_ANCHORS — ` +
        `add one so the gate cannot pass vacuously on an unrelated structural fault (F-e7faec0c)`);
      const res = validatePayload('policy', load(resolve(POLICIES, 'invalid', f)));
      assert.equal(res.valid, false, `expected ${f} to be REJECTED by policy.schema.json but it passed`);
      const serialized = JSON.stringify(res.errors);
      assert.match(serialized, anchor,
        `${f} was rejected, but NOT for the violation it pins — expected ${anchor}, got: ${serialized}`);
    });
  }

  it('every anchor corresponds to a fixture that still exists (no dead anchors)', () => {
    for (const name of Object.keys(INVALID_FIXTURE_ANCHORS)) {
      assert.ok(files.includes(name),
        `INVALID_FIXTURE_ANCHORS names ${name} but no such fixture exists in fixtures/policies/invalid/`);
    }
  });
});
