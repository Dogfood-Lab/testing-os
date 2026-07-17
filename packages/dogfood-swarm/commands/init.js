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
 *
 * Steps 4-6 are wrapped in a try/catch that deletes the step-3 save-point
 * tag before re-throwing (F-53a7d713) — see compensateOrphanedSavePointTag
 * below.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { detectDomains, saveDomainDraft } from '../lib/domains.js';
import { resolveRoadmapSeed, stampRoadmapSeedLineage } from './lib/roadmap-seed.js';

/**
 * @param {object} opts
 * @param {string} opts.repoPath — path to local repo
 * @param {string} [opts.repo] — org/repo name (auto-detected if omitted)
 * @param {string} opts.dbPath — path to control-plane.db
 * @param {string|true} [opts.seedFromRoadmap] — T4 (F-d110f547):
 *   `--seed-from-roadmap[=<run-id>|latest]`. `true` (bare flag) or the
 *   literal `'latest'` seed from whatever this checkout's
 *   dogfood/roadmap/latest.json currently names; any other string names an
 *   explicit prior run id. Absent (undefined) by default — lineage is
 *   opt-in, never inferred (T4: "seeding a new run from a prior roadmap is
 *   an explicit flag"). Resolved and schema-validated BEFORE any DB write
 *   so a bad/missing seed fails fast without leaving a half-initialized run.
 * @returns {object} — { runId, domains, unmatched, savePointTag, roadmapSeed }
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

  // 4-6. Auto-detect domains, create the run row, save the domain draft.
  //
  // F-53a7d713: the save-point tag above is the one IRREVERSIBLE side effect
  // init() performs before its own `runs` row exists to point at it. If any
  // of the three steps below throws (a locked/too-new control-plane.db, a
  // transient I/O error scanning the target repo, a malformed domain-
  // detection result), the tag would otherwise survive uncleaned — nothing
  // else in this package sweeps or prunes an orphaned `swarm-save-*` tag
  // (rewind.js only ever consumes one by operator-typed name). Named
  // compensator per the workflow-standards rule (Sagas, Garcia-Molina &
  // Salem 1987): undo the tag, THEN re-throw the original failure untouched
  // — the operator must see the real error, not a masked compensator result.
  let domains, unmatched, runId, roadmapSeed = null;
  try {
    // T4/F-d110f547: resolve + validate BEFORE any DB work — the fastest
    // possible fail-fast for a bad/missing seed, and it means a doomed init
    // never even reaches detectDomains' filesystem walk.
    if (opts.seedFromRoadmap) {
      roadmapSeed = resolveRoadmapSeed(repoPath, opts.seedFromRoadmap);
    }

    ({ domains, unmatched } = detectDomains(repoPath));

    const hex = randomBytes(2).toString('hex');
    runId = `swarm-${timestamp}-${hex}`;

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

    // T4/F-d110f547: records this NEW run's lineage durably (the `kv` table
    // — no schema migration; see commands/lib/roadmap-seed.js's header).
    // dispatch.js reads this back to decide the first-audit-wave
    // auto-injection gate.
    if (roadmapSeed) {
      stampRoadmapSeedLineage(db, runId, roadmapSeed);
    }
  } catch (err) {
    compensateOrphanedSavePointTag(repoPath, savePointTag);
    throw err;
  }

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
    roadmapSeed: roadmapSeed
      ? { sourceRunId: roadmapSeed.sourceRunId, sequence: roadmapSeed.sequence, path: roadmapSeed.relPath }
      : null,
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

/**
 * Named compensator for F-53a7d713 (workflow-standards NAMED_COMPENSATORS):
 * undoes the ONE irreversible side effect init() performs before its own
 * `runs` row exists — the save-point git tag created at step 3. Owner:
 * init() itself; invoked only from its own catch block above, never called
 * standalone.
 *
 * Best-effort by design: a compensator that itself throws must never mask
 * the real failure the caller is already unwinding from — init()'s catch
 * always re-throws the original `err` regardless of what happens here. A
 * tag this fails to delete (e.g. git itself is unavailable) is not a NEW
 * failure mode — it degrades to exactly the bounded, self-announcing,
 * LOW-severity residual F-53a7d713 already documents (an operator can
 * always `git tag -d` it manually via `git tag -l 'swarm-save-*'`).
 */
function compensateOrphanedSavePointTag(repoPath, tag) {
  try {
    git(repoPath, ['tag', '-d', tag]);
  } catch { /* best effort — see docstring above */ }
}
