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
 * F-112c88a4: defense-in-depth sibling of generateFindingId's own
 * boundary-collision fix (findings-A-002, above). A plain `'::'.join()` here
 * would let a delimiter-shaped VALUE in one field forge a false boundary
 * with its neighbor — e.g. (issue_kind='x::y', root_cause_kind='z') and
 * (issue_kind='x', root_cause_kind='y::z') both flatten to the same joined
 * string. Routed through the same NUL-delimited boundaryHash() helper
 * generateFindingId uses, so no component value can forge a boundary
 * regardless of what it contains.
 *
 * Today's five fields are each enum- or pattern-constrained upstream (see
 * dogfood-finding.schema.json) such that none can actually contain '::', so
 * this specific collision is not reachable through the intended pipeline —
 * but that safety lives entirely in the CALLER's schema, not in this
 * function's own construction. boundaryHash() makes computeDedupeKey safe on
 * its own terms, so a future caller (or a future schema relaxation on any of
 * these fields) cannot unknowingly reopen the collision generateFindingId
 * was explicitly fixed to close.
 *
 * @param {{ repo: string, issue_kind: string, root_cause_kind: string, journey_stage: string, slug: string }} fields
 * @returns {string}
 */
export function computeDedupeKey(fields) {
  return boundaryHash([
    fields.repo,
    fields.issue_kind,
    fields.root_cause_kind,
    fields.journey_stage,
    fields.slug
  ]);
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
