/**
 * Regression test for the lockfile-drift gate (H10 / Wave A1 Stage A amend).
 *
 * Why this exists, beyond what sync-version.test.mjs already covers:
 *   sync-version.mjs is a field-stamper. It checks two surfaces — top-level
 *   `lock.version` and `lock.packages[""].version` — and rewrites them on
 *   drift. It does NOT inspect:
 *     - `lock.packages["packages/<name>"].version` (the 7 workspace-package
 *       entries that npm writes into the lockfile alongside their own
 *       package.json fields). At HEAD d0f7a58, these all carried `1.2.2`
 *       while root was at `1.2.3` — invisible to sync-version.
 *     - `lock.packages[""].engines.node`. At HEAD, the lockfile carried
 *       `>=20` while root package.json declared `>=22` (the 2026-05-14
 *       Node 20 EOL bump). Also invisible to sync-version.
 *
 *   The advisor's recommended path is:
 *     (1) heal the lockfile by running `npm install` so every field in the
 *         lockfile is regenerated from the actual workspace state;
 *     (2) add a CI guard (`npm install --package-lock-only &&
 *         git diff --exit-code package-lock.json`) that catches ANY future
 *         drift class, not just the two field-stamper looks at;
 *     (3) add THIS regression test that asserts the two specific surfaces
 *         the field-stamper still misses, wired into `npm run test:scripts`
 *         so local `npm run verify` also fails fast.
 *
 * Strategy: parse the actual repo lockfile + root package.json. Assert each
 * workspace-package entry's version matches root, and that engines.node
 * matches root. The test must FAIL at the pre-fix anchor
 * (`swarm-stage-a-amend1-pre`) and PASS after `npm install` heals it.
 *
 * To anchor the regression: a second test invocation reads
 * `git show swarm-stage-a-amend1-pre:package-lock.json` (or, in CI, a
 * baked-in fixture from .gitattributes is not available — we just run the
 * positive-case assertion against the live tree). The pre-fix anchor case
 * is documented in the wave deliverable rather than shipped as a fixture
 * because it would re-introduce the bad state every time the wave-amend
 * test fixture is updated.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkgPath = resolve(repoRoot, 'package.json');
const lockPath = resolve(repoRoot, 'package-lock.json');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workspaceEntries(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([key]) => key.startsWith('packages/'))
    .map(([key, value]) => ({ key, version: value.version, engines: value.engines }));
}

test('lockfile is present at repo root', () => {
  assert.ok(existsSync(lockPath), `expected package-lock.json at ${lockPath}`);
});

test('every workspace entry in lockfile carries the root package version (H10)', () => {
  const pkg = loadJson(pkgPath);
  const lock = loadJson(lockPath);
  const expected = pkg.version;
  const entries = workspaceEntries(lock);
  assert.ok(entries.length >= 1, 'expected at least one packages/* entry in lockfile');
  for (const { key, version } of entries) {
    assert.equal(
      version,
      expected,
      `lockfile entry ${key} carries version ${version} but root package.json is ${expected}. ` +
        `Run 'npm install' to regenerate the lockfile.`
    );
  }
});

test('lockfile root entry engines.node matches root package.json (H10, engines drift class)', () => {
  const pkg = loadJson(pkgPath);
  const lock = loadJson(lockPath);
  const expectedEngines = pkg.engines?.node;
  assert.ok(expectedEngines, 'root package.json must declare engines.node');
  const rootEntry = lock.packages?.[''];
  assert.ok(rootEntry, 'lockfile must have a packages[""] root entry');
  const actualEngines = rootEntry.engines?.node;
  assert.equal(
    actualEngines,
    expectedEngines,
    `lockfile root engines.node is ${actualEngines} but root package.json declares ${expectedEngines}. ` +
      `Run 'npm install' to regenerate the lockfile.`
  );
});

test('every workspace entry in lockfile carries engines.node matching root (H10 fix-up L1-005)', () => {
  // Advisor verifier Lens 1 (L1-005): the original H10 regression test
  // only asserted root-entry engines.node. Per-workspace lockfile entries
  // also carry engines.node when the workspace package.json declares one,
  // and at HEAD d0f7a58 those entries drifted to ">=20" alongside the
  // version drift. The CI step (`npm install --package-lock-only && git
  // diff --exit-code package-lock.json`) catches this operationally; this
  // assertion is the in-test mirror so `npm run verify` fails fast locally.
  const pkg = loadJson(pkgPath);
  const lock = loadJson(lockPath);
  const expected = pkg.engines?.node;
  assert.ok(expected, 'root package.json must declare engines.node');
  const entries = workspaceEntries(lock);
  for (const { key, engines } of entries) {
    // Only assert when the workspace entry actually carries engines — if
    // the workspace package.json doesn't declare it, the lockfile entry
    // won't either, and that's correct.
    if (engines === undefined) continue;
    const actual = engines?.node;
    assert.equal(
      actual,
      expected,
      `lockfile entry ${key} carries engines.node ${actual} but root package.json declares ${expected}. ` +
        `Run 'npm install' to regenerate the lockfile.`
    );
  }
});

test('lockfile top-level version matches root package.json (already covered by sync-version; defense-in-depth)', () => {
  const pkg = loadJson(pkgPath);
  const lock = loadJson(lockPath);
  assert.equal(
    lock.version,
    pkg.version,
    `lockfile top-level version is ${lock.version} but root package.json is ${pkg.version}.`
  );
  assert.equal(
    lock.packages?.['']?.version,
    pkg.version,
    `lockfile packages[""].version is ${lock.packages?.['']?.version} but root package.json is ${pkg.version}.`
  );
});
