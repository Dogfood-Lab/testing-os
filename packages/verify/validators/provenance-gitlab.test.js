/**
 * provenance-gitlab.test.js — GitLab CI provenance adapter (peer of githubProvenance)
 *
 * GitLab is the SECOND provenance provider. The adapter mirrors githubProvenance's
 * hardening exactly:
 *   - per-request AbortController timeout → throws `provenance: GitLab API timeout`
 *   - returns false ONLY on HTTP 404 (pipeline/job genuinely absent)
 *   - THROWS on 401/403/429/5xx as OPERATIONAL (so parseRejectionReason routes the
 *     fault to ops, not back to the submitter) — same `provenance:` prefix as GitHub
 *   - asserts the pipeline/job reached a FINISHED/SUCCESS state
 *   - binds the confirmed commit sha to the PERSISTED commit (expected.refCommitSha,
 *     the verify-A-001 anti-forgery guard) mandatorily, and binds the project path
 *     to source.repo
 *   - injectable fetch (opts.fetchImpl) so tests need no network
 *
 * Anti-forgery test id mirrored from GitHub: verify-A-001 (ref.commit_sha binding).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { gitlabProvenance } from './provenance.js';

// A schema-shaped GitLab source. `provider_run_id` is the pipeline (or job) id;
// `run_url` is a GitLab pipeline/job URL the repo-binding layer can decode.
function pipelineSource(overrides = {}) {
  return {
    provider: 'gitlab',
    workflow: '.gitlab-ci.yml',
    provider_run_id: '424242',
    run_url: 'https://gitlab.com/acme/widget/-/pipelines/424242',
    repo: 'acme/widget',
    ...overrides
  };
}

function jobSource(overrides = {}) {
  return {
    provider: 'gitlab',
    workflow: '.gitlab-ci.yml',
    provider_run_id: '987654',
    run_url: 'https://gitlab.com/acme/widget/-/jobs/987654',
    repo: 'acme/widget',
    ...overrides
  };
}

const RUN_HEAD = 'c5d6c4e0000000000000000000000000deadbeef';
const FORGED = 'f0f0f0f0000000000000000000000000baddecaf';

// GitLab pipeline payload (GET /projects/:id/pipelines/:pipeline_id).
function mockPipeline(overrides = {}) {
  return {
    id: 424242,
    status: 'success',
    sha: RUN_HEAD,
    ...overrides
  };
}

// GitLab job payload (GET /projects/:id/jobs/:job_id). The commit lives under
// `commit.id` rather than a top-level `sha`.
function mockJob(overrides = {}) {
  return {
    id: 987654,
    status: 'success',
    commit: { id: RUN_HEAD },
    ...overrides
  };
}

function fetchReturning(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function fetchWithStatus(status) {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

// ── Happy path: well-formed finished pipeline/job is confirmed ────

describe('gitlabProvenance confirms a finished pipeline/job', () => {
  it('confirms a successful pipeline whose sha === refCommitSha and project === source.repo', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline())
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
  });

  it('confirms a successful JOB whose commit.id === refCommitSha', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockJob())
    });
    const ok = await adapter.confirm(jobSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
  });

  it('binds the project path to source.repo (rejects a mismatched project)', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline())
    });
    const ok = await adapter.confirm(
      pipelineSource({ repo: 'victim/repo', run_url: 'https://gitlab.com/acme/widget/-/pipelines/424242' }),
      { refCommitSha: RUN_HEAD }
    );
    assert.equal(ok, false, 'source.repo not matching the run_url project must not confirm');
  });
});

// ── verify-A-001: anti-forgery ref.commit_sha binding (mirrors GitHub) ──
//
// HIGH/security: the commit a record attests to is submission.ref.commit_sha
// (index.js persists submission.ref verbatim). A submitter who owns a real
// finished pipeline could otherwise point ref.commit_sha at any 40-hex sha and
// earn a provenance_confirmed 'pass' for a commit the pipeline never executed.
// gitlabProvenance binds the pipeline sha to the persisted commit and rejects
// any mismatch — identical guard to githubProvenance.

describe('gitlabProvenance binds ref.commit_sha to the run (verify-A-001)', () => {
  it('rejects when the persisted ref.commit_sha differs from the pipeline sha', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline())
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: FORGED });
    assert.equal(ok, false,
      'a ref.commit_sha that does not match the confirmed pipeline sha must NOT be confirmed');
  });

  it('confirms when the persisted ref.commit_sha matches the pipeline sha', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline())
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true,
      'a ref.commit_sha equal to the confirmed pipeline sha must be confirmed');
  });

  it('rejects a forged commit on the JOB path too (commit.id binding)', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockJob())
    });
    const ok = await adapter.confirm(jobSource(), { refCommitSha: FORGED });
    assert.equal(ok, false);
  });
});

// ── Finished-state guard (mirrors githubProvenance run.status === 'completed') ──

describe('gitlabProvenance requires a finished/success state', () => {
  for (const status of ['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled', 'manual']) {
    it(`rejects a pipeline with non-finished status: ${status}`, async () => {
      const adapter = gitlabProvenance('token', {
        timeoutMs: 1000,
        fetchImpl: fetchReturning(mockPipeline({ status }))
      });
      const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
      assert.equal(ok, false, `${status} pipeline must not be confirmed`);
    });
  }

  it('confirms a successful pipeline (status: success)', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline({ status: 'success' }))
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
  });

  it('confirms a finished pipeline even when it FAILED (provenance = ran, not passed)', async () => {
    // Mirror githubProvenance: provenance confirms the pipeline EXECUTED to a
    // terminal state. Pass/fail is a separate signal (ci_checks / scenario
    // verdicts). 'failed' is terminal, so it confirms.
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline({ status: 'failed' }))
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true, 'verifier confirms the pipeline reached a terminal state');
  });

  it('confirms a canceled pipeline (terminal state)', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(mockPipeline({ status: 'canceled' }))
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
  });
});

// ── 404 vs operational (mirrors verify-A-002) ──────────────────────

describe('gitlabProvenance distinguishes ops failures from missing runs', () => {
  it('returns false (run genuinely absent) on HTTP 404', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchWithStatus(404)
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, false, '404 means the pipeline does not exist — a real rejection, not an outage');
  });

  for (const status of [401, 403, 429, 500, 503]) {
    it(`throws an operational error on HTTP ${status} (not a submission-bad false)`, async () => {
      const adapter = gitlabProvenance('token', {
        timeoutMs: 1000,
        retries: 0,
        fetchImpl: fetchWithStatus(status)
      });
      await assert.rejects(
        adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD }),
        err => {
          assert.match(err.message, /provenance: GitLab API returned/);
          assert.match(err.message, new RegExp(String(status)));
          return true;
        }
      );
    });
  }
});

// ── Timeout (mirrors F-246817-014) ─────────────────────────────────

describe('gitlabProvenance fetch timeout', () => {
  function makeHangingFetch() {
    return function hangingFetch(_url, opts) {
      return new Promise((_resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };
  }

  it('throws timeout error when fetch hangs longer than timeoutMs', async () => {
    const adapter = gitlabProvenance('token', {
      timeoutMs: 50,
      fetchImpl: makeHangingFetch()
    });
    const start = Date.now();
    await assert.rejects(
      adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD }),
      err => {
        assert.match(err.message, /provenance: GitLab API timeout/);
        assert.match(err.message, /50ms/);
        return true;
      }
    );
    assert.ok(Date.now() - start < 5000, 'expected fast abort');
  });

  it('throws provenance: network error on persistent transport failures (F-dac7e08c)', async () => {
    // Pre-F-dac7e08c this pinned `return false` — which classified a network
    // outage as submission-bad and permanently persisted a rejected record.
    // The contract is now: retry within budget, then THROW (operational).
    const failingFetch = async () => { throw new Error('connection refused'); };
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      retries: 1,
      sleepImpl: async () => {},
      fetchImpl: failingFetch
    });
    await assert.rejects(
      adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD }),
      /provenance: network error: connection refused/
    );
  });
});

// ── Provider guard + malformed input ───────────────────────────────

describe('gitlabProvenance input guards', () => {
  it('throws on a non-gitlab provider', async () => {
    const adapter = gitlabProvenance('token', { fetchImpl: fetchReturning(mockPipeline()) });
    await assert.rejects(
      adapter.confirm({ provider: 'github', provider_run_id: '1', run_url: 'https://github.com/a/b/actions/runs/1' }),
      /unsupported provider: github/
    );
  });

  it('returns false when run_url is missing', async () => {
    const adapter = gitlabProvenance('token', { fetchImpl: fetchReturning(mockPipeline()) });
    const ok = await adapter.confirm({ provider: 'gitlab', provider_run_id: '1' });
    assert.equal(ok, false);
  });

  it('returns false when run_url does not match the GitLab pipeline/job shape', async () => {
    const adapter = gitlabProvenance('token', { fetchImpl: fetchReturning(mockPipeline()) });
    const ok = await adapter.confirm({
      provider: 'gitlab',
      provider_run_id: '1',
      run_url: 'https://gitlab.com/acme/widget/-/merge_requests/1'
    });
    assert.equal(ok, false);
  });
});

// ── Bounded retry over transient faults (PROACT-VERIFY-001, mirrors GitHub) ──
//
// MEDIUM/resilience: a single 429/5xx blip used to fail the submission as an
// operational incident. The adapter now retries 429/5xx within a bounded budget
// (opts.retries, default 2) with exponential backoff (honoring Retry-After), and
// still THROWS on exhaustion so a genuinely-down provider surfaces as
// operational — never a false 'confirmed'. 404 is NOT retried.

describe('gitlabProvenance bounded retry (PROACT-VERIFY-001)', () => {
  it('retries a 429 then confirms on the following 200 (retry worked)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => mockPipeline() };
    };
    const adapter = gitlabProvenance('token', { timeoutMs: 1000, backoffMs: 1, fetchImpl });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true, '429-then-200 must confirm — the retry succeeded');
    assert.equal(calls, 2, 'expected exactly one retry (2 total requests)');
  });

  it('honors Retry-After (numeric seconds) before the retry', async () => {
    let calls = 0;
    const waited = [];
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, headers: { get: h => (h === 'retry-after' ? '2' : null) }, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => mockPipeline() };
    };
    const adapter = gitlabProvenance('token', {
      timeoutMs: 1000,
      sleepImpl: ms => { waited.push(ms); return Promise.resolve(); },
      fetchImpl
    });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
    assert.deepEqual(waited, [2000], 'Retry-After: 2 must drive a 2000ms wait');
  });

  it('THROWS on exhausted 5xx retries (a genuinely-down provider still surfaces)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    };
    const adapter = gitlabProvenance('token', { timeoutMs: 1000, retries: 2, backoffMs: 1, fetchImpl });
    await assert.rejects(
      adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD }),
      err => {
        assert.match(err.message, /provenance: GitLab API returned 500/);
        return true;
      }
    );
    assert.equal(calls, 3, 'expected 1 initial + 2 retries = 3 requests before throwing');
  });

  it('does NOT retry a 404 (run genuinely absent → single immediate false)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    };
    const adapter = gitlabProvenance('token', { timeoutMs: 1000, retries: 2, backoffMs: 1, fetchImpl });
    const ok = await adapter.confirm(pipelineSource(), { refCommitSha: RUN_HEAD });
    assert.equal(ok, false);
    assert.equal(calls, 1, '404 must not be retried');
  });
});
