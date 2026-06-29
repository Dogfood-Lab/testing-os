/**
 * Stage C amend-wave non-vacuity floor for the workspace test suite
 * (PB-CI-004).
 *
 * Why this file exists:
 *
 * Root `npm test` fans out via `npm test --workspaces --if-present`. The
 * `--if-present` flag silently skips any workspace lacking a `test` script —
 * which means if a publishable package's `test` script were ever dropped (a
 * bad merge, a botched package.json edit), the root suite would still exit 0
 * with that package's tests never running. The suite would pass VACUOUSLY for
 * that package. That is the "a failure must never be reported as success"
 * humanization failure at the suite level: zero matched tests is not a pass.
 *
 * This guard is the test: it asserts every PUBLISHABLE workspace (the 6
 * non-private @dogfood-lab/* packages that release.yml ships) declares a
 * non-empty, non-skip `test` script. It fails loudly — naming the offending
 * package — if any publishable workspace would be silently skipped by
 * `--if-present`.
 *
 * Mirrors the repo's existing META-test discipline (check-package-deps-hygiene,
 * stageA-check-ci-honesty-paths): walk the real packages/ tree, assert an
 * invariant, name the offender on failure.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const packagesDir = resolve(repoRoot, 'packages');

function readPkg(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** The publishable workspaces are the non-private @dogfood-lab/* packages. */
function publishablePackages() {
  const out = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const pkg = readPkg(dir);
    if (!pkg) continue;
    if (pkg.private === true) continue;
    out.push({ dir: entry.name, name: pkg.name, pkg });
  }
  return out;
}

test('PB-CI-004: at least one publishable workspace exists (the floor itself is non-vacuous)', () => {
  const pkgs = publishablePackages();
  assert.ok(
    pkgs.length >= 6,
    `expected >=6 publishable @dogfood-lab/* packages (lockstep), found ${pkgs.length}: ${pkgs.map((p) => p.name).join(', ')}`,
  );
});

test('PB-CI-004: every publishable workspace declares a non-skip test script (suite cannot pass vacuously via --if-present)', () => {
  for (const { dir, name, pkg } of publishablePackages()) {
    const script = pkg.scripts && pkg.scripts.test;
    assert.ok(
      typeof script === 'string' && script.trim().length > 0,
      `publishable workspace ${name} (packages/${dir}) has no \`test\` script — \`npm test --workspaces --if-present\` would SILENTLY skip it and the root suite would pass vacuously for this package (PB-CI-004). Add a real \`node --test\` (or vitest) script.`,
    );
    // A test script that is a no-op (e.g. `exit 0`, `true`, or the npm default
    // "Error: no test specified" placeholder) defeats the floor. Reject the
    // known vacuous shapes.
    const vacuous = /^(exit 0|true|:|echo[^&|]*&&\s*exit 0)\s*$/.test(script.trim())
      || /no test specified/i.test(script);
    assert.ok(
      !vacuous,
      `publishable workspace ${name} (packages/${dir}) has a vacuous test script (${JSON.stringify(script)}) — a no-op test script reports success without running any test (PB-CI-004).`,
    );
  }
});

test('PB-CI-004: root test script fans out across workspaces (the floor is wired to the real suite)', () => {
  const root = readPkg(repoRoot);
  assert.ok(root && root.scripts, 'root package.json must have scripts');
  assert.match(
    root.scripts.test || '',
    /--workspaces/,
    'root `test` script must fan out across workspaces (`npm test --workspaces ...`) so the per-package test floor is actually exercised (PB-CI-004).',
  );
});
