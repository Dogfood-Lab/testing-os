/**
 * verify-verb-family.test.js — W3-BACK-003/004/005 (Phase 7 wave 3)
 *
 * Tests for the three new v2 verbs:
 *   - swarm verify-recurring     — multi-wave fixed-event detection
 *   - swarm verify-unverified    — re-classify deferred findings
 *   - swarm verify-approved      — pre-amend anchor gate
 *
 * Each verb uses the shared lib/verify-classifier-v2.js base and emits
 * the Pattern #8 envelope with verb-specific extras under
 * `findings[].verb_specifics`.
 *
 * Strategy: synthetic on-disk SQLite + tmp filesystem, exercise the full
 * verb impl (loadXxxFindings + verb impl). Same fixture pattern as
 * verify-fixed.test.js's "verifyFixed — end-to-end" suite.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';
import {
  loadRecurringFindings,
  verifyRecurring,
} from './commands/verify-recurring.js';
import {
  loadUnverifiedFindings,
  verifyUnverified,
} from './commands/verify-unverified.js';
import {
  loadApprovedFindings,
  verifyApproved,
} from './commands/verify-approved.js';

function pipe() { return { isTTY: false, write: () => true }; }

function setupTempRun({ withFile = true, fileLine42Symbol = null } = {}) {
  const tempDir = join(tmpdir(), `vvf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const repoRoot = join(tempDir, 'repo');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });

  if (withFile) {
    const lines = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    if (fileLine42Symbol) {
      lines[41] = `function ${fileLine42Symbol}() {}`;
    }
    writeFileSync(join(repoRoot, 'src', 'a.js'), lines.join('\n'));
  }

  const outputDir = join(tempDir, 'swarms-out');
  const dbPath = join(tempDir, 'cp.db');
  return { tempDir, repoRoot, outputDir, dbPath };
}

function teardown(tempDir, dbPath) {
  try { closeDb(dbPath); } catch { /* */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
}

// ═══════════════════════════════════════════════════════════════════════
// verify-recurring — W3-BACK-003
// ═══════════════════════════════════════════════════════════════════════

