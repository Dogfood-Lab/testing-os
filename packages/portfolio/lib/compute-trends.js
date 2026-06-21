/**
 * compute-trends — F3-001 (corpus trend / regression surface).
 *
 * The records/ tree (records/<org>/<repo>/YYYY/MM/DD/run-*.json) is the full
 * dated history of every dogfood run. `indexes/latest-by-repo.json` collapses
 * that history to a SINGLE newest record per repo+surface — which is all
 * `generatePortfolio` reads, so the portfolio cannot express a trend or a
 * regression. This module scans records/ directly and reconstructs, per
 * repo+surface:
 *   - an ordered `history` of { run_id, verified, finished_at }, oldest -> newest
 *   - `current` / `previous` verdicts (the two newest accepted runs)
 *   - `regressed` (previous pass -> current fail) / `recovered` (fail -> pass)
 *   - `pass_rate` over a rolling window (default 30 days)
 *
 * Design notes, load-bearing:
 *
 *   - Ordering uses Date.parse(finished_at) (ms-since-epoch), NEVER ISO string
 *     lex-compare. rebuild-indexes.js documents the hazard: `2026-03-19T15:45:12Z`
 *     lex-compares AFTER `2026-03-19T15:45:12.500Z` because `Z` (0x5A) > `.`
 *     (0x2E), so mixed-precision timestamps sort backwards under a string
 *     compare. A NaN parse (missing/garbage) is treated as oldest, matching the
 *     "treated as oldest"/"treated as stale" sentinel convention in
 *     rebuild-indexes.js.
 *
 *   - Only `verification.status === 'accepted'` records count toward the
 *     verdict trend, and the `_rejected/` subtree is excluded entirely —
 *     mirroring rebuildIndexes' latest-by-repo logic so the two surfaces agree
 *     on what "the latest verdict" means.
 *
 *   - `latest_path` (the relative path of the newest accepted run) is
 *     POSIXIFIED with `.split(sep).join('/')`. SEED-1 (rebuild-indexes.js):
 *     relative() returns OS-native separators; a backslash leaking into a
 *     serialized index path becomes a broken raw.githubusercontent.com URL on
 *     Windows. Normalize once, at this serialization boundary. NEVER a
 *     win32-skip.
 *
 * This module stays inside packages/portfolio — it does NOT import or edit
 * packages/ingest. `rebuild-indexes.js`'s findJsonFiles is not exposed via a
 * workspace subpath export (the ingest `./lib/*` map does not cover the package
 * root), so we scan with a local `findJsonFiles` modeled on it, including the
 * same readdir-tolerance so one unreadable subtree degrades to a skip rather
 * than sinking the whole scan.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DEFAULT_WINDOW_DAYS = 30;

/**
 * Recursively collect .json record files under a directory. Modeled on
 * rebuild-indexes.js#findJsonFiles, including its tolerance: an unreadable
 * subtree (EACCES / lock / not-a-dir) is skipped, not fatal, so a partial
 * record tree still yields a partial trend rather than no trend at all. Skips
 * `.tmp` writes-in-progress like the ingest walker.
 *
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable subtree — skip it; the rest of the scan continues.
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Parse a finished_at into ms-since-epoch, or NaN when missing/unparseable.
 * Date.parse normalizes precision/timezone so the numeric compare is correct
 * regardless of ISO format — see the module header's lex-compare note.
 *
 * @param {unknown} finishedAt
 * @returns {number} ms or NaN
 */
function toMs(finishedAt) {
  if (finishedAt == null) return NaN;
  return new Date(finishedAt).getTime();
}

/**
 * Compute per repo+surface trends from the records/ tree.
 *
 * @param {string} repoRoot - Absolute path to the testing-os repo root.
 * @param {object} [options]
 * @param {number} [options.windowDays=30] - Rolling window (days) for pass-rate.
 * @param {number} [options.now=Date.now()] - Injectable clock for deterministic
 *   windowing in tests.
 * @returns {Object<string, Object<string, {
 *   history: Array<{ run_id: string, verified: string, finished_at: string }>,
 *   current: { run_id: string, verified: string, finished_at: string } | null,
 *   previous: { run_id: string, verified: string, finished_at: string } | null,
 *   regressed: boolean,
 *   recovered: boolean,
 *   pass_rate: number | null,
 *   pass_rate_sample: number,
 *   pass_rate_window_days: number,
 *   latest_path: string | null,
 * }>>} trends keyed by repo, then product_surface.
 */
