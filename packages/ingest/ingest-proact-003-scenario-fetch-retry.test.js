/**
 * ingest-proact-003-scenario-fetch-retry.test.js
 *
 * INGEST-PROACT-003 (Stage C humanization) — graceful degradation for transient
 * GitHub API faults in the scenario fetcher.
 *
 * The hole: githubScenarioFetcher.fetchWithReason() returned on the FIRST
 * upstream fault. A single transient 5xx / 429 / network blip during a CI ingest
 * turned a perfectly loadable scenario into a hard scenario-load failure — the
 * submission was rejected for an upstream hiccup that a one-second retry would
 * have ridden out.
 *
 * Fix: a small bounded retry with exponential backoff (mirrors renameWithRetry's
 * discipline) for the RETRYABLE classes only — request timeout (AbortError), a
 * 5xx server error, a 429 rate-limit, and network rejects. A 404 (not_found) and
 * an invalid id are DEFINITIVE answers and are NOT retried. The backoff sleep is
 * injectable so the test runs instantly.
 *
 * Invariant:
 *   - a transient 5xx followed by a 200 returns the scenario (the retry worked).
 *   - a 429 followed by a 200 returns the scenario.
 *   - a 404 is returned immediately with reason='not_found' and is NOT retried
 *     (exactly one fetch call).
 *   - persistent 5xx exhausts the bounded attempts and THROWS the classified
 *     `scenario-fetch-fault:` operational error after exactly `attempts` calls
 *     (V2-CROSS-BO-001 superseded the original return of the back-compat
 *     'not_found' class — an outage is an ops incident, not a missing file).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubScenarioFetcher } from './load-context.js';

const VALID_SHA = 'deadbeef';

function resp(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

// Schema-valid (V2-CROSS-BO-002 added a validatePayload('scenario', …) gate
// at the fetch boundary, so success-path fixtures must conform).
const GOOD_YAML = [
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

describe('INGEST-PROACT-003 — bounded retry with backoff for transient faults', () => {
  it('a transient 5xx then a 200 returns the scenario (retry worked)', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return n === 1 ? resp(503) : resp(200, GOOD_YAML);
    };
    const sleeps = [];
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl,
      attempts: 3,
      sleepImpl: (ms) => sleeps.push(ms),
    });

    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, `expected the scenario after a retry; got ${JSON.stringify(result)}`);
    assert.equal(result.scenario.scenario_id, 'sanity');
    assert.equal(n, 2, 'must retry exactly once past the transient 5xx');
    assert.equal(sleeps.length, 1, 'must back off once before the retry');
  });

  it('a 429 rate-limit then a 200 returns the scenario', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return n === 1 ? resp(429) : resp(200, GOOD_YAML);
    };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });
    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, 'a 429 must be retried');
    assert.equal(n, 2);
  });

  it('a 404 is NOT retried — returned immediately as not_found', async () => {
    let n = 0;
    const fetchImpl = async () => { n += 1; return resp(404); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });
    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.scenario, null);
    assert.equal(result.reason, 'not_found');
    assert.equal(n, 1, 'a 404 is a definitive answer — never retried');
  });

  it('persistent 5xx exhausts the bounded attempts then THROWS the classified operational fault', async () => {
    // V2-CROSS-BO-001: this case previously returned reason='not_found' —
    // an outage misclassified as a missing scenario file, which rejected a
    // good submission. The retry budget is unchanged; the exhaustion outcome is now a throw.
    let n = 0;
    const fetchImpl = async () => { n += 1; return resp(500); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });
    await assert.rejects(fetcher.fetchWithReason('sanity'), /scenario-fetch-fault: .*500/);
    assert.equal(n, 3, 'must try exactly `attempts` times before giving up');
  });

  it('a transient network reject then a 200 returns the scenario', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNRESET');
      return resp(200, GOOD_YAML);
    };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });
    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, 'a transient network reject must be retried');
    assert.equal(n, 2);
  });
});
