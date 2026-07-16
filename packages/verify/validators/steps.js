/**
 * Step results validator
 *
 * Enforces the bridge between scenario definitions and record evidence:
 * - Every required step must have a matching step_result
 * - A scenario cannot be "pass" if any required step is "fail" or "blocked"
 */

/**
 * Validate step results for a single scenario result.
 *
 * Note: Without access to the source repo's scenario definition, we validate
 * structural integrity. The full required_steps check is done by
 * validateRequiredSteps below, which verify() runs per scenario_result when
 * the caller supplies loaded scenario definitions (options.scenarios).
 *
 * @param {object} scenarioResult - A single scenario_results[] item
 * @returns {string[]} Array of error messages (empty if valid)
 */
export function validateStepResults(scenarioResult) {
  const errors = [];
  const { step_results, verdict, scenario_id } = scenarioResult;

  if (!step_results || step_results.length === 0) {
    errors.push('step_results is required and must have at least one entry');
    return errors;
  }

  // Must match the step_results[].status enum in BOTH dogfood-record-submission.schema.json
  // and dogfood-record.schema.json (["pass","fail","blocked","skip","partial"]). `partial`
  // is a first-class, contract-blessed step status (verdict.js ranks it 2/3); omitting it
  // here falsely rejected schema-valid submissions as "unknown status".
  const VALID_STATUSES = new Set(['pass', 'fail', 'blocked', 'skip', 'partial']);

  for (let i = 0; i < step_results.length; i++) {
    const step = step_results[i];
    if (step == null || typeof step !== 'object' || typeof step.step_id !== 'string') {
      errors.push(`step_results[${i}] is malformed: must be a non-null object with a string step_id`);
    }
  }

  const seenIds = new Set();
  for (const step of step_results) {
    if (step == null || typeof step !== 'object') continue;
    // F-70338558: a step without a string step_id is already reported as
    // malformed above; letting `undefined` into the dedupe Set made two
    // malformed steps emit a spurious `duplicate step_id: undefined`.
    if (typeof step.step_id !== 'string') continue;
    if (seenIds.has(step.step_id)) {
      errors.push(`duplicate step_id: ${step.step_id}`);
    }
    seenIds.add(step.step_id);
    if (step.status != null && !VALID_STATUSES.has(step.status)) {
      errors.push(`step "${step.step_id}" has unknown status: "${step.status}"`);
    }
  }

  // A scenario cannot be "pass" if any step is "fail" or "blocked"
  if (verdict === 'pass') {
    // Guard `s != null` to match the two sibling loops above: a null element is
    // already reported as malformed there, and dereferencing `s.status` here
    // would throw a TypeError that runValidator misclassifies as an operational
    // VALIDATOR_FAULT_STEPS instead of a submission-bad signal (verify-B-004).
    const failingSteps = step_results.filter(
      s => s != null && (s.status === 'fail' || s.status === 'blocked')
    );
    if (failingSteps.length > 0) {
      const ids = failingSteps.map(s => s.step_id).join(', ');
      errors.push(
        `scenario verdict is "pass" but steps [${ids}] have status fail/blocked`
      );
    }
  }

  // F-88fb37ff: mirror of the pass-direction check above. A scenario cannot
  // claim "fail"/"blocked" while every reported step says otherwise either —
  // computeVerdict() (validators/verdict.js) trusts scenario_results[].verdict
  // verbatim and never re-derives it from step_results, so without this check
  // a self-reported "blocked" verdict backed by zero failing/blocked steps
  // sailed through with no rejection reason at all.
  //
  // F-e42e8f80 (wave 20, amends F-88fb37ff): the original gate required at
  // least one step to ACTIVELY report fail/blocked, which wrongly rejected
  // the common honest shape "the scenario was blocked before any step could
  // run, so every step reports 'skip'" — 'skip' and 'partial' are NEUTRAL
  // (no evidence either way), not "evidence of no failure." Only 'pass' is an
  // ACTIVE CONTRADICTION of a fail/blocked verdict (the step ran and claimed
  // success). The gate now fires only when EVERY reported step actively says
  // "pass" — a single skip/partial/fail/blocked step is enough to keep a
  // fail/blocked verdict internally consistent.
  //
  // F-cc198701 (wave 22, confirming audit of F-e42e8f80): this condition and
  // its validateRequiredSteps mirror below enumerated only 2 of the 4 legal
  // values in scenario_results[].verdict's own schema enum (dogfood-record-
  // submission.schema.json: ["pass","fail","blocked","partial"]) — 'partial'
  // was never checked in either direction. A submitter could self-report
  // verdict:'partial' with EVERY step actively 'fail' (strictly worse,
  // more self-contradictory evidence than the fail/blocked direction already
  // rejects) and sail through with zero rejection reason, because
  // computeVerdict() never re-derives the verdict from step_results either —
  // the ONLY guard against a dishonest self-report was this exact check, and
  // it had a verdict-enum-shaped hole. Widened to also fire for 'partial',
  // reusing the identical "all present steps actively pass" bar: 'partial'
  // backed by zero non-pass evidence is exactly as self-contradictory as
  // 'blocked'/'fail' backed by zero non-pass evidence. Deliberately does NOT
  // touch the pass-direction check above (line ~59) — 'partial' backed by
  // SOME failing steps is not inherently contradictory the way 'partial'
  // backed by all-pass steps is.
  if (verdict === 'fail' || verdict === 'blocked' || verdict === 'partial') {
    const allStepsActivelyPass = step_results.every(
      s => s != null && s.status === 'pass'
    );
    if (allStepsActivelyPass) {
      errors.push(
        `scenario verdict is "${verdict}" but no step reports status fail/blocked`
      );
    }
  }

  return errors;
}

