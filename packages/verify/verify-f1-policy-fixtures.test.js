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

describe('VERIFY-F1 golden policy fixtures: invalid fixtures are rejected at load', () => {
  const files = yamls('invalid');
  assert.ok(files.length >= 6, 'expected the invalid golden fixtures to exist');
  for (const f of files) {
    it(`invalid: ${f}`, () => {
      const res = validatePayload('policy', load(resolve(POLICIES, 'invalid', f)));
      assert.equal(res.valid, false, `expected ${f} to be REJECTED by policy.schema.json but it passed`);
    });
  }
});
