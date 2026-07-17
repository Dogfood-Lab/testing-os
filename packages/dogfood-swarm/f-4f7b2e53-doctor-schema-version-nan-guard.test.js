/**
 * f-4f7b2e53-doctor-schema-version-nan-guard.test.js — F-4f7b2e53 (LOW, wave 37):
 * doctor.js's checkSchemaVersion did `onDisk = row ? parseInt(row.value, 10) : 0`
 * with no NaN guard — unlike this exact file's OWN checkNodeVersion (which
 * guards with `Number.isFinite(major) &&`) and history.js:43 / redrive.js:178,
 * which both guard a CLI-supplied numeric input the same way.
 *
 * PROVEN LIVE (isolated scratch DB, zero writes to the real control-plane.db):
 * seeding a fresh SQLite file's kv.schema_version with the non-numeric string
 * 'not-a-number' made the real, unmutated runDoctor() report the
 * schema-version check as `{status: 'pass', message: "...schema vNaN is
 * understood by this build..."}` and the overall verdict `pass` / exitCode 0
 * — because `NaN > SCHEMA_VERSION` (the only branch capable of reporting
 * FAIL) is always false, so a corrupted value silently fell through to a
 * self-evidently-broken "pass" message instead of being surfaced.
 *
 * The fix guards with `Number.isFinite(onDisk)` before the comparison,
 * reporting 'warn' (matching the sibling branch immediately above it, which
 * already reports 'warn' for a DB it cannot even read) instead of a lying
 * 'pass'.
 *
 * Test invariants (RED->GREEN against the pre-fix code, verified by
 * temporarily reverting commands/doctor.js's guard during authoring):
 *   1. A corrupted (non-numeric) kv.schema_version reports status 'warn',
 *      never 'pass' and never a hard 'fail' (doctor cannot itself resolve
 *      the corruption, so it discloses rather than gates).
 *   2. The warn message names the actual corrupted value, not "vNaN".
 *   3. A WARN never gates the exit code — overallStatus/exitCode stay
 *      warn/0, matching this file's own documented exit-code contract.
 *   4. CONTROL: an ordinary, freshly-created control-plane.db (untouched
 *      schema_version) still reports 'pass'.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor } from './commands/doctor.js';
import { openDb, closeDb } from './db/connection.js';

const cleanupPaths = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

function freshDbPath(prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(tmp);
  const dbPath = join(tmp, 'control-plane.db');
  // Bootstrap a real, current-schema DB via the real openDb path (never
  // hand-written schema SQL) so the corruption below is the ONLY deviation
  // from a genuinely valid control-plane.db.
  openDb(dbPath);
  closeDb(dbPath);
  return dbPath;
}

function corruptSchemaVersion(dbPath, rawValue) {
  const db = new Database(dbPath);
  try {
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(rawValue);
  } finally {
    db.close();
  }
}

/** @pins F-4f7b2e53 */
describe('F-4f7b2e53 — doctor checkSchemaVersion guards a corrupted (non-numeric) schema_version', () => {
  it('a non-numeric kv.schema_version reports WARN, not a lying PASS, and does not gate the exit code', () => {
    const dbPath = freshDbPath('f-4f7b2e53-corrupt-');
    corruptSchemaVersion(dbPath, 'not-a-number');

    const report = runDoctor({ dbPath });
    const check = report.checks.find((c) => c.id === 'schema-version');

    assert.ok(check, 'doctor must include a schema-version check');
    assert.equal(check.status, 'warn',
      `a corrupted (NaN-parsing) schema_version must report 'warn', not '${check.status}' — doctor cannot resolve the corruption itself`);
    assert.doesNotMatch(check.message, /vNaN/,
      `the pre-fix defect: a lying "vNaN is understood" pass message must not appear; got: ${JSON.stringify(check.message)}`);
    assert.match(check.message, /not-a-number/,
      `the warn message should name the actual corrupted value so the operator can act on it; got: ${JSON.stringify(check.message)}`);
    assert.equal(report.overallStatus, 'warn', 'a schema-version WARN must roll up to overallStatus warn (no other check fails)');
    assert.equal(report.exitCode, 0, 'a WARN must never gate the exit code — only a hard FAIL does');
  });

  it('control: an ordinary, freshly-created control-plane.db reports PASS for schema-version', () => {
    const dbPath = freshDbPath('f-4f7b2e53-clean-');

    const report = runDoctor({ dbPath });
    const check = report.checks.find((c) => c.id === 'schema-version');

    assert.equal(check.status, 'pass', 'a freshly-created, uncorrupted control-plane.db must report pass');
    assert.equal(report.exitCode, 0);
  });
});
