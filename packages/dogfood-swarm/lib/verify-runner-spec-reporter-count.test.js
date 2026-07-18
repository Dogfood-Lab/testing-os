/**
 * verify-runner-spec-reporter-count.test.js — extractTestCount must measure
 * the node spec reporter's summary, not only TAP's.
 *
 * No F-id: this is a plain engineered fix (coordinator-relayed hotfix for the
 * CI Node-24 leg, run 29635789922; disclosed in HANDOFF), not a control-plane
 * finding — so no `@pins` tag and no F-id citation exist anywhere for it, by
 * instruction.
 *
 * THE GAP. Node >= 23 made `spec` the DEFAULT `--test-reporter` even when
 * stdout is not a TTY (nodejs/node#54548). The spec summary is a flush-left
 * block of `ℹ tests N` / `ℹ pass N` / `ℹ fail N` lines — none of which
 * matched any pattern in extractTestCount (TAP `^# tests? N`, jest/vitest
 * `Tests[:] N passed`, pytest, cargo). So on Node 24 a plain `node --test`
 * consumer of `swarm verify` produced real output the floor could not
 * measure, and the honest-unmeasured path (correctly) blocked with
 * `unmeasured_tests`. Reproduced live pre-fix on Node 22 by pinning the
 * reporter: a scratch fixture repo whose test script is
 * `node --test --test-reporter=spec` driven through the REAL
 * nodeAdapter.run() path yielded exactly the CI shape — verdict
 * `unmeasured_tests`, "could not measure test count — the test step produced
 * 296 chars of output matching no known runner summary."
 *
 * FIXTURE PROVENANCE. The canned spec output below is captured from a real
 * `node --test --test-reporter=spec` run on this rig (Node v22.22.3, piped
 * stdout, NO_COLOR=1 — the same env runStep pins), not hand-imagined; the
 * summary-line shape is identical to what Node 24's default emits. Canned
 * output through the real runSteps is this package's established pattern for
 * exercising the measurement floor (verify-runner-measure-before-truncate
 * .test.js's echoStep) — the live-child variant was proven once during the
 * fix (transcript in the lane report) and is not re-run here, because a live
 * `npm test` child per test case is slow and this floor's contract is over
 * the STREAM, which the canned fixture pins byte-for-byte.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSteps } from './verify/runner.js';

const CWD = tmpdir();
const fixtureDirs = [];

after(() => {
  for (const d of fixtureDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/**
 * A step that prints `text` verbatim on stdout and exits with `exitCode`.
 * Same file-not-`-e` rationale as verify-runner-measure-before-truncate
 * .test.js's echoStep (shell:true + a space in execPath would split the
 * command; and the fixture must survive shell quoting untouched, which
 * matters here — it contains a non-ASCII glyph).
 */
