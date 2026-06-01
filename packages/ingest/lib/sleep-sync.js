/**
 * sleepSync — `Atomics.wait`-based synchronous sleep.
 *
 * Sibling of `packages/findings/lib/file-lock.js`'s private `sleepSync`. The
 * duplication exists because npm workspaces do not allow `ingest → findings`
 * imports (findings already depends on ingest, and the reverse edge would
 * create a workspace dependency cycle — same constraint that forced
 * `packages/ingest/lib/atomic-write.js` to duplicate
 * `packages/findings/lib/atomic-write.js`).
 *
 * The helper exists to replace the `while (Date.now() < until)` busy-spin
 * loops sprinkled across synchronous backoff paths (notably
 * `packages/ingest/lib/rename-with-retry.js`'s EPERM/EBUSY retry on Windows
 * NTFS). Spin loops burn a full CPU core for the entire backoff window
 * — Atomics.wait cedes the thread.
 *
 * Why synchronous: the callsites (atomic-write helpers, rebuild-indexes,
 * event-log appender, rename-with-retry) are themselves synchronous and
 * cascading an `await` would leak the boundary into otherwise-deterministic
 * flush paths — same rationale documented at the findings sibling.
 *
 * @param {number} ms - Milliseconds to sleep. Non-finite or non-positive
 *   values are no-ops (we don't trust caller arithmetic to never produce
 *   negative deltas if a system clock skews).
 */
export function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}
