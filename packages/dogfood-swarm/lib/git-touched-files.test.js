/**
 * git-touched-files.test.js — F-60a257a6: a git rename/copy's SOURCE path
 * must be part of the independently-computed touched-file set, not silently
 * discarded.
 *
 * THE GAP. `git status --porcelain -z` emits a rename/copy as ONE record:
 * `RM <dest>\0<source>\0` (destination in the primary field, source as a
 * separate trailing NUL field — no ` -> ` separator under `-z`). Verified
 * directly against real git in this session:
 *
 *   $ git mv old.js new.js && echo world >> new.js && git status --porcelain -z | xxd
 *   RM new.js\0old.js\0
 *
 * The pre-fix loop consumed and discarded that source field (`i++` with no
 * read) — VD-NEW-1's own header says this module exists so ownership
 * enforcement does NOT trust an agent's self-report, but for a rename INTO
 * an agent's domain from OUTSIDE it, the source half of that move was
 * invisible to the one probe meant to catch exactly that. The REVERSE
 * direction (moving a file OUT of the agent's own domain) was already
 * caught, because the destination path itself fails the domain-glob match —
 * only the move-IN direction was blind.
 *
 * WHY A REAL GIT REPO, NOT A HAND-BUILT porcelain STRING. This module's own
 * fp-003 comment explains -z's NUL-terminated, unescaped-UTF-8 wire format
 * is exactly why a previous bug (path mangling) went unnoticed — a fixture
 * that fabricates the porcelain bytes by hand could accidentally encode the
 * fix's assumption instead of testing it against what git actually emits.
 * Every test below drives a real `git mv` + edit through a real temp repo,
 * mirroring the initGitRepo pattern already used in
 * wave12-swarm-cp-pins.test.js / stage-c-truth-pins.test.js (duplicated
 * here rather than imported, matching this repo's per-file convention for
 * small test fixtures).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getActualTouchedFiles } from './git-touched-files.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
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

describe('getActualTouchedFiles — rename/copy source path (F-60a257a6)', () => {
  it('a rename WITH a content edit (RM status) reports the source as deleted, not just the destination', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'git-touched-rename-'));
    try {
      initGitRepo(repoPath);
      mkdirSync(join(repoPath, 'other-domain'), { recursive: true });
      writeFileSync(join(repoPath, 'other-domain', 'file.js'), 'hello\n');
      commitAll(repoPath, 'seed');

      // Simulate an agent adopting a file FROM outside its domain INTO its
      // own territory, with an edit — this is the exact shape the finding
      // reproduced (RM, not a pure rename).
      git(repoPath, ['mv', 'other-domain/file.js', 'src-file.js']);
      writeFileSync(join(repoPath, 'src-file.js'), 'hello\nworld\n');

      const result = getActualTouchedFiles(repoPath);

      assert.ok(
        result.all.includes('other-domain/file.js'),
        `the rename SOURCE must be in the touched set so ownership enforcement can see it — got: ${JSON.stringify(result.all)}`,
      );
      assert.ok(result.all.includes('src-file.js'), 'the rename DESTINATION must still be in the touched set (unchanged behavior)');
      assert.ok(result.deleted.includes('other-domain/file.js'), 'the source is bucketed as deleted — it no longer exists at that path');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('a PURE rename with no content edit (R status, no M) also reports the source', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'git-touched-pure-rename-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'old-name.js'), 'unchanged content\n');
      commitAll(repoPath, 'seed');

      git(repoPath, ['mv', 'old-name.js', 'new-name.js']);

      const result = getActualTouchedFiles(repoPath);
      assert.ok(result.all.includes('old-name.js'), `pure-rename source must be touched — got: ${JSON.stringify(result.all)}`);
      assert.ok(result.all.includes('new-name.js'));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('an ordinary modification (no rename) is unaffected — no phantom source entries appear', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'git-touched-plain-edit-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'a.js'), 'one\n');
      commitAll(repoPath, 'seed');
      writeFileSync(join(repoPath, 'a.js'), 'one\ntwo\n');

      const result = getActualTouchedFiles(repoPath);
      assert.deepEqual(result.all, ['a.js']);
      assert.deepEqual(result.deleted, []);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('a genuine deletion (no rename involved) still works exactly as before', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'git-touched-real-delete-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'gone.js'), 'bye\n');
      commitAll(repoPath, 'seed');
      rmSync(join(repoPath, 'gone.js'));

      const result = getActualTouchedFiles(repoPath);
      assert.deepEqual(result.deleted, ['gone.js']);
      assert.deepEqual(result.all, ['gone.js']);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('the move-OUT direction stays caught the way it already was (regression guard) — destination fails a downstream glob check regardless', () => {
    // This module does not itself apply domain globs (that is checkOwnership,
    // lib/domains.js, out of this test's scope) — this test just confirms
    // getActualTouchedFiles still reports BOTH halves of a move-out rename
    // (src.js -> other-domain/file.js) so a downstream glob check has both
    // paths to evaluate, same as the move-in case above.
    const repoPath = mkdtempSync(join(tmpdir(), 'git-touched-move-out-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'src-file.js'), 'hello\n');
      commitAll(repoPath, 'seed');

      mkdirSync(join(repoPath, 'other-domain'), { recursive: true });
      git(repoPath, ['mv', 'src-file.js', 'other-domain/file.js']);

      const result = getActualTouchedFiles(repoPath);
      assert.ok(result.all.includes('src-file.js'), 'the vacated source must be visible');
      assert.ok(result.all.includes('other-domain/file.js'), 'the new destination must be visible');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
