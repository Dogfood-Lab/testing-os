/**
 * Stable ID generation and dedupe key computation for derived findings.
 *
 * ID law: same record + same rule + same lesson slug = same finding ID.
 * No timestamp noise in IDs.
 */

import { createHash } from 'node:crypto';

/**
 * Delimiter for the boundary hash: a NUL code unit cannot appear in a repo
 * slug (`[a-zA-Z0-9_.-]`) nor in a derived lesson slug, so joining components
 * with it means no component value can forge a false boundary between them.
 */
const BOUNDARY_DELIM = '\u0000';

/**
 * Generate a stable finding ID from derivation context.
 * Format: dfind-<repo-slug>-<lesson-slug>-<boundary-hash>
 *
 * The trailing boundary hash disambiguates inputs whose component boundary is
 * itself an underscore (findings-A-002): `sanitize` folds `_` to `-`, so
 * (repoSlug='a_b', lessonSlug='c') and (repoSlug='a', lessonSlug='b_c') both
 * flatten the human-readable middle to `a-b-c` and previously produced the
 * same id. The hash is computed over the components joined by BOUNDARY_DELIM,
 * so the two tuples hash differently and never collapse to one finding_id.
 *
 * @param {string} repoSlug - e.g. "repo-crawler-mcp"
 * @param {string} lessonSlug - e.g. "surface-misclassification"
 * @returns {string}
 */
export function generateFindingId(repoSlug, lessonSlug) {
  const boundary = boundaryHash([repoSlug, lessonSlug]);
  return `dfind-${sanitize(repoSlug)}-${sanitize(lessonSlug)}-${boundary}`;
}

/**
 * Compute a dedupe key for collision detection.
 * Two findings with the same dedupe key are considered the same lesson.
 *
 * @param {{ repo: string, issue_kind: string, root_cause_kind: string, journey_stage: string, slug: string }} fields
 * @returns {string}
 */
export function computeDedupeKey(fields) {
  return [
    fields.repo,
    fields.issue_kind,
    fields.root_cause_kind,
    fields.journey_stage,
    fields.slug
  ].join('::');
}

/**
 * Sanitize a string for use in finding IDs.
 * Lowercase, replace non-alphanumeric with hyphens, collapse runs, trim.
 */
function sanitize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Short stable hash of an ordered component tuple, joined by BOUNDARY_DELIM so
 * no component value can forge a false boundary. 8 lowercase-hex chars are
 * ample for the finding/pattern id space (a per-repo, per-lesson namespace).
 *
 * @param {string[]} components
 * @returns {string}
 */
export function boundaryHash(components) {
  return createHash('sha256').update(components.join(BOUNDARY_DELIM)).digest('hex').slice(0, 8);
}
