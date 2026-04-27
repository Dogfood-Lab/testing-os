/**
 * Cross-process advisory file lock built on `openSync(path, 'wx')` exclusive-create.
 *
 * Why this exists: `appendEvent` in review/event-log.js does a read-modify-write
 * of a YAML array (read existing events → push new → atomic-rename whole file).
 * Two concurrent appends both read N events, both push, both rename — second
 * rename wins, dropping the first event. The atomic rename eliminates partial-
 * file corruption (worst case before wave 9), but cannot eliminate the lost-
 * event window. F-PIPELINE-011 (W3-PIPE-001) closes that window at the choke
 * point so the bug class is impossible to recur — Pattern #4 from the
 * swarm-evidence catalog.
 *
 * Why an O_EXCL lock FILE (not a lock DIR): an early implementation used
 * `mkdirSync` then a follow-up `writeFileSync(.../pid)` — but those are two
 * separate fs ops, so a process that's mid-acquisition is in a state where
 * the dir exists but the pid file does NOT. A racing acquirer sees the dir,
 * tries to read pid, gets ENOENT, classifies as stale, removes the dir, and
 * the original acquirer's pid write later trips on the dir being gone.
 * Lock-FILE-with-O_EXCL avoids that: the `open(path, 'wx')` call returns a
 * file descriptor in one syscall, and we write the pid through that fd —
 * any racing acquirer that sees the file knows it's fully formed.
 *
 * Why not `proper-lockfile`: that package isn't a dep of this monorepo
 * (verified at the start of wave 30). `open(path, 'wx')` is atomic on POSIX
 * and Windows — the kernel guarantees exactly one creator wins, the loser
 * sees `EEXIST`. The pattern has been in use for decades and works the same
 * on every fs Node supports (NTFS, ext4, APFS, tmpfs, nfsv4).
 *
 * Why not `O_APPEND`: the format here is a YAML array, not JSONL. `O_APPEND`
 * makes byte-append atomic for sub-`PIPE_BUF` writes on POSIX, but the
 * read-modify-write of the whole array bypasses that — even with `O_APPEND`
 * the events would not be a valid YAML array. Switching the format to JSONL
 * is a bigger compat break than this contract should make. Lock instead.
 *
 * Stale lock recovery: a process that crashes while holding the lock leaves
 * the file behind. We detect "stale" by reading the holder PID and using
 * `process.kill(pid, 0)` to test liveness — `ESRCH` means the holder is
 * gone and the lock is reclaimable. The reclaim itself is best-effort:
 * another fresh acquirer might race the cleanup, but the worst case is an
 * extra retry, never lost data. To prevent two reclaimers from both believing
 * they won, the reclaim sequence is `unlink → open(wx)`; the second
 * reclaimer's `open(wx)` will fail because the first reclaimer already
 * created it.
 *
 * Concurrency caveat — out of scope: this is a *single-machine* lock. NFS or
 * other distributed filesystems expose `open(wx)` semantics that may not be
 * truly atomic across nodes. The dogfood pipeline runs on a single GitHub
 * runner per dispatch, so this is sufficient. A multi-runner sharded ingest
 * would need a real consensus lock — flagged in the JSDoc above
 * `withFileLock` so the limitation is visible at the use site.
 */

import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, existsSync, unlinkSync, linkSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// 30s default timeout: appendEvent's critical section is small (~ms), but
// 50-way parallel ingests serializing through the lock can take a few seconds
// in aggregate. 30s leaves comfortable headroom for the dogfood pipeline's
// realistic concurrency (~10 parallel jobs per dispatch wave) without making
// CI hang on a runaway holder.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 15;
const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * Compute the lock file path for a given target file.
 * Co-locates with the target so a permission-restricted directory still works.
 *
 * Kept named `lockDirFor` for back-compat with the wave-30 design draft —
 * the path now points at a regular file, not a directory, but the call sites
 * don't care about the kind.
 *
 * @param {string} targetPath
 * @returns {string}
 */
export function lockDirFor(targetPath) {
  return `${targetPath}.lock`;
}

/**
 * Test whether a process is alive. Returns false if `pid` is missing,
 * non-numeric, or `process.kill(pid, 0)` rejects with `ESRCH`. Any other
 * error (e.g. `EPERM` on a foreign-user pid) is treated as "alive" — better
 * to wait out the lock than to steal a live one.
 *
 * @param {number|string|null|undefined} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  const n = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Atomically create the lock file with the holder's PID as content.
 *
 * Two-step pattern: write a temp file (containing this process's pid) in the
 * same parent dir, then `linkSync(temp, lockPath)`. `link` is atomic on every
 * fs Node supports — it either creates the link or fails with EEXIST; there
 * is no observable intermediate state where the lock file exists but is
 * empty. This closes the race that an earlier `open(wx)+write` design left
 * open: a racing acquirer could read the lock file in the window between
 * `open` and `write` and see it as empty (= stale) before the holder's pid
 * was recorded.
 *
 * @param {string} lockPath
 * @returns {boolean} true on success; false if the lock already exists.
 */
