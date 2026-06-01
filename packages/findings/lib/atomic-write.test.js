/**
 * Regression tests for the temp+rename atomic write helper used by the
 * three artifact write paths (derive/synthesis/review). Guards against the
 * F-721047-010 sibling-fix gap: a torn writeFileSync would silently disappear
 * from listings because every loader has a try/empty-catch.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { atomicWriteFileSync } from './atomic-write.js';
import { writeFinding, resetSeenWrites } from '../derive/write-findings.js';
import { writePattern, writeRecommendation, writeDoctrine, resetSeenArtifactWrites } from '../synthesis/write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), `atomic-write-${prefix}-`));
}

/**
 * Make fs.writeFileSync throw on its NEXT call, then restore.
 *
 * fs.writeFileSync from `node:fs` is bound at import time inside the helper
 * (`atomic-write.js` does `import { writeFileSync } from 'node:fs'`), so
 * patching `fs.writeFileSync` would not intercept it. Instead we replace the
 * module-level method with `mock.method`, which Node's test runner can mutate
 * on the live default export, and then trip on the first call only.
 */
function installTornWrite() {
  const orig = fs.writeFileSync;
  let tripped = false;
  const mocked = mock.method(fs, 'writeFileSync', (...args) => {
    if (tripped) return orig.apply(fs, args);
    tripped = true;
    throw new Error('simulated torn write');
  });
  return () => mocked.mock.restore();
}

function listTmpLeaks(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.tmp'));
}

// Tests ─────────────────────────────────────────────────────────────────────

describe('atomicWriteFileSync', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpDir('helper'); });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  it('writes content atomically and returns the path', () => {
    const path = join(tmpRoot, 'note.txt');
    const out = atomicWriteFileSync(path, 'hello\n');
    assert.equal(out, path);
    assert.equal(readFileSync(path, 'utf-8'), 'hello\n');
    assert.deepEqual(listTmpLeaks(tmpRoot), [], 'no .tmp leak after success');
  });

  it('overwrites without exposing a half-written file (existing content preserved on failure)', () => {
    const path = join(tmpRoot, 'note.txt');
    writeFileSync(path, 'ORIGINAL', 'utf-8');

    const restore = installTornWrite();
    try {
      assert.throws(() => atomicWriteFileSync(path, 'NEW VALUE'), /simulated torn write/);
    } finally {
      restore();
    }

    assert.equal(readFileSync(path, 'utf-8'), 'ORIGINAL', 'original file untouched');
    assert.deepEqual(listTmpLeaks(tmpRoot), [], 'tmp file cleaned up after failure');
  });
});

describe('writeFinding (derive) — torn-write does not corrupt', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpDir('derive'); });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  // Schema-conformant fixture (D2B-002 — writeFinding now schema-gates).
  // Pre-D2B-002 the writers were schema-blind, so these regression tests
  // shipped with placeholder fields. The torn-write invariant they probe is
  // still load-bearing; only the fixture shape needed updating.
  const finding = {
    schema_version: '1.0.0',
    finding_id: 'dfind-test-001',
    title: 'placeholder torn-write fixture',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/x',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'surface_archetype',
    summary: 'placeholder finding for torn-write regression test fixture.',
    source_record_ids: ['r-1'],
    evidence: [{ evidence_kind: 'record', record_id: 'r-1' }],
    derived: {
      method: 'deterministic_rule',
      rule_id: 'rule-test',
      derived_at: '2026-04-26T00:00:00Z',
      rationale: 'torn-write regression test rationale.'
    },
    created_at: '2026-04-26T00:00:00Z',
    updated_at: '2026-04-26T00:00:00Z',
  };

  it('preserves prior file when underlying writeFileSync throws', () => {
    const targetDir = resolve(tmpRoot, 'findings', 'mcp-tool-shop-org', 'x');
    // Pre-seed with a known-good prior version
    const filePath = writeFinding(tmpRoot, finding);
    const original = readFileSync(filePath, 'utf-8');

    // L3-001 family-seal: writeFinding refuses same-process same-id by default.
    // Explicitly opt back in for this legitimate "rewrite with new contents"
    // test so the torn-write hook (NOT the collision guard) is what trips
    // the assertion.
    resetSeenWrites(tmpRoot);

    const restore = installTornWrite();
    try {
      assert.throws(() => writeFinding(tmpRoot, { ...finding, summary: 'CHANGED summary for torn-write fixture.' }));
    } finally {
      restore();
    }

    assert.equal(readFileSync(filePath, 'utf-8'), original, 'prior finding intact');
    assert.deepEqual(listTmpLeaks(targetDir), [], 'no orphaned .tmp');
  });
});

