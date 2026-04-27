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
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const packagesDir = resolve(repoRoot, 'packages');

const hasRealPackage =
  existsSync(packagesDir) &&
  readdirSync(packagesDir).some((entry) => {
    if (entry.startsWith('.')) return false;
    const p = resolve(packagesDir, entry);
    if (!statSync(p).isDirectory()) return false;
    return existsSync(resolve(p, 'package.json'));
  });

if (!hasRealPackage) {
  console.log('[testing-os build] No packages yet — skipping tsc --build.');
  process.exit(0);
}

// Drift gate: every packages/<name>/tsconfig.json must be in root references.
// Same drift class as STATUS.run / AUDIT_PHASES (F-693631-010 / F-375053-005)
// — a hand-maintained list duplicating an authoritative source. A new TS
// package added without updating root tsconfig.json would otherwise silently
// skip type-check from the root.
const tsPackages = readdirSync(packagesDir)
  .filter((entry) => {
    if (entry.startsWith('.')) return false;
    const p = resolve(packagesDir, entry);
    return statSync(p).isDirectory() && existsSync(resolve(p, 'tsconfig.json'));
  })
  .map((entry) => `packages/${entry}`);

const rootTsconfigPath = resolve(repoRoot, 'tsconfig.json');
const rootTsconfig = JSON.parse(readFileSync(rootTsconfigPath, 'utf8'));
const referenced = new Set(
  (rootTsconfig.references ?? []).map((r) => posix.normalize(r.path))
);
const missing = tsPackages.filter((p) => !referenced.has(p));

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
