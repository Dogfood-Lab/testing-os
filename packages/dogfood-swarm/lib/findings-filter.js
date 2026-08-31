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
 * `file_path` falls back to `filed_by_domain` (v10, C3 amendment) instead of
 * being excluded outright — see findingsForDomain's own doc for why.
 */

import { minimatch } from 'minimatch';

/**
 * Match `file_path` against any of `globs`.
 *
 * `nocase` is load-bearing, not a convenience (run swarm-1788165870-6880 wave 2,
 * 2026-08-31): callers mix case-folded and raw inputs — declared-closures.js folds
 * the PATH through normalizeFilePathForGlobMatch (lowercase) while domain globs
 * arrive RAW, so a domain owning `README*` / `SHIP_GATE.md` could NEVER close a
 * finding on those files ('readme.pypi.md' vs 'README*' under case-sensitive
 * minimatch); only all-lowercase filenames closed. Same trap class F-00d67cb6
 * fixed from the path side in fingerprint.js, and the open F-f347d858 names at
 * collect.js. normalizePath already treats case-variant spellings as the SAME
 * file for identity, so ownership matching folds case too — in the one shared
 * matcher, so every caller (closure, routing, id-reuse vouching) inherits it
 * rather than each re-fixing one side. lib/domains.js's checkOwnership calls
 * minimatch directly (raw-vs-raw, self-consistent) and is deliberately not
 * changed in this slice.
 *
 * @param {string} filePath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function matchesAnyGlob(filePath, globs) {
  if (!filePath) return false;
  return globs.some(g => minimatch(filePath, g, { dot: true, nocase: true }));
}

/**
 * Return approved findings for a run filtered to those whose file_path
 * matches the given domain's globs. If 0 match, return an empty array —
 * that is the correct answer (this domain has no work this wave).
 *
 * F-874c0683 / F-aa32371b (C3 amendment): a finding with no `file_path` at
 * all (a repo-level / file-less finding — proven at pass scale by this
 * wave's own dispatch preview: 40 file-less feature findings routed to ZERO
 * agents) has no glob to match against, so the file_path branch below can
 * never select it for ANY domain. Before this fallback that meant an
 * approved file-less finding was permanently unroutable — see dispatch.js's
 * own F-aa32371b comment, which surfaces exactly this class as a loud
 * dispatch-time warning because nothing could ever fix it. The fallback
 * routes a file-less finding to whichever domain FILED it
 * (`findings.filed_by_domain`, stamped once at upsert from the collect-time
 * `_declaringDomain` attribution — see lib/fingerprint.js#upsertFindings).
 * `filed_by_domain` is NULL for every pre-v10 row and for any finding
 * upserted before a caller threaded `_declaringDomain` through; those rows
 * still fall through to "routes to no domain" here — the honest answer,
 * since there is no recorded filer to route to, not a guess.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {{globs: string[], name?: string}} domain — domain row with globs
 *   already parsed to array. `name` is required for the file-less fallback to
 *   have any effect — a caller that passes a bare `{ globs }` (no `name`)
 *   degrades silently to the pre-fallback behavior for file-less findings
 *   only (never a false match: `filed_by_domain === undefined` is never true
 *   for a real filed_by_domain string). F-762d2b9b: this omission is now
 *   diagnosed loudly (see below) rather than only disclosed in this
 *   docstring — a documented risk nobody reads is the same as an
 *   undocumented one.
 * @returns {object[]} findings rows
 */
export function findingsForDomain(db, runId, domain) {
  const approved = db.prepare(
    "SELECT * FROM findings WHERE run_id = ? AND status = 'approved'"
  ).all(runId);

  // F-762d2b9b: `domain.globs` present but `domain.name` missing is never a
  // legitimate, intentional caller shape (per this function's own docstring
  // above) — it silently drops every file-less approved finding this domain
  // filed, with no signal at all. The live instance was
  // commands/resume.js:335 (swarm-cp-verbs' fix), passing a bare `{ globs }`
  // on the redispatch path; that call site is being corrected this same
  // wave, but the LIBRARY must stop trusting a caller-supplied shape it has
  // already identified as fragile, so a FUTURE resume.js-shaped omission
  // fails visibly instead of silently reproducing this exact class. A
  // console.warn (not a throw) is deliberate: this runs on a recovery path
  // (dispatch/resume after a timeout or crash), and turning a silent
  // under-delivery into a hard crash there would make the recovery path
  // itself less safe than the bug it replaces. The warning only fires when
  // it could actually matter — a name-less domain with zero file-less
  // approved findings this run has nothing to lose from the omission.
  if (!domain.name && approved.some(f => !f.file_path)) {
    console.warn(
      `findings-filter: domain object has globs but no name, and ${runId} has approved file-less ` +
      `findings — every file-less finding this domain may have filed will be silently excluded from ` +
      `its result set (the filed_by_domain fallback requires domain.name). Pass the full domain row ` +
      `(including name), not a bare { globs } shape.`
    );
  }

  return approved.filter(f => {
    if (f.file_path) return matchesAnyGlob(f.file_path, domain.globs);
    return f.filed_by_domain != null && f.filed_by_domain === domain.name;
  });
}
