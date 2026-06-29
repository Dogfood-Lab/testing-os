/**
 * proac-001-merge-source-validation.test.js — FIND-PROAC-001.
 *
 * THE INVARIANT: `performMerge` writes the canonical with
 * `lineage.merged_from = [<non-canonical source ids>]` BEFORE it loops over the
 * sources marking each one superseded via `performAction`. Each `performAction`
 * supersede re-validates the source against the finding schema (F-FIND-001
 * write-side gate) and can fail — but `performMerge` ignored
 * `sourceResult.success`. The result: a canonical that records `merged_from: [X]`
 * for a source X that was never actually superseded (its on-disk status stays
 * whatever it was, its lineage.superseded_by never gets set). The merge reports
 * `{ success: true }` while the lineage is a lie.
 *
 * AFTER FIX (fail-closed-before-write): every source finding is schema-validated
 * BEFORE the canonical is written. If any source is invalid, the whole merge is
 * refused with `{ success: false, error }` naming the offending source id(s) +
 * reason, and the canonical on disk is byte-for-byte unchanged.
 *
 * Tests run against real fixtures written to a temp root (setupTestRoot
 * pattern), exercising the real `performMerge` / `findById` / `atomicWrite`
 * code paths — no mocks.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { performMerge } from './review-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_proac_001__');

function makeTestFinding(overrides = {}) {
  return {
    schema_version: '1.0.0',
    finding_id: 'dfind-proac-001',
    title: 'Test finding for proac-001 merge validation',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'repo_local',
    summary: 'Test finding for proac-001 merge source-validation invariant.',
    source_record_ids: ['test-record-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-record-001', note: 'Test evidence.' }],
    created_at: '2026-03-29T12:00:00Z',
    updated_at: '2026-03-29T12:00:00Z',
    ...overrides
  };
}

function writeFinding(finding) {
  const [org, repo] = finding.repo.split('/');
  const dir = resolve(TEST_ROOT, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${finding.finding_id}.yaml`);
  writeFileSync(path, yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
  return path;
}

function rawOnDisk(findingId, repo = 'mcp-tool-shop-org/test-repo') {
  const [org, repoName] = repo.split('/');
  const path = resolve(TEST_ROOT, 'findings', org, repoName, `${findingId}.yaml`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'findings'), { recursive: true });
}

describe('FIND-PROAC-001 — merge refuses when a source is schema-invalid', () => {
  before(setupTestRoot);
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('refuses the whole merge, names the bad source, leaves the canonical byte-for-byte unchanged', () => {
    // Canonical is valid; the second source is schema-invalid (bad enum) so the
    // supersede re-write would be refused by the F-FIND-001 write-side gate.
    writeFinding(makeTestFinding({
      finding_id: 'dfind-canon',
      source_record_ids: ['rec-canon'],
      evidence: [{ evidence_kind: 'record', record_id: 'rec-canon', note: 'canon' }]
    }));
    writeFinding(makeTestFinding({
      finding_id: 'dfind-bad-source',
      issue_kind: 'not_a_real_issue_kind_enum',
      source_record_ids: ['rec-bad'],
      evidence: [{ evidence_kind: 'record', record_id: 'rec-bad', note: 'bad' }]
    }));

    const canonBefore = rawOnDisk('dfind-canon');
    const badBefore = rawOnDisk('dfind-bad-source');

    const result = performMerge(TEST_ROOT, {
      sourceIds: ['dfind-canon', 'dfind-bad-source'],
      canonicalId: 'dfind-canon',
      actor: 'mike',
      reason: 'Same lesson from overlapping evidence.'
    });

    assert.equal(result.success, false, 'merge must be refused when a source is invalid');
    assert.ok(result.error, 'a structured error must be returned');
    assert.match(result.error, /dfind-bad-source/, 'error must name the offending source id');

    // The canonical must NOT have been written — no merged_from lie on disk.
    assert.equal(rawOnDisk('dfind-canon'), canonBefore, 'canonical unchanged on disk');
    assert.equal(rawOnDisk('dfind-bad-source'), badBefore, 'bad source unchanged on disk');
  });

  it('a fully-valid merge still succeeds and supersedes every source', () => {
    setupTestRoot();
    writeFinding(makeTestFinding({
      finding_id: 'dfind-ok-canon',
      source_record_ids: ['rec-a'],
      evidence: [{ evidence_kind: 'record', record_id: 'rec-a', note: 'a' }]
    }));
    writeFinding(makeTestFinding({
      finding_id: 'dfind-ok-source',
      source_record_ids: ['rec-b'],
      evidence: [{ evidence_kind: 'record', record_id: 'rec-b', note: 'b' }]
    }));

    const result = performMerge(TEST_ROOT, {
      sourceIds: ['dfind-ok-canon', 'dfind-ok-source'],
      canonicalId: 'dfind-ok-canon',
      actor: 'mike',
      reason: 'Same lesson, overlapping evidence.'
    });

    assert.ok(result.success, result.error);
    const source = yaml.load(rawOnDisk('dfind-ok-source'));
    assert.equal(source.status, 'rejected', 'source actually superseded');
    assert.equal(source.lineage?.superseded_by, 'dfind-ok-canon');
    const canon = yaml.load(rawOnDisk('dfind-ok-canon'));
    assert.ok(canon.lineage?.merged_from?.includes('dfind-ok-source'));
  });
});
