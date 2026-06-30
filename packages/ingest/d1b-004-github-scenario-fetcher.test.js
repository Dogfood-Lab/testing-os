/**
 * d1b-004-github-scenario-fetcher.test.js
 *
 * D1B-004 (Stage C humanization) — `githubScenarioFetcher` had two
 * operator-legibility holes:
 *
 *   1. No per-request timeout. A hung GitHub API call (rate-limit throttle,
 *      regional outage, slow connection) would stall ingest indefinitely
 *      — bounded only by the outer CI 10-min kill. Sibling fix already
 *      shipped at `packages/verify/validators/provenance.js:80-104`
 *      (AbortController + 30s timeout); this finding ports that pattern.
 *
 *   2. Untyped failure return. `null` covered four distinct failure modes
 *      (timeout, 404, JSON parse, network reject) — the operator could not
 *      pivot on the reason. Fix: return a typed object that names the
 *      failure class for human triage.
 *
 * Lens: every external uncertain operation must be bounded (timeout) AND
 * typed (failure-class discriminable).
 *
 * Invariant (all four mode-cases enforced):
 *   - mock fetch hangs past timeout → result.reason === 'timeout'
 *   - mock fetch returns 404         → result.reason === 'not_found'
 *   - mock fetch returns 200 + bad JSON → result.reason === 'parse_error'
 *   - mock fetch returns 200 + good YAML → scenario returned as before
 *     (back-compat: `loadScenarios` consumes the result without crashing)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubScenarioFetcher, loadScenarios } from './load-context.js';

// ─────────────────────────────────────────────────────────────────
// Test seam: githubScenarioFetcher uses `globalThis.fetch` so we
// swap it in/out per test. Tests restore the original in finally
// blocks to keep the namespace clean for sibling tests.
// ─────────────────────────────────────────────────────────────────

async function withMockFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    // MUST await: `githubScenarioFetcher` reads `globalThis.fetch` at call
    // time (the documented test seam), once per retry attempt. Returning the
    // pending promise without awaiting let `finally` restore the real fetch
    // synchronously — so the INGEST-PROACT-003 retry's 2nd+ attempt then hit
    // the real api.github.com with a fake token (404 -> not_found), an
    // intermittent flake. Awaiting keeps the mock installed for every attempt.
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe('D1B-004 — githubScenarioFetcher AbortController + typed reason', () => {
  it('POSITIVE timeout: a hang past the AbortController deadline yields reason="timeout"', async () => {
    // Mock fetch that never resolves UNTIL aborted — mimicking a hung
    // upstream. The fetcher must abort and surface reason="timeout".
    const hangingFetch = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
      // When AbortController fires, throw a real AbortError so the
      // fetcher's catch can pivot on err.name === 'AbortError'.
      signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });

    await withMockFetch(hangingFetch, async () => {
      // Pass an artificially short timeout to keep the test runtime bounded
      // (production default is 30s) and attempts:1 so this case isolates the
      // single-attempt timeout classification — the retry path is covered in
      // f-ingest-003-scenario-fetch-retry.test.js.
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef', { timeoutMs: 50, attempts: 1 });
      const result = await fetcher.fetchWithReason('sanity');
      assert.equal(result.scenario, null);
      assert.equal(result.reason, 'timeout',
        `expected reason="timeout"; got ${JSON.stringify(result)}`);
    });
  });

  it('POSITIVE 404: missing scenario yields reason="not_found"', async () => {
    const notFoundFetch = async () => ({ ok: false, status: 404, async text() { return ''; } });
    await withMockFetch(notFoundFetch, async () => {
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef');
      const result = await fetcher.fetchWithReason('sanity');
      assert.equal(result.scenario, null);
      assert.equal(result.reason, 'not_found');
    });
  });

  it('POSITIVE parse error: 200 OK with malformed YAML yields reason="parse_error"', async () => {
    const badYamlFetch = async () => ({
      ok: true,
      status: 200,
      async text() { return 'this: is\n  not: yaml\n - {[\n'; }
    });
    await withMockFetch(badYamlFetch, async () => {
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef');
      const result = await fetcher.fetchWithReason('sanity');
      assert.equal(result.scenario, null);
      assert.equal(result.reason, 'parse_error');
    });
  });

  it('POSITIVE success: 200 OK with valid YAML returns the scenario (no reason field)', async () => {
    const goodFetch = async () => ({
      ok: true,
      status: 200,
      async text() { return 'scenario_id: sanity\nsteps:\n  - id: one\n    purpose: smoke\n'; }
    });
    await withMockFetch(goodFetch, async () => {
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef');
      const result = await fetcher.fetchWithReason('sanity');
      assert.ok(result.scenario, 'success path must return a scenario object');
      assert.equal(result.scenario.scenario_id, 'sanity');
      // Success path: reason field is absent (or null) — operators
      // distinguish failure-class signals from successful loads.
      assert.ok(result.reason == null,
        'success path must NOT carry a reason field');
    });
  });

  it('back-compat: loadScenarios still consumes the legacy success path without crashing', async () => {
    // loadScenarios MUST keep working with the new contract. We exercise
    // both: a success returning the scenario object, AND a failure
    // returning a typed reason — the error message must surface the
    // reason so the operator sees WHY the scenario didn't load.
    const goodFetcher = {
      fetch: async () => ({ scenario_id: 'sanity', steps: [{ id: 'one' }] })
    };
    const submission = {
      scenario_results: [{ scenario_id: 'sanity', product_surface: 'cli' }]
    };
    const result = await loadScenarios(submission, goodFetcher);
    assert.equal(result.errors.length, 0,
      `success path must not produce errors; got ${JSON.stringify(result.errors)}`);
    assert.ok(result.scenarios.has('sanity'),
      'scenarios map must include the loaded scenario');
  });

  it('L1-007: loadScenarios propagates typed reason when fetcher exposes fetchWithReason', async () => {
    // The typed reason MUST reach the consumer (errors[]) so an operator
    // diagnosing a stale scenario chain can distinguish timeout from 404
    // from parse_error. Pre-fix: loadScenarios consumed only the legacy
    // .fetch(id) truthiness, dropping the discriminator.
    const timeoutFetch = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });

    await withMockFetch(timeoutFetch, async () => {
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef', { timeoutMs: 50, attempts: 1 });
      const submission = {
        scenario_results: [{ scenario_id: 'sanity', product_surface: 'cli' }]
      };
      const result = await loadScenarios(submission, fetcher);
      assert.equal(result.scenarios.size, 0, 'timed-out scenario must not appear in scenarios map');
      assert.equal(result.errors.length, 1, 'one timed-out fetch produces one error entry');
      assert.match(result.errors[0], /reason: timeout/,
        `error string must surface the typed reason; got ${JSON.stringify(result.errors[0])}`);
    });
  });
});
