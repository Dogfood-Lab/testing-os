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
  if (!policy.surfaces) policy.surfaces = {};
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
  if (!policy.applied_recommendations) policy.applied_recommendations = {};
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

/** Resolve the on-disk path for a repo policy under rootDir. */
function policyPathFor(rootDir, orgRepo) {
  const [org, repo] = orgRepo.split('/');
  return resolve(rootDir, 'policies', 'repos', org, `${repo}.yaml`);
}
