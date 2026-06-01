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
 * `sleepSync` in `file-lock.js:286` — the contract is identical; the
 * helper is duplicated here because rename-with-retry must not import the
 * larger file-lock module (cyclic-import risk: atomic-write imports
 * rename-with-retry, and file-lock imports atomic-write transitively
 * through the lock-event write path).
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
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
