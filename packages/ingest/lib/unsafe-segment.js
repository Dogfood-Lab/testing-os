/**
 * unsafe-segment.js — central path-segment safety helper.
 *
 * Three callsites previously defined or duplicated this regex (F-916867-005):
 *   - packages/ingest/persist.js (canonical instance)
 *   - packages/ingest/load-context.js (loadRepoPolicy + githubScenarioFetcher)
 *   - packages/findings/derive/load-records.js (the missing third callsite)
 *
 * The check rejects path-traversal substrings (`..`), any path separator
 * (`/`, `\`), and a segment that is EXACTLY `.` (F-3d2e6edf: path.join
 * normalizes a lone-dot segment away, so a schema-valid repo like `./x`
 * filed records one directory level UP — records/_rejected/x/... at the org
 * level — and resolved policies/repos/./x.yaml to policies/repos/x.yaml;
 * the verify CLI's safe() helper already blocked `.`, and the two guards
 * must agree). EMBEDDED dots remain legal because GitHub permits dotted
 * org/repo names like `next.js`, `mcp-tool-shop.github.io`, `repo.io`. The
 * submission schema's repo pattern `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` agrees
 * on characters (though it still admits a lone-dot segment — this guard is
 * the backstop).
 *
 * F-375053-006 regression — an earlier `/[.\/]/` was over-broad and crashed
 * legitimate submissions inside writeRecord. The narrower form (now
 * `/^\.$|\.\.|[/\\]/`) has stood since wave 9; this helper is the
 * productized form.
 */

/**
 * Regex matching unsafe substrings in a single path segment.
 * Use `.test(segment)` — returns true if the segment is unsafe.
 *
 * @type {RegExp}
 */
export const UNSAFE_SEGMENT = /^\.$|\.\.|[/\\]/;

/**
 * Predicate form: returns true when the given segment contains a path-traversal
 * substring or a path separator.
 *
 * @param {string} segment - A single path-segment candidate (e.g. an org or repo name).
 * @returns {boolean}
 */
export function isUnsafeSegment(segment) {
  return UNSAFE_SEGMENT.test(segment);
}
