/**
 * Review engine for SYNTHESIS ARTIFACTS (patterns / recommendations / doctrine).
 *
 * F2-INTEL-001 — closes the intelligence loop. `synthesis/` derives patterns,
 * recommendations, and doctrine and writes them with `status: 'candidate'`, but
 * `advise/query.js` (`queryPatterns` / `queryRecommendations` / `queryDoctrine`)
 * surfaces ONLY `status === 'accepted'`. At HEAD the finding review engine
 * (`review/review-engine.js`) could promote findings, but NOTHING could promote
 * a synthesis artifact candidate → accepted, so nothing the intelligence layer
 * derived ever reached the advise surface. This module is the missing verb.
 *
 * It mirrors `performAction` (review/review-engine.js) and REUSES the finding
 * status law verbatim (`validateTransition`, `ACTION_TARGET_STATUS`,
 * `REASON_REQUIRED`, `REQUIRES_ACCEPTED`, `REQUIRES_CLOSED` from
 * review/transitions.js). Persistence goes through the synthesis writers
 * (`writePattern` / `writeRecommendation` / `writeDoctrine`), which re-validate
 * the promoted artifact against its JSON Schema before it touches disk.
 *
 * Contract reality (load-bearing): the artifact schemas constrain `status` to a
 * NARROWER set than findings —
 *   pattern        : candidate | accepted | rejected | invalidated
 *   recommendation : candidate | accepted | rejected
 *   doctrine       : candidate | accepted | rejected
 * None of them permit `reviewed`. The finding law's intermediate `reviewed`
 * state is therefore not expressible for artifacts: actions whose
 * `ACTION_TARGET_STATUS` is `reviewed` (`review`, `reopen`) cannot persist a
 * schema-valid artifact, and so are refused HONESTLY with a structured error
 * rather than writing an artifact the contract would reject. `invalidate` is the
 * one special case the contract supports — but only for patterns, which carry a
 * literal `invalidated` status. Recommendations and doctrine lack it, so
 * `invalidate` on those is refused with a structured hint. This is honest
 * partial coverage, not a silent no-op.
 */

import { relative } from 'node:path';

import { validateTransition, ACTION_TARGET_STATUS, REASON_REQUIRED, REQUIRES_ACCEPTED, REQUIRES_CLOSED } from './transitions.js';
import { createEvent, appendEvent } from './event-log.js';
import {
  resetSeenArtifactWrite,
  writePattern,
  writeRecommendation,
  writeDoctrine,
  loadPatternsWithSkips,
  loadRecommendationsWithSkips,
  loadDoctrinesWithSkips
} from '../synthesis/write-artifacts.js';

/**
 * Surface torn/unreadable artifact YAML on stderr — the lookup-path analogue of
 * the derive CLI's "N pattern(s) skipped (torn/unreadable)" reporting
 * (cli.js) and `findRecordFile`'s stderr note (derive/load-records.js).
 *
 * B-001 — `findArtifactById` / `getArtifactReviewQueue` consumed only the
 * loader's `entries`, discarding `skipped[]`. A torn artifact YAML for the very
 * id under accept/show/queue therefore vanished behind a bare "<type> not
 * found", giving the operator no signal that a file was unreadable. The id
 * lives INSIDE the file, so a torn file can't be matched to a requested id;
 * the honest signal is to name the torn files whenever any are present so the
 * operator can distinguish "absent" from "present but unparseable". Returns the
 * skipped list so callers can decide whether the not-found was hint-worthy.
 *
 * @param {string} rootDir
 * @param {string} type - artifact kind, for the message prefix
 * @param {Array<{ path: string, error: string }>} skipped
 */
function reportArtifactSkips(rootDir, type, skipped) {
  if (!skipped || skipped.length === 0) return;
  // eslint-disable-next-line no-console
  console.error(`${skipped.length} ${type}(s) skipped (torn/unreadable):`);
  for (const s of skipped) {
    // eslint-disable-next-line no-console
    console.error(`  ${relative(rootDir, s.path)} — ${s.error}`);
  }
}

/**
 * Per-artifact-type configuration: the on-disk directory, the id field name,
 * the loader (with-skips) and the writer. Mirrors how the finding engine pairs
 * `findById` + writer; here the type is a first-class parameter.
 */
