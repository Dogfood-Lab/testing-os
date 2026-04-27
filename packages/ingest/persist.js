/**
 * Persist layer
 *
 * Writes verified records to the canonical sharded path.
 * Handles: accepted/rejected routing, atomic write (temp+rename),
 * duplicate detection by run_id, directory creation.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { validateRecord } from './validate-record.js';

/**
 * Error thrown when writeRecord loses a TOCTOU race for the same canonical path.
 * The first concurrent writer wins; the loser sees this error.
 */
export class DuplicateRunIdError extends Error {
  constructor(runId, path) {
    super(`duplicate run_id: ${runId} — another writer won the race for ${path}`);
    this.name = 'DuplicateRunIdError';
    this.code = 'DUPLICATE_RUN_ID';
    this.runId = runId;
    this.path = path;
  }
}

/**
 * Compute the canonical file path for a persisted record.
 *
 * Accepted:  records/<org>/<repo>/YYYY/MM/DD/run-<run_id>.json
 * Rejected:  records/_rejected/<org>/<repo>/YYYY/MM/DD/run-<run_id>.json
 *
 * @param {object} record - Persisted record
 * @param {string} repoRoot - Absolute path to dogfood-labs repo root
 * @returns {string} Absolute file path
 */
export function computeRecordPath(record, repoRoot) {
  const status = record.verification?.status;
  const base = status === 'rejected' ? 'records/_rejected' : 'records';

  const [org, repo] = (record.repo || '').split('/');
  if (!org || !repo) {
    throw new Error(`invalid repo format: ${record.repo}`);
  }

  // Path-traversal guard: reject `..` substrings and any path separator.
  // Single dots are legal in GitHub org/repo names (e.g. `next.js`,
  // `mcp-tool-shop.github.io`) and the submission schema's repo pattern
  // `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` allows them — so `/[.\/]/` was over-broad
  // and crashed legitimate submissions inside writeRecord. Mirrors the narrower
  // check in load-context.js:37 so all path-segment guards in this package agree.
  const unsafeSegment = /\.\.|[/\\]/;
  if (unsafeSegment.test(org) || unsafeSegment.test(repo)) {
    throw new Error(`unsafe repo segment: ${record.repo}`);
  }

  if (!/^[\w-]+$/.test(record.run_id)) {
    throw new Error(`unsafe run_id: ${record.run_id}`);
  }

  const finishedAt = record.timing?.finished_at;
  if (!finishedAt) {
    throw new Error('record missing timing.finished_at');
  }

  const date = new Date(finishedAt);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid finished_at timestamp');
  }
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  const filename = `run-${record.run_id}.json`;

  return join(repoRoot, base, org, repo, year, month, day, filename);
}

/**
 * Check if a record with this run_id already exists (accepted or rejected).
 *
 * @param {string} runId
 * @param {object} record - The record (used for repo/timing to compute path)
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isDuplicate(runId, record, repoRoot) {
  // Check accepted path
  const acceptedRecord = { ...record, verification: { ...record.verification, status: 'accepted' } };
  const acceptedPath = computeRecordPath(acceptedRecord, repoRoot);
  if (existsSync(acceptedPath)) return true;

  // Check rejected path
  const rejectedRecord = { ...record, verification: { ...record.verification, status: 'rejected' } };
  const rejectedPath = computeRecordPath(rejectedRecord, repoRoot);
  if (existsSync(rejectedPath)) return true;

  return false;
}

/**
 * Write a record atomically: write to temp file, then exclusive-rename into place.
 *
 * Race semantics: the canonical path is created via `open(path, 'wx')` (exclusive
 * create — fails if the path exists). Two concurrent ingests for the same run_id
 * can both pass `isDuplicate` (no file yet); the FIRST `open(wx)` wins and the
 * SECOND throws `DuplicateRunIdError` instead of silently overwriting. The
 * temp+rename pattern still provides crash-atomicity — the canonical file is
 * either fully written or absent, never partial.
 *
 * Why not just `existsSync` then `writeFileSync`? That's the original race —
 * the existsSync check and the write are not atomic. `open(wx)` collapses both
 * into a single OS-level call.
 *
 * @param {object} record - Persisted record
 * @param {string} repoRoot - Absolute path to dogfood-labs repo root
 * @returns {{ path: string, written: boolean }} path and whether a write occurred
 * @throws {DuplicateRunIdError} when a concurrent writer won the race
 */
export function writeRecord(record, repoRoot) {
  if (isDuplicate(record.run_id, record, repoRoot)) {
    const path = computeRecordPath(record, repoRoot);
    return { path, written: false };
  }

  // Enforce dogfood-record.schema.json BEFORE touching the filesystem.
  // Better to throw loudly than silently persist a malformed record — the
  // schema is the contract every downstream consumer relies on.
  validateRecord(record);

  const path = computeRecordPath(record, repoRoot);
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true });

  // Race-safe atomic create: try to claim the canonical path with O_EXCL first.
  // If another writer already won the race, fail closed with DuplicateRunIdError
  // — never silently overwrite. On success, hold an empty file we'll fill via
  // temp+rename so the visible bytes are still atomic.
  let claimed = false;
  try {
    const fd = openSync(path, 'wx');
    closeSync(fd);
    claimed = true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new DuplicateRunIdError(record.run_id, path);
    }
    throw err;
  }

  // Atomic write: temp file → rename over the empty placeholder.
  const tmpSuffix = randomBytes(4).toString('hex');
  const tmpPath = `${path}.${tmpSuffix}.tmp`;

  try {
    writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    // On any failure after we claimed the path, release the claim so a retry
    // can succeed. The tmp file is best-effort cleanup.
    if (claimed) {
      try { unlinkSync(path); } catch { /* placeholder already gone */ }
    }
    try { unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }

  return { path, written: true };
}
