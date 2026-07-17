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
 * Compute the actual touched-files set in a worktree, including untracked
 * files (a new `.github/CODEOWNERS` or similar would be invisible to
 * `git diff` but visible to `git status --porcelain`).
 *
 * F-4ba6036b: `git status --porcelain` alone only sees changes relative to
 * HEAD. An agent that runs `git add && git commit` inside its worktree makes
 * ALL of its edits invisible to the status probe — status is clean against
 * the new HEAD — and ownership enforcement silently falls back to the agent's
 * self-reported `files_changed` (the exact untrusted channel VD-NEW-1 was
 * built to stop trusting). When `options.baseRef` is supplied, the COMMITTED
 * delta (`git diff --name-only -z <baseRef>`) is unioned into the touched
 * set, so committed edits stay visible. The correct base:
 *   - isolated worktree → the worktree branch point (dispatch-time HEAD) —
 *     resolve with resolveWorktreeBaseRef(); NOT current main HEAD.
 *   - non-isolated      → runs.commit_sha (the run's init-time HEAD).
 *
 * @param {string} repoPath — absolute path to the worktree
 * @param {object} [options]
 * @param {string} [options.baseRef] — commit-ish to diff the working tree
 *   against so committed changes are included in the touched set
 * @returns {{ modified: string[], added: string[], deleted: string[], untracked: string[], all: string[] }}
 *   `all` is the union of every category in deduplicated order. Caller passes
 *   `all` to checkOwnership; the per-category breakdown is for the divergence
 *   finding. `baseDiffUnavailable: true` is set when a baseRef was supplied
 *   but the diff probe failed (bad ref, shallow clone) — status-only coverage.
 */
export function getActualTouchedFiles(repoPath, options = {}) {
  const modified = [];
  const added = [];
  const deleted = [];
  const untracked = [];

  // `git status --porcelain` distinguishes adds from modifications and catches
  // untracked files in one pass — needed so that a new file like
  // `.github/CODEOWNERS` lands in the touched set even before any `git add`.
  //
  // fp-003: the `-z` flag is load-bearing, not a perf tweak. Without it git
  // C-quotes any path containing a space or non-ASCII byte (default
  // core.quotePath=true) — `naïve.js` → `"na\303\257ve.js"` — and the old
  // `path.replace(/\\/g,'/')` then mangled the octal escapes into
  // `na/303/257ve.js`, silently corrupting the touched set the ownership gate
  // depends on. Under `-z` git emits raw NUL-terminated bytes with NO quoting
  // or escaping (spaces and UTF-8 preserved verbatim), so we split on \0 and
  // do NOT run any backslash→slash normalization on the bytes (that step
  // corrupts multibyte UTF-8 on POSIX). `-z` paths already use forward slashes.
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=normal'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
  } catch {
    // Not a git repo, or git unavailable. Return empty — caller treats the
    // empty set as "no independent verification available" and falls back to
    // the agent's self-report (degraded mode, surfaced in the report).
    return { modified: [], added: [], deleted: [], untracked: [], all: [], unavailable: true };
  }

  // Under `-z` each record is `XY <space> path\0` (X = index status, Y =
  // worktree status). A rename/copy record is special: the status field is
  // followed by the DESTINATION path in this record, then the SOURCE path as a
  // SEPARATE trailing NUL field (there is no ` -> ` separator under `-z`). We
  // want the destination as the primary touched entry, but the source is
  // NOT discarded (F-60a257a6): it is folded into `deleted` below.
  //
  // F-60a257a6: the source half of a rename/copy is a real ownership signal,
  // not noise. `git mv other-domain/file.js src/file.js` makes the
  // DESTINATION (src/file.js) the only path this loop used to see — which is
  // IN this agent's domain and therefore innocuous — while the SOURCE
  // (other-domain/file.js, a file the agent does NOT own) silently vanished
  // from the touched set entirely, because the old code did nothing but
  // `i++` past it. That is exactly the class of violation checkOwnership
  // exists to catch (an agent removing a file outside its assigned domain),
  // and the independently-computed evidence trail had no record of it — the
  // reverse direction (moving a file OUT of the agent's own domain) was
  // still caught, since the DESTINATION path itself would fail the
  // domain-glob match, so only the move-in direction was blind. The source
  // path is pushed to `deleted`, not a new bucket: from the touched-set's
  // perspective a rename-away IS a deletion at that path (the file no
  // longer exists there), which is the existing, correctly-named bucket for
  // exactly that fact, and it flows into `all` (what checkOwnership
  // consults) the same way any other `D` status already does.
  const fields = porcelain.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue; // trailing empty field after the final NUL
    const xy = record.slice(0, 2);
    const path = record.slice(3); // skip the single space after XY
    if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') {
      // The next field is the rename/copy SOURCE. Consume it as its own
      // record (so the outer loop does not also try to parse it as an XY
      // line) AND record it as touched — the agent moved this path out of
      // wherever it lived, and that is ownership-relevant at the SOURCE
      // location regardless of who owns the destination.
      const sourcePath = fields[i + 1];
      if (sourcePath) deleted.push(sourcePath);
      i++;
    }
    if (xy === '??') untracked.push(path);
    else if (xy[0] === 'D' || xy[1] === 'D') deleted.push(path);
    else if (xy[0] === 'A' || xy[1] === 'A') added.push(path);
    else modified.push(path); // includes R/C — destination is a touched tracked file
  }

  // F-4ba6036b: committed-delta union. `git diff --name-only <baseRef>` diffs
  // the base against the WORKING TREE, so it covers committed + staged +
  // unstaged tracked changes in one probe; the status pass above contributes
  // the untracked files a diff can never see. `-z` for the same quoting
  // reasons as the status probe (fp-003).
  let baseDiffUnavailable = false;
  if (options.baseRef) {
    try {
      const diffOut = execFileSync(
        'git', ['diff', '--name-only', '-z', options.baseRef],
        { cwd: repoPath, encoding: 'utf-8' }
      );
      for (const path of diffOut.split('\0')) {
        if (path) modified.push(path);
      }
    } catch {
      // Bad ref / shallow clone — fall back to status-only coverage, but say
      // so: the caller surfaces the degraded probe rather than silently
      // narrowing (same posture as the `unavailable` status-probe fallback).
      baseDiffUnavailable = true;
    }
  }

  const seen = new Set();
  const all = [];
  for (const p of [...modified, ...added, ...deleted, ...untracked]) {
    if (!seen.has(p)) { seen.add(p); all.push(p); }
  }

  const result = { modified, added, deleted, untracked, all };
  if (baseDiffUnavailable) result.baseDiffUnavailable = true;
  return result;
}

/**
 * Resolve the diff base for an ISOLATED worktree: the branch point where the
 * worktree branch forked off the main branch (dispatch-time HEAD). Using the
 * CURRENT main HEAD would be wrong once other waves' work merges into main —
 * their edits would diff as this agent's. Falls back to null when the
 * merge-base cannot be computed (caller then uses status-only coverage).
 *
 * @param {string} worktreePath
 * @param {string} mainBranch — runs.branch (e.g. 'main')
 * @returns {string|null}
 */
export function resolveWorktreeBaseRef(worktreePath, mainBranch) {
  try {
    return execFileSync(
      'git', ['merge-base', mainBranch, 'HEAD'],
      { cwd: worktreePath, encoding: 'utf-8' }
    ).trim() || null;
  } catch {
    return null;
  }
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
