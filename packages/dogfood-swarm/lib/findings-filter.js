/**
 * findings-filter.js — Domain-scoped finding selection for amend prompts.
 *
 * Both `dispatch` (initial amend wave) and `resume` (re-dispatch after timeout
 * or failure) must hand each domain agent ONLY the approved findings whose
 * `file_path` falls inside the agent's owned globs. This shared helper is the
 * single source of truth for that filter.
 *
 * Why this exists:
 *   The original dispatch path tried to filter via the `file_claims` table
 *   joined to the agent's domain. But audits never write file_claims (only
 *   amend agents do, when they edit), so the join returned 0 rows for every
 *   domain on the FIRST amend wave. The old fallback then loaded ALL approved
 *   findings and fed them to every agent — defeating exclusive ownership and
 *   causing every agent to attempt every fix. The resume path was even worse:
 *   it skipped the filter entirely and always sent everything.
 *
 * Glob semantics match `lib/domains.js#checkOwnership`: `minimatch` with
 * `dot: true`, any-match across the domain's glob list. A finding with no
 * `file_path` is excluded — there is no domain to assign it to.
 */

import { minimatch } from 'minimatch';

/**
 * Match `file_path` against any of `globs`.
 * @param {string} filePath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function matchesAnyGlob(filePath, globs) {
  if (!filePath) return false;
  return globs.some(g => minimatch(filePath, g, { dot: true }));
}

/**
 * Return approved findings for a run filtered to those whose file_path
 * matches the given domain's globs. If 0 match, return an empty array —
 * that is the correct answer (this domain has no work this wave).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {{globs: string[]}} domain — domain row with globs already parsed to array
 * @returns {object[]} findings rows
 */
export function findingsForDomain(db, runId, domain) {
  const approved = db.prepare(
    "SELECT * FROM findings WHERE run_id = ? AND status = 'approved'"
  ).all(runId);

  return approved.filter(f => matchesAnyGlob(f.file_path, domain.globs));
}
