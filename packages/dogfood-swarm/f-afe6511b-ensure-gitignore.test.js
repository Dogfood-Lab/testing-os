/**
 * f-afe6511b-ensure-gitignore.test.js — F-afe6511b: ensureGitignore's own
 * docstring contract is "Ensure .swarm/ is in the repo's .gitignore," and
 * createWorktree calls it unconditionally relying on that. But a repo with
 * NO .gitignore hit `if (!existsSync(gitignorePath)) return;` and silently
 * did nothing — .swarm/ was never ignored, so worktree scaffolding created
 * INSIDE the repo (`<repo>/.swarm/worktrees/`) landed untracked in the
 * operator's own tree, which then feeds the ownership probe's
 * `git status --porcelain` and can read as a phantom violation.
 *
 * Real git repos, not mocks (CLAUDE.md rule 6) — a temp dir, git init, no
 * .gitignore written on purpose.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureGitignore, createWorktree } from './lib/worktree.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A real git repo with NO .gitignore — the exact precondition the finding names. */
function repoWithoutGitignore() {
  const repo = mkdtempSync(join(tmpdir(), 'f-afe6511b-fixture-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf-8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'root']);
  return repo;
}

function teardown(repo) {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('ensureGitignore — creates .gitignore when the repo has none (F-afe6511b)', () => {
  it('creates .gitignore containing .swarm/ when the repo has no .gitignore at all', () => {
    const repo = repoWithoutGitignore();
    try {
      assert.equal(existsSync(join(repo, '.gitignore')), false, 'precondition: no .gitignore yet');
      ensureGitignore(repo);
      assert.equal(existsSync(join(repo, '.gitignore')), true, 'ensureGitignore must create the file, not silently no-op');
      const content = readFileSync(join(repo, '.gitignore'), 'utf-8');
      assert.match(content, /\.swarm\//);
    } finally {
      teardown(repo);
    }
  });

  it('createWorktree end-to-end: a repo with no .gitignore ends up with .swarm/ ignored', () => {
    const repo = repoWithoutGitignore();
    try {
      createWorktree(repo, { runId: 'swarm-afe6511btest', waveNumber: 1, domainName: 'backend' });
      const gitignorePath = join(repo, '.gitignore');
      assert.equal(existsSync(gitignorePath), true);
      assert.match(readFileSync(gitignorePath, 'utf-8'), /\.swarm\//);

      // The real proof: `.swarm` must not show up as untracked content that
      // an ownership probe's `git status --porcelain` would see.
      const status = git(repo, ['status', '--porcelain']);
      assert.doesNotMatch(status, /\.swarm/, '.swarm/ scaffolding must not appear as untracked in git status');
    } finally {
      teardown(repo);
    }
  });

  it('is idempotent: calling it twice on a freshly-created .gitignore does not duplicate the entry', () => {
    const repo = repoWithoutGitignore();
    try {
      ensureGitignore(repo);
      ensureGitignore(repo);
      const content = readFileSync(join(repo, '.gitignore'), 'utf-8');
      assert.equal((content.match(/\.swarm\//g) || []).length, 1);
    } finally {
      teardown(repo);
    }
  });

  it('does not regress the pre-existing case: an existing .gitignore without .swarm/ still gets it appended', () => {
    const repo = repoWithoutGitignore();
    try {
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n', 'utf-8');
      ensureGitignore(repo);
      const content = readFileSync(join(repo, '.gitignore'), 'utf-8');
      assert.match(content, /node_modules\//, 'existing entries must be preserved');
      assert.match(content, /\.swarm\//);
    } finally {
      teardown(repo);
    }
  });

  it('does not regress the pre-existing case: an existing .gitignore that already has .swarm/ is left untouched', () => {
    const repo = repoWithoutGitignore();
    try {
      writeFileSync(join(repo, '.gitignore'), '.swarm/\nnode_modules/\n', 'utf-8');
      const before = readFileSync(join(repo, '.gitignore'), 'utf-8');
      ensureGitignore(repo);
      const after = readFileSync(join(repo, '.gitignore'), 'utf-8');
      assert.equal(after, before);
    } finally {
      teardown(repo);
    }
  });
});
