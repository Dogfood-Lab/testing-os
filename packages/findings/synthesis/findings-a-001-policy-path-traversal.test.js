/**
 * findings-A-001 (sibling) — policyPathFor path-traversal guard.
 *
 * `applyRecommendation --write --policy <org/repo>` builds the on-disk policy
 * path via `policyPathFor(rootDir, orgRepo)`, which split on `/` and resolved
 * `policies/repos/<org>/<repo>.yaml` with no `isUnsafeSegment` guard. A
 * `--policy ../../foo` (or an org/repo containing `..`) escapes the policies
 * tree, letting an apply read/write a YAML file outside `policies/repos/`.
 *
 * AFTER FIX: a traversal `policyRepo` refuses with a structured
 * { code: 'RECOMMENDATION_UNSAFE_POLICY', message, hint } before any path is
 * resolved or file touched.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { applyRecommendation } from './apply-recommendation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_a001_policy_path__');

function makeRec(overrides = {}) {
  return {
    schema_version: '1.0.0',
    recommendation_id: 'drec-a001',
    title: 'Add entrypoint-truth scenario to CLI rollout',
    status: 'accepted',
    recommendation_kind: 'starter_scenario',
    summary: 'New CLI repos should run the entrypoint-truth scenario before rollout assumptions are encoded.',
    applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
    based_on_pattern_ids: ['dpat-a001'],
    action: { type: 'add_scenario', target: 'entrypoint-truth-check', details: 'Run the entrypoint truth scenario for CLI repos.' },
    confidence: 'strong',
    review: { reviewed_by: 'mike', reviewed_at: '2026-06-21T00:00:00Z', last_action: 'accept' },
    ...overrides
  };
}

function writeRecFile(id, rec) {
  const d = resolve(TEST_ROOT, 'recommendations');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(rec, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'recommendations'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'policies', 'repos'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('findings-A-001: applyRecommendation rejects path-traversal policyRepo', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('--write with a traversal policyRepo refuses with RECOMMENDATION_UNSAFE_POLICY', () => {
    writeRecFile('drec-a001', makeRec());
    const res = applyRecommendation(TEST_ROOT, {
      id: 'drec-a001',
      mode: 'write',
      actor: 'mike',
      policyRepo: '../../etc',
    });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'RECOMMENDATION_UNSAFE_POLICY');
    assert.ok(res.error.hint);
  });

  it('dry-run with a traversal policyRepo also refuses (no path leaked in preview)', () => {
    writeRecFile('drec-a001', makeRec());
    const res = applyRecommendation(TEST_ROOT, {
      id: 'drec-a001',
      mode: 'dry-run',
      policyRepo: 'org/..',
    });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'RECOMMENDATION_UNSAFE_POLICY');
  });

  it('a well-formed policyRepo still resolves (guard does not regress the happy path)', () => {
    writeRecFile('drec-a001', makeRec());
    const res = applyRecommendation(TEST_ROOT, {
      id: 'drec-a001',
      mode: 'dry-run',
      policyRepo: 'mcp-tool-shop-org/widget',
    });
    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.match(res.preview.policyPath, /widget\.yaml$/);
  });
});
