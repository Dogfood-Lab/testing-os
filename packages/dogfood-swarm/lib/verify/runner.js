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
      // ve-trunc-001: MEASURE the full stream here, STORE the bounded copy.
      // These are different concerns and the bound was destroying the former to
      // serve the latter: runSteps used to call extractTestCount on the
      // TRUNCATED text, so on this repo (898,923 chars of `npm test`, first
      // summary at byte 483,236 — 112x past the 8,000 bound) the count was
      // unfindable and a 2,853-test run was reported `no_tests`. The floor
      // truncated the evidence and then reported that there was no evidence —
      // in the ONE gate that cannot be overridden, so it deadlocked rather than
      // degraded. The full text is deliberately NOT returned: the step result
      // is the persisted receipt, and an 899 KB receipt is what the bound
      // exists to prevent.
      ...measureStep(step, stdout),
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
      // Measure the failure path too: a test step that exits non-zero still
      // reports how many tests ran, and that count is real evidence.
      ...measureStep(step, e.stdout || ''),
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

    // ve-trunc-001: the count is measured inside runStep against the FULL
    // stream (see measureStep). It is NOT re-derived from `result.stdout` here
    // — that is the bounded copy kept for the receipt, and measuring it is the
    // bug this fixes.
    if (step.name === 'test' && result.test_count != null) {
      testCount = result.test_count;
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
  //
  // ds-verify-001: a POSITIVE count is required. extractTestCount returns 0
  // (not null) for an explicit zero-test run — cargo `test result: ok. 0
  // passed`, node `# tests 0` — so `testCount != null` alone let a run that
  // exercised nothing count as "tests ran". Demand `testCount > 0`.
  const testStep = results.find(r => r.name === 'test');
  const testsRan = testStep ? (testStep.passed && testCount != null && testCount > 0) : false;

  // ds-verify-001: lift the pass→no_tests downgrade OUT of the node adapter and
  // into the runner so it fires uniformly for EVERY adapter. A required `test`
  // step that PASSED but exercised zero tests (count 0 or unrecognized) is not
  // a verified pass — there is no positive evidence the fix works. Previously
  // this downgrade lived only in adapters/node.js, so a cargo `0 passed` or a
  // node `# tests 0` scored a clean `pass`. The node adapter still refines the
  // human-readable reason for its no-`test`-script case; the verdict decision
  // is made here, once.
  // ve-trunc-001: `no_tests` used to conflate two OPPOSITE conditions — "the
  // test step genuinely ran zero tests" (a defect in the WORK) and "I could not
  // measure what ran" (a defect in the INSTRUMENT). Both produced the identical
  // verdict, so an operator reading NO_TESTS went hunting for missing tests in
  // a repo that has thousands. That is the instrument reporting its own
  // blindness in the vocabulary of the subject's failure — the same flattening
  // as an adjudication receipt turning BUDGET_EXCEEDED into
  // insufficient_context.
  //
  // Both still BLOCK. Neither is a pass, and an exit-0 with no countable tests
  // must never become one: that would trade an honest false-negative for a
  // vacuous gate, in the only gate that is law. What changes is WHICH defect
  // gets named, and where the operator is pointed.
  // The discriminator is OUTPUT, not the count being null. Two ways to reach
  // "no countable tests", and they are opposite conditions:
  //
  //   full_output_chars === 0  -> the step produced NOTHING. `npm test
  //                               --if-present` with no `test` script exits 0
  //                               and emits exactly 0 chars (measured). Nothing
  //                               ran; `no_tests` is the honest, correct answer
  //                               and stays exactly as it was.
  //   output > 0, count null   -> something ran and emitted output this floor
  //                               does not recognize. Calling that "zero tests"
  //                               is a claim the instrument cannot support.
  //
  // Both still BLOCK. An exit-0 with no countable tests must never become a
  // pass — that would trade an honest false-negative for a vacuous gate, in the
  // only gate that is law.
  //
  // NOTE on scope: the condition originally scoped for this verdict —
  // "truncated before the summary" — is now UNREACHABLE, because measureStep
  // reads the full stream before truncation, so the bound can no longer blind
  // the count. What remains, and what this serves, is the sibling condition:
  // an unrecognized runner. Same principle, still live — the instrument must
  // not report its own blindness in the vocabulary of the subject's failure.
  let noTests = false;
  if (verdict === 'pass' && testStep && testStep.passed && !testsRan) {
    const fullChars = testStep.full_output_chars ?? 0;
    if (testCount == null && fullChars > 0) {
      verdict = 'unmeasured_tests';
      reason = `could not measure test count — the test step produced ${fullChars} chars of output matching no known runner summary. The count is unproven, not zero.`;
    } else {
      verdict = 'no_tests';
      noTests = true;
      reason = 'test step ran zero tests — no positive evidence the fix works; not a verified pass';
    }
  }

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
  if (noTests) out.no_tests = true;
  // Only attach `reason` when there is one to report — keeps the `pass` shape
  // unchanged and lets the display layer treat its presence as "explain why".
  if (reason) out.reason = reason;
  return out;
}

