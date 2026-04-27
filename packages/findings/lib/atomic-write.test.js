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
import { writeFinding } from '../derive/write-findings.js';
import { writePattern, writeRecommendation, writeDoctrine } from '../synthesis/write-artifacts.js';

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

  const finding = {
    schema_version: '1.0.0',
    finding_id: 'F-test-001',
    finding_type: 'evidence_gap',
    severity: 'low',
    repo: 'mcp-tool-shop-org/x',
    title: 'placeholder',
    summary: 'placeholder finding for torn-write regression',
    derived_at: '2026-04-26T00:00:00Z',
    rule_id: 'R-TEST',
    source_record_ids: ['r-1'],
    evidence: [{ evidence_kind: 'record_field', record_id: 'r-1', field_path: '$.x', observed_value: 1 }],
    confidence: 0.5,
    status: 'candidate'
  };

  it('preserves prior file when underlying writeFileSync throws', () => {
    const targetDir = resolve(tmpRoot, 'findings', 'mcp-tool-shop-org', 'x');
    // Pre-seed with a known-good prior version
    const filePath = writeFinding(tmpRoot, finding);
    const original = readFileSync(filePath, 'utf-8');

    const restore = installTornWrite();
    try {
      assert.throws(() => writeFinding(tmpRoot, { ...finding, summary: 'CHANGED' }));
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
    const pattern = { pattern_id: 'PAT-001', name: 'p', description: 'd' };
    const rec = { recommendation_id: 'REC-001', title: 't', body: 'b' };
    const doc = { doctrine_id: 'DOC-001', title: 't', body: 'b' };

    const pPath = writePattern(tmpRoot, pattern);
    const rPath = writeRecommendation(tmpRoot, rec);
    const dPath = writeDoctrine(tmpRoot, doc);
    const orig = {
      p: readFileSync(pPath, 'utf-8'),
      r: readFileSync(rPath, 'utf-8'),
      d: readFileSync(dPath, 'utf-8')
    };

    for (const [fn, payload, prior, dir] of [
      [writePattern, { ...pattern, name: 'CHANGED' }, orig.p, dirname(pPath)],
      [writeRecommendation, { ...rec, title: 'CHANGED' }, orig.r, dirname(rPath)],
      [writeDoctrine, { ...doc, title: 'CHANGED' }, orig.d, dirname(dPath)]
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

    const finding = {
      schema_version: '1.0.0',
      finding_id: 'F-rev-001',
      finding_type: 'evidence_gap',
      severity: 'low',
      repo: 'mcp-tool-shop-org/x',
      title: 'rev placeholder',
      summary: 'review torn-write regression',
      derived_at: '2026-04-26T00:00:00Z',
      rule_id: 'R-TEST',
      source_record_ids: ['r-1'],
      evidence: [{ evidence_kind: 'record_field', record_id: 'r-1', field_path: '$.x', observed_value: 1 }],
      confidence: 0.5,
      status: 'candidate'
    };
    const filePath = writeFinding(tmpRoot, finding);
    const original = readFileSync(filePath, 'utf-8');

    const restore = installTornWrite();
    let result;
    try {
      // performAction internally writes the finding and would also append an event log.
      // The torn write trips on the first writeFileSync — the finding write — and bubbles.
      assert.throws(() => {
        result = performAction(tmpRoot, {
          findingId: 'F-rev-001',
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
