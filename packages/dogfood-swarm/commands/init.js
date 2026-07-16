/**
 * init.js — `swarm init <repo-path>`
 *
 * Creates a run, auto-detects domains, saves draft, reports to coordinator.
 * Does NOT freeze domains — coordinator reviews first.
 *
 * Steps:
 * 1. Validate repo path (git repo, clean working tree)
 * 2. Read HEAD commit + branch
 * 3. Create save point tag
 * 4. Auto-detect domains from repo structure
 * 5. Create run + domain draft in control plane DB
 * 6. Print domain proposal for coordinator review
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { detectDomains, saveDomainDraft } from '../lib/domains.js';

/**
 * @param {object} opts
 * @param {string} opts.repoPath — path to local repo
 * @param {string} [opts.repo] — org/repo name (auto-detected if omitted)
 * @param {string} opts.dbPath — path to control-plane.db
 * @returns {object} — { runId, domains, unmatched, savePointTag }
 */
export function init(opts) {
  const repoPath = resolve(opts.repoPath);

  // 1. Validate git repo
  if (!existsSync(resolve(repoPath, '.git'))) {
    throw new Error(`Not a git repo: ${repoPath}`);
  }

  // Check clean working tree
  const status = git(repoPath, ['status', '--porcelain']);
  if (status.trim()) {
    throw new Error(`Working tree is not clean. Commit or stash changes first.\n${status}`);
  }

  // 2. Read HEAD commit + branch
  const commitSha = git(repoPath, ['rev-parse', 'HEAD']).trim();
  const branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  // Auto-detect org/repo from remote
  let repo = opts.repo;
  if (!repo) {
    try {
      const remoteUrl = git(repoPath, ['remote', 'get-url', 'origin']).trim();
      const match = remoteUrl.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
      repo = match ? match[1] : basename(repoPath);
    } catch {
      repo = basename(repoPath);
    }
  }

  // 3. Create save point tag
  const timestamp = Math.floor(Date.now() / 1000);
  const savePointTag = `swarm-save-${timestamp}`;
  git(repoPath, ['tag', savePointTag]);

  // 4. Auto-detect domains
  const { domains, unmatched } = detectDomains(repoPath);

  // 5. Create run in DB
  const hex = randomBytes(2).toString('hex');
  const runId = `swarm-${timestamp}-${hex}`;

  const db = openDb(opts.dbPath);
  db.prepare(`
    INSERT INTO runs (id, repo, local_path, commit_sha, branch, save_point_tag, status)
    VALUES (?, ?, ?, ?, ?, ?, 'initializing')
  `).run(runId, repo, repoPath, commitSha, branch, savePointTag);

  // Save domain draft (unfrozen)
  saveDomainDraft(db, runId, domains.map(d => ({
    name: d.name,
    globs: d.globs,
    ownership_class: d.ownership_class,
  })));

  return {
    runId,
    repo,
    repoPath,
    commitSha,
    branch,
    savePointTag,
    domains: domains.map(d => ({
      name: d.name,
      ownership_class: d.ownership_class,
      matched_files: d.matched_files.length,
      globs: d.globs,
    })),
    unmatched,
  };
}

// F-264bd9d2 (wave 20): argv-array form (execFileSync), never a shell-string
// exec. Every call site below passes only a hardcoded literal argv or a pure
// internal timestamp (`tag`, savePointTag — `swarm-save-${Date.now()}`, never
// operator or target-repo input), so this closes the THIRD documented
// instance of this class in this package (F-21240958 commands/persist.js,
// its sibling F-1f7f9de8 persist-results.js) — matching every other git/node
// invocation in the command layer (dispatch.js's execFileSync('git', [...]),
// lib/worktree.js).
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}
