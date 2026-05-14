/**
 * wave-history-breadcrumb.test.js — Phase 5B-1 fold-in: close the 5B-0 audit
 * MEDIUM that `summarizeWaveHistory()` and the `formatStatus` breadcrumb
 * codepath are not pinned by tests because `stubStatus` in cli-smoke.test.js
 * sets `waves.current: null`, leaving the breadcrumb codepath dead under
 * test. The breadcrumb is load-bearing once `swarm rewind` ships — operators
 * need to see "this wave has rewind history" without raw SQL.
 *
 * Cordoned-test discipline: all DB work runs against an in-memory or fixture
 * tempdir DB. No live control-plane.db / no production paths.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, closeDb, openMemoryDb } from './db/connection.js';
import { transitionWave } from './lib/wave-state-machine.js';
import { summarizeWaveHistory, formatStatus, status } from './commands/status.js';

// ──────────────────────────────────────────────────────────────
// 1. summarizeWaveHistory unit tests — pure-function coverage
// ──────────────────────────────────────────────────────────────

describe('summarizeWaveHistory — pure unit coverage', () => {
  it('returns {count:0, interesting:false, lastReason:null} for empty events', () => {
    assert.deepEqual(summarizeWaveHistory([]), {
      count: 0,
      interesting: false,
      lastReason: null,
    });
  });

  it('single event from a non-blocked source is NOT interesting', () => {
    // dispatched -> failed is the common-case write; the breadcrumb stays
    // silent so steady-state status output does not gain a per-wave line.
    const events = [{ from_status: 'dispatched', to_status: 'failed', reason: 'collect rejected' }];
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 1);
    assert.equal(r.interesting, false);
    assert.equal(r.lastReason, null);
  });

  it('single event from a BLOCKED source IS interesting (override-only)', () => {
    // failed -> collected via override is the canonical revalidate audit row
    // — there is no preceding dispatched->failed in this slice because the
    // test simulates a wave seeded directly at failed (fixture setup) that
    // an operator then revalidated.
    const events = [{
      from_status: 'failed',
      to_status: 'collected',
      reason: 'revalidate: wave-2 corrected',
    }];
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 1);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, 'revalidate: wave-2 corrected');
  });

  it('two events including BLOCKED-source override IS interesting', () => {
    const events = [
      { from_status: 'dispatched', to_status: 'failed', reason: 'collect rejected' },
      { from_status: 'failed', to_status: 'collected', reason: 'revalidate: patched' },
    ];
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 2);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, 'revalidate: patched');
  });

  it('multiple events from non-blocked sources IS interesting (count > 1 rule)', () => {
    const events = [
      { from_status: 'dispatched', to_status: 'collected', reason: null },
      { from_status: 'collected', to_status: 'verified', reason: 'verified' },
      { from_status: 'verified', to_status: 'advanced', reason: 'promotion' },
    ];
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 3);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, 'promotion');
  });

  it('truncates lastReason past 60 chars with ellipsis', () => {
    const long = 'x'.repeat(80);
    const events = [
      { from_status: 'failed', to_status: 'collected', reason: long },
    ];
    const r = summarizeWaveHistory(events);
    assert.equal(r.interesting, true);
    assert.ok(r.lastReason.length <= 60,
      `lastReason must be <= 60 chars; got ${r.lastReason.length}`);
    assert.ok(r.lastReason.endsWith('...'),
      `truncated lastReason must end with '...'; got "${r.lastReason}"`);
  });

  it('rewind row out of a non-blocked source IS interesting (count > 1 fallback)', () => {
    // The rewind row by itself (single event, dispatched -> aborted_for_rewind)
    // is NOT a BLOCKED source override (dispatched is not blocked), so the
    // interesting trigger fires via count > 1 when paired with any prior
    // transition. We seed a dispatched->collected, then a rewind row, and
    // confirm the breadcrumb fires.
    const events = [
      { from_status: 'dispatched', to_status: 'collected', reason: 'normal collect' },
      { from_status: 'collected', to_status: 'aborted_for_rewind', reason: 'rewind: tear down' },
    ];
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 2);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, 'rewind: tear down');
  });

  it('rewind out of a BLOCKED (failed) source IS interesting even as sole event', () => {
    // Direct failed -> aborted_for_rewind via the override path. BLOCKED
    // source → interesting=true regardless of count.
    const events = [
      { from_status: 'failed', to_status: 'aborted_for_rewind', reason: 'rewind: unsalvageable' },
    ];
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 1);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, 'rewind: unsalvageable');
  });
});

// ──────────────────────────────────────────────────────────────
// 2. formatStatus integration — real DB fixture, breadcrumb renders
// ──────────────────────────────────────────────────────────────

describe('formatStatus breadcrumb — integration over real DB fixture', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'breadcrumb-fixture-'));
    dbPath = join(tempDir, 'control-plane.db');
  });

  afterEach(() => {
    if (dbPath) { try { closeDb(dbPath); } catch { /* */ } }
    if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ } }
    tempDir = undefined;
    dbPath = undefined;
  });

  function seedRunAndWave(waveStatus = 'dispatched') {
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tempDir, 'a'.repeat(40));
    const w = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES ('r1', 'health-amend-a', 1, ?, 'snap1')
    `).run(waveStatus);
    return { db, waveId: Number(w.lastInsertRowid) };
  }

  it('renders the breadcrumb when wave has rewind + override transitions', () => {
    const { db, waveId } = seedRunAndWave('dispatched');
    transitionWave(db, waveId, 'failed', 'collect rejected');
    transitionWave(db, waveId, 'collected', 'revalidate: patched outputs', true);
    transitionWave(db, waveId, 'aborted_for_rewind', 'rewind: dogfood reset', true);
    closeDb(dbPath);

    const s = status({ runId: 'r1', dbPath });
    const out = formatStatus(s);
    assert.match(out, /History:\s*3 transitions/);
    assert.match(out, /last reason: "rewind: dogfood reset"/);
    assert.match(out, new RegExp(`swarm history ${waveId}`));
  });

  it('does NOT render the breadcrumb when wave has only dispatched->failed', () => {
    const { db, waveId } = seedRunAndWave('dispatched');
    transitionWave(db, waveId, 'failed', 'collect rejected');
    closeDb(dbPath);

    const s = status({ runId: 'r1', dbPath });
    const out = formatStatus(s);
    // Single event from non-blocked source → no breadcrumb.
    assert.doesNotMatch(out, /History:.*transitions?/);
    assert.doesNotMatch(out, /last reason/);
    assert.doesNotMatch(out, new RegExp(`swarm history ${waveId}`));
  });

  it('renders breadcrumb after a single rewind override on a failed wave', () => {
    // Wave seeded directly at failed (fixture pattern from revalidate.test.js)
    // — when rewind aborts it, that's a single BLOCKED-source override which
    // should fire the breadcrumb.
    const { db, waveId } = seedRunAndWave('failed');
    transitionWave(db, waveId, 'aborted_for_rewind', 'rewind: only event', true);
    closeDb(dbPath);

    const s = status({ runId: 'r1', dbPath });
    const out = formatStatus(s);
    assert.match(out, /History:\s*1 transition/);
    assert.match(out, /last reason: "rewind: only event"/);
  });
});

// ──────────────────────────────────────────────────────────────
// 3. summarizeWaveHistory robustness against malformed inputs
// ──────────────────────────────────────────────────────────────

describe('summarizeWaveHistory — robustness', () => {
  it('handles events without reason field (null/undefined)', () => {
    const events = [
      { from_status: 'failed', to_status: 'collected', reason: null },
    ];
    const r = summarizeWaveHistory(events);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, null);
  });

  it('works against a real DB pulled through openMemoryDb', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp', 'a'.repeat(40));
    const w = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES ('r1', 'health-audit-a', 1, 'dispatched', 'snap1')
    `).run();
    const waveId = Number(w.lastInsertRowid);

    transitionWave(db, waveId, 'failed', 'first');
    transitionWave(db, waveId, 'collected', 'revalidate: corrected', true);

    const events = db.prepare(
      'SELECT * FROM wave_state_events WHERE wave_id = ? ORDER BY id'
    ).all(waveId);
    const r = summarizeWaveHistory(events);
    assert.equal(r.count, 2);
    assert.equal(r.interesting, true);
    assert.equal(r.lastReason, 'revalidate: corrected');
  });
});
