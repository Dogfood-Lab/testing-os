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
 * Multi-file commit-group: crash/IO-failure RECOVERY-atomic, NOT reader-atomic
 * (W3-PIPE-002):
 * The 3 indexes are written together via a two-phase commit pattern. Phase 1
 * stages all 3 files to temp paths AND records them in a journal file. Phase 2
 * renames each temp into its final location, then deletes the journal. If the
 * process crashes mid-rename, the next run detects the journal, deletes any
 * residual temps it lists, and re-runs the rebuild from scratch. The rebuild
 * is idempotent (it scans records/ end-to-end), so re-running is the correct
 * recovery action.
 *
 * IMPORTANT — what "atomicity" means here. The guarantee is RECOVERY-atomic,
 * not READER-atomic. Phase 2 promotes the temps with a per-leg `renameSync`
 * (each rename is individually atomic), but the GROUP is not promoted under a
 * single atomic operation. During the promote window — and during the heal
 * window after a mid-promote IO failure (ENOSPC/EACCES after the first
 * final is renamed but a later one is not) — a concurrent reader CAN observe
 * the index group in a mutually-inconsistent intermediate state (e.g. an
 * already-promoted latest-by-repo.json against a not-yet-promoted failing.json).
 * The catch on a promote failure does NOT roll back already-promoted finals;
 * it preserves the journal and emits a structured error event so an operator
 * can force an immediate rebuild before the next scheduled run heals it. The
 * design is sound because the only writer (the ingest pipeline) serializes
 * rebuilds and `rebuildIndexes` is synchronous — there is no in-flight reader
 * that races a writer mid-promote within a single process. If you ever need
 * true reader-atomicity (a reader that NEVER sees a torn group), this design
 * must change (e.g. swap a single directory symlink, or version the index dir).
 *
 * Pattern reference: choke-point fix (Pattern #4) for multi-file recovery.
 * Single-file `atomicWriteFileSync` (lib/atomic-write.js) handles each leg;
 * the journal handles the cross-file recovery boundary. The single-file helper
 * is the same one Class #6 helper-adoption-sweep enforces as canonical for
 * temp+rename writes under `packages/ingest/`.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { logStage as sharedLogStage } from '@dogfood-lab/dogfood-swarm/lib/log-stage.js';
import { stageWriteFileSync, promoteStaged, discardStaged } from './lib/atomic-write.js';

/**
 * D1B-005 (Stage C humanization): one structured `logStage('warn', ...)`
 * helper, component-pinned to `ingest` so the NDJSON line is greppable
 * with the rest of the pipeline. Wave-22 sibling pattern — see
 * `packages/ingest/run.js`'s private `logStage` wrapper for the same
 * `component: 'ingest'` pinning convention.
 */
function logStage(stage, fields = {}) {
  // Defensive: strip any caller-supplied `stage:` before delegating so
  // the outer positional stage always wins. Same shape as run.js (see
  // wave-22 F-827321-035 hardening rationale).
  const { stage: _ignored, ...rest } = fields;
  sharedLogStage(stage, { component: 'ingest', ...rest });
}

/**
 * Recursively find all .json files under a directory.
 *
 * d3-ingest-B005 (Stage C humanization): the `readdirSync` is wrapped so an
 * unreadable subtree (EACCES, ENOTDIR, a Windows lock — the same class
 * renameWithRetry defends against) degrades to "that subtree's records are
 * missing from this rebuild" instead of throwing and aborting the WHOLE scan.
 * This restores parity with the per-FILE tolerance of `loadRecord` just below
 * (module header: "does NOT crash on a single bad file") and mirrors the
 * in-repo precedent in `packages/portfolio/lib/parse-regression-pins.js`'s
 * `walkSourceFiles`. The skip is NOT silent: a structured
 * `logStage('warn', { kind: 'dir_unreadable', path })` NDJSON line makes it
 * greppable alongside the rest of the pipeline (`"kind":"dir_unreadable"`), so
 * the operator can see which subtree was dropped and why the index is partial.
 * Exported so the guard is unit-testable in isolation (the single wrapped
 * `readdirSync` serves both the top-level call and every recursive descent).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Unreadable directory (locked / permission-restricted / not a dir).
    // Skip this subtree rather than sinking the whole rebuild, but emit a
    // structured, greppable warn naming the path so the partial index is
    // explained — not a silent swallow.
    logStage('warn', {
      kind: 'dir_unreadable',
      reason: err && err.code ? err.code : 'readdir_failed',
      path: dir,
      error: err && err.message ? err.message : String(err),
    });
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
 * Probe whether `dir` exists but is unreadable at its OWN level (EACCES /
 * Windows lock / ENOTDIR) — as distinct from a deep leaf failing mid-walk.
 *
 * ingest-B-002: `findJsonFiles` deliberately degrades an unreadable subtree to
 * "those records are missing" and returns `[]`. That is correct for a single
 * locked LEAF, but catastrophic for the records/ ROOT: a transiently-locked
 * root makes the WHOLE corpus invisible, and an unguarded rebuild would then
 * overwrite every index with empty content. This probe lets `rebuildIndexes`
 * tell the two apart so it can REFUSE to clobber good indexes when the root
 * itself is the thing that failed. A non-existent dir is NOT unreadable — that
 * is the legitimate empty-corpus case, which must still rebuild empty indexes.
 *
 * @param {string} dir
 * @returns {{ unreadable: boolean, code: string|null, error: string|null }}
 */
function probeDirReadable(dir) {
  if (!existsSync(dir)) return { unreadable: false, code: null, error: null };
  try {
    readdirSync(dir);
    return { unreadable: false, code: null, error: null };
  } catch (err) {
    return {
      unreadable: true,
      code: err && err.code ? err.code : 'readdir_failed',
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Read the prior committed latest-by-repo.json so a rebuild can tell whether
 * the index it is about to overwrite currently has content. Used by the
 * ingest-B-002 refuse-to-overwrite guard: an empty scan is only suspicious if
 * the prior index was non-empty. A missing or unparseable prior index counts
 * as "no prior content" (the legitimate first-run / empty-corpus case).
 *
 * @param {string} latestPath
 * @returns {boolean} true if the prior index existed and held at least one repo
 */
function priorIndexHasContent(latestPath) {
  if (!existsSync(latestPath)) return false;
  try {
    const prior = JSON.parse(readFileSync(latestPath, 'utf-8'));
    return prior && typeof prior === 'object' && Object.keys(prior).length > 0;
  } catch {
    // Unparseable prior index — treat as no usable content so a corrupt index
    // never wedges the rebuild into a permanent refuse state.
    return false;
  }
}

/**
 * Whether the freshly-built latest-by-repo map has no repos. Used by the
 * ingest-B-002 refuse-to-overwrite guard to recognise an empty scan. A scan
 * can be empty because there are genuinely no accepted records (legitimate)
 * or because the corpus was invisible (a transiently-locked records tree) —
 * the guard combines this with `priorIndexHasContent` to tell them apart.
 *
 * @param {object} latestByRepo
 * @returns {boolean}
 */
function latestByRepoIsEmpty(latestByRepo) {
  return !latestByRepo || Object.keys(latestByRepo).length === 0;
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

  // ingest-B-002: capture two facts BEFORE the scan so we can refuse to clobber
  // good indexes with empty ones when the corpus is invisible rather than empty.
  //   1. Is the records/ ROOT itself unreadable (vs a deep leaf, vs absent)?
  //      A locked root makes the WHOLE corpus invisible — findJsonFiles would
  //      return [] after one low `dir_unreadable` warn, and an unguarded
  //      commit-group would then overwrite every index with {}.
  //   2. Did the PRIOR latest-by-repo.json have content? An empty scan is only
  //      suspicious if there was something to lose; a legitimately empty
  //      first-run corpus must still write empty indexes.
  const recordsDir = join(repoRoot, 'records');
  const latestPath = join(indexDir, 'latest-by-repo.json');
  const rootProbe = probeDirReadable(recordsDir);
  const hadPriorIndex = priorIndexHasContent(latestPath);

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
    // SEED-1 (d3-ingest-001) — posixify at the serialization boundary.
    // `relative()` returns OS-native separators (backslashes on win32). This
    // value becomes `record._path` and is serialized verbatim into all three
    // committed index `path` fields (latest-by-repo / failing / stale), which
    // downstream consumers read as raw.githubusercontent.com URL fragments
    // (docs/policy-contract.md Gate F) — a backslash there is a broken URL.
    // Normalize ONCE here, at the single source the whole family flows through,
    // so every serialized path is forward-slash regardless of host OS. Mirrors
    // the canonical transform proven in
    // packages/portfolio/lib/parse-regression-pins.js:75. NEVER a win32-skip.
    const relPath = relative(repoRoot, f).split(sep).join('/');
    const { record, error } = loadRecord(f);
    if (error) {
      corrupted.push({ path: relPath, error });
      // D1B-005: structured warn event so the NDJSON stream carries the
      // skip with the same discipline as the ingest pipeline. Greppable
      // via `"kind":"record_skipped"` + `"reason":"corrupted"`.
      logStage('warn', {
        kind: 'record_skipped',
        reason: 'corrupted',
        path: relPath,
        error
      });
      continue;
    }
    if (!record || !record.run_id) {
      skipped.push({ path: relPath, reason: 'missing run_id' });
      logStage('warn', {
        kind: 'record_skipped',
        reason: 'missing_run_id',
        path: relPath
      });
      continue;
    }
    record._path = relPath;
    allRecords.push(record);
  }

  // --- latest-by-repo.json ---
  // Keyed by repo, then product_surface. Only accepted records count.
  //
  // F-89b7dcd5: `record.repo` and `sr.product_surface` come from loadRecord()
  // (JSON.parse only, no schema gate — see its JSDoc) rather than validated
  // submission input, so a hand-committed record with repo: '__proto__' would
  // otherwise resolve `latestByRepo['__proto__']` to Object.prototype itself
  // (truthy, on a plain `{}`), skip the init branch below, and land the
  // surface write ON Object.prototype — real global prototype pollution for
  // the rest of this process. Object.create(null) removes the prototype
  // chain entirely: `latestByRepo['__proto__']` is a plain (absent) data
  // property, not the special accessor. JSON.stringify (below, at the
  // commitGroupRename call) serializes a null-prototype object identically
  // to a plain one, so this costs nothing on the write side. Not reachable
  // from the ingest write path today (writeRecord's validateRecord() gate
  // constrains repo's shape before persist.js ever writes a file), so this
  // is defense-in-depth against a hand-committed or otherwise out-of-band
  // record file, not a live vulnerability.
  const latestByRepo = Object.create(null);

  for (const record of allRecords) {
    if (record.verification?.status !== 'accepted') continue;

    const repo = record.repo;
    if (!latestByRepo[repo]) latestByRepo[repo] = Object.create(null);

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

  // ingest-B-002: REFUSE to overwrite good indexes with empty ones when the
  // corpus was invisible rather than genuinely empty. Two refuse conditions:
  //   - records_root_unreadable: the records/ ROOT itself failed to read
  //     (EACCES / Windows lock / ENOTDIR). The entire corpus is invisible —
  //     committing now would wipe every index. This is distinct from a single
  //     locked leaf, which findJsonFiles already degrades to a partial scan.
  //   - empty_scan_with_prior_index: the root read fine but the scan found
  //     zero accepted records while the prior latest-by-repo had content. The
  //     records likely vanished transiently; clobbering loses the portfolio.
  // A legitimately empty corpus (no accepted records AND no prior content) is
  // NOT refused — it must still write empty indexes (first-run case). We skip
  // the commit-group and emit a structured, greppable event so the operator
  // sees the refusal loudly instead of a silently-emptied portfolio.
  const noAcceptedScanned = latestByRepoIsEmpty(latestByRepo);
  if (rootProbe.unreadable || (noAcceptedScanned && hadPriorIndex)) {
    const reason = rootProbe.unreadable
      ? 'records_root_unreadable'
      : 'empty_scan_with_prior_index';
    // A root IO failure is an operator-actionable error (the corpus is gone);
    // an empty scan over a readable root is a warn (recoverable next run).
    logStage(rootProbe.unreadable ? 'error' : 'warn', {
      kind: 'index_rebuild_skipped',
      reason,
      records_dir: recordsDir,
      accepted_scanned: acceptedFiles.length,
      prior_index_non_empty: hadPriorIndex,
      root_error_code: rootProbe.code,
      error: rootProbe.error,
    });
    return {
      latestByRepo,
      failing,
      stale,
      accepted: acceptedFiles.length,
      rejected: rejectedFiles.length,
      corrupted,
      skipped,
      skippedCommit: reason,
    };
  }

  // Write indexes via commit-group two-phase commit. See module header
  // for the full design rationale.
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
 * Crash / IO-failure semantics (RECOVERY-atomic, not reader-atomic):
 *   - Failure during STAGE phase: every staged temp is unlinked in the catch
 *     block; the journal (if written) is unlinked too. No partial visible
 *     state — no final was touched.
 *   - Failure during PROMOTE phase: any successfully-renamed file is at its
 *     final path with its NEW content; remaining temps are still next to
 *     their (still-OLD) finals. The group is therefore mutually inconsistent
 *     until healed — a reader in this window sees a torn group. We do NOT
 *     roll back the already-promoted finals (their prior content was already
 *     overwritten by the atomic rename — there is nothing to roll back to
 *     without re-reading the journal). Instead we emit a structured
 *     `logStage('error', { kind: 'commit_group_partial_promote', ... })`
 *     naming which finals were promoted vs left stale so an operator can
 *     force an immediate rebuild, and we preserve the journal. Next run's
 *     `cleanupCrashedJournals` deletes residual temps and the journal; the
 *     next normal `rebuildIndexes` call rewrites all 3 indexes from scratch
 *     (idempotent), which is what heals the torn group.
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
    // because the journal is process-private — the pid + random suffix make
    // the filename collision-free, and `cleanupCrashedJournals` is pid-aware
    // (it skips journals whose pid is a still-live process), so a future
    // concurrent rebuild's in-flight journal is never reaped out from under
    // it. The temp `entries` it lists are equally collision-free (each carries
    // its own random suffix from `stageWriteFileSync`).
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
    //
    // ingest-A-001: the group is now reader-inconsistent (promoted finals
    // carry new content; stale finals carry old content). Name which finals
    // are which in a structured error event so an operator can force an
    // immediate rebuild rather than wait for the next scheduled run to heal
    // the torn group.
    const promoted = stagedTmps.slice(0, promotedCount).map((e) => e.finalPath);
    const stale = stagedTmps.slice(promotedCount).map((e) => e.finalPath);
    logStage('error', {
      kind: 'commit_group_partial_promote',
      reason: err && err.code ? err.code : 'promote_failed',
      promoted_count: promotedCount,
      total: stagedTmps.length,
      promoted_finals: promoted,
      stale_finals: stale,
      journal: journalPath,
      error: err && err.message ? err.message : String(err),
    });
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
 * Probe whether a pid is still a live process. `process.kill(pid, 0)` sends
 * no signal — it only performs the permission/existence check, throwing
 * ESRCH when the pid is dead. An EPERM means the process exists but is owned
 * by another user; that still counts as "live" for our purpose (do not reap
 * its journal). Any other error (or a non-integer pid) is treated as "not
 * provably live" so a malformed journal never blocks its own cleanup.
 *
 * @param {unknown} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Find and clean up any in-progress journals from previous runs. Each journal
 * lists the temp paths that were staged; we unlink any that still exist
 * (they are residue from a crashed run) and delete the journal.
 *
 * ingest-A-002: cleanup is PID-AWARE. A journal whose `pid` is a still-live
 * process is the in-flight recovery state of a concurrent rebuild — reaping
 * it would delete that run's temps and journal mid-flight. Today the only
 * writer serializes rebuilds and `rebuildIndexes` is synchronous, so no live
 * sibling journal exists at Phase-0 cleanup time; this guard makes the design
 * correct (not merely safe-by-serialization) so a future maintainer who adds
 * concurrency does not silently corrupt a peer. A dead pid, a missing/
 * malformed pid, or an unreadable journal is still reaped — that is the
 * crashed-run residue this function exists to clear.
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
    // Skip a journal owned by a still-live process — it belongs to a
    // concurrent rebuild's in-flight recovery state, not crashed residue.
    if (parsed && isProcessAlive(parsed.pid) && parsed.pid !== process.pid) {
      continue;
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