describe('verify-recurring — multi-wave fixed-event detection', () => {
  let env;

  beforeEach(() => {
    env = setupTempRun({ fileLine42Symbol: 'doThing' });
    const db = openDb(env.dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha)
      VALUES ('r1', 'org/r', ?, ?)`).run(env.repoRoot, 'a'.repeat(40));
    // Three waves: 5, 12, 20.
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (1, 'r1', 'health-amend-a', 5, 'collected')`).run();
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (2, 'r1', 'health-amend-b', 12, 'collected')`).run();
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (3, 'r1', 'health-amend-c', 20, 'collected')`).run();
    // Recurring finding: fixed in 5, recurred in 8 (no wave row needed for
    // an event whose wave isn't in this set; we'll use wave_id=1), fixed
    // again in 12, fixed again in 20.
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-RC', 'fpRC', 'HIGH', 'bug', 'src/a.js', 42, 'doThing', 'leak', 'fixed', 1, 3)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'fixed', 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'recurred', 2)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'fixed', 2)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'fixed', 3)`).run();
    // Non-recurring finding: only one fixed event — should NOT be returned.
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-ONCE', 'fpONCE', 'LOW', 'quality', 'src/a.js', 5, 'once', 'd', 'fixed', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (2, 'fixed', 1)`).run();
  });

  afterEach(() => teardown(env.tempDir, env.dbPath));

  it('loadRecurringFindings returns only findings with ≥2 distinct fixed-event waves', () => {
    const db = openDb(env.dbPath);
    const rows = loadRecurringFindings(db, 'r1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].finding_id, 'F-RC');
  });

  it('enriches recurrence_count + claimed_in_waves + regressed_in_waves', () => {
    const db = openDb(env.dbPath);
    const [row] = loadRecurringFindings(db, 'r1');
    assert.equal(row.recurrence_count, 3);
    assert.deepEqual(row.claimed_in_waves, [5, 12, 20]);
    assert.deepEqual(row.regressed_in_waves, [12]);
  });

  it('writes a verify-recurring-delta/v1 envelope to the run output dir', () => {
    const result = verifyRecurring({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.ok(existsSync(result.deltaPath));
    assert.match(result.deltaPath, /verify-recurring-20\.json$/);
    const onDisk = JSON.parse(readFileSync(result.deltaPath, 'utf-8'));
    assert.equal(onDisk.schema, 'verify-recurring-delta/v1');
    assert.equal(onDisk.verb, 'verify-recurring');
    assert.equal(onDisk.summary.total, 1);
    assert.equal(onDisk.findings.length, 1);
    assert.equal(onDisk.findings[0].verb_specifics.recurrence_count, 3);
    assert.deepEqual(onDisk.findings[0].verb_specifics.claimed_in_waves, [5, 12, 20]);
  });

  it('every entry has a verified_via tag (vantage-point disclosure)', () => {
    const result = verifyRecurring({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    for (const f of result.delta.findings) {
      assert.ok(typeof f.verified_via === 'string', `verified_via missing on ${f.finding_id}`);
    }
  });

  it('exit 1 when offending count exceeds threshold and the recurring finding is still present', () => {
    // The fixture file has doThing at line 42 → claimed-but-still-present.
    const result = verifyRecurring({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.delta.summary.claimedButStillPresent, 1);
  });

  it('throws when the run is not found', () => {
    assert.throws(
      () => verifyRecurring({ runId: 'nope', dbPath: env.dbPath, outputDir: env.outputDir, stream: pipe() }),
      /Run not found/
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// verify-unverified — W3-BACK-004
// ═══════════════════════════════════════════════════════════════════════

describe('verify-unverified — re-classify deferred findings', () => {
  let env;

  beforeEach(() => {
    env = setupTempRun({ fileLine42Symbol: 'stillThere' });
    const db = openDb(env.dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha)
      VALUES ('r1', 'org/r', ?, ?)`).run(env.repoRoot, 'a'.repeat(40));
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (1, 'r1', 'health-amend-a', 7, 'collected')`).run();
    // Three findings: one unverified at present-anchor, one unverified
    // whose anchor is now gone (means deferral was correct), one with
    // status='new' (must be excluded).
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-U1', 'fpU1', 'MEDIUM', 'bug', 'src/a.js', 42, 'stillThere', 'd', 'unverified', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'unverified', 1)`).run();
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-U2', 'fpU2', 'LOW', 'quality', 'src/a.js', 50, 'gonePhantom', 'd', 'unverified', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (2, 'unverified', 1)`).run();
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-NEW', 'fpNEW', 'LOW', 'quality', 'src/a.js', 5, 'thing', 'd', 'new', 1, 1)`).run();
  });

  afterEach(() => teardown(env.tempDir, env.dbPath));

  it('loadUnverifiedFindings returns only status=unverified rows', () => {
    const db = openDb(env.dbPath);
    const rows = loadUnverifiedFindings(db, 'r1');
    const ids = rows.map(r => r.finding_id).sort();
    assert.deepEqual(ids, ['F-U1', 'F-U2']);
  });

  it('joins the most recent unverified-event wave_number', () => {
    const db = openDb(env.dbPath);
    const rows = loadUnverifiedFindings(db, 'r1');
    for (const r of rows) {
      assert.equal(r.deferred_wave_number, 7);
    }
  });

  it('writes verify-unverified-delta/v1 with the verb tag and verb_specifics', () => {
    const result = verifyUnverified({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 5, format: 'json', stream: pipe(),
    });
    assert.match(result.deltaPath, /verify-unverified-7\.json$/);
    const onDisk = JSON.parse(readFileSync(result.deltaPath, 'utf-8'));
    assert.equal(onDisk.schema, 'verify-unverified-delta/v1');
    assert.equal(onDisk.verb, 'verify-unverified');
    assert.equal(onDisk.summary.total, 2);
    for (const f of onDisk.findings) {
      assert.equal(f.verb_specifics.deferred_wave_number, 7);
    }
  });

  it('classifies F-U1 (anchor still present at line 42) as claimed-but-still-present', () => {
    const result = verifyUnverified({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 5, format: 'json', stream: pipe(),
    });
    const u1 = result.delta.findings.find(f => f.finding_id === 'F-U1');
    assert.equal(u1.classification, 'claimed-but-still-present');
    assert.equal(u1.verified_via, 'anchor');
  });

  it('classifies F-U2 (anchor never reappears) as verified', () => {
    const result = verifyUnverified({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 5, format: 'json', stream: pipe(),
    });
    const u2 = result.delta.findings.find(f => f.finding_id === 'F-U2');
    assert.equal(u2.classification, 'verified');
    assert.equal(u2.verified_via, 'anchor');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// verify-approved — W3-BACK-005
// ═══════════════════════════════════════════════════════════════════════

describe('verify-approved — pre-amend anchor gate', () => {
  let env;

  beforeEach(() => {
    env = setupTempRun({ fileLine42Symbol: 'targetFn' });
    const db = openDb(env.dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha)
      VALUES ('r1', 'org/r', ?, ?)`).run(env.repoRoot, 'a'.repeat(40));
    db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
      VALUES (1, 'r1', 'feature-audit', 9, 'collected')`).run();
  });

  afterEach(() => teardown(env.tempDir, env.dbPath));

  it('exit 0 when no approved findings exist', () => {
    const result = verifyApproved({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.delta.summary.total, 0);
  });

  it('exit 0 when approved finding still has its anchor (claimed-but-still-present is the OK state)', () => {
    const db = openDb(env.dbPath);
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-APP', 'fpA', 'HIGH', 'bug', 'src/a.js', 42, 'targetFn', 'leak', 'approved', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'approved', 1)`).run();

    const result = verifyApproved({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.delta.summary.claimedButStillPresent, 1);
    assert.equal(result.delta.findings[0].verb_specifics.approved_wave_number, 9);
  });

  it('exit 1 when anchor drifted (verified = anchor gone before fix dispatched)', () => {
    // Insert an approved finding whose anchor is NOT in the file —
    // anchor drifted away, so the approval no longer matches reality.
    const db = openDb(env.dbPath);
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-DRIFT', 'fpD', 'HIGH', 'bug', 'src/a.js', 42, 'gonePhantom', 'leak', 'approved', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'approved', 1)`).run();

    const result = verifyApproved({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.delta.summary.verified, 1);
  });

  it('exit 2 when an approved finding classifies unverifiable (broken anchor blocks dispatch)', () => {
    const db = openDb(env.dbPath);
    // file_path points to a missing file — classifier returns unverifiable.
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-BROKEN', 'fpB', 'HIGH', 'bug', 'src/missing.js', 42, 'targetFn', 'leak', 'approved', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'approved', 1)`).run();

    const result = verifyApproved({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.delta.summary.unverifiable, 1);
  });

  it('writes the verify-approved-delta/v1 envelope to the run output dir', () => {
    const db = openDb(env.dbPath);
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
        file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r1', 'F-APP', 'fpA', 'HIGH', 'bug', 'src/a.js', 42, 'targetFn', 'leak', 'approved', 1, 1)`).run();
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id) VALUES (1, 'approved', 1)`).run();

    const result = verifyApproved({
      runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir,
      threshold: 0, format: 'json', stream: pipe(),
    });
    assert.match(result.deltaPath, /verify-approved-9\.json$/);
    const onDisk = JSON.parse(readFileSync(result.deltaPath, 'utf-8'));
    assert.equal(onDisk.schema, 'verify-approved-delta/v1');
    assert.equal(onDisk.verb, 'verify-approved');
  });

  it('throws when the run is not found', () => {
    assert.throws(
      () => verifyApproved({ runId: 'nope', dbPath: env.dbPath, outputDir: env.outputDir, stream: pipe() }),
      /Run not found/
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Pattern #8 cross-verb invariant — every verb produces the same envelope
// ═══════════════════════════════════════════════════════════════════════

describe('Pattern #8 envelope parity across verbs', () => {
  it('verify-recurring + verify-unverified + verify-approved share envelope shape', () => {
    const env = setupTempRun({ fileLine42Symbol: 'doThing' });
    try {
      const db = openDb(env.dbPath);
      db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha)
        VALUES ('r1', 'org/r', ?, ?)`).run(env.repoRoot, 'a'.repeat(40));
      db.prepare(`INSERT INTO waves (id, run_id, phase, wave_number, status)
        VALUES (1, 'r1', 'health-amend-a', 1, 'collected')`).run();

      // Empty results from each verb still produce identical-shape envelopes.
      const r = verifyRecurring({
        runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir, format: 'json', stream: pipe(),
      });
      const u = verifyUnverified({
        runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir, format: 'json', stream: pipe(),
      });
      const a = verifyApproved({
        runId: 'r1', dbPath: env.dbPath, outputDir: env.outputDir, format: 'json', stream: pipe(),
      });

      const required = [
        'schema', 'runId', 'waveNumber', 'checkedAt', 'verb',
        'summary', 'threshold', 'thresholdExceeded', 'exitCode', 'findings',
      ];
      for (const env of [r.delta, u.delta, a.delta]) {
        for (const k of required) {
          assert.ok(k in env, `key '${k}' missing from envelope (verb=${env.verb})`);
        }
        assert.ok('verified_via_distribution' in env.summary,
          `verified_via_distribution missing from summary (verb=${env.verb})`);
      }
      assert.notEqual(r.delta.verb, u.delta.verb);
      assert.notEqual(u.delta.verb, a.delta.verb);
    } finally {
      teardown(env.tempDir, env.dbPath);
    }
  });
});
