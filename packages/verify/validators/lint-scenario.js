/**
 * Scenario lint (F-BACKEND-003)
 *
 * `lintScenario(scenarioDoc, { file })` is the author-time check behind the
 * `dogfood-verify lint --scenario <file>` mode: it validates a whole scenario
 * definition WITHOUT a submission, batch-reporting every fault. It is the
 * scenario-side sibling of lint-policy.js (VERIFY-F3) and shares its shape,
 * exit contract, and honest-coverage discipline.
 *
 * Three passes, mirroring lint-policy's layering:
 *   1. Structural gate — `validatePayload('scenario', …)` against scenario.schema.json
 *      (the same registered schema production ingest uses to fetch + validate a
 *      committed scenario). Catches missing required fields, bad enums, pattern
 *      violations, additionalProperties, the verifiable⇒expected conditional.
 *   2. Author-time value checks the schema cannot express (errors, `scenario-config:`):
 *      required_steps referencing an undeclared step id, and duplicate step ids.
 *      The scenario schema literally says required_steps "Must reference valid step
 *      IDs" but JSON Schema cannot enforce a cross-field id reference, and it
 *      validates each step in isolation so it cannot see a repeated id.
 *   3. `filename → scenario_id` advisory (a WARNING, never an error,
 *      `scenario-footgun:`): the receiver fetches dogfood/scenarios/<scenario_id>.yaml,
 *      so a basename that differs from scenario_id makes the committed definition
 *      unreachable and required-steps enforcement silently fails open.
 *
 * Coverage boundary (the VERIFY-F2 over-claim lesson): a clean scenario lint is
 * "no static fault," NOT "a real submission will satisfy this scenario." Static
 * lint validates the definition in isolation; it cannot verify that a submission's
 * step_results actually satisfy required_steps, nor that the receiver can reach the
 * file at the attested commit. `coverageNote` says so.
 */

import { basename } from 'node:path';

import { validatePayload } from '@dogfood-lab/schemas';

/** Stated in every scenario lint result so a clean verdict is never read as full coverage. */
export const SCENARIO_COVERAGE_NOTE =
  'Static lint only — it validates the scenario DEFINITION in isolation. It cannot verify that a ' +
  "real submission's `step_results` actually satisfy `required_steps`, nor that the receiver can " +
  'fetch this file at the attested commit (the filename → scenario_id check is a heuristic, not a ' +
  'guarantee). Run a real ingest of a submission for that.';

/**
 * Lint a parsed scenario document.
 *
 * @param {unknown} scenarioDoc - The parsed scenario YAML/JSON (any value; a non-object is
 *   reported by the schema gate).
 * @param {{ file?: string }} [opts] - The source file path (basename → scenario_id advisory).
 *   When absent, the filename check is skipped (there is no basename to compare).
 * @returns {{
 *   ok: boolean, origin: 'scenario', coverageNote: string,
 *   errors: { label: string, code: string, location: string, field?: string, message: string }[],
 *   warnings: { label: string, code: string, location: string, field: string, suggestion: string, message: string }[]
 * }} `ok` is true iff there are no errors; warnings never affect `ok`.
 */
export function lintScenario(scenarioDoc, { file } = {}) {
  const errors = [];
  const warnings = [];

  // 1. Structural schema gate.
  const schema = validatePayload('scenario', scenarioDoc);
  for (const e of schema.errors) {
    errors.push({
      label: 'scenario-schema:',
      code: e.keyword || 'schema',
      location: e.path || '/',
      message: e.message || 'schema violation',
    });
  }

  // 2. Author-time value checks. Defensive: a schema-invalid doc may have a malformed or
  // missing steps/success_criteria, so guard every access against non-arrays/non-objects
  // (mirrors collectPredicates' defensiveness in lint-policy.js).
  const doc = scenarioDoc && typeof scenarioDoc === 'object' ? scenarioDoc : {};
  const steps = Array.isArray(doc.steps) ? doc.steps : [];

  // Collect declared step ids, flagging duplicates as we go. A repeated id validates clean
  // structurally (the schema checks each step in isolation) but is ambiguous at runtime: a
  // step_result keyed by that id cannot say which step it satisfied.
  const declaredIds = new Set();
  const seenIds = new Set();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const id = step.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    declaredIds.add(id);
    if (seenIds.has(id)) {
      errors.push({
        label: 'scenario-config:',
        code: 'duplicate_step_id',
        location: `steps[${i}]`,
        field: id,
        message: `step id "${id}" is declared more than once — step ids must be unique so a step_result can name exactly one step`,
      });
    }
    seenIds.add(id);
  }

  // required_steps must reference a declared step id. The scenario schema says so in prose but
  // cannot enforce a cross-field id reference.
  const sc = doc.success_criteria && typeof doc.success_criteria === 'object' ? doc.success_criteria : {};
  const requiredSteps = Array.isArray(sc.required_steps) ? sc.required_steps : [];
  for (let i = 0; i < requiredSteps.length; i++) {
    const ref = requiredSteps[i];
    if (typeof ref !== 'string') continue; // a non-string entry is a schema fault, already reported above
    if (!declaredIds.has(ref)) {
      errors.push({
        label: 'scenario-config:',
        code: 'required_step_undeclared',
        location: `success_criteria.required_steps[${i}]`,
        field: ref,
        message: `required step "${ref}" is not declared by any steps[].id — the scenario can never pass because the receiver enforces a step the exercise never runs`,
      });
    }
  }

  // 3. filename → scenario_id advisory. The receiver fetches dogfood/scenarios/<scenario_id>.yaml,
  // so a mismatch makes the committed definition unreachable and required-steps enforcement fails
  // OPEN silently. Advisory only — a repo may legitimately hold a scenario under a different name
  // during authoring (e.g. examples/scenario.example.yaml holds scenario_id "cli-smoke").
  const scenarioId = doc.scenario_id;
  if (file && typeof scenarioId === 'string' && scenarioId.length > 0) {
    const base = basename(String(file)).replace(/\.ya?ml$/i, '');
    if (base !== scenarioId) {
      warnings.push({
        label: 'scenario-footgun:',
        code: 'filename_scenario_id_mismatch',
        location: '/',
        field: 'scenario_id',
        suggestion: `rename the file to "${scenarioId}.yaml" (or change scenario_id to "${base}")`,
        message:
          `the file basename "${base}" does not match scenario_id "${scenarioId}" — the receiver ` +
          `fetches dogfood/scenarios/${scenarioId}.yaml, so this committed definition is unreachable ` +
          `and required-steps enforcement silently fails OPEN`,
      });
    }
  }

  return { ok: errors.length === 0, origin: 'scenario', errors, warnings, coverageNote: SCENARIO_COVERAGE_NOTE };
}
