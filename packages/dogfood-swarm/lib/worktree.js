/**
 * worktree.js — Per-agent git worktree isolation.
 *
 * Each agent gets its own worktree during dispatch.
 * This gives clean attribution, prevents shared-workspace drift,
 * and makes retry/discard mechanical.
 *
 * Worktrees live at: <repo>/.swarm/worktrees/<wave>-<domain>/
 * Branch names: swarm/<run-short>/<wave>-<domain>
 *
 * Lifecycle:
 *   dispatch → create worktree per agent
 *   agent works in its worktree
 *   collect  → read diff from worktree, validate ownership, merge to main
 *   cleanup  → remove worktree after successful merge or on discard
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create a worktree for an agent.
 *
 * @param {string} repoPath — main repo path
 * @param {object} opts
 * @param {string} opts.runId
 * @param {number} opts.waveNumber
 * @param {string} opts.domainName
 * @returns {{ worktreePath: string, branch: string }}
 */
export function createWorktree(repoPath, opts) {
  const runShort = opts.runId.replace(/^swarm-/, '').slice(0, 12);
  const branch = `swarm/${runShort}/w${opts.waveNumber}-${opts.domainName}`;
  const wtDir = join(repoPath, '.swarm', 'worktrees', `w${opts.waveNumber}-${opts.domainName}`);

  // Ensure .swarm/worktrees exists
  const parentDir = join(repoPath, '.swarm', 'worktrees');
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

  // Ensure .swarm is in .gitignore
  ensureGitignore(repoPath);

  // Remove stale worktree if it exists
  if (existsSync(wtDir)) {
    try { git(repoPath, `worktree remove "${wtDir}" --force`); } catch { /* */ }
  }

  // Delete stale branch if it exists
  try { git(repoPath, `branch -D "${branch}"`); } catch { /* branch doesn't exist */ }

  // Create worktree with new branch from HEAD
  git(repoPath, `worktree add -b "${branch}" "${wtDir}"`);

  return { worktreePath: wtDir, branch };
}

/**
 * Get the diff (changed files) from a worktree relative to its branch point.
 *
 * @param {string} repoPath — main repo path
 * @param {string} worktreePath
 * @returns {string[]} — list of changed file paths (relative to repo root)
 */
export function getWorktreeDiff(repoPath, worktreePath) {
  try {
    const output = git(worktreePath, 'diff --name-only HEAD~1..HEAD');
    return output.trim().split('\n').filter(Boolean);
  } catch {
    // No commits yet — check for uncommitted changes
    const output = git(worktreePath, 'diff --name-only HEAD');
    return output.trim().split('\n').filter(Boolean);
  }
}

/**
 * Get all uncommitted changes in a worktree.
 */
export function getWorktreeChanges(worktreePath) {
  const staged = git(worktreePath, 'diff --name-only --cached').trim().split('\n').filter(Boolean);
  const unstaged = git(worktreePath, 'diff --name-only').trim().split('\n').filter(Boolean);
  const untracked = git(worktreePath, 'ls-files --others --exclude-standard').trim().split('\n').filter(Boolean);
  return { staged, unstaged, untracked, all: [...new Set([...staged, ...unstaged, ...untracked])] };
}

/**
 * Merge a worktree branch back into the main branch.
 *
 * @param {string} repoPath — main repo path
 * @param {string} branch — worktree branch name
 * @returns {{ merged: boolean, conflicts: string[] }}
 */
export function mergeWorktree(repoPath, branch) {
  try {
    git(repoPath, `merge "${branch}" --no-ff -m "swarm: merge ${branch}"`);
    return { merged: true, conflicts: [] };
  } catch (e) {
    // Check for merge conflicts
    const status = git(repoPath, 'diff --name-only --diff-filter=U').trim();
    const conflicts = status.split('\n').filter(Boolean);
    if (conflicts.length > 0) {
      // Abort the merge — coordinator must resolve
      git(repoPath, 'merge --abort');
      return { merged: false, conflicts };
    }
    throw e;
  }
}

/**
 * Remove a worktree and optionally delete its branch.
 *
 * @param {string} repoPath
 * @param {string} worktreePath
 * @param {string} [branch] — if provided, also delete the branch
 */
export function removeWorktree(repoPath, worktreePath, branch) {
  try {
    git(repoPath, `worktree remove "${worktreePath}" --force`);
  } catch { /* already removed */ }

  if (branch) {
    try { git(repoPath, `branch -D "${branch}"`); } catch { /* already deleted */ }
  }
}

/**
 * List all swarm worktrees for a repo.
 */
export function listWorktrees(repoPath) {
  try {
    const output = git(repoPath, 'worktree list --porcelain');
    const worktrees = [];
    let current = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7);
      } else if (line === 'bare' || line === 'detached') {
        current[line] = true;
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees.filter(w => w.branch?.includes('swarm/'));
  } catch {
    return [];
  }
}

/**
 * Clean up all swarm worktrees for a repo.
 */
export function cleanupAllWorktrees(repoPath) {
  const worktrees = listWorktrees(repoPath);
  for (const wt of worktrees) {
    removeWorktree(repoPath, wt.path, wt.branch);
  }
  // Prune stale worktree references
  try { git(repoPath, 'worktree prune'); } catch { /* */ }
  return worktrees.length;
}

// ── Internal ──

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Ensure .swarm/ is in the repo's .gitignore. Pure-Node fs only — no shell.
 *
 * Originally used `execSync('cat ...')` + `execSync('echo ... >>')`, which
 * inherits the platform shell. On Windows cmd.exe `cat` does not exist, the
 * call throws "cat is not recognized", the catch in createWorktree swallows
 * the error, and the agent runs without isolation. `echo` on cmd also writes
 * a literal trailing space + CRLF that corrupts the file. Wave-1 fixed this
 * upstream; the testing-os monorepo migration regressed it. This is the
 * defense-in-depth fix carrying that wave-1 pattern into every copy.
 */
export function ensureGitignore(repoPath) {
  const gitignorePath = join(repoPath, '.gitignore');
  if (!existsSync(gitignorePath)) return;

  const content = readFileSync(gitignorePath, 'utf-8');
  if (content.includes('.swarm/')) return;

  // Preserve any existing trailing newline; only inject one if the file
  // doesn't already end with `\n`. Always append a final `\n` so subsequent
  // appenders behave the same way.
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  appendFileSync(gitignorePath, `${prefix}.swarm/\n`, 'utf-8');
}
