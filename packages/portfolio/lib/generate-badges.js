/**
 * generate-badges — F5-04 (dogfood status badge / shields.io endpoint).
 *
 * Turns the latest-by-repo index (repo -> surface -> { verified,
 * verification_status, finished_at }) into one shields.io ENDPOINT JSON per
 * repo+surface. shields.io's endpoint protocol is a tiny contract:
 *
 *   { schemaVersion: 1, label: <left text>, message: <right text>, color: <right bg> }
 *
 * A repo README embeds `https://img.shields.io/endpoint?url=<raw url to this file>`
 * and shields renders a live pass/fail/stale pill. (Serving these files via CI
 * is a deferred follow-up — see the portfolio README + the build-report
 * out_of_scope note; this module only PRODUCES the endpoint objects.)
 *
 * Status mapping:
 *   pass + fresh  -> message 'pass',  color 'brightgreen'
 *   fail          -> message 'fail',  color 'red'
 *   stale         -> message 'stale', color 'orange'
 *
 * Staleness wins over a pass verdict: a green badge backed by a months-old run
 * is a lie the consumer can't see through, so an old (or unparseable)
 * finished_at downgrades the pill to 'stale'/orange. A FAIL is reported as fail
 * regardless of age — a known failure is more actionable than "stale," and we
 * never want to hide a red verdict behind an orange one.
 *
 * Filenames are <org>--<repo>--<surface>.json, with every filesystem-hostile
 * character (path separators, colons, whitespace) collapsed to '-'. The double
 * dash delimiter keeps the org/repo/surface boundaries legible while staying
 * safe on every filesystem and inside a flat indexes/badges/ directory. The
 * key carries no native separators (SEED-1 lesson: never let a path separator
 * leak into a stored identifier).
 */

const DEFAULT_WINDOW_DAYS = 30;

// badge-serving-loop-incomplete — the org-wide rollup pill. Leading underscore
// keeps it unambiguous against every per-repo+surface filename (those always
// contain '--' joining a sanitized org/repo/surface; sanitizeSegment can never
// emit a leading underscore from a real repo path), and it sorts to the front
// of a directory listing so an operator scanning indexes/badges/ sees the fleet
// summary first. Exported so consumers and tests reference one source of truth
// for the served path instead of hardcoding the string.
export const AGGREGATE_BADGE_FILENAME = '_aggregate.json';

// Status precedence, worst-first. The aggregate reports the WORST status across
// the fleet because a single green pill that hides a red surface is the exact
// lie the per-surface staleness rule already guards against — escalated one
// level up. fail > stale > pass: a known failure is the most actionable signal,
// staleness is the next (a pass we can't prove is fresh), pass is the floor.
const STATUS_RANK = { fail: 2, stale: 1, pass: 0 };
const STATUS_COLOR = { fail: 'red', stale: 'orange', pass: 'brightgreen' };

/**
 * Collapse any filesystem-hostile run of characters to a single '-'. Used for
 * each filename segment so org/repo slashes, colons, and spaces can't produce
 * a nested path or an invalid name. Trailing/leading dashes are trimmed.
 *
 * @param {string} segment
 * @returns {string}
 */
function sanitizeSegment(segment) {
  return String(segment)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a flat, separator-free badge filename for a repo+surface.
 * `repo` is "<org>/<name>"; the org and name are sanitized independently then
 * joined with '--' so a sanitized org can't blur into the repo name.
 *
 * @param {string} repo - "<org>/<name>"
 * @param {string} surface
 * @returns {string} e.g. "mcp-tool-shop-org--shipcheck--cli.json"
 */
function badgeFilename(repo, surface) {
  const [org, ...rest] = repo.split('/');
  const name = rest.join('/'); // tolerate an unexpected extra slash in the name
  const parts = [sanitizeSegment(org), sanitizeSegment(name), sanitizeSegment(surface)];
  return `${parts.join('--')}.json`;
}

/**
 * Generate shields.io endpoint objects for every repo+surface in the index.
 *
 * @param {Object<string, Object<string, { verified?: string, verification_status?: string, finished_at?: string }>>} index
 *   The latest-by-repo index shape.
 * @param {object} [options]
 * @param {number} [options.windowDays=30] - Days after which a passing surface
 *   is reported 'stale'.
 * @param {number} [options.now=Date.now()] - Injectable clock for deterministic
 *   staleness in tests.
 * @returns {Object<string, { schemaVersion: 1, label: 'dogfood', message: string, color: string }>}
 *   keyed by sanitized filename.
 */
/**
 * Reduce one record to its badge status: 'pass' | 'fail' | 'stale'. Shared by
 * the per-surface pills and the aggregate rollup so the two cannot drift on what
 * "passing" means.
 *
 * @param {{ verified?: string, finished_at?: string }} record
 * @param {number} now
 * @param {number} windowMs
 * @returns {'pass'|'fail'|'stale'}
 */
function recordStatus(record, now, windowMs) {
  const verified = record?.verified;
  const finishedMs = record?.finished_at != null ? new Date(record.finished_at).getTime() : NaN;
  // Unparseable timestamp => cannot prove freshness => treat as stale.
  const isStale = !Number.isFinite(finishedMs) || (now - finishedMs) > windowMs;

  // A known failure is always reported as fail — never masked by staleness.
  if (verified === 'fail') return 'fail';
  if (isStale) return 'stale';
  if (verified === 'pass') return 'pass';
  // Any non-pass/non-fail verdict on a fresh record (e.g. an unexpected verdict
  // value): surface it conservatively rather than claim 'pass'.
  return 'stale';
}

export function generateBadges(index, options = {}) {
  const { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = options;
  const windowMs = windowDays * 86400000;

  const badges = {};
  let worst = null;
  let surfaceCount = 0;
  for (const [repo, surfaces] of Object.entries(index || {})) {
    for (const [surface, record] of Object.entries(surfaces || {})) {
      const status = recordStatus(record, now, windowMs);
      surfaceCount++;
      if (worst === null || STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;

      badges[badgeFilename(repo, surface)] = {
        schemaVersion: 1,
        label: 'dogfood',
        message: status,
        color: STATUS_COLOR[status],
      };
    }
  }

  // badge-serving-loop-incomplete — one fleet-wide pill alongside the per-surface
  // ones, so a README can embed a single "is everything green" badge. Only when
  // the fleet is non-empty: an empty index has no status to roll up, and an
  // aggregate that read 'pass' over zero surfaces would assert health we never
  // measured.
  if (surfaceCount > 0 && worst !== null) {
    badges[AGGREGATE_BADGE_FILENAME] = {
      schemaVersion: 1,
      label: 'dogfood',
      message: worst,
      color: STATUS_COLOR[worst],
    };
  }

  return badges;
}
