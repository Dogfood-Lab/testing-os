/**
 * Review engine for dogfood findings.
 *
 * Performs operator actions (accept, reject, edit, merge, reopen, invalidate, supersede)
 * with state-machine enforcement, event logging, and artifact mutation.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { validateTransition, ACTION_TARGET_STATUS, REASON_REQUIRED, REQUIRES_ACCEPTED, REQUIRES_CLOSED } from './transitions.js';
import { createEvent, appendEvent } from './event-log.js';
import { parseFinding, validateFinding } from '../validate.js';
import { findById, loadFindings } from '../reader.js';
import { atomicWriteFileSync } from '../lib/atomic-write.js';

/**
 * Perform a review action on a finding.
 *
 * @param {string} rootDir - dogfood-labs repo root
 * @param {object} params
 * @param {string} params.findingId
 * @param {string} params.action - review|accept|reject|edit|merge|reopen|invalidate|supersede
 * @param {string} params.actor
 * @param {string} [params.reason]
 * @param {string} [params.rejectReason] - structured reject reason enum
 * @param {object} [params.fieldChanges] - { fieldName: newValue }
 * @param {string[]} [params.mergeSourceIds] - for merge action
 * @param {string} [params.supersededBy] - for supersede action
 * @param {string} [params.notes]
 * @returns {{ success: boolean, error?: string, finding?: object, event?: object }}
 */
