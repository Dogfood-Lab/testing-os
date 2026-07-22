/**
 * worktree.js — Per-agent git worktree isolation.
 *
 * Each agent gets its own worktree during dispatch.
 * This gives clean attribution, prevents shared-workspace drift,
 * and makes retry/discard mechanical.
 *
 * Worktrees live at: <repo>/.swarm/worktrees/w<wave>-<domain>-<run-short>/
 * Branch names: swarm/<run-short>/w<wave>-<domain>
 *
 * The run-short slug is part of the DIRECTORY name, not just the branch
 * (F-527dc73e): two concurrent runs against the same repo whose wave numbers
 * and domain names coincide would otherwise collide on the path, and the
 * stale-cleanup in createWorktree (`git worktree remove --force`) would
 * destroy the other run's live worktree including uncommitted agent edits.
 *
 * Lifecycle:
 *   dispatch → create worktree per agent. npm-workspaces repos additionally
 *              get their workspace self-links provisioned INSIDE the worktree
 *              and realpath-containment gated (lib/workspace-links.js;
 *              observed in run swarm-1784601601-bd4a).
 *   agent works in its worktree
 *   collect  → read diff from worktree, validate ownership. Collect does NOT
 *              merge: merging an isolated branch back is an out-of-band
 *              coordinator step (mergeWorktree below has no production
 *              callers today — F-1ab3fd1f corrected the earlier "collect
 *              merges to main" claim in this header).
 *   cleanup  → the run's terminal promotion removes worktrees that are CLEAN
 *              and MERGED; dirty or unmerged worktrees are skipped with a
 *              worktree_unmerged_skipped breadcrumb, and `swarm clean --apply`
 *              is the only verb that may force-remove preserved work.
 */

import { execSync, execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, appendFileSync, rmSync,
  lstatSync, readdirSync, chmodSync,
} from 'node:fs';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { join, relative, isAbsolute } from 'node:path';
import { logStage } from './log-stage.js';
import { provisionWorkspaceLinks, checkWorkspaceRealpathContainment } from './workspace-links.js';

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
 * Derive the run-short slug used in both the worktree branch namespace
 * (`swarm/<runShort>/...`) and the worktree directory name. Single source of
 * truth — commands/clean.js and commands/dispatch.js#previewWorktree must
 * derive the same slug byte-for-byte.
 *
 * F-7e2dbf43: the slug keeps the TAIL of the id, not the head. init.js run
 * ids are `swarm-<10-digit-epoch-seconds>-<4 hex>`; the old `slice(0, 12)`
 * kept the full epoch but only ONE of the four random hex chars, so two runs
 * initialized in the same second collided on the slug with probability 1/16
 * — collapsing the F-527dc73e collision defense (shared worktree dir names +
 * branch prefixes let one run's cleanup destroy the sibling's live
 * worktrees). `slice(-12)` keeps the epoch tail + the full random suffix.
 * Worktrees created by runs under the OLD slug are orphaned by this change
 * (their branch prefix no longer matches); `git worktree prune` + manual
 * removal reclaims them — new runs only going forward.
 *
 * @param {string} runId
 * @returns {string}
 */