/**
 * Validate step results against a scenario definition's required_steps.
 *
 * F-3bfc2885: this is the REAL enforcement behind the `step-results-present`
 * and `step-verdict-consistent` global reject rules (policies/global-policy.yaml,
 * allowlisted in KNOWN_REJECT_RULE_IDS). verify() calls it per scenario_result
 * when the caller supplies loaded scenario definitions (options.scenarios).
 * Each error is tagged with the `[rule-id]` it enforces so operators can pivot
 * from a rejection reason straight to the policy rule.
 *
 * @param {object} scenarioResult - A single scenario_results[] item
 * @param {string[]} requiredSteps - Step IDs from scenario definition's success_criteria.required_steps
 * @returns {string[]} Array of error messages (empty if valid)
 */
export function validateRequiredSteps(scenarioResult, requiredSteps) {
  const errors = [];
  const { step_results, verdict } = scenarioResult;

  if (!step_results) return ['[step-results-present] step_results missing'];

  // F-ad98b5ac: build the map defensively — the same floor the sibling
  // validateStepResults applies (its verify-B-004 guard). A null / non-object /
  // string-step_id-less element must not throw a TypeError here: that TypeError
  // escapes to runValidator('steps', ...) which mislabels it as an operational
  // VALIDATOR_FAULT_STEPS, inverting a submission-bad signal into an ops fault
  // (the F-efe4f893 family inversion). Structural malformed-step *reporting*
  // stays validateStepResults' job; this only stops the map build from throwing.
  const resultMap = new Map();
  for (const s of step_results) {
    if (s != null && typeof s === 'object' && typeof s.step_id === 'string') {
      resultMap.set(s.step_id, s);
    }
  }

  // Every required step must have a matching step_result
  for (const stepId of requiredSteps) {
    const result = resultMap.get(stepId);
    if (!result) {
      errors.push(`[step-results-present] required step "${stepId}" has no matching step_result`);
    }
  }

  // A scenario cannot be "pass" if any required step is fail/blocked — or
  // absent entirely: validateStepResults' structural check only sees REPORTED
  // steps, so a submitter who silently omits a failing required step would
  // otherwise keep a "pass" verdict consistent (F-3bfc2885 sibling case).
  if (verdict === 'pass') {
    for (const stepId of requiredSteps) {
      const result = resultMap.get(stepId);
      if (!result) {
        errors.push(
          `[step-verdict-consistent] scenario verdict is "pass" but required step "${stepId}" has no step_result`
        );
      } else if (result.status === 'fail' || result.status === 'blocked') {
        errors.push(
          `[step-verdict-consistent] scenario verdict is "pass" but required step "${stepId}" has status "${result.status}"`
        );
      }
    }
  }

  // F-88fb37ff: mirror of the pass-direction block above, scoped to REQUIRED
  // steps (the sibling check in validateStepResults enforces the same rule
  // over ALL reported steps regardless of which are required).
  //
  // F-e42e8f80 (wave 20, amends F-88fb37ff): "no required step reports
  // fail/blocked" was too narrow a bar — a required step honestly reporting
  // 'skip' (never ran because the scenario was blocked upstream) or 'partial'
  // is NEUTRAL, not an active contradiction, and must not force a rejection.
  // The gate now fires only when every PRESENT required step actively says
  // "pass" — mirroring validateStepResults' all-pass bar. A required step
  // that is simply MISSING is "not an active pass" exactly like skip/partial
  // would be, so it never by itself forces this check to fire (`result !=
  // null && result.status === 'pass'` is false for a missing step too); its
  // absence is already rejected unconditionally by the [step-results-present]
  // loop above, regardless of verdict, so this check deliberately does not
  // pile a second, verdict-specific error onto the exact same gap.
  //
  // F-cc198701 (wave 22): mirrors the identical widening in
  // validateStepResults above — 'partial' was the one legal scenario-verdict
  // enum value this scoped-to-required-steps check never enumerated either.
  if ((verdict === 'fail' || verdict === 'blocked' || verdict === 'partial') && requiredSteps.length > 0) {
    const allPresentRequiredStepsActivelyPass = requiredSteps.every(stepId => {
      const result = resultMap.get(stepId);
      return result != null && result.status === 'pass';
    });
    if (allPresentRequiredStepsActivelyPass) {
      errors.push(
        `[step-verdict-consistent] scenario verdict is "${verdict}" but no required step reports status fail/blocked`
      );
    }
  }

  return errors;
}
