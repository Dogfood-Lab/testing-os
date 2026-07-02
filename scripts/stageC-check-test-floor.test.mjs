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
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, relative } from 'node:path';
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

// ─────────────────────────────────────────────────────────────────────────────
// F-8125c01b: file-level discovery sweep. PB-CI-004 above asserts every
// publishable workspace HAS a non-vacuous test script, but nothing asserted
// every committed *.test.* FILE is actually matched by some runner. That gap
// is the root cause behind the TESTS-001/002/003 class: a test file landing
// outside its runner's glob (a findings/ file outside the old enumeration,
// the orphaned dogfood/ and site/ tests) is a file-level silent skip —
// invisible to the script-level floor, green forever. The sweep walks the
// repo, and every test file must be covered by its owning package's test
// script, by the root test:scripts globs, or by an explicit
// allowlist-with-reason (scripts/test-floor-allowlist.json — the
// regression-pin-allowlist discipline).
// ─────────────────────────────────────────────────────────────────────────────

const TEST_FILE_RE = /\.test\.(?:js|mjs|cjs|ts|tsx)$/;
// Directory names never walked: generated/vendored trees, plus swarm run
// artifacts (swarms/ can hold agent worktrees — full repo copies whose test
// files are counted in their own checkouts, not this one).
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.cache',
  '__test_root__', 'swarms', '.dogfood-worktrees',
]);

function collectTestFiles(root) {
  const out = [];
  (function visit(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile() && TEST_FILE_RE.test(e.name)) {
        out.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  })(root);
  return out.sort();
}

/** Convert a test-script glob ('*.test.js', 'lib/*.test.js', 'a/**' ) to a path regex. */
function globToRe(glob) {
  // Swap the stars for NUL-delimited placeholders BEFORE regex-escaping so
  // the escape pass cannot touch them (NUL never appears in a script glob).
  const DS = '\u0000D\u0000'; // **
  const SS = '\u0000S\u0000'; // *
  let p = glob.replace(/\*\*/g, DS).replace(/\*/g, SS);
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  p = p.replace(new RegExp(DS, 'g'), '.*').replace(new RegExp(SS, 'g'), '[^/]*');
  return new RegExp(`^${p}$`);
}

/** Extract the quoted glob arguments of a `node --test "g1" "g2"` script. */
function quotedGlobs(script) {
  return [...script.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
}

/** Does this package-level test script run `relInPkg`? */
function scriptCoversFile(script, relInPkg) {
  if (typeof script !== 'string' || script.trim().length === 0) return false;
  // vitest discovers *.test.* under the package (schemas). Treat as full coverage.
  if (/\bvitest\b/.test(script)) return true;
  if (/\bnode\s+--test\b/.test(script)) {
    const globs = quotedGlobs(script);
    // Bare `node --test` (no path args) = recursive discovery from the
    // package root on Node >= 22 (this repo's engines floor) — full coverage.
    if (globs.length === 0) return true;
    return globs.some((g) => globToRe(g).test(relInPkg));
  }
  return false;
}

/**
 * The sweep. Pure over a root dir so the META test below can prove it FIRES
 * on a synthetic orphan — a sweep only ever run against a currently-clean
 * tree would itself be the vacuous-gate class it exists to close.
 */
function findUncoveredTests(root) {
  const allowlistPath = join(root, 'scripts/test-floor-allowlist.json');
  const allowlist = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, 'utf8')).entries ?? []
    : [];
  const allowed = new Map(allowlist.map((e) => [e.path, e.reason]));
  const rootPkg = readPkg(root) ?? {};
  const rootScriptGlobs = quotedGlobs((rootPkg.scripts ?? {})['test:scripts'] ?? '');

  const problems = [];
  for (const [p, reason] of allowed) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      problems.push({ file: p, why: 'allowlist entry has no reason — the allowlist discipline requires one' });
    }
    if (!existsSync(join(root, p))) {
      problems.push({ file: p, why: 'allowlist entry points at a file that no longer exists — remove the stale entry' });
    }
  }

  for (const rel of collectTestFiles(root)) {
    if (allowed.has(rel)) continue;
    const pkgMatch = /^packages\/([^/]+)\/(.+)$/.exec(rel);
    if (pkgMatch) {
      const pkg = readPkg(join(root, 'packages', pkgMatch[1]));
      const script = pkg?.scripts?.test;
      if (!scriptCoversFile(script ?? '', pkgMatch[2])) {
        problems.push({
          file: rel,
          why: `not matched by packages/${pkgMatch[1]}'s test script (${JSON.stringify(script ?? '<none>')}) — this file NEVER RUNS`,
        });
      }
      continue;
    }
    if (!rootScriptGlobs.some((g) => globToRe(g).test(rel))) {
      problems.push({
        file: rel,
        why: `not matched by any root test:scripts glob (${rootScriptGlobs.join(', ') || '<none>'}) — this file NEVER RUNS`,
      });
    }
  }
  return problems;
}

