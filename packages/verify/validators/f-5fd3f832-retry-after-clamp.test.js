/**
 * F-5fd3f832: a provider-sent Retry-After header was honored with NO upper
 * bound — `Retry-After: 86400` (or an HTTP-date hours ahead) made the adapter
 * sleep that long between attempts. The per-request AbortController timeout
 * bounds each REQUEST but not the inter-attempt sleep, so one hostile/broken
 * 429 (plausible via gitlabProvenance's self-hosted apiBase) could wedge the
 * concurrency-serialized ingest.yml queue for hours.
 *
 * Contract: the Retry-After-derived wait is clamped to MAX_RETRY_AFTER_MS
 * (30s) in both the delta-seconds and HTTP-date branches; the exponential
 * fallback was already bounded by the retry budget.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubProvenance, gitlabProvenance, MAX_RETRY_AFTER_MS } from './provenance.js';

const GH_SOURCE = {
  provider: 'github',
  workflow: 'dogfood.yml',
  provider_run_id: '9123456789',
  run_url: 'https://github.com/acme/widget/actions/runs/9123456789'
};

const GL_SOURCE = {
  provider: 'gitlab',
  workflow: '.gitlab-ci.yml',
  provider_run_id: '424242',
  run_url: 'https://gitlab.com/acme/widget/-/pipelines/424242',
  repo: 'acme/widget'
};

function throttled429(retryAfterValue) {
  return async () => ({
    ok: false,
    status: 429,
    headers: { get: h => (h === 'retry-after' ? retryAfterValue : null) },
    json: async () => ({})
  });
}

function collectSleeps() {
  const waited = [];
  return { waited, sleepImpl: async (ms) => { waited.push(ms); } };
}

describe('F-5fd3f832: Retry-After waits are clamped (github adapter)', () => {
  it('clamps a huge delta-seconds Retry-After to MAX_RETRY_AFTER_MS', async () => {
    const { waited, sleepImpl } = collectSleeps();
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, fetchImpl: throttled429('86400'), sleepImpl
    });
    await assert.rejects(() => adapter.confirm(GH_SOURCE), /provenance: GitHub API returned 429/);
    assert.equal(waited.length, 2);
    for (const ms of waited) {
      assert.ok(ms <= MAX_RETRY_AFTER_MS,
        `wait ${ms}ms must be clamped to ${MAX_RETRY_AFTER_MS}ms`);
    }
  });

  it('clamps a far-future HTTP-date Retry-After to MAX_RETRY_AFTER_MS', async () => {
    const { waited, sleepImpl } = collectSleeps();
    const farFuture = new Date(Date.now() + 6 * 3600_000).toUTCString();
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 1, fetchImpl: throttled429(farFuture), sleepImpl
    });
    await assert.rejects(() => adapter.confirm(GH_SOURCE));
    assert.equal(waited.length, 1);
    assert.ok(waited[0] <= MAX_RETRY_AFTER_MS,
      `HTTP-date wait ${waited[0]}ms must be clamped to ${MAX_RETRY_AFTER_MS}ms`);
  });

  it('still honors a small Retry-After exactly (no over-clamping)', async () => {
    const { waited, sleepImpl } = collectSleeps();
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 1, fetchImpl: throttled429('2'), sleepImpl
    });
    await assert.rejects(() => adapter.confirm(GH_SOURCE));
    assert.deepEqual(waited, [2000]);
  });
});

describe('F-5fd3f832: Retry-After waits are clamped (gitlab adapter)', () => {
  it('clamps a huge delta-seconds Retry-After to MAX_RETRY_AFTER_MS', async () => {
    const { waited, sleepImpl } = collectSleeps();
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 2, fetchImpl: throttled429('86400'), sleepImpl
    });
    await assert.rejects(() => adapter.confirm(GL_SOURCE), /provenance: GitLab API returned 429/);
    assert.equal(waited.length, 2);
    for (const ms of waited) {
      assert.ok(ms <= MAX_RETRY_AFTER_MS,
        `wait ${ms}ms must be clamped to ${MAX_RETRY_AFTER_MS}ms`);
    }
  });
});
