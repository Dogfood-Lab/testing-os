/**
 * Regression tests for scripts/apply-finding-migration.mjs.
 *
 * Stage C Wave A2 D4B-003 (Class #14 6th-iteration instance): the existing
 * Windows-cross-platform main-entry guard pattern is `process.argv[1] &&
 * pathToFileURL(process.argv[1]).href === import.meta.url`. Sibling scripts
 * (sync-version.mjs:167, check-finding-regression-pins.mjs:285, the live
 * canonical at check-doc-drift.mjs:994) all have the short-circuit. The
 * apply-finding-migration.mjs guard at line 232 is missing the
 * `process.argv[1] &&` half — invocation paths where argv[1] is undefined
 * (Node REPL, dynamic `import()` from stdin/eval, certain test harnesses)
 * throw `TypeError: The "path" argument must be of type string. Received
 * undefined` instead of cleanly no-op'ing the main-entry block.
 *
 * Test invariant (two halves):
 *   1. Importing the module from a context where `process.argv[1]` is
 *      undefined must NOT throw a TypeError. The main block silently
 *      no-ops; only the named exports (applyMigration, loadManifest) are
 *      visible.
 *   2. Counter-test: when invoked normally as a Node entrypoint
 *      (`node scripts/apply-finding-migration.mjs --help-ish`), the main
 *      block runs as before — proven by parseArgs reaching the no-manifest
 *      exit path with code 1 (manifest-required error).
 *
 * Pattern reference: Class #14 main-entry-guard sweep first landed in
 * W31-BACK-001 (apply-finding-migration.mjs:225 comment block names the
 * pattern). The audit-the-audit caught that the guard itself shipped with
 * the older, fragile half — fixed in this wave alongside the doc-drift
 * schema-conformance vacuous-gate cleanup.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const targetScript = resolve(repoRoot, 'scripts/apply-finding-migration.mjs');

test('apply-finding-migration: target script exists', () => {
  assert.ok(existsSync(targetScript), `expected ${targetScript}`);
});

test('apply-finding-migration: main-entry guard short-circuits when process.argv[1] is undefined (D4B-003)', () => {
  // Reproduce the failure path: spawn `node -e` with no script argv[1].
  // The module must import cleanly — main() must NOT fire, and crucially
  // `pathToFileURL(undefined)` must NOT throw a TypeError that would
  // propagate up through the dynamic import.
  //
  // We resolve to a file: URL string and import() it from the -e snippet.
  // When the guard is buggy (`if (import.meta.url === pathToFileURL(process.argv[1]).href)`),
  // the import rejects with `TypeError: The "path" argument must be of type
  // string. Received undefined`. When fixed (`if (process.argv[1] && ...)`),
  // the import resolves and the named exports become visible.
  const fileUrl = `file:///${targetScript.replace(/\\/g, '/')}`;
  const snippet = `
    import(${JSON.stringify(fileUrl)})
      .then((mod) => {
        if (typeof mod.applyMigration !== 'function') {
          console.error('MISSING_EXPORT_applyMigration');
          process.exit(3);
        }
        if (typeof mod.loadManifest !== 'function') {
          console.error('MISSING_EXPORT_loadManifest');
          process.exit(3);
        }
        console.log('GUARD_OK');
        process.exit(0);
      })
      .catch((err) => {
        console.error('IMPORT_FAILED:' + err.message);
        process.exit(4);
      });
  `;

  const result = spawnSync(process.execPath, ['-e', snippet], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Diagnostic surface: include both streams on any non-zero exit so a
  // future regression points at the exact failure (TypeError vs. missing
  // export vs. some new failure mode).
  if (result.status !== 0) {
    const tag = result.stderr.includes('Received undefined')
      ? 'D4B-003 REGRESSION: main-entry guard threw TypeError on undefined process.argv[1] — the `process.argv[1] &&` short-circuit is missing'
      : 'apply-finding-migration import failed';
    assert.fail(
      `${tag}\n` +
        `  exit: ${result.status}\n` +
        `  stdout: ${result.stdout}\n` +
        `  stderr: ${result.stderr}`,
    );
  }
  assert.match(result.stdout, /GUARD_OK/);
});

test('apply-finding-migration: main-entry block still runs when invoked as a script (D4B-003 counter-test)', () => {
  // Sanity check: the fix preserves normal-invocation behavior. With no
  // manifest and no --check flag, parseArgs accepts; the missing-manifest
  // path exits 1 with a message naming the manifest path. The exact text
  // is not load-bearing — we just want non-zero exit + non-empty stderr,
  // proving main() actually ran.
  const result = spawnSync(
    process.execPath,
    [targetScript, '/nonexistent/manifest-that-does-not-exist.json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.notEqual(
    result.status,
    0,
    'main-entry block should have run and exited non-zero on missing manifest',
  );
  assert.ok(
    (result.stderr ?? '').length > 0 || (result.stdout ?? '').length > 0,
    'main() should have produced output on the missing-manifest path',
  );
});

test('apply-finding-migration: guard line uses the canonical `process.argv[1] &&` short-circuit (D4B-003 structural pin)', () => {
  // Structural assertion: the fix must use the same idiom as sibling scripts
  // (sync-version.mjs:167, check-finding-regression-pins.mjs:285, the
  // current canonical at check-doc-drift.mjs:994). Pinning the literal
  // ensures a future hand-edit that drops the short-circuit re-introduces
  // the regression and fails this test before CI ships it. We accept both
  // operand orders around `===` since sibling scripts split — sync-version
  // and check-finding-regression-pins write `pathToFileURL(...) === import.meta.url`
  // while apply-finding-migration's prior shape was the reverse. The
  // load-bearing assertion is the `process.argv[1] && ...` short-circuit
  // immediately followed by a `pathToFileURL(process.argv[1])` comparison
  // against `import.meta.url`.
  const src = readFileSync(targetScript, 'utf8');
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped
    .split(/\r?\n/)
    .find((l) => /^\s*if\s*\(.*process\.argv\[1\]/.test(l) && l.includes('pathToFileURL'));
  assert.ok(
    guardLine,
    `expected an executable line in scripts/apply-finding-migration.mjs that begins 'if (...process.argv[1]' and references pathToFileURL — found none`,
  );
  assert.match(
    guardLine,
    /process\.argv\[1\]\s*&&/,
    'main-entry guard must short-circuit on `process.argv[1] &&` before calling pathToFileURL(process.argv[1])',
  );
  assert.match(
    guardLine,
    /pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url|import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href/,
    'main-entry guard must compare pathToFileURL(process.argv[1]).href against import.meta.url',
  );
});
