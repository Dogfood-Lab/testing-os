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
      // no-verdict-upgrade are enforced by other validators or the main verify() function
      default:
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
      if (!coverageCheck) {
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
