/**
 * f-2a5ddafa-provenance-retry-warn.test.js
 *
 * F-2a5ddafa (Stage C humanization) — both provenance adapters retried
 * transient faults (429/5xx/timeout/network) with exponential backoff, but
 * the retry loop itself was completely silent: `await sleep(...); continue;`
 * fired with no logStage/log call anywhere inside either loop. A submission
 * that succeeded only after 1-2 retries against a degrading GitHub/GitLab API
 * was byte-for-byte indistinguishable in the log from one that succeeded on
 * the first try — an operator had zero early-warning signal of a degrading
 * provider until the retry budget fully exhausted and threw.
 *
 * Fix: `onRetryWarn(fields)` fires at the point each loop decides to retry,
 * defaulting to a structured NDJSON stderr line (`component:'verify'`,
 * `stage:'warn'`) and injectable via `opts.onRetryWarn` for tests (mirrors
 * the already-injectable `opts.fetchImpl` / `opts.sleepImpl` on this file).
 *
 * Why NOT `logStage` from `@dogfood-lab/dogfood-swarm/lib/log-stage.js`:
 * packages/verify has no dependency on dogfood-swarm and taking one would
 * close a SECOND, larger workspace cycle (verify -> dogfood-swarm ->
 * findings -> ingest -> verify) — see provenance.js's `defaultOnRetryWarn`
 * doc block for the full reasoning. This suite pins that the emitted shape
 * is real and correct without that import.
 *
 * RED proof (reasoned, not re-executed as a hang risk): before this fix,
 * `onRetryWarn` did not exist on the opts object at all — every assertion
 * in the "onRetryWarn fires" describe blocks below would fail with "onRetryWarn
 * was never called" (the array stays empty), since nothing invoked it. This is
 * independently re-derived from reading the pre-fix source (confirmed: zero
 * occurrences of any warn/log call inside either retry loop), not carried
 * over from the finding's own prose.
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

function okGithubResp() {
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

function okGitlabResp() {
  return { ok: true, status: 200, json: async () => ({ id: 424242, status: 'success', sha: RUN_HEAD }) };
}

/** @pins F-2a5ddafa */
describe('F-2a5ddafa — githubProvenance emits onRetryWarn before each retry', () => {
  it('a timeout then a 200: onRetryWarn fires once with status_or_reason="timeout"', async () => {
    let calls = 0;
    const warnings = [];
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw abortError();
        return okGithubResp();
      }
    });
    const ok = await adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
    assert.equal(warnings.length, 1, `expected exactly one retry warning; got ${JSON.stringify(warnings)}`);
    assert.equal(warnings[0].kind, 'provenance_retry');
    assert.equal(warnings[0].provider, 'github');
    assert.equal(warnings[0].attempt, 1);
    assert.equal(warnings[0].status_or_reason, 'timeout');
    assert.equal(typeof warnings[0].next_backoff_ms, 'number');
  });

  it('a 503 then a 200: onRetryWarn fires with status_or_reason=503 (the numeric status)', async () => {
    let calls = 0;
    const warnings = [];
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? { ok: false, status: 503 } : okGithubResp();
      }
    });
    await adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status_or_reason, 503);
  });

  it('a transport reject then a 200: onRetryWarn carries the underlying error message', async () => {
    let calls = 0;
    const warnings = [];
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET');
        return okGithubResp();
      }
    });
    await adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].status_or_reason, /ECONNRESET/);
  });

  it('exhausting the retry budget fires onRetryWarn exactly `retries` times, not on the final throw', async () => {
    const warnings = [];
    const adapter = githubProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => { throw abortError(); }
    });
    await assert.rejects(() => adapter.confirm(GH_SOURCE), /provenance: GitHub API timeout/);
    assert.equal(warnings.length, 2, 'retries=2 → 2 warn events before the 3rd attempt throws');
    assert.deepEqual(warnings.map(w => w.attempt), [1, 2]);
  });

  it('DEFAULT onRetryWarn (no opts override): writes a structured NDJSON warn line to stderr', async () => {
    let calls = 0;
    const captured = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(chunk.toString()); return true; };
    try {
      const adapter = githubProvenance('token', {
        timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
        fetchImpl: async () => {
          calls++;
          if (calls === 1) throw abortError();
          return okGithubResp();
        }
      });
      await adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD });
    } finally {
      process.stderr.write = origErr;
    }
    const jsonLine = captured.find((c) => c.trim().startsWith('{'));
    assert.ok(jsonLine, `expected a JSON warn line on stderr; got ${JSON.stringify(captured)}`);
    const parsed = JSON.parse(jsonLine.trim());
    assert.equal(parsed.component, 'verify');
    assert.equal(parsed.stage, 'warn');
    assert.equal(parsed.kind, 'provenance_retry');
    assert.equal(parsed.provider, 'github');
  });
});

/** @pins F-2a5ddafa */
describe('F-2a5ddafa — gitlabProvenance mirrors the onRetryWarn discipline', () => {
  it('a timeout then a 200: onRetryWarn fires once with provider="gitlab"', async () => {
    let calls = 0;
    const warnings = [];
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw abortError();
        return okGitlabResp();
      }
    });
    const ok = await adapter.confirm(GL_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, 'provenance_retry');
    assert.equal(warnings[0].provider, 'gitlab');
    assert.equal(warnings[0].status_or_reason, 'timeout');
  });

  it('a 429 then a 200: onRetryWarn carries the numeric status', async () => {
    let calls = 0;
    const warnings = [];
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? { ok: false, status: 429 } : okGitlabResp();
      }
    });
    await adapter.confirm(GL_SOURCE, { refCommitSha: RUN_HEAD });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status_or_reason, 429);
  });

  it('exhausting the retry budget fires onRetryWarn exactly `retries` times', async () => {
    const warnings = [];
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000, retries: 1, sleepImpl: noSleep,
      onRetryWarn: (f) => warnings.push(f),
      fetchImpl: async () => { throw abortError(); }
    });
    await assert.rejects(() => adapter.confirm(GL_SOURCE), /provenance: GitLab API timeout/);
    assert.equal(warnings.length, 1, 'retries=1 → 1 warn event before the 2nd attempt throws');
  });
});
