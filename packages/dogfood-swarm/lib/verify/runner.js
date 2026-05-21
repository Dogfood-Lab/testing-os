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
 * Uses `execFileSync` argv-array form to mirror the v1.2.0 F-W1-BACK-003
 * doctrine (`packages/dogfood-swarm/lib/worktree.js`,
 * `packages/dogfood-swarm/lib/domains.js`): callers pass `step.cmd` +
 * `step.args` as a structured pair so a future adapter author who lands a
 * user-influenced `step.args` cannot re-introduce shell metacharacter
 * interpretation in the argument vector. Current call sites
 * (`adapters/{node,python,rust}.js`) all pass hardcoded safe args, so this
 * is defense-in-depth — but it keeps the doctrine consistent across the
 * package.
 *
 * `shell: true` is retained because production adapters invoke `npm`/`npx`
 * (Windows `.cmd` wrappers that need PATHEXT resolution from a shell). The
 * argv-array shape is still the load-bearing security signal: it forces a
 * future contributor to think in terms of `(cmd, args[])` rather than string
 * concatenation, and it keeps this file's import + call shape identical to
 * the worktree.js doctrine.
 *
 * @param {string} repoPath — cwd for the command
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
  const allPassed = requiredResults.every(r => r.passed);

  return {
    steps: results,
    verdict: allPassed ? 'pass' : 'fail',
    duration_ms: Date.now() - totalStart,
    test_count: testCount,
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
