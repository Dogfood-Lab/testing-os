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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hasRealPackage, findTsconfigReferenceDrift } from './build.mjs';

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
