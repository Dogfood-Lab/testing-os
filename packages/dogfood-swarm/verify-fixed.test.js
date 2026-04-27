/**
 * verify-fixed.test.js — F-252713-002 (Phase 7 wave 1, FT-BACKEND-002)
 *
 * `swarm verify-fixed` is the on-demand command companion to FT-OUTPUTS-001's
 * always-on CI gate. Together they operationalize Class #14 — the wave-1
 * pattern where an amend agent reports `[fixed]` against a finding that
 * was never actually amended in the working tree, and the receipt carries
 * the lie forward.
 *
 * Receipts:
 *   1. classifyFixedFinding — every classification path:
 *        verified / regressed / claimed-but-still-present / unverifiable.
 *   2. buildVerifyFixedDelta — model shape + summary counts + threshold +
 *      exit-code 3-way (clean / threshold exceeded / pipeline broken).
 *   3. renderVerifyFixedDelta — TTY-aware format auto-detect (text /
 *      markdown / json), explicit --format override, and the
 *      DOGFOOD_FINDINGS_FORMAT env override (symmetry with the wave-23
 *      digest renderer).
 *   4. Output schema is renderer-agnostic: text/markdown/json all read
 *      the same fields from the same model.
 *   5. Sweep audit (Class #9 carryover): every emitter in this command
 *      flows through the renderVerifyFixedDelta() choke-point — no
 *      console.log(rawMarkdown) bypass.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { openMemoryDb, openDb, closeDb } from './db/connection.js';
import {
  classifyFixedFinding,
  buildVerifyFixedDelta,
  loadFixedFindings,
} from './lib/verify-fixed.js';
import {
  renderVerifyFixedDelta,
  renderVerifyFixedJson,
  renderVerifyFixedMarkdown,
  renderVerifyFixedText,
} from './lib/findings-render.js';
import { verifyFixed } from './commands/verify-fixed.js';

// ─── Helpers ───────────────────────────────────────────────────────

function tty() { return { isTTY: true, write: () => true }; }
function pipe() { return { isTTY: false, write: () => true }; }

/**
 * Build a fake-filesystem reader from a `{ path → lines[] }` map. The map
 * keys are repo-relative paths; the reader resolves them through the same
 * path.resolve() the classifier uses, so the keys match on win32 + posix.
 */
function fakeReader(table, repoRoot) {
  const resolved = new Map();
  for (const [k, v] of Object.entries(table)) {
    resolved.set(resolve(repoRoot, k), v);
  }
  return (absPath) => (resolved.has(absPath) ? resolved.get(absPath) : null);
}

// Use a tmpdir-relative root so resolve() lands on a real OS-native path
// shape (drive letter on Windows, leading slash on POSIX). Tests do not
// touch the real filesystem at REPO — fakeReader is the I/O layer.
const REPO = join(tmpdir(), 'verify-fixed-test-repo');

