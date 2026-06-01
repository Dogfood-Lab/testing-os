/**
 * renameWithRetry — Windows-tolerant atomic rename.
 *
 * Sibling of `packages/findings/lib/rename-with-retry.js`. The two files
 * have the same contract; the duplication exists because npm workspaces do
 * not allow `ingest → findings` imports (findings already depends on ingest,
 * and adding the reverse edge would create a workspace dependency cycle).
 *
 * On Windows NTFS, `renameSync(tmp, target)` can throw EPERM/EBUSY even when
 * the calling process holds the file lock, because antivirus / Search Indexer
 * / backup agents hold transient handles across the rename window. Bounded
 * exponential backoff retries past the transient handle.
 *
 * Synchronous-on-purpose: the call sites (atomic-write helpers, rebuild-indexes,
 * event-log appender) are themselves synchronous, and an async retry would
 * leak the boundary into otherwise-deterministic flush paths.
 *
 * @param {string} tmp - Source path (the just-written temp file).
 * @param {string} dest - Destination path (the canonical artifact).
 * @param {object} [opts]
 * @param {number} [opts.retries=10] - Max retry attempts after the first failure.
 * @param {number} [opts.baseMs=15]  - Initial backoff in ms (doubles each step).
 * @param {number} [opts.maxMs=200]  - Cap on per-step backoff.
 */
import { renameSync } from 'node:fs';

import { sleepSync } from './sleep-sync.js';

export function renameWithRetry(tmp, dest, { retries = 10, baseMs = 15, maxMs = 200 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (err) {
      if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || i === retries) throw err;
      const delay = Math.min(baseMs * (1 << i), maxMs);
      // D1B-002-ingest (Stage C humanization fold): replaced the
      // `while (Date.now() < until)` busy-spin with the Atomics.wait-
      // based sleepSync helper. Same workspace-cycle pattern as
      // `ingest/lib/atomic-write.js` — sibling helper, not a
      // cross-package import.
      sleepSync(delay);
    }
  }
}