const ARTIFACT_TYPES = {
  pattern: {
    dir: 'patterns',
    idKey: 'pattern_id',
    loadWithSkips: loadPatternsWithSkips,
    write: writePattern,
    statuses: new Set(['candidate', 'accepted', 'rejected', 'invalidated']),
    hasInvalidatedStatus: true
  },
  recommendation: {
    dir: 'recommendations',
    idKey: 'recommendation_id',
    loadWithSkips: loadRecommendationsWithSkips,
    write: writeRecommendation,
    statuses: new Set(['candidate', 'accepted', 'rejected']),
    hasInvalidatedStatus: false
  },
  doctrine: {
    dir: 'doctrine',
    idKey: 'doctrine_id',
    loadWithSkips: loadDoctrinesWithSkips,
    write: writeDoctrine,
    statuses: new Set(['candidate', 'accepted', 'rejected']),
    hasInvalidatedStatus: false
  }
};

/**
 * Find a single synthesis artifact by id.
 *
 * @param {string} rootDir
 * @param {'pattern'|'recommendation'|'doctrine'} type
 * @param {string} id
 * @returns {{ data: object, path: string, type: string } | null}
 */
export function findArtifactById(rootDir, type, id) {
  const cfg = ARTIFACT_TYPES[type];
  if (!cfg) return null;
  const { entries, skipped } = cfg.loadWithSkips(rootDir);
  for (const entry of entries) {
    if (entry.data && entry.data[cfg.idKey] === id) {
      return { data: entry.data, path: entry.path, type };
    }
  }
  // B-001 — id absent from the clean entries. A torn file may be hiding it;
  // name the torn files rather than letting a bare not-found mislead.
  reportArtifactSkips(rootDir, type, skipped);
  return null;
}

/**
 * Perform a review action on a synthesis artifact — the artifact analogue of
 * `performAction`. Promotes a candidate to accepted (closing the loop),
 * rejects, or invalidates per the reused finding status law.
 *
 * @param {string} rootDir
 * @param {object} params
 * @param {'pattern'|'recommendation'|'doctrine'} params.type
 * @param {string} params.id
 * @param {string} params.action - accept | reject | review | reopen | invalidate
 * @param {string} params.actor
 * @param {string} [params.reason]
 * @param {string} [params.notes]
 * @returns {{ success: boolean, error?: string, artifact?: object, event?: object }}
 */
