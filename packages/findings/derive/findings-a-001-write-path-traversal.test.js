/**
 * findings-A-001 — write-side path-traversal guard.
 *
 * The READ side (`loadRecordsForRepoWithSkips`, load-records.js) rejects an
 * org/repo segment containing `..` or a path separator via `isUnsafeSegment`.
 * The WRITE side did NOT: `writeFinding` split `finding.repo` into org/repo
 * and built `resolve(rootDir, 'findings', org, repo)` with no guard. The
 * dogfood-finding schema's `repo` pattern admits `.` and `..`, so
 * `repo: '../policies'` is schema-valid and escapes one level under rootDir
 * (into policies/, indexes/, reports/). Same gap in `policyPathFor`
 * (apply-recommendation.js), fed by `--policy <org/repo>`.
 *
 * AFTER FIX: a finding whose repo contains `..` is REJECTED before any path
 * is built; nothing is written outside `findings/`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';

import { writeFinding, writeFindings, resetSeenWrites } from './write-findings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_findings_a_001__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

/** Build a schema-valid finding whose repo segment is the attack payload. */
function makeFinding(repo, findingId = 'dfind-traversal-fixture') {
  return {
    schema_version: '1.0.0',
    finding_id: findingId,
    title: 'findings-A-001 traversal fixture finding',
    status: 'candidate',
    repo,
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'surface_archetype',
    summary: 'Traversal fixture summary spanning enough characters to satisfy the schema.',
    source_record_ids: ['test-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-001' }],
    derived: {
      method: 'deterministic_rule',
      rule_id: 'rule-test',
      derived_at: '2026-06-21T00:00:00.000Z',
      rationale: 'Traversal fixture rationale.',
    },
    created_at: '2026-06-21T00:00:00.000Z',
    updated_at: '2026-06-21T00:00:00.000Z',
  };
}

describe('findings-A-001: writeFinding rejects path-traversal repo segments', () => {
  before(setup);
  after(teardown);

  it('REJECTS a finding whose repo org/repo contains ".." (no write outside findings/)', () => {
    const root = resolve(TEST_ROOT, 'reject-dotdot');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    // `../policies` is schema-valid (two segments matching the repo pattern),
    // and escapes one level under rootDir into policies/.
    const finding = makeFinding('../policies', 'dfind-escape-policies');

    assert.throws(
      () => writeFinding(root, finding),
      err => {
        assert.equal(err.code, 'FINDING_UNSAFE_REPO');
        return true;
      },
      'writeFinding must reject a traversal repo segment with a structured error'
    );

    // Nothing wrote anywhere under root (not findings/, not policies/, etc.).
    const stray = existsSync(root) ? readdirSync(root) : [];
    assert.deepEqual(stray, [], 'no directories created for a rejected traversal write');
  });

  it('REJECTS when the repo path component carries a traversal segment', () => {
    const root = resolve(TEST_ROOT, 'reject-nested');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    const finding = makeFinding('org/..', 'dfind-escape-nested');
    assert.throws(
      () => writeFinding(root, finding),
      err => err.code === 'FINDING_UNSAFE_REPO'
    );
  });

  it('writeFindings surfaces the traversal rejection in errors[] (not thrown out of the batch)', () => {
    const root = resolve(TEST_ROOT, 'batch-reject');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    const safe = makeFinding('mcp-tool-shop-org/widget', 'dfind-safe-one');
    const evil = makeFinding('../policies', 'dfind-evil-two');

    const { written, errors } = writeFindings(root, [safe, evil]);
    assert.equal(written.length, 1, 'the safe finding still writes');
    assert.equal(errors.length, 1, 'the traversal finding is refused');
    assert.equal(errors[0].code, 'FINDING_UNSAFE_REPO');
  });

  it('a well-formed repo still writes cleanly (guard does not regress the happy path)', () => {
    const root = resolve(TEST_ROOT, 'happy');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    const finding = makeFinding('mcp-tool-shop-org/widget', 'dfind-happy-path');
    const path = writeFinding(root, finding);
    assert.ok(existsSync(path), 'well-formed finding writes to findings/<org>/<repo>/');
    assert.match(path, /findings[/\\]mcp-tool-shop-org[/\\]widget[/\\]/);
  });

  it('dotted org/repo names (e.g. next.js) remain legal — single dots are not traversal', () => {
    const root = resolve(TEST_ROOT, 'dotted');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    const finding = makeFinding('vercel/next.js', 'dfind-dotted-legal');
    const path = writeFinding(root, finding);
    assert.ok(existsSync(path), 'a legitimately dotted repo name still writes');
  });
});
