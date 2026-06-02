/**
 * runner.js — Shared command runner for verify adapters.
 *
 * Executes commands, captures stdout/stderr, normalizes results
 * into verification steps with exit codes and durations.
 */

import { execFileSync } from 'node:child_process';

/**
 * Run a single verification step.
 *
 * Uses `execFileSync` with the `(step.cmd, step.args[])` argv-array form to
 * mirror the v1.2.0 F-W1-BACK-003 doctrine
 * (`packages/dogfood-swarm/lib/worktree.js`,
 * `packages/dogfood-swarm/lib/domains.js`) and keep the import + call shape
 * consistent across the package.
 *
 * SECURITY — the actual guarantee (ve-006). `shell: true` is retained
 * because production adapters invoke `npm`/`npx` (Windows `.cmd` wrappers
 * that need PATHEXT resolution from a shell). With `shell: true`, Node joins
 * `file` + `args` into a single string and hands it to the shell, so the
 * argv array does NOT neutralize shell metacharacters: every arg IS subject
 * to shell interpretation. This code path is safe ONLY because every live
 * `step.args` is a hardcoded literal (verified across
 * `adapters/{node,python,rust}.js` and the commandOverrides callers); the
 * one piece of untrusted, target-repo-influenced data is `cwd` (repoPath),
 * which never reaches the command string.
 *
 * Therefore, before landing any `step.cmd`/`step.args` value derived from
 * target-repo or user input, you MUST either drop `shell: true` (and resolve
 * the npm/npx `.cmd` shim explicitly on win32) or shell-escape the value.
 * The argv-array shape is a readability/consistency convention here, not a
 * sanitizer — do not treat it as one.
 *
 * @param {string} repoPath — cwd for the command (the only untrusted input;
 *   it is passed as `cwd`, never concatenated into the command string)
 * @param {object} step — { name: string, cmd: string, args?: string[], optional?: boolean }
 * @returns {object} — StepResult
 */
export function runStep(repoPath, step) {
  const cmdArgs = step.args || [];
  // `command` is the human-readable display string returned to callers and
  // asserted by callers/tests; it is NOT what executes. `execFileSync`
  // receives `step.cmd` + the argv array separately below.
  const fullCmd = cmdArgs.length ? `${step.cmd} ${cmdArgs.join(' ')}` : step.cmd;
  const start = Date.now();

  try {
    const stdout = execFileSync(step.cmd, cmdArgs, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 min per step
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: true,
    });

    return {
      name: step.name,
      command: fullCmd,
      exit_code: 0,
      passed: true,
      duration_ms: Date.now() - start,
      stdout: truncate(stdout, 8000),
      stderr: '',
      optional: !!step.optional,
    };
  } catch (e) {
    return {
      name: step.name,
      command: fullCmd,
      exit_code: e.status ?? 1,
      passed: false,
      duration_ms: Date.now() - start,
      stdout: truncate(e.stdout || '', 8000),
      stderr: truncate(e.stderr || '', 8000),
      optional: !!step.optional,
    };
  }
}

/**
 * Run a sequence of verification steps.
 * Stops at the first required failure unless continueOnError is set.
 *
 * @param {string} repoPath
 * @param {Array} steps
 * @param {object} [opts]
 * @param {boolean} [opts.continueOnError] — keep going after required step failure
 * @returns {object} — { steps: StepResult[], verdict, duration_ms, test_count? }
 */
export function runSteps(repoPath, steps, opts = {}) {
  const results = [];
  const totalStart = Date.now();
  let testCount = null;

  for (const step of steps) {
    if (!step) continue; // null steps are skipped (adapter said "not applicable")

    const result = runStep(repoPath, step);
    results.push(result);

    // Try to extract test count from stdout
    if (step.name === 'test' && result.stdout) {
      const count = extractTestCount(result.stdout);
      if (count != null) testCount = count;
    }

    // Stop on required failure unless configured otherwise
    if (!result.passed && !result.optional && !opts.continueOnError) {
      break;
    }
  }

  const requiredResults = results.filter(r => !r.optional);

  // ve-005: an empty required-step set must NOT be an automatic `pass`.
  // `[].every(...)` is vacuously true, so without this guard a run where
  // every step was optional, skipped, or filtered away would report `pass`
  // and advance the wave to `verified` having required nothing. Mirror the
  // registry's `verdict: 'skip'` shape so callers/status already handle it.
  let verdict;
  if (requiredResults.length === 0) {
    verdict = 'skip';
  } else {
    verdict = requiredResults.every(r => r.passed) ? 'pass' : 'fail';
  }

  // ve-004: distinguish "tests actually ran" from "the test step was a
  // no-op". `npm test --if-present` exits 0 with no `test` script, which
  // looks identical to a real pass at the wave gate. A `test` step that
  // passed but yielded no recognizable test count produced nothing we can
  // call a verified pass — surface `tests_ran: false` so the caller can
  // treat it as not-verified instead of a clean PASS.
  const testStep = results.find(r => r.name === 'test');
  const testsRan = testStep ? (testStep.passed && testCount != null) : false;

  return {
    steps: results,
    verdict,
    duration_ms: Date.now() - totalStart,
    test_count: testCount,
    tests_ran: testsRan,
  };
}

/**
 * Try to extract test count from various test runner outputs.
 */
function extractTestCount(stdout) {
  // Node test runner: "# tests 42"
  const nodeMatch = stdout.match(/# tests? (\d+)/);
  if (nodeMatch) return parseInt(nodeMatch[1], 10);

  // Jest/Vitest: "Tests: 42 passed"
  const jestMatch = stdout.match(/Tests:\s+(\d+)\s+passed/);
  if (jestMatch) return parseInt(jestMatch[1], 10);

  // pytest: "42 passed"
  const pytestMatch = stdout.match(/(\d+)\s+passed/);
  if (pytestMatch) return parseInt(pytestMatch[1], 10);

  // cargo test: "test result: ok. 42 passed"
  const cargoMatch = stdout.match(/test result: \w+\.\s+(\d+)\s+passed/);
  if (cargoMatch) return parseInt(cargoMatch[1], 10);

  return null;
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... (truncated, ${str.length} total chars)`;
}
