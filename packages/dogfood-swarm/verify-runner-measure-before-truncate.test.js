/**
 * verify-runner-measure-before-truncate.test.js — the deterministic floor must
 * measure the FULL stream and truncate only what it stores (ve-trunc-001).
 *
 * THE DEADLOCK THIS FIXES. `runStep` truncated stdout to MAX_STEP_OUTPUT_CHARS
 * (8000) and `runSteps` then handed that truncated copy to `extractTestCount`.
 * Measured on this repo: `npm test` emits 898,923 chars — 112x the bound — and
 * the first real summary lands at byte 483,236. So the count was unfindable,
 * `tests_ran` was false, and the verdict was `no_tests` on a run that had just
 * executed ~2,853 tests in 33 seconds. The floor truncated the evidence and
 * then reported that there was no evidence.
 *
 * That is the ONE gate that cannot be overridden, so it did not degrade the
 * swarm — it DEADLOCKED it. No `--reason` could move it. Incorruptible and
 * blind at the same time.
 *
 * THE DIRECTION IS RIGHT AND STAYS RIGHT. An exit-0 with no countable tests
 * must NEVER become a pass — that would trade an honest false-negative for a
 * vacuous gate, in the only gate that is law. Every test here asserts the run
 * still BLOCKS; what changes is that a measurable run is now measured, and an
 * unmeasurable one is named as the instrument's failure rather than the work's.
 *
 * THE FIXTURES MUST EXCEED THE BOUND OR THEY PROVE NOTHING. A small output
 * never truncates and passes either way — the same vacuous shape as an
 * "em-dash survives" test against a mojibake bug. Every fixture below puts its
 * summary line deliberately past MAX_STEP_OUTPUT_CHARS.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSteps } from './lib/verify/runner.js';

const CWD = tmpdir();
const MAX_STEP_OUTPUT_CHARS = 8000; // mirrors runner.js:24

/**
 * A step that prints `text` verbatim on stdout and exits 0.
 *
 * The fixture goes to a FILE, not into an `-e` argument: these outputs are
 * deliberately 60 KB+ and would blow the command-line length limit. The command
 * is `node` from PATH rather than `process.execPath`, because runStep uses
 * `shell: true` and this rig's execPath is `C:\Program Files\nodejs\node.exe` —
 * the space would split the command.
 */
function echoStep(name, text) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-'));
  const dataFile = join(dir, 'out.txt').replace(/\\/g, '/');
  const emitFile = join(dir, 'emit.cjs').replace(/\\/g, '/');
  writeFileSync(dataFile, text, 'utf-8');
  writeFileSync(emitFile, `process.stdout.write(require("fs").readFileSync(${JSON.stringify(dataFile)},"utf8"))`, 'utf-8');
  return { name, cmd: 'node', args: [emitFile] };
}

/** Filler that pushes the real summary well past the 8 KB storage bound. */
function padding(chars) {
  return `${'ok 1 - a passing subtest with a reasonably long name to burn bytes\n'.repeat(Math.ceil(chars / 66))}`;
}

