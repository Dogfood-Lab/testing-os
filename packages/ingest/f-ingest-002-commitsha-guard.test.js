/**
 * f-ingest-002-commitsha-guard.test.js
 *
 * F-INGEST-002 (security) — `githubScenarioFetcher` interpolated `commitSha`
 * raw into the authenticated GitHub API URL (`?ref=${commitSha}`) with no
 * validation, while every sibling input was guarded (org/repo via
 * isUnsafeSegment, scenarioId via /^[\w-]+$/). An unvalidated ref from a
 * future caller could re-target the Bearer-token call's ref or inject query
 * parameters.
 *
 * Fix: a commitSha SHAPE guard (/^[0-9a-f]{7,40}$/) at the top of the fetcher,
 * returning the same typed `invalid_id` failure the scenarioId guard uses, and
 * — critically — NEVER reaching the authenticated fetch.
 *
 * Invariant (both halves):
 *   - a malformed commitSha returns reason='invalid_id' on BOTH surfaces and
 *     does NOT call fetch.
 *   - a well-formed commitSha (hex, 7–40 chars) still fetches normally.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubScenarioFetcher } from './load-context.js';

// Schema-valid success fixture (V2-CROSS-BO-002 added a validatePayload gate
// at the fetch boundary, so 200-path fixtures must conform).
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

describe('F-INGEST-002 — githubScenarioFetcher commitSha shape guard', () => {
  const malformed = [
    'main',                       // a branch name, not a sha
    'deadbeef?injected=1',        // query-param injection
    '../../../etc/passwd',        // traversal
    'HEAD~1',                     // ref expression
    'ABCDEF1',                    // uppercase (git shas are lowercase hex)
    'g'.repeat(40),               // non-hex chars
    'abc',                        // too short (< 7)
    'a'.repeat(41),               // too long (> 40)
    '',                           // empty
  ];

  for (const sha of malformed) {
    it(`rejects malformed commitSha ${JSON.stringify(sha)} without fetching`, async () => {
      let fetchCalls = 0;
      const fetchImpl = async () => { fetchCalls++; return { ok: true, status: 200, async text() { return 'scenario_id: x\n'; } }; };
      const fetcher = githubScenarioFetcher('test-token', 'org/repo', sha, { fetchImpl });

      const result = await fetcher.fetchWithReason('sanity');
      assert.equal(result.scenario, null);
      assert.equal(result.reason, 'invalid_id',
        `expected reason="invalid_id" for sha ${JSON.stringify(sha)}; got ${JSON.stringify(result)}`);

      const legacy = await fetcher.fetch('sanity');
      assert.equal(legacy, null, 'legacy surface must also return null for a bad commitSha');

      assert.equal(fetchCalls, 0, 'a malformed commitSha must NOT reach the authenticated fetch');
    });
  }

  it('still fetches with a well-formed commit sha (7–40 lowercase hex)', async () => {
    let fetchedUrl = null;
    const fetchImpl = async (url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, async text() { return VALID_SCENARIO_YAML; } };
    };
    const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'deadbeef', { fetchImpl });
    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, 'a valid commit sha must fetch normally');
    assert.equal(result.scenario.scenario_id, 'sanity');
    assert.match(fetchedUrl, /\?ref=deadbeef$/, 'the valid sha must reach the ref query');
  });

  it('accepts a full 40-char lowercase sha', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, async text() { return VALID_SCENARIO_YAML; } });
    const fetcher = githubScenarioFetcher('test-token', 'org/repo', 'a'.repeat(40), { fetchImpl });
    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario);
  });
});
