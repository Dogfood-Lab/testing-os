/**
 * w4-f-2750c4e8-fetch-amplification.test.js
 *
 * F-2750c4e8 (wave 4 HIGH): the production scenario-fetch path had NO cap on
 * GitHub API calls per submission and deduped only SUCCESSES
 * (`if (scenarios.has(id)) continue`) — 50 entries repeating one missing
 * scenario_id drove 50 sequential authenticated fetches, and because the
 * fetch loop runs before schema validation, a hostile repository_dispatch
 * payload could burn the workflow token's rate limit and stall the
 * concurrency-serialized ingest queue (a cheap availability attack).
 *
 * Contract:
 *   - every ATTEMPTED id is deduped — successes AND typed failures cost one
 *     fetch each;
 *   - distinct fetches are capped at MAX_DISTINCT_SCENARIO_FETCHES (1000 —
 *     the schema's scenario_results maxItems, i.e. the published contract
 *     bound); entries beyond the cap get a typed `fetch_cap` error with no
 *     network touch;
 *   - run.js collapses >20 scenario-load rejection reasons into a count
 *     summary so a 1000-error submission cannot bloat the persisted record;
 *   - thrown scenario-fetch-faults stay UNcached (outage semantics survive).
 *
 * F-35486d38 (fixed in the same function): the V2-CROSS-BO-002 byte cap now
 * streams the body and aborts the moment the running byte count crosses
 * GITHUB_SCENARIO_MAX_BYTES — a header-suppressed oversized body is never
 * fully buffered.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';
import {
  loadScenarios,
  githubScenarioFetcher,
  MAX_DISTINCT_SCENARIO_FETCHES,
  GITHUB_SCENARIO_MAX_BYTES
} from './load-context.js';
import { verifyOnly } from './run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

let pilot0;
before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(__dirname, '../verify/fixtures/pilot-0-submission.json'), 'utf-8'));
});

describe('F-2750c4e8 — attempted-id dedupe', () => {
  it('50 entries repeating one FAILING id cost exactly one fetch', async () => {
    let calls = 0;
    const fetcher = {
      async fetch() { calls++; return null; },
      async fetchWithReason() { calls++; return { scenario: null, reason: 'parse_error' }; }
    };
    const submission = {
      scenario_results: Array.from({ length: 50 }, () => ({ scenario_id: 'missing' }))
    };
    const { errors } = await loadScenarios(submission, fetcher);
    assert.equal(calls, 1, 'a repeated failing id must be fetched ONCE (pre-fix: 50 sequential fetches)');
    assert.equal(errors.length, 1, 'one failure, one error entry — repeats are silent');
  });

  it('repeated SUCCESS ids still cost one fetch (existing behavior preserved)', async () => {
    let calls = 0;
    const fetcher = {
      async fetch() { calls++; return null; },
      async fetchWithReason() {
        calls++;
        return { scenario: { success_criteria: { required_steps: [] } } };
      }
    };
    const submission = {
      scenario_results: [{ scenario_id: 'a' }, { scenario_id: 'a' }, { scenario_id: 'a' }]
    };
    const { scenarios } = await loadScenarios(submission, fetcher);
    assert.equal(calls, 1);
    assert.equal(scenarios.size, 1);
  });

  it('legacy fetch() surface is deduped on failures too', async () => {
    let calls = 0;
    const fetcher = { async fetch() { calls++; return null; } };
    const submission = {
      scenario_results: Array.from({ length: 10 }, () => ({ scenario_id: 'gone' }))
    };
    const { errors } = await loadScenarios(submission, fetcher);
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
  });
});

describe('F-2750c4e8 — distinct-fetch cap at the schema ceiling', () => {
  it(`fetches at most ${MAX_DISTINCT_SCENARIO_FETCHES} distinct ids; the rest get a typed fetch_cap error`, async () => {
    let calls = 0;
    const fetcher = {
      async fetch() { calls++; return null; },
      async fetchWithReason() { calls++; return { scenario: null, reason: 'parse_error' }; }
    };
    const overBy = 5;
    const submission = {
      scenario_results: Array.from(
        { length: MAX_DISTINCT_SCENARIO_FETCHES + overBy },
        (_, i) => ({ scenario_id: `s${i}` })
      )
    };
    const { errors } = await loadScenarios(submission, fetcher);
    assert.equal(calls, MAX_DISTINCT_SCENARIO_FETCHES,
      'the cap must bound the network spend regardless of payload shape');
    const capped = errors.filter(e => /reason: fetch_cap/.test(e));
    assert.equal(capped.length, overBy);
  });

  it('the cap equals the submission schema scenario_results maxItems (the published contract bound)', () => {
    const schemaPath = resolve(__dirname, '../schemas/src/json/dogfood-record-submission.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    const maxItems = schema.properties.scenario_results.maxItems;
    assert.equal(MAX_DISTINCT_SCENARIO_FETCHES, maxItems,
      'a schema-valid submission must never be able to hit the fetch cap');
  });
});

describe('F-2750c4e8 — scenario-load reason collapse in the persisted record', () => {
  it('more than 20 scenario-load errors collapse into a count summary', async () => {
    const fetcher = {
      async fetch() { return null; },
      async fetchWithReason() { return { scenario: null, reason: 'parse_error' }; }
    };
    const submission = structuredClone(pilot0);
    submission.run_id = 'w4-collapse-001';
    submission.scenario_results = Array.from({ length: 25 }, (_, i) => ({ scenario_id: `s${i}` }));

    const result = await verifyOnly(submission, {
      repoRoot: REPO_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: fetcher
    });

    const scenarioLoad = result.record.verification.rejection_reasons
      .filter(r => r.startsWith('scenario-load:'));
    assert.equal(scenarioLoad.length, 21, '20 individual reasons + 1 collapse summary');
    assert.match(scenarioLoad[20], /\+5 more scenario-load errors collapsed; 25 total/);
  });
});

describe('F-35486d38 — streaming byte cap (header-suppressed oversized body)', () => {
  function chunkedResponse(chunks, { contentLength = null } = {}) {
    let i = 0;
    let cancelled = false;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? contentLength : null) },
      body: {
        getReader() {
          return {
            async read() {
              if (cancelled || i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[i++] };
            },
            async cancel() { cancelled = true; }
          };
        }
      },
      // text() intentionally absent on the streaming path fixture — the
      // fetcher must not need it when a body stream exists.
      wasCancelled: () => cancelled,
      chunksConsumed: () => i
    };
  }

  it('aborts the read once the running byte count crosses the cap — never buffers the full body', async () => {
    const half = new Uint8Array(Math.ceil(GITHUB_SCENARIO_MAX_BYTES / 2) + 1);
    // 4 chunks ≈ 2x the cap; overflow lands on chunk 2.
    const resp = chunkedResponse([half, half, half, half]);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', 'deadbeef', {
      fetchImpl: async () => resp,
      attempts: 1,
      sleepImpl: () => {}
    });
    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.reason, 'too_large');
    assert.equal(resp.wasCancelled(), true, 'the reader must be cancelled at overflow');
    assert.ok(resp.chunksConsumed() <= 2,
      `must stop at the overflow chunk; consumed ${resp.chunksConsumed()} of 4`);
  });

  it('a small streamed body still parses (streaming path is not lossy)', async () => {
    const yamlBody = [
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
    const bytes = new TextEncoder().encode(yamlBody);
    const resp = chunkedResponse([bytes.slice(0, 20), bytes.slice(20)]);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', 'deadbeef', {
      fetchImpl: async () => resp,
      attempts: 1,
      sleepImpl: () => {}
    });
    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, `expected a parsed scenario; got ${JSON.stringify(result)}`);
    assert.equal(result.scenario.scenario_id, 'sanity');
  });

  it('the text() fallback still enforces the cap post-read (test stubs without a body stream)', async () => {
    const big = 'x'.repeat(GITHUB_SCENARIO_MAX_BYTES + 1);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', 'deadbeef', {
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return big; } }),
      attempts: 1,
      sleepImpl: () => {}
    });
    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.reason, 'too_large');
  });
});