describe('runSteps — the test count is measured before truncation', () => {
  it('finds the count when the summary sits FAR beyond MAX_STEP_OUTPUT_CHARS (the deadlock)', () => {
    const out = `TAP version 13\n${padding(60_000)}# tests 2853\n# pass 2853\n# fail 0\n`;
    assert.ok(out.length > MAX_STEP_OUTPUT_CHARS * 5, 'fixture sanity: must dwarf the bound or it proves nothing');
    assert.ok(out.indexOf('# tests') > MAX_STEP_OUTPUT_CHARS, 'fixture sanity: summary must be PAST the bound');

    const res = runSteps(CWD, [echoStep('test', out)]);
    assert.equal(res.test_count, 2853, 'the count must come from the full stream, not the stored copy');
    assert.equal(res.tests_ran, true);
    assert.equal(res.verdict, 'pass');
  });

  it('still TRUNCATES what it stores — measurement and storage stay separate concerns', () => {
    const out = `TAP version 13\n${padding(60_000)}# tests 2853\n`;
    const res = runSteps(CWD, [echoStep('test', out)]);
    const step = res.steps.find(s => s.name === 'test');
    assert.ok(step.stdout.length <= MAX_STEP_OUTPUT_CHARS + 200, 'the receipt must stay bounded');
    assert.equal(step.truncated, true, 'and must still say so');
    assert.equal(res.test_count, 2853, 'while the count is unaffected by the bound');
  });

  // CONTROL (a) — the direction must not flip. A real zero stays blocked.
  it('a genuinely zero-test run is still no_tests, not a pass', () => {
    const res = runSteps(CWD, [echoStep('test', 'TAP version 13\n# tests 0\n# pass 0\n')]);
    assert.equal(res.verdict, 'no_tests');
    assert.equal(res.tests_ran, false);
    assert.match(res.reason, /zero tests/);
  });

  // CONTROL (b) — a small single-workspace run is unaffected.
  it('a small single-workspace output still extracts and passes', () => {
    const res = runSteps(CWD, [echoStep('test', 'TAP version 13\nok 1 - x\n# tests 42\n# pass 42\n')]);
    assert.equal(res.test_count, 42);
    assert.equal(res.verdict, 'pass');
  });

  // CONTROL (c) — the fan-out. `npm test --workspaces` emits ONE summary per
  // workspace; taking the FIRST under-counted this repo by 62% (1328 of 2853).
  it('a fan-out with multiple summaries reports the SUM, not the first', () => {
    const out = `# tests 1328\n# pass 1328\n${padding(20_000)}# tests 430\n# pass 430\n# tests 356\n`;
    const res = runSteps(CWD, [echoStep('test', out)]);
    assert.equal(res.test_count, 1328 + 430 + 356, 'every workspace summary must be counted');
  });

  it('sums ACROSS runners — this repo fans out to 6x node --test plus 1x vitest', () => {
    // vitest emits `  Tests  144 passed (144)` — note NO colon, which the old
    // `/Tests:\s+/` required and therefore never matched.
    const out = `# tests 1328\n${padding(20_000)}\n      Test Files  14 passed (14)\n      Tests  144 passed (144)\n`;
    const res = runSteps(CWD, [echoStep('test', out)]);
    assert.equal(res.test_count, 1328 + 144, 'a mixed fan-out must total both runners');
  });

  // THE ANCHOR. This repo contains a test literally named
  // "node `# tests 0` -> verdict no_tests", and its TAP line sits at byte
  // 258,390 — BEFORE the first real summary at 483,236. Unanchored, the regex
  // matched that NAME and returned 0, so fixing truncation ALONE would still
  // have reported no_tests. Same disease DS-PROAC-04 fixed for the pytest
  // branch: output echoed by the code under test outranking the summary.
  it('a TEST NAME mentioning the summary pattern cannot outrank the real summary', () => {
    const out = [
      'TAP version 13',
      '    # Subtest: node `# tests 0` → verdict no_tests (not pass)',
      '    ok 1 - node `# tests 0` → verdict no_tests (not pass)',
      padding(20_000),
      '# tests 2853',
      '# pass 2853',
    ].join('\n');
    const res = runSteps(CWD, [echoStep('test', out)]);
    assert.equal(res.test_count, 2853, 'the line-anchored summary must win over an indented test name');
    assert.equal(res.verdict, 'pass');
  });

  it('an unrecognizable test output is NOT reported as zero tests', () => {
    // The instrument could not measure. That is the instrument's failure, not
    // the work's — and it must not be laundered into the vocabulary of the
    // subject's failure. Still blocks; just names the right defect.
    const out = `some runner nobody taught this floor about\n${padding(60_000)}\nall good!\n`;
    const res = runSteps(CWD, [echoStep('test', out)]);
    assert.notEqual(res.verdict, 'pass', 'must still block — never certify what it could not see');
    assert.notEqual(res.verdict, 'no_tests', 'must not claim zero tests ran; it does not know that');
    assert.equal(res.test_count, null);
    assert.match(res.reason, /could not measure|unproven/i, 'the reason must point at the instrument');
  });
});
