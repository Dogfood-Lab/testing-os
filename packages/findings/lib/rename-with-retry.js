/**
 * renameWithRetry — Windows-tolerant atomic rename.
 *
 * On Windows NTFS, `renameSync(tmp, target)` can throw EPERM (or EBUSY) even
 * when the calling process holds the file lock. The most common cause is a
 * transient handle held by a sibling — antivirus scanning the freshly-written
 * temp, Search Indexer, Defender, a backup agent — across the rename window.
 * The handle releases on its own within milliseconds, but the bare renameSync
 * is unforgiving and surfaces the error to the operator.
 *
 * The fix is a bounded exponential-backoff retry. The W3-PIPE-001 wave-30
 * receipt documents the 50/50 multi-process race-test outcome with this
 * mitigation in place; without it, that test fails reliably on Windows CI.
 *
 * Synchronous-on-purpose: the call sites here (atomic-write helpers, event-log
 * appender) are themselves synchronous, and Promise-based retries would
 * leak the async boundary into otherwise-deterministic flush paths.
 *
 * D1B-002-findings — the backoff used to be a CPU-busy `while (Date.now() <
 * until)` spin. The repo already ships `sleepSync` via `Atomics.wait` on a
 * tiny SharedArrayBuffer (see `file-lock.js:286`). Atomics.wait yields the
 * thread instead of pegging a core, with the same sync API. The retry
 * envelope and visible behaviour are preserved; only the cost of the wait
 * changes.
 *
 * @param {string} tmp - Source path (the just-written temp file).
 * @param {string} dest - Destination path (the canonical artifact).
 * @param {object} [opts]
 * @param {number} [opts.retries=10] - Max retry attempts after the first failure.
 * @param {number} [opts.baseMs=15]  - Initial backoff in ms (doubles each step).
 * @param {number} [opts.maxMs=200]  - Cap on per-step backoff.
 */
import { renameSync } from 'node:fs';

/**
 * Sleep synchronously for `ms` milliseconds via `Atomics.wait` on a tiny
 * SharedArrayBuffer. Yields the thread (does not spin). Mirrors the
 * `sleepSync` in `file-lock.js` — the contract is identical; the
 * helper is duplicated here because rename-with-retry must not import the
 * larger file-lock module (cyclic-import risk: atomic-write imports
 * rename-with-retry, and file-lock imports atomic-write transitively
 * through the lock-event write path).
 *
 * F-3a7c4d67 (sibling sweep): this file's own `ms <= 0` guard does NOT
 * catch `ms = NaN` — every comparison with NaN is `false` in JS, so
 * `NaN <= 0` is `false` and execution falls through to
 * `Atomics.wait(view, 0, 0, NaN)`, independently confirmed (isolated
 * one-liner, no repo writes) to hang the calling thread indefinitely, no
 * bound, no error, no log line — the same defect class F-3a7c4d67 named in
 * file-lock.js's sibling `sleepSync`, found here via that finding's own
 * "sweep for every sibling" discipline, not named in the finding's own
 * text. Reachable via `renameWithRetry(tmp, dest, { baseMs: NaN })` or
 * `{ maxMs: NaN }` — `Math.min(NaN * 2**i, maxMs)` and
 * `Math.min(baseMs * 2**i, NaN)` both evaluate to NaN, and the only current
 * production caller (`atomic-write.js`) calls with zero options today, so
 * this is latent-but-real against the function's own public option surface,
 * not a live bug. Widened to the same `Number.isFinite` check
 * `packages/ingest/lib/sleep-sync.js` already carries.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Test-only: exercise the private `sleepSync` guard directly, without
 * forcing a real EPERM/EBUSY filesystem race through `renameWithRetry`.
 * Mirrors `file-lock.js`'s own `isLocked` test-only export precedent.
 */
export function __testSleepSync(ms) {
  return sleepSync(ms);
}

export function renameWithRetry(tmp, dest, { retries = 10, baseMs = 15, maxMs = 200 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || i === retries) throw err;
      const delay = Math.min(baseMs * (1 << i), maxMs);
      // Synchronous sleep via Atomics.wait — yields the thread instead of
      // spinning. The public API stays sync (matches renameSync). The
      // delays remain bounded (≤200ms) and the failure mode is rare.
      sleepSync(delay);
    }
  }
}
