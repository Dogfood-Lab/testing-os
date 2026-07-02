/**
 * v2-invarian-004-resolve-scenario-fetcher.test.js
 *
 * V2-INVARIAN-004 (wave-2 fix-up) — the F-3bfc2885 wiring buried the
 * fetcher-construction condition (real provenance AND github provider AND
 * string repo AND string commit_sha AND token present) inline in run.js's
 * CLI entrypoint, where it was untestable without spawning the CLI. The
 * invariant "which submissions get required-steps enforcement" deserves a
 * unit-testable seam.
 *
 * Fix: `resolveScenarioFetcher(provenance, submission, env)` exported from
 * run.js; the CLI entrypoint calls it. Pinned matrix:
 *   - github provider + real provenance + token  → fetcher
 *   - gitlab provider                            → null (no contents-API adapter yet)
 *   - stub provenance                            → null
 *   - missing token                              → null
 *   - malformed submission / missing commit_sha  → null
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';
import { resolveScenarioFetcher } from './run.js';

const realProvenance = { confirm: async () => true };

const githubSubmission = {
  repo: 'org/repo',
  ref: { commit_sha: 'deadbeef' },
  source: { provider: 'github' },
};

const ENV = { GITHUB_TOKEN: 'tok' };

describe('V2-INVARIAN-004 — resolveScenarioFetcher', () => {
  it('github provider + real provenance + token yields a fetcher', () => {
    const fetcher = resolveScenarioFetcher(realProvenance, githubSubmission, ENV);
    assert.ok(fetcher, 'expected a fetcher');
    assert.equal(typeof fetcher.fetch, 'function');
    assert.equal(typeof fetcher.fetchWithReason, 'function');
  });

  it('provider defaulting: a submission without source.provider is treated as github', () => {
    const fetcher = resolveScenarioFetcher(realProvenance, { repo: 'org/repo', ref: { commit_sha: 'deadbeef' } }, ENV);
    assert.ok(fetcher);
  });

  it('GH_TOKEN is accepted as the token fallback', () => {
    const fetcher = resolveScenarioFetcher(realProvenance, githubSubmission, { GH_TOKEN: 'tok2' });
    assert.ok(fetcher);
  });

  it('gitlab provider yields null (documented gap — no gitlab contents-API adapter)', () => {
    const sub = { ...githubSubmission, source: { provider: 'gitlab' } };
    assert.equal(resolveScenarioFetcher(realProvenance, sub, ENV), null);
  });

  it('stub provenance yields null (preview/test runs never hit the GitHub API)', () => {
    assert.equal(resolveScenarioFetcher(stubProvenance, githubSubmission, ENV), null);
  });

  it('missing token yields null', () => {
    assert.equal(resolveScenarioFetcher(realProvenance, githubSubmission, {}), null);
  });

  it('null / array / malformed submissions yield null', () => {
    assert.equal(resolveScenarioFetcher(realProvenance, null, ENV), null);
    assert.equal(resolveScenarioFetcher(realProvenance, [], ENV), null);
    assert.equal(resolveScenarioFetcher(realProvenance, { repo: 42, ref: { commit_sha: 'deadbeef' } }, ENV), null);
    assert.equal(resolveScenarioFetcher(realProvenance, { repo: 'org/repo', ref: {} }, ENV), null);
    assert.equal(resolveScenarioFetcher(realProvenance, { repo: 'org/repo' }, ENV), null);
  });
});