export function reviewArtifact(rootDir, params) {
  const { type, id, action, actor } = params;

  if (!type || !ARTIFACT_TYPES[type]) {
    return { success: false, error: `Unknown artifact type: "${type}". Expected pattern|recommendation|doctrine.` };
  }
  if (!id) return { success: false, error: 'id is required' };
  if (!action) return { success: false, error: 'action is required' };
  if (!actor) return { success: false, error: 'actor is required' };
  if (!(action in ACTION_TARGET_STATUS)) {
    return { success: false, error: `Unknown action: "${action}"` };
  }

  const cfg = ARTIFACT_TYPES[type];

  // Load the artifact
  const found = findArtifactById(rootDir, type, id);
  if (!found) return { success: false, error: `${type} not found: ${id}` };

  const artifact = found.data;
  const fromStatus = artifact.status;

  // Enforce reason requirement (reused REASON_REQUIRED)
  if (REASON_REQUIRED.has(action) && !params.reason) {
    return { success: false, error: `Action "${action}" requires a reason` };
  }

  // Enforce accepted-only actions (reused REQUIRES_ACCEPTED — invalidate)
  if (REQUIRES_ACCEPTED.has(action) && fromStatus !== 'accepted') {
    return { success: false, error: `Action "${action}" requires status "accepted", got "${fromStatus}"` };
  }

  // Enforce closed-only actions (reused REQUIRES_CLOSED — reopen)
  if (REQUIRES_CLOSED.has(action) && fromStatus !== 'accepted' && fromStatus !== 'rejected') {
    return { success: false, error: `Action "${action}" requires status "accepted" or "rejected", got "${fromStatus}"` };
  }

  // Determine the law's target status (reused ACTION_TARGET_STATUS)
  const lawTarget = ACTION_TARGET_STATUS[action];

  // Validate the transition under the reused finding law FIRST — an unlawful
  // transition is refused with the same vocabulary the finding engine uses.
  if (lawTarget !== null && lawTarget !== fromStatus) {
    const transResult = validateTransition(fromStatus, lawTarget);
    if (!transResult.valid) {
      return { success: false, error: transResult.error };
    }
  }

  // Map the law's target status onto the NARROWER artifact contract.
  // The finding law uses `reviewed` as an intermediate state; artifact schemas
  // do not permit it. Refuse honestly where the artifact cannot hold the state.
  let toStatus;
  if (action === 'invalidate') {
    if (!cfg.hasInvalidatedStatus) {
      return {
        success: false,
        error: `invalidate is not supported for ${type}: its schema has no "invalidated" status. ` +
          `Use reject (with a reason) to retire an accepted ${type}.`
      };
    }
    toStatus = 'invalidated';
  } else if (lawTarget === 'reviewed') {
    // `review` / `reopen` target the intermediate `reviewed` state, which no
    // artifact schema permits. Refuse rather than write an invalid artifact.
    return {
      success: false,
      error: `Action "${action}" targets status "reviewed", which the ${type} contract does not allow ` +
        `(${type} status ∈ {${[...cfg.statuses].join(', ')}}). Use accept or reject instead.`
    };
  } else {
    toStatus = lawTarget;
  }

  // Defensive: never persist a status the artifact schema forbids.
  if (!cfg.statuses.has(toStatus)) {
    return { success: false, error: `Computed status "${toStatus}" is not valid for ${type}.` };
  }

  const now = new Date().toISOString();

  // Apply status + review metadata. `last_action` mirrors the finding engine's
  // review block. For invalidate, `last_action: 'invalidate'` is what
  // queryPatterns checks to exclude the artifact (advise/query.js).
  artifact.status = toStatus;
  artifact.review = {
    reviewed_by: actor,
    reviewed_at: now,
    last_action: action,
    ...(params.reason ? { decision_reason: params.reason } : {})
  };
  artifact.updated_at = now;

  // Build the review event (carries artifact id + kind, back-compat).
  const event = createEvent({
    artifactId: id,
    artifactKind: type,
    actor,
    action,
    fromStatus,
    toStatus,
    reason: params.reason,
    notes: params.notes
  });

  // Persist via the synthesis writer — which RE-VALIDATES the promoted artifact
  // against its JSON Schema (fail-closed). The reset is the documented opt-in
  // for a legitimate re-write of an id already touched in this process (the
  // synthesis collision guard otherwise refuses the second write). B-003 —
  // scope it to THIS id so a future batch reviewer doesn't disarm the guard for
  // the other ids it has written this process.
  try {
    resetSeenArtifactWrite(rootDir, type, id);
    cfg.write(rootDir, artifact);
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }

  // Append the event only after the artifact persisted successfully.
  appendEvent(rootDir, event);

  return { success: true, artifact, event };
}

/**
 * Get the artifact review queue: candidate artifacts needing operator attention.
 * Mirrors `getReviewQueue` (review/review-engine.js). With `type` omitted,
 * scans all three artifact families.
 *
 * @param {string} rootDir
 * @param {'pattern'|'recommendation'|'doctrine'} [type]
 * @returns {Array<{ data: object, path: string, type: string, queueReason: string }>}
 */
export function getArtifactReviewQueue(rootDir, type) {
  const types = type ? [type] : Object.keys(ARTIFACT_TYPES);
  const queue = [];

  for (const t of types) {
    const cfg = ARTIFACT_TYPES[t];
    if (!cfg) continue;
    const { entries, skipped } = cfg.loadWithSkips(rootDir);
    // B-001 — a torn artifact silently shrinks the review queue; name it so the
    // operator knows the queue is partial rather than complete.
    reportArtifactSkips(rootDir, t, skipped);
    for (const entry of entries) {
      const data = entry.data;
      if (!data) continue;
      if (data.status === 'candidate') {
        queue.push({ data, path: entry.path, type: t, queueReason: 'Unreviewed candidate' });
      }
    }
  }

  return queue;
}
