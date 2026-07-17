/**
 * f-f347d858-collect-scope-confirmed-path-normalize.test.js — F-f347d858 (LOW, wave 37):
 * scopeConfirmedToOwningDomain (commands/collect.js) resolved ownership via
 * matchesAnyGlob(filePath, domain.globs) using the RAW `file_path` column
 * straight from the DB — no normalization first. lib/fingerprint.js's own
 * (private) normalizePath exists specifically because two spellings of the
 * identical file (leading './', doubled/trailing slash, backslash, case
 * variant) must fingerprint — and now must OWNERSHIP-MATCH — identically.
 *
 * REACHABILITY, checked empirically against the real minimatch dependency
 * (v10.2.5) used by this package: minimatch's platform option defaults to
 * `process.platform`, and on win32 it already normalizes a backslash
 * separator and tolerates a doubled internal slash — so those two spellings
 * happen to match RAW on a Windows dev box today, but that is a *platform*
 * leniency, not a guarantee (on a POSIX CI runner, `isWindows` is false and
 * a literal backslash is just an ordinary path-segment character, matching
 * nothing). The CASE-variant failure, by contrast, is platform-INDEPENDENT:
 * minimatch's `nocase` option defaults to unset regardless of OS, and
 * matchesAnyGlob never passes it — so a case-variant file_path is the one
 * spelling proven to fail RAW on every platform, and is used below as the
 * definitive RED (pre-fix) -> GREEN (post-fix) proof. The other three
 * spellings (leading './', backslash, doubled slash) are asserted
 * POST-fix-only, as a correctness/portability guarantee: normalizing makes
 * this code behave identically regardless of which platform runs it,
 * instead of depending on whichever platform's minimatch happens to be
 * lenient today.
 *
 * Fixed by normalizing filePath (strip leading './', collapse doubled/
 * trailing slashes, backslash->forward-slash, lowercase — the same
 * transform as lib/fingerprint.js's normalizePath, duplicated locally as
 * collect.js's own normalizeFilePathForGlobMatch since that helper isn't
 * exported) immediately before the matchesAnyGlob call.
 *
 * Test invariants (RED->GREEN against the pre-fix code for the case-variant
 * assertion, verified by temporarily reverting commands/collect.js's
 * normalize call during authoring):
 *   1. A case-variant file_path still resolves to its owning domain
 *      (platform-independent proof).
 *   2. A leading-'./', backslash-separated, and doubled-slash file_path all
 *      still resolve to their owning domain post-fix (portability
 *      guarantee, not a platform-dependent RED claim).
 *   3. FAIL-CLOSED PRESERVED: a file_path matching NO domain at all (even
 *      after normalization) is still correctly excluded — the fix must not
 *      turn into a false-positive closer.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { scopeConfirmedToOwningDomain } from './commands/collect.js';

const RUN_ID = 'test-f-f347d858';
const DOMAIN = { name: 'swarm-cp-verbs', globs: ['packages/dogfood-swarm/commands/**'] };

const cleanupPaths = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

function seedOneFinding(filePath) {
  const tmp = mkdtempSync(join(tmpdir(), 'f-f347d858-'));
  cleanupPaths.push(tmp);
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`)
    .run(RUN_ID, tmp, 'a'.repeat(40));
  db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
    VALUES (?, 'F-TARGET', 'fp-1', 'LOW', 'quality', ?, 'a finding', 'unverified')`)
    .run(RUN_ID, filePath);
  return { db, dbPath };
}

/** @pins F-f347d858 */
describe('F-f347d858 — scopeConfirmedToOwningDomain normalizes file_path before matchesAnyGlob', () => {
  it('RED->GREEN (platform-independent): a case-variant file_path still resolves to its owning domain', () => {
    const { db, dbPath } = seedOneFinding('Packages/Dogfood-Swarm/Commands/Collect.js');
    try {
      const scoped = scopeConfirmedToOwningDomain(db, RUN_ID, [DOMAIN], [
        { domain: 'swarm-cp-verbs', confirmed: ['F-TARGET'] },
      ]);
      assert.deepEqual(scoped, ['F-TARGET'],
        'a case-variant file_path must still match its owning domain\'s (lowercase) glob after normalization');
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
    }
  });

  it('portability guarantee: a leading-"./"-prefixed file_path resolves to its owning domain', () => {
    const { db, dbPath } = seedOneFinding('./packages/dogfood-swarm/commands/collect.js');
    try {
      const scoped = scopeConfirmedToOwningDomain(db, RUN_ID, [DOMAIN], [
        { domain: 'swarm-cp-verbs', confirmed: ['F-TARGET'] },
      ]);
      assert.deepEqual(scoped, ['F-TARGET']);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
    }
  });

  it('portability guarantee: a backslash-separated file_path resolves to its owning domain', () => {
    const { db, dbPath } = seedOneFinding('packages\\dogfood-swarm\\commands\\collect.js');
    try {
      const scoped = scopeConfirmedToOwningDomain(db, RUN_ID, [DOMAIN], [
        { domain: 'swarm-cp-verbs', confirmed: ['F-TARGET'] },
      ]);
      assert.deepEqual(scoped, ['F-TARGET']);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
    }
  });

  it('portability guarantee: a doubled-slash file_path resolves to its owning domain', () => {
    const { db, dbPath } = seedOneFinding('packages//dogfood-swarm/commands/collect.js');
    try {
      const scoped = scopeConfirmedToOwningDomain(db, RUN_ID, [DOMAIN], [
        { domain: 'swarm-cp-verbs', confirmed: ['F-TARGET'] },
      ]);
      assert.deepEqual(scoped, ['F-TARGET']);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
    }
  });

  it('fail-closed preserved: a file_path matching NO domain (even normalized) is still excluded', () => {
    const { db, dbPath } = seedOneFinding('packages/some-unowned-domain/src/foo.js');
    try {
      const scoped = scopeConfirmedToOwningDomain(db, RUN_ID, [DOMAIN], [
        { domain: 'swarm-cp-verbs', confirmed: ['F-TARGET'] },
      ]);
      assert.deepEqual(scoped, [], 'normalization must not create false-positive ownership matches');
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
    }
  });
});
