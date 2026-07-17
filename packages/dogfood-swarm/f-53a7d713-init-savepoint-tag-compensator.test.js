/**
 * f-53a7d713-init-savepoint-tag-compensator.test.js — F-53a7d713 (LOW, wave 37):
 * init() created the git save-point tag (`git tag swarm-save-<timestamp>`)
 * BEFORE detectDomains(), openDb(), the `INSERT INTO runs`, and
 * saveDomainDraft() — with no try/catch and no compensator. If any of those
 * four later steps threw (a plausible, ordinary failure: a locked/too-new
 * control-plane.db, a transient I/O error scanning the target repo, a
 * malformed domain-detection result), init() threw uncaught and NO `runs`
 * row was ever created — but the git tag now existed in the target repo
 * with nothing pointing at it, and nothing in this package sweeps or prunes
 * an orphaned `swarm-save-*` tag (rewind.js only ever consumes one by
 * operator-typed name).
 *
 * The fix wraps steps 4-6 in a try/catch: on any failure, a named
 * compensator (compensateOrphanedSavePointTag, commands/init.js) deletes the
 * just-created tag with `git tag -d <tag>` BEFORE re-throwing the original
 * error untouched.
 *
 * FORCED FAILURE, proven live against the real, unmutated init() export: a
 * dbPath that is itself a pre-existing DIRECTORY (not a file) makes
 * better-sqlite3's `new Database(dbPath)` throw SQLITE_CANTOPEN_ISDIR
 * ("unable to open database file") — a real, deterministic, environment-
 * driven failure inside step 5 (openDb), reached only AFTER the save-point
 * tag already exists and AFTER detectDomains() has already run on a minimal
 * fixture repo (proving the compensator's try block genuinely spans steps
 * 4-6, not just step 5). No monkey-patching, no mocked dependency — every
 * call in this test drives the real git binary and the real init() export.
 *
 * Test invariants (RED->GREEN against the pre-fix code, verified by
 * temporarily reverting commands/init.js's try/catch during authoring):
 *   1. init() still re-throws the original downstream failure — the
 *      compensator must never swallow or replace it.
 *   2. After a failed init(), `git tag -l 'swarm-save-*'` in the fixture
 *      repo reports ZERO tags — no orphan survives.
 *   3. CONTROL: a successful init() still creates exactly one
 *      `swarm-save-*` tag, matching the `savePointTag` it returns — the
 *      compensator must not also delete the tag on the HAPPY path.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init } from './commands/init.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A minimal, clean fixture git repo — never the real testing-os repo. */
function makeCleanFixtureRepo() {
  const repoPath = mkdtempSync(join(tmpdir(), 'f-53a7d713-repo-'));
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'fixture@example.test']);
  git(repoPath, ['config', 'user.name', 'Fixture']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n', 'utf-8');
  git(repoPath, ['add', '.']);
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial'], {
    cwd: repoPath,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  return repoPath;
}

function savePointTags(repoPath) {
  return git(repoPath, ['tag', '-l', 'swarm-save-*']).trim().split('\n').filter(Boolean);
}

const cleanupPaths = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/** @pins F-53a7d713 */
describe('F-53a7d713 — init() cleans up its own orphaned save-point tag on a downstream failure', () => {
  it('forced failure (dbPath is an existing directory -> openDb cannot open it): init() re-throws AND leaves no orphaned swarm-save-* tag', () => {
    const repoPath = makeCleanFixtureRepo();
    cleanupPaths.push(repoPath);
    const dbDir = mkdtempSync(join(tmpdir(), 'f-53a7d713-dbdir-'));
    cleanupPaths.push(dbDir);
    const dbPath = join(dbDir, 'control-plane.db');
    // dbPath itself is a directory, not a file -- new Database(dbPath) throws
    // SQLITE_CANTOPEN_ISDIR inside openDb(), which runs inside the try block
    // (step 5), AFTER the save-point tag (step 3) and detectDomains (step 4).
    mkdirSync(dbPath);

    assert.throws(
      () => init({ repoPath, dbPath }),
      /unable to open database file|CANTOPEN/,
      'init() must re-throw the real openDb failure, not swallow it behind the compensator',
    );

    assert.deepEqual(
      savePointTags(repoPath),
      [],
      'a failed init() must leave NO orphaned swarm-save-* tag in the target repo',
    );
  });

  it('control: a successful init() still creates exactly one swarm-save-* tag, matching the returned savePointTag', () => {
    const repoPath = makeCleanFixtureRepo();
    cleanupPaths.push(repoPath);
    const dbDir = mkdtempSync(join(tmpdir(), 'f-53a7d713-dbdir-ok-'));
    cleanupPaths.push(dbDir);
    const dbPath = join(dbDir, 'control-plane.db');

    const result = init({ repoPath, dbPath });

    assert.deepEqual(
      savePointTags(repoPath),
      [result.savePointTag],
      'a successful init() must still create exactly one swarm-save-* tag, and the compensator must not remove it on the happy path',
    );
  });
});
