/**
 * Index generator
 *
 * Scans records/ and records/_rejected/ to produce:
 * - indexes/latest-by-repo.json  (keyed by repo + product_surface)
 * - indexes/failing.json         (records where verified verdict is not pass)
 * - indexes/stale.json           (repos/surfaces with no recent accepted record)
 *
 * Regenerated on every accepted/rejected write in Phase 1.
 *
 * Multi-file commit-group atomicity (W3-PIPE-002):
 * The 3 indexes are written together via a two-phase commit pattern. Phase 1
 * stages all 3 files to temp paths AND records them in a journal file. Phase 2
 * renames each temp into its final location, then deletes the journal. If the
 * process crashes mid-rename, the next run detects the journal, deletes any
 * residual temps it lists, and re-runs the rebuild from scratch. The rebuild
 * is idempotent (it scans records/ end-to-end), so re-running is the correct
 * recovery action.
 *
 * Pattern reference: choke-point fix (Pattern #4) for multi-file atomicity.
 * Single-file `atomicWriteFileSync` (lib/atomic-write.js) handles each leg;
 * the journal handles the cross-file boundary. The single-file helper is
 * the same one Class #6 helper-adoption-sweep enforces as canonical for
 * temp+rename writes under `packages/ingest/`.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';

import { stageWriteFileSync, promoteStaged, discardStaged } from './lib/atomic-write.js';

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

  // Write indexes via commit-group two-phase commit. See module header
  // for the full design rationale.
  const latestPath = join(indexDir, 'latest-by-repo.json');
  const failingPath = join(indexDir, 'failing.json');
  const stalePath = join(indexDir, 'stale.json');

  // Phase 0: clean up any residual journal from a previous crashed run.
  // Idempotent: rerun-from-scratch is the correct recovery (the rebuild
  // scans all records every time), so we just delete the journal and any
  // temp files it lists, then proceed normally.
  cleanupCrashedJournals(indexDir);

  commitGroupRename(indexDir, [
    { finalPath: latestPath, content: JSON.stringify(latestByRepo, null, 2) + '\n' },
    { finalPath: failingPath, content: JSON.stringify(failing, null, 2) + '\n' },
    // Stale renames LAST: it is the most-derivative index (depends on
    // latestByRepo's timestamps). If a partial-failure escape ever does
    // happen, readers see a stale-by-stale.json that's a previous-pass
    // shape — never a future shape pointing at run_ids the latest index
    // doesn't reflect. Recovery on next run completes the renames.
    { finalPath: stalePath, content: JSON.stringify(stale, null, 2) + '\n' },
  ]);

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

/**
 * Two-phase commit for a group of files written together. Stages all temps
 * AND records them in a journal first; then renames them in caller-given
 * order. The journal is deleted only after every rename succeeds.
 *
 * Crash semantics:
 *   - Crash during STAGE phase: every staged temp is unlinked in the catch
 *     block; the journal (if written) is unlinked too. No partial visible
 *     state.
 *   - Crash during PROMOTE phase: any successfully-renamed file is at its
 *     final path; remaining temps are still next to their finals. The
 *     journal still exists. Next run's `cleanupCrashedJournals` deletes
 *     residual temps and the journal; the next normal `rebuildIndexes`
 *     call rewrites all 3 indexes from scratch (idempotent).
 *
 * Why journal-then-rename rather than journal-only: the rename phase needs
 * to be the visible commit point. A journal-only design would require
 * readers to consult the journal, which couples readers to writers. The
 * present design keeps reader code untouched (read each index path
 * directly).
 *
 * @param {string} indexDir - Where the journal lives.
 * @param {Array<{ finalPath: string, content: string }>} entries
 */
function commitGroupRename(indexDir, entries) {
  const journalPath = join(indexDir, `.in-progress.${process.pid}.${randomBytes(4).toString('hex')}.json`);
  const stagedTmps = [];

  // Phase 1: stage all temps. If anything fails, unlink everything we staged.
  try {
    for (const entry of entries) {
      const tmpPath = stageWriteFileSync(entry.finalPath, entry.content);
      stagedTmps.push({ tmpPath, finalPath: entry.finalPath });
    }

    // Write journal AFTER staging so it never points at a non-existent temp.
    // Atomic write of the journal itself: writeFileSync directly is fine here
    // because the journal is process-private (the pid suffix guarantees no
    // collision with concurrent rebuilds).
    writeFileSync(
      journalPath,
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        entries: stagedTmps,
      }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    // STAGE-phase failure — roll back every temp we managed to write. The
    // journal might or might not exist; clean it up too.
    for (const { tmpPath } of stagedTmps) discardStaged(tmpPath);
    try { unlinkSync(journalPath); } catch { /* may not exist */ }
    throw err;
  }

  // Phase 2: promote each staged temp to its final path.
  // Order matters — the caller chose `entries` ordering for partial-failure
  // recoverability (most-derivative file last). We promote in that order.
  let promotedCount = 0;
  try {
    for (const { tmpPath, finalPath } of stagedTmps) {
      promoteStaged(tmpPath, finalPath);
      promotedCount++;
    }
  } catch (err) {
    // PROMOTE-phase failure: leave the journal in place so the next run's
    // `cleanupCrashedJournals` can finish the cleanup. Any unpromoted temps
    // are still on disk; we do NOT roll back already-promoted finals
    // (their previous content is already overwritten — the rename was
    // atomic at each individual leg, just not as a group). The next run
    // is idempotent and will rewrite all three from scratch.
    throw new Error(
      `commitGroupRename: promote failed after ${promotedCount}/${stagedTmps.length} files; ` +
      `journal preserved at ${journalPath} for next-run cleanup. Original error: ${err.message}`
    );
  }

  // Phase 3: clean up the journal. If this fails, the next run's
  // `cleanupCrashedJournals` will pick up the slack — the journal's
  // entries all reference temps that no longer exist (we promoted them),
  // so the cleanup is a no-op except for unlinking the journal itself.
  try { unlinkSync(journalPath); } catch { /* will be cleaned next run */ }
}

/**
 * Find and clean up any in-progress journals from previous runs. Each journal
 * lists the temp paths that were staged; we unlink any that still exist
 * (they are residue from a crashed run) and delete the journal.
 *
 * Idempotent: on a clean filesystem it's a no-op; on a crashed-mid-promote
 * filesystem it cleans the slate so the upcoming `commitGroupRename` can
 * stage fresh temps without colliding.
 *
 * @param {string} indexDir
 */
function cleanupCrashedJournals(indexDir) {
  if (!existsSync(indexDir)) return;
  const entries = readdirSync(indexDir);
  for (const entry of entries) {
    if (!entry.startsWith('.in-progress.') || !entry.endsWith('.json')) continue;
    const journalPath = join(indexDir, entry);
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(journalPath, 'utf-8'));
    } catch {
      // Unreadable journal — best we can do is delete it. The temps it
      // referenced will linger but they're harmless (they have a unique
      // suffix that won't be re-used).
    }
    if (parsed && Array.isArray(parsed.entries)) {
      for (const e of parsed.entries) {
        if (e && typeof e.tmpPath === 'string') {
          try { unlinkSync(e.tmpPath); } catch { /* may not exist */ }
        }
      }
    }
    try { unlinkSync(journalPath); } catch { /* race with another cleaner */ }
  }
}
