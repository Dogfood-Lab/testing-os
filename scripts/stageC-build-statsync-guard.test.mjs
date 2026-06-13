/**
 * stageC-build-statsync-guard — regression for d6-infra-B002.
 *
 * build.mjs's hasRealPackage() and findTsconfigReferenceDrift() iterate every
 * entry under packages/ and call statSync(entry) to decide if it's a directory.
 * Pre-fix that statSync was UNCONDITIONAL: a broken symlink, an EACCES entry,
 * or a TOCTOU race (entry removed between readdirSync and statSync) makes
 * statSync throw ENOENT/EACCES/ELOOP, aborting `npm run build` with a raw Node
 * fs stack trace instead of the script's structured `[testing-os build]`
 * guidance. The rest of build.mjs is careful to emit operator-legible
 * console.error lines on drift; this IO boundary was the one spot that could
 * escape as a bare stack.
 *
 * The humanization fix: skip an un-stat-able entry (it cannot be a real package
 * or a TS package — both predicates need a readable directory) AND emit a
 * single structured `[testing-os build] skipped unreadable entry under
 * packages/: <path> — <code>` warning to stderr naming the offending path and
 * the fs error code, so a stray broken symlink degrades to "ignored that entry"
 * instead of crashing the wave-tolerant builder. A healthy package sitting
 * next to the broken entry must still be discovered — the guard skips the bad
 * entry, it does not abort the scan.
 *
 * Why a dedicated stageC- file rather than extending build.test.mjs: this guard
 * needs a broken-symlink fixture + a stderr-capture harness that the sibling
 * drift tests don't, and the Stage C naming convention prefixes new test files.
 *
 * Portability: the symlink fixture is created with symlinkSync to a
 * non-existent target. On the CI baseline (ubuntu-latest) and this dev rig
 * (Windows, dir-type symlink) that produces an entry whose statSync throws
 * ENOENT. If symlinkSync itself is unsupported (no privilege), the test
 * registers a skip with a logged reason rather than a silent pass.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hasRealPackage, findTsconfigReferenceDrift } from './build.mjs';

/** Allocate a temp packages/ fixture root with cleanup registered at alloc. */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stageC-build-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packagesDir = resolve(dir, 'packages');
  mkdirSync(packagesDir, { recursive: true });
  return {
    dir,
    packagesDir,
    rootTsconfigPath: resolve(dir, 'tsconfig.json'),
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
    /**
     * Plant a broken symlink under packages/ that statSync will throw ENOENT
     * on. Returns true on success, false (with reason logged) if symlinking is
     * unsupported on this host.
     */
    addBrokenSymlink(name) {
      try {
        symlinkSync(resolve(packagesDir, '__no_such_target__'), resolve(packagesDir, name), 'dir');
        return true;
      } catch (e) {
        return false;
      }
    },
    writeRootTsconfig(referencePaths) {
      writeFileSync(
        resolve(dir, 'tsconfig.json'),
        JSON.stringify({ files: [], references: referencePaths.map((p) => ({ path: p })) }, null, 2)
      );
    },
  };
}

/** Capture process.stderr.write for the duration of fn(), restore after. */
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) hasRealPackage: a broken symlink under packages/ must NOT abort the scan.
//     A real package sitting beside it must still be discovered (the guard
//     skips the bad entry, it does not crash the predicate).
// ─────────────────────────────────────────────────────────────────────────────

test('guard: hasRealPackage skips a broken symlink and still finds a real package', (t) => {
  const fx = makeFixture(t);
  if (!fx.addBrokenSymlink('broken-link')) {
    t.skip('symlinkSync unsupported on this host (no privilege) — cannot plant the broken-symlink fixture');
    return;
  }
  fx.addPackage('schemas'); // a real package beside the broken link

  let result;
  const stderr = captureStderr(() => {
    // Must NOT throw a raw ENOENT — pre-fix this line aborted with an fs stack.
    result = hasRealPackage(fx.packagesDir);
  });

  assert.equal(result, true, 'the real package must still be discovered past the broken-symlink entry');
  assert.match(
    stderr,
    /\[testing-os build] skipped unreadable entry under packages\/: .*broken-link.* — ENOENT/,
    'a structured [testing-os build] skip warning naming the offending path + fs code must be emitted'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) findTsconfigReferenceDrift: a broken symlink must be skipped, not crash
//     the drift scan, and must NOT spuriously appear in tsPackages/missing[].
// ─────────────────────────────────────────────────────────────────────────────

test('guard: findTsconfigReferenceDrift skips a broken symlink and reports real drift correctly', (t) => {
  const fx = makeFixture(t);
  if (!fx.addBrokenSymlink('broken-link')) {
    t.skip('symlinkSync unsupported on this host (no privilege) — cannot plant the broken-symlink fixture');
    return;
  }
  fx.addPackage('schemas'); // referenced
  fx.addPackage('analytics'); // a real TS package, NOT referenced → genuine drift
  fx.writeRootTsconfig(['packages/schemas']);

  let out;
  const stderr = captureStderr(() => {
    // Must NOT throw on the broken-link entry.
    out = findTsconfigReferenceDrift({
      packagesDir: fx.packagesDir,
      rootTsconfigPath: fx.rootTsconfigPath,
    });
  });

  // The broken symlink is neither a real package nor a TS package — it must be
  // absent from both discovered lists, while the genuine drift still surfaces.
  assert.deepEqual(out.tsPackages.sort(), ['packages/analytics', 'packages/schemas']);
  assert.deepEqual(out.missing, ['packages/analytics'], 'real drift must still be reported');
  assert.ok(
    !out.tsPackages.includes('packages/broken-link'),
    'the broken-symlink entry must never appear as a TS package'
  );
  assert.match(
    stderr,
    /\[testing-os build] skipped unreadable entry under packages\/: .*broken-link.* — ENOENT/,
    'a structured skip warning naming the offending path + fs code must be emitted'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Healthy-input regression: with NO broken entry, no skip warning is
//     emitted and discovery is unchanged. Proves the guard only fires on the
//     abnormal entry and does not become a chatty no-op in the common case.
// ─────────────────────────────────────────────────────────────────────────────

test('guard: a clean packages/ tree emits no skip warning (guard is silent on healthy input)', (t) => {
  const fx = makeFixture(t);
  fx.addPackage('schemas');
  fx.addPackage('analytics');
  fx.writeRootTsconfig(['packages/schemas', 'packages/analytics']);

  let real;
  let drift;
  const stderr = captureStderr(() => {
    real = hasRealPackage(fx.packagesDir);
    drift = findTsconfigReferenceDrift({
      packagesDir: fx.packagesDir,
      rootTsconfigPath: fx.rootTsconfigPath,
    });
  });

  assert.equal(real, true);
  assert.deepEqual(drift.missing, [], 'no drift on a fully-referenced tree');
  assert.equal(
    stderr.includes('[testing-os build] skipped unreadable entry'),
    false,
    'a healthy tree must not emit any skip warning'
  );
});
