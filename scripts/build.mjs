#!/usr/bin/env node
/**
 * build.mjs — wave-tolerant root builder.
 *
 * Skips `tsc --build` when `packages/` has no real package (e.g. fresh clone
 * before any package scaffold), otherwise invokes it. Keeping this guard is
 * cheap and avoids `error TS18002: The files list in config file is empty`
 * on an empty workspace. Drift-detection: also asserts every TS-bearing
 * package under packages/ is registered in the root tsconfig.json's
 * `references` list and exits non-zero on drift (closes audit-coverage gap
 * #11 — hand-maintained list duplicating an authoritative source).
 *
 * The drift logic is exported as pure functions (`hasRealPackage`,
 * `findTsconfigReferenceDrift`) so scripts/build.test.mjs can exercise the
 * missing[]-filter, the posix.normalize() reference comparison, and the
 * empty-packages early-skip without spawning `tsc --build`. This mirrors the
 * `syncVersion()` / `runDriftChecks()` separation in the sibling script gates
 * — the gate was previously module-top-level and therefore untestable
 * (d6-infra-002).
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True when `packages/` holds at least one real package (a directory, not
 * dot-prefixed, with a package.json). Mirrors the `hasRealPackage` guard so an
 * empty/fresh workspace skips `tsc --build` rather than tripping TS18002.
 *
 * @param {string} packagesDir — absolute path to the packages/ dir
 * @returns {boolean}
 */
export function hasRealPackage(packagesDir) {
  return (
    existsSync(packagesDir) &&
    readdirSync(packagesDir).some((entry) => {
      if (entry.startsWith('.')) return false;
      const p = resolve(packagesDir, entry);
      if (!statSync(p).isDirectory()) return false;
      return existsSync(resolve(p, 'package.json'));
    })
  );
}

/**
 * Drift gate: every packages/<name>/tsconfig.json must be registered in the
 * root tsconfig.json `references` array. Same drift class as STATUS.run /
 * AUDIT_PHASES (F-693631-010 / F-375053-005) — a hand-maintained list
 * duplicating an authoritative source. A new TS package added without updating
 * root tsconfig.json would otherwise silently skip type-check from the root.
 *
 * Reference paths are canonicalized on BOTH sides (`posix.normalize` plus a
 * trailing-slash strip) so all three valid tsconfig reference spellings —
 * `packages/x`, `./packages/x`, and `packages/x/` — match the discovered
 * `packages/x`. `posix.normalize` alone collapses `./` and `//` but PRESERVES
 * a trailing slash, so a `packages/x/` reference would otherwise false-positive
 * as drift; `normalizeRef` strips it.
 *
 * @param {object} opts
 * @param {string} opts.packagesDir — absolute path to packages/
 * @param {string} opts.rootTsconfigPath — absolute path to root tsconfig.json
 * @returns {{ tsPackages: string[], referenced: string[], missing: string[] }}
 */
export function findTsconfigReferenceDrift({ packagesDir, rootTsconfigPath }) {
  const tsPackages = readdirSync(packagesDir)
    .filter((entry) => {
      if (entry.startsWith('.')) return false;
      const p = resolve(packagesDir, entry);
      return statSync(p).isDirectory() && existsSync(resolve(p, 'tsconfig.json'));
    })
    .map((entry) => normalizeRef(`packages/${entry}`));

  const rootTsconfig = JSON.parse(readFileSync(rootTsconfigPath, 'utf8'));
  const referenced = (rootTsconfig.references ?? []).map((r) => normalizeRef(r.path));
  const referencedSet = new Set(referenced);
  const missing = tsPackages.filter((p) => !referencedSet.has(p));

  return { tsPackages, referenced, missing };
}

/**
 * Canonicalize a tsconfig reference path for comparison: posix-normalize
 * (collapses `./` and `//`) then strip a single trailing slash so
 * `packages/x/` and `packages/x` compare equal. The root path `/` is left
 * intact (never a valid package reference, but a defensive guard).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeRef(p) {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

// CLI entry — only run when invoked directly, not when imported by tests.
// `pathToFileURL(process.argv[1]).href === import.meta.url` is the canonical
// cross-platform entrypoint check (matches sync-version.mjs / F-W1-CI-007);
// on Windows a raw string compare can disagree on drive-letter casing or
// 8.3-vs-long-name resolution and silently no-op.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const packagesDir = resolve(repoRoot, 'packages');

  if (!hasRealPackage(packagesDir)) {
    console.log('[testing-os build] No packages yet — skipping tsc --build.');
    process.exit(0);
  }

  const rootTsconfigPath = resolve(repoRoot, 'tsconfig.json');
  const { missing } = findTsconfigReferenceDrift({ packagesDir, rootTsconfigPath });

  if (missing.length > 0) {
    console.error(
      `[testing-os build] tsconfig.json references drift — these packages have a tsconfig.json but are not referenced from root: ${missing.join(', ')}`
    );
    console.error(
      `Add them to tsconfig.json's "references" array, e.g.: { "path": "${missing[0]}" }`
    );
    process.exit(1);
  }

  execSync('tsc --build', { stdio: 'inherit', cwd: repoRoot });
}
