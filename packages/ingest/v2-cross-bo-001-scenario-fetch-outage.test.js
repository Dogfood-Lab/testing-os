/**
 * v2-cross-bo-001-scenario-fetch-outage.test.js
 *
 * V2-CROSS-BO-001 (wave-2 fix-up) — githubScenarioFetcher classified transport
 * errors (DNS failure, ECONNREFUSED) and non-404 HTTP statuses (401/403 bad
 * credential) as a definitive `not_found`. That made a GitHub outage or a
 * misconfigured token indistinguishable from "the scenario file does not
 * exist" — and via the `scenario-load:` channel it REJECTED a perfectly good
 * submission as submission-side.
 *
 * Fix contract (mirrors the F-dac7e08c adapter discipline in
 * packages/verify/validators/provenance.js):
 *   - 429/5xx and transport rejects are retried within the bounded budget,
 *     then on exhaustion THROW a `scenario-fetch-fault:` classified error;
 *   - 401/403 (and any other non-404, non-transient status) THROW immediately
 *     — a credential/config fault is never the submitter's payload;
 *   - `not_found` is reserved for a true 404;
 *   - the thrown fault propagates through loadScenarios (never converted into
 *     a scenario-load rejection), so the ingest CLI's outer catch surfaces it
 *     as an operational error (exit 2) instead of persisting a rejected record;
 *   - parseRejectionReason classifies the `scenario-fetch-fault:` prefix as
 *     'operational' — pinned so no future surface can route an outage back to
 *     the submitter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRejectionReason } from '@dogfood-lab/verify';
import { githubScenarioFetcher, loadScenarios } from './load-context.js';

const VALID_SHA = 'deadbeef';

function resp(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

describe('V2-CROSS-BO-001 — outages and credential faults are operational, not not_found', () => {
  it('persistent transport rejects (ECONNREFUSED) exhaust the retry budget then THROW scenario-fetch-fault', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('connect ECONNREFUSED 140.82.112.3:443'); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    await assert.rejects(
      fetcher.fetchWithReason('sanity'),
      /^Error: scenario-fetch-fault: .*ECONNREFUSED/,
      'a persistent transport reject must throw, not return not_found'
    );
    assert.equal(calls, 3, 'transport rejects are retried within the bounded budget first');
  });

  it('persistent 5xx exhausts the retry budget then THROWS scenario-fetch-fault (was: not_found)', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return resp(503); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    await assert.rejects(
      fetcher.fetchWithReason('sanity'),
      /^Error: scenario-fetch-fault: .*503/,
      'a persistent 5xx outage must throw, not return not_found'
    );
    assert.equal(calls, 3);
  });

  it('a 401 bad credential THROWS immediately — never retried, never not_found', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return resp(401); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    await assert.rejects(fetcher.fetchWithReason('sanity'), /scenario-fetch-fault: .*401/);
    assert.equal(calls, 1, 'a credential fault is not transient — no retry');
  });

  it('a 403 THROWS immediately — never retried, never not_found', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return resp(403); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    await assert.rejects(fetcher.fetchWithReason('sanity'), /scenario-fetch-fault: .*403/);
    assert.equal(calls, 1);
  });

  it('not_found stays reserved for a true 404', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return resp(404); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.scenario, null);
    assert.equal(result.reason, 'not_found');
    assert.equal(calls, 1);
  });

  it('the legacy fetch() surface also propagates the fault (an outage must not read as "missing")', async () => {
    const fetchImpl = async () => resp(500);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 2, sleepImpl: () => {},
    });
    await assert.rejects(fetcher.fetch('sanity'), /scenario-fetch-fault:/);
  });

  it('loadScenarios PROPAGATES the operational fault instead of rejecting the submission', async () => {
    const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 2, sleepImpl: () => {},
    });
    const submission = { scenario_results: [{ scenario_id: 'sanity' }] };

    // Pre-fix this resolved with errors[0] = '... (reason: not_found)' which
    // run.js turned into a `scenario-load:` REJECTION of a good submission.
    await assert.rejects(
      loadScenarios(submission, fetcher),
      /scenario-fetch-fault:/,
      'an outage must surface as a thrown operational fault, not a scenario-load rejection'
    );
  });

  it('parseRejectionReason classifies scenario-fetch-fault: as operational', () => {
    const parsed = parseRejectionReason(
      'scenario-fetch-fault: GitHub API HTTP 503 loading scenario "sanity" (3 attempts)'
    );
    assert.equal(parsed.class, 'operational',
      'an outage/credential fault pages ops — it must never route back to the submitter');
    assert.equal(parsed.prefix, 'scenario-fetch-fault:');
  });
});