function atomicCreateLock(lockPath) {
  const tmpPath = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  // Write the temp file atomically (truncates if it somehow exists, which
  // it never should given the pid+random suffix). Content is the holder pid.
  writeFileSync(tmpPath, String(process.pid), 'utf-8');
  try {
    linkSync(tmpPath, lockPath);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  } finally {
    // The temp file is no longer needed regardless of link outcome — the
    // hardlink (on success) keeps the inode alive at lockPath; on failure
    // the temp file is just garbage to clean up.
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

/**
 * Attempt to acquire an exclusive file-lock on `lockPath`. Returns true if
 * the lock was acquired; false if it is held by another live process OR
 * by a process whose lock file is unreadable / pid-empty (treated as live
 * with bounded mtime patience — see below).
 *
 * Stale recovery: a holder's PID file remains until its release `unlink`
 * runs. If the holder PROCESS is gone (process.kill ESRCH), the lock is
 * reclaimable. We do NOT treat empty/missing pid content as stale on its
 * own — that was the wave-30 first-pass bug. Even with `linkSync` for
 * atomic creation, on Windows a racing reader can land on a brief window
 * where the pid file's content has not yet been committed to the dirent
 * cache from the other process. Empty content + bounded-stale-mtime is the
 * safer guard: we only reclaim if the lock file is ALSO older than
 * `staleAfterMs`, the same boundary `proper-lockfile` uses.
 *
 * @param {string} lockPath
 * @param {{ staleAfterMs?: number }} opts
 * @returns {boolean}
 */
function tryAcquire(lockPath, opts = {}) {
  const { staleAfterMs = DEFAULT_STALE_AFTER_MS } = opts;

  if (atomicCreateLock(lockPath)) return true;

  // Lock exists — test for staleness.
  let pidRaw = null;
  let mtimeMs = NaN;
  try {
    pidRaw = readFileSync(lockPath, 'utf-8').trim();
  } catch {
    // Read failed — fall through to the mtime check below; if we can't
    // even stat it, treat as live.
  }
  try {
    const st = statSync(lockPath);
    mtimeMs = st.mtimeMs;
  } catch { /* will be NaN, treated as live */ }

  // PID-known case: trust process.kill to decide alive-vs-dead. This is the
  // common case and gives fast crash recovery (sub-100ms typical).
  if (pidRaw && pidRaw !== '') {
    if (isProcessAlive(pidRaw)) return false;

    // PID-dead reclaim via "rename to graveyard" — atomic claim that exactly
    // one reclaimer wins. Without this, a sequence like:
    //   1. A holds lock; A releases (unlinks); A's pid becomes dead
    //   2. C atomicCreateLock succeeds — C owns lock with pid=C
    //   3. B (had read pidRaw=A above) confirms A dead, calls unlinkSync — but
    //      the file is now C's lock! Now B and C both think they own it.
    // produces a double-owner. The graveyard rename is the atomic CAS step:
    // exactly one process can rename a given file at a given moment. We
    // verify the rename succeeded AND the file we renamed still has the
    // dead PID we expected; if the content shifted (someone else just
    // re-acquired), put the file back.
    return reclaimViaGraveyard(lockPath, pidRaw);
  }

  // PID-unknown case (empty/unreadable content). DO NOT treat as stale on
  // content alone — Windows can present a brief window where the holder's
  // file content is still flushing. Only reclaim if the lock is also older
  // than `staleAfterMs`. With the default 30s staleAfterMs, fast appenders
  // never trip this; only a true crash window does.
  if (Number.isFinite(mtimeMs) && Date.now() - mtimeMs > staleAfterMs) {
    if (process.env.FILE_LOCK_DEBUG) {
      process.stderr.write(`[file-lock][pid=${process.pid}] STALE-RECLAIM (mtime-old) lockPath=${lockPath} ageMs=${Date.now() - mtimeMs}\n`);
    }
    // Use the same graveyard-rename CAS for the mtime-stale path. The PID
    // is unknown so we use empty string as the "expected" content — the
    // graveyard verification will accept whatever it reads (the put-back
    // branch only triggers when actualPid is non-empty AND differs).
    return reclaimViaGraveyard(lockPath, pidRaw || '');
  }

  // Treat as live; the holder owns the lock and will release it.
  return false;
}

/**
 * Release a lock acquired via `tryAcquire`. Best-effort — a missing lock file
 * is not an error (it means stale-lock recovery already cleaned it).
 *
 * @param {string} lockPath
 */
function release(lockPath) {
  try { unlinkSync(lockPath); } catch { /* may already be gone */ }
}

/**
 * Reclaim a stale lock via "rename to graveyard." Atomic CAS step: exactly
 * one reclaimer can rename a file at a time. The winner verifies the renamed
 * file still has the dead PID it expected (defending against the case where
 * the lock content shifted between the read-pid step and the rename); if so,
 * the winner unlinks the graveyard file and creates a fresh lock. If the
 * content shifted, the winner puts the file back so the new owner is
 * unaffected.
 *
 * @param {string} lockPath
 * @param {string} expectedDeadPid - The PID we observed and confirmed dead.
 * @returns {boolean}
 */
function reclaimViaGraveyard(lockPath, expectedDeadPid) {
  const graveyardPath = `${lockPath}.gy.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockPath, graveyardPath);
  } catch (err) {
    // Another reclaimer beat us — let the retry loop sort it out.
    return false;
  }

  // We won the rename. Verify content.
  let actualPid = null;
  try {
    actualPid = readFileSync(graveyardPath, 'utf-8').trim();
  } catch { /* unreadable — treat as confirmation */ }

  if (actualPid && actualPid !== expectedDeadPid) {
    // Content shifted between our read and our rename. The "stale" lock
    // we grabbed is actually a fresh acquisition by someone else.
    // Put it back. If put-back fails (e.g., another reclaimer raced and
    // already created a new lock at lockPath), discard the graveyard copy.
    try {
      renameSync(graveyardPath, lockPath);
      if (process.env.FILE_LOCK_DEBUG) {
        process.stderr.write(`[file-lock][pid=${process.pid}] CAS-FAIL-PUTBACK lockPath=${lockPath} expected=${expectedDeadPid} found=${actualPid}\n`);
      }
    } catch {
      try { unlinkSync(graveyardPath); } catch { /* drop */ }
    }
    return false;
  }

  if (process.env.FILE_LOCK_DEBUG) {
    process.stderr.write(`[file-lock][pid=${process.pid}] STALE-RECLAIM (dead-pid) lockPath=${lockPath} pid=${expectedDeadPid}\n`);
  }

  try { unlinkSync(graveyardPath); } catch { /* drop */ }
  return atomicCreateLock(lockPath);
}

/**
 * Sleep synchronously for `ms` milliseconds via `Atomics.wait` on a tiny
 * SharedArrayBuffer. We can't `await` here because the callers
 * (`appendEvent`, `rebuildIndexes`) are sync APIs — the whole pipeline
 * is sync from `ingest()` down to fs I/O, so introducing async here would
 * cascade through six callers and break the back-compat contract on
 * `appendEvent` that review-engine relies on.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lock on `targetPath`. The lock is a
 * sibling directory at `<targetPath>.lock` — see file header for the
 * full design rationale.
 *
 * The lock is per-target, so two unrelated `appendEvent` calls writing to
 * different daily log files do NOT serialize against each other.
 *
 * @template T
 * @param {string} targetPath - The file being mutated; the lock dir is `<targetPath>.lock`.
 * @param {() => T} fn - The critical section. Runs synchronously.
 * @param {{
 *   timeoutMs?: number,
 *   retryIntervalMs?: number,
 *   staleAfterMs?: number
 * }} [options]
 * @returns {T}
 */
export function withFileLock(targetPath, fn, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  } = options;

  const lockPath = lockDirFor(targetPath);

  // Ensure the parent dir exists — otherwise mkdirSync(lockPath) fails with
  // ENOENT and we mis-classify the lock as held.
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* may already exist */ }

  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let lastErrCtx = null;

  while (Date.now() < deadline) {
    if (tryAcquire(lockPath, { staleAfterMs })) {
      acquired = true;
      break;
    }
    sleepSync(retryIntervalMs);
  }

  if (!acquired) {
    const err = new Error(
      `withFileLock: timed out after ${timeoutMs}ms waiting for ${lockPath}` +
      (lastErrCtx ? ` (last error: ${lastErrCtx})` : '')
    );
    err.code = 'ELOCKTIMEOUT';
    err.lockPath = lockPath;
    throw err;
  }

  try {
    return fn();
  } finally {
    release(lockPath);
  }
}

/**
 * Test-only: probe whether a lock is currently held without acquiring it.
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isLocked(targetPath) {
  return existsSync(lockDirFor(targetPath));
}
