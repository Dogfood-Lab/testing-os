/**
 * h4-engine-auto-reject-reason.test.js — H4 partner half: the review
 * engine MUST populate `review.reject_reason` whenever an action drives the
 * finding's status to `rejected`, not only for `action === 'reject'`.
 *
 * AT HEAD: `review-engine.js performAction` line 110 sets
 *   `...(params.rejectReason && action === 'reject' ? { reject_reason: params.rejectReason } : {})`
 * For `supersede` (and merge → supersede via performMerge), the engine
 * does NOT supply a reject_reason. The resulting finding has
 * `status === 'rejected'` AND `review.reject_reason === undefined`. The
 * H4 schema fix would reject that finding at the contract boundary; the
 * engine quietly produces an artifact that would fail validation.
 *
 * AFTER FIX: when the target status is 'rejected' and the operator didn't
 * supply a structured rejectReason, the engine auto-populates it based on
 * the action:
 *   - merge → 'merged_into_canonical'
 *   - supersede → 'merged_into_canonical' (the supersede is the
 *     non-canonical side of a merge; lineage already carries superseded_by)
 *   - reject → operator-supplied; if missing, engine fails closed
 *
 * Test seeds a candidate finding, calls performAction with action='supersede',
 * and asserts the finding now has `review.reject_reason ===
 * 'merged_into_canonical'` AND validates against the schema with the H4 if/then.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { performAction, performMerge } from './review-engine.js';
import { validateFinding } from '../validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_h4_engine__');

function makeFinding(overrides = {}) {
  return {
    schema_version: '1.0.0',
    finding_id: 'dfind-h4-engine-test',
    title: 'H4 engine test finding for auto-populate reject_reason',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'repo_local',
    summary: 'A test finding for exercising the H4 engine auto-populate invariant.',
    source_record_ids: ['test-record-h4'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-record-h4' }],
    created_at: '2026-05-31T12:00:00Z',
    updated_at: '2026-05-31T12:00:00Z',
    ...overrides,
  };
}

function writeFindingTo(rootDir, finding) {
  const [org, repo] = finding.repo.split('/');
  const dir = resolve(rootDir, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${finding.finding_id}.yaml`);
  writeFileSync(path, yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
  return path;
}

function readBackFinding(rootDir, finding) {
  const [org, repo] = finding.repo.split('/');
  const path = resolve(rootDir, 'findings', org, repo, `${finding.finding_id}.yaml`);
  return yaml.load(readFileSync(path, 'utf-8'));
}

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('H4 engine — auto-populate review.reject_reason on supersede/merge', () => {
  beforeEach(setup);
  after(teardown);

  it('supersede populates review.reject_reason="merged_into_canonical" automatically', () => {
    writeFindingTo(TEST_ROOT, makeFinding({ status: 'accepted' }));

    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-h4-engine-test',
      action: 'supersede',
      actor: 'tester',
      reason: 'replaced by stronger canonical version',
      supersededBy: 'dfind-h4-canonical',
    });

    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'rejected', 'supersede transitions to rejected');
    assert.equal(
      result.finding.review.reject_reason,
      'merged_into_canonical',
      'engine auto-populates reject_reason on supersede'
    );

    // And the persisted artifact validates against the H4 schema if/then.
    const onDisk = readBackFinding(TEST_ROOT, makeFinding());
    const validation = validateFinding(onDisk);
    assert.equal(
      validation.valid,
      true,
      `superseded finding must satisfy H4 if/then. Errors: ${JSON.stringify(validation.errors)}`
    );
  });

  it('explicit rejectReason on supersede is preserved (operator override wins)', () => {
    writeFindingTo(TEST_ROOT, makeFinding({ status: 'accepted' }));

    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-h4-engine-test',
      action: 'supersede',
      actor: 'tester',
      reason: 'duplicate that was originally classified wrong',
      supersededBy: 'dfind-h4-canonical',
      rejectReason: 'duplicate',
    });

    assert.ok(result.success, result.error);
    assert.equal(result.finding.review.reject_reason, 'duplicate', 'operator-supplied rejectReason wins');
  });

  it('reject still requires operator-supplied rejectReason (no silent default)', () => {
    // The H4 fix is "auto-populate when reasonable defaults exist." For
    // explicit reject, defaulting would erase the operator's intent —
    // they should pass insufficient_evidence / noise / etc. The engine
    // should still NOT invent one in that case.
    writeFindingTo(TEST_ROOT, makeFinding({ status: 'candidate' }));

    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-h4-engine-test',
      action: 'reject',
      actor: 'tester',
      reason: 'operator manual reject without structured tag',
      // rejectReason intentionally omitted
    });

    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'rejected');
    // No silent default — the engine populates undefined here, and the
    // resulting persisted finding would fail H4 schema validation. The
    // operator must learn to pass rejectReason. (We assert by the absence
    // of reject_reason; the schema enforcement is in findings.test.js's
    // separate H4 case.)
    assert.equal(
      result.finding.review.reject_reason,
      undefined,
      'explicit reject without rejectReason still leaves the field undefined; operator must supply one'
    );
  });

  it('performMerge marks non-canonical sources rejected with reject_reason="merged_into_canonical"', () => {
    writeFindingTo(TEST_ROOT, makeFinding({ finding_id: 'dfind-h4-source-a', status: 'candidate' }));
    writeFindingTo(TEST_ROOT, makeFinding({ finding_id: 'dfind-h4-source-b', status: 'candidate' }));

    const result = performMerge(TEST_ROOT, {
      sourceIds: ['dfind-h4-source-a', 'dfind-h4-source-b'],
      canonicalId: 'dfind-h4-source-a',
      actor: 'tester',
      reason: 'duplicates of the same lesson',
    });

    assert.ok(result.success, result.error);

    // dfind-h4-source-b should be rejected with reject_reason set.
    const sourceB = readBackFinding(TEST_ROOT, makeFinding({ finding_id: 'dfind-h4-source-b' }));
    assert.equal(sourceB.status, 'rejected');
    assert.equal(sourceB.review.reject_reason, 'merged_into_canonical');

    // And it validates against the H4 schema if/then.
    const validation = validateFinding(sourceB);
    assert.equal(
      validation.valid,
      true,
      `merged-source finding must satisfy H4 if/then. Errors: ${JSON.stringify(validation.errors)}`
    );
  });
});