export function performAction(rootDir, params) {
  const { findingId, action, actor } = params;

  if (!findingId) return { success: false, error: 'findingId is required' };
  if (!action) return { success: false, error: 'action is required' };
  if (!actor) return { success: false, error: 'actor is required' };

  // Load the finding
  const result = findById(rootDir, findingId);
  if (!result) return { success: false, error: `Finding not found: ${findingId}` };

  const finding = result.data;
  const filePath = result.path;
  const fromStatus = finding.status;

  // Enforce reason requirement
  if (REASON_REQUIRED.has(action) && !params.reason) {
    return { success: false, error: `Action "${action}" requires a reason` };
  }

  // Enforce accepted-only actions
  if (REQUIRES_ACCEPTED.has(action) && fromStatus !== 'accepted') {
    return { success: false, error: `Action "${action}" requires status "accepted", got "${fromStatus}"` };
  }

  // Enforce closed-only actions (reopen)
  if (REQUIRES_CLOSED.has(action) && fromStatus !== 'accepted' && fromStatus !== 'rejected') {
    return { success: false, error: `Action "${action}" requires status "accepted" or "rejected", got "${fromStatus}"` };
  }

  // Determine target status
  let toStatus = ACTION_TARGET_STATUS[action];
  if (toStatus === null) {
    // Edit preserves current status
    toStatus = fromStatus;
  }

  // Validate transition (except edit which doesn't change status)
  if (action !== 'edit' && toStatus !== fromStatus) {
    const transResult = validateTransition(fromStatus, toStatus);
    if (!transResult.valid) {
      return { success: false, error: transResult.error };
    }
  }

  // Build field changes for edit action
  const fieldChanges = {};
  if (action === 'edit' && params.fieldChanges) {
    for (const [field, newValue] of Object.entries(params.fieldChanges)) {
      // Prototype-pollution guard: `field` is operator-supplied via CLI/API.
      // Writing to `__proto__` / `constructor` / `prototype` would mutate
      // Object.prototype for the review-engine process and silently corrupt
      // every downstream YAML dump + reload. Reject these keys outright so
      // the operator sees a structured error instead of a poisoned process.
      if (field === '__proto__' || field === 'constructor' || field === 'prototype') {
        return { success: false, error: `Field "${field}" is not editable (reserved/unsafe key)` };
      }
      const oldValue = finding[field];
      if (oldValue !== newValue) {
        fieldChanges[field] = { from: oldValue, to: newValue };
        finding[field] = newValue;
      }
    }
  }

  // Apply status change
  finding.status = toStatus;

  // Apply review metadata
  const now = new Date().toISOString();

  // H4 / F-stage-a-h4 — auto-populate review.reject_reason whenever the
  // target status is 'rejected'. Pre-amend, the engine only set the field
  // for `action === 'reject'` and silently produced rejected findings on
  // merge / supersede without a structured reason. The H4 schema if/then
  // would then reject those findings at the contract boundary — but the
  // engine was producing them. The fix:
  //
  //   - Operator-supplied `params.rejectReason` always wins (override).
  //   - `merge` and `supersede` auto-default to `'merged_into_canonical'`
  //     since lineage already carries `superseded_by` / `merged_from`.
  //   - For `action === 'reject'`, the engine does NOT invent a default —
  //     defaulting would erase operator intent. F-FIND-001 supersedes the
  //     earlier "test-and-tell" path: rather than persisting a finding with
  //     no reject_reason and letting the operator discover it downstream, the
  //     write-side schema gate below refuses the write at the point of action,
  //     so the operator gets a structured error and the canonical store never
  //     holds a malformed finding. (See h4-engine-auto-reject-reason.test.js.)
  let effectiveRejectReason = params.rejectReason;
  if (!effectiveRejectReason && toStatus === 'rejected' && (action === 'merge' || action === 'supersede')) {
    effectiveRejectReason = 'merged_into_canonical';
  }

  finding.review = {
    reviewed_by: actor,
    reviewed_at: now,
    last_action: action,
    ...(params.reason ? { decision_reason: params.reason } : {}),
    ...(params.notes ? { review_notes: params.notes } : {}),
    ...(effectiveRejectReason ? { reject_reason: effectiveRejectReason } : {})
  };

  // Update timestamps
  finding.updated_at = now;

  // Handle invalidation
  if (action === 'invalidate') {
    finding.invalidation = {
      is_invalidated: true,
      invalidated_at: now,
      reason: params.reason
    };
  }

  // Handle supersede
  if (action === 'supersede') {
    if (!params.supersededBy) {
      return { success: false, error: 'supersede action requires supersededBy' };
    }
    if (!finding.lineage) finding.lineage = {};
    finding.lineage.superseded_by = params.supersededBy;
  }

  // Create review event
  const event = createEvent({
    findingId,
    actor,
    action,
    fromStatus,
    toStatus,
    reason: params.reason,
    fieldChanges: Object.keys(fieldChanges).length > 0 ? fieldChanges : undefined,
    mergedFromIds: params.mergeSourceIds,
    notes: params.notes
  });

  // F-FIND-001 — schema gate BEFORE the filesystem touch. Every sibling
  // finding writer (derive writeFinding, synthesis writePattern/...) validates
  // first so no path can persist a malformed finding; the review engine was the
  // last on-disk finding writer missing the gate. An operator edit with a
  // typo'd enum or an unknown field is refused here instead of silently
  // corrupting the canonical store. Return-shaped (not thrown) to match this
  // function's `{ success, error }` contract.
  const validation = validateFinding(finding);
  if (!validation.valid) {
    const summary = validation.errors.map(e => `${e.path || '/'} ${e.message}`).join('; ');
    return { success: false, error: `Refused: edit would persist a schema-invalid finding: ${summary}` };
  }

  const clean = JSON.parse(JSON.stringify(finding));
  const body = yaml.dump(clean, { lineWidth: 120, noRefs: true });

  // F-FIND-002 — append the audit event BEFORE the artifact write. The trail is
  // append-only and the package advertises a complete one; the unsafe
  // asymmetry is a persisted state change with no event. Appending first means
  // an append failure aborts before the artifact lands (no silent desync); the
  // only residual asymmetry is an event with no state change, which the
  // append-only reader tolerates and an operator can reconcile.
  appendEvent(rootDir, event);
  atomicWriteFileSync(filePath, body);

  return { success: true, finding, event };
}

/**
 * Merge multiple findings into one canonical finding.
 *
 * @param {string} rootDir
 * @param {object} params
 * @param {string[]} params.sourceIds - Finding IDs to merge
 * @param {string} params.canonicalId - Target finding ID (must exist or be one of sourceIds)
 * @param {string} params.actor
 * @param {string} params.reason
 * @returns {{ success: boolean, error?: string, canonical?: object, events?: object[] }}
 */