function echoStep(name, text, { exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-spec-fixture-'));
  fixtureDirs.push(dir);
  const dataFile = join(dir, 'out.txt').replace(/\\/g, '/');
  const emitFile = join(dir, 'emit.cjs').replace(/\\/g, '/');
  writeFileSync(dataFile, text, 'utf-8');
  writeFileSync(
    emitFile,
    `process.stdout.write(require("fs").readFileSync(${JSON.stringify(dataFile)},"utf8"));process.exitCode=${exitCode};`,
    'utf-8',
  );
  return { name, cmd: 'node', args: [emitFile] };
}

// Captured from a real `node --test --test-reporter=spec` run (see header).
const SPEC_PASSING = [
  '✔ top-level passes (0.5902ms)',
  '▶ a suite',
  '  ✔ nested one (0.0941ms)',
  '  ✔ nested two (0.0561ms)',
  '✔ a suite (0.3336ms)',
  'ℹ tests 3',
  'ℹ suites 1',
  'ℹ pass 3',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 78.3194',
  '',
].join('\n');

describe('extractTestCount measures the node spec reporter summary (Node >= 23 default)', () => {
  it('a passing spec-reporter stream measures ℹ tests N and verdicts pass', () => {
    // Fixture sanity: the stream must NOT be measurable through the TAP
    // branch, or this test would stay green with the spec branch deleted and
    // prove nothing about it.
    assert.doesNotMatch(SPEC_PASSING, /^# tests? \d+/m,
      'fixture sanity: no TAP summary may hide inside the spec fixture');

    const res = runSteps(CWD, [echoStep('test', SPEC_PASSING)]);
    assert.equal(res.test_count, 3, 'ℹ tests 3 must be measured as the count');
    assert.equal(res.tests_ran, true);
    assert.equal(res.verdict, 'pass');
  });

  it('a workspace fan-out with one spec summary per workspace SUMS the blocks (TAP defect #2, spec edition)', () => {
    const twoWorkspaces = SPEC_PASSING + '\nℹ tests 5\nℹ suites 2\nℹ pass 5\nℹ fail 0\n';
    const res = runSteps(CWD, [echoStep('test', twoWorkspaces)]);
    assert.equal(res.test_count, 8, 'must sum 3 + 5, not first-match 3');
  });

  it('a mixed fan-out (spec workspaces + a vitest workspace) sums across formats (TAP defect #3, spec edition)', () => {
    const mixed = SPEC_PASSING + '\n  Tests  144 passed (144)\n';
    const res = runSteps(CWD, [echoStep('test', mixed)]);
    assert.equal(res.test_count, 147, 'must sum spec 3 + vitest 144');
  });

  it('ℹ tests 0 reads as 0 (not null) → verdict no_tests, the same refinement as TAP `# tests 0`', () => {
    const empty = 'ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ duration_ms 5.1\n';
    const res = runSteps(CWD, [echoStep('test', empty)]);
    assert.equal(res.test_count, 0);
    assert.equal(res.verdict, 'no_tests',
      'an exit-0 spec run of zero tests is not a verified pass — it must land in no_tests, never pass, '
        + 'and never unmeasured_tests (the count IS proven: it is zero)');
  });

  it('a FAILING spec run (non-zero exit) still measures the total on the catch path; ℹ fail feeds the verdict via exit code, never the count', () => {
    const failing = [
      '✔ one passes (0.5ms)',
      '✖ one fails (0.7ms)',
      'ℹ tests 2',
      'ℹ suites 0',
      'ℹ pass 1',
      'ℹ fail 1',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 12.5',
      '',
    ].join('\n');
    const res = runSteps(CWD, [echoStep('test', failing, { exitCode: 1 })]);
    assert.equal(res.verdict, 'fail', 'the exit code decides the verdict');
    assert.equal(res.test_count, 2,
      'the measured count must be the ℹ tests TOTAL (2) — not the pass line (1), not the fail line (1), '
        + 'and not their sum with the total (4): the breakdown lines must not match the counter');
  });

  it('ANCHOR: a test literally NAMED "ℹ tests 999" is not counted — result lines are glyph-prefixed/indented, only the flush-left summary matches', () => {
    // The spec edition of the TAP name-echo hazard ("node `# tests 0` →
    // verdict no_tests" sitting in this very repo's output at byte 258,390).
    const withNameEcho = [
      '✔ ℹ tests 999 stays a name, not a summary (0.4ms)',
      '▶ suite about ℹ tests 999',
      '  ✔ ℹ tests 999 nested (0.2ms)',
      '✔ suite about ℹ tests 999 (0.5ms)',
      'ℹ tests 2',
      'ℹ pass 2',
      'ℹ fail 0',
      '',
    ].join('\n');
    const res = runSteps(CWD, [echoStep('test', withNameEcho)]);
    assert.equal(res.test_count, 2,
      'only the flush-left ℹ tests 2 summary may count — 999 from the echoed names must not appear in any sum');
  });

  it('both formats: a plain TAP stream still measures exactly as before (non-regression)', () => {
    const tap = 'TAP version 13\nok 1 - a\nok 2 - b\n1..2\n# tests 2\n# pass 2\n# fail 0\n';
    const res = runSteps(CWD, [echoStep('test', tap)]);
    assert.equal(res.test_count, 2);
    assert.equal(res.verdict, 'pass');
  });

  it('genuinely unrecognized output still blocks as unmeasured_tests — the honest-unmeasured path is narrowed, not removed', () => {
    const alien = 'All 7 checks completed successfully.\nDone in 1.2s.\n';
    const res = runSteps(CWD, [echoStep('test', alien)]);
    assert.equal(res.test_count, null);
    assert.equal(res.verdict, 'unmeasured_tests',
      'output matching no known summary must keep blocking — this fix teaches the floor one more format, '
        + 'it does not teach it to guess');
  });
});
