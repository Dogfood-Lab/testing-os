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

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logStage } from './log-stage.js';

/**
 * Validate that a domain name is safe to interpolate into both a filesystem
 * path AND a git branch name.
 *
 * Why this is centralized: createWorktree() and mergeWorktree() previously
 * interpolated opts.domainName directly into shell-quoted git command
 * strings (`git worktree add -b "<branch>" ...`). A domain name containing
 * shell metacharacters (`"; rm -rf / ; "`), backticks, or path-traversal
 * segments (`../../tmp/x`) would break the surrounding quotes and execute
 * arbitrary shell, or escape the .swarm/worktrees/ jail. The argv-array
 * execFileSync calls below close the shell-injection half; this predicate
 * is the defense-in-depth half so even non-shell sinks see a sanitized name.
 *
 * Domains today are auto-detected from a fixed bucket list (tests, docs,
 * frontend, backend, ci-tooling, shared) or manually added via
 * `swarm domains <run> --add <name>` from operator input — the operator
 * path is the only untrusted vector.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeDomainName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 64) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

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
  if (!isSafeDomainName(opts.domainName)) {
    throw new Error(
      `Unsafe domain name: ${JSON.stringify(opts.domainName)} — must match /^[a-zA-Z0-9_-]+$/ and be ≤64 chars`
    );
  }
  if (!Number.isInteger(opts.waveNumber) || opts.waveNumber < 0) {
    throw new Error(`Unsafe wave number: ${JSON.stringify(opts.waveNumber)}`);
  }
  const runShort = opts.runId.replace(/^swarm-/, '').slice(0, 12);
  const branch = `swarm/${runShort}/w${opts.waveNumber}-${opts.domainName}`;
  const wtDir = join(repoPath, '.swarm', 'worktrees', `w${opts.waveNumber}-${opts.domainName}`);

  // Ensure .swarm/worktrees exists
  const parentDir = join(repoPath, '.swarm', 'worktrees');
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

  // Ensure .swarm is in .gitignore
  ensureGitignore(repoPath);

  // Remove stale worktree if it exists. Argv-array form bypasses the shell
  // so wtDir cannot trigger metacharacter interpretation.
  //
  // sm-p-003: this runs ONLY when wtDir is present and the `--force` remove
  // FAILED, yet the `worktree add` below will then fail too. Bare-swallowing
  // the precursor failure left the operator with only the downstream `add`
  // error and no breadcrumb that cleanup failed first. Log to the NDJSON
  // stream (no control-flow change — still best-effort) so the precursor is
  // greppable when the subsequent add blows up. Same forensic channel D3B-012
  // gave applyTimeoutPolicy's NULL started_at skip.
  if (existsSync(wtDir)) {
    try {
      gitArgs(repoPath, ['worktree', 'remove', wtDir, '--force']);
    } catch (e) {
      logStage('worktree_stale_remove_failed', {
        component: 'dogfood-swarm',
        wtDir,
        branch,
        err: e.message,
      });
    }
  }

  // Delete stale branch if it exists.
  try { gitArgs(repoPath, ['branch', '-D', branch]); } catch { /* branch doesn't exist */ }

  // Create worktree with new branch from HEAD.
  gitArgs(repoPath, ['worktree', 'add', '-b', branch, wtDir]);

  return { worktreePath: wtDir, branch };
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
    // Argv-array form so a malicious branch name cannot break out of the
    // -m argument and inject shell commands.
    gitArgs(repoPath, ['merge', branch, '--no-ff', '-m', `swarm: merge ${branch}`]);
    return { merged: true, conflicts: [] };
  } catch (e) {
    // Check for merge conflicts. d4-swarm-core-B003: route both recovery calls
    // through the argv-array gitArgs() helper so EVERY git invocation in this
    // module stays on the shell-free path. These two calls use fixed argument
    // strings today (no live injection vector), but the shell-form git() helper
    // was an inconsistency with the module's stated argv-array discipline — a
    // future edit that interpolates a branch-derived argument into one of them
    // would otherwise silently reintroduce a shell-injection sink. No behavior
    // change; pure defense-in-depth parity.
    const status = gitArgs(repoPath, ['diff', '--name-only', '--diff-filter=U']).trim();
    const conflicts = status.split('\n').filter(Boolean);
    if (conflicts.length > 0) {
      // Abort the merge — coordinator must resolve
      gitArgs(repoPath, ['merge', '--abort']);
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
    gitArgs(repoPath, ['worktree', 'remove', worktreePath, '--force']);
  } catch { /* already removed */ }

  if (branch) {
    try { gitArgs(repoPath, ['branch', '-D', branch]); } catch { /* already deleted */ }
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
  // Prune stale worktree references. sm-p-003: best-effort, but a swallowed
  // prune failure left no breadcrumb at all; log it so a stuck prune is
  // greppable. Control flow is unchanged — cleanup is advisory.
  try {
    git(repoPath, 'worktree prune');
  } catch (e) {
    logStage('worktree_prune_failed', {
      component: 'dogfood-swarm',
      repoPath,
      err: e.message,
    });
  }
  return worktrees.length;
}

// ── Internal ──

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Argv-array variant of git(): bypasses the shell entirely so caller-supplied
 * arguments cannot trigger metacharacter interpretation. Use this for any
 * git invocation that interpolates external/unvalidated input (branch names,
 * worktree paths, domain-derived strings).
 */
function gitArgs(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
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
