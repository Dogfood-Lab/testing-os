#!/usr/bin/env node
/**
 * sync-version.mjs — stamp the current workspace version into README.md and
 * package-lock.json.
 *
 * Why: the README carries a prominent "vX.Y.Z — N tests, ..." line just under
 * the badges, and `package-lock.json` carries the version twice (top-level and
 * `packages.""`). Historically (pre-v4.4) the README was hand-edited every
 * release, and at the v4.3.0 → v4.4.0 bump it drifted (INF-B-001). The
 * lockfile drift caught here in v1.1.1 (F-178611-015) shipped `1.0.0` while
 * `package.json` was `1.1.1` because no install ran between bumps. This script
 * is the single source of truth — root `package.json` is authoritative, README
 * and lockfile version fields are generated.
 *
 * Contract:
 *   README.md
 *     - Must contain a single block delimited by
 *       <!-- version:start --> ... <!-- version:end -->.
 *     - That block is replaced wholesale. Any hand-edits inside it are lost.
 *     - Everything outside the block (tests count, package count, mode count,
 *       short descriptor) is preserved — we only rewrite the vX.Y.Z token.
 *
 *   package-lock.json
 *     - Must be lockfileVersion 3 (npm 7+).
 *     - Two version fields are kept in sync with package.json:
 *         (a) top-level `version`
 *         (b) `packages[""].version` (the workspace-root entry)
 *     - Other lockfile fields are untouched. Re-serialised with 2-space indent
 *       + trailing newline (npm's default) so `npm install` won't churn the
 *       file on next run.
 *
 * Usage:
 *   node scripts/sync-version.mjs           # rewrite if drifted
 *   node scripts/sync-version.mjs --check   # exit non-zero if drifted (CI gate)
 *
 * Invoked automatically via npm `prebuild` so `npm run build` at the repo root
 * always refreshes README + lockfile before producing artifacts.
 *
 * Programmatic API (for tests):
 *   import { syncVersion } from './sync-version.mjs';
 *   const result = syncVersion({ repoRoot, check: false });
 *   // result = { version, readme: 'in-sync'|'updated'|'drift', lockfile: ... }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_BLOCK_START = '<!-- version:start -->';
const VERSION_BLOCK_END = '<!-- version:end -->';
const VERSION_TOKEN_REGEX = /v\d+\.\d+\.\d+(?:-[\w.]+)?/;

/**
 * Run the sync. Pure-ish — mutates the filesystem only when `check` is false
 * and a drift exists. Returns a summary object so callers (CLI + tests) can
 * inspect what happened without re-reading the files.
 *
 * @param {Object} opts
 * @param {string} opts.repoRoot - absolute path to repo root
 * @param {boolean} opts.check   - if true, never write; throw on drift
 * @returns {{version: string, readme: 'in-sync'|'updated', lockfile: 'in-sync'|'updated'|'absent'}}
 */
export function syncVersion({ repoRoot, check = false }) {
  const pkgPath = resolve(repoRoot, 'package.json');
  const readmePath = resolve(repoRoot, 'README.md');
  const lockPath = resolve(repoRoot, 'package-lock.json');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
  if (!version) {
    throw new Error('[sync-version] root package.json has no version field');
  }

  const readmeStatus = syncReadme({ readmePath, version, check });
  const lockfileStatus = syncLockfile({ lockPath, version, check });

  return { version, readme: readmeStatus, lockfile: lockfileStatus };
}

function syncReadme({ readmePath, version, check }) {
  const readme = readFileSync(readmePath, 'utf8');
  const startIdx = readme.indexOf(VERSION_BLOCK_START);
  const endIdx = readme.indexOf(VERSION_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `[sync-version] README.md is missing the ${VERSION_BLOCK_START} / ${VERSION_BLOCK_END} block.\n` +
        `Add one around the "v${version} — ..." line so this script can keep it current.`
    );
  }

  const before = readme.slice(0, startIdx + VERSION_BLOCK_START.length);
  const after = readme.slice(endIdx);
  const inner = readme.slice(startIdx + VERSION_BLOCK_START.length, endIdx);

  if (!VERSION_TOKEN_REGEX.test(inner)) {
    throw new Error('[sync-version] README.md version block does not contain a vX.Y.Z token to replace.');
  }
  const nextInner = inner.replace(VERSION_TOKEN_REGEX, `v${version}`);

  if (nextInner === inner) return 'in-sync';

  if (check) {
    throw new DriftError(
      `[sync-version] README.md is stale. Expected v${version} but block contains a different version.\n` +
        `Run: node scripts/sync-version.mjs`
    );
  }

  writeFileSync(readmePath, before + nextInner + after);
  return 'updated';
}

function syncLockfile({ lockPath, version, check }) {
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }

  const lock = JSON.parse(raw);

  // Field (a): top-level version.
  // Field (b): packages[""].version — the workspace-root entry, present in
  // lockfileVersion 2+. Older v1 lockfiles don't have it; tolerate that.
  const topDrift = lock.version !== version;
  const rootEntry = lock.packages?.[''];
  const rootDrift = rootEntry !== undefined && rootEntry.version !== version;

  if (!topDrift && !rootDrift) return 'in-sync';

  if (check) {
    throw new DriftError(
      `[sync-version] package-lock.json is stale.\n` +
        `  package.json:                ${version}\n` +
        `  package-lock.json version:   ${lock.version}\n` +
        `  package-lock.json packages."" version: ${rootEntry?.version ?? '<absent>'}\n` +
        `Run: node scripts/sync-version.mjs (or 'npm install' to regenerate fully).`
    );
  }

  if (topDrift) lock.version = version;
  if (rootDrift) rootEntry.version = version;

  // npm writes lockfiles with 2-space indent + trailing newline. Match it so
  // a subsequent `npm install` doesn't reformat and dirty the working tree.
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return 'updated';
}

/** Sentinel so the CLI can exit 1 on drift but other errors exit 2. */
export class DriftError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriftError';
  }
}

// CLI entry — only run when invoked directly, not when imported by tests.
const isMain = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const check = process.argv.includes('--check');

  try {
    const result = syncVersion({ repoRoot, check });
    if (check) {
      console.log(
        `[sync-version] OK at v${result.version} (README: ${result.readme}, lockfile: ${result.lockfile}).`
      );
    } else {
      const changed = [
        result.readme === 'updated' ? 'README.md' : null,
        result.lockfile === 'updated' ? 'package-lock.json' : null,
      ].filter(Boolean);
      if (changed.length === 0) {
        console.log(`[sync-version] Already in sync at v${result.version}.`);
      } else {
        console.log(`[sync-version] Stamped v${result.version} into ${changed.join(', ')}.`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(err instanceof DriftError ? 1 : 2);
  }
}
