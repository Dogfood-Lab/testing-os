/**
 * F-57a0c0ad: a non-declarative global warn rule emitted `${id}: ${description}`
 * (colon format) while declarative warn/reject rules emit `[${id}] ${body}` via
 * buildReason — two formats for the same concept in one function. A consumer
 * grepping the documented `[rule-id]` shape missed legacy-form warnings.
 * Contract: legacy warn rules emit the bracketed form too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePolicy } from './validators/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pilot0 = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'pilot-0-submission.json'), 'utf-8')
);

function policyWithRules(rules) {
  return { policy_version: '1.0.0', defaults: {}, global_rules: rules };
}

describe('F-57a0c0ad: legacy warn rules use the bracketed [rule-id] convention', () => {
  it('a non-declarative warn rule emits [id] description', () => {
    const { warnings } = validatePolicy(structuredClone(pilot0), {
      globalPolicy: policyWithRules([
        { id: 'soft-coverage', severity: 'warn', description: 'coverage below target is tolerated for now' },
      ]),
      repoPolicy: null,
    });
    assert.deepEqual(warnings, ['[soft-coverage] coverage below target is tolerated for now']);
  });

  it('a description-less warn rule falls back to [id] policy warning', () => {
    const { warnings } = validatePolicy(structuredClone(pilot0), {
      globalPolicy: policyWithRules([{ id: 'bare-warn', severity: 'warn' }]),
      repoPolicy: null,
    });
    assert.deepEqual(warnings, ['[bare-warn] policy warning']);
  });
});
