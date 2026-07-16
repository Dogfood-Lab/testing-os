/**
 * Apply-back for accepted recommendations (F2-INTEL-003).
 *
 * The intelligence layer derives recommendations whose `action` describes a
 * concrete operational change: `{ type, target, details }` where
 *   type   ∈ add_check | add_scenario | set_policy | set_evidence |
 *            add_review_step | set_verification
 *   target ≤ 100 chars
 *   details = FREE TEXT (the human-readable intent)
 *
 * This module turns an ACCEPTED recommendation into an actual edit — but only
 * where it is safe and unambiguous. Honest partial automation, never a fake
 * auto-apply:
 *
 *   - Only `status === 'accepted'` is applicable. A candidate / rejected
 *     recommendation refuses with a structured error.
 *   - The only structurally-safe edit is adding the recommendation's `target`
 *     (a scenario / check id) to a named repo policy's
 *     `surfaces.<surface>.required_scenarios` list. `add_scenario` and
 *     `add_check` map to this; every other action type is free-text-only intent
 *     and REFUSES on --write with a hint to apply manually.
 *   - The free-text `details` is NEVER injected into the policy as logic — it is
 *     recorded as provenance only.
 *   - dry-run (default) renders the proposed change and writes nothing.
 *
 * Structured errors all carry { code, message, hint } so the CLI and any
 * programmatic caller see the same vocabulary.
 *
 * TEST_ROOT-safe: every path is derived from `rootDir`; no real-tree paths are
 * hard-coded.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { isUnsafeSegment } from '@dogfood-lab/ingest/lib/unsafe-segment.js';
import { atomicWriteFileSync } from '../lib/atomic-write.js';
import { findArtifactById } from '../review/review-artifacts.js';
import { createEvent, appendEvent } from '../review/event-log.js';

/**
 * Action types whose `target` is a structured id we can safely add to a policy's
 * required-scenarios list. Everything else is free-text-only intent.
 */
const STRUCTURED_LIST_ACTIONS = new Set(['add_scenario', 'add_check']);

function structuredError(code, message, hint) {
  return { success: false, error: { code, message, hint } };
}

/**
 * @param {string} rootDir
 * @param {object} params
 * @param {string} params.id - recommendation_id
 * @param {'dry-run'|'write'} [params.mode='dry-run']
 * @param {string} [params.actor='operator']
 * @param {string} [params.policyRepo] - org/repo naming the policy to edit (required for --write)
 * @returns {{ success: boolean, applied?: boolean, preview?: object, provenance?: object, error?: { code, message, hint } }}
 */
