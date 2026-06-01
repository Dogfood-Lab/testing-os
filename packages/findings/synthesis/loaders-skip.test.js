/**
 * loaders-skip.test.js — H2 invariants: silent-loader closure for the synthesis
 * package siblings (F-721047-010 family).
 *
 * Covers:
 *   - `loadAcceptedPatterns(rootDir)` in recommendation-derivation.js
 *   - `loadPatterns(rootDir)` / `loadRecommendations(rootDir)` /
 *     `loadDoctrines(rootDir)` (all calling `loadArtifacts(dir)` in write-artifacts.js)
 *
 * AT HEAD: both call sites wrap the parse step in a silent `try { … } catch { /* skip * / }`.
 * Torn YAML files disappear with no signal.
 *
 * AFTER FIX: each loader emits an explicit warning to `console.error` for
 * every torn file (which the test captures), and a sibling structured API
 * (`loadAcceptedPatternsWithSkips`, `loadPatternsWithSkips`, etc.) returns
 * `{ entries, skipped }`. The legacy array-shape callers continue to work.
 *
 * Each test seeds one good + one torn YAML and asserts:
 *   - The good entry surfaces (array).
 *   - The torn file is reported via the *WithSkips API (skipped[]).
 *   - The legacy API does not throw.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import {
  loadAcceptedPatterns,
  loadAcceptedPatternsWithSkips,
} from './recommendation-derivation.js';

import {
  loadPatterns,
  loadRecommendations,
  loadDoctrines,
  loadPatternsWithSkips,
  loadRecommendationsWithSkips,
  loadDoctrinesWithSkips,
} from './write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_loaders_skip__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

const TORN_YAML = 'this: : invalid yaml ::\n  : :\n';

function writeYamlFile(dirPath, fileName, obj) {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(resolve(dirPath, fileName), yaml.dump(obj, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function writeTornFile(dirPath, fileName) {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(resolve(dirPath, fileName), TORN_YAML, 'utf-8');
}

// ============================================================
// recommendation-derivation.js — loadAcceptedPatterns
// ============================================================

describe('loadAcceptedPatterns — H2 silent-loader closure (F-721047-010)', () => {
  before(setup);
  after(teardown);

  it('surfaces good accepted patterns AND reports torn pattern files in skipped', () => {
    const root = resolve(TEST_ROOT, 'rec');
    const patternsDir = resolve(root, 'patterns');

    writeYamlFile(patternsDir, 'dpat-good.yaml', {
      pattern_id: 'dpat-good',
      status: 'accepted',
      pattern_kind: 'evidence_calibration',
      dimensions: { product_surfaces: ['cli'], issue_kinds: ['evidence_insufficiency'] },
      support: { repo_count: 2, finding_count: 5 },
      transfer_scope: 'surface_archetype',
    });
    writeYamlFile(patternsDir, 'dpat-not-accepted.yaml', {
      pattern_id: 'dpat-not-accepted',
      status: 'candidate',
    });
    writeTornFile(patternsDir, 'dpat-torn.yaml');

    // Legacy array API — only accepted patterns, no throw.
    const patterns = loadAcceptedPatterns(root);
    assert.equal(patterns.length, 1, 'one accepted pattern surfaces');
    assert.equal(patterns[0].pattern_id, 'dpat-good');

    // New structured API — surfaces the torn file as a skip.
    const { entries, skipped } = loadAcceptedPatternsWithSkips(root);
    assert.equal(entries.length, 1, 'one accepted entry');
    assert.equal(skipped.length, 1, 'torn file reported');
    assert.match(skipped[0].path, /dpat-torn\.yaml$/);
    assert.match(skipped[0].error, /YAML parse error/);
  });
});

// ============================================================
// write-artifacts.js — loadArtifacts (via loadPatterns/Recs/Doctrines)
// ============================================================

describe('write-artifacts loaders — H2 silent-loader closure (F-721047-010)', () => {
  before(setup);
  after(teardown);

  it('loadPatterns surfaces good entries AND reports torn YAML in skipped', () => {
    const root = resolve(TEST_ROOT, 'pats');
    const dir = resolve(root, 'patterns');
    writeYamlFile(dir, 'a.yaml', { pattern_id: 'dpat-a' });
    writeTornFile(dir, 'b-torn.yaml');

    const arr = loadPatterns(root);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].pattern_id, 'dpat-a');

    const { entries, skipped } = loadPatternsWithSkips(root);
    assert.equal(entries.length, 1);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].path, /b-torn\.yaml$/);
  });

  it('loadRecommendations surfaces good entries AND reports torn YAML in skipped', () => {
    const root = resolve(TEST_ROOT, 'recs');
    const dir = resolve(root, 'recommendations');
    writeYamlFile(dir, 'a.yaml', { recommendation_id: 'drec-a' });
    writeTornFile(dir, 'b-torn.yaml');

    const arr = loadRecommendations(root);
    assert.equal(arr.length, 1);

    const { entries, skipped } = loadRecommendationsWithSkips(root);
    assert.equal(entries.length, 1);
    assert.equal(skipped.length, 1);
  });

  it('loadDoctrines surfaces good entries AND reports torn YAML in skipped', () => {
    const root = resolve(TEST_ROOT, 'docs');
    const dir = resolve(root, 'doctrine');
    writeYamlFile(dir, 'a.yaml', { doctrine_id: 'ddoct-a' });
    writeTornFile(dir, 'b-torn.yaml');

    const arr = loadDoctrines(root);
    assert.equal(arr.length, 1);

    const { entries, skipped } = loadDoctrinesWithSkips(root);
    assert.equal(entries.length, 1);
    assert.equal(skipped.length, 1);
  });
});
