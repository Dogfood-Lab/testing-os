/**
 * Policy validator
 *
 * Evaluates a submission against global policy and optional repo policy.
 * Global rules are non-overridable. Repo policies add surface-specific requirements.
 */

import { evaluatePredicate, buildReason, PredicateError } from './predicate.js';

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    // Prototype-pollution guard: js-yaml's default schema lets attacker-controlled
    // policy YAML embed `__proto__` / `constructor` / `prototype` as object keys.
    // Recursing into those mutates `Object.prototype` for the verifier process,
    // which can flip policy_valid checks for every later submission. Drop the key.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Global reject-rule ids the build can account for. Two groups:
 *   - HANDLED HERE — enforced by the switch below.
 *   - ENFORCED ELSEWHERE — owned by another validator or by verify() itself
 *     (the switch's `default` arm intentionally no-ops them).
 *
 * PROACT-VERIFY-002: any `severity: reject` rule whose id is OUTSIDE this set is
 * an operator-added gate the build does not enforce. Silently no-op'ing it (the
 * old `default: break`) meant the rule looked active in global-policy.yaml but
 * never ran. We now surface an actionable diagnostic instead. Keep this set in
 * sync when a new reject rule gains real enforcement.
 */
const KNOWN_REJECT_RULE_IDS = new Set([
  // handled by the switch in validatePolicy
  'scenario-minimum',
  'blocked-needs-reason',
  // enforced by other validators or by verify() itself (default-arm no-op is correct)
  'schema-valid',
  'provenance-confirmed',
  // F-3bfc2885: enforced by validateRequiredSteps (validators/steps.js), which
  // verify() runs per scenario_result when the ingest layer supplies loaded
  // scenario definitions (options.scenarios). The structural half (non-empty
  // step_results, dup ids, pass-vs-fail over REPORTED steps) is
  // validateStepResults.
  'step-results-present',
  'step-verdict-consistent',
  'no-verdict-upgrade',
]);

// VERIFY-F1: `attested-if-human` is intentionally NOT in the set above. It used to
// be a switch arm; it is now enforced DECLARATIVELY (it carries a `when` predicate
// in policies/global-policy.yaml and flows through the engine). If it ever appears
// WITHOUT a `when` — a misconfigured migration — it falls to the default arm and is
// NOT in KNOWN_REJECT_RULE_IDS, so it surfaces the "no enforcement" diagnostic
// (fail-closed) instead of silently doing nothing.

/**
 * VERIFY-F1: evaluate a declarative rule's `when` predicate against each root and
 * return one reason string (`[id] body`) per match. Throws {@link PredicateError}
 * on a semantic fault; the caller decides whether that is operational (global rule)
 * or submission-bad (repo custom rule).
 */
function collectMatches(rule, roots, scope) {
  const reasons = [];
  for (const root of roots) {
    if (evaluatePredicate(rule.when, root, scope)) reasons.push(buildReason(rule, root));
  }
  return reasons;
}

/** Route matched reasons by severity. reject -> errors, warn -> warnings, info -> logged-only. */
function routeReasons(rule, reasons, errors, warnings) {
  if (rule.severity === 'reject') errors.push(...reasons);
  else if (rule.severity === 'warn') warnings.push(...reasons);
  // info: intentionally non-surfacing
}

/**
 * Resolve the effective surface policy for a given product surface.
 * Repo policy overrides global defaults per surface.
 *
 * @param {string} surface - Product surface name
 * @param {object} globalPolicy - Parsed global policy
 * @param {object|null} repoPolicy - Parsed repo policy
 * @returns {object} Resolved surface policy
 */
function resolveSurfacePolicy(surface, globalPolicy, repoPolicy) {
  const defaults = globalPolicy.defaults || {};

  if (repoPolicy?.surfaces?.[surface]) {
    return deepMerge(defaults, repoPolicy.surfaces[surface]);
  }

  return defaults;
}

