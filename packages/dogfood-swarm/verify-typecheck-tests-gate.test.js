/**
 * verify-typecheck-tests-gate.test.js — ve-tc-001.
 *
 * RED-PROOF for the swarm-verify typecheck:tests gap (ai-rpg-engine v2.8
 * incident, 2026-07-22). The node verify adapter ran `npx tsc --noEmit` (the
 * ROOT tsconfig, which by convention EXCLUDES test files) but NOT the repo's
 * own `typecheck:tests` script — so a TS error confined to a *.test.ts passed
 * `swarm verify` clean: `npm test` (vitest) strips types, and the generic
 * typecheck never saw the test file. A real TS2345 in a new formulas.test.ts
 * shipped green, caught only because a concurrent session happened to run the
 * repo's own `typecheck:tests`.
 *
 * The fix (lib/verify/adapters/node.js): the probe detects a `typecheck:tests`
 * npm script (evidence.hasTypecheckTests) and commands() promotes it into a
 * REQUIRED step — so a repo that declares its test-file type gate gets it run
 * by the deterministic floor, and a failing test-file typecheck now blocks the
 * wave. "Optional-if-absent": a repo with no such script gets no such step, so
 * requiring it can never false-fail a JS-only or single-tsconfig repo.
 *
 * Proof, three altitudes:
 *   1. commands(): the step is script-detected AND REQUIRED (the two
 *      properties the gate depends on), and ABSENT when the repo declares no
 *      such script (why requiring it is safe).
 *   2. adapter.run(): the SAME fixture (a broken typecheck:tests + green
 *      tests) run through the PRE-FIX step list passes, and through the real
 *      post-fix adapter FAILS — the exact "would have passed before, fails
 *      after" A/B. `verdict: 'fail'` is what cli.js's cmdVerify (cli-p-002)
 *      turns into a non-zero exit, i.e. `swarm verify` failing.
 *
 * Hermetic by construction: the fixture's scripts are `node -e` one-liners
 * (no tsc, no network). The gap under test is the adapter's STEP LIST, not
 * tsc — so a deterministic failing `typecheck:tests` script proves the floor
 * now RUNS the repo's test-type gate and BLOCKS on its failure, which is the
 * whole finding. The default `typecheck` step (`npx tsc --noEmit`) is
 * overridden to an in-process no-op wherever the adapter is driven, to keep
 * the subprocess off the network (mirrors meta-amendB-operator-output.test.js's
 * SAFE_OPTIONAL_OVERRIDES); the step UNDER TEST — typecheck:tests — is never
 * overridden, it is discovered from the fixture's own package.json.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeAdapter } from './lib/verify/adapters/node.js';
import { runSteps } from './lib/verify/runner.js';

// The bare `node` + the inner quotes are load-bearing under runStep's
// `shell: true`, which joins cmd+args into ONE string for the shell — the
// exact reasoning meta-amendB-operator-output.test.js documents for its own
// no-op overrides. Neutralizes the default `npx tsc --noEmit` typecheck step
// so the fixtures never shell out to npx (which could hang or fetch on a CI
// host). Optional, so it never affects the verdict either way.
const SAFE_NOOP_TYPECHECK = { name: 'typecheck', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true };

/**
 * A synthetic Node repo. With `withGate`, it declares a `typecheck:tests`
 * script that FAILS (simulating `tsc -p tsconfig.tests.json` finding a TS2345
 * in a test file) — exit 2 is tsc's "type errors found" code, and the message
 * mirrors the real ai-rpg-engine incident so a persisted receipt reads
 * authentically. Its `test` script is always GREEN and emits a node --test TAP
 * summary at line start, because the incident was a test-file TYPE error, not
 * a runtime test failure — the runner must measure a real passing test so the
 * verdict is a genuine `pass`, not a `no_tests` downgrade.
 */
function makeRepo(parent, { withGate }) {
  const dir = mkdtempSync(join(parent, withGate ? 'tc-gate-' : 'tc-none-'));
  const scripts = {
    test: `node -e "console.log('# tests 1'); console.log('# pass 1')"`,
  };
  if (withGate) {
    scripts['typecheck:tests'] =
      `node -e "console.error('src/systems/formulas.test.ts(12,20): error TS2345: Argument of type (a: number, b: number) => number is not assignable to parameter of type FormulaFn'); process.exit(2)"`;
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `fixture-tc-${withGate ? 'gate' : 'none'}`, version: '0.0.0', scripts }, null, 2),
    'utf-8',
  );
  return dir;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. commands() — script-detected + REQUIRED (the two load-bearing props)
// ═══════════════════════════════════════════════════════════════════════

