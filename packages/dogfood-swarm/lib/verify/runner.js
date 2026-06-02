/**
 * runner.js — Shared command runner for verify adapters.
 *
 * Executes commands, captures stdout/stderr, normalizes results
 * into verification steps with exit codes and durations.
 */

import { execFileSync } from 'node:child_process';

/**
 * Per-step wall-clock budget. A step that exceeds this is killed and tagged
 * `timed_out` (ve-p-005) rather than reported as an ordinary fast failure.
 */
const STEP_TIMEOUT_MS = 300000; // 5 min per step

/**
 * Per-stream output cap (ve-p-007). Bounds a single step's stdout/stderr so a
 * huge test log cannot bloat the persisted verification_receipts row. Defined
 * once and referenced by both truncate sites; the per-receipt implied ceiling
 * is ~4 steps × (stdout + stderr) = ~64 KB. Raising this single-sources the
 * blast radius — see bounded-json-read.js's MAX_AGENT_OUTPUT_BYTES for the
 * same pattern.
 */
const MAX_STEP_OUTPUT_CHARS = 8000;

/**
 * Recognizes the shell's "executable not found" message across platforms.
 * With `shell: true` a missing `step.cmd` does NOT surface as an ENOENT error
 * object — the shell itself runs and exits non-zero with one of these strings
 * on stderr (verified empirically per ve-p-001). The ENOENT object only
 * appears on the rare `shell: false` path, handled separately in the catch.
 */
const TOOL_NOT_FOUND_STDERR = /is not recognized as an internal or external command|: command not found|: not found/i;

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
 * @param {object} step — { name, cmd, args?, optional?, timeoutMs? }. `timeoutMs`
 *   overrides the default per-step budget (ve-p-005) so build-heavy repos
 *   (large Rust workspaces) can be given more room without a misleading
 *   "failure" that is really "didn't finish in 5 min".
 * @returns {object} — StepResult
 */