function mkFinding(overrides = {}) {
  return {
    finding_id: 'F-001',
    fingerprint: 'fp-' + (overrides.finding_id || 'F-001'),
    severity: 'HIGH',
    category: 'bug',
    file_path: 'src/a.js',
    line_number: 42,
    symbol: 'doThing',
    description: 'doThing leaks memory',
    recommendation: 'free the buffer',
    last_seen_wave: 3,
    fixed_wave_id: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. classifyFixedFinding — the four classification paths
// ═══════════════════════════════════════════════════════════════════════

describe('classifyFixedFinding — verified', () => {
  it('classifies as verified when the anchor is gone from the bucket', () => {
    const finding = mkFinding({ symbol: 'doThing', line_number: 42 });
    // bucket = 40-50; lines 40-50 do NOT contain `doThing`.
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1} — clean code here`);
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(result.classification, 'verified');
    assert.match(result.evidence, /no longer present/);
  });

  it('finds verified even when an unrelated symbol is in the same bucket', () => {
    const finding = mkFinding({ symbol: 'doThing', line_number: 25 });
    // bucket = 20-30; lines have `doOther` not `doThing`.
    const file = [];
    for (let i = 0; i < 60; i++) file.push(`// line ${i + 1} — doOther stays`);
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(result.classification, 'verified');
  });
});

describe('classifyFixedFinding — claimed-but-still-present', () => {
  it('matches at the exact recorded line within ±2 tolerance', () => {
    const finding = mkFinding({ symbol: 'doThing', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[41] = 'function doThing() { /* still here */ }';
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(result.classification, 'claimed-but-still-present');
    assert.match(result.evidence, /still at/);
  });

  it('honours the ±2 line tolerance — line 44 still counts as exact', () => {
    const finding = mkFinding({ symbol: 'doThing', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[43] = 'function doThing() {}'; // line 44, +2 from recorded
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(result.classification, 'claimed-but-still-present');
  });
});

describe('classifyFixedFinding — regressed', () => {
  it('classifies as regressed when anchor is in the bucket but not at exact line', () => {
    const finding = mkFinding({ symbol: 'doThing', line_number: 41 });
    // bucket = 40-50, recorded = 41; tolerance = ±2 (39-43). Place anchor
    // at line 48 — inside bucket, outside tolerance → regressed.
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[47] = 'function doThing() { /* moved nearby */ }';
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(result.classification, 'regressed');
    assert.match(result.evidence, /reappeared/);
  });
});

describe('classifyFixedFinding — unverifiable', () => {
  it('classifies as unverifiable when the file is gone', () => {
    const finding = mkFinding({ symbol: 'doThing' });
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({}, REPO), // empty FS
    });
    assert.equal(result.classification, 'unverifiable');
    assert.match(result.evidence, /not present|deleted|moved|unreadable/);
  });

  it('classifies as unverifiable when finding has no file_path', () => {
    const finding = mkFinding({ file_path: null });
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({}, REPO),
    });
    assert.equal(result.classification, 'unverifiable');
    assert.match(result.evidence, /no file_path/);
  });

  it('classifies as unverifiable when no symbol and no description anchor', () => {
    const finding = mkFinding({ symbol: '', description: 'a b c' });
    const file = Array.from({ length: 10 }, () => 'noise');
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    assert.equal(result.classification, 'unverifiable');
  });

  it('falls back to a description token when symbol is absent', () => {
    const finding = mkFinding({
      symbol: '',
      description: 'memoryLeak in buffer logic',
      line_number: 5,
    });
    const file = ['', 'noise', 'noise', 'noise', 'function memoryLeak() {}', 'noise'];
    const result = classifyFixedFinding(finding, REPO, {
      readLines: fakeReader({ 'src/a.js': file }, REPO),
    });
    // bucket 0-10 contains the anchor near recorded line 5 → claimed-present.
    assert.equal(result.classification, 'claimed-but-still-present');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. buildVerifyFixedDelta — model shape + counts + threshold + exit code
// ═══════════════════════════════════════════════════════════════════════

describe('buildVerifyFixedDelta — model shape', () => {
  it('produces the v1 schema header and renderer-agnostic fields', () => {
    const fs = {
      ['src/a.js']: Array.from({ length: 60 }, (_, i) => `// ${i + 1}`),
    };
    const fixed = [mkFinding({ finding_id: 'F-001', symbol: 'gone', line_number: 42 })];
    const delta = buildVerifyFixedDelta({
      runId: 'r1',
      waveNumber: 5,
      fixedFindings: fixed,
      repoRoot: REPO,
      threshold: 0,
      readLines: fakeReader(fs, REPO),
      now: () => '2026-04-26T00:00:00.000Z',
    });
    assert.equal(delta.schema, 'verify-fixed-delta/v1');
    assert.equal(delta.runId, 'r1');
    assert.equal(delta.waveNumber, 5);
    assert.equal(delta.checkedAt, '2026-04-26T00:00:00.000Z');
    assert.equal(delta.summary.total, 1);
    assert.equal(delta.summary.verified, 1);
    assert.equal(delta.threshold, 0);
    assert.equal(delta.thresholdExceeded, false);
    assert.equal(delta.exitCode, 0);
    assert.equal(delta.findings.length, 1);
    assert.equal(delta.findings[0].classification, 'verified');
    assert.equal(delta.findings[0].originalFixedWave, 3);
  });

  it('counts every classification bucket', () => {
    const fs = {
      ['src/v.js']: Array.from({ length: 60 }, (_, i) => `// ${i + 1}`),
      ['src/c.js']: (() => {
        const f = Array.from({ length: 60 }, (_, i) => `// ${i + 1}`);
        f[41] = 'function doThing() {}';
        return f;
      })(),
      ['src/r.js']: (() => {
        const f = Array.from({ length: 60 }, (_, i) => `// ${i + 1}`);
        f[47] = 'function doThing() {}';
        return f;
      })(),
      // src/u.js intentionally absent → unverifiable
    };
    const fixed = [
      mkFinding({ finding_id: 'F-V', file_path: 'src/v.js', symbol: 'gone', line_number: 42 }),
      mkFinding({ finding_id: 'F-C', file_path: 'src/c.js', symbol: 'doThing', line_number: 42 }),
      mkFinding({ finding_id: 'F-R', file_path: 'src/r.js', symbol: 'doThing', line_number: 41 }),
      mkFinding({ finding_id: 'F-U', file_path: 'src/u.js', symbol: 'gone', line_number: 1 }),
    ];
    const delta = buildVerifyFixedDelta({
      runId: 'r1',
      waveNumber: 5,
      fixedFindings: fixed,
      repoRoot: REPO,
      threshold: 0,
      readLines: fakeReader(fs, REPO),
      now: () => '2026-04-26T00:00:00.000Z',
    });
    assert.equal(delta.summary.total, 4);
    assert.equal(delta.summary.verified, 1);
    assert.equal(delta.summary.regressed, 1);
    assert.equal(delta.summary.claimedButStillPresent, 1);
    assert.equal(delta.summary.unverifiable, 1);
  });
});

describe('buildVerifyFixedDelta — exit code 3-way disambiguation', () => {
  // Mirrors wave-18's findings-digest.js disambiguation contract.

  it('exit 0 when total === 0', () => {
    const delta = buildVerifyFixedDelta({
      runId: 'r1', waveNumber: 1, fixedFindings: [],
      repoRoot: REPO, threshold: 0, readLines: fakeReader({}, REPO),
    });
    assert.equal(delta.exitCode, 0);
    assert.equal(delta.thresholdExceeded, false);
  });

  it('exit 0 when everything verified within threshold', () => {
    const fs = { ['src/a.js']: Array.from({ length: 60 }, (_, i) => `// ${i + 1}`) };
    const delta = buildVerifyFixedDelta({
      runId: 'r1', waveNumber: 1,
      fixedFindings: [mkFinding({ symbol: 'gone' })],
      repoRoot: REPO, threshold: 0, readLines: fakeReader(fs, REPO),
    });
    assert.equal(delta.exitCode, 0);
  });

  it('exit 1 when offending count exceeds threshold', () => {
    const fs = {
      ['src/a.js']: (() => {
        const f = Array.from({ length: 60 }, (_, i) => `// ${i + 1}`);
        f[41] = 'function doThing() {}'; // claimed-but-still-present
        return f;
      })(),
    };
    const delta = buildVerifyFixedDelta({
      runId: 'r1', waveNumber: 1,
      fixedFindings: [mkFinding({ symbol: 'doThing', line_number: 42 })],
      repoRoot: REPO, threshold: 0, readLines: fakeReader(fs, REPO),
    });
    assert.equal(delta.exitCode, 1);
    assert.equal(delta.thresholdExceeded, true);
  });

  it('exit 0 when offending count equals threshold', () => {
    const fs = {
      ['src/a.js']: (() => {
        const f = Array.from({ length: 60 }, (_, i) => `// ${i + 1}`);
        f[41] = 'function doThing() {}';
        return f;
      })(),
    };
    const delta = buildVerifyFixedDelta({
      runId: 'r1', waveNumber: 1,
      fixedFindings: [mkFinding({ symbol: 'doThing', line_number: 42 })],
      repoRoot: REPO, threshold: 1, readLines: fakeReader(fs, REPO),
    });
    assert.equal(delta.exitCode, 0);
    assert.equal(delta.thresholdExceeded, false);
  });

  it('exit 2 when ALL findings are unverifiable (pipeline broken)', () => {
    const delta = buildVerifyFixedDelta({
      runId: 'r1', waveNumber: 1,
      fixedFindings: [
        mkFinding({ finding_id: 'F-1', file_path: 'src/missing-1.js' }),
        mkFinding({ finding_id: 'F-2', file_path: 'src/missing-2.js' }),
      ],
      repoRoot: REPO, threshold: 0, readLines: fakeReader({}, REPO),
    });
    assert.equal(delta.exitCode, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. renderVerifyFixedDelta — format auto-detect + explicit override
// ═══════════════════════════════════════════════════════════════════════

describe('renderVerifyFixedDelta — TTY auto-detect', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.DOGFOOD_FINDINGS_FORMAT; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DOGFOOD_FINDINGS_FORMAT;
    else process.env.DOGFOOD_FINDINGS_FORMAT = originalEnv;
  });

  const sampleModel = {
    schema: 'verify-fixed-delta/v1',
    runId: 'r1',
    waveNumber: 5,
    checkedAt: '2026-04-26T00:00:00.000Z',
    summary: { total: 1, verified: 1, regressed: 0, claimedButStillPresent: 0, unverifiable: 0 },
    threshold: 0,
    thresholdExceeded: false,
    exitCode: 0,
    findings: [{
      finding_id: 'F-1', fingerprint: 'fp', classification: 'verified',
      file: 'src/a.js', line: 42, symbol: 'doThing',
      severity: 'HIGH', description: 'leak', recommendation: 'free',
      evidence: 'anchor /\\bdoThing\\b/ no longer present at src/a.js:40-50',
      originalFixedWave: 3,
    }],
  };

  it('defaults to text on TTY', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    const out = renderVerifyFixedDelta(sampleModel, undefined, tty());
    assert.match(out, /VERDICT:/);
    assert.doesNotMatch(out, /^\| /m);  // markdown tables start with `|`
  });

  it('defaults to markdown when piped/redirected', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    const out = renderVerifyFixedDelta(sampleModel, undefined, pipe());
    assert.match(out, /\| Class \| F-id \|/);
    assert.match(out, /^# Verify-Fixed Delta/m);
  });

  it('honours explicit --format=json', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    const out = renderVerifyFixedDelta(sampleModel, 'json', tty());
    const parsed = JSON.parse(out);
    assert.equal(parsed.schema, 'verify-fixed-delta/v1');
    assert.equal(parsed.summary.total, 1);
  });

  it('honours explicit --format=text on a piped stream', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    const out = renderVerifyFixedDelta(sampleModel, 'text', pipe());
    assert.match(out, /VERDICT:/);
  });

  it('honours explicit --format=markdown on a TTY stream', () => {
    delete process.env.DOGFOOD_FINDINGS_FORMAT;
    const out = renderVerifyFixedDelta(sampleModel, 'markdown', tty());
    assert.match(out, /^# Verify-Fixed Delta/m);
  });

  it('DOGFOOD_FINDINGS_FORMAT=raw forces markdown', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'raw';
    const out = renderVerifyFixedDelta(sampleModel, 'text', tty());
    assert.match(out, /^# Verify-Fixed Delta/m);
  });

  it('DOGFOOD_FINDINGS_FORMAT=human forces text', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'human';
    const out = renderVerifyFixedDelta(sampleModel, 'markdown', pipe());
    assert.match(out, /VERDICT:/);
  });

  it('DOGFOOD_FINDINGS_FORMAT=json forces json', () => {
    process.env.DOGFOOD_FINDINGS_FORMAT = 'json';
    const out = renderVerifyFixedDelta(sampleModel, 'text', tty());
    JSON.parse(out); // does not throw
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Renderer-agnostic schema parity (text / markdown / json read same model)
// ═══════════════════════════════════════════════════════════════════════

describe('renderer parity — every format reads the same fields', () => {
  const model = {
    schema: 'verify-fixed-delta/v1',
    runId: 'r1', waveNumber: 5, checkedAt: '2026-04-26T00:00:00.000Z',
    summary: { total: 3, verified: 1, regressed: 1, claimedButStillPresent: 1, unverifiable: 0 },
    threshold: 0, thresholdExceeded: true, exitCode: 1,
    findings: [
      { finding_id: 'F-A', fingerprint: 'fpA', classification: 'claimed-but-still-present',
        file: 'src/a.js', line: 12, symbol: 'badThing', severity: 'CRITICAL',
        description: 'still here', evidence: 'still at src/a.js:12', originalFixedWave: 2 },
      { finding_id: 'F-B', fingerprint: 'fpB', classification: 'regressed',
        file: 'src/b.js', line: 30, symbol: 'wobble', severity: 'HIGH',
        description: 'reverted', evidence: 'reappeared at src/b.js:38', originalFixedWave: 2 },
      { finding_id: 'F-C', fingerprint: 'fpC', classification: 'verified',
        file: 'src/c.js', line: 5, symbol: 'gone', severity: 'LOW',
        description: 'cleaned', evidence: 'no longer present', originalFixedWave: 2 },
    ],
  };

  it('json includes every finding with full classification', () => {
    const parsed = JSON.parse(renderVerifyFixedJson(model));
    assert.equal(parsed.findings.length, 3);
    const classes = parsed.findings.map((f) => f.classification).sort();
    assert.deepEqual(classes, ['claimed-but-still-present', 'regressed', 'verified']);
  });

  it('markdown includes every finding ID', () => {
    const md = renderVerifyFixedMarkdown(model);
    assert.match(md, /F-A/); assert.match(md, /F-B/); assert.match(md, /F-C/);
    assert.match(md, /CLAIMED-PRESENT/);
    assert.match(md, /REGRESSED/);
    assert.match(md, /VERIFIED/);
  });

  it('text includes every finding ID', () => {
    const txt = renderVerifyFixedText(model);
    assert.match(txt, /F-A/); assert.match(txt, /F-B/); assert.match(txt, /F-C/);
    assert.match(txt, /CLAIMED-PRESENT/);
  });

  it('claimed-but-still-present sorts above verified in human renderers', () => {
    const txt = renderVerifyFixedText(model);
    const idxClaimed = txt.indexOf('F-A');
    const idxVerified = txt.indexOf('F-C');
    assert.ok(idxClaimed < idxVerified, 'claimed-but-still-present should appear before verified');
  });

  it('text headline reflects threshold-exceeded state', () => {
    const txt = renderVerifyFixedText(model);
    assert.match(txt, /failed verification/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. End-to-end: loadFixedFindings + verifyFixed against a temp run
// ═══════════════════════════════════════════════════════════════════════

describe('loadFixedFindings — DB query', () => {
  let db;
  beforeEach(() => {
    db = openMemoryDb();
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha)
      VALUES ('r1', 'org/r', '/tmp/r', ?)`).run('a'.repeat(40));
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (1, 'r1', 'health-amend-a', 1, 'collected')`).run();
    // Two findings: one fixed, one new — verifies the WHERE filter.
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-1', 'fp1', 'HIGH', 'bug', 'src/a.js', 42, 'doThing', 'd1', 'fixed', 1, 1)`).run();
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-2', 'fp2', 'LOW', 'quality', 'src/b.js', 7, 'something', 'd2', 'new', 1, 1)`).run();
    // Insert a 'fixed' event for F-1 to exercise the wave-id join.
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id)
      VALUES (1, 'fixed', 1)`).run();
  });
  afterEach(() => db.close());

  it('returns only status=fixed findings', () => {
    const rows = loadFixedFindings(db, 'r1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].finding_id, 'F-1');
  });

  it('joins the most recent fixed event wave id', () => {
    const rows = loadFixedFindings(db, 'r1');
    assert.equal(rows[0].fixed_wave_id, 1);
  });
});

describe('verifyFixed — end-to-end against a temp DB + temp filesystem', () => {
  let tempDir, dbPath, outputDir, repoRoot;

  beforeEach(() => {
    tempDir = join(tmpdir(), `vf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    repoRoot = join(tempDir, 'repo');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    // Fixture file: anchor still at recorded line → claimed-but-still-present
    writeFileSync(
      join(repoRoot, 'src', 'a.js'),
      Array.from({ length: 60 }, (_, i) => i === 41 ? 'function doThing() {}' : `// line ${i + 1}`).join('\n')
    );
    outputDir = join(tempDir, 'swarms-out');
    dbPath = join(tempDir, 'cp.db');

    // Seed a real on-disk DB. openDb caches the handle in a module-level
    // pool; closeDb drops the cache so verifyFixed gets a fresh handle.
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha)
      VALUES ('r1', 'org/r', ?, ?)`).run(repoRoot, 'a'.repeat(40));
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (1, 'r1', 'health-amend-a', 7, 'collected')`).run();
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-CLAIMED', 'fpC', 'HIGH', 'bug', 'src/a.js', 42, 'doThing', 'd', 'fixed', 1, 1)`).run();
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('writes the delta JSON to swarms/<run>/verify-fixed-<wave>.json', () => {
    const result = verifyFixed({
      runId: 'r1', dbPath, outputDir, threshold: 0, format: 'json', stream: pipe(),
    });
    assert.ok(existsSync(result.deltaPath));
    assert.match(result.deltaPath, /verify-fixed-7\.json$/);
    const onDisk = JSON.parse(readFileSync(result.deltaPath, 'utf-8'));
    // W3-BACK-002 wave 30: schema bumped to v2 by default; --legacy-v1 keeps v1.
    assert.equal(onDisk.schema, 'verify-fixed-delta/v2');
    assert.equal(onDisk.verb, 'verify-fixed');
    assert.equal(onDisk.summary.total, 1);
    assert.equal(onDisk.summary.claimedButStillPresent, 1);
    // Vantage-point disclosure: every entry must carry verified_via.
    assert.ok(onDisk.findings.every((f) => typeof f.verified_via === 'string'));
    assert.ok(onDisk.summary.verified_via_distribution, 'v2 must surface verified_via_distribution');
  });

  it('--legacy-v1 emits the v1 schema for backward-compat consumers', () => {
    const result = verifyFixed({
      runId: 'r1', dbPath, outputDir, threshold: 0, format: 'json', stream: pipe(),
      legacyV1: true,
    });
    const onDisk = JSON.parse(readFileSync(result.deltaPath, 'utf-8'));
    assert.equal(onDisk.schema, 'verify-fixed-delta/v1');
    // v1 has no verb or verified_via fields — that's the contract.
    assert.equal(onDisk.verb, undefined);
    assert.equal(onDisk.findings[0].verified_via, undefined);
  });

  it('returns exit code 1 when threshold (0) is exceeded by the claimed-present finding', () => {
    const result = verifyFixed({
      runId: 'r1', dbPath, outputDir, threshold: 0, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.delta.thresholdExceeded, true);
  });

  it('returns exit code 0 when threshold accommodates the offending count', () => {
    const result = verifyFixed({
      runId: 'r1', dbPath, outputDir, threshold: 5, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.delta.thresholdExceeded, false);
  });

  it('throws a helpful error when run is not found', () => {
    assert.throws(
      () => verifyFixed({ runId: 'nope', dbPath, outputDir, stream: pipe() }),
      /Run not found/
    );
  });
});