/**
 * Evaluate a submission against policy.
 *
 * @param {object} submission - Source-authored submission
 * @param {object} options
 * @param {object} options.globalPolicy
 * @param {object|null} options.repoPolicy
 * @returns {{ valid: boolean, errors: string[], warnings: string[], configErrors: string[] }}
 *   `configErrors` (VERIFY-F1) are eval-time repo custom-rule predicate faults; the
 *   caller emits them with a `policy-config:` prefix (submission-bad). A non-empty
 *   `configErrors` makes `valid` false.
 * @throws {Error} F-3ef6b03e: a global rule declared `severity: reject` whose id
 *   is outside {@link KNOWN_REJECT_RULE_IDS} — a maintainer-authored
 *   global-policy.yaml gap, not a submission fault. Mirrors the GLOBAL-rule
 *   predicate-fault throw above: `runValidator('policy', ...)` in index.js
 *   wraps this as `VALIDATOR_FAULT_POLICY:`, which parseRejectionReason
 *   classifies 'operational' by family match. Pre-fix this pushed into
 *   `errors` under the `policy:` prefix, which parseRejectionReason
 *   classifies 'submission-bad' — telling every consumer in the fleet to fix
 *   a payload that was never the problem.
 */
export function validatePolicy(submission, { globalPolicy, repoPolicy }) {
  const errors = [];
  // VERIFY-F4: warn-severity rules record an accepted-with-warning note here
  // instead of being silently dropped. A populated warnings[] never affects
  // `valid` — the caller (index.js) routes it to verification.warnings.
  const warnings = [];
  // VERIFY-F1: a malformed REPO custom-rule predicate (an eval-time semantic fault
  // the schema could not catch — unknown leading field, numeric op vs non-number,
  // over-depth) is a `policy-config:` submission-bad reason recorded here (the repo
  // authored the bad rule; do NOT page studio ops). A non-empty configErrors flips
  // `valid` false (fail-closed). The caller prefixes these `policy-config: `, not
  // `policy: `. Global-rule predicate faults are NOT collected here — they throw
  // (-> VALIDATOR_FAULT_POLICY, operational).
  const configErrors = [];

  // --- Global rules (non-overridable) ---

  const globalRules = globalPolicy.global_rules || [];

  for (const rule of globalRules) {
    // VERIFY-F1: a rule carrying a `when` predicate is enforced DECLARATIVELY by
    // the engine; a rule WITHOUT `when` falls to the legacy severity handling +
    // id switch below (the seven built-ins that stay code-enforced). A GLOBAL-rule
    // predicate fault is allowed to THROW (-> VALIDATOR_FAULT_POLICY, operational):
    // a broken global policy is an operator/ops incident, mirroring loadGlobalPolicy's
    // fail-loud schema gate. scope 'scenario_result' evaluates per element in array
    // order (one reason per offending element); 'submission' (default) evaluates once.
    if (rule.when) {
      const scope = rule.scope || 'submission';
      const roots = scope === 'scenario_result'
        ? (submission.scenario_results || [])
        : [submission];
      routeReasons(rule, collectMatches(rule, roots, scope), errors, warnings);
      continue;
    }

    // VERIFY-F4: a global warn-rule is accepted-with-warning; an info-rule logs
    // only. Neither may reject. Mirrors the PROACT-VERIFY-002 discipline of not
    // dropping operator-authored rules on the floor: a declared rule that the
    // build does nothing with is invisible to the operator who wrote it.
    if (rule.severity === 'warn') {
      // F-57a0c0ad: bracketed `[id]` form — the same shape buildReason gives
      // declarative rules — so one grep pattern finds every rule-attributed
      // message regardless of how the rule is enforced.
      warnings.push(`[${rule.id}] ${rule.description || 'policy warning'}`);
      continue;
    }
    if (rule.severity === 'info') {
      // Logged only — info rules are intentionally non-surfacing in the record.
      continue;
    }
    if (rule.severity !== 'reject') continue;

    switch (rule.id) {
      case 'scenario-minimum':
        if (!submission.scenario_results || submission.scenario_results.length === 0) {
          errors.push(`[${rule.id}] ${rule.description}`);
        }
        break;

      // VERIFY-F1: the `attested-if-human` switch arm was removed in v1.7.0. The rule
      // is now enforced declaratively via a `when` predicate (see the `if (rule.when)`
      // branch above and policies/global-policy.yaml). The differential-equivalence
      // gate proves the declarative form is byte-identical to this removed arm.

      case 'blocked-needs-reason':
        for (const sr of submission.scenario_results || []) {
          if (sr.verdict === 'blocked' && !sr.blocking_reason) {
            errors.push(
              `[${rule.id}] scenario "${sr.scenario_id}": verdict is "blocked" but blocking_reason is missing`
            );
          }
        }
        break;

      // schema-valid, provenance-confirmed, step-results-present, step-verdict-consistent,
      // no-verdict-upgrade are enforced by other validators or the main verify() function.
      // PROACT-VERIFY-002 / F-3ef6b03e: a reject rule the build neither handles here NOR
      // enforces elsewhere would otherwise pass SILENTLY — the operator's new gate never
      // runs. THROW rather than push to `errors`: this is a maintainer-authored
      // global-policy.yaml gap (the same class of broken-policy-file fault
      // loadGlobalPolicy's schema gate already fails loud on), not a submission fault.
      // Pushing to `errors` would route through the `policy:` prefix — classified
      // 'submission-bad' by parseRejectionReason — telling the submitter to fix a
      // payload that was never the problem, fleet-wide, for every submission until a
      // maintainer notices. Throwing here mirrors the GLOBAL-rule predicate-fault
      // throw above: runValidator('policy', ...) in index.js wraps it as
      // `VALIDATOR_FAULT_POLICY:`, classified 'operational' — exit 2, nothing
      // persisted, no run_id poisoned via the duplicate guard (F-82429f90).
      default:
        if (!KNOWN_REJECT_RULE_IDS.has(rule.id)) {
          throw new Error(
            `rule "${rule.id}" is declared severity:reject but has no enforcement in this build — ` +
              `add an enforcement arm in validators/policy.js or register it in KNOWN_REJECT_RULE_IDS`
          );
        }
        break;
    }
  }

  // --- Surface-specific rules ---

  for (const sr of submission.scenario_results || []) {
    const surface = sr.product_surface;
    const surfacePolicy = resolveSurfacePolicy(surface, globalPolicy, repoPolicy);

    // Execution mode check
    const allowedModes = surfacePolicy.execution_mode_policy?.allowed;
    if (allowedModes && !allowedModes.includes(sr.execution_mode)) {
      errors.push(
        `surface[${surface}]: execution_mode "${sr.execution_mode}" not allowed (allowed: ${allowedModes.join(', ')})`
      );
    }

    // Evidence requirements
    const evidenceReqs = surfacePolicy.evidence_requirements;
    if (evidenceReqs) {
      const evidence = sr.evidence || [];

      if (evidenceReqs.min_evidence_count && evidence.length < evidenceReqs.min_evidence_count) {
        errors.push(
          `surface[${surface}]: requires ${evidenceReqs.min_evidence_count} evidence items, got ${evidence.length}`
        );
      }

      if (evidenceReqs.required_kinds) {
        const presentKinds = new Set(evidence.map(e => e.kind));
        for (const kind of evidenceReqs.required_kinds) {
          if (!presentKinds.has(kind)) {
            errors.push(`surface[${surface}]: required evidence kind "${kind}" is missing`);
          }
        }
      }

      // VERIFY-F2: tag gating. forbidden_tags rejects a scenario_result carrying
      // any listed tag; required_tags rejects one missing any listed tag (a
      // tagless scenario fails every required_tags rule). Tags are optional on
      // the scenario_result, so an absent `tags` array trips required_tags but
      // never forbidden_tags.
      const tags = new Set(sr.tags || []);

      if (evidenceReqs.forbidden_tags) {
        for (const tag of evidenceReqs.forbidden_tags) {
          if (tags.has(tag)) {
            errors.push(
              `surface[${surface}]: scenario "${sr.scenario_id}" carries forbidden tag "${tag}"`
            );
          }
        }
      }

      if (evidenceReqs.required_tags) {
        for (const tag of evidenceReqs.required_tags) {
          if (!tags.has(tag)) {
            errors.push(
              `surface[${surface}]: scenario "${sr.scenario_id}" is missing required tag "${tag}"`
            );
          }
        }
      }
    }

    // VERIFY-F1: declarative custom rules for this surface, evaluated per
    // scenario_result. Additive-only (reject/warn/info, no accept verb) so a repo
    // can never weaken a global gate. A predicate fault here is a `policy-config:`
    // submission-bad reason (the repo authored the bad rule), NOT an ops page.
    for (const customRule of surfacePolicy.custom_rules || []) {
      try {
        routeReasons(customRule, collectMatches(customRule, [sr], 'scenario_result'), errors, warnings);
      } catch (err) {
        if (err instanceof PredicateError) {
          configErrors.push(`rule "${customRule.id}": ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }

  const uniqueSurfaces = [...new Set((submission.scenario_results || []).map(sr => sr.product_surface))];

  for (const surface of uniqueSurfaces) {
    const surfacePolicy = resolveSurfacePolicy(surface, globalPolicy, repoPolicy);
    const ciReqs = surfacePolicy.ci_requirements;
    if (!ciReqs) continue;

    // F-3b34d51e: mirror coverage_min's missing-data contract. Pre-fix the
    // gate was `if (tests_must_pass && submission.ci_checks)` — omitting the
    // optional ci_checks field (or sending [] / no kind:'test' entries)
    // skipped the branch entirely and policy-validated clean under a
    // tests_must_pass:true surface. Require at least one kind:'test' check
    // whose status is not 'fail'; reject absent/empty/no-test-kind evidence.
    if (ciReqs.tests_must_pass) {
      const testChecks = (submission.ci_checks || []).filter(c => c.kind === 'test');
      if (testChecks.length === 0) {
        errors.push(
          `surface[${surface}]: tests_must_pass is true but no kind:test CI check provided`
        );
      } else {
        const failingTests = testChecks.filter(c => c.status === 'fail');
        if (failingTests.length > 0) {
          const ids = failingTests.map(c => c.id).join(', ');
          errors.push(`surface[${surface}]: CI tests must pass but [${ids}] failed`);
        }
      }
    }

    if (ciReqs.coverage_min != null) {
      const coverageCheck = submission.ci_checks?.find(c => c.kind === 'coverage');
      // ci_checks[].value is OPTIONAL in the submission schema (only id/kind/status
      // are required). A value-less coverage check must be treated the SAME as a
      // missing one: at the trust boundary the verifier rejects incomplete proof.
      // Without this guard, `undefined < coverage_min` is false (and a coerced
      // null/NaN is likewise not a real measurement), so the gate silently passed
      // with no measured coverage.
      const measured = coverageCheck && typeof coverageCheck.value === 'number'
        && Number.isFinite(coverageCheck.value);
      if (!coverageCheck || !measured) {
        errors.push(
          `surface[${surface}]: coverage_min is ${ciReqs.coverage_min}% but no coverage data provided`
        );
      } else if (coverageCheck.value < ciReqs.coverage_min) {
        errors.push(
          `surface[${surface}]: coverage ${coverageCheck.value}% is below minimum ${ciReqs.coverage_min}%`
        );
      }
    }
  }

  return {
    valid: errors.length === 0 && configErrors.length === 0,
    errors,
    warnings,
    configErrors,
  };
}
