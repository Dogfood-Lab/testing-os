/**
 * f-19d78ede-status-fetch-timeout.test.js
 *
 * F-19d78ede (Stage C humanization) — status.js's ONE network call
 * (`fetchJsonOrNull`'s `fetchImpl(url)` at the served-index fetch) had no
 * timeout, no AbortController, no `signal` — confirmed by grep across the
 * whole packages/report/ tree (source + the pre-existing test files) before
 * this fix: zero occurrences of 'timeout', 'AbortController', or 'signal'.
 * Every OTHER network call in this domain (provenance.js, load-context.js)
 * is bounded specifically because a hung API call would otherwise stall a
 * consumer's CI step until the GitHub Actions runner's own ~6h timeout
 * fires — exactly the failure class this module's own header says it
 * exists to prevent ("nothing in the consumer's own CI ever turns red").
 *
 * Fix: `fetchJsonOrNull` now wraps the fetch in an AbortController on a
 * bounded timeout (`DEFAULT_STATUS_FETCH_TIMEOUT_MS`, overridable via
 * `opts.fetchTimeoutMs`), and an expired timeout surfaces as the SAME
 * structured `INDEX_UNREACHABLE` error the function already throws for a
 * plain transport reject.
 *
 * RED proof (reasoned): pre-fix, `fetchImpl` was called as `fetchImpl(url)`
 * with no second argument at all — a `fetchImpl` that only resolves when
 * its `init.signal` fires would have hung forever (no signal was ever
 * passed to abort it), so `runStatus` would never have settled within the
 * bounded timeout these tests assert on. Independently re-derived by
 * reading the pre-fix `fetchJsonOrNull` source directly (see this file's
 * own historical single-argument call, `res = await fetchImpl(url);`),
 * not carried over from the finding's own prose. This is NOT re-executed
 * against the pre-fix code (that would require literally hanging a test
 * process to prove it, the worst possible way to prove a hang).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runStatus, DEFAULT_STATUS_FETCH_TIMEOUT_MS } from '@dogfood-lab/report/status.js';

const REPO = 'acme/widgets';

/** @pins F-19d78ede */
describe('F-19d78ede — status.js bounds its one network call with a timeout', () => {
  it('a fetchImpl that only settles when aborted: runStatus rejects INDEX_UNREACHABLE within the bounded timeout, not hanging', async () => {
    // Simulates the exact hazard: a fetch that never resolves on its own.
    // Real fetch() rejects with an AbortError when `signal` fires; this stub
    // mirrors that contract so the test proves the WIRING, not just a timer.
    const neverResolvingFetch = (url, init) => new Promise((_resolve, reject) => {
      if (!init || !init.signal) {
        reject(new Error('test bug: fetchImpl was not given a signal — timeout wiring is missing'));
        return;
      }
      init.signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });

    const start = Date.now();
    await assert.rejects(
      () => runStatus({ repo: REPO, fetchImpl: neverResolvingFetch, fetchTimeoutMs: 50 }),
      (err) => {
        assert.equal(err.code, 'INDEX_UNREACHABLE', `expected INDEX_UNREACHABLE; got code=${err.code} message=${err.message}`);
        assert.match(err.message, /timed out after 50ms/);
        return true;
      }
    );
    const elapsed = Date.now() - start;
    // A genuine unbounded hang never resolves at all — completing this
    // assert.rejects already disproves it. This bound is generous purely
    // to guard a slow CI box.
    assert.ok(elapsed < 5000, `expected the timeout to fire well under 5s; took ${elapsed}ms`);
  });

  it('DEFAULT_STATUS_FETCH_TIMEOUT_MS matches the sibling 30s convention used elsewhere in this domain', () => {
    assert.equal(DEFAULT_STATUS_FETCH_TIMEOUT_MS, 30000);
  });

  it('control: a fetchImpl that resolves quickly is unaffected by the new timeout wiring', async () => {
    const fastFetch = async () => ({
      ok: true,
      status: 200,
      async json() { return { [REPO]: { cli: { run_id: 'x', verified: 'pass', verification_status: 'accepted', finished_at: new Date().toISOString(), path: 'records/x.json' } } }; },
    });
    const result = await runStatus({ repo: REPO, fetchImpl: fastFetch, fetchTimeoutMs: 50 });
    assert.equal(result.exitCode, 0, `expected a clean accepted+fresh result; got ${result.message}`);
  });

  it('control: fetchImpl receives an AbortSignal even on the happy path (wiring is unconditional, not timeout-only)', async () => {
    let sawSignal = false;
    const fetchImpl = async (url, init) => {
      sawSignal = !!(init && init.signal instanceof AbortSignal);
      return {
        ok: true,
        status: 200,
        async json() { return { [REPO]: { cli: { run_id: 'x', verified: 'pass', verification_status: 'accepted', finished_at: new Date().toISOString(), path: 'records/x.json' } } }; },
      };
    };
    await runStatus({ repo: REPO, fetchImpl });
    assert.equal(sawSignal, true, 'fetchImpl must be called with a real AbortSignal, not just an ignored positional slot');
  });
});
