/**
 * f-3a7c4d67-file-lock-defensive-gaps.test.js
 *
 * F-3a7c4d67 (Stage C humanization) — two independent defensive gaps in
 * file-lock.js's small retry loop, found together:
 *
 * (1) The private `sleepSync(ms)` helper had no guard on `ms`, unlike its
 *     documented sibling `packages/ingest/lib/sleep-sync.js`. Independently
 *     re-confirmed (isolated Node one-liner, no repo writes, run and killed
 *     under a bounded Bash timeout before this fix was written) that
 *     `Atomics.wait(view, 0, 0, NaN)` never returns — it hangs the calling
 *     thread indefinitely. Reachable via
 *     `withFileLock(path, fn, { retryIntervalMs: NaN })`, e.g. a config
 *     value computed as `x / y` with `y === 0`.
 *
 * (2) `withFileLock`'s ELOCKTIMEOUT error message promised a
 *     `(last error: ...)` clause, but `lastErrCtx` was declared, read once,
 *     and NEVER assigned anywhere in the function (confirmed by grep before
 *     this fix: exactly two occurrences of the identifier — declaration +
 *     the dead read). Every real lock-timeout rendered the bare
 *     "timed out after Nms waiting for X" with the promised detail
 *     permanently absent.
 *
 * RED proof (reasoned, not re-executed as a hang risk — actually flipping
 * the NaN-guard fix off and running these tests would risk hanging the test
 * process on this exact defect, which is the WORST possible way to prove a
 * hang bug): pre-fix, `sleepSync(NaN)` would have hung test (1) forever, and
 * `lastErrCtx` was structurally incapable of being non-null pre-fix (it was
 * assigned exactly once, at declaration, to `null`, and never reassigned) —
 * both facts independently re-derived by reading file-lock.js's pre-fix
 * source directly (see file header for the byte-for-byte grep confirmation),
 * not carried over from the finding's own prose.
 *
 * There were zero existing tests for withFileLock/tryAcquire/sleepSync in
 * this file before this fix (confirmed by grep across packages/findings for
 * "withFileLock"/"ELOCKTIMEOUT" — only file-lock.js itself matched) — this
 * is the first regression coverage this module has ever had.
 *
 * SIBLING SWEEP (per swarms/PROTOCOL.md "Fixing a class, not an instance"):
 * grepped packages/verify, packages/findings, packages/ingest,
 * packages/report, packages/portfolio for "Atomics.wait" — three hits
 * beyond file-lock.js itself: packages/ingest/lib/sleep-sync.js (already
 * correctly guarded — the sibling F-3a7c4d67's own text cites as the
 * documented-correct comparison), packages/findings/lib/rename-with-retry.js
 * (found the SAME gap independently: a private `sleepSync` guarded only
 * `ms <= 0`, which does NOT catch `NaN` — every comparison with NaN is
 * `false` in JS — fixed alongside this file, see the "F-3a7c4d67 (3)"
 * describe block below), and packages/ingest/lib/rename-with-retry.js
 * (imports `sleepSync` from the already-correct ingest sleep-sync.js —
 * no fix needed there). Two independently-coded duplicates of the SAME
 * helper had the SAME class of gap; one already had it, one didn't — this
 * is exactly the "a sweep that finds nothing is evidence, a sweep you
 * didn't run is a finding waiting to be filed against you" case, except
 * this sweep found something and closed it in the same wave.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileLock, lockDirFor, isLocked } from './file-lock.js';
import { __testSleepSync } from './rename-with-retry.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'file-lock-f3a7c4d67-'));
}

/** Pre-create a lock file at `target`'s lock path, "held" by our own live pid. */
function seedLiveLock(target) {
  writeFileSync(lockDirFor(target), String(process.pid), 'utf-8');
}