/**
 * Measure a step's FULL stdout before the caller truncates it for storage.
 *
 * Returns the fields worth keeping on the (bounded) step result: the test count
 * measured from the complete stream, and how big that stream actually was — so
 * an operator reading a truncated receipt can see what fraction they are
 * looking at, and a `could not measure` reason can quote real numbers instead
 * of gesturing.
 *
 * Only the `test` step is measured; running the count patterns over lint/build
 * output would be wasted work and a chance for a stray match.
 */
function measureStep(step, fullStdout) {
  if (step.name !== 'test') return {};
  return {
    test_count: extractTestCount(fullStdout),
    full_output_chars: fullStdout.length,
  };
}

/**
 * Try to extract test count from various test runner outputs.
 */
function extractTestCount(stdout) {
  // ve-trunc-001 — three defects, all measured on this repo's real `npm test`
  // (898,923 chars, 7 workspaces):
  //
  // 1. ANCHOR. The old `/# tests? (\d+)/` was unanchored, so it matched a TEST
  //    NAME. This repo contains a test literally named
  //    "node `# tests 0` → verdict no_tests", whose TAP line sits at byte
  //    258,390 — BEFORE the first real summary at 483,236. The first match was
  //    therefore `0`, meaning that even with an unbounded stream the floor
  //    would still have reported no_tests. Fixing the truncation alone would
  //    NOT have unblocked this repo. `^` (with /m) is what excludes indented
  //    TAP name lines. Same disease DS-PROAC-04 fixed for the pytest branch:
  //    output echoed by the code under test outranking the real summary.
  //
  // 2. SUM. `npm test --workspaces --if-present` emits ONE summary per
  //    workspace. Taking the FIRST reported 1328 of 2853 — a silent 62%
  //    under-count even once the stream is unbounded.
  //
  // 3. MIXED RUNNERS. This fan-out is 6x `node --test` + 1x vitest, and vitest
  //    prints `  Tests  144 passed (144)` — NO colon. The old
  //    `/Tests:\s+(\d+)\s+passed/` required one and so never matched vitest at
  //    all; the node branch returning first hid that it was also broken.
  //
  // node and jest/vitest are summed TOGETHER because a real fan-out mixes them.
  // The pytest/cargo branches below keep their existing first/last-match shape
  // — they have the same theoretical exposure, but nothing here proves it and a
  // blind refactor of a gate that is law is not worth the risk.
  let total = 0;
  let found = false;

  // node --test TAP: "# tests 42" at LINE START. A nested summary or a test
  // name is always indented, so the anchor excludes both.
  for (const m of stdout.matchAll(/^# tests? (\d+)/gm)) {
    total += parseInt(m[1], 10);
    found = true;
  }

  // jest "Tests:  42 passed" / vitest "  Tests  144 passed (144)". Colon
  // optional; indent tolerated (vitest indents), but still line-anchored — a
  // TAP name line begins with `#`/`ok`/`not ok` after its indent, never
  // `Tests`. `Test Files  14 passed` does not match: the literal is `Tests`.
  for (const m of stdout.matchAll(/^\s*Tests:?\s+(\d+)\s+passed/gm)) {
    total += parseInt(m[1], 10);
    found = true;
  }

  if (found) return total;

  // pytest: the session-summary line, e.g. "===== 42 passed, 1 skipped in
  // 4.21s =====". DS-PROAC-04: a bare /(\d+)\s+passed/ grabbed the FIRST
  // "<n> passed" anywhere in the log — a progress line or a captured-stdout
  // echo from the code under test could win and report a wrong test_count.
  // Anchor on the summary line the way the other three patterns anchor on
  // their markers: require `passed` to share its line with the summary's
  // companion tokens (`in <time>`, or a `failed`/`skipped`/`error`/`xfailed`
  // tally), and prefer the LAST such line — pytest prints the summary last.
  const pytestSummary = /^.*?(\d+)\s+passed.*?(?:\bin\s+[\d.]+s|\b\d+\s+(?:failed|skipped|error|errors|xfailed|xpassed|warning|warnings|deselected))\b.*$/gim;
  let pytestLast = null;
  for (const m of stdout.matchAll(pytestSummary)) pytestLast = m;
  if (pytestLast) return parseInt(pytestLast[1], 10);
  // Fallback for a bare "N passed" with no companion tokens (a minimal run):
  // still prefer the LAST occurrence so a stray earlier number cannot win.
  const pytestBareAll = [...stdout.matchAll(/(\d+)\s+passed/g)];
  if (pytestBareAll.length) {
    return parseInt(pytestBareAll[pytestBareAll.length - 1][1], 10);
  }

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
