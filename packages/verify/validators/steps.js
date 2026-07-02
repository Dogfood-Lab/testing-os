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

  const resultMap = new Map(step_results.map(s => [s.step_id, s]));

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

  return errors;
}
