/**
 * Policy validator
 *
 * Evaluates a submission against global policy and optional repo policy.
 * Global rules are non-overridable. Repo policies add surface-specific requirements.
 */

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
  'attested-if-human',
  'blocked-needs-reason',
  // enforced by other validators or by verify() itself (default-arm no-op is correct)
  'schema-valid',
  'provenance-confirmed',
  'step-results-present',
  'step-verdict-consistent',
  'no-verdict-upgrade',
]);

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
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePolicy(submission, { globalPolicy, repoPolicy }) {
  const errors = [];

  // --- Global rules (non-overridable) ---

  const globalRules = globalPolicy.global_rules || [];

  for (const rule of globalRules) {
    if (rule.severity !== 'reject') continue;

    switch (rule.id) {
      case 'scenario-minimum':
        if (!submission.scenario_results || submission.scenario_results.length === 0) {
          errors.push(`[${rule.id}] ${rule.description}`);
        }
        break;

      case 'attested-if-human':
        for (const sr of submission.scenario_results || []) {
          if ((sr.execution_mode === 'human' || sr.execution_mode === 'mixed') && !sr.attested_by) {
            errors.push(
              `[${rule.id}] scenario "${sr.scenario_id}": execution_mode is "${sr.execution_mode}" but attested_by is missing`
            );
          }
        }
        break;

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
      // PROACT-VERIFY-002: a reject rule the build neither handles here NOR enforces
      // elsewhere would otherwise pass SILENTLY — the operator's new gate never runs.
      // Reject the submission with a diagnostic naming the unenforced rule so the gap
      // is visible instead of failing open.
      default:
        if (!KNOWN_REJECT_RULE_IDS.has(rule.id)) {
          // No `policy:` prefix here — index.js prepends it to every policy
          // error (mirrors the `[rule.id]` / `surface[...]` messages above).
          errors.push(
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
    }
  }

  const uniqueSurfaces = [...new Set((submission.scenario_results || []).map(sr => sr.product_surface))];

  for (const surface of uniqueSurfaces) {
    const surfacePolicy = resolveSurfacePolicy(surface, globalPolicy, repoPolicy);
    const ciReqs = surfacePolicy.ci_requirements;
    if (!ciReqs) continue;

    if (ciReqs.tests_must_pass && submission.ci_checks) {
      const failingTests = submission.ci_checks.filter(
        c => c.kind === 'test' && c.status === 'fail'
      );
      if (failingTests.length > 0) {
        const ids = failingTests.map(c => c.id).join(', ');
        errors.push(`surface[${surface}]: CI tests must pass but [${ids}] failed`);
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

  return { valid: errors.length === 0, errors };
}