describe('ve-tc-001 — node adapter commands(): typecheck:tests is script-detected and required', () => {
  it('adds a REQUIRED typecheck:tests step when the repo declares the script', () => {
    const steps = nodeAdapter.commands({}, { hasTypecheckTests: true });
    const tc = steps.find((s) => s.name === 'typecheck:tests');
    assert.ok(tc, 'the typecheck:tests step must be present when the repo declares the script');
    assert.ok(!tc.optional, 'it must be REQUIRED (not optional) — a required failure is what flips the verdict to fail');
    assert.equal(tc.cmd, 'npm');
    assert.deepEqual(tc.args, ['run', 'typecheck:tests']);
    // Ordered right after the generic src typecheck, before test/build.
    assert.deepEqual(steps.map((s) => s.name), ['lint', 'typecheck', 'typecheck:tests', 'test', 'build']);
  });

  it('optional-if-absent: NO typecheck:tests step when the repo declares no such script', () => {
    const steps = nodeAdapter.commands({}, {});
    assert.equal(steps.find((s) => s.name === 'typecheck:tests'), undefined,
      'a repo without the script gets no step — this is why requiring it can never false-fail such a repo');
    // The pre-existing steps are untouched (additive-only): same four, same order.
    assert.deepEqual(steps.map((s) => s.name), ['lint', 'typecheck', 'test', 'build']);
  });

  it('an explicit override forces the step even without detection, and wins over the default', () => {
    const custom = { name: 'typecheck:tests', cmd: 'npm', args: ['run', 'tc'] };
    const steps = nodeAdapter.commands({ 'typecheck:tests': custom }, {});
    assert.equal(steps.find((s) => s.name === 'typecheck:tests'), custom);
  });

  it('backward-compatible: commands() with no evidence arg still yields the pre-fix default steps', () => {
    const steps = nodeAdapter.commands();
    assert.deepEqual(steps.map((s) => s.name), ['lint', 'typecheck', 'test', 'build']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. adapter.run() — the gate FIRES: same fixture, pre-fix passes / post-fix fails
// ═══════════════════════════════════════════════════════════════════════

describe('ve-tc-001 — the gate fires: a test-file type error now FAILS swarm verify', () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), 've-tc-run-')); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('RED→GREEN: the SAME broken repo passes the PRE-FIX step list but FAILS the fixed adapter', () => {
    const repo = makeRepo(root, { withGate: true });

    // The pre-fix node-adapter step list: exactly lint/typecheck/test/build,
    // no typecheck:tests. This is what shipped the ai-rpg-engine false green.
    const preFixSteps = [
      { name: 'lint', cmd: 'npm', args: ['run', 'lint', '--if-present'], optional: true },
      SAFE_NOOP_TYPECHECK,
      { name: 'test', cmd: 'npm', args: ['test', '--if-present'] },
      { name: 'build', cmd: 'npm', args: ['run', 'build', '--if-present'], optional: true },
    ];
    const preFix = runSteps(repo, preFixSteps, { continueOnError: true });
    assert.equal(preFix.verdict, 'pass',
      'PRE-FIX: the broken typecheck:tests is never run — the test-file type error is invisible (the false green the incident shipped)');
    assert.equal(preFix.steps.find((s) => s.name === 'typecheck:tests'), undefined,
      'sanity: the pre-fix list has no typecheck:tests step at all');

    // Post-fix: the real adapter discovers typecheck:tests from package.json
    // and runs it as a required step.
    const postFix = nodeAdapter.run(repo, { typecheck: SAFE_NOOP_TYPECHECK });
    assert.equal(postFix.verdict, 'fail',
      'POST-FIX: the same repo now FAILS — cli.js cmdVerify (cli-p-002) turns any non-pass verdict into a non-zero exit, i.e. swarm verify fails');
    const tc = postFix.steps.find((s) => s.name === 'typecheck:tests');
    assert.ok(tc, 'the gate step ran');
    assert.equal(tc.passed, false, 'the test-file type error was caught');
    assert.ok(!tc.optional, 'the gate is REQUIRED — that is what flipped the verdict');
  });

  it('a repo whose typecheck:tests passes still verifies clean (no false-fail from the new gate)', () => {
    // Same shape, but the test-type gate is GREEN.
    const dir = mkdtempSync(join(root, 'tc-green-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-tc-green',
        version: '0.0.0',
        scripts: {
          test: `node -e "console.log('# tests 1'); console.log('# pass 1')"`,
          'typecheck:tests': `node -e "process.exit(0)"`,
        },
      }, null, 2),
      'utf-8',
    );
    const result = nodeAdapter.run(dir, { typecheck: SAFE_NOOP_TYPECHECK });
    assert.equal(result.verdict, 'pass');
    const tc = result.steps.find((s) => s.name === 'typecheck:tests');
    assert.ok(tc && tc.passed, 'the gate ran and passed');
  });

  it('a repo with NO typecheck:tests script verifies exactly as before (optional-if-absent)', () => {
    const repo = makeRepo(root, { withGate: false });
    const result = nodeAdapter.run(repo, { typecheck: SAFE_NOOP_TYPECHECK });
    assert.equal(result.verdict, 'pass',
      'no test-type gate declared → nothing added → the floor has nothing to say, and does not block');
    assert.equal(result.steps.find((s) => s.name === 'typecheck:tests'), undefined,
      'no gate step is invented for a repo that never declared one');
  });
});