export function performMerge(rootDir, params) {
  const { sourceIds, canonicalId, actor, reason } = params;

  if (!sourceIds?.length || sourceIds.length < 2) {
    return { success: false, error: 'Merge requires at least 2 source finding IDs' };
  }
  if (!canonicalId) return { success: false, error: 'canonicalId is required' };
  if (!actor) return { success: false, error: 'actor is required' };
  if (!reason) return { success: false, error: 'Merge requires a reason' };

  // Load all source findings
  const sources = [];
  for (const id of sourceIds) {
    const result = findById(rootDir, id);
    if (!result) return { success: false, error: `Source finding not found: ${id}` };
    sources.push(result);
  }

  // Find canonical (must be one of the sources)
  const canonicalResult = sources.find(s => s.data.finding_id === canonicalId);
  if (!canonicalResult) {
    return { success: false, error: `Canonical ID "${canonicalId}" must be one of the source IDs` };
  }

  const canonical = canonicalResult.data;
  const nonCanonical = sources.filter(s => s.data.finding_id !== canonicalId);

  // Merge evidence and source_record_ids into canonical
  const mergedRecordIds = new Set(canonical.source_record_ids || []);
  const mergedEvidence = [...(canonical.evidence || [])];
  const mergedScenarioIds = new Set(canonical.scenario_ids || []);

  for (const s of nonCanonical) {
    for (const rid of (s.data.source_record_ids || [])) mergedRecordIds.add(rid);
    for (const sid of (s.data.scenario_ids || [])) mergedScenarioIds.add(sid);
    for (const ev of (s.data.evidence || [])) {
      // Dedupe evidence by kind+record_id+scenario_id
      const key = `${ev.evidence_kind}:${ev.record_id || ''}:${ev.scenario_id || ''}`;
      const exists = mergedEvidence.some(e =>
        `${e.evidence_kind}:${e.record_id || ''}:${e.scenario_id || ''}` === key
      );
      if (!exists) mergedEvidence.push(ev);
    }
  }

  // Update canonical
  canonical.source_record_ids = [...mergedRecordIds];
  canonical.scenario_ids = [...mergedScenarioIds];
  canonical.evidence = mergedEvidence;
  canonical.lineage = {
    ...(canonical.lineage || {}),
    merged_from: nonCanonical.map(s => s.data.finding_id)
  };

  const now = new Date().toISOString();
  canonical.updated_at = now;
  canonical.review = {
    reviewed_by: actor,
    reviewed_at: now,
    last_action: 'merge',
    decision_reason: reason
  };

  // F-FIND-001 — schema gate the canonical BEFORE any write. The merge mutates
  // source_record_ids / evidence / lineage / review; a malformed result must
  // never reach disk. Matches the singleton writers and `performAction`.
  const validation = validateFinding(canonical);
  if (!validation.valid) {
    const summary = validation.errors.map(e => `${e.path || '/'} ${e.message}`).join('; ');
    return { success: false, error: `Refused: merge would persist a schema-invalid canonical: ${summary}` };
  }

  const cleanCanonical = JSON.parse(JSON.stringify(canonical));
  const canonicalBody = yaml.dump(cleanCanonical, { lineWidth: 120, noRefs: true });

  // F-FIND-002 — append the canonical merge event BEFORE the canonical write
  // (same ordering rationale as performAction). An append failure aborts before
  // the canonical or any source mutation lands.
  const mergeEvent = createEvent({
    findingId: canonicalId,
    actor,
    action: 'merge',
    fromStatus: canonical.status,
    toStatus: canonical.status,
    reason,
    mergedFromIds: nonCanonical.map(s => s.data.finding_id)
  });
  appendEvent(rootDir, mergeEvent);
  atomicWriteFileSync(canonicalResult.path, canonicalBody);

  // Mark source findings as rejected/superseded. Each supersede flows through
  // performAction, so the F-FIND-001 schema gate covers these re-writes too.
  const events = [];
  for (const s of nonCanonical) {
    const sourceResult = performAction(rootDir, {
      findingId: s.data.finding_id,
      action: 'supersede',
      actor,
      reason: `Merged into ${canonicalId}`,
      supersededBy: canonicalId
    });
    if (sourceResult.event) events.push(sourceResult.event);
  }

  events.push(mergeEvent);

  return { success: true, canonical, events };
}

/**
 * Get the review queue: findings needing operator attention.
 *
 * @param {string} rootDir
 * @returns {Array<{ data: object, reason: string }>}
 */
export function getReviewQueue(rootDir) {
  const allFindings = loadFindings(rootDir);
  const queue = [];

  for (const f of allFindings) {
    if (!f.data) continue;

    // Invalidation check first — takes priority over status-based matching
    if (f.data.invalidation?.is_invalidated) {
      queue.push({ data: f.data, path: f.path, queueReason: 'Invalidated — needs resolution' });
    } else if (f.data.status === 'candidate') {
      queue.push({ data: f.data, path: f.path, queueReason: 'Unreviewed candidate' });
    } else if (f.data.status === 'reviewed') {
      queue.push({ data: f.data, path: f.path, queueReason: 'Reviewed but unresolved' });
    }
  }

  return queue;
}
