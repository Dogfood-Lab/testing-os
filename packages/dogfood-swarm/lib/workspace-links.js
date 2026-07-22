/**
 * workspace-links.js — npm-workspaces link provisioning + realpath-containment
 * preflight for --isolate worktrees.
 *
 * Observed in run swarm-1784601601-bd4a (ai-rpg-engine, an npm-workspaces
 * monorepo, Windows): `git worktree add` checks out TRACKED files only, so a
 * fresh --isolate worktree has no node_modules at all. Because swarm worktrees
 * nest INSIDE the audited repo (<repo>/.swarm/worktrees/<name>/ — see
 * lib/worktree.js), Node's resolver walks ancestor directories out of the
 * worktree and resolves every bare specifier against the MAIN checkout's
 * node_modules — where the @scope/* workspace links point at the MAIN
 * checkout's package dirs. An isolated agent's `npm test` therefore exercised
 * the main checkout's code, not the worktree's own edits: green as an
 * illusion, with no MODULE_NOT_FOUND to disclose it. Incidental npm/npx
 * activity inside the worktree compounds this into a hybrid (a partial
 * worktree node_modules resolves what it has; everything it lacks — always
 * the workspace links — still silently escapes). The agent-side "repair"
 * (`npm install` in the worktree) rewrote package-lock.json, an edit outside
 * every domain's scope.
 *
 * The fix is deliberately NOT `npm install`/`npm ci` per worktree: that costs
 * seconds-to-minutes per agent inside dispatch's wave-build path, needs a
 * warm cache or network, and is exactly the lockfile-rewrite hazard observed
 * live. Instead we recreate ONLY the workspace self-links — the one
 * resolution class where escaping the worktree changes which CODE runs.
 * Third-party bare specifiers still fall through to the source repo's
 * complete node_modules, which is a valid materialization of the worktree's
 * OWN lockfile (the worktree is cut from HEAD; its package-lock.json is
 * byte-identical to the source repo's), so that fall-through is
 * version-exact and immutable for the life of the wave.
 *
 * Links are created with symlinkSync(target, path, 'junction') — on Windows
 * that is a directory junction (no admin rights / Developer Mode needed; the
 * same reparse type npm itself uses for workspace links on Windows), and the
 * type argument is ignored on POSIX where a plain symlink results.
 *
 * checkWorkspaceRealpathContainment is the doctor-style per-worktree
 * preflight (same {id,status,message,hint} row shape as commands/doctor.js
 * checks): every workspace link must exist and fs.realpathSync through it
 * must stay under the worktree root. createWorktree runs it after
 * provisioning and fails LOUD on violation — isolation is a contract
 * (F-693631-001), and a worktree whose workspace imports resolve elsewhere
 * is not isolated.
 *
 * Trust class: package.json files here belong to the AUDITED repo's checkout
 * — the same "untrusted target-repo file" class as
 * lib/verify/adapters/node.js's package.json read — so every read routes
 * through readBoundedJson (H5 discipline), workspace names are validated
 * against the npm name grammar before becoming link paths (a hostile
 * `"name": "../../x"` must not escape node_modules/), and glob expansion
 * never leaves the worktree (segment-wise readdir, no `..`).
 */

import {
  existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync,
  rmdirSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readBoundedJson } from './bounded-json-read.js';

export const WORKSPACE_CONTAINMENT_CHECK_ID = 'workspace-realpath-containment';

/**
 * npm package-name grammar (validate-npm-package-name's new-package rule).
 * Names failing this are skipped with a reason instead of becoming link
 * paths — the name field is audited-repo-authored input.
 */
const SAFE_PACKAGE_NAME = /^(@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Pattern shapes beyond "literal segments + single-level `*` wildcards" are
 * NOT expanded (returned in unsupportedPatterns for the caller to disclose).
 * npm workspaces overwhelmingly use `dir/*`; supporting minimatch's full
 * grammar here would mean vendoring a matcher for a tail that has never
 * appeared in a swarm-audited repo. Both the provisioner and the containment
 * check enumerate through this SAME expander, so an unsupported pattern is a
 * disclosed blind spot, never a false containment failure.
 */
function isSupportedPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  if (pattern.startsWith('!')) return false;
  if (pattern.includes('**')) return false;
  if (/[?{}[\]()]/.test(pattern)) return false;
  if (pattern.split('/').some(seg => seg === '..')) return false;
  return true;
}

/** Segment with `*` → RegExp matching one directory name (never dotdirs). */
function segmentToRegExp(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
  return new RegExp(`^${escaped}$`);
}

