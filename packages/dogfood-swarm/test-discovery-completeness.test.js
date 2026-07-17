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
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
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

function walkTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkTestFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.test.js')) {
      out.push(relative(PKG_ROOT, join(dir, entry.name)).split(sep).join('/'));
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