export function computeTrends(repoRoot, options = {}) {
  const { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = options;

  const recordsDir = join(repoRoot, 'records');
  if (!existsSync(recordsDir)) return {};

  // Exclude the _rejected/ subtree the same way rebuildIndexes does: a record
  // is rejected if its repo-root-relative path starts with the rejected prefix
  // (either separator, since the filter runs on the native path before
  // posixifying for storage).
  const recordFiles = findJsonFiles(recordsDir).filter((f) => {
    const rel = relative(recordsDir, f);
    return !rel.startsWith(`_rejected${sep}`) && !rel.startsWith('_rejected/');
  });

  // repo -> surface -> array of accepted run rows.
  const bySurface = {};

  for (const filePath of recordFiles) {
    let record;
    try {
      record = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      // One corrupt record must not sink the trend — mirrors loadRecord's
      // per-file tolerance in rebuild-indexes.js.
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (record.verification?.status !== 'accepted') continue;
    const repo = typeof record.repo === 'string' ? record.repo : null;
    const runId = record.run_id;
    if (!repo || !runId) continue;

    const verified = record.overall_verdict?.verified ?? null;
    const finishedAt = record.timing?.finished_at ?? null;
    // POSIXIFY at the storage boundary — see module header (SEED-1).
    const relPath = relative(repoRoot, filePath).split(sep).join('/');

    for (const sr of record.scenario_results || []) {
      const surface = sr.product_surface;
      if (!surface) continue;
      ((bySurface[repo] ??= {})[surface] ??= []).push({
        run_id: runId,
        verified,
        finished_at: finishedAt,
        _ms: toMs(finishedAt),
        _path: relPath,
      });
    }
  }

  const windowMs = windowDays * 86400000;
  const windowStart = now - windowMs;

  const trends = {};
  for (const [repo, surfaces] of Object.entries(bySurface)) {
    trends[repo] = {};
    for (const [surface, rows] of Object.entries(surfaces)) {
      // Order oldest -> newest by ms (NaN sorts oldest). Stable for equal ms.
      const ordered = rows.slice().sort((a, b) => {
        const am = Number.isFinite(a._ms) ? a._ms : -Infinity;
        const bm = Number.isFinite(b._ms) ? b._ms : -Infinity;
        return am - bm;
      });

      // Collapse to one row per run: the submission schema permits multiple
      // scenario_results with the same product_surface in a single run (minItems:1,
      // no maxItems, no uniqueness), and each contributed an identical row here
      // (same run_id/verified/finished_at). Without this, a run's N duplicates
      // would let current/previous land on the SAME run — masking a real
      // pass->fail regression — and would skew the windowed pass-rate (N votes
      // for one run). Dedup keeps the first occurrence per run_id; ordering is
      // already chronological so the kept row is correct.
      const seenRuns = new Set();
      const sorted = ordered.filter((r) => {
        if (seenRuns.has(r.run_id)) return false;
        seenRuns.add(r.run_id);
        return true;
      });

      const history = sorted.map(({ run_id, verified, finished_at }) => ({
        run_id,
        verified,
        finished_at,
      }));

      const currentRow = sorted[sorted.length - 1] ?? null;
      const previousRow = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

      const current = currentRow
        ? { run_id: currentRow.run_id, verified: currentRow.verified, finished_at: currentRow.finished_at }
        : null;
      const previous = previousRow
        ? { run_id: previousRow.run_id, verified: previousRow.verified, finished_at: previousRow.finished_at }
        : null;

      const regressed = !!(previous && previous.verified === 'pass' && current && current.verified === 'fail');
      const recovered = !!(previous && previous.verified === 'fail' && current && current.verified === 'pass');

      // Windowed pass-rate: runs whose finished_at is within [windowStart, now].
      const windowed = sorted.filter((r) => Number.isFinite(r._ms) && r._ms >= windowStart && r._ms <= now);
      const passCount = windowed.filter((r) => r.verified === 'pass').length;
      const pass_rate = windowed.length > 0 ? passCount / windowed.length : null;

      trends[repo][surface] = {
        history,
        current,
        previous,
        regressed,
        recovered,
        pass_rate,
        pass_rate_sample: windowed.length,
        pass_rate_window_days: windowDays,
        latest_path: currentRow ? currentRow._path : null,
      };
    }
  }

  return trends;
}
