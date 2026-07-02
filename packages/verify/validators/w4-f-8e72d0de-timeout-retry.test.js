/**
 * w4-f-8e72d0de-timeout-retry.test.js
 *
 * F-8e72d0de (wave 4): both provenance adapters threw IMMEDIATELY on an
 * AbortError (per-request timeout) while retrying transport rejects and
 * 429/5xx within the PROVENANCE_RETRIES budget. A timeout is at least as
 * transient as a connection refusal — a single slow response failed the
 * whole confirmation when one retry might have confirmed the run. Contrast:
 * the scenario fetcher in ingest/load-context.js already retried timeouts.
 *
 * Contract (both adapters — the documented peer discipline):
 *   - an AbortError is retried within the same budget as a transport reject;
 *   - on exhaustion the timeout error still throws (operational,
 *     `provenance-fault:` at the verify() boundary).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubProvenance, gitlabProvenance } from './provenance.js';

const RUN_HEAD = 'c5d6c4e0000000000000000000000000deadbeef';

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

function abortError() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

const noSleep = async () => {};

describe('F-8e72d0de — githubProvenance retries per-request timeouts', () => {
  it('a single timeout followed by a 200 confirms the run', async () => {
    let calls = 0;
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw abortError();
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 9123456789,
            status: 'completed',
            head_sha: RUN_HEAD,
            repository: { full_name: 'acme/widget' }
          })
        };
      }
    });
    const ok = await adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(ok, true, 'one slow response must not fail the confirmation');
    assert.equal(calls, 2);
  });

  it('exhausting every attempt on timeouts still throws the timeout error', async () => {
    let calls = 0;
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      fetchImpl: async () => { calls++; throw abortError(); }
    });
    await assert.rejects(
      () => adapter.confirm(GH_SOURCE),
      /provenance: GitHub API timeout after 1000ms/
    );
    assert.equal(calls, 3, 'retries=2 → 3 total attempts before the operational throw');
  });
});

describe('F-8e72d0de — gitlabProvenance mirrors the timeout-retry discipline', () => {
  it('a single timeout followed by a 200 confirms the pipeline', async () => {
    let calls = 0;
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw abortError();
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 424242, status: 'success', sha: RUN_HEAD })
        };
      }
    });
    const ok = await adapter.confirm(GL_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
    assert.equal(calls, 2);
  });

  it('exhausting every attempt on timeouts still throws the timeout error', async () => {
    let calls = 0;
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 1, sleepImpl: noSleep,
      fetchImpl: async () => { calls++; throw abortError(); }
    });
    await assert.rejects(
      () => adapter.confirm(GL_SOURCE),
      /provenance: GitLab API timeout after 1000ms/
    );
    assert.equal(calls, 2);
  });
});
