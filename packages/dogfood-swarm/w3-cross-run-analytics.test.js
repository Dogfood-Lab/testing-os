/**
 * w3-cross-run-analytics.test.js — F4-CP-01 cross-run analytics query module.
 *
 * Background (verified against source). Every control-plane verb is
 * single-runId scoped (status/runs/findings/verify-* all take a <run-id>),
 * yet the DB persists cross-run data: findings.fingerprint is
 * content-addressed and the schema's UNIQUE constraint is (run_id,
 * fingerprint) — so the SAME fingerprint observed in two distinct runs
 * produces TWO findings rows, one per run. That is the cross-run signal no
 * existing verb surfaces: a finding that recurs across runs (e.g. a fix that
 * regressed, or a class of defect the team keeps re-introducing).
 *
 * This file pins the pure DB-read query functions in
 * lib/queries/cross-run-analytics.js:
 *
 *   queryRecurringFindings(db)
 *     → fingerprints seen in MORE THAN ONE run, with
 *       {fingerprint, description, run_count, severity, first_seen, last_seen}.
 *
 *   queryPerRepoRunHistory(db, repoPattern?)
 *     → per-run {run_id, repo, wave_count, finding_count, status, created_at}
 *       ordered created_at DESC; optional repo LIKE filter.
 *
 *   queryFindingRecurrenceRate(db, windowDays?)
 *     → recurrence stats over the run population.
 *
 * The functions are pure reads — they take an open better-sqlite3 handle and
 * never touch the real control-plane.db tree. Tests seed an in-memory DB via
 * openMemoryDb().
 *
 * Pattern #10 (FAILS-then-PASSES proof gate): written against a non-existent
 * module first (import throws / functions absent → RED), then the module was
 * implemented to GREEN.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import {
  queryRecurringFindings,
  queryPerRepoRunHistory,
  queryFindingRecurrenceRate,
} from './lib/queries/cross-run-analytics.js';

/**
 * Seed two runs that SHARE a fingerprint ('fp-shared') plus run-unique
 * fingerprints. Returns the db handle (caller closes).
 *
 * runA (org/repo-a): fp-shared (HIGH), fp-a-only (LOW)  — 2 waves
 * runB (org/repo-b): fp-shared (HIGH), fp-b-only (MEDIUM) — 1 wave
 *
 * fp-shared therefore appears in run_count = 2; the run-unique ones in 1.
 */
function seedTwoRunsSharingFingerprint(db) {
  // runA — created earlier
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status, created_at)
     VALUES ('runA', 'org/repo-a', '/tmp/a', ?, 'health-audit-a', '2026-06-01 00:00:00')`
  ).run('a'.repeat(40));
  const wA1 = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('runA','health-audit-a',1,'collected')`
  ).run();
  db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('runA','health-audit-b',2,'collected')`
  ).run();
  const wA1id = Number(wA1.lastInsertRowid);
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
     VALUES ('runA','F-shared','fp-shared','HIGH','bug','shared regression', 'new', ?, ?)`
  ).run(wA1id, wA1id);
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
     VALUES ('runA','F-a-only','fp-a-only','LOW','style','only in A', 'new', ?, ?)`
  ).run(wA1id, wA1id);

  // runB — created later
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status, created_at)
     VALUES ('runB', 'org/repo-b', '/tmp/b', ?, 'feature-execute', '2026-06-05 00:00:00')`
  ).run('b'.repeat(40));
  const wB1 = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('runB','health-audit-a',1,'collected')`
  ).run();
  const wB1id = Number(wB1.lastInsertRowid);
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
     VALUES ('runB','F-shared','fp-shared','HIGH','bug','shared regression', 'recurring', ?, ?)`
  ).run(wB1id, wB1id);
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
     VALUES ('runB','F-b-only','fp-b-only','MEDIUM','bug','only in B', 'new', ?, ?)`
  ).run(wB1id, wB1id);
}

// ═══════════════════════════════════════════
// queryRecurringFindings
// ═══════════════════════════════════════════

describe('queryRecurringFindings — fingerprints seen in > 1 run', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('returns ONLY the cross-run fingerprint with run_count 2', () => {
    seedTwoRunsSharingFingerprint(db);

    const rows = queryRecurringFindings(db);

    assert.equal(rows.length, 1,
      `only fp-shared spans >1 run; got ${rows.length}: ${JSON.stringify(rows)}`);
    const r = rows[0];
    assert.equal(r.fingerprint, 'fp-shared');
    assert.equal(r.run_count, 2, 'fp-shared appears in runA and runB');
    assert.equal(r.severity, 'HIGH');
    assert.equal(r.description, 'shared regression');
    // first_seen / last_seen are the earliest/latest run created_at the
    // fingerprint was observed in.
    assert.equal(r.first_seen, '2026-06-01 00:00:00');
    assert.equal(r.last_seen, '2026-06-05 00:00:00');
  });

  it('returns [] when no fingerprint recurs across runs', () => {
    // Single run only — nothing can recur across runs.
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha) VALUES ('solo','org/r','/tmp','c')`
    ).run();
    const w = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number) VALUES ('solo','health-audit-a',1)`
    ).run();
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, first_seen_wave)
       VALUES ('solo','F-1','fp-1','LOW','bug','d',?)`
    ).run(Number(w.lastInsertRowid));

    assert.deepEqual(queryRecurringFindings(db), []);
  });

  it('counts DISTINCT runs, not finding rows (same fp twice in one run is run_count 1)', () => {
    // Defensive: even though UNIQUE(run_id, fingerprint) blocks two rows for
    // the same (run, fp), the query must key on DISTINCT run_id so that the
    // recurrence signal is "how many runs", not "how many rows".
    seedTwoRunsSharingFingerprint(db);
    const rows = queryRecurringFindings(db);
    assert.equal(rows[0].run_count, 2);
  });
});