export function applyRecommendation(rootDir, params) {
  const { id } = params;
  const mode = params.mode || 'dry-run';
  const actor = params.actor || 'operator';

  if (!id) {
    return structuredError('RECOMMENDATION_ID_REQUIRED', 'id is required', 'Pass the recommendation_id to apply.');
  }

  // Load the recommendation.
  const found = findArtifactById(rootDir, 'recommendation', id);
  if (!found) {
    return structuredError(
      'RECOMMENDATION_NOT_FOUND',
      `recommendation not found: ${id}`,
      'Run `findings recommendations list` to see available ids.'
    );
  }
  const rec = found.data;

  // Applicability gate — only accepted recommendations are applicable.
  if (rec.status !== 'accepted') {
    return structuredError(
      'RECOMMENDATION_NOT_ACCEPTED',
      `recommendation ${id} has status "${rec.status}" — only accepted recommendations can be applied`,
      'Accept it first: `findings recommendations accept ' + id + ' --actor <name>`.'
    );
  }

  const action = rec.action || {};
  const surfaces = rec.applies_to?.product_surfaces || [];

  // findings-A-001 — path-traversal guard on the operator-supplied --policy
  // <org/repo>. `policyPathFor` resolves `policies/repos/<org>/<repo>.yaml`; an
  // org/repo carrying `..` or a separator would escape the policies tree on
  // BOTH the dry-run (path leaked in preview) and write (file touched) paths,
  // so reject here before either branch resolves a path.
  //
  // F-853dbce9: the two-segment repo contract (F-54e5fde7 / V2-CROSS-BO-003)
  // was NOT enforced here — the bare 2-way destructure silently DROPS every
  // segment past the second, so `--policy group/subgroup/project` yielded
  // pOrg='group', pRepo='subgroup' and resolved a DIFFERENT repo's policy
  // file than the operator named, with no error on either the dry-run
  // preview or the --write path. Matches persist.js:51's `segments.length
  // !== 2` guard verbatim so the family reads identically.
  if (params.policyRepo) {
    const segments = String(params.policyRepo).split('/');
    if (segments.length !== 2) {
      return structuredError(
        'RECOMMENDATION_UNSAFE_POLICY',
        `policy repo "${params.policyRepo}" is not a two-segment org/repo slug`,
        'Nested GitLab subgroups are unsupported — pass --policy <org>/<repo>.'
      );
    }
    const [pOrg, pRepo] = segments;
    if (!pOrg || !pRepo || isUnsafeSegment(pOrg) || isUnsafeSegment(pRepo)) {
      return structuredError(
        'RECOMMENDATION_UNSAFE_POLICY',
        `policy repo "${params.policyRepo}" is not a safe org/repo path segment`,
        'Pass --policy <org/repo> with no ".." or path separators inside the org or repo name.'
      );
    }
  }

  // Build the resolution context shared by dry-run and write.
  const isStructured = STRUCTURED_LIST_ACTIONS.has(action.type);
  const surface = surfaces.length === 1 ? surfaces[0] : null;

  // ── dry-run: render the proposed change, write nothing ──────────────
  if (mode !== 'write') {
    const policyPath = params.policyRepo ? policyPathFor(rootDir, params.policyRepo) : null;
    return {
      success: true,
      applied: false,
      preview: {
        recommendationId: id,
        actionType: action.type,
        target: action.target,
        details: action.details,
        surface: surface,
        surfaces,
        autoApplicable: isStructured && !!surface,
        policyRepo: params.policyRepo || null,
        policyPath: policyPath,
        field: isStructured ? `surfaces.${surface || '<surface>'}.required_scenarios` : null,
        note: isStructured
          ? (surface
            ? `Would add "${action.target}" to required_scenarios for surface "${surface}". Free-text details recorded as provenance only.`
            : `Action is structurally applicable but the recommendation spans ${surfaces.length} surface(s); --write needs a single surface.`)
          : `Action type "${action.type}" is free-text-only intent — review the details and apply manually. --write will refuse.`
      }
    };
  }

  // ── write: apply ONLY the safe, unambiguous structured intent ───────

  // Free-text-only intent (set_policy / set_evidence / set_verification /
  // add_review_step) cannot be safely auto-applied.
  if (!isStructured) {
    return structuredError(
      'RECOMMENDATION_NOT_AUTO_APPLICABLE',
      `recommendation ${id} action type "${action.type}" carries free-text-only intent`,
      `The intent lives in action.details, which must not be injected as policy logic. Apply manually: "${action.details}".`
    );
  }

  // Need a named policy to edit.
  if (!params.policyRepo) {
    return structuredError(
      'RECOMMENDATION_AMBIGUOUS_TARGET',
      `recommendation ${id} does not name a policy to edit`,
      'Pass --policy <org/repo> to name the repo policy whose required_scenarios should gain "' + action.target + '".'
    );
  }

  // Need an unambiguous surface.
  if (!surface) {
    return structuredError(
      'RECOMMENDATION_AMBIGUOUS_TARGET',
      `recommendation ${id} applies to ${surfaces.length} surface(s) — cannot pick one automatically`,
      'Narrow the recommendation to a single product_surface, then re-run, or edit the policy manually.'
    );
  }

  if (!action.target) {
    return structuredError(
      'RECOMMENDATION_AMBIGUOUS_TARGET',
      `recommendation ${id} has no action.target id to add`,
      'A structured add_scenario/add_check action must carry a target id. Apply manually.'
    );
  }

  // Load the named policy.
  const policyPath = policyPathFor(rootDir, params.policyRepo);
  if (!existsSync(policyPath)) {
    return structuredError(
      'RECOMMENDATION_TARGET_POLICY_MISSING',
      `policy not found for ${params.policyRepo} at ${policyPath}`,
      'Create the repo policy first, or pass a --policy that exists.'
    );
  }

  let policy;
  try {
    policy = yaml.load(readFileSync(policyPath, 'utf-8')) || {};
  } catch (err) {
    return structuredError(
      'RECOMMENDATION_TARGET_POLICY_UNREADABLE',
      `could not parse policy ${params.policyRepo}: ${err.message}`,
      'Fix the policy YAML, then re-run.'
    );
  }

  // Apply the structured intent: add target to surfaces.<surface>.required_scenarios.
  //
  // F-5dfddcb5: policy.surfaces is a dynamic-key container (`[surface]`,
  // below) built from a value this module does not itself constrain to a
  // safe enum — Object.create(null) so a `surface` value of '__proto__'
  // reassigns an own data property instead of the object's [[Prototype]].
  // Mirrors the identical fix already shipped in this domain for the same
  // assignment shape: packages/ingest/rebuild-indexes.js (F-89b7dcd5),
  // packages/portfolio/lib/compute-trends.js (F-a853fcaa). Not reachable
  // today — `surface` comes from `rec.applies_to.product_surfaces`, which is
  // schema-enum-constrained — but this is the same defense-in-depth posture
  // the sibling fixes already established for this pattern.
  if (!policy.surfaces) policy.surfaces = Object.create(null);
  if (!policy.surfaces[surface]) policy.surfaces[surface] = {};
  if (!Array.isArray(policy.surfaces[surface].required_scenarios)) {
    policy.surfaces[surface].required_scenarios = [];
  }
  const list = policy.surfaces[surface].required_scenarios;
  const alreadyPresent = list.includes(action.target);
  if (!alreadyPresent) list.push(action.target);

  // Record provenance — recommendation_id + (free-text) details, kept OUT of any
  // logic field. Stored under a dedicated `applied_recommendations` map keyed by
  // the scenario id so it is auditable but never interpreted by the policy
  // engine. The free-text details live here as a human note, never as a rule.
  //
  // F-5dfddcb5: Object.create(null), not {} — action.target is FREE TEXT
  // (≤100 chars, no enum constraint, per this file's own header docstring)
  // used as the dynamic key immediately below. On a plain {}, the bracket
  // assignment `container['__proto__'] = provenance` does not create an own
  // '__proto__' data property — it invokes Object.prototype's __proto__
  // SETTER, which reassigns the CONTAINER's own [[Prototype]] to the
  // provenance object. The write silently vanishes (Object.keys() stays [])
  // and the container starts inheriting provenance's own properties instead
  // — confirmed with a standalone probe matching this exact single-assignment
  // shape. (This is scoped to the one container object, not a write onto the
  // shared, global Object.prototype — that stronger form needs a read-then-
  // write through an unguarded lookup, which is a different pattern.)
  // Object.create(null) removes the [[Prototype]] chain entirely, so
  // '__proto__' is just an ordinary key. NOT reachable from untrusted input
  // today — the only current producer (recommendation-derivation.js's
  // selectTemplate()) emits hardcoded literal targets — but a future
  // template letting action.target reflect free-form scenario-id-shaped text
  // must not silently reopen this class. Mirrors the identical fix already
  // shipped for this pattern: packages/ingest/rebuild-indexes.js
  // (F-89b7dcd5), packages/portfolio/lib/compute-trends.js (F-a853fcaa).
  if (!policy.applied_recommendations) policy.applied_recommendations = Object.create(null);
  const provenance = {
    recommendation_id: id,
    action_type: action.type,
    target: action.target,
    surface,
    details: action.details,
    applied_by: actor,
    applied_at: new Date().toISOString()
  };
  policy.applied_recommendations[action.target] = provenance;

  // NOTE: provenance is intentionally written under a NON-schema key. The policy
  // schema (`policy.schema.json`) has `additionalProperties: false`, so a real
  // policy would reject `applied_recommendations`. We keep the provenance OUT of
  // the validated surface by returning it on the result for the operator and the
  // event log, and we strip it before persisting so the policy stays schema-valid.
  const persistable = { ...policy };
  delete persistable.applied_recommendations;

  atomicWriteFileSync(policyPath, yaml.dump(persistable, { lineWidth: 120, noRefs: true }));

  // Log an apply event (recommendation review-event shape; action 'apply').
  const event = createEvent({
    artifactId: id,
    artifactKind: 'recommendation',
    actor,
    action: 'apply',
    fromStatus: 'accepted',
    toStatus: 'accepted',
    notes: `Applied ${action.type} target=${action.target} to ${params.policyRepo} surface=${surface}`
  });
  appendEvent(rootDir, event);

  return {
    success: true,
    applied: true,
    alreadyPresent,
    policyPath,
    provenance
  };
}

/**
 * Resolve the on-disk path for a repo policy under rootDir.
 *
 * F-853dbce9: fails closed on the same two-segment invariant the guard above
 * enforces, rather than trusting every caller to have checked first —
 * mirrors persist.js's computeRecordPath, which owns this same invariant at
 * the write layer instead of trusting its own callers. Both of this
 * function's current callers (the dry-run preview and the --write path) are
 * already gated by the guard above, so this throw is defense-in-depth, not
 * the primary enforcement point — but a future call site that skips the
 * guard must fail loud here, not silently resolve a different repo's file.
 */
function policyPathFor(rootDir, orgRepo) {
  const segments = String(orgRepo).split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error(`policy repo "${orgRepo}" is not a two-segment org/repo slug`);
  }
  const [org, repo] = segments;
  return resolve(rootDir, 'policies', 'repos', org, `${repo}.yaml`);
}
