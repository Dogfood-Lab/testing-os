/**
 * stageC-worktree-merge-gitargs.test.js
 *
 * Stage-C (humanization) amend — d4-swarm-core-B003 (LOW, defensive).
 *
 * mergeWorktree()'s conflict-recovery catch block used the shell-form git()
 * helper for its two recovery calls:
 *
 *     git(repoPath, 'diff --name-only --diff-filter=U')
 *     git(repoPath, 'merge --abort')
 *
 * while the rest of the module routes every branch/path-bearing call through
 * the argv-array gitArgs() helper (execFileSync, no shell). The two calls use
 * fixed argument strings with no interpolation, so there is no LIVE injection
 * vector — but the inconsistency is a latent footgun: a future maintainer who
 * interpolates a branch-derived argument into one of those shell strings would
 * silently bypass the module's argv-array defense-in-depth.
 *
 * The fix converts both calls to gitArgs(repoPath, [...]). This file pins:
 *   1. A SOURCE-level seal: mergeWorktree's body contains no shell-form git()
 *      call (only gitArgs / execFileSync survive). Goes RED on the pre-fix
 *      source.
 *   2. A BEHAVIORAL proof: the conflict-recovery path still works end to end
 *      against a real git repo — a genuine merge conflict is detected, the
 *      merge is aborted, and merged:false + the conflicting file are returned,
 *      AND the clean (no-conflict) merge still returns merged:true. This proves
 *      the gitArgs swap is behavior-preserving, not just a textual edit.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorktree, mergeWorktree } from './lib/worktree.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'stageC-merge-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, '.gitignore'), '.swarm/\n', 'utf-8');
  writeFileSync(join(root, 'file.txt'), 'base line\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'root']);
  return root;
}

// ═══════════════════════════════════════════
// Source seal — no shell-form git() survives in mergeWorktree
// ═══════════════════════════════════════════

describe('B003 — mergeWorktree routes every git call through gitArgs (source seal)', () => {
  it('mergeWorktree body contains no shell-form git( call (RED on pre-fix source)', () => {
    const src = readFileSync(join(__dirname, 'lib/worktree.js'), 'utf-8');

    // Extract the mergeWorktree function body. Anchor on the export and stop
    // at the next top-level `export function` / end of the removeWorktree
    // header so we scan only this function, not the whole module (which
    // legitimately defines the git() helper itself).
    const startIdx = src.indexOf('export function mergeWorktree');
    assert.ok(startIdx >= 0, 'mergeWorktree must exist');
    const afterStart = src.slice(startIdx);
    // Body ends at the start of the NEXT top-level doc-comment + export.
    const endRel = afterStart.indexOf('export function removeWorktree');
    assert.ok(endRel > 0, 'removeWorktree must follow mergeWorktree');
    const rawBody = afterStart.slice(0, endRel);

    // Strip comments before scanning — the live fix carries a doc comment that
    // mentions the shell-form `git()` helper in prose, and the source seal must
    // scan executable code only, not documentation that names the token.
    const body = rawBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => { const i = line.indexOf('//'); return i >= 0 ? line.slice(0, i) : line; })
      .join('\n');

    // The shell-form helper is `git(` ; the argv-array helper is `gitArgs(`.
    // A naive /git\(/ would also match `gitArgs(`, so require a word boundary
    // BEFORE git that is NOT the `Args` suffix: match `git(` only when not
    // immediately preceded by an identifier char and not immediately followed
    // by `Args`. Simplest robust check: strip every `gitArgs(` occurrence,
    // then assert no bare `git(` remains.
    const withoutGitArgs = body.replace(/gitArgs\(/g, 'XXARGSXX(');
    assert.ok(
      !/\bgit\(/.test(withoutGitArgs),
      'mergeWorktree must not use the shell-form git() helper — route conflict ' +
      'recovery through the argv-array gitArgs() helper for injection-safety parity',
    );

    // And positively confirm the two recovery calls are present in argv form.
    assert.ok(
      body.includes("gitArgs(repoPath, ['diff', '--name-only', '--diff-filter=U'])"),
      'the diff --name-only --diff-filter=U recovery call must use gitArgs argv form',
    );
    assert.ok(
      body.includes("gitArgs(repoPath, ['merge', '--abort'])"),
      'the merge --abort recovery call must use gitArgs argv form',
    );
  });
});

// ═══════════════════════════════════════════
// Behavioral proof — conflict recovery still works post-swap
// ═══════════════════════════════════════════

describe('B003 — mergeWorktree conflict recovery is behavior-preserving', () => {
  let repo;

  beforeEach(() => { repo = initRepo(); });
  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('a genuine merge conflict is detected, aborted, and reported (merged:false + conflict file)', () => {
    // Create a worktree branch off HEAD, edit file.txt in the worktree, and
    // edit the SAME line on main so the merge conflicts.
    const { worktreePath, branch } = createWorktree(repo, {
      runId: 'swarm-stagecB003',
      waveNumber: 1,
      domainName: 'backend',
    });

    // Divergent edit on the worktree branch.
    writeFileSync(join(worktreePath, 'file.txt'), 'worktree version\n', 'utf-8');
    git(worktreePath, ['add', 'file.txt']);
    git(worktreePath, ['commit', '-q', '-m', 'worktree edit']);

    // Conflicting edit on main (same line).
    writeFileSync(join(repo, 'file.txt'), 'main version\n', 'utf-8');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-q', '-m', 'main edit']);

    const result = mergeWorktree(repo, branch);

    assert.equal(result.merged, false, 'conflicting merge must report merged:false');
    assert.ok(Array.isArray(result.conflicts), 'conflicts must be an array');
    assert.ok(
      result.conflicts.includes('file.txt'),
      `the conflicting file must be surfaced; got ${JSON.stringify(result.conflicts)}`,
    );

    // The merge must have been ABORTED — the working tree is clean (no
    // lingering unmerged paths / MERGE_HEAD). `git status --porcelain` is
    // empty when the abort succeeded.
    const porcelain = git(repo, ['status', '--porcelain']);
    assert.equal(porcelain.trim(), '', 'merge --abort must have cleaned the unmerged state');
    // main still holds its own version (abort rolled the merge back).
    // Normalize line endings — git checks out CRLF on Windows fixtures.
    assert.equal(readFileSync(join(repo, 'file.txt'), 'utf-8').replace(/\r\n/g, '\n'), 'main version\n');
  });

  it('a clean (non-conflicting) merge still returns merged:true', () => {
    // Worktree edits a DIFFERENT file so the merge applies cleanly.
    const { worktreePath, branch } = createWorktree(repo, {
      runId: 'swarm-stagecB003',
      waveNumber: 2,
      domainName: 'docs',
    });

    writeFileSync(join(worktreePath, 'added.txt'), 'new content\n', 'utf-8');
    git(worktreePath, ['add', 'added.txt']);
    git(worktreePath, ['commit', '-q', '-m', 'worktree adds a file']);

    const result = mergeWorktree(repo, branch);

    assert.equal(result.merged, true, 'a non-conflicting merge must report merged:true');
    assert.deepEqual(result.conflicts, [], 'no conflicts on a clean merge');
    // The merged file is present on main (line-ending tolerant for Windows).
    assert.equal(readFileSync(join(repo, 'added.txt'), 'utf-8').replace(/\r\n/g, '\n'), 'new content\n');
  });
});
