/**
 * f-find-001-002-write-gates.test.js — on-disk write gates for the review
 * engine's finding writers.
 *
 * F-FIND-001 (schema gate): `performAction` and `performMerge` persist the
 * mutated finding via `atomicWriteFileSync` with NO schema re-validation. Every
 * sibling writer (derive `writeFinding`, synthesis `writePattern` /
 * `writeRecommendation` / `writeDoctrine`) validates BEFORE the filesystem
 * touch — "no path can persist a malformed finding." The review engine was the
 * only on-disk finding writer missing the gate, so an operator edit with a
 * typo'd enum or an unknown field silently corrupted the canonical store.
 *
 *   Invariant: an `edit` that would produce a schema-invalid finding is refused
 *   with `{ success: false }` AND the on-disk YAML is byte-for-byte unchanged.
 *
 * F-FIND-002 (event/artifact desync): the artifact was persisted BEFORE its
 * review event was appended. A failure in `appendEvent` between the two left a
 * state change on disk with no audit event — an integrity gap in the
 * append-only trail the package advertises. The fix appends the event BEFORE
 * the artifact write, so a failed append surfaces a structured error and the
 * state change never lands without its audit event.
 *
 *   Invariant: when the event append fails, `performAction` reports failure AND
 *   the finding's status on disk is unchanged (no silent desync).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { performAction, performMerge } from './review-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_find_001_002__');

function makeTestFinding(overrides = {}) {
  return {
    schema_version: '1.0.0',
    finding_id: 'dfind-test-gate',
    title: 'Test finding for write-gate regressions',
    status: 'reviewed',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'repo_local',
    summary: 'Test finding for write-gate regression coverage and schema enforcement.',
    source_record_ids: ['test-record-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-record-001', note: 'Test evidence.' }],
    created_at: '2026-03-29T12:00:00Z',
    updated_at: '2026-03-29T12:00:00Z',
    ...overrides
  };
}

function findingPath(findingId, repo = 'mcp-tool-shop-org/test-repo') {
  const [org, repoName] = repo.split('/');
  return resolve(TEST_ROOT, 'findings', org, repoName, `${findingId}.yaml`);
}

function writeFindingToTestRoot(finding) {
  const path = findingPath(finding.finding_id, finding.repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
  return path;
}

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'findings'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('F-FIND-001: performAction schema-gates on-disk finding writes', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('refuses an edit with a bad enum value and leaves the file unchanged', () => {
    const path = writeFindingToTestRoot(makeTestFinding());
    const before = readFileSync(path, 'utf-8');

    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-gate',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { issue_kind: 'not-a-real-enum-value' }
    });

    assert.equal(result.success, false, 'edit with bad enum must be refused');
    assert.ok(result.error, 'a structured error must be returned');

    const after = readFileSync(path, 'utf-8');
    assert.equal(after, before, 'on-disk YAML must be byte-for-byte unchanged after a refused edit');
  });

  it('refuses an edit that introduces an unknown field and leaves the file unchanged', () => {
    const path = writeFindingToTestRoot(makeTestFinding());
    const before = readFileSync(path, 'utf-8');

    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-gate',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { totally_unknown_field: 'whatever' }
    });

    assert.equal(result.success, false, 'edit adding an unknown field must be refused (additionalProperties:false)');
    assert.ok(result.error, 'a structured error must be returned');

    const after = readFileSync(path, 'utf-8');
    assert.equal(after, before, 'on-disk YAML must be byte-for-byte unchanged after a refused edit');
  });

  it('a valid edit still succeeds and persists (back-compat)', () => {
    writeFindingToTestRoot(makeTestFinding());
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-gate',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { root_cause_kind: 'interface_assumption_error' }
    });
    assert.ok(result.success, result.error);
    const onDisk = yaml.load(readFileSync(findingPath('dfind-test-gate'), 'utf-8'));
    assert.equal(onDisk.root_cause_kind, 'interface_assumption_error');
  });
});

describe('F-FIND-001: performMerge schema-gates the canonical write', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('refuses a merge whose canonical would be schema-invalid and leaves canonical unchanged', () => {
    // Seed two mergeable findings, then corrupt the canonical's enum on disk so
    // the merge re-write would persist a schema-invalid canonical.
    writeFindingToTestRoot(makeTestFinding({
      finding_id: 'dfind-merge-a',
      status: 'candidate',
      issue_kind: 'not-a-real-enum-value',
      source_record_ids: ['rec-a'],
      evidence: [{ evidence_kind: 'record', record_id: 'rec-a', note: 'A' }]
    }));
    writeFindingToTestRoot(makeTestFinding({
      finding_id: 'dfind-merge-b',
      status: 'candidate',
      source_record_ids: ['rec-b'],
      evidence: [{ evidence_kind: 'record', record_id: 'rec-b', note: 'B' }]
    }));

    const canonPath = findingPath('dfind-merge-a');
    const before = readFileSync(canonPath, 'utf-8');

    const result = performMerge(TEST_ROOT, {
      sourceIds: ['dfind-merge-a', 'dfind-merge-b'],
      canonicalId: 'dfind-merge-a',
      actor: 'mike',
      reason: 'Same lesson from overlapping evidence.'
    });

    assert.equal(result.success, false, 'merge producing an invalid canonical must be refused');
    assert.ok(result.error, 'a structured error must be returned');

    const after = readFileSync(canonPath, 'utf-8');
    assert.equal(after, before, 'canonical YAML must be unchanged when the merge is refused');
  });
});

describe('F-FIND-002: state change and audit event cannot silently desync', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('a failed event append surfaces an error and does not leave a state change without its audit event', () => {
    const path = writeFindingToTestRoot(makeTestFinding({ status: 'candidate' }));

    // Force appendEvent to fail by making the reviews/ path un-creatable:
    // plant a regular FILE where the reviews/<YYYY> directory tree must be
    // mkdir'd, so mkdirSync(dir, { recursive:true }) inside appendEvent throws
    // ENOTDIR/EEXIST. This is a realistic IO failure between the two writes.
    const reviewsBlocker = resolve(TEST_ROOT, 'reviews');
    writeFileSync(reviewsBlocker, 'not a directory', 'utf-8');

    let threw = false;
    let result;
    try {
      result = performAction(TEST_ROOT, {
        findingId: 'dfind-test-gate',
        action: 'accept',
        actor: 'mike',
        reason: 'Evidence is strong and portable.'
      });
    } catch {
      threw = true;
    }

    // Either contract is acceptable per the finding: a structured failure
    // return OR a thrown error — what is NOT acceptable is a silent success
    // with the artifact persisted but no audit event.
    if (!threw) {
      assert.equal(result.success, false, 'a failed event append must not report success');
    }

    const onDisk = yaml.load(readFileSync(path, 'utf-8'));
    assert.equal(
      onDisk.status,
      'candidate',
      'status must NOT be persisted to disk when the audit event could not be appended'
    );
  });
});
