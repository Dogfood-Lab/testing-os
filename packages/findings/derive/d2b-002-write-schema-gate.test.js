/**
 * d2b-002-write-schema-gate.test.js — fail-closed schema gate on the
 * library-path writers.
 *
 * AT HEAD (Stage B advisor-verified): `writeFinding(rootDir, finding)` does
 * NOT validate against `dogfood-finding.schema.json` before writing — only
 * the CLI gates (`derive.js:383`). A programmatic caller can therefore
 * persist a malformed finding to disk, which then breaks every downstream
 * consumer that assumes schema conformance. The sibling writers
 * (`writePattern`/`writeRecommendation`/`writeDoctrine`) are WORSE — they
 * have no CLI validation either, so even CLI invocations can persist
 * malformed pattern/recommendation/doctrine YAML.
 *
 * AFTER FIX: each library-path writer validates the payload BEFORE touching
 * the filesystem. Validation failure throws a structured error whose `code`
 * is `FINDING_SCHEMA_INVALID` / `PATTERN_SCHEMA_INVALID` /
 * `RECOMMENDATION_SCHEMA_INVALID` / `DOCTRINE_SCHEMA_INVALID`. The shape
 * mirrors `RecordValidationError` in @dogfood-lab/ingest/validate-record.js
 * — a typed error class with `.code` so callers can pattern-match without
 * substring grep on `.message`.
 *
 * Test invariant: programmatic call with a malformed finding/pattern/
 * recommendation/doctrine throws the structured error AND does NOT write
 * to disk (no orphan file).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';

import { writeFinding } from './write-findings.js';
import { writePattern, writeRecommendation, writeDoctrine } from '../synthesis/write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_d2b_002_schema_gate__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile())
    .length;
}

describe('D2B-002: writeFinding schema-gates malformed findings', () => {
  before(setup);
  after(teardown);

  it('throws FINDING_SCHEMA_INVALID for malformed finding; no file written', () => {
    const root = resolve(TEST_ROOT, 'finding-schema');
    mkdirSync(root, { recursive: true });

    // Malformed: missing title + summary, status not in enum, etc.
    const bad = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-malformed-001',
      // title MISSING
      status: 'not-a-real-status',
      repo: 'org/repo',
      // summary MISSING
      // many other required fields missing
    };

    assert.throws(
      () => writeFinding(root, bad),
      err => {
        assert.equal(err.code, 'FINDING_SCHEMA_INVALID', 'structured error code');
        assert.equal(err.name, 'FindingValidationError', 'typed error class');
        assert.ok(Array.isArray(err.errors), 'errors array carried for debugging');
        assert.ok(err.errors.length > 0, 'at least one validation error reported');
        return true;
      }
    );

    // No orphan file landed on disk.
    const findingsDir = resolve(root, 'findings');
    assert.equal(countFiles(findingsDir), 0, 'no finding file written on schema failure');
  });

  it('valid finding still writes successfully (back-compat)', () => {
    const root = resolve(TEST_ROOT, 'finding-ok');
    mkdirSync(root, { recursive: true });

    const ok = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-ok-001',
      title: 'D2B-002 happy-path fixture',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'surface_archetype',
      summary: 'Valid finding for happy-path counter-test of D2B-002.',
      source_record_ids: ['test-001'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-001' }],
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };

    const path = writeFinding(root, ok);
    assert.ok(existsSync(path), 'valid finding lands on disk');
  });
});

describe('D2B-002 siblings: pattern/recommendation/doctrine schema gates', () => {
  before(setup);
  after(teardown);

  it('writePattern throws PATTERN_SCHEMA_INVALID for malformed pattern; no file written', () => {
    const root = resolve(TEST_ROOT, 'pattern-schema');
    mkdirSync(root, { recursive: true });

    const bad = {
      schema_version: '1.0.0',
      pattern_id: 'dpat-malformed-001',
      // title MISSING
      status: 'candidate',
      // summary missing
      // many required fields missing
    };

    assert.throws(
      () => writePattern(root, bad),
      err => {
        assert.equal(err.code, 'PATTERN_SCHEMA_INVALID');
        assert.equal(err.name, 'PatternValidationError');
        return true;
      }
    );

    const patternsDir = resolve(root, 'patterns');
    assert.equal(countFiles(patternsDir), 0, 'no pattern file on schema failure');
  });

  it('writeRecommendation throws RECOMMENDATION_SCHEMA_INVALID for malformed; no file', () => {
    const root = resolve(TEST_ROOT, 'rec-schema');
    mkdirSync(root, { recursive: true });

    const bad = {
      schema_version: '1.0.0',
      recommendation_id: 'drec-malformed-001',
      // many required fields missing
      status: 'not-a-real-status',
    };

    assert.throws(
      () => writeRecommendation(root, bad),
      err => {
        assert.equal(err.code, 'RECOMMENDATION_SCHEMA_INVALID');
        assert.equal(err.name, 'RecommendationValidationError');
        return true;
      }
    );

    const recsDir = resolve(root, 'recommendations');
    assert.equal(countFiles(recsDir), 0, 'no recommendation file on schema failure');
  });

  it('writeDoctrine throws DOCTRINE_SCHEMA_INVALID for malformed; no file', () => {
    const root = resolve(TEST_ROOT, 'doc-schema');
    mkdirSync(root, { recursive: true });

    const bad = {
      schema_version: '1.0.0',
      doctrine_id: 'ddoc-malformed-001',
      status: 'not-a-real-status',
      // many required fields missing
    };

    assert.throws(
      () => writeDoctrine(root, bad),
      err => {
        assert.equal(err.code, 'DOCTRINE_SCHEMA_INVALID');
        assert.equal(err.name, 'DoctrineValidationError');
        return true;
      }
    );

    const docDir = resolve(root, 'doctrine');
    assert.equal(countFiles(docDir), 0, 'no doctrine file on schema failure');
  });

  it('valid pattern/recommendation/doctrine still write successfully (back-compat)', () => {
    const root = resolve(TEST_ROOT, 'siblings-ok');
    mkdirSync(root, { recursive: true });

    const okPattern = {
      schema_version: '1.0.0',
      pattern_id: 'dpat-ok-001',
      title: 'Valid pattern',
      status: 'candidate',
      pattern_kind: 'recurring_failure',
      summary: 'Valid pattern summary spanning enough characters for the schema.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 1, surface_count: 1 },
      dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
      transfer_scope: 'surface_archetype',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
    const okRec = {
      schema_version: '1.0.0',
      recommendation_id: 'drec-ok-001',
      title: 'Valid recommendation',
      status: 'candidate',
      recommendation_kind: 'starter_check',
      summary: 'Valid recommendation summary spanning enough characters.',
      based_on_pattern_ids: ['dpat-x'],
      applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
      action: { type: 'add_check', target: 'rollout', details: 'Test action details' },
      confidence: 'emerging',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
    const okDoc = {
      schema_version: '1.0.0',
      doctrine_id: 'ddoc-ok-001',
      title: 'Valid doctrine',
      status: 'candidate',
      doctrine_kind: 'rollout_law',
      statement: 'A valid doctrine statement spanning enough characters for the schema.',
      rationale: 'Rationale spanning enough characters to satisfy the doctrine schema.',
      based_on_pattern_ids: ['dpat-x'],
      transfer_scope: 'surface_archetype',
      strength: 'proven',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };

    const p1 = writePattern(root, okPattern);
    const p2 = writeRecommendation(root, okRec);
    const p3 = writeDoctrine(root, okDoc);
    assert.ok(existsSync(p1));
    assert.ok(existsSync(p2));
    assert.ok(existsSync(p3));
  });
});
