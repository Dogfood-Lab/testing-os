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
 * @param {string} tmp - Source path (the just-written temp file).
 * @param {string} dest - Destination path (the canonical artifact).
 * @param {object} [opts]
 * @param {number} [opts.retries=10] - Max retry attempts after the first failure.
 * @param {number} [opts.baseMs=15]  - Initial backoff in ms (doubles each step).
 * @param {number} [opts.maxMs=200]  - Cap on per-step backoff.
 */
import { renameSync } from 'node:fs';

export function renameWithRetry(tmp, dest, { retries = 10, baseMs = 15, maxMs = 200 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || i === retries) throw err;
      const delay = Math.min(baseMs * (1 << i), maxMs);
      // Synchronous sleep — the public API is sync (matches renameSync), so
      // setTimeout would change the contract. Spin-wait is acceptable here
      // because the delays are bounded (≤200ms) and the failure mode is rare.
      const until = Date.now() + delay;
      while (Date.now() < until) { /* spin */ }
    }
  }
}
