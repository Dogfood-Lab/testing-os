/**
 * v2-cross-bo-002-scenario-trust-boundary.test.js
 *
 * V2-CROSS-BO-002 (wave-2 fix-up) — a fetched scenario definition crosses the
 * consumer-repo → verifier trust boundary UNPROTECTED in githubScenarioFetcher:
 *
 *   1. `resp.text()` had no byte cap — a hostile/misconfigured source repo
 *      could feed an arbitrarily large body into memory and into yaml.load.
 *   2. The loaded object was never schema-validated — any YAML object shape
 *      flowed straight into verify()'s required-steps enforcement.
 *
 * Fix contract pinned here:
 *   - a body over GITHUB_SCENARIO_MAX_BYTES (1 MiB) → typed reason
 *     'too_large', definitive (never retried);
 *   - a Content-Length header over the cap short-circuits BEFORE text() is
 *     ever read;
 *   - a parses-but-schema-invalid scenario → typed reason 'schema_invalid',
 *     definitive — and the reason flows through loadScenarios into the
 *     `scenario-load:` channel, which parseRejectionReason classifies
 *     'ingest' (submission-side rejection), NOT a VALIDATOR_FAULT;
 *   - a fully schema-valid scenario still loads (GREEN path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRejectionReason } from '@dogfood-lab/verify';
import {
  githubScenarioFetcher,
  loadScenarios,
  GITHUB_SCENARIO_MAX_BYTES
} from './load-context.js';

const VALID_SHA = 'deadbeef';

const VALID_SCENARIO_YAML = [
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

function resp(status, body = '', headers = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers ? { get: (k) => headers[k.toLowerCase()] ?? null } : undefined,
    async text() { return body; },
  };
}

describe('V2-CROSS-BO-002 — scenario trust boundary (byte cap + schema gate)', () => {
  it('exports a 1 MiB byte cap', () => {
    assert.equal(GITHUB_SCENARIO_MAX_BYTES, 1024 * 1024);
  });

  it('an oversized body yields reason="too_large" and is NOT retried', async () => {
    let calls = 0;
    const big = 'x'.repeat(GITHUB_SCENARIO_MAX_BYTES + 1);
    const fetchImpl = async () => { calls += 1; return resp(200, big); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.scenario, null);
    assert.equal(result.reason, 'too_large',
      `expected reason="too_large"; got ${JSON.stringify(result)}`);
    assert.equal(calls, 1, 'an oversized body is a definitive answer — never retried');
  });

  it('a Content-Length header over the cap short-circuits before text() is read', async () => {
    let textRead = false;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(GITHUB_SCENARIO_MAX_BYTES + 1) : null) },
      async text() { textRead = true; return 'scenario_id: x\n'; },
    });
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl, attempts: 1 });

    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.reason, 'too_large');
    assert.equal(textRead, false, 'the oversized body must never be buffered');
  });

  it('a parses-but-schema-invalid scenario yields reason="schema_invalid" and is NOT retried', async () => {
    let calls = 0;
    // Valid YAML, valid object — but not a scenario (missing every required field).
    const fetchImpl = async () => { calls += 1; return resp(200, 'scenario_id: sanity\nbogus: true\n'); };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.scenario, null);
    assert.equal(result.reason, 'schema_invalid',
      `expected reason="schema_invalid"; got ${JSON.stringify(result)}`);
    assert.equal(calls, 1, 'a schema-invalid scenario is a definitive answer — never retried');
  });

  it('the schema_invalid reason flows through loadScenarios and classifies as ingest (submission-side), not a validator fault', async () => {
    const fetchImpl = async () => resp(200, 'not_a_scenario: at all\n');
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl, attempts: 1 });
    const submission = { scenario_results: [{ scenario_id: 'sanity' }] };

    const { scenarios, errors } = await loadScenarios(submission, fetcher);
    assert.equal(scenarios.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /reason: schema_invalid/,
      `error string must surface the typed reason; got ${JSON.stringify(errors[0])}`);

    // The ingest layer prefixes these with `scenario-load:` (run.js step 4b) —
    // pin the classification: submission-side scenario-load, NOT operational.
    const parsed = parseRejectionReason(`scenario-load: ${errors[0]}`);
    assert.equal(parsed.class, 'ingest');
  });

  it('GREEN: a fully schema-valid scenario still loads', async () => {
    const fetchImpl = async () => resp(200, VALID_SCENARIO_YAML);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl, attempts: 1 });

    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, `valid scenario must load; got ${JSON.stringify(result)}`);
    assert.equal(result.scenario.scenario_id, 'sanity');
    assert.deepEqual(result.scenario.success_criteria.required_steps, ['one']);
    assert.ok(result.reason == null, 'success path carries no reason');
  });
});
