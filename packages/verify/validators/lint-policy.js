/**
 * Policy lint (VERIFY-F3)
 *
 * `lintPolicy(policyDoc, { origin })` is the author-time check behind the
 * `dogfood-verify lint` verb: it validates a whole policy file WITHOUT a submission,
 * batch-reporting every fault. It is the `opa check` analogue named (as a deferred
 * companion) in docs/policy-dsl.md and specified in docs/policy-lint.md.
 *
 * Three passes, mirroring the runtime's own layering:
 *   1. Structural gate — `validatePayload('policy', …)` against policy.schema.json (the same
 *      gate loadGlobalPolicy / loadRepoPolicy run). Catches unknown op, malformed/banned field,
 *      mixed node, value-arity, custom_rules-under-defaults, additionalProperties.
 *   2. Static predicate walk — the data-independent semantic faults the schema cannot express:
 *      unknown leading field, combinator over-depth, node budget (via predicate.js#lintPredicate).
 *   3. `[]`-footgun advisory — a deterministic warning (never an error) on a negative op over a
 *      `[]` path (via predicate.js#findEmptyArrayFootguns).
 *
 * Coverage boundary (the VERIFY-F2 over-claim lesson): `type_mismatch` and `fanout_budget` are
 * DATA-DEPENDENT and cannot be caught statically. `coverageNote` says so — a clean lint is "no
 * static fault and no footgun," NOT "this policy can never produce a policy-config: rejection."
 */

import { validatePayload } from '@dogfood-lab/schemas';
import { lintPredicate, findEmptyArrayFootguns } from './predicate.js';

/** Stated in every lint result so a clean verdict is never read as full coverage. */
export const COVERAGE_NOTE =
  'Static lint only — it cannot catch a `type_mismatch` (a numeric op over a non-number field) ' +
  'or a `fanout_budget` overrun; both depend on submission data. Run ' +
  '`dogfood-verify --file <submission> --explain` to exercise the data-dependent path.';

/**
 * Lint a parsed policy document.
 *
 * @param {unknown} policyDoc - The parsed policy YAML/JSON (any value; a non-object is reported
 *   by the schema gate).
 * @param {{ origin?: 'global'|'repo'|'unknown' }} [opts] - The policy's origin, used only for
 *   reporting (the caller derives it from the file path).
 * @returns {{
 *   ok: boolean, origin: string, coverageNote: string,
 *   errors: { label: string, code: string, location: string, field?: string, message: string }[],
 *   warnings: { label: string, code: string, location: string, field: string, suggestion: string, message: string }[]
 * }} `ok` is true iff there are no errors; warnings (footguns) never affect `ok`.
 */
export function lintPolicy(policyDoc, { origin = 'unknown' } = {}) {
  const errors = [];
  const warnings = [];

  // 1. Structural schema gate.
  const schema = validatePayload('policy', policyDoc);
  for (const e of schema.errors) {
    errors.push({
      label: 'policy-schema:',
      code: e.keyword || 'schema',
      location: e.path || '/',
      message: e.message || 'schema violation',
    });
  }

  // 2 + 3. Static predicate walk + footgun advisory over every `when` location. Defensive: a
  // schema-invalid doc may have malformed predicates; the walkers tolerate non-objects.
  for (const { when, scope, location } of collectPredicates(policyDoc)) {
    for (const f of lintPredicate(when, scope)) {
      errors.push({ label: 'policy-config:', code: f.code, location, field: f.field, message: f.message });
    }
    for (const g of findEmptyArrayFootguns(when)) {
      warnings.push({
        label: 'policy-footgun:',
        code: 'footgun-empty-array',
        location,
        field: g.field,
        suggestion: g.suggestion,
        message:
          `negative operator "${g.op}" over the array path "${g.field}" fails OPEN on an empty or ` +
          `absent array — the rule silently does not fire when there are no elements`,
      });
    }
  }

  return { ok: errors.length === 0, origin, errors, warnings, coverageNote: COVERAGE_NOTE };
}

/**
 * Enumerate every `when` predicate in a policy with its evaluation scope and an operator-readable
 * location. Walks the SAME two locations the runtime evaluates (validators/policy.js):
 *   - `global_rules[].when` at scope `rule.scope || 'submission'`
 *   - `surfaces.<surface>.custom_rules[].when` at scope `scenario_result`
 * `custom_rules` under `defaults` is schema-forbidden, so it is not walked here — the structural
 * gate already reports it if present (matching the runtime, which never evaluates it).
 */
function* collectPredicates(policyDoc) {
  if (policyDoc === null || typeof policyDoc !== 'object') return;

  const globalRules = Array.isArray(policyDoc.global_rules) ? policyDoc.global_rules : [];
  for (let i = 0; i < globalRules.length; i++) {
    const rule = globalRules[i];
    if (rule && typeof rule === 'object' && rule.when != null) {
      yield {
        when: rule.when,
        scope: rule.scope || 'submission',
        location: `global_rules[${i}]${rule.id ? ` (${rule.id})` : ''}`,
      };
    }
  }

  const surfaces = policyDoc.surfaces && typeof policyDoc.surfaces === 'object' ? policyDoc.surfaces : {};
  for (const [surface, sp] of Object.entries(surfaces)) {
    const customRules = sp && Array.isArray(sp.custom_rules) ? sp.custom_rules : [];
    for (let i = 0; i < customRules.length; i++) {
      const rule = customRules[i];
      if (rule && typeof rule === 'object' && rule.when != null) {
        yield {
          when: rule.when,
          scope: 'scenario_result',
          location: `surfaces.${surface}.custom_rules[${i}]${rule.id ? ` (${rule.id})` : ''}`,
        };
      }
    }
  }
}
