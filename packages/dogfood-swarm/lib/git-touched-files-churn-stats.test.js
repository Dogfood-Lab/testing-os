/**
 * git-touched-files-churn-stats.test.js — F-e7c4c16d / F-swarmcpcore-004 (T2):
 * getChurnStats reports per-file churn RELATIVE to current file size
 * (Nagappan & Ball, ICSE 2005 — cited in the dispatch's own Q3: relative,
 * not absolute, churn discriminates), over a trailing --since window.
 *
 * Fixture pattern (initGitRepo/git/commitAll) duplicated from
 * git-touched-files.test.js rather than imported — matches this repo's own
 * per-file convention for small test fixtures (that file's own header cites
 * the same precedent from wave12-swarm-cp-pins.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getChurnStats } from './git-touched-files.js';

function git(cwd, args, extraEnv) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t.t']);
  git(repoPath, ['config', 'user.name', 't']);
}

function commitAll(repoPath, message) {
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', message]);
}

/** Commit with an explicit author+committer date — no history rewrite needed. */
function commitAllAt(repoPath, message, isoDate) {
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate });
}

describe('getChurnStats — relative per-file churn over a trailing window (F-e7c4c16d)', () => {
  it('ranks a repeatedly-REWRITTEN small file above a single-commit large file', () => {
    // A single ADD's lines_changed always equals the file's own size at that
    // moment (relative_churn's natural ceiling ≈ 1.0) — a large file touched
    // ONCE cannot exceed that ceiling. A SMALL file that is fully REPLACED
    // (not merely appended to) many times accumulates delete+add churn well
    // past its OWN final size, which is exactly the shape relative churn is
    // meant to surface over an absolute lines-changed count.
    const repoPath = mkdtempSync(join(tmpdir(), 'git-churn-'));
    try {
      initGitRepo(repoPath);

      writeFileSync(join(repoPath, 'quiet.js'), Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n');
      writeFileSync(join(repoPath, 'hot.js'), 'version 0\n');
      commitAll(repoPath, 'seed');

      for (let i = 1; i <= 10; i++) {
        // Full-content replacement (a different single line each time), so
        // git sees a clean delete-of-old + add-of-new rather than an
        // unchanged-line match.
        writeFileSync(join(repoPath, 'hot.js'), `version ${i}\n`);
        commitAll(repoPath, `rewrite hot.js #${i}`);
      }

      const stats = getChurnStats(repoPath, { sinceDays: 3650 });
      assert.equal(stats.available, true);

      const hot = stats.files.find(f => f.file === 'hot.js');
      const quiet = stats.files.find(f => f.file === 'quiet.js');
      assert.ok(hot, 'hot.js must appear in the churn stats');
      assert.ok(quiet, 'quiet.js must appear in the churn stats');
      assert.ok(
        hot.relative_churn > quiet.relative_churn,
        `relative churn must rank the repeatedly-rewritten small file above the single-commit large one — got hot=${hot.relative_churn} quiet=${quiet.relative_churn}`,
      );
      assert.ok(hot.relative_churn > 1, `hot.js's accumulated churn must exceed its OWN current size (the whole point of relative churn) — got ${hot.relative_churn}`);

      // Determinism: hot.js must sort strictly before quiet.js.
      const hotIdx = stats.files.findIndex(f => f.file === 'hot.js');
      const quietIdx = stats.files.findIndex(f => f.file === 'quiet.js');
      assert.ok(hotIdx < quietIdx, 'files must be sorted by relative_churn DESC');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('excludes commits outside the --since window', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'git-churn-window-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'old.js'), 'line 0\n');
      commitAllAt(repoPath, 'ancient commit', '2000-01-01T00:00:00');

      const stats = getChurnStats(repoPath, { sinceDays: 1 });
      assert.equal(stats.available, true);
      assert.equal(stats.files.length, 0, 'a commit dated year 2000 must not appear inside a 1-day window');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('returns available:false (never throws) when the path is not a git repo', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'git-churn-not-a-repo-'));
    try {
      const stats = getChurnStats(notARepo);
      assert.equal(stats.available, false);
      assert.deepEqual(stats.files, []);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('defaults sinceDays to 90 when omitted', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'git-churn-default-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'a.js'), 'line 0\n');
      commitAll(repoPath, 'seed');
      const stats = getChurnStats(repoPath);
      assert.equal(stats.since_days, 90);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
