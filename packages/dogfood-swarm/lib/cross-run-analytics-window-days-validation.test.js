/**
 * cross-run-analytics-window-days-validation.test.js — F-36327af8: a
 * malformed `windowDays` argument to queryFindingRecurrenceRate produced a
 * clean, misleadingly-healthy all-zero result instead of an error —
 * indistinguishable from a genuinely quiet run history. `Number()` on a
 * non-numeric string (the realistic operator typo '30days', or 'abc') is
 * NaN, and SQLite's datetime() returns NULL for an unparseable modifier
 * like '-NaN days' rather than throwing, so the WHERE clause matched zero
 * rows silently.
 *
 * Not reachable via the shipped `swarm trends` CLI (cli.js already validates
 * --window-days with a strict regex) but IS reachable via this package's
 * documented `./lib/*` export — any external consumer importing
 * queryFindingRecurrenceRate directly gets a plausible-looking "no recurring
 * findings" report instead of a signal that ITS OWN input was malformed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { queryFindingRecurrenceRate } from './queries/cross-run-analytics.js';

// Seeds one genuinely-recurring fingerprint across two runs, so the
// malformed-input tests below are provably NOT just "an empty DB looks
// empty" — real recurrence exists and a correct call finds it.
function seedRecurringFingerprint(db) {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, created_at) VALUES ('runA','org/r','/tmp/a',?,'2026-06-01 00:00:00')`).run('a'.repeat(40));
  db.prepare(`INSERT INTO waves (run_id, phase, wave_number) VALUES ('runA','health-audit-a',1)`).run();
  db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, first_seen_wave) VALUES ('runA','F-1','fp-shared','HIGH','bug','d',1)`).run();
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, created_at) VALUES ('runB','org/r','/tmp/b',?,'2026-06-05 00:00:00')`).run('b'.repeat(40));
  db.prepare(`INSERT INTO waves (run_id, phase, wave_number) VALUES ('runB','health-audit-a',1)`).run();
  db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, first_seen_wave) VALUES ('runB','F-2','fp-shared','HIGH','bug','d',1)`).run();
}

describe('queryFindingRecurrenceRate — windowDays validation (F-36327af8)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); seedRecurringFingerprint(db); });
  afterEach(() => { db.close(); });

  it('regression control: undefined/null windowDays still means "all runs", unaffected by the new guard', () => {
    assert.equal(queryFindingRecurrenceRate(db, undefined).recurring_fingerprints, 1);
    assert.equal(queryFindingRecurrenceRate(db, null).recurring_fingerprints, 1);
  });

  it('regression control: a genuinely valid numeric windowDays still works exactly as before', () => {
    const stats = queryFindingRecurrenceRate(db, 3650);
    assert.equal(stats.total_runs, 2);
    assert.equal(stats.recurring_fingerprints, 1);
    assert.equal(stats.window_days, 3650);
  });

  /** @pins F-36327af8 */
  it('throws — never silently returns an all-zero result — for a non-numeric windowDays string', () => {
    // '30days' is the realistic operator typo the finding names: Number()
    // yields NaN, which the pre-fix code fed straight into the SQL date
    // modifier and SQLite silently NULLed out.
    assert.throws(
      () => queryFindingRecurrenceRate(db, '30days'),
      /windowDays must be a finite number/,
    );
    assert.throws(
      () => queryFindingRecurrenceRate(db, 'abc'),
      /windowDays must be a finite number/,
    );
  });

  it('GATE (mutation control): the thrown message names the actual malformed value, not a generic complaint', () => {
    assert.throws(
      () => queryFindingRecurrenceRate(db, 'not-a-number'),
      (err) => {
        assert.match(err.message, /"not-a-number"/);
        return true;
      },
    );
  });

  it('a numeric STRING (e.g. "30", as a query-string value would arrive) is accepted, matching the CLI\'s own tolerance', () => {
    // cli.js's --window-days validation accepts digit strings and this
    // function has always coerced via Number() — the fix must not narrow
    // that existing tolerance, only reject genuinely non-numeric input.
    const stats = queryFindingRecurrenceRate(db, '3650');
    assert.equal(stats.recurring_fingerprints, 1);
  });
});
