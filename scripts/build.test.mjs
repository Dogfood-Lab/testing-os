/**
 * Regression tests for scripts/build.mjs's tsconfig-references drift gate.
 *
 * Why this lives at the root scripts/ tree: same reason as sync-version.test.mjs
 * and check-doc-drift.test.mjs — build.mjs isn't owned by any workspace package
 * and we don't grow a pseudo-workspace just to host its test. Run via
 * `npm run test:scripts` (the `scripts/*.test.mjs` glob picks it up; also wired
 * in CI after `npm ci`).
 *
 * What it guards (d6-infra-002): build.mjs carries a Class-#11 drift gate —
 * every packages/<name>/tsconfig.json must be registered in the root
 * tsconfig.json `references` array, else `npm run build` exits 1. The gate
 * passes VACUOUSLY in the live tree today (one TS package `schemas`, one
 * matching reference), so its missing[]-filter, posix.normalize() comparison,
 * and the hasRealPackage early-skip were entirely unexercised. The four sibling
 * script gates (sync-version, check-doc-drift, check-finding-regression-pins,
 * apply-finding-migration) each ship a colocated test; build.mjs shipped none.
 * These tests make the gate non-vacuous: each MUTATES the protected thing (adds
 * an unreferenced TS package / drops the reference / empties packages/) and
 * asserts the gate reacts.
 *
 * Cleanup: every makeFixture() call registers `t.after(() => rmSync(dir, ...))`
 * at allocation time (mirroring the sync-version.test.mjs pattern that closed
 * F-651020-007) so the temp dir is removed even when an assertion throws.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hasRealPackage, findTsconfigReferenceDrift } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Allocate a temp fixture root, register cleanup, and return helpers that mimic
 * the relevant subset of the real repo layout (a packages/ tree + a root
 * tsconfig.json).
 */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'build-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packagesDir = resolve(dir, 'packages');
  mkdirSync(packagesDir, { recursive: true });
  return {
    dir,
    packagesDir,
    rootTsconfigPath: resolve(dir, 'tsconfig.json'),
    /** Create packages/<name>/ with optional package.json and/or tsconfig.json. */
    addPackage(name, { withPackageJson = true, withTsconfig = true } = {}) {
      const pkgDir = resolve(packagesDir, name);
      mkdirSync(pkgDir, { recursive: true });
      if (withPackageJson) {
        writeFileSync(
          resolve(pkgDir, 'package.json'),
          JSON.stringify({ name: `@dogfood-lab/${name}`, version: '0.0.0' }, null, 2)
        );
      }
      if (withTsconfig) {
        writeFileSync(
          resolve(pkgDir, 'tsconfig.json'),
          JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: {} }, null, 2)
        );
      }
    },
    /** Write the root tsconfig.json with the given `references` paths. */
    writeRootTsconfig(referencePaths) {
      writeFileSync(
        resolve(dir, 'tsconfig.json'),
        JSON.stringify(
          { files: [], references: referencePaths.map((p) => ({ path: p })) },
          null,
          2
        )
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Drift fixture: a TS package absent from root references → missing[] fires.
//     This is the exact regression the gate exists to catch — the mutation is
//     "add a second TS package, forget the root reference".
// ─────────────────────────────────────────────────────────────────────────────

test('drift: a TS package missing from root references is reported in missing[]', (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas'); // TS package, WILL be referenced
  fx.addPackage('analytics'); // TS package, will NOT be referenced (the drift)
  fx.writeRootTsconfig(['packages/schemas']); // analytics omitted on purpose

  const { tsPackages, missing } = findTsconfigReferenceDrift({
    packagesDir: fx.packagesDir,
    rootTsconfigPath: fx.rootTsconfigPath,
  });

  assert.deepEqual(tsPackages.sort(), ['packages/analytics', 'packages/schemas']);
  assert.deepEqual(missing, ['packages/analytics'], 'the unreferenced TS package must surface in missing[]');
});

test('clean: every TS package referenced → missing[] empty (gate passes)', (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas');
  fx.addPackage('analytics');
  fx.writeRootTsconfig(['packages/schemas', 'packages/analytics']);

  const { missing } = findTsconfigReferenceDrift({
    packagesDir: fx.packagesDir,
    rootTsconfigPath: fx.rootTsconfigPath,
  });

  assert.deepEqual(missing, [], 'no drift when every TS package has a root reference');
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Normalization fixture: a reference written as './packages/x' or
//     'packages/x/' (trailing dot/slash) must still match the discovered
//     'packages/x'. Probes the posix.normalize() comparison on BOTH sides.
// ─────────────────────────────────────────────────────────────────────────────

test("normalization: './packages/x' reference matches discovered 'packages/x' (no false drift)", (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas');
  fx.writeRootTsconfig(['./packages/schemas']); // leading-dot form

  const { missing } = findTsconfigReferenceDrift({
    packagesDir: fx.packagesDir,
    rootTsconfigPath: fx.rootTsconfigPath,
  });

  assert.deepEqual(missing, [], "'./packages/schemas' must normalize-match 'packages/schemas'");
});

test("normalization: 'packages/x/' trailing-slash reference matches discovered 'packages/x'", (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas');
  fx.writeRootTsconfig(['packages/schemas/']); // trailing-slash form

  const { missing } = findTsconfigReferenceDrift({
    packagesDir: fx.packagesDir,
    rootTsconfigPath: fx.rootTsconfigPath,
  });

  assert.deepEqual(missing, [], "'packages/schemas/' must normalize-match 'packages/schemas'");
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Discovery scoping: only directories WITH a tsconfig.json count as TS
//     packages; a JS-only package (package.json but no tsconfig.json) and
//     dot-prefixed entries are ignored, so they never spuriously appear in
//     missing[].
// ─────────────────────────────────────────────────────────────────────────────

test('discovery: a JS-only package (no tsconfig.json) is not a TS package and never drifts', (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas'); // TS
  fx.addPackage('findings', { withTsconfig: false }); // JS-only — must be ignored
  fx.writeRootTsconfig(['packages/schemas']); // findings intentionally absent

  const { tsPackages, missing } = findTsconfigReferenceDrift({
    packagesDir: fx.packagesDir,
    rootTsconfigPath: fx.rootTsconfigPath,
  });

  assert.deepEqual(tsPackages, ['packages/schemas'], 'JS-only package must not be discovered as a TS package');
  assert.deepEqual(missing, [], 'a JS-only package must not trip the references drift gate');
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) hasRealPackage early-skip: an empty packages/ dir (or a packages/ with
//     only dot-dirs / tsconfig-less dirs) returns false so build.mjs skips
//     `tsc --build` instead of tripping TS18002.
// ─────────────────────────────────────────────────────────────────────────────

test('early-skip: empty packages/ dir → hasRealPackage is false', (t) => {
  const fx = makeFixture(t); // packagesDir created empty
  assert.equal(hasRealPackage(fx.packagesDir), false, 'empty packages/ must skip the build');
});

test('early-skip: a non-existent packages/ dir → hasRealPackage is false', (t) => {
  const fx = makeFixture(t);
  const ghost = resolve(fx.dir, 'does-not-exist');
  assert.equal(hasRealPackage(ghost), false, 'missing packages/ must skip the build');
});

test('early-skip: a dir with a real package → hasRealPackage is true', (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas');
  assert.equal(hasRealPackage(fx.packagesDir), true);
});

test('early-skip: a packages/ with only a dot-prefixed dir → hasRealPackage is false', (t) => {
  const fx = makeFixture(t);
  mkdirSync(resolve(fx.packagesDir, '.cache'), { recursive: true });
  writeFileSync(resolve(fx.packagesDir, '.cache', 'package.json'), '{}');
  assert.equal(hasRealPackage(fx.packagesDir), false, 'dot-prefixed entries are not real packages');
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) F-b27d6c0c: the `tsc --build` execSync call is wrapped in try/catch and
//     reports a structured '[testing-os build] ...' message, not a raw Node
//     stack trace. execSync('tsc --build', ...) lives inside the CLI entry
//     block (only runs when build.mjs is invoked directly), so it can't be
//     exercised via import like hasRealPackage/findTsconfigReferenceDrift
//     above — this spawns build.mjs as a real subprocess instead. The fixture
//     passes BOTH earlier gates (hasRealPackage, tsconfig reference drift)
//     cleanly so execution actually reaches the execSync line, then starves
//     PATH so `tsc` itself cannot resolve — a completely real, non-mocked
//     execSync throw (ENOENT via the shell's command-not-found path), not a
//     synthetic one. That throw is exactly what an uncaught call would have
//     surfaced as a raw stack trace pre-fix; it is what this test proves is
//     now caught and reworded.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fixture repo root that is a real, self-contained copy of the
 * scripts/ dir (so build.mjs's `here`/`repoRoot` resolution — always
 * relative to its OWN file location, not an injectable parameter — lands on
 * the fixture, not the real repo) plus a packages/ tree that clears both
 * earlier gates.
 */
function makeCliFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'build-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(resolve(dir, 'scripts'), { recursive: true });
  copyFileSync(resolve(here, 'build.mjs'), resolve(dir, 'scripts/build.mjs'));
  mkdirSync(resolve(dir, 'packages/foo'), { recursive: true });
  writeFileSync(resolve(dir, 'packages/foo/package.json'), JSON.stringify({ name: '@dogfood-lab/foo', version: '0.0.0' }));
  writeFileSync(resolve(dir, 'packages/foo/tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: 'packages/foo' }] }));
  return dir;
}

test('F-b27d6c0c: an execSync failure on `tsc --build` prints the structured message and exits 1, no raw stack', (t) => {
  const fixtureRoot = makeCliFixture(t);
  const res = spawnSync(process.execPath, [resolve(fixtureRoot, 'scripts/build.mjs')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    // Starve PATH (keep only a directory that cannot contain `tsc`) so the
    // execSync('tsc --build', ...) call inside build.mjs fails with a real,
    // unmocked "command not found" — reachable only because the fixture
    // above already clears hasRealPackage + the reference-drift gate.
    env: { ...process.env, PATH: dirname(process.execPath), Path: dirname(process.execPath) },
  });
  const combined = `${res.stdout}\n${res.stderr}`;

  assert.notEqual(res.status, 0, `build.mjs must exit non-zero when tsc --build fails\n${combined}`);
  assert.match(
    combined,
    /\[testing-os build\] tsc --build failed/,
    `expected the structured '[testing-os build] tsc --build failed' message\n${combined}`,
  );
  // The pre-fix behavior: an uncaught execSync throw prints Node's own
  // "Error: Command failed: tsc --build" plus internal child_process stack
  // frames. Neither should appear once the throw is caught and reworded.
  assert.doesNotMatch(
    combined,
    /Command failed: tsc --build/,
    `raw execSync error text leaked through — the catch block should have replaced it\n${combined}`,
  );
  assert.doesNotMatch(
    combined,
    /at ChildProcess|internal\/child_process/,
    `a raw Node internal stack trace leaked through — the catch block should have swallowed it\n${combined}`,
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
// this id is dual-pinned in scripts/sync-version.mjs's own main-entry guard
// too — see sync-version.test.mjs for that sibling fix site).
//
// No separate "main() runs on real invocation" spawn test here: the
// F-b27d6c0c test above ALREADY proves it end-to-end — it spawns build.mjs
// via makeCliFixture() and only reaches the "tsc --build failed" branch
// because the `if (isMain)` block fired first. Duplicating that spawn here
// (which would additionally need PATH starved of `tsc` to stay fast) would
// be redundant; this test adds only the structural guard-shape pin.
// ─────────────────────────────────────────────────────────────────────────────

test('F-W1-CI-007: main-entry guard uses pathToFileURL(process.argv[1]).href === import.meta.url, not a resolve()-based compare', () => {
  const src = readFileSync(resolve(here, 'build.mjs'), 'utf8');
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped
    .split(/\r?\n/)
    .find((l) => /^\s*const isMain\s*=/.test(l));
  assert.ok(guardLine, 'expected a `const isMain = ...` line in build.mjs — pin is stale');
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
