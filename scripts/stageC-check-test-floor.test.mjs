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

/**
 * A test script that is a no-op or coverage-defeating shape (e.g. `exit 0`,
 * `true`, the npm default "Error: no test specified" placeholder) defeats the
 * floor. F-02b2ec03: `--passWithNoTests` (removed by F-cc9f0603 — a zero-test
 * vitest run reports success) and a bare `echo ...` with no runner after it
 * are rejected alongside the original shapes so neither can silently return.
 */
function isVacuousTestScript(script) {
  return /^(exit 0|true|:|echo\b[^&|;]*(?:&&\s*exit 0)?)\s*$/.test(script.trim())
    || /no test specified/i.test(script)
    || /--passWithNoTests\b/.test(script);
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
    assert.ok(
      !isVacuousTestScript(script),
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

// F-113b0115: include `.spec.` — the other standard naming convention (and
// part of this repo's swarm-domain ownership globs). A spec file invisible to
// the sweep recreates the file-level silent-skip class one convention over.
const TEST_FILE_RE = /\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx)$/;
// What a bare `node --test` ACTUALLY discovers on Node >= 22: .test.{js,mjs,cjs}
// files anywhere, plus runnable-extension files under a directory named test/.
// NOT .ts/.tsx (no transpiler) and NOT .spec. naming — claiming those covered
// is the F-4d5e0db4 / F-113b0115 over-claim.
const NODE_BARE_DISCOVERY_RE = /(?:\.test\.(?:js|mjs|cjs)$)|(?:(?:^|\/)test\/.*\.(?:js|mjs|cjs)$)/;
// Directory names never walked: generated/vendored trees, plus swarm run
// artifacts (agent worktrees are full repo copies whose test files are counted
// in their own checkouts, not this one).
//
// `.swarm` is where the control plane actually creates `--isolate` worktrees
// today (see dogfood-swarm's `clean` verb and its .gitignore fixture); the
// older `swarms` / `.dogfood-worktrees` names are kept so a tree carrying
// either layout still sweeps clean. Omitting `.swarm` made every stranded
// worktree's test files read as orphans — one bogus entry per test file per
// worktree, drowning a real orphan in thousands of false ones. That is this
// gate lying by the same mechanism it exists to catch, so the skip-list has to
// track the directory name whenever it moves.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.cache',
  '__test_root__', '.swarm', 'swarms', '.dogfood-worktrees',
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

/**
 * Extract the path/glob arguments of a `node --test ...` invocation — quoted
 * OR unquoted. F-654a84e6/F-789ca80f: quoted-only extraction made an unquoted
 * `node --test cli.test.js` read as zero args = bare recursive discovery,
 * silently claiming full-package coverage for a script that runs exactly one
 * file. `--flags` are skipped; a trailing-slash directory arg is treated as
 * the recursive discovery Node performs inside it (`dir/**`).
 */
function nodeTestPathArgs(script) {
  const m = /\bnode\s+--test\b([^|&;]*)/.exec(script);
  if (!m) return [];
  const args = [];
  for (const t of m[1].matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    const tok = t[1] ?? t[2] ?? t[3];
    if (tok.startsWith('-')) continue;
    args.push(tok.endsWith('/') ? `${tok}**` : tok);
  }
  return args;
}

/** vitest config files that can narrow the default discovery `include`. */
function vitestConfigFiles(pkgDir) {
  return [
    'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
    'vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts',
    'vitest.workspace.js', 'vitest.workspace.ts',
  ].filter((n) => existsSync(join(pkgDir, n)));
}

/** Does this package-level test script run `relInPkg`? */
function scriptCoversFile(script, relInPkg, pkgDir) {
  if (typeof script !== 'string' || script.trim().length === 0) return false;
  if (/\bvitest\b/.test(script)) {
    // vitest's DEFAULT include discovers *.{test,spec}.* under the package
    // (schemas). F-4d5e0db4: fail CLOSED on the two coverage-defeating shapes
    // — a re-added --passWithNoTests, and a committed vitest config that can
    // narrow `include` below the default glob (none exists today; if one
    // lands, the sweep flags the package's test files and forces an explicit
    // review/allowlist instead of silently trusting the default).
    if (/--passWithNoTests\b/.test(script)) return false;
    if (pkgDir && vitestConfigFiles(pkgDir).length > 0) return false;
    return true;
  }
  if (/\bnode\s+--test\b/.test(script)) {
    const globs = nodeTestPathArgs(script);
    // Bare `node --test` (no path args) = recursive discovery from the
    // package root on Node >= 22 (this repo's engines floor) — but only for
    // the shapes Node's runner actually discovers. A .test.ts or .spec.* file
    // in a node-runner package NEVER RUNS (F-4d5e0db4 / F-113b0115).
    if (globs.length === 0) return NODE_BARE_DISCOVERY_RE.test(relInPkg);
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
  const rootScriptGlobs = nodeTestPathArgs((rootPkg.scripts ?? {})['test:scripts'] ?? '');

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
      if (!scriptCoversFile(script ?? '', pkgMatch[2], join(root, 'packages', pkgMatch[1]))) {
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

// ─────────────────────────────────────────────────────────────────────────────
// F-654a84e6 / F-789ca80f: scriptCoversFile must not treat a `node --test`
// script with UNQUOTED positional args as bare recursive discovery. Quoted-only
// extraction made `node --test cli.test.js` read as full-package coverage when
// it runs exactly one file — the sweep's central claim silently inverted.
// ─────────────────────────────────────────────────────────────────────────────

test('F-654a84e6/F-789ca80f META: an UNQUOTED single-file `node --test cli.test.js` script covers only that file, not the whole package', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-unquoted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/uq/lib'), { recursive: true });
  writeFileSync(join(dir, 'packages/uq/package.json'), JSON.stringify({
    name: 'uq', version: '1.0.0', scripts: { test: 'node --test cli.test.js' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/uq/cli.test.js'), '');
  writeFileSync(join(dir, 'packages/uq/lib/orphan.test.js'), '');
  const files = findUncoveredTests(dir).map((p) => p.file);
  assert.deepEqual(
    files,
    ['packages/uq/lib/orphan.test.js'],
    'the unquoted single-file script runs ONLY cli.test.js — the sibling must be flagged, not silently claimed covered',
  );
});

test('F-654a84e6 META: `node --test lib/` covers files under lib/ but flags a test file outside it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-dirarg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/da/lib'), { recursive: true });
  writeFileSync(join(dir, 'packages/da/package.json'), JSON.stringify({
    name: 'da', version: '1.0.0', scripts: { test: 'node --test lib/' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/da/lib/inside.test.js'), '');
  writeFileSync(join(dir, 'packages/da/outside.test.js'), '');
  const files = findUncoveredTests(dir).map((p) => p.file);
  assert.deepEqual(
    files,
    ['packages/da/outside.test.js'],
    '`node --test lib/` runs only under lib/ — outside.test.js NEVER RUNS and must be flagged',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-4d5e0db4: two coverage over-claims. (1) bare `node --test` cannot execute
// .ts files; (2) any script containing "vitest" was trusted as full recursive
// coverage even with coverage-defeating shapes present.
// ─────────────────────────────────────────────────────────────────────────────

test('F-4d5e0db4 META: a .test.ts file in a bare `node --test` package is flagged (the node runner cannot execute TypeScript)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-ts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/nr'), { recursive: true });
  writeFileSync(join(dir, 'packages/nr/package.json'), JSON.stringify({
    name: 'nr', version: '1.0.0', scripts: { test: 'node --test' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/nr/runs.test.js'), '');
  writeFileSync(join(dir, 'packages/nr/stray.test.ts'), '');
  const files = findUncoveredTests(dir).map((p) => p.file);
  assert.deepEqual(
    files,
    ['packages/nr/stray.test.ts'],
    'bare `node --test` discovers .test.{js,mjs,cjs} only — a .test.ts file NEVER RUNS in a node-runner package',
  );
});

test('F-4d5e0db4 META: a vitest script with --passWithNoTests re-added is NOT trusted as coverage (fail closed)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-pwnt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/vt'), { recursive: true });
  writeFileSync(join(dir, 'packages/vt/package.json'), JSON.stringify({
    name: 'vt', version: '1.0.0', scripts: { test: 'vitest run --passWithNoTests' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/vt/some.test.ts'), '');
  const files = findUncoveredTests(dir).map((p) => p.file);
  assert.deepEqual(
    files,
    ['packages/vt/some.test.ts'],
    'a vitest script carrying --passWithNoTests defeats the floor — coverage must not be trusted (F-4d5e0db4 fail-closed)',
  );
});

test('F-4d5e0db4 META: a vitest package with a committed vitest.config fails closed (include may be narrowed)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-vtcfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/vc'), { recursive: true });
  writeFileSync(join(dir, 'packages/vc/package.json'), JSON.stringify({
    name: 'vc', version: '1.0.0', scripts: { test: 'vitest run' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/vc/vitest.config.ts'), 'export default {};\n');
  writeFileSync(join(dir, 'packages/vc/some.test.ts'), '');
  const files = findUncoveredTests(dir).map((p) => p.file);
  assert.deepEqual(
    files,
    ['packages/vc/some.test.ts'],
    'a vitest.config can narrow `include` below the default discovery glob — the sweep must fail closed and force explicit review/allowlist',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-113b0115: the sweep must SEE `.spec.` files — the other standard naming
// convention. Bare `node --test` does not discover spec naming, so a spec file
// in a node-runner package is an orphan and must be flagged.
// ─────────────────────────────────────────────────────────────────────────────

test('F-113b0115 META: a .spec. file in a bare `node --test` package is visible to the sweep and flagged', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-spec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fx', version: '1.0.0', scripts: { 'test:scripts': 'node --test "scripts/*.test.mjs"' },
  }, null, 2));
  mkdirSync(join(dir, 'packages/sp'), { recursive: true });
  writeFileSync(join(dir, 'packages/sp/package.json'), JSON.stringify({
    name: 'sp', version: '1.0.0', scripts: { test: 'node --test' },
  }, null, 2));
  writeFileSync(join(dir, 'packages/sp/runs.test.js'), '');
  writeFileSync(join(dir, 'packages/sp/orphan.spec.js'), '');
  const files = findUncoveredTests(dir).map((p) => p.file);
  assert.deepEqual(
    files,
    ['packages/sp/orphan.spec.js'],
    'bare `node --test` does not discover .spec. naming — the file NEVER RUNS and must be flagged (F-113b0115)',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-02b2ec03: pin the F-cc9f0603 fix (--passWithNoTests removal) and close the
// bare-echo hole in the vacuous-shape rejection.
// ─────────────────────────────────────────────────────────────────────────────

test('F-02b2ec03: the vacuous-script rejection catches --passWithNoTests and bare echo shapes', () => {
  assert.ok(isVacuousTestScript('vitest run --passWithNoTests'), '--passWithNoTests reports success with zero tests — vacuous');
  assert.ok(isVacuousTestScript('echo ok'), 'a bare echo is a zero-test success script — vacuous');
  assert.ok(isVacuousTestScript('echo hi && exit 0'), 'the original echo-and-exit shape stays rejected');
  assert.ok(isVacuousTestScript('exit 0'), 'original shape stays rejected');
  assert.ok(!isVacuousTestScript('node --test'), 'a real runner is not vacuous');
  assert.ok(!isVacuousTestScript('vitest run'), 'plain vitest run is not vacuous');
  assert.ok(!isVacuousTestScript('echo starting && node --test'), 'an echo FOLLOWED by a real runner is not vacuous');
});

test('F-02b2ec03: no root or workspace script reintroduces --passWithNoTests (pin for the F-cc9f0603 removal)', () => {
  const offenders = [];
  const rootPkg = readPkg(repoRoot) ?? {};
  for (const [k, v] of Object.entries(rootPkg.scripts ?? {})) {
    if (/--passWithNoTests\b/.test(v)) offenders.push(`<root>:${k}`);
  }
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkg = readPkg(join(packagesDir, entry.name));
    for (const [k, v] of Object.entries(pkg?.scripts ?? {})) {
      if (/--passWithNoTests\b/.test(v)) offenders.push(`packages/${entry.name}:${k}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `--passWithNoTests defeats the test floor (a zero-test run reports success) and was removed by F-cc9f0603 — it must not return: ${offenders.join(', ')}`,
  );
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
