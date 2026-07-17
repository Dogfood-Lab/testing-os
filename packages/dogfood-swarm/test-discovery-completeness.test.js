/**
 * test-discovery-completeness.test.js — F-6a5eb347: a test file this package's
 * own `npm test` cannot see is not a test, and nothing said so out loud.
 *
 * THE DEFECT. This package's test script is a non-recursive, two-shape glob:
 *
 *     node --test "*.test.js" "lib/*.test.js"
 *
 * Exactly the package root, and exactly one level under `lib/`. A `.test.js`
 * anywhere else — `commands/`, `db/`, or any nested `lib/` subdirectory — is
 * **silently invisible**: not skipped, not reported as zero-matched, simply
 * never executed. And `lib/case-file/`, `lib/verify/`, `lib/queries/` are all
 * real production subdirectories in this same package, so the natural place to
 * put a test for `lib/verify/runner.js` is precisely a place that would never
 * run. That script is wired into `npm run verify` through the root workspace
 * fan-out, so it is every CI run and every publish.
 *
 * The constraint was real, known, and enforced by NOTHING: it was disclosed
 * twice, in prose, in files that a contributor adding a test would have no
 * reason to open. Wave 29 had to keep four of its own new test files flat to
 * dodge it — the convention was being obeyed by people who happened to know,
 * which is the definition of a rule that will be broken by someone who doesn't.
 *
 * WHY THIS GATE AND NOT A WIDER GLOB. The finding offered both. `**\/*.test.js`
 * would collect exactly the same 180 files today (verified: 0 matches inside
 * node_modules, because this package's deps hoist to the root) and would let
 * tests live beside their code — genuinely the nicer shape. It was NOT taken,
 * deliberately: "safe today because the directory happens to be absent" is the
 * exact reasoning that let the dead `test:vitest` script (F-3af2f9c8) walk into
 * stale `.swarm/worktrees` copies, and a recursive glob whose safety depends on
 * npm's hoisting choice is a hazard waiting for an install topology to change.
 * Widening deserves its own dispatch, with a node_modules exclusion proven
 * rather than assumed. This gate closes the defect's actual harm — an invisible
 * test — without betting on that.
 *
 * WHAT IT DOES NOT DO, stated plainly: it enforces the flat convention rather
 * than removing it. A contributor who wants `lib/verify/runner.test.js` is still
 * told no; they are just told LOUDLY, at test time, instead of discovering it
 * months later when the test they wrote turns out to have never run once.
 *
 * SYMLINK FOLLOWING (F-93c87a69). `readdirSync(dir, {withFileTypes:true})`
 * reports a Windows junction's dirent as `isDirectory() === false` and
 * `isSymbolicLink() === true` (verified empirically) — a walk that recurses
 * only on `isDirectory()` never enters a symlinked/junctioned subdirectory,
 * so a `.test.js` living inside one would be invisible to BOTH `npm test`'s
 * glob (the original F-6a5eb347 defect) AND this gate. `walkTestFiles` below
 * resolves the dirent's target explicitly (`realpathSync` + `statSync`) and
 * recurses into it when it is a directory, with a visited-realpath guard
 * against a symlink cycle. Not reachable today — zero symlinks exist
 * anywhere under this package's tracked tree — but future-proofed the same
 * way this repo has calibrated other real-but-currently-unreachable gaps
 * (e.g. F-89b7dcd5, F-937733ee).
 */

import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Directories the package's own test run can never reach, and which must not be
 * mistaken for source. `.swarm` is the load-bearing one: isolated waves create
 * FULL repo checkouts under `.swarm/worktrees/`, so walking into it would find
 * every test file in the repo N times over and report phantom violations that
 * vanish after `swarm clean`. That is the same trap F-3af2f9c8 documented.
 */
const SKIP_DIRS = new Set(['node_modules', '.swarm', '.git', 'dist', 'coverage']);