export function runStep(repoPath, step) {
  const cmdArgs = step.args || [];
  const timeoutMs = step.timeoutMs ?? STEP_TIMEOUT_MS;
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
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: true,
    });

    const out = truncate(stdout, MAX_STEP_OUTPUT_CHARS);
    return {
      name: step.name,
      command: fullCmd,
      exit_code: 0,
      passed: true,
      duration_ms: Date.now() - start,
      stdout: out.text,
      stderr: '',
      truncated: out.truncated,
      optional: !!step.optional,
    };
  } catch (e) {
    const duration_ms = Date.now() - start;
    const stderrRaw = e.stderr || '';

    // ve-p-001: a MISSING build tool on PATH is an EXPECTED operating
    // condition (we audit arbitrary external repos on heterogeneous hosts),
    // not a real fix failure. Distinguish it so runSteps can degrade to a
    // `tool_missing` verdict instead of a misleading FAIL. ENOENT is the
    // shell:false shape; the stderr regex catches the shell:true shape, where
    // the shell runs and reports "not recognized"/"command not found" itself.
    const toolMissing = e.code === 'ENOENT' || TOOL_NOT_FOUND_STDERR.test(stderrRaw);

    // ve-p-005: a 5-min hang must be distinguishable from a fast exit-1 fail.
    // Under shell:true, Node's SIGTERM hits the wrapping shell, not the real
    // grandchild, so e.killed/e.signal are erased — the reliable signal is the
    // elapsed wall clock reaching the budget. e.signal is still checked first
    // for the shell:false future where Node sets it on the real child.
    const timedOut = !toolMissing &&
      (e.signal === 'SIGTERM' || e.killed === true ||
        duration_ms >= timeoutMs - 50);

    const stdout = truncate(e.stdout || '', MAX_STEP_OUTPUT_CHARS);
    const stderr = truncate(stderrRaw, MAX_STEP_OUTPUT_CHARS);
    return {
      name: step.name,
      command: fullCmd,
      // -127 is the conventional "command not found" exit; use it as a sentinel
      // so the persisted exit_code itself flags the tool-missing case.
      exit_code: toolMissing ? (e.status ?? -127) : (e.status ?? 1),
      passed: false,
      duration_ms,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      tool_missing: toolMissing,
      timed_out: timedOut,
      reason: toolMissing
        ? `tool \`${step.cmd}\` not found on PATH`
        : timedOut
          ? `step \`${step.name}\` timed out after ${timeoutMs}ms`
          : undefined,
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
 * @returns {object} — { steps: StepResult[], verdict, duration_ms, test_count,
 *   tests_ran, timed_out, truncated, reason? }. `verdict` is one of
 *   `pass | fail | skip | tool_missing`; adapters may further refine `pass` to
 *   `no_tests`. `reason` is present (a human-readable string) on every non-pass
 *   verdict the runner originates, absent on a plain `pass`.
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
  const requiredFailures = requiredResults.filter(r => !r.passed);

  // ve-005: an empty required-step set must NOT be an automatic `pass`.
  // `[].every(...)` is vacuously true, so without this guard a run where
  // every step was optional, skipped, or filtered away would report `pass`
  // and advance the wave to `verified` having required nothing. Mirror the
  // registry's `verdict: 'skip'` shape so callers/status already handle it.
  //
  // ve-p-001: a required step that failed SOLELY because its tool is missing
  // from PATH degrades to a distinct `tool_missing` verdict, not `fail` — the
  // wave correctly stays un-advanced WITHOUT lying that the code broke. A real
  // (non-tool-missing) required failure dominates: it is the more actionable,
  // honest signal, so `fail` wins when both are present.
  let verdict;
  let reason;
  if (requiredResults.length === 0) {
    verdict = 'skip';
    reason = 'no required steps ran — nothing to verify in this environment';
  } else if (requiredFailures.length === 0) {
    verdict = 'pass';
  } else if (requiredFailures.some(r => !r.tool_missing)) {
    verdict = 'fail';
    const timedOut = requiredFailures.find(r => r.timed_out);
    if (timedOut) reason = timedOut.reason;
  } else {
    // Every required failure was a missing tool. The display `command` string
    // begins with the executable name, so its first token names the tool.
    verdict = 'tool_missing';
    const missing = [...new Set(requiredFailures.map(r => r.command?.split(' ')[0]))]
      .filter(Boolean);
    reason = `required tool(s) not found on PATH (${missing.join(', ')}) — cannot verify in this environment`;
  }

  // ve-004: distinguish "tests actually ran" from "the test step was a
  // no-op". `npm test --if-present` exits 0 with no `test` script, which
  // looks identical to a real pass at the wave gate. A `test` step that
  // passed but yielded no recognizable test count produced nothing we can
  // call a verified pass — surface `tests_ran: false` so the caller can
  // treat it as not-verified instead of a clean PASS.
  const testStep = results.find(r => r.name === 'test');
  const testsRan = testStep ? (testStep.passed && testCount != null) : false;

  const out = {
    steps: results,
    verdict,
    duration_ms: Date.now() - totalStart,
    test_count: testCount,
    tests_ran: testsRan,
    // ve-p-005 / ve-p-007: aggregate the per-step signals so the display layer
    // can flag a hang or a truncated log at the run level without re-walking
    // every step.
    timed_out: results.some(r => r.timed_out),
    truncated: results.some(r => r.truncated),
  };
  // Only attach `reason` when there is one to report — keeps the `pass` shape
  // unchanged and lets the display layer treat its presence as "explain why".
  if (reason) out.reason = reason;
  return out;
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

/**
 * Bound a captured stream. Returns `{ text, truncated }` so the caller can
 * surface a top-level `truncated` flag (ve-p-007) — the operator otherwise has
 * no signal that the displayed/persisted log is partial. The "… (truncated)"
 * marker is appended in-band as before for anyone reading the raw text.
 */
function truncate(str, max) {
  if (!str) return { text: '', truncated: false };
  if (str.length <= max) return { text: str, truncated: false };
  return {
    text: str.slice(0, max) + `\n... (truncated, ${str.length} total chars)`,
    truncated: true,
  };
}