/** @pins F-3a7c4d67 */
describe('F-3a7c4d67 (1): sleepSync no longer hangs on a non-finite retryIntervalMs', () => {
  it('retryIntervalMs=NaN: withFileLock still times out (bounded), instead of hanging forever', () => {
    const root = makeRoot();
    const target = join(root, 'events.yaml');
    seedLiveLock(target); // held by our own pid → tryAcquire never succeeds
    try {
      const start = Date.now();
      assert.throws(
        () => withFileLock(target, () => 'should not run', { timeoutMs: 150, retryIntervalMs: NaN }),
        (err) => err && err.code === 'ELOCKTIMEOUT',
        'must throw ELOCKTIMEOUT, not hang'
      );
      const elapsed = Date.now() - start;
      // A genuine Atomics.wait(NaN) hang never returns at all — any completed
      // assertion above already disproves it. This bound is generous
      // (well over timeoutMs=150) purely to guard against a slow CI box,
      // not because the fix is expected to be slow.
      assert.ok(elapsed < 5000, `expected a bounded timeout well under 5s; took ${elapsed}ms`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retryIntervalMs=NaN: the critical section fn is never invoked when the lock times out', () => {
    const root = makeRoot();
    const target = join(root, 'events.yaml');
    seedLiveLock(target);
    try {
      let ran = false;
      assert.throws(
        () => withFileLock(target, () => { ran = true; }, { timeoutMs: 100, retryIntervalMs: NaN }),
        /ELOCKTIMEOUT|timed out/
      );
      assert.equal(ran, false, 'fn must not run when the lock could never be acquired');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retryIntervalMs=-5 (negative): also stays bounded — the guard treats non-positive the same as non-finite', () => {
    const root = makeRoot();
    const target = join(root, 'events.yaml');
    seedLiveLock(target);
    try {
      const start = Date.now();
      assert.throws(
        () => withFileLock(target, () => {}, { timeoutMs: 100, retryIntervalMs: -5 }),
        (err) => err && err.code === 'ELOCKTIMEOUT'
      );
      assert.ok(Date.now() - start < 5000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** @pins F-3a7c4d67 */
describe('F-3a7c4d67 (2): withFileLock names the real cause in "(last error: ...)"', () => {
  it('a lock held by a live pid: ELOCKTIMEOUT message names "held by live process pid=<pid>"', () => {
    const root = makeRoot();
    const target = join(root, 'events.yaml');
    seedLiveLock(target);
    try {
      let caught;
      try {
        withFileLock(target, () => {}, { timeoutMs: 150, retryIntervalMs: 20 });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'must throw');
      assert.equal(caught.code, 'ELOCKTIMEOUT');
      // Pre-fix this clause never appeared at all (lastErrCtx was always
      // null) — this is the core regression proof.
      assert.match(caught.message, /\(last error: /,
        `message must now include the promised "(last error: ...)" clause; got: ${caught.message}`);
      assert.match(caught.message, new RegExp(`held by live process pid=${process.pid}`),
        `message must name the actual blocking pid; got: ${caught.message}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: a successful acquisition (no contention) still works and runs fn exactly once', () => {
    const root = makeRoot();
    const target = join(root, 'events.yaml');
    try {
      let calls = 0;
      const result = withFileLock(target, () => { calls += 1; return 'ok'; }, { timeoutMs: 1000, retryIntervalMs: 10 });
      assert.equal(result, 'ok');
      assert.equal(calls, 1);
      assert.equal(isLocked(target), false, 'the lock must be released after fn returns');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** @pins F-3a7c4d67 */
describe('F-3a7c4d67 (3): sibling instance found via sweep — rename-with-retry.js\'s own duplicated sleepSync had the identical NaN gap', () => {
  it('NaN is a no-op (returns immediately), not a hang', () => {
    const start = Date.now();
    __testSleepSync(NaN);
    const elapsed = Date.now() - start;
    // A genuine Atomics.wait(NaN) hang never returns at all — completing
    // this call already disproves it. Generous bound only for a slow CI box.
    assert.ok(elapsed < 2000, `expected an instant no-op; took ${elapsed}ms`);
  });

  it('a negative value is also a no-op, matching the finite-positive-only contract', () => {
    const start = Date.now();
    __testSleepSync(-5);
    assert.ok(Date.now() - start < 2000);
  });

  it('control: a real small positive delay still actually sleeps (the guard does not defeat legitimate backoff)', () => {
    const start = Date.now();
    __testSleepSync(30);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 25, `expected the real Atomics.wait to elapse at least ~30ms; only took ${elapsed}ms`);
  });
});
