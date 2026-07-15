/**
 * Persist layer
 *
 * Writes verified records to the canonical sharded path.
 * Handles: accepted/rejected routing, atomic write (temp+rename),
 * duplicate detection by run_id, directory creation.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { validateRecord } from './validate-record.js';
import { isUnsafeSegment } from './lib/unsafe-segment.js';
import { submissionDigest } from './lib/integrity.js';
import { readChainHead, appendChainEntry } from './lib/chain-manifest.js';
import { parseRejectionReason } from '@dogfood-lab/verify';

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
 * Error thrown when writeRecord's SECOND computeRecordPath() call — the one
 * that computes the real write target, reached only AFTER validateRecord()
 * has already confirmed the record is schema-valid — still cannot produce a
 * safe path.
 *
 * F-bbbe2e1f: computeRecordPath()'s isUnsafeSegment check (lib/unsafe-segment.js)
 * is STRICTER than the record schema's own repo pattern
 * (`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`), which permits an embedded `..` or a
 * lone `.` segment (e.g. `../etc`). A record can therefore pass
 * validateRecord() above and still fail here — this is never a schema
 * problem, it is the traversal backstop firing on schema-valid input. Pre-fix
 * that let a bare, unclassified computeRecordPath Error (no `.code`) escape
 * uncaught — the exact shape F-a37d36f5 eliminated at the FIRST
 * computeRecordPath call (the isDuplicate probe below) but not this second
 * one, three lines after validateRecord(). Classifying it here matches
 * RecordValidationError's discipline and stays fail-closed: nothing below
 * this point has touched the filesystem yet (mkdirSync/openSync/writeFileSync
 * all come after), so no partial write is possible either way.
 */