export function runShortOf(runId) {
  return runId.replace(/^swarm-/, '').slice(-12);
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
  const runShort = runShortOf(opts.runId);
  const branch = `swarm/${runShort}/w${opts.waveNumber}-${opts.domainName}`;
  // F-527dc73e: the run-short slug is folded into the DIRECTORY name so two
  // runs against the same repo can never collide on the path (the stale-remove
  // below would otherwise destroy the other run's live worktree).
  const wtDir = join(repoPath, '.swarm', 'worktrees', `w${opts.waveNumber}-${opts.domainName}-${runShort}`);

  // Ensure .swarm/worktrees exists
  const parentDir = join(repoPath, '.swarm', 'worktrees');
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

  // Ensure .swarm is in .gitignore
  ensureGitignore(repoPath);

  // Remove stale worktree if it exists. Argv-array form bypasses the shell
  // so wtDir cannot trigger metacharacter interpretation.
  //
  // sm-p-003: this runs ONLY when wtDir is present and the `--force` remove
  // FAILED, yet the `worktree add` below will then fail too. Log to the NDJSON
  // stream (best-effort) so the precursor is greppable when the subsequent add
  // blows up. Same forensic channel D3B-012 gave applyTimeoutPolicy's NULL
  // started_at skip.
  //
  // Windows --isolate strand (ai-rpg-engine v2.8): a stale npm-workspaces
  // worktree survives `git worktree remove --force` — its provisioned
  // node_modules junctions block git's removal (see forceRemoveDir) — so the
  // `worktree add` below would fail on the still-occupied path, breaking resume
  // / re-dispatch onto the same wtDir (proven: git worktree remove reports "not
  // a working tree" for the orphan, then add errors "already exists"). Reclaim
  // the survivor at the fs level, same as removeWorktree's teardown path, so
  // the add always lands on a clean path. wtDir is built under .swarm/worktrees/
  // above, so the jail guard holds by construction — kept for uniformity.
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
    if (existsSync(wtDir) && isUnderSwarmWorktrees(repoPath, wtDir)) {
      try {
        forceRemoveDir(wtDir);
        logStage('worktree_stale_fs_reclaimed', {
          component: 'dogfood-swarm',
          wtDir,
          branch,
          note: 'stale worktree survived `git worktree remove --force` (Windows --isolate junction strand); reclaimed at the fs level before re-create',
        });
      } catch (e) {
        // The `git worktree add` below will surface the still-occupied path as
        // the loud failure; this names the fs-level cause first.
        logStage('worktree_stale_reclaim_failed', {
          component: 'dogfood-swarm',
          wtDir,
          branch,
          err: e.message,
        });
      }
      try { gitArgs(repoPath, ['worktree', 'prune']); } catch { /* advisory */ }
    }
  }

  // Delete stale branch if it exists.
  try { gitArgs(repoPath, ['branch', '-D', branch]); } catch { /* branch doesn't exist */ }

  // Create worktree with new branch from HEAD.
  gitArgs(repoPath, ['worktree', 'add', '-b', branch, wtDir]);

  // Observed in run swarm-1784601601-bd4a (ai-rpg-engine): `git worktree add`
  // materializes tracked files only, and because the worktree nests INSIDE
  // the audited repo, an npm-workspaces repo's bare @scope/* imports walked
  // up out of the worktree and silently resolved against the MAIN checkout's
  // node_modules — the agent tested main's code, not its own edits. Recreate
  // the workspace self-links here (junctions on Windows, symlinks on POSIX;
  // no npm subprocess, so package-lock.json cannot be rewritten), then gate
  // on the realpath-containment preflight. A containment failure throws:
  // same fail-loud isolation contract as F-693631-001 — dispatch/resume wrap
  // this into IsolationError. No-op for non-npm-workspaces repos.
  const provisioned = provisionWorkspaceLinks(wtDir);
  if (provisioned.isWorkspacesRepo) {
    logStage('worktree_workspace_links_provisioned', {
      component: 'dogfood-swarm',
      worktreePath: wtDir,
      linked: provisioned.linked.length,
      unsupportedPatterns: provisioned.unsupportedPatterns,
      skipped: provisioned.skipped,
    });
    const containment = checkWorkspaceRealpathContainment(wtDir);
    if (containment.status === 'fail') {
      logStage('worktree_workspace_containment_failed', {
        component: 'dogfood-swarm',
        worktreePath: wtDir,
        violations: containment.violations,
      });
      throw new Error(`${containment.id} failed for ${wtDir}: ${containment.message}`);
    }
  }

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
 * True when worktreePath sits at or under <repoPath>/.swarm/worktrees/ — the
 * only tree the fs-level force-remove (forceRemoveDir, below) is ever allowed
 * to bulldoze. createWorktree always builds worktrees there, and both call
 * sites that reach removeWorktree pass swarm worktree paths — from
 * listWorktrees (git-porcelain form, forward slashes on Windows) or from the
 * runs/agent_runs worktree_path column (join form, backslashes). path.relative
 * on win32 normalizes separators and case, so the guard holds for both shapes
 * (proven across separator/case variants before shipping). A survivor OUTSIDE
 * this jail is left stranded rather than force-removed — defense in depth so a
 * mis-derived path can never turn removeWorktree into an arbitrary `rm -rf`.
 */
