/**
 * stageC-runner-pytest-count-anchor.test.js
 *
 * DS-PROAC-04 (LOW, Stage C amend — humanization lens):
 *
 * extractTestCount()'s pytest pattern was a bare `/(\d+)\s+passed/` — the
 * FIRST `<n> passed` anywhere in the captured stdout. The other three
 * runner patterns anchor on a contextual marker ("# tests N", "Tests: N
 * passed", "test result: ok. N passed"); the pytest one did not, so a stray
 * "<n> passed" earlier in the log — a progress line, a captured stdout
 * echo, a dependency's own summary — would mis-capture the test count.
 *
 * A wrong test_count is a quiet honesty defect: the wave gate persists a
 * count that does not match the real session summary, and the operator
 * trusts it. The fix anchors the pytest read on the real session summary
 * line (the line that also carries the `passed`/`failed`/`in <t>s` summary
 * shape), or prefers the LAST match, so an earlier stray number cannot win.
 *
 * extractTestCount is module-private, so we exercise it through the public
 * surface: runStep() on a tiny cross-platform script that prints a crafted
 * pytest-shaped log, then runSteps() to read test_count. No mocks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSteps } from './lib/verify/runner.js';

let TEST_ROOT;
function setupTestRoot() {
  return mkdtempSync(join(tmpdir(), 'stageC-pytest-anchor-'));
}

/**
 * Emit a fixed pytest-shaped log via Node so the assertion is fully
 * cross-platform (no reliance on pytest being installed). The script writes
 * its lines verbatim to stdout; runSteps reads stdout and runs the SAME
 * extractTestCount the production path uses.
 */
function pytestLogStep(root, logLines, name = 'test') {
  const scriptPath = join(root, 'emit-pytest-log.mjs');
  const body = `process.stdout.write(${JSON.stringify(logLines.join('\n') + '\n')});`;
  writeFileSync(scriptPath, body);
  return { name, cmd: 'node', args: [scriptPath] };
}

describe('runner extractTestCount — DS-PROAC-04 pytest count anchored to summary line', () => {
  it('ignores a stray earlier "<n> passed" and parses the real session summary', () => {
    TEST_ROOT = setupTestRoot();
    try {
      // A realistic pytest run: a captured-stdout echo from the code under
      // test prints "3 passed" early, then the real summary reports 42.
      const step = pytestLogStep(TEST_ROOT, [
        'collected 42 items',
        '',
        'tests/test_app.py::test_thing PASSED',
        '----- Captured stdout -----',
        'sanity: 3 passed pre-checks before main run',
        '',
        '============ 42 passed, 1 skipped in 4.21s ============',
      ]);

      const res = runSteps(TEST_ROOT, [step], { continueOnError: true });
      assert.equal(res.verdict, 'pass');
      assert.equal(res.test_count, 42,
        'must read the real session summary (42), not the stray earlier "3 passed"');
      assert.equal(res.tests_ran, true);
    } finally {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it('still reads a plain single-summary pytest log (happy path intact)', () => {
    TEST_ROOT = setupTestRoot();
    try {
      const step = pytestLogStep(TEST_ROOT, [
        'collected 7 items',
        '============ 7 passed in 0.12s ============',
      ]);
      const res = runSteps(TEST_ROOT, [step], { continueOnError: true });
      assert.equal(res.test_count, 7);
    } finally {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });
});
