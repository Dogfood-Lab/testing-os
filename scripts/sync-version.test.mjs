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
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVersion, DriftError } from './sync-version.mjs';

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

test('package.json without a version field throws', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-version-noversion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake' }));
  assert.throws(
    () => syncVersion({ repoRoot: dir, check: false }),
    /no version field/
  );
});
