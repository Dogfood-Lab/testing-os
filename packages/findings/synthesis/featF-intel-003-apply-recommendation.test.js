/**
 * featF-INTEL-003 — recommendations apply-back.
 *
 * `applyRecommendation(rootDir, { id, mode, actor, policyRepo })`:
 *   - Only an ACCEPTED recommendation is applicable; others refuse with a
 *     structured { code, message, hint } error.
 *   - mode 'dry-run' (default) renders the proposed change (action.type +
 *     target + details + the policy field it would touch). Writes nothing.
 *   - mode 'write' applies ONLY the structured intent where it is safe and
 *     unambiguous — add the `target` scenario/check id to the named policy's
 *     `surfaces.<surface>.required_scenarios` list — and records
 *     recommendation_id + details as provenance. The free-text `details` is
 *     NEVER injected as policy logic. If the action cannot be safely
 *     auto-applied (ambiguous target/surface, free-text-only intent), write
 *     REFUSES with a structured hint telling the operator to apply manually.
 *
 * TEST_ROOT temp dirs only — never the real policies tree.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { applyRecommendation } from './apply-recommendation.js';
import { getAllEvents } from '../review/event-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_apply_rec__');

function makeRec(overrides = {}) {
  return {
    schema_version: '1.0.0',
    recommendation_id: 'drec-featf-003',
    title: 'Add entrypoint-truth scenario to CLI rollout',
    status: 'accepted',
    recommendation_kind: 'starter_scenario',
    summary: 'New CLI repos should run the entrypoint-truth scenario before rollout assumptions are encoded.',
    applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
    based_on_pattern_ids: ['dpat-featf-001'],
    action: { type: 'add_scenario', target: 'entrypoint-truth-check', details: 'Run the entrypoint truth scenario for CLI repos.' },
    confidence: 'strong',
    review: { reviewed_by: 'mike', reviewed_at: '2026-06-13T00:00:00Z', last_action: 'accept' },
    ...overrides
  };
}

function writeRecFile(id, rec) {
  const d = resolve(TEST_ROOT, 'recommendations');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(rec, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function writePolicy(orgRepo, policy) {
  const [org, repo] = orgRepo.split('/');
  const d = resolve(TEST_ROOT, 'policies', 'repos', org);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${repo}.yaml`), yaml.dump(policy, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function readPolicy(orgRepo) {
  const [org, repo] = orgRepo.split('/');
  return yaml.load(readFileSync(resolve(TEST_ROOT, 'policies', 'repos', org, `${repo}.yaml`), 'utf-8'));
}

function basePolicy() {
  return {
    repo: 'mcp-tool-shop-org/widget',
    policy_version: '1.0.0',
    enforcement: { mode: 'required' },
    surfaces: {
      cli: {
        required_scenarios: ['install-and-run'],
        freshness: { max_age_days: 14, warn_age_days: 7 }
      }
    }
  };
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'recommendations'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'policies', 'repos'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('featF-INTEL-003: applicability gate', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('a candidate recommendation is NOT applicable — refused with structured error', () => {
    writeRecFile('drec-featf-003', makeRec({ status: 'candidate' }));
    const res = applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'dry-run' });
    assert.equal(res.success, false);
    assert.ok(res.error);
    assert.equal(res.error.code, 'RECOMMENDATION_NOT_ACCEPTED');
    assert.match(res.error.message, /accepted/i);
    assert.ok(res.error.hint);
  });

  it('unknown recommendation id refuses with a structured error', () => {
    const res = applyRecommendation(TEST_ROOT, { id: 'drec-nope', mode: 'dry-run' });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'RECOMMENDATION_NOT_FOUND');
  });
});

describe('featF-INTEL-003: dry-run preview (writes nothing)', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('renders the proposed change without touching the policy', () => {
    writeRecFile('drec-featf-003', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());

    const res = applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'dry-run', policyRepo: 'mcp-tool-shop-org/widget' });
    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.equal(res.applied, false, 'dry-run must not apply');
    assert.ok(res.preview, 'dry-run returns a preview');
    assert.equal(res.preview.actionType, 'add_scenario');
    assert.equal(res.preview.target, 'entrypoint-truth-check');
    assert.equal(res.preview.surface, 'cli');
    assert.match(res.preview.policyPath, /widget\.yaml$/);
    assert.match(res.preview.field, /required_scenarios/);

    // Policy on disk is unchanged.
    const policy = readPolicy('mcp-tool-shop-org/widget');
    assert.deepEqual(policy.surfaces.cli.required_scenarios, ['install-and-run']);
  });
});

describe('featF-INTEL-003: --write safe apply', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('adds the target scenario id to the named policy surface and records provenance', () => {
    writeRecFile('drec-featf-003', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());

    const res = applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });
    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.equal(res.applied, true);

    const policy = readPolicy('mcp-tool-shop-org/widget');
    assert.ok(policy.surfaces.cli.required_scenarios.includes('entrypoint-truth-check'),
      'the structured target id was added to required_scenarios');
    // The free-text details must NOT be injected as policy logic.
    assert.equal(JSON.stringify(policy).includes('Run the entrypoint truth scenario'), false,
      'free-text details must never be injected into the policy');

    // Provenance is recorded (on the policy as an applied-from marker).
    assert.ok(res.provenance);
    assert.equal(res.provenance.recommendation_id, 'drec-featf-003');
    assert.ok(res.provenance.details.includes('entrypoint truth'));
  });

  it('logs an apply event', () => {
    writeRecFile('drec-featf-003', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());
    applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });
    const events = getAllEvents(TEST_ROOT);
    const ev = events.find(e => e.artifact_id === 'drec-featf-003' && e.action === 'apply');
    assert.ok(ev, 'an apply event should be logged');
    assert.equal(ev.artifact_kind, 'recommendation');
  });

  it('is idempotent — re-applying does not duplicate the scenario id', () => {
    writeRecFile('drec-featf-003', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());
    applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });
    applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });
    const policy = readPolicy('mcp-tool-shop-org/widget');
    const count = policy.surfaces.cli.required_scenarios.filter(s => s === 'entrypoint-truth-check').length;
    assert.equal(count, 1, 'apply is idempotent');
  });
});

describe('featF-INTEL-003: honest refusal on ambiguous / free-text-only intent', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('a free-text-only action (no resolvable target) refuses on --write with a structured hint', () => {
    // set_policy with target 'policy' is the derived shape whose intent lives in
    // the free-text details — there is no structured id to safely apply.
    writeRecFile('drec-featf-003', makeRec({
      recommendation_kind: 'policy_seed',
      action: { type: 'set_policy', target: 'policy', details: 'Seed calibrated policy defaults for CLI repos.' }
    }));
    writePolicy('mcp-tool-shop-org/widget', basePolicy());

    const res = applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'RECOMMENDATION_NOT_AUTO_APPLICABLE');
    assert.match(res.error.hint, /manual|manually/i);

    // Policy untouched.
    const policy = readPolicy('mcp-tool-shop-org/widget');
    assert.deepEqual(policy.surfaces.cli.required_scenarios, ['install-and-run']);
  });

  it('write without a resolvable policy (no policyRepo) refuses with a structured hint', () => {
    writeRecFile('drec-featf-003', makeRec());
    const res = applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike' });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'RECOMMENDATION_AMBIGUOUS_TARGET');
    assert.ok(res.error.hint);
  });

  it('write against an ambiguous surface (recommendation applies to 2+ surfaces) refuses', () => {
    writeRecFile('drec-featf-003', makeRec({
      applies_to: { product_surfaces: ['cli', 'npm-package'], transfer_scope: 'surface_archetype' }
    }));
    writePolicy('mcp-tool-shop-org/widget', basePolicy());
    const res = applyRecommendation(TEST_ROOT, { id: 'drec-featf-003', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'RECOMMENDATION_AMBIGUOUS_TARGET');
  });
});