/** The two shapes `node --test "*.test.js" "lib/*.test.js"` actually collects. */
function isCollectedByTestScript(relPath) {
  const parts = relPath.split('/');
  if (parts.length === 1) return true;
  return parts.length === 2 && parts[0] === 'lib';
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {Set<string>} seenRealDirs — realpath-canonicalized dirs already
 *   recursed into via a symlink, so a cycle (including a symlink pointing
 *   at an ancestor of itself) terminates instead of looping forever. Only
 *   symlink targets are tracked here — plain directory recursion below
 *   cannot cycle on its own, since a real filesystem tree has no loops.
 */
function walkTestFiles(dir, out = [], seenRealDirs = new Set()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue; // by name, regardless of dirent kind — see below
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestFiles(full, out, seenRealDirs);
    } else if (entry.isSymbolicLink()) {
      // F-93c87a69: a junction/symlink reports isDirectory()===false here, so
      // the target must be resolved explicitly rather than trusted from the
      // dirent. The upfront SKIP_DIRS check above (not gated on isDirectory())
      // matters concretely for this case: every wave worktree junctions its
      // OWN node_modules at the worktree root, and following a same-named
      // junction blindly would walk that entire dependency tree.
      let real;
      try {
        real = realpathSync(full);
      } catch {
        continue; // dangling symlink target; nothing to walk
      }
      if (seenRealDirs.has(real)) continue; // cycle guard
      let targetStat;
      try {
        targetStat = statSync(real);
      } catch {
        continue; // target vanished between readdir and stat; nothing to walk
      }
      if (targetStat.isDirectory()) {
        seenRealDirs.add(real);
        walkTestFiles(real, out, seenRealDirs);
      } else if (entry.name.endsWith('.test.js')) {
        out.push(relative(PKG_ROOT, full).split(sep).join('/'));
      }
    } else if (entry.name.endsWith('.test.js')) {
      out.push(relative(PKG_ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

describe('every .test.js in this package is actually reachable by `npm test` (F-6a5eb347)', () => {
  it('no test file sits outside the two shapes the test script collects', () => {
    const all = walkTestFiles(PKG_ROOT);

    // Non-vacuity: a walk that finds nothing would pass this gate while proving
    // nothing at all — the exact shape of the vacuous check this repo keeps
    // paying for. This file itself is at the root, so the floor is never zero.
    assert.ok(all.length > 50,
      `fixture sanity: the walk must actually find this package's tests (found ${all.length})`);
    assert.ok(all.includes('test-discovery-completeness.test.js'),
      'fixture sanity: the walk must find THIS file, or it is not walking what it thinks it is');

    const invisible = all.filter((f) => !isCollectedByTestScript(f));
    assert.deepEqual(invisible, [],
      'these .test.js files are INVISIBLE to `node --test "*.test.js" "lib/*.test.js"` — '
        + 'they will never run, in CI or locally, and their green is meaningless:\n'
        + invisible.map((f) => `  ${f}`).join('\n')
        + '\nMove them to the package root or one level under lib/, or widen the test '
        + 'script (see this file\'s docstring for why that was not done here).');
  });

  it('the gate can actually fire — the shape rule rejects a nested path (non-vacuity)', () => {
    // If isCollectedByTestScript ever returns true for everything, the
    // assertion above becomes theater. Pin the classifier directly against the
    // real production subdirectories that make this defect reachable.
    assert.equal(isCollectedByTestScript('foo.test.js'), true, 'root-level must be collected');
    assert.equal(isCollectedByTestScript('lib/foo.test.js'), true, 'one level under lib/ must be collected');
    for (const nested of [
      'commands/foo.test.js',
      'db/foo.test.js',
      'lib/verify/runner.test.js',
      'lib/case-file/adjudicate.test.js',
      'lib/queries/analytics.test.js',
      'commands/lib/escape-reason.test.js',
    ]) {
      assert.equal(isCollectedByTestScript(nested), false,
        `${nested} is NOT collected by the test script and the rule must say so`);
    }
  });
});

describe('walkTestFiles follows symlinked/junctioned directories (F-93c87a69)', () => {
  let scratchRoot;
  let extraTempDirs;

  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'walk-symlink-'));
    extraTempDirs = [];
  });
  afterEach(() => {
    for (const d of extraTempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  /**
   * The walk exactly as it existed before this fix, kept ONLY so the fixture
   * below can prove it is a real discriminator and not a tautology: since
   * `entry.isDirectory()` is false for a junction/symlink on this platform,
   * this reference version never recurses into one, matching F-93c87a69's
   * empirical finding.
   */
  function walkTestFilesPreFix(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walkTestFilesPreFix(join(dir, entry.name), out);
      } else if (entry.name.endsWith('.test.js')) {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  /**
   * Builds a junction inside `scratchRoot` pointing at a `.test.js`-bearing
   * directory that lives in a SEPARATE temp dir, entirely outside the tree
   * being walked. The real target must NOT be reachable by plain recursion
   * from `scratchRoot` — nesting it inside `scratchRoot` as a sibling of the
   * junction would let ordinary (non-symlink) recursion find it directly,
   * masking the exact defect this fixture exists to isolate (a file visible
   * ONLY through the symlink).
   */
  function buildJunctionFixture() {
    const realTarget = mkdtempSync(join(tmpdir(), 'walk-symlink-target-'));
    extraTempDirs.push(realTarget);
    const nestedTest = join(realTarget, 'nested.test.js');
    writeFileSync(nestedTest, '// fixture only — never executed as a real test\n');
    const linkPath = join(scratchRoot, 'linked-dir');
    symlinkSync(realTarget, linkPath, 'junction');
    return { realTarget, nestedTest, linkPath };
  }

  it('RED (pre-fix reference): a .test.js inside a junctioned dir is invisible to the OLD walk', () => {
    const { nestedTest } = buildJunctionFixture();

    // Fixture sanity: the file genuinely exists on disk before asking whether
    // any walk can see it through the junction.
    assert.ok(existsSync(nestedTest), 'fixture setup: the nested test file must exist');

    const found = walkTestFilesPreFix(scratchRoot);
    assert.ok(!found.includes(nestedTest),
      'fixture sanity: the PRE-FIX walk must NOT see the file through the junction — '
        + 'if it does, this fixture no longer exercises F-93c87a69 and the GREEN test below is vacuous');
  });

  it('GREEN: the current walk follows the junction and reports the nested test file', () => {
    buildJunctionFixture();

    const found = walkTestFiles(scratchRoot);
    assert.ok(found.some((p) => p.endsWith('nested.test.js')),
      'the current walk must follow a symlinked/junctioned directory and report the .test.js inside it — '
        + `got: ${JSON.stringify(found)}`);
  });

  it('a symlinked directory that cycles back on an ancestor does not hang the walk', () => {
    // Non-vacuity note: if the cycle guard ever regresses to unbounded
    // recursion, this call hangs or stack-overflows rather than failing an
    // assertion — completing at all, within node's default test timeout, IS
    // the proof the guard fired.
    symlinkSync(scratchRoot, join(scratchRoot, 'self-link'), 'junction');
    const found = walkTestFiles(scratchRoot);
    assert.ok(Array.isArray(found));
  });
});