test('F-8125c01b: every committed test file is matched by a runner (no file-level silent skips)', () => {
  const problems = findUncoveredTests(repoRoot);
  assert.deepEqual(
    problems,
    [],
    `orphaned test files detected — each one is committed but NEVER RUNS:\n` +
      problems.map((p) => `  ${p.file}: ${p.why}`).join('\n') +
      `\nFix: widen the owning package's test script glob, add the file to test:scripts, or add an allowlist-with-reason entry to scripts/test-floor-allowlist.json.`,
  );
});

test('F-8125c01b META: the sweep FIRES on a synthetic orphaned test file (the sweep itself is non-vacuous)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0',
    scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/covered.test.mjs'), '');
  // Orphan 1: outside every root glob.
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'tools/orphan.test.mjs'), '');
  // Orphan 2: inside a package whose glob only matches the root level.
  mkdirSync(join(dir, 'packages/thing/deep'), { recursive: true });
  writeFileSync(join(dir, 'packages/thing/package.json'), JSON.stringify({
    name: 'thing', version: '1.0.0', scripts: { test: 'node --test "*.test.js"' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/thing/shallow.test.js'), '');
  writeFileSync(join(dir, 'packages/thing/deep/buried.test.js'), '');

  const problems = findUncoveredTests(dir);
  const files = problems.map((p) => p.file).sort();
  assert.deepEqual(
    files,
    ['packages/thing/deep/buried.test.js', 'tools/orphan.test.mjs'],
    `the sweep must flag exactly the two orphans (covered.test.mjs and shallow.test.js are matched): ${JSON.stringify(problems)}`,
  );
});

test('F-8125c01b META: a bare `node --test` package script covers nested test files (recursive discovery, no false positives)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-bare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/bare/lib/deep'), { recursive: true });
  writeFileSync(join(dir, 'packages/bare/package.json'), JSON.stringify({
    name: 'bare', version: '1.0.0', scripts: { test: 'node --test' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/bare/lib/deep/nested.test.js'), '');
  assert.deepEqual(findUncoveredTests(dir), [], 'bare `node --test` discovers recursively on Node >= 22 — nested files are covered');
});

test('F-8125c01b META: allowlist entries need a reason and a live path (no allowlist rot)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-allow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/test-floor-allowlist.json'), JSON.stringify({
    entries: [
      { path: 'tools/gone.test.mjs', reason: 'kept as a fixture' },   // stale path
      { path: 'tools/here.test.mjs', reason: '' },                     // empty reason
    ],
  }, null, 2));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'tools/here.test.mjs'), '');
  const problems = findUncoveredTests(dir);
  assert.ok(problems.some((p) => /no longer exists/.test(p.why)), `stale allowlist path must be flagged: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => /no reason/.test(p.why)), `empty allowlist reason must be flagged: ${JSON.stringify(problems)}`);
});
