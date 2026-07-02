/**
 * F-3bfc2885: the `step-results-present` / `step-verdict-consistent` global
 * reject rules must be REAL enforcement, not a KNOWN_REJECT_RULE_IDS entry
 * pointing at a dead function. verify() now accepts a `scenarios` Map
 * (scenario_id → scenario definition) and runs validateRequiredSteps per
 * scenario_result against success_criteria.required_steps.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify } from './index.js';
import { validateRequiredSteps } from './validators/steps.js';
import { stubProvenance } from './validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const POLICIES = resolve(__dirname, '../../policies');

let pilot0;
let globalPolicy;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
  globalPolicy = yaml.load(readFileSync(resolve(POLICIES, 'global-policy.yaml'), 'utf-8'));
});

function baseOptions(scenarios) {
  return {
    globalPolicy,
    repoPolicy: null,
    provenance: stubProvenance,
    policyVersion: '1.0.0',
    ...(scenarios ? { scenarios } : {})
  };
}

function scenarioDef(requiredSteps) {
  return { success_criteria: { required_steps: requiredSteps } };
}

describe('F-3bfc2885: required_steps enforcement wired into verify()', () => {
  it('rejects when a required step has no matching step_result', async () => {
    const scenarios = new Map([
      ['record-ingest-roundtrip', scenarioDef(['emit-submission', 'not-reported-step'])]
    ]);
    const record = await verify(structuredClone(pilot0), baseOptions(scenarios));
    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r =>
        r.includes('[step-results-present]') && r.includes('not-reported-step')
      ),
      `expected [step-results-present] reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('rejects a pass verdict whose required step is missing (step-verdict-consistent)', async () => {
    const scenarios = new Map([
      ['record-ingest-roundtrip', scenarioDef(['ghost-step'])]
    ]);
    const record = await verify(structuredClone(pilot0), baseOptions(scenarios));
    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('[step-verdict-consistent]')),
      `expected [step-verdict-consistent] reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('accepts when every required step has a matching step_result', async () => {
    const scenarios = new Map([
      ['record-ingest-roundtrip', scenarioDef(['emit-submission', 'write-record'])]
    ]);
    const record = await verify(structuredClone(pilot0), baseOptions(scenarios));
    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('accepts unchanged when no scenarios map is supplied (back-compat)', async () => {
    const record = await verify(structuredClone(pilot0), baseOptions(null));
    assert.equal(record.verification.status, 'accepted');
  });

  it('a scenario definition without success_criteria enforces nothing', async () => {
    const scenarios = new Map([['record-ingest-roundtrip', { steps: [] }]]);
    const record = await verify(structuredClone(pilot0), baseOptions(scenarios));
    assert.equal(record.verification.status, 'accepted');
  });
});

describe('F-3bfc2885: validateRequiredSteps rule-id attribution', () => {
  it('tags missing required steps with [step-results-present]', () => {
    const sr = { verdict: 'fail', step_results: [{ step_id: 'a', status: 'pass' }] };
    const errors = validateRequiredSteps(sr, ['a', 'b']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[step-results-present\] required step "b"/);
  });

  it('tags pass-verdict-with-failing-required-step with [step-verdict-consistent]', () => {
    const sr = {
      verdict: 'pass',
      step_results: [{ step_id: 'a', status: 'blocked' }]
    };
    const errors = validateRequiredSteps(sr, ['a']);
    assert.ok(errors.some(e => e.startsWith('[step-verdict-consistent]') && e.includes('"blocked"')));
  });

  it('tags pass-verdict-with-MISSING-required-step with both rule ids', () => {
    const sr = { verdict: 'pass', step_results: [{ step_id: 'a', status: 'pass' }] };
    const errors = validateRequiredSteps(sr, ['gone']);
    assert.ok(errors.some(e => e.startsWith('[step-results-present]')));
    assert.ok(errors.some(e => e.startsWith('[step-verdict-consistent]')));
  });
});