function expandPattern(rootDir, pattern) {
  let dirs = [rootDir];
  for (const segment of pattern.replace(/\/+$/, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    const next = [];
    if (segment.includes('*')) {
      const re = segmentToRegExp(segment);
      for (const dir of dirs) {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          if (re.test(entry.name)) next.push(join(dir, entry.name));
        }
      }
    } else {
      for (const dir of dirs) {
        const candidate = join(dir, segment);
        let st;
        try {
          st = lstatSync(candidate);
        } catch {
          continue;
        }
        if (st.isDirectory()) next.push(candidate);
      }
    }
    dirs = next;
    if (dirs.length === 0) break;
  }
  return dirs;
}

/**
 * Read <rootDir>/package.json and expand its workspaces patterns into
 * concrete workspace packages.
 *
 * @param {string} rootDir — worktree (or repo) root
 * @returns {null | {
 *   workspaces: Array<{ name: string, dir: string }>,
 *   unsupportedPatterns: string[],
 *   skipped: Array<{ dir: string, reason: string }>,
 * }} — null when rootDir is not an npm-workspaces repo (no package.json, an
 *   unreadable/malformed one, or no workspaces field). Degrade-not-throw:
 *   a non-Node target repo must not break worktree creation.
 */
export function enumerateWorkspacePackages(rootDir) {
  const rootManifestPath = join(rootDir, 'package.json');
  if (!existsSync(rootManifestPath)) return null;

  let rootManifest;
  try {
    rootManifest = readBoundedJson(rootManifestPath);
  } catch {
    return null;
  }
  if (!rootManifest || typeof rootManifest !== 'object') return null;

  // npm accepts both the array form and the { packages: [...] } object form.
  const rawPatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces && Array.isArray(rootManifest.workspaces.packages)
      ? rootManifest.workspaces.packages
      : null);
  if (!rawPatterns) return null;

  const unsupportedPatterns = [];
  const skipped = [];
  const workspaces = [];
  const seenNames = new Set();

  for (const pattern of rawPatterns) {
    if (!isSupportedPattern(pattern)) {
      unsupportedPatterns.push(String(pattern));
      continue;
    }
    for (const dir of expandPattern(rootDir, pattern)) {
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = readBoundedJson(manifestPath);
      } catch {
        skipped.push({ dir, reason: 'unreadable-or-malformed package.json' });
        continue;
      }
      const name = manifest && typeof manifest === 'object' ? manifest.name : undefined;
      if (typeof name !== 'string' || !SAFE_PACKAGE_NAME.test(name)) {
        skipped.push({ dir, reason: `unsafe or missing package name: ${JSON.stringify(name)}` });
        continue;
      }
      if (seenNames.has(name)) {
        skipped.push({ dir, reason: `duplicate workspace name: ${name}` });
        continue;
      }
      seenNames.add(name);
      workspaces.push({ name, dir });
    }
  }

  return { workspaces, unsupportedPatterns, skipped };
}

/**
 * Remove whatever occupies linkPath so a fresh link can land there. A
 * symlink/junction is unlinked WITHOUT following it (rmdirSync fallback:
 * Windows removes directory junctions via rmdir, and unlink can EPERM on
 * them); a real directory (a stale physical copy inside node_modules) is
 * removed recursively — it is dead weight by definition, the live source
 * is the workspace package dir.
 */
function removeExistingEntry(linkPath) {
  const st = lstatSync(linkPath, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(linkPath);
    } catch {
      rmdirSync(linkPath);
    }
    return;
  }
  if (st.isDirectory()) {
    rmSync(linkPath, { recursive: true, force: true });
    return;
  }
  rmSync(linkPath, { force: true });
}

/**
 * Materialize node_modules/<name> → <worktree>/<workspace-dir> links for
 * every workspace package in an npm-workspaces worktree. Idempotent —
 * existing entries at the link path are replaced.
 *
 * NEVER touches package-lock.json (no npm subprocess anywhere in this
 * module) — the observed-live failure mode this replaces was an agent-side
 * `npm install` rewriting the lockfile.
 *
 * @param {string} worktreePath
 * @returns {{
 *   isWorkspacesRepo: boolean,
 *   linked: Array<{ name: string, dir: string, linkPath: string }>,
 *   unsupportedPatterns: string[],
 *   skipped: Array<{ dir: string, reason: string }>,
 * }}
 * @throws {Error} when a link cannot be created (e.g. a volume without
 *   reparse-point support — the exFAT/FAT32 class commands/doctor.js already
 *   documents for hardlinks). Provisioning failure must fail LOUD: the
 *   caller (createWorktree → dispatch/resume) wraps it into IsolationError.
 */
