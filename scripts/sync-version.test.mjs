/**
 * Regression test for scripts/sync-version.mjs.
 *
 * Why this lives at the root scripts/ tree: the script isn't owned by any
 * workspace package and we don't want to grow a pseudo-workspace just to host
 * a 200-line test. Run via `npm run test:scripts` (also wired in CI right
 * after `npm ci` so the gate fails fast on lockfile drift).
 *
 * Coverage:
 *   - README updated in-place when stale
 *   - lockfile top-level + packages."" both updated when stale
 *   - --check throws DriftError on either drift, no writes
 *   - in-sync inputs return 'in-sync' for both, no writes
 *   - lockfile without packages."" entry (lockfileVersion 1) tolerated
 *   - F-178611-015 regression: README in-sync but lockfile at 1.0.0 → drift
 *
 * Cleanup: every test registers `t.after(() => rmSync(dir, ...))` at the
 * moment of allocation so the temp dir is removed even when an assertion
 * throws (closes F-651020-007). Trailing rmSync at the end of the test body
 * is the wrong shape — it never runs on assertion failure and leaks tmpdir
 * entries across CI and local runs.
 *
 * Wave A1 amend (H10): also imports check-lockfile-drift.test.mjs so that the
 * `npm run test:scripts` pipeline picks up the new lockfile-drift regression
 * test without needing a package.json scripts edit. sync-version.test.mjs is
 * the natural compose point — it's the existing entry that covers the two
 * lockfile surfaces sync-version.mjs *does* check; check-lockfile-drift.test
 * covers the surfaces it does NOT (per-workspace versions + engines.node).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncVersion, DriftError } from './sync-version.mjs';
// H10 regression: per-workspace version drift + engines.node drift. See
// scripts/check-lockfile-drift.test.mjs for the contract.
import './check-lockfile-drift.test.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function makeRepo(t, version, { readmeVersion, lockTopVersion, lockRootVersion, omitLockRoot, omitLockfile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake', version }, null, 2));
  writeFileSync(
    join(dir, 'README.md'),
    `# Fake\n<!-- version:start -->\nv${readmeVersion ?? version} — N tests\n<!-- version:end -->\nbody\n`
  );
  if (!omitLockfile) {
    const lock = {
      name: 'fake',
      version: lockTopVersion ?? version,
      lockfileVersion: 3,
      requires: true,
      packages: omitLockRoot
        ? {}
        : { '': { name: 'fake', version: lockRootVersion ?? version } },
    };
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  }
  return dir;
}

function readLock(dir) {
  return JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
}
function readReadme(dir) {
  return readFileSync(join(dir, 'README.md'), 'utf8');
}

test('in-sync repo returns in-sync for both, no writes', (t) => {
  const dir = makeRepo(t, '1.1.1');
  const before = statSync(join(dir, 'package-lock.json')).mtimeMs;
  const result = syncVersion({ repoRoot: dir, check: false });
  assert.equal(result.version, '1.1.1');
  assert.equal(result.readme, 'in-sync');
  assert.equal(result.lockfile, 'in-sync');
  const after = statSync(join(dir, 'package-lock.json')).mtimeMs;
  assert.equal(before, after, 'lockfile must not be rewritten when in-sync');
});

test('drifted lockfile top-level version is rewritten', (t) => {
  const dir = makeRepo(t, '1.1.1', { lockTopVersion: '1.0.0' });
  const result = syncVersion({ repoRoot: dir, check: false });
  assert.equal(result.lockfile, 'updated');
  const lock = readLock(dir);
  assert.equal(lock.version, '1.1.1');
  assert.equal(lock.packages[''].version, '1.1.1');
});

test('drifted lockfile packages."" version is rewritten', (t) => {
  const dir = makeRepo(t, '1.1.1', { lockRootVersion: '1.0.0' });
  const result = syncVersion({ repoRoot: dir, check: false });
  assert.equal(result.lockfile, 'updated');
  const lock = readLock(dir);
  assert.equal(lock.packages[''].version, '1.1.1');
});

test('F-178611-015 regression: README in-sync but lockfile at 1.0.0 → drift detected', (t) => {
  // Exactly the v1.1.1 ship state that triggered the finding.
  const dir = makeRepo(t, '1.1.1', { lockTopVersion: '1.0.0', lockRootVersion: '1.0.0' });
  assert.throws(
    () => syncVersion({ repoRoot: dir, check: true }),
    (err) => err instanceof DriftError && /package-lock\.json is stale/.test(err.message)
  );
  // Without --check, the same state should be auto-repaired.
  const result = syncVersion({ repoRoot: dir, check: false });
  assert.equal(result.lockfile, 'updated');
  assert.equal(readLock(dir).version, '1.1.1');
  assert.equal(readLock(dir).packages[''].version, '1.1.1');
});

test('--check throws DriftError on README drift, leaves files untouched', (t) => {
  const dir = makeRepo(t, '1.1.1', { readmeVersion: '1.0.0' });
  const before = readReadme(dir);
  assert.throws(
    () => syncVersion({ repoRoot: dir, check: true }),
    (err) => err instanceof DriftError && /README\.md is stale/.test(err.message)
  );
  assert.equal(readReadme(dir), before, 'README must not be written under --check');
});

test('--check throws DriftError on lockfile drift, leaves files untouched', (t) => {
  const dir = makeRepo(t, '1.1.1', { lockTopVersion: '1.0.0' });
  const beforeLock = readFileSync(join(dir, 'package-lock.json'), 'utf8');
  assert.throws(
    () => syncVersion({ repoRoot: dir, check: true }),
    (err) => err instanceof DriftError && /package-lock\.json is stale/.test(err.message)
  );
  assert.equal(
    readFileSync(join(dir, 'package-lock.json'), 'utf8'),
    beforeLock,
    'lockfile must not be written under --check'
  );
});

test('lockfile without packages."" entry is tolerated (legacy lockfileVersion 1 shape)', (t) => {
  const dir = makeRepo(t, '1.1.1', { omitLockRoot: true });
  const result = syncVersion({ repoRoot: dir, check: false });
  // Top-level is in-sync (we set it to '1.1.1' by default), packages."" absent.
  assert.equal(result.lockfile, 'in-sync');
});

test('absent lockfile reports absent, does not throw', (t) => {
  const dir = makeRepo(t, '1.1.1', { omitLockfile: true });
  const result = syncVersion({ repoRoot: dir, check: true });
  assert.equal(result.lockfile, 'absent');
});

test('lockfile rewrite preserves 2-space indent + trailing newline', (t) => {
  const dir = makeRepo(t, '1.1.1', { lockTopVersion: '1.0.0' });
  syncVersion({ repoRoot: dir, check: false });
  const raw = readFileSync(join(dir, 'package-lock.json'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'lockfile must end with a newline');
  // Must use 2-space indent (npm's default), not tabs or 4-space.
  assert.match(raw, /\n  "lockfileVersion": 3,/);
});

test('F-c03b121c: a version block containing TWO vX.Y.Z tokens throws loudly instead of stamping/validating only the first', (t) => {
  // VERSION_TOKEN_REGEX is single-match: with two tokens in the block, only
  // the FIRST is stamped/checked — a compound line like
  // 'v1.8.0 — supersedes v1.7.0' would ship the second token stale forever
  // while --check stays green. The contract is exactly ONE stampable token;
  // more is a loud config violation (plain Error, exit 2 — not DriftError).
  const dir = mkdtempSync(join(tmpdir(), 'sync-version-twotokens-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake', version: '1.8.0' }, null, 2));
  writeFileSync(
    join(dir, 'README.md'),
    `# Fake\n<!-- version:start -->\nv1.8.0 — current release, supersedes v1.7.0\n<!-- version:end -->\nbody\n`
  );
  for (const check of [true, false]) {
    assert.throws(
      () => syncVersion({ repoRoot: dir, check }),
      (err) => !(err instanceof DriftError) && /2 .*tokens|contains 2/.test(err.message),
      `check=${check}: two tokens in the block must throw a contract error naming the count`,
    );
  }
});

test('package.json without a version field throws', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-version-noversion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake' }));
  assert.throws(
    () => syncVersion({ repoRoot: dir, check: false }),
    /no version field/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-W1-CI-007 — ESM main-entry guard: only run main() when invoked as a
// script, not when imported by tests. Previous heuristic compared
// `resolve(fileURLToPath(import.meta.url))` to `resolve(process.argv[1])` —
// on Windows the two strings can disagree on drive-letter casing or 8.3 vs
// long-name resolution and the entry block silently no-ops. The canonical
// Node cross-platform pattern is `pathToFileURL(process.argv[1]).href ===
// import.meta.url` (matches apply-finding-migration.mjs's W31-BACK-001 fix;
// this id is dual-pinned in scripts/build.mjs's own main-entry guard too —
// see build.test.mjs for that sibling fix site).
// ─────────────────────────────────────────────────────────────────────────────

test('F-W1-CI-007: main-entry guard uses pathToFileURL(process.argv[1]).href === import.meta.url, not a resolve()-based compare', () => {
  const src = readFileSync(resolve(repoRoot, 'scripts/sync-version.mjs'), 'utf8');
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped
    .split(/\r?\n/)
    .find((l) => /^\s*const isMain\s*=/.test(l));
  assert.ok(guardLine, 'expected a `const isMain = ...` line in sync-version.mjs — pin is stale');
  assert.match(
    guardLine,
    /process\.argv\[1\]\s*&&/,
    'main-entry guard must short-circuit on `process.argv[1] &&`',
  );
  assert.match(
    guardLine,
    /pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url/,
    'main-entry guard must compare pathToFileURL(process.argv[1]).href against import.meta.url, not resolve()d path strings (F-W1-CI-007)',
  );
  assert.doesNotMatch(
    guardLine,
    /resolve\(\s*fileURLToPath/,
    'main-entry guard must not revert to the resolve(fileURLToPath(...)) === resolve(process.argv[1]) comparison — that class disagrees on Windows drive-letter casing / 8.3 resolution and silently no-ops (F-W1-CI-007)',
  );
});

test('F-W1-CI-007: `--check` invokes the main-entry block on a real script invocation (proves isMain fires), exits 0 on the in-sync live tree', () => {
  const targetScript = resolve(repoRoot, 'scripts/sync-version.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  // --check is read-only regardless of outcome — safe to run against the real
  // repo. A non-zero/non-one status would mean an uncaught (non-DriftError)
  // exception; either 0 (in-sync) or 1 (DriftError) proves main() ran.
  assert.ok(
    result.status === 0 || result.status === 1,
    `expected main() to run and exit 0 (in-sync) or 1 (drift), got ${result.status}.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /\[sync-version\]/, '--check must print the [sync-version] status line, proving isMain fired');
});