function isUnderSwarmWorktrees(repoPath, worktreePath) {
  const base = join(repoPath, '.swarm', 'worktrees');
  const rel = relative(base, worktreePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Clear the read-only attribute across a tree so a subsequent rm cannot EPERM
 * on a read-only entry. Uses lstat and NEVER follows a symlink/junction into
 * its target — chmod-ing through a workspace junction would touch content
 * outside the worktree (the isolation invariant workspace-links.js enforces).
 * Best-effort per entry: a chmod that itself fails must not abort the walk.
 */
function clearReadonlyRecursive(target) {
  let st;
  try { st = lstatSync(target); } catch { return; }
  if (st.isSymbolicLink()) return; // a junction/symlink is a leaf — unlinked by rm, never recursed
  try { chmodSync(target, st.isDirectory() ? 0o777 : 0o666); } catch { /* best-effort */ }
  if (st.isDirectory()) {
    let entries;
    try { entries = readdirSync(target); } catch { return; }
    for (const entry of entries) clearReadonlyRecursive(join(target, entry));
  }
}

/**
 * Force-remove a directory that `git worktree remove --force` could not delete.
 *
 * Windows --isolate strand (reproduced live, ai-rpg-engine v2.8, run
 * swarm-1784601601-bd4a shape): `git worktree remove --force` on an
 * npm-workspaces worktree deletes its git-tracked content AND drops the
 * worktree admin ref, but LEAVES the untracked node_modules/ subtree holding
 * the workspace directory JUNCTIONS provisionWorkspaceLinks created. Those
 * reparse points (plus any read-only node_modules content) strand the whole
 * worktree path on disk while `git worktree list` already reports clean — so a
 * second `swarm clean` cannot even see the orphan. This is the fs-level `rm -rf`
 * the incident needed, made routine.
 *
 * rmSync({recursive,force}) is the fast path: on a modern Node it clears the
 * read-only attribute itself AND unlinks a junction as a LEAF — it does NOT
 * recurse through a reparse point into its target (verified on this rig: a
 * junction's external target survives). The read-only pre-clear + retry is the
 * portability fallback for a Node build whose internal EPERM handler does not
 * chmod: only reached if the first rm throws, and it re-raises the ORIGINAL
 * error if the retry still fails so the caller sees the true cause.
 *
 * @param {string} dir
 * @throws re-raises the removal error when the path cannot be reclaimed.
 */
export function forceRemoveDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (firstErr) {
    try {
      clearReadonlyRecursive(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      throw firstErr;
    }
  }
}

/**
 * Remove a worktree and optionally delete its branch.
 *
 * PH-DS-01: completion-path parity with rewind.js's --apply teardown — a
 * survivor must never be silently reported as a clean removal.
 *
 * Windows robustness (ai-rpg-engine v2.8 dogfood cycle): `git worktree remove
 * --force` on an npm-workspaces --isolate worktree STRANDS the directory (the
 * provisioned node_modules junctions survive git's removal; see forceRemoveDir).
 * When the path is still present after the git remove — and only while it is
 * inside the `.swarm/worktrees/` jail — we reclaim it at the fs level, then
 * `git worktree prune`. The prune is idempotent AND load-bearing for the branch
 * delete below: a branch still "checked out" in a registered-but-gone worktree
 * refuses `git branch -D`, so prune first, then delete. A successful reclaim
 * emits `worktree_fs_reclaimed` (so the operator has a durable record the
 * Windows path fired); only a path that survives even the fs reclaim is
 * reported stranded via `worktree_cleanup_failed` (a genuinely locked resource
 * / permission wall). Mirrors rewind.js's recheck (distinct stage names so the
 * paths stay greppable apart).
 *
 * @param {string} repoPath
 * @param {string} worktreePath
 * @param {string} [branch] — if provided, also delete the branch
 * @returns {{ removed: boolean, stranded: boolean }}
 */
export function removeWorktree(repoPath, worktreePath, branch) {
  try {
    gitArgs(repoPath, ['worktree', 'remove', worktreePath, '--force']);
  } catch { /* fall through to the fs-level reclaim below */ }

  // git left the path on disk (the Windows junction strand, or a plain orphan
  // git no longer tracks). Reclaim it — but only inside the swarm-worktrees
  // jail, so a mis-derived path can never become an arbitrary force-remove.
  let fsReclaimAttempted = false;
  if (existsSync(worktreePath) && isUnderSwarmWorktrees(repoPath, worktreePath)) {
    fsReclaimAttempted = true;
    try {
      forceRemoveDir(worktreePath);
    } catch { /* the final existsSync check below records the stranded outcome */ }
    // Prune git's now-dangling worktree bookkeeping AND unblock the branch
    // delete below (a still-"checked out" branch refuses -D).
    try { gitArgs(repoPath, ['worktree', 'prune']); } catch { /* advisory */ }
  }

  if (branch) {
    try { gitArgs(repoPath, ['branch', '-D', branch]); } catch { /* already deleted / not present */ }
  }

  if (existsSync(worktreePath)) {
    logStage('worktree_cleanup_failed', {
      component: 'dogfood-swarm',
      repoPath,
      worktreePath,
      branch: branch || null,
      reason: fsReclaimAttempted
        ? 'worktree path still present after `git worktree remove --force` and fs-level reclaim'
        : 'worktree path still present after `git worktree remove --force` (outside .swarm/worktrees jail — left for manual handling)',
    });
    return { removed: false, stranded: true };
  }
  if (fsReclaimAttempted) {
    logStage('worktree_fs_reclaimed', {
      component: 'dogfood-swarm',
      repoPath,
      worktreePath,
      branch: branch || null,
      note: '`git worktree remove --force` left the path on disk (Windows --isolate junction strand); reclaimed at the fs level',
    });
  }
  return { removed: true, stranded: false };
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
 *
 * PH-DS-01: returns a structured { removed, stranded, total } summary so the
 * caller and the operator can see how many worktrees survived the sweep, rather
 * than the prior bare count that conflated "swept" with "actually removed". Each
 * survivor already emitted a `worktree_cleanup_failed` breadcrumb inside
 * removeWorktree; this rolls the per-worktree outcomes into a wave-level count.
 *
 * @param {string} repoPath
 * @returns {{ removed: number, stranded: number, total: number }}
 */
export function cleanupAllWorktrees(repoPath) {
  const worktrees = listWorktrees(repoPath);
  let removed = 0;
  let stranded = 0;
  for (const wt of worktrees) {
    const outcome = removeWorktree(repoPath, wt.path, wt.branch);
    if (outcome.stranded) stranded++;
    else removed++;
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
  return { removed, stranded, total: worktrees.length };
}

/**
 * Inspect a worktree for at-risk agent work before any destructive removal.
 *
 * F-1ab3fd1f: `git worktree remove --force` discards uncommitted edits and
 * `git branch -D` force-deletes unmerged branches — and nothing in the
 * production pipeline ever merges isolated agent branches (mergeWorktree has
 * no production callers; merging is an out-of-band coordinator step). Two
 * signals mark preserved-work states:
 *
 *   - dirty:    the worktree has uncommitted/untracked edits (`git status
 *               --porcelain` non-empty). The highest-value at-risk state —
 *               agents typically never commit.
 *   - unmerged: the worktree branch has commits that are NOT an ancestor of
 *               the run's main branch (`git merge-base --is-ancestor` fails).
 *
 * Failure posture is conservative: if the merge-base probe itself errors
 * (unknown branch, detached state), the branch is reported unmerged so the
 * caller preserves rather than destroys.
 *
 * @param {string} repoPath — main repo path (branch probes run here)
 * @param {string} worktreePath — the worktree to inspect (dirty probe runs here)
 * @param {string} [branch] — worktree branch name
 * @param {string} [mainBranch] — merged-check baseline (runs.branch); HEAD fallback
 * @returns {{ dirty: boolean, unmerged: boolean }}
 */
export function worktreeDisposition(repoPath, worktreePath, branch, mainBranch = 'HEAD') {
  let dirty = false;
  try {
    dirty = gitArgs(worktreePath, ['status', '--porcelain']).trim().length > 0;
  } catch { /* worktree path gone / not a repo — nothing to preserve there */ }

  let unmerged = false;
  if (branch) {
    try {
      gitArgs(repoPath, ['merge-base', '--is-ancestor', branch, mainBranch]);
    } catch {
      unmerged = true;
    }
  }
  return { dirty, unmerged };
}

/**
 * Clean up the swarm worktrees belonging to ONE run.
 *
 * F-e7369293: the run's terminal 'complete' promotion previously called
 * cleanupAllWorktrees, which sweeps EVERY swarm/* worktree and branch in the
 * repo — completing run A tore down run B's in-flight --isolate worktrees in
 * the same repo, destroying B's unmerged agent edits. This helper applies the
 * same run-short branch-prefix scoping that commands/clean.js documents
 * (branches are namespaced swarm/<runShort>/...), so only THIS run's
 * worktrees are removed. The prune step and its worktree_prune_failed
 * breadcrumb mirror cleanupAllWorktrees.
 *
 * F-1ab3fd1f: before each removal the worktree is checked for UNMERGED agent
 * work (dirty tree or unmerged branch commits — see worktreeDisposition).
 * Preserved-work worktrees are SKIPPED with a loud worktree_unmerged_skipped
 * breadcrumb naming the surviving path + branch; `swarm clean --apply`
 * (dry-run-default, operator-explicit) is the only verb that force-removes
 * them. Pre-wave-2 the accidental ABSENCE of terminal cleanup preserved this
 * work; the F-e7369293 fix removed that safety margin — this guard restores
 * it deliberately.
 *
 * @param {string} repoPath
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.mainBranch] — merged-check baseline (runs.branch)
 * @returns {{ removed: number, stranded: number, skipped: number, total: number }}
 */
export function cleanupRunWorktrees(repoPath, runId, opts = {}) {
  const branchPrefix = `swarm/${runShortOf(runId)}/`;
  const worktrees = listWorktrees(repoPath).filter(w => {
    const branch = (w.branch || '').replace(/^refs\/heads\//, '');
    return branch.includes(branchPrefix);
  });
  let removed = 0;
  let stranded = 0;
  let skipped = 0;
  for (const wt of worktrees) {
    const branch = (wt.branch || '').replace(/^refs\/heads\//, '');
    const disposition = worktreeDisposition(repoPath, wt.path, branch, opts.mainBranch || 'HEAD');
    if (disposition.dirty || disposition.unmerged) {
      skipped++;
      logStage('worktree_unmerged_skipped', {
        component: 'dogfood-swarm',
        repoPath,
        worktreePath: wt.path,
        branch,
        dirty: disposition.dirty,
        unmerged: disposition.unmerged,
        remediation:
          'merge or export the surviving branch, then dispose of it explicitly with `swarm clean <run-id> --apply`',
      });
      continue;
    }
    const outcome = removeWorktree(repoPath, wt.path, branch);
    if (outcome.stranded) stranded++;
    else removed++;
  }
  try {
    git(repoPath, 'worktree prune');
  } catch (e) {
    logStage('worktree_prune_failed', {
      component: 'dogfood-swarm',
      repoPath,
      err: e.message,
    });
  }
  return { removed, stranded, skipped, total: worktrees.length };
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
 * Ensure .swarm/ is in the repo's .gitignore, CREATING the file if the repo
 * has none. Pure-Node fs only — no shell.
 *
 * Originally used `execSync('cat ...')` + `execSync('echo ... >>')`, which
 * inherits the platform shell. On Windows cmd.exe `cat` does not exist, the
 * call throws "cat is not recognized", the catch in createWorktree swallows
 * the error, and the agent runs without isolation. `echo` on cmd also writes
 * a literal trailing space + CRLF that corrupts the file. Wave-1 fixed this
 * upstream; the testing-os monorepo migration regressed it. This is the
 * defense-in-depth fix carrying that wave-1 pattern into every copy.
 *
 * F-afe6511b: a repo with NO .gitignore used to hit `if (!existsSync(...))
 * return;` and silently do nothing, contradicting the docstring's own
 * contract ("Ensure .swarm/ is in the repo's .gitignore") and this module's
 * own name-vs-behavior discipline (the exact class of bug the wave-1 fix
 * above already exists to eliminate: "the catch in createWorktree swallows
 * the error, and the agent runs without isolation"). Worktrees are created
 * nested inside the repo at `<repo>/.swarm/worktrees/`, so the consequence
 * was untracked `.swarm/` content in the operator's own tree — which then
 * feeds getActualTouchedFiles' `git status --porcelain`, so an isolated
 * agent's own worktree scaffolding could be misread as a phantom ownership
 * violation. createWorktree is already mutating the repo far more invasively
 * (a new worktree, a new branch) than writing one line to a new file, so
 * creating the .gitignore when absent is a strictly smaller surprise than
 * leaving the swarm's own jail untracked and undocumented.
 */
export function ensureGitignore(repoPath) {
  const gitignorePath = join(repoPath, '.gitignore');

  if (!existsSync(gitignorePath)) {
    logStage('gitignore_created_for_swarm', { component: 'dogfood-swarm', repoPath, gitignorePath });
    atomicWriteFileSync(gitignorePath, '.swarm/\n', 'utf-8');
    return;
  }

  const content = readFileSync(gitignorePath, 'utf-8');
  if (content.includes('.swarm/')) return;

  // Preserve any existing trailing newline; only inject one if the file
  // doesn't already end with `\n`. Always append a final `\n` so subsequent
  // appenders behave the same way.
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  appendFileSync(gitignorePath, `${prefix}.swarm/\n`, 'utf-8');
}
