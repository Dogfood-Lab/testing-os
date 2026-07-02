/**
 * F-dac7e08c: a genuine transport error (DNS failure, ECONNREFUSED — the
 * provider or the runner's network is DOWN) was `return false`, which
 * verify/index.js turned into `provenance: source run could not be confirmed`
 * — classified submission-bad and bounced to the submitter, permanently
 * persisting a REJECTED record whose run_id then trips the duplicate guard on
 * a clean resubmission. That inverted the verify-A-002 taxonomy (429/5xx
 * throw → operational).
 *
 * Contract: transport rejects are retried within the PROVENANCE_RETRIES
 * budget (at least as transient as a 5xx) and on exhaustion THROW
 * `provenance: network error: …` so the reason lands under the operational
 * `provenance-fault:` prefix. `return false` is reserved for HTTP 404.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubProvenance, gitlabProvenance } from './provenance.js';
import { parseRejectionReason } from '../parse-rejection.js';

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

function transportError() {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  return err;
}

const noSleep = async () => {};

describe('F-dac7e08c: transport errors are operational, not submission-bad (github)', () => {
  it('throws provenance: network error after exhausting retries', async () => {
    let calls = 0;
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      retries: 2,
      sleepImpl: noSleep,
      fetchImpl: async () => { calls++; throw transportError(); }
    });
    await assert.rejects(() => adapter.confirm(GH_SOURCE), /provenance: network error: fetch failed/);
    assert.equal(calls, 3, 'transport rejects must be retried within the budget (retries=2 → 3 attempts)');
  });

  it('the thrown reason classifies OPERATIONAL via the provenance-fault prefix', async () => {
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 0, sleepImpl: noSleep,
      fetchImpl: async () => { throw transportError(); }
    });
    let message;
    try {
      await adapter.confirm(GH_SOURCE);
      assert.fail('expected a throw');
    } catch (e) {
      message = e.message;
    }
    // verify/index.js wraps a provenance throw as `provenance-fault: verification failed: <msg>`.
    const parsed = parseRejectionReason(`provenance-fault: verification failed: ${message}`);
    assert.equal(parsed.class, 'operational',
      'a network outage must page ops, not bounce to the submitter');
  });

  it('recovers when the transport blip clears on a retry', async () => {
    let calls = 0;
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw transportError();
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
    assert.equal(ok, true, 'a momentary transport blip must not fail the submission');
    assert.equal(calls, 2);
  });
});

describe('F-dac7e08c: transport errors are operational (gitlab mirror)', () => {
  it('throws provenance: network error after exhausting retries', async () => {
    let calls = 0;
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 1, sleepImpl: noSleep,
      fetchImpl: async () => { calls++; throw transportError(); }
    });
    await assert.rejects(() => adapter.confirm(GL_SOURCE), /provenance: network error: fetch failed/);
    assert.equal(calls, 2);
  });

  it('still returns false on HTTP 404 (run genuinely absent — submission-bad)', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 1, sleepImpl: noSleep,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
    });
    const ok = await adapter.confirm(GL_SOURCE);
    assert.equal(ok, false);
  });
});
