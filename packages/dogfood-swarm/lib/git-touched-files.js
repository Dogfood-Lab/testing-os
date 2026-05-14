/**
 * git-touched-files.js — Independent file-touched-set probe.
 *
 * VD-NEW-1 (Phase 2-B verification-discipline): the canonical
 * `agent-output.schema.json` makes `files_changed` agent-self-reported.
 * `commands/collect.js` historically trusted that list to drive
 * `checkOwnership` and `file_claims`. That is a verifier-in-the-thing-being-
 * verified pattern (Class #14): an agent that under-reports `files_changed`
 * bypasses ownership enforcement.
 *
 * Restructure (not warning): ownership runs against the **independently
 * computed** touched-file set from git. The agent's `files_changed` becomes
 * a documentation/audit field, useful as a sanity-check but NOT load-bearing
 * for ownership enforcement. If the two sets diverge, that's a finding worth
 * surfacing (non-blocking) — but the gate is grounded in repo truth.
 *
 * Returns paths normalized to forward slashes (matches the rest of the
 * codebase; minimatch in domains.js does not normalize).
 */

import { execFileSync } from 'node:child_process';

/**
 * Compute the actual touched-files set in a worktree relative to HEAD,
 * including untracked files (a new `.github/CODEOWNERS` or similar would be
 * invisible to `git diff --name-only HEAD` but visible to `git status
 * --porcelain`).
 *
 * @param {string} repoPath — absolute path to the worktree
 * @returns {{ modified: string[], added: string[], deleted: string[], untracked: string[], all: string[] }}
 *   `all` is the union of every category in deduplicated order. Caller passes
 *   `all` to checkOwnership; the per-category breakdown is for the divergence
 *   finding.
 */
export function getActualTouchedFiles(repoPath) {
  const modified = [];
  const added = [];
  const deleted = [];
  const untracked = [];

  // `git diff --name-only HEAD` covers staged + unstaged tracked changes
  // (modified + added + deleted). `git status --porcelain` distinguishes
  // adds from modifications and catches untracked files — needed so that a
  // new file like `.github/CODEOWNERS` lands in the touched set even before
  // any `git add`. We use porcelain for the categorization and diff as a
  // belt-and-suspenders cross-check on tracked changes.
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
  } catch {
    // Not a git repo, or git unavailable. Return empty — caller treats the
    // empty set as "no independent verification available" and falls back to
    // the agent's self-report (degraded mode, surfaced in the report).
    return { modified: [], added: [], deleted: [], untracked: [], all: [], unavailable: true };
  }

  // Porcelain format: `XY path` (X = index status, Y = worktree status).
  // Renames are `R  old -> new`; we want the destination.
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    let path;
    if (xy[0] === 'R' || xy[1] === 'R') {
      const arrow = rest.indexOf(' -> ');
      path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    } else {
      path = rest;
    }
    path = path.replace(/\\/g, '/');
    if (xy === '??') untracked.push(path);
    else if (xy[0] === 'D' || xy[1] === 'D') deleted.push(path);
    else if (xy[0] === 'A' || xy[1] === 'A') added.push(path);
    else modified.push(path);
  }

  const seen = new Set();
  const all = [];
  for (const p of [...modified, ...added, ...deleted, ...untracked]) {
    if (!seen.has(p)) { seen.add(p); all.push(p); }
  }

  return { modified, added, deleted, untracked, all };
}

/**
 * Compute the divergence between the agent's self-reported `files_changed`
 * and the independently-computed touched set.
 *
 * @param {string[]} reported — agent's `files_changed`
 * @param {string[]} actual — `getActualTouchedFiles(repo).all`
 * @returns {{ missing_from_report: string[], extra_in_report: string[], match: boolean }}
 *   `missing_from_report` = files touched but not reported (the dangerous
 *   case — could have bypassed ownership before this restructure).
 *   `extra_in_report` = files reported but not actually touched (usually
 *   benign — over-reporting; also catches stale entries from a copy-paste
 *   draft).
 */
export function diffReportedVsActual(reported, actual) {
  const reportedSet = new Set((reported || []).map(p => p.replace(/\\/g, '/')));
  const actualSet = new Set((actual || []).map(p => p.replace(/\\/g, '/')));

  const missing_from_report = [];
  for (const p of actualSet) if (!reportedSet.has(p)) missing_from_report.push(p);

  const extra_in_report = [];
  for (const p of reportedSet) if (!actualSet.has(p)) extra_in_report.push(p);

  return {
    missing_from_report,
    extra_in_report,
    match: missing_from_report.length === 0 && extra_in_report.length === 0,
  };
}
