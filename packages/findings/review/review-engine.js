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
import { parseFinding } from '../validate.js';
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
  finding.review = {
    reviewed_by: actor,
    reviewed_at: now,
    last_action: action,
    ...(params.reason ? { decision_reason: params.reason } : {}),
    ...(params.notes ? { review_notes: params.notes } : {}),
    ...(params.rejectReason && action === 'reject' ? { reject_reason: params.rejectReason } : {})
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

  // Persist: update finding artifact
  const clean = JSON.parse(JSON.stringify(finding));
  atomicWriteFileSync(filePath, yaml.dump(clean, { lineWidth: 120, noRefs: true }));

  // Persist: append event to log
  appendEvent(rootDir, event);

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

  // Write canonical
  const cleanCanonical = JSON.parse(JSON.stringify(canonical));
  atomicWriteFileSync(canonicalResult.path, yaml.dump(cleanCanonical, { lineWidth: 120, noRefs: true }));

  // Mark source findings as rejected/superseded
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

  // Log merge event for canonical
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