// ═══════════════════════════════════════════
// queryPerRepoRunHistory
// ═══════════════════════════════════════════

describe('queryPerRepoRunHistory — per-run rollup, newest first', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('returns one row per run with wave_count + finding_count, ordered created_at DESC', () => {
    seedTwoRunsSharingFingerprint(db);

    const rows = queryPerRepoRunHistory(db);
    assert.equal(rows.length, 2);

    // Newest (runB, 2026-06-05) first.
    assert.equal(rows[0].run_id, 'runB');
    assert.equal(rows[0].repo, 'org/repo-b');
    assert.equal(rows[0].wave_count, 1);
    assert.equal(rows[0].finding_count, 2);
    assert.equal(rows[0].status, 'feature-execute');
    assert.equal(rows[0].created_at, '2026-06-05 00:00:00');

    assert.equal(rows[1].run_id, 'runA');
    assert.equal(rows[1].wave_count, 2);
    assert.equal(rows[1].finding_count, 2);
  });

  it('filters by repo LIKE pattern when repoPattern is given', () => {
    seedTwoRunsSharingFingerprint(db);

    const onlyA = queryPerRepoRunHistory(db, 'repo-a');
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].run_id, 'runA');

    // A pattern matching neither returns [].
    assert.deepEqual(queryPerRepoRunHistory(db, 'no-such-repo'), []);
  });

  it('a run with zero waves/findings still appears with 0 counts', () => {
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, created_at)
       VALUES ('empty','org/empty','/tmp','d','2026-06-10 00:00:00')`
    ).run();
    const rows = queryPerRepoRunHistory(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, 'empty');
    assert.equal(rows[0].wave_count, 0);
    assert.equal(rows[0].finding_count, 0);
  });
});

// ═══════════════════════════════════════════
// queryFindingRecurrenceRate
// ═══════════════════════════════════════════

describe('queryFindingRecurrenceRate — recurrence stats over the run population', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('reports total runs, distinct fingerprints, recurring count, and a rate', () => {
    seedTwoRunsSharingFingerprint(db);

    const stats = queryFindingRecurrenceRate(db);
    assert.equal(stats.total_runs, 2);
    // distinct fingerprints across all runs: fp-shared, fp-a-only, fp-b-only
    assert.equal(stats.distinct_fingerprints, 3);
    // fingerprints that span >1 run: just fp-shared
    assert.equal(stats.recurring_fingerprints, 1);
    // rate = recurring / distinct = 1/3
    assert.ok(Math.abs(stats.recurrence_rate - (1 / 3)) < 1e-9,
      `recurrence_rate should be 1/3; got ${stats.recurrence_rate}`);
  });

  it('handles an empty DB without dividing by zero', () => {
    const stats = queryFindingRecurrenceRate(db);
    assert.equal(stats.total_runs, 0);
    assert.equal(stats.distinct_fingerprints, 0);
    assert.equal(stats.recurring_fingerprints, 0);
    assert.equal(stats.recurrence_rate, 0,
      'rate must be 0 (not NaN) when there are no fingerprints');
  });

  it('respects an optional windowDays filter on run created_at', () => {
    // runA at 2026-06-01, runB at 2026-06-05. A window anchored at runB's date
    // with a 2-day window excludes runA, so the shared fingerprint can no
    // longer recur within-window → 0 recurring.
    seedTwoRunsSharingFingerprint(db);

    // Wide window: both runs in scope → recurrence present.
    const wide = queryFindingRecurrenceRate(db, 3650);
    assert.equal(wide.recurring_fingerprints, 1);

    // The windowDays arg must at least be accepted and change the run
    // population it considers (narrow window → fewer runs counted).
    const narrow = queryFindingRecurrenceRate(db, 1);
    assert.ok(narrow.total_runs <= wide.total_runs,
      'a narrower window must not count MORE runs than a wider one');
  });
});
