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
 *   - mock fetch hangs past timeout → exhausted-timeout THROWS a
 *     `scenario-fetch-fault:` whose detail keeps the literal word 'timeout'
 *     (F-07ab7f86 superseded the original typed-reason return: a sustained
 *     slow-API window is outage-class, and returning 'timeout' made run.js
 *     persist a rejected record whose run_id the duplicate guard then
 *     poisoned)
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
  it('POSITIVE timeout: exhausting every attempt on a hang THROWS scenario-fetch-fault with "timeout" in the detail (F-07ab7f86)', async () => {
    // Mock fetch that never resolves UNTIL aborted — mimicking a hung
    // upstream. The fetcher must abort every attempt, then classify the
    // exhaustion as OPERATIONAL (outage-class), keeping the word 'timeout'
    // in the thrown detail so the operator pivot key survives.
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
      // exhaustion classification — the retry path is covered in
      // ingest-proact-003-scenario-fetch-retry.test.js.
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef', { timeoutMs: 50, attempts: 1 });
      await assert.rejects(
        fetcher.fetchWithReason('sanity'),
        /scenario-fetch-fault: timeout/,
        'exhausted timeout must throw the classified operational fault, not return a typed reason'
      );
    });
  });

  it('POSITIVE timeout retry: a single timeout followed by a 200 still returns the scenario', async () => {
    // The timeout stays RETRYABLE mid-budget — only exhaustion throws.
    let n = 0;
    const flakyFetch = (_url, { signal } = {}) => {
      n += 1;
      if (n === 1) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        async text() {
          return [
            'scenario_id: sanity',
            'scenario_name: Sanity smoke',
            'scenario_version: 1.0.0',
            'product_surface: cli',
            'execution_mode: bot',
            'description: Smoke-checks the CLI happy path.',
            'steps:',
            '  - id: one',
            '    action: run the CLI once',
            'success_criteria:',
            '  required_steps:',
            '    - one',
            ''
          ].join('\n');
        }
      });
    };

    await withMockFetch(flakyFetch, async () => {
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef', {
        timeoutMs: 50, attempts: 2, sleepImpl: () => {}
      });
      const result = await fetcher.fetchWithReason('sanity');
      assert.ok(result.scenario, `a mid-budget timeout must be retried; got ${JSON.stringify(result)}`);
      assert.equal(n, 2);
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
    // Schema-valid fixture (V2-CROSS-BO-002 added a validatePayload gate at
    // the fetch boundary).
    const goodFetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return [
          'scenario_id: sanity',
          'scenario_name: Sanity smoke',
          'scenario_version: 1.0.0',
          'product_surface: cli',
          'execution_mode: bot',
          'description: Smoke-checks the CLI happy path.',
          'steps:',
          '  - id: one',
          '    action: run the CLI once',
          'success_criteria:',
          '  required_steps:',
          '    - one',
          ''
        ].join('\n');
      }
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
    // diagnosing a stale scenario chain can distinguish 404 from
    // parse_error. Pre-fix: loadScenarios consumed only the legacy
    // .fetch(id) truthiness, dropping the discriminator. (This pin
    // originally used the timeout class; F-07ab7f86 migrated exhausted
    // timeout to a thrown operational fault, so parse_error carries the
    // typed-reason-propagation invariant now.)
    const badYamlFetch = async () => ({
      ok: true,
      status: 200,
      async text() { return 'this: is\n  not: yaml\n - {[\n'; }
    });

    await withMockFetch(badYamlFetch, async () => {
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef', { timeoutMs: 50, attempts: 1 });
      const submission = {
        scenario_results: [{ scenario_id: 'sanity', product_surface: 'cli' }]
      };
      const result = await loadScenarios(submission, fetcher);
      assert.equal(result.scenarios.size, 0, 'unloadable scenario must not appear in scenarios map');
      assert.equal(result.errors.length, 1, 'one failed fetch produces one error entry');
      assert.match(result.errors[0], /reason: parse_error/,
        `error string must surface the typed reason; got ${JSON.stringify(result.errors[0])}`);
    });
  });

  it('L1-007 exhaustion: a timed-out fetch inside loadScenarios PROPAGATES as scenario-fetch-fault (F-07ab7f86)', async () => {
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
      await assert.rejects(
        loadScenarios(submission, fetcher),
        /scenario-fetch-fault: timeout/,
        'a sustained slow-API window must surface operational (exit 2, nothing persisted), never as a scenario-load rejection'
      );
    });
  });
});
