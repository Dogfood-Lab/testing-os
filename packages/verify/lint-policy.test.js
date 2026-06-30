/**
 * lint-policy.test.js (VERIFY-F3) — integration tests for lintPolicy(policyDoc,
 * { origin }): the author-time policy check that runs the structural schema gate +
 * the static predicate walk + the `[]`-footgun advisory over a whole policy file,
 * with NO submission. The golden lint fixtures in fixtures/policies/lint/ ARE the
 * contract; this gate enforces each behaves as docs/policy-lint.md documents.
 *
 * Mirrors the verify-f1-policy-fixtures.test.js gate pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { lintPolicy } from './validators/lint-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT = resolve(__dirname, '../../fixtures/policies/lint');
const INVALID = resolve(__dirname, '../../fixtures/policies/invalid');
const load = (dir, f) => yaml.load(readFileSync(resolve(dir, f), 'utf-8'));

describe('lintPolicy: footgun fixture WARNS (never errors)', () => {
  const res = lintPolicy(load(LINT, 'footgun-negative-over-array.yaml'), { origin: 'repo' });

  it('is ok (warnings do not block)', () => assert.equal(res.ok, true));
  it('reports zero errors', () => assert.equal(res.errors.length, 0));
  it('reports exactly one footgun warning naming the field', () => {
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings[0].code, 'footgun-empty-array');
    assert.equal(res.warnings[0].field, 'evidence[].kind');
    assert.match(res.warnings[0].suggestion, /not.*any/s);
  });
});

describe('lintPolicy: a LEGIT existential-negative still only WARNS', () => {
  const res = lintPolicy(load(LINT, 'legit-existential-negative.yaml'), { origin: 'global' });
  it('is ok (advisory, the author confirms intent)', () => assert.equal(res.ok, true));
  it('warns but does not error', () => {
    assert.equal(res.errors.length, 0);
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings[0].field, 'scenario_results[].verdict');
  });
});

describe('lintPolicy: unknown field is an ERROR', () => {
  const res = lintPolicy(load(LINT, 'unknown-field.yaml'), { origin: 'repo' });
  it('is not ok', () => assert.equal(res.ok, false));
  it('reports a policy-config: unknown_field error naming the rule + field', () => {
    const e = res.errors.find(e => e.code === 'unknown_field');
    assert.ok(e, `expected an unknown_field error, got ${JSON.stringify(res.errors)}`);
    assert.equal(e.label, 'policy-config:');
    assert.match(e.location, /bogus-field-rule/);
    assert.match(e.message, /nonexistent_field/);
  });
});

describe('lintPolicy: over-depth is an ERROR', () => {
  const res = lintPolicy(load(LINT, 'over-depth.yaml'), { origin: 'repo' });
  it('is not ok', () => assert.equal(res.ok, false));
  it('reports a max_depth error', () => {
    assert.ok(res.errors.some(e => e.code === 'max_depth'));
  });
});

describe('lintPolicy: a clean policy reports nothing', () => {
  const res = lintPolicy(load(LINT, 'clean.yaml'), { origin: 'repo' });
  it('is ok', () => assert.equal(res.ok, true));
  it('has no errors and no warnings (incl. the not(any()) idiom is not flagged)', () => {
    assert.equal(res.errors.length, 0);
    assert.equal(res.warnings.length, 0);
  });
});

describe('lintPolicy: a structurally-invalid policy is a policy-schema: ERROR', () => {
  // Reuse a schema-invalid fixture from the F1 gate (unknown op caught by the schema).
  const res = lintPolicy(load(INVALID, 'predicate-unknown-op.yaml'), { origin: 'repo' });
  it('is not ok', () => assert.equal(res.ok, false));
  it('reports at least one policy-schema: error', () => {
    assert.ok(res.errors.some(e => e.label === 'policy-schema:'));
  });
});

describe('lintPolicy: honest coverage note', () => {
  const res = lintPolicy(load(LINT, 'clean.yaml'), { origin: 'repo' });
  it('states what static lint cannot catch (type_mismatch is data-dependent)', () => {
    assert.match(res.coverageNote, /type_mismatch/);
    assert.match(res.coverageNote, /submission/);
  });
});

describe('lintPolicy: live policies/ tree is clean (smoke gate)', () => {
  const REPO_ROOT = resolve(__dirname, '../..');
  it('global-policy.yaml lints clean (no errors, no footguns)', () => {
    const res = lintPolicy(load(resolve(REPO_ROOT, 'policies'), 'global-policy.yaml'), { origin: 'global' });
    assert.equal(res.ok, true, `global policy should lint clean, got: ${JSON.stringify(res.errors)}`);
    assert.equal(res.warnings.length, 0, `global policy should have no footguns, got: ${JSON.stringify(res.warnings)}`);
  });
});