export class UnsafeRecordPathError extends Error {
  constructor(record, cause) {
    super(
      `record passed schema validation but its path could not be safely computed ` +
      `(repo: ${record.repo}, run_id: ${record.run_id}): ${cause.message}`,
      { cause }
    );
    this.name = 'UnsafeRecordPathError';
    this.code = 'UNSAFE_RECORD_PATH';
    this.repo = record.repo;
    this.runId = record.run_id;
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

  // V2-CROSS-BO-003 (F-54e5fde7 family): strictly two segments — the old
  // destructure silently dropped a third segment (`group/subgroup/project`
  // filed under `group/subgroup/`), sharding the record into the WRONG
  // repo's path. Fail closed instead.
  const segments = (record.repo || '').split('/');
  if (segments.length !== 2) {
    throw new Error(`invalid repo format: ${record.repo}`);
  }
  const [org, repo] = segments;
  if (!org || !repo) {
    throw new Error(`invalid repo format: ${record.repo}`);
  }

  // Path-traversal guard: reject `..` substrings and any path separator.
  // Single dots are legal in GitHub org/repo names (e.g. `next.js`,
  // `mcp-tool-shop.github.io`) and the submission schema's repo pattern
  // `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` allows them. Centralized in
  // ./lib/unsafe-segment.js so all three callsites (persist, load-context,
  // findings/derive/load-records) agree by import — F-916867-005.
  if (isUnsafeSegment(org) || isUnsafeSegment(repo)) {
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
 * F-4036ae25: a prior `_rejected` record whose rejection_reasons are ALL
 * `schema:`-class is "we could not understand your submission", not a
 * rendered verdict about the run — the same doctrine that already exempts an
 * unfilable (`_skipPersist`) rejection from consuming its run_id. Narrowing
 * `_skipPersist` in verify/index.js means a filable-but-schema-invalid
 * submission now DOES persist (the fleet-wide audit trail F-4036ae25
 * restores), so this is the other half of that fix: persisting the evidence
 * must not resurrect the exact run_id-poisoning pathology F-82429f90
 * eliminated for validator-crash faults. A mixed-reason or non-schema
 * rejection (policy, provenance, ...) is still a rendered verdict and stays
 * blocking — unchanged from today.
 *
 * Any read/parse failure fails closed (blocking): a corrupted or unreadable
 * evidence file must never silently unblock a path collision.
 *
 * @param {string} rejectedPath - Absolute path already confirmed to exist.
 * @returns {boolean} true when every rejection reason is schema-class.
 */
function isRetryableSchemaRejection(rejectedPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(rejectedPath, 'utf-8'));
  } catch {
    return false;
  }
  const reasons = parsed?.verification?.rejection_reasons;
  if (parsed?.verification?.status !== 'rejected' || !Array.isArray(reasons) || reasons.length === 0) {
    return false;
  }
  return reasons.every(r => parseRejectionReason(r).prefix === 'schema:');
}

/**
 * Check if a record with this run_id already exists (accepted or rejected).
 *
 * F-0f9e4077 (wave-6 regression, fixed wave-8): computeRecordPath() is keyed
 * on (run_id, date, accepted|rejected) — never on rejection_reasons content.
 * So once a `_rejected` record occupies a path, ANY new record whose OWN
 * status is STILL 'rejected' is headed to that exact same path no matter
 * which violation it reports (an unexpected field with a different name, a
 * different value, even a byte-identical resubmission all collide
 * identically — computeRecordPath never looks at content). The
 * isRetryableSchemaRejection carve-out below exists so a stale schema-class
 * rejection does not block a DIFFERENT-status (now accepted) record from
 * reaching ITS OWN, different path — it was never a promise that the
 * REJECTED path specifically is free. Pre-fix, skipping the status check let
 * an uncorrected retry fall through as "not a duplicate," reach
 * writeRecord()'s exclusive-create, and throw DuplicateRunIdError — a
 * purely sequential, single-writer collision masquerading as the two-writer
 * TOCTOU race that error class exists for. Gating on
 * `record.verification.status === 'accepted'` restores the carve-out to
 * exactly the case it can actually help (a record now headed elsewhere)
 * while making a still-rejected collision an unconditional, ordinary
 * duplicate — so writeRecord() short-circuits before ever attempting the
 * write, and no throw is reachable for this class anymore.
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
  if (existsSync(rejectedPath)) {
    // A record that is itself still rejected can only ever land at THIS
    // path — asking whether the OLD occupant is retryable is moot when the
    // NEW attempt has nowhere else to go. Only a record now bound for the
    // accepted path (real forward progress) gets to ask that question.
    if (record.verification?.status !== 'accepted') return true;
    return !isRetryableSchemaRejection(rejectedPath);
  }

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
  // F-a37d36f5: family sibling of the ingest.js pre-check fix — writeRecord
  // carries its OWN premature isDuplicate call, reached even when the
  // caller's own duplicate check was skipped or already cleared. A record
  // whose repo/run_id computeRecordPath rejects (invalid format, unsafe
  // segment) cannot possibly collide with an existing file, so treating the
  // throw as "not a duplicate" here is the same semantically-free
  // short-circuit as the run.js fix — it lets validateRecord() below be the
  // authoritative judge instead of a raw path-computation throw.
  let duplicate;
  try {
    duplicate = isDuplicate(record.run_id, record, repoRoot);
  } catch {
    duplicate = false;
  }
  if (duplicate) {
    const path = computeRecordPath(record, repoRoot);
    return { path, written: false };
  }

  // Integrity chain v1 — stamp the tamper-evident integrity block BEFORE
  // validating + writing, so the persisted record self-certifies.
  //
  // Serialized-ingest assumption (LOCKED CONTRACT step 4): ingest.yml is
  // concurrency-serialized and writeRecord is synchronous, so reading the chain
  // head and then appending after the write is race-free. A fork for
  // truly-concurrent ingest (two writers assigning the same seq) is OUT OF SCOPE
  // — see lib/chain-manifest.js. The order is: read head → compute digest over
  // the record WITHOUT integrity (stable regardless of the block) → stamp
  // integrity → write the record → append the manifest line. The append happens
  // ONLY after the record write succeeds, and only on this real-write path
  // (never on the duplicate short-circuit above).
  const head = readChainHead(repoRoot);
  const digest = submissionDigest(record);
  record.integrity = {
    submission_digest: digest,
    prev_digest: head.submission_digest,
    seq: head.seq + 1,
  };

  // Enforce dogfood-record.schema.json BEFORE touching the filesystem.
  // Better to throw loudly than silently persist a malformed record — the
  // schema is the contract every downstream consumer relies on.
  validateRecord(record);

  // F-bbbe2e1f: see UnsafeRecordPathError's doc comment. Wrap this SECOND
  // computeRecordPath() call — the first is inside isDuplicate() above,
  // already guarded by F-a37d36f5 — so a schema-valid-but-unsafe repo (e.g.
  // `../etc`) throws a classified error instead of a bare one.
  let path;
  try {
    path = computeRecordPath(record, repoRoot);
  } catch (err) {
    throw new UnsafeRecordPathError(record, err);
  }
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

  // Append the chain ledger line AFTER the record write succeeds. The manifest
  // append is atomic (temp+rename rewrite — see lib/chain-manifest.js); a torn
  // append cannot leave a half-line. `path` field is the record path RELATIVE to
  // repoRoot, forward-slashed, so the ledger is portable across OSes and a line
  // copy-pasted into a raw.githubusercontent URL is not a broken link (mirrors
  // the posixify-at-the-boundary doctrine in run.js / rebuild-indexes.js).
  const relPath = relative(repoRoot, path).split(sep).join('/');
  appendChainEntry(repoRoot, {
    seq: record.integrity.seq,
    run_id: record.run_id,
    repo: record.repo,
    status: record.verification?.status ?? 'accepted',
    path: relPath,
    submission_digest: record.integrity.submission_digest,
    prev_digest: record.integrity.prev_digest,
    persisted_at: new Date().toISOString(),
  });

  return { path, written: true };
}
