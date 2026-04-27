/**
 * Index generator
 *
 * Scans records/ and records/_rejected/ to produce:
 * - indexes/latest-by-repo.json  (keyed by repo + product_surface)
 * - indexes/failing.json         (records where verified verdict is not pass)
 * - indexes/stale.json           (repos/surfaces with no recent accepted record)
 *
 * Regenerated on every accepted/rejected write in Phase 1.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Recursively find all .json files under a directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
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
 * Load and parse a record file.
 *
 * @param {string} filePath
 * @returns {{ record: object|null, error: string|null }}
 */
function loadRecord(filePath) {
  try {
    return { record: JSON.parse(readFileSync(filePath, 'utf-8')), error: null };
  } catch (err) {
    return { record: null, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Rebuild all indexes from the records directory.
 *
 * Corrupted records (parse failure) and records missing run_id are surfaced
 * via the returned `corrupted` and `skipped` arrays AND logged to stderr so
 * operators see them. The function does NOT crash on a single bad file —
 * the index must keep building so the rest of the portfolio stays current —
 * but the bad files are NOT silently dropped.
 *
 * @param {string} repoRoot - Absolute path to dogfood-labs repo root
 * @param {object} [options]
 * @param {number} [options.staleDays=30] - Days after which a surface is stale
 * @returns {{ latestByRepo: object, failing: object[], stale: object[], accepted: number, rejected: number, corrupted: Array<{ path: string, error: string }>, skipped: Array<{ path: string, reason: string }> }}
 */
export function rebuildIndexes(repoRoot, options = {}) {
  const { staleDays = 30 } = options;
  const indexDir = join(repoRoot, 'indexes');
  mkdirSync(indexDir, { recursive: true });

  // Collect all records (accepted + rejected)
  const recordsDir = join(repoRoot, 'records');
  const acceptedFiles = findJsonFiles(recordsDir)
    .filter(f => {
      const rel = relative(recordsDir, f);
      return !rel.startsWith('_rejected/') && !rel.startsWith('_rejected\\');
    });
  const rejectedFiles = findJsonFiles(join(repoRoot, 'records', '_rejected'));

  const allRecords = [];
  const corrupted = [];
  const skipped = [];

  for (const f of [...acceptedFiles, ...rejectedFiles]) {
    const relPath = relative(repoRoot, f);
    const { record, error } = loadRecord(f);
    if (error) {
      corrupted.push({ path: relPath, error });
      console.error(`[rebuild-indexes] corrupted record skipped: ${relPath} — ${error}`);
      continue;
    }
    if (!record || !record.run_id) {
      skipped.push({ path: relPath, reason: 'missing run_id' });
      console.error(`[rebuild-indexes] record skipped (missing run_id): ${relPath}`);
      continue;
    }
    record._path = relPath;
    allRecords.push(record);
  }

  // --- latest-by-repo.json ---
  // Keyed by repo, then product_surface. Only accepted records count.
  const latestByRepo = {};

  for (const record of allRecords) {
    if (record.verification?.status !== 'accepted') continue;

    const repo = record.repo;
    if (!latestByRepo[repo]) latestByRepo[repo] = {};

    for (const sr of record.scenario_results || []) {
      const surface = sr.product_surface;
      const existing = latestByRepo[repo][surface];

      const finishedAt = record.timing?.finished_at;
      // Compare timestamps numerically. ISO 8601 lex-compare only agrees with
      // chronological order when both strings share identical precision and
      // timezone format — `2026-03-19T15:45:12Z` lex-compares AFTER
      // `2026-03-19T15:45:12.500Z` (because `Z` (0x5A) > `.` (0x2E)), so
      // mixed-precision timestamps would pick the wrong "latest." Date.parse
      // normalizes to ms-since-epoch; NaN (bad/missing) is treated as oldest.
      const finishedMs = finishedAt ? new Date(finishedAt).getTime() : NaN;
      const existingMs = existing?.finished_at ? new Date(existing.finished_at).getTime() : NaN;
      const isNewer = !existing || (Number.isFinite(finishedMs) && (!Number.isFinite(existingMs) || finishedMs > existingMs));
      if (isNewer) {
        latestByRepo[repo][surface] = {
          run_id: record.run_id,
          verified: record.overall_verdict?.verified,
          verification_status: 'accepted',
          finished_at: finishedAt,
          path: record._path
        };
      }
    }
  }

  // --- failing.json ---
  // Latest accepted records where verified verdict is not "pass"
  const failing = [];

  for (const [repo, surfaces] of Object.entries(latestByRepo)) {
    for (const [surface, entry] of Object.entries(surfaces)) {
      if (entry.verified !== 'pass') {
        failing.push({
          repo,
          surface,
          run_id: entry.run_id,
          verified: entry.verified,
          finished_at: entry.finished_at,
          path: entry.path
        });
      }
    }
  }

  // --- stale.json ---
  // Surfaces where the latest accepted record is older than staleDays
  const stale = [];
  const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  for (const [repo, surfaces] of Object.entries(latestByRepo)) {
    for (const [surface, entry] of Object.entries(surfaces)) {
      // Compare numerically — see latest-by-repo block above for the
      // mixed-precision lex-compare hazard. A missing/unparseable
      // finished_at is treated as stale (NaN < cutoff is false in lex,
      // hiding records with no usable timing — the original behavior
      // silently dropped them from stale-detection).
      const entryMs = entry.finished_at ? new Date(entry.finished_at).getTime() : NaN;
      const isStale = !Number.isFinite(entryMs) || entryMs < cutoffMs;
      if (isStale) {
        const ageDays = Number.isFinite(entryMs)
          ? Math.floor((Date.now() - entryMs) / (24 * 60 * 60 * 1000))
          : null;
        stale.push({
          repo,
          surface,
          run_id: entry.run_id,
          finished_at: entry.finished_at,
          age_days: ageDays,
          path: entry.path
        });
      }
    }
  }

  // Write indexes
  const latestPath = join(indexDir, 'latest-by-repo.json');
  const failingPath = join(indexDir, 'failing.json');
  const stalePath = join(indexDir, 'stale.json');

  const tmpSuffix = randomBytes(4).toString('hex');
  const latestTmp = `${latestPath}.${tmpSuffix}.tmp`;
  const failingTmp = `${failingPath}.${tmpSuffix}.tmp`;
  const staleTmp = `${stalePath}.${tmpSuffix}.tmp`;

  writeFileSync(latestTmp, JSON.stringify(latestByRepo, null, 2) + '\n', 'utf-8');
  renameSync(latestTmp, latestPath);
  writeFileSync(failingTmp, JSON.stringify(failing, null, 2) + '\n', 'utf-8');
  renameSync(failingTmp, failingPath);
  writeFileSync(staleTmp, JSON.stringify(stale, null, 2) + '\n', 'utf-8');
  renameSync(staleTmp, stalePath);

  return {
    latestByRepo,
    failing,
    stale,
    accepted: acceptedFiles.length,
    rejected: rejectedFiles.length,
    corrupted,
    skipped
  };
}