describe('write-artifacts (synthesis) — torn-write does not corrupt', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpDir('synth'); });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  it('pattern + recommendation + doctrine all roll back on torn write', () => {
    // Schema-conformant fixtures (D2B-002 — synthesis writers now schema-gate).
    const pattern = {
      schema_version: '1.0.0',
      pattern_id: 'dpat-torn-001',
      title: 'p torn-write fixture',
      status: 'candidate',
      pattern_kind: 'recurring_failure',
      summary: 'placeholder pattern for torn-write regression test fixture.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 1, surface_count: 1 },
      dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
      transfer_scope: 'surface_archetype',
      created_at: '2026-04-26T00:00:00Z',
      updated_at: '2026-04-26T00:00:00Z',
    };
    const rec = {
      schema_version: '1.0.0',
      recommendation_id: 'drec-torn-001',
      title: 't torn-write rec fixture',
      status: 'candidate',
      recommendation_kind: 'starter_check',
      summary: 'placeholder recommendation for torn-write regression test.',
      based_on_pattern_ids: ['dpat-x'],
      applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
      action: { type: 'add_check', target: 'rollout', details: 'placeholder action details' },
      confidence: 'emerging',
      created_at: '2026-04-26T00:00:00Z',
      updated_at: '2026-04-26T00:00:00Z',
    };
    const doc = {
      schema_version: '1.0.0',
      doctrine_id: 'ddoc-torn-001',
      title: 't torn-write doc fixture',
      status: 'candidate',
      doctrine_kind: 'rollout_law',
      statement: 'placeholder doctrine statement for torn-write regression test fixture.',
      rationale: 'placeholder rationale for torn-write regression test fixture spans enough chars.',
      based_on_pattern_ids: ['dpat-x'],
      transfer_scope: 'surface_archetype',
      strength: 'proven',
      created_at: '2026-04-26T00:00:00Z',
      updated_at: '2026-04-26T00:00:00Z',
    };

    const pPath = writePattern(tmpRoot, pattern);
    const rPath = writeRecommendation(tmpRoot, rec);
    const dPath = writeDoctrine(tmpRoot, doc);
    const orig = {
      p: readFileSync(pPath, 'utf-8'),
      r: readFileSync(rPath, 'utf-8'),
      d: readFileSync(dPath, 'utf-8')
    };

    // Schema-conformant mutation: tweak `title` (a string field present on all
    // three artifact shapes) so the schema gate passes and the torn-write
    // hook is what trips the assertion.
    for (const [fn, payload, prior, dir] of [
      [writePattern, { ...pattern, title: 'CHANGED title' }, orig.p, dirname(pPath)],
      [writeRecommendation, { ...rec, title: 'CHANGED title' }, orig.r, dirname(rPath)],
      [writeDoctrine, { ...doc, title: 'CHANGED title' }, orig.d, dirname(dPath)]
    ]) {
      const restore = installTornWrite();
      try {
        assert.throws(() => fn(tmpRoot, payload));
      } finally {
        restore();
      }
      const livePath = fn === writePattern ? pPath : fn === writeRecommendation ? rPath : dPath;
      assert.equal(readFileSync(livePath, 'utf-8'), prior, 'prior artifact intact after torn write');
      assert.deepEqual(listTmpLeaks(dir), [], 'no orphaned .tmp');
    }
  });
});

describe('review-engine — torn-write does not corrupt finding', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpDir('review'); });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  it('failed performAction leaves the on-disk finding unchanged', async () => {
    // Lazy import so the seed write happens before any fs hook is installed.
    const { performAction } = await import('../review/review-engine.js');

    // Schema-conformant fixture (D2B-002).
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-rev-001',
      title: 'rev placeholder torn-write fixture',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/x',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'surface_archetype',
      summary: 'review torn-write regression test fixture summary.',
      source_record_ids: ['r-1'],
      evidence: [{ evidence_kind: 'record', record_id: 'r-1' }],
      derived: {
        method: 'deterministic_rule',
        rule_id: 'rule-test',
        derived_at: '2026-04-26T00:00:00Z',
        rationale: 'review torn-write regression rationale.'
      },
      created_at: '2026-04-26T00:00:00Z',
      updated_at: '2026-04-26T00:00:00Z',
    };
    const filePath = writeFinding(tmpRoot, finding);
    const original = readFileSync(filePath, 'utf-8');

    // L3-001 family-seal: performAction internally rewrites the finding;
    // explicitly opt back in for this legitimate "seed-then-update" flow
    // so the torn-write hook is what trips, not the collision guard.
    // (performAction itself uses atomicWriteFileSync, not writeFinding, so
    // this reset is defensive — it future-proofs the test against any
    // refactor that routes performAction through writeFinding.)
    resetSeenWrites(tmpRoot);

    const restore = installTornWrite();
    let result;
    try {
      // performAction internally writes the finding and would also append an event log.
      // The torn write trips on the first writeFileSync — the finding write — and bubbles.
      assert.throws(() => {
        result = performAction(tmpRoot, {
          findingId: 'dfind-rev-001',
          action: 'accept',
          actor: 'tester'
        });
      });
    } finally {
      restore();
    }

    assert.equal(readFileSync(filePath, 'utf-8'), original, 'finding artifact unchanged');
    const dir = dirname(filePath);
    assert.deepEqual(listTmpLeaks(dir), [], 'no orphaned .tmp');
  });
});
