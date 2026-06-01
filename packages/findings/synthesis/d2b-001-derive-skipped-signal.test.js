/**
 * d2b-001-derive-skipped-signal.test.js — surface `{skipped}` through the
 * derive API return shape and the CLI.
 *
 * AT HEAD (Stage B advisor-verified): `deriveRecommendations(rootDir)` and
 * `deriveDoctrine(rootDir)` call `loadAcceptedPatterns(rootDir)` which under
 * the hood now delegates to `loadAcceptedPatternsWithSkips` BUT discards the
 * `skipped` list. The `WithSkips` variants exist (`safe-yaml-load` family,
 * Wave A1 closure) but the derive API surface is the legacy array — a torn
 * pattern that WOULD have been considered for recommendation/doctrine
 * synthesis silently vanishes with no signal at the operator surface.
 *
 * AFTER FIX: `deriveRecommendations(rootDir)` and `deriveDoctrine(rootDir)`
 * each return a `skipped: [{ path, error }]` field alongside the existing
 * `recommendations` / `doctrines` + `stats`. Legacy consumers who only read
 * `result.recommendations` or `result.doctrines` see no change (back-compat
 * preserved). New consumers (CLI, audit tooling) read `result.skipped` and
 * surface a structured operator message:
 *
 *   "N patterns skipped (torn/unreadable): <comma-separated paths>"
 *
 * The CLI emits this to stderr so it appears in CI logs without
 * suppressing the success exit code (the derivation still runs against the
 * clean patterns — partial-completion is documented honestly).
 *
 * Counter-test: torn-free pattern dir → `skipped` is an empty array.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { deriveRecommendations } from './recommendation-derivation.js';
import { deriveDoctrine } from './doctrine-derivation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_d2b_001_skip_signal__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'patterns'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

function writePatternFile(rootDir, fileName, data) {
  writeFileSync(resolve(rootDir, 'patterns', fileName), yaml.dump(data), 'utf-8');
}

function writeTornPatternFile(rootDir, fileName) {
  writeFileSync(resolve(rootDir, 'patterns', fileName), 'this: is: not valid yaml: [', 'utf-8');
}

function makeAcceptedPattern(id) {
  return {
    schema_version: '1.0.0',
    pattern_id: id,
    title: 'Test pattern for D2B-001',
    status: 'accepted',
    pattern_kind: 'rollout_calibration',
    summary: 'Test pattern summary spanning enough characters for the schema.',
    source_finding_ids: ['dfind-test-a', 'dfind-test-b'],
    support: { finding_count: 2, repo_count: 2, surface_count: 1 },
    dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'], root_cause_kinds: ['contract_drift'] },
    transfer_scope: 'surface_archetype',
    pattern_strength: 'strong',
    created_at: '2026-05-31T00:00:00.000Z',
    updated_at: '2026-05-31T00:00:00.000Z',
  };
}

describe('D2B-001: deriveRecommendations surfaces skipped torn patterns', () => {
  before(setup);
  after(() => {
    if (existsSync(TEST_ROOT)) {
      try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* drop */ }
    }
  });

  it('returns skipped[] for torn pattern files; legacy recommendations array still populates', () => {
    const root = resolve(TEST_ROOT, 'recs-with-torn');
    mkdirSync(resolve(root, 'patterns'), { recursive: true });

    writePatternFile(root, 'good.yaml', makeAcceptedPattern('dpat-good-001'));
    writeTornPatternFile(root, 'torn.yaml');

    const result = deriveRecommendations(root);

    // Legacy contract preserved.
    assert.ok(Array.isArray(result.recommendations), 'recommendations[] still present');
    assert.ok(result.stats, 'stats still present');
    assert.equal(result.stats.patternsConsidered, 1, 'only the good pattern reached the synthesis loop');

    // New structured-skip contract.
    assert.ok(Array.isArray(result.skipped), 'skipped[] present on return shape');
    assert.equal(result.skipped.length, 1, 'one torn pattern reported');
    assert.match(result.skipped[0].path, /torn\.yaml$/, 'skipped record carries the path');
    assert.match(result.skipped[0].error, /YAML parse error/i, 'structured error string');
  });

  // Counter-test — back-compat.
  it('no torn files: skipped[] is an empty array (back-compat for legacy consumers)', () => {
    const root = resolve(TEST_ROOT, 'recs-no-torn');
    mkdirSync(resolve(root, 'patterns'), { recursive: true });
    writePatternFile(root, 'good.yaml', makeAcceptedPattern('dpat-good-only-001'));

    const result = deriveRecommendations(root);
    assert.ok(Array.isArray(result.skipped), 'skipped[] always present (back-compat: type-stable)');
    assert.equal(result.skipped.length, 0, 'no torn patterns → empty skipped');
    assert.equal(result.stats.patternsConsidered, 1);
  });
});

describe('D2B-001: deriveDoctrine surfaces skipped torn patterns', () => {
  before(setup);
  after(() => {
    if (existsSync(TEST_ROOT)) {
      try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* drop */ }
    }
  });

  it('returns skipped[] for torn pattern files; legacy doctrines array still populates', () => {
    const root = resolve(TEST_ROOT, 'doc-with-torn');
    mkdirSync(resolve(root, 'patterns'), { recursive: true });

    writePatternFile(root, 'good.yaml', makeAcceptedPattern('dpat-good-002'));
    writeTornPatternFile(root, 'torn.yaml');

    const result = deriveDoctrine(root);

    // Legacy contract preserved.
    assert.ok(Array.isArray(result.doctrines), 'doctrines[] still present');
    assert.ok(result.stats, 'stats still present');

    // New structured-skip contract.
    assert.ok(Array.isArray(result.skipped), 'skipped[] present on return shape');
    assert.equal(result.skipped.length, 1, 'one torn pattern reported');
    assert.match(result.skipped[0].path, /torn\.yaml$/);
    assert.match(result.skipped[0].error, /YAML parse error/i);
  });

  it('no torn files: skipped[] is empty (back-compat)', () => {
    const root = resolve(TEST_ROOT, 'doc-no-torn');
    mkdirSync(resolve(root, 'patterns'), { recursive: true });
    writePatternFile(root, 'good.yaml', makeAcceptedPattern('dpat-clean-only-001'));

    const result = deriveDoctrine(root);
    assert.ok(Array.isArray(result.skipped));
    assert.equal(result.skipped.length, 0);
  });
});