export function provisionWorkspaceLinks(worktreePath) {
  const enumeration = enumerateWorkspacePackages(worktreePath);
  if (!enumeration) {
    return { isWorkspacesRepo: false, linked: [], unsupportedPatterns: [], skipped: [] };
  }

  const linked = [];
  for (const ws of enumeration.workspaces) {
    // SAFE_PACKAGE_NAME admits at most one '/', in the @scope/name position —
    // the join can never climb out of node_modules/.
    const linkPath = join(worktreePath, 'node_modules', ...ws.name.split('/'));
    mkdirSync(dirname(linkPath), { recursive: true });
    removeExistingEntry(linkPath);
    try {
      symlinkSync(ws.dir, linkPath, 'junction');
    } catch (e) {
      throw new Error(
        `workspace link creation failed for ${ws.name} → ${ws.dir}: ${e.message} ` +
        `(volume without reparse-point support, e.g. exFAT/FAT32? See \`swarm doctor\` posture on FS traps)`,
        { cause: e },
      );
    }
    linked.push({ name: ws.name, dir: ws.dir, linkPath });
  }

  return {
    isWorkspacesRepo: true,
    linked,
    unsupportedPatterns: enumeration.unsupportedPatterns,
    skipped: enumeration.skipped,
  };
}

/** true when childReal sits at or under rootReal (both already realpath'd;
 * path.win32.relative compares case-insensitively, so this holds on NTFS). */
function isUnderRoot(childReal, rootReal) {
  const rel = relative(rootReal, childReal);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Doctor-style per-worktree preflight: for every workspace package, the
 * node_modules/<name> link must EXIST and its fs.realpathSync must stay
 * under the worktree root. Catches all three broken provisioning shapes
 * observed in run swarm-1784601601-bd4a:
 *
 *   missing-link     — no entry at node_modules/<name>; a bare import walks
 *                      up out of the nested worktree and silently resolves
 *                      against the MAIN checkout (the green-illusion class).
 *   escapes-worktree — the entry resolves OUTSIDE the worktree (e.g. a
 *                      copied node_modules whose absolute junction targets
 *                      still point at the main checkout's package dirs).
 *   dangling-link    — the entry exists but its target does not resolve.
 *
 * @param {string} worktreePath
 * @returns {{ id: string, status: 'pass'|'fail', message: string,
 *   hint?: string, violations: Array<{ name: string, kind: string,
 *   linkPath: string, resolvedPath?: string }> }}
 */
export function checkWorkspaceRealpathContainment(worktreePath) {
  const enumeration = enumerateWorkspacePackages(worktreePath);
  if (!enumeration) {
    return {
      id: WORKSPACE_CONTAINMENT_CHECK_ID,
      status: 'pass',
      message: `not an npm-workspaces repo — containment not applicable: ${worktreePath}`,
      violations: [],
    };
  }

  let rootReal;
  try {
    rootReal = realpathSync(worktreePath);
  } catch (e) {
    return {
      id: WORKSPACE_CONTAINMENT_CHECK_ID,
      status: 'fail',
      message: `worktree root does not resolve (${e.code || e.message}): ${worktreePath}`,
      hint: 'the worktree path itself is gone or unreadable — recreate it (re-dispatch or `swarm resume`)',
      violations: [],
    };
  }

  const violations = [];
  for (const ws of enumeration.workspaces) {
    const linkPath = join(worktreePath, 'node_modules', ...ws.name.split('/'));
    const st = lstatSync(linkPath, { throwIfNoEntry: false });
    if (!st) {
      violations.push({ name: ws.name, kind: 'missing-link', linkPath });
      continue;
    }
    let resolved;
    try {
      resolved = realpathSync(linkPath);
    } catch {
      violations.push({ name: ws.name, kind: 'dangling-link', linkPath });
      continue;
    }
    if (!isUnderRoot(resolved, rootReal)) {
      violations.push({ name: ws.name, kind: 'escapes-worktree', linkPath, resolvedPath: resolved });
    }
  }

  if (violations.length > 0) {
    const detail = violations
      .map(v => `${v.name} (${v.kind}${v.resolvedPath ? ` → ${v.resolvedPath}` : ''})`)
      .join(', ');
    return {
      id: WORKSPACE_CONTAINMENT_CHECK_ID,
      status: 'fail',
      message: `${violations.length} of ${enumeration.workspaces.length} workspace link(s) resolve outside the worktree or are missing: ${detail}`,
      hint: 'bare workspace imports in this worktree would run the MAIN checkout\'s code (green-illusion class, run swarm-1784601601-bd4a). Recreate the worktree (re-dispatch / `swarm resume`); do NOT repair with `npm install` — it can rewrite package-lock.json.',
      violations,
    };
  }

  return {
    id: WORKSPACE_CONTAINMENT_CHECK_ID,
    status: 'pass',
    message: `all ${enumeration.workspaces.length} workspace link(s) resolve inside the worktree`,
    violations,
  };
}
