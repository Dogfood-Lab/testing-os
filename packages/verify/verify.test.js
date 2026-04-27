import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify } from './index.js';
import { validateSubmissionSchema } from './validators/schema.js';
import { validateStepResults } from './validators/steps.js';
import { validatePolicy } from './validators/policy.js';
import { computeVerdict } from './validators/verdict.js';
import { stubProvenance, rejectingProvenance, githubProvenance } from './validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const POLICIES = resolve(__dirname, '../../policies');

let pilot0;
let globalPolicy;
let repoPolicy;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
  globalPolicy = yaml.load(readFileSync(resolve(POLICIES, 'global-policy.yaml'), 'utf-8'));
  repoPolicy = yaml.load(
    readFileSync(resolve(POLICIES, 'repos/mcp-tool-shop-org/dogfood-labs.yaml'), 'utf-8')
  );
});

// ── Schema Validation ──────────────────────────────────────────

describe('schema validation', () => {
  it('accepts a valid pilot-0 submission', () => {
    const result = validateSubmissionSchema(pilot0);
    assert.equal(result.valid, true, `errors: ${result.errors.join(', ')}`);
  });

  it('rejects submission missing required fields', () => {
    const result = validateSubmissionSchema({ schema_version: '1.0.0' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects submission with invalid commit_sha pattern', () => {
    const bad = structuredClone(pilot0);
    bad.ref.commit_sha = 'not-a-sha';
    const result = validateSubmissionSchema(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('commit_sha')));
  });

  it('rejects submission with empty scenario_results', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results = [];
    const result = validateSubmissionSchema(bad);
    assert.equal(result.valid, false);
  });

  it('rejects submission with invalid overall_verdict type', () => {
    const bad = structuredClone(pilot0);
    bad.overall_verdict = { proposed: 'pass', verified: 'pass' };
    const result = validateSubmissionSchema(bad);
    assert.equal(result.valid, false);
  });
});

// ── Step Results Validation ────────────────────────────────────

describe('step results validation', () => {
  it('passes for valid step results', () => {
    const errors = validateStepResults(pilot0.scenario_results[0]);
    assert.deepEqual(errors, []);
  });

  it('rejects empty step_results', () => {
    const bad = { ...pilot0.scenario_results[0], step_results: [] };
    const errors = validateStepResults(bad);
    assert.ok(errors.length > 0);
  });

  it('rejects duplicate step IDs', () => {
    const bad = structuredClone(pilot0.scenario_results[0]);
    bad.step_results.push({ step_id: 'emit-submission', status: 'pass' });
    const errors = validateStepResults(bad);
    assert.ok(errors.some(e => e.includes('duplicate')));
  });

  it('rejects pass verdict when a step is fail', () => {
    const bad = structuredClone(pilot0.scenario_results[0]);
    bad.verdict = 'pass';
    bad.step_results[0].status = 'fail';
    const errors = validateStepResults(bad);
    assert.ok(errors.some(e => e.includes('fail')));
  });

  it('allows partial verdict with failing steps', () => {
    const scenario = structuredClone(pilot0.scenario_results[0]);
    scenario.verdict = 'partial';
    scenario.step_results[0].status = 'fail';
    const errors = validateStepResults(scenario);
    assert.deepEqual(errors, []);
  });
});

// ── Policy Validation ──────────────────────────────────────────

describe('policy validation', () => {
  it('passes for valid pilot-0 submission', () => {
    const result = validatePolicy(pilot0, { globalPolicy, repoPolicy });
    assert.equal(result.valid, true, `errors: ${result.errors.join(', ')}`);
  });

  it('rejects human execution_mode without attested_by', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].execution_mode = 'human';
    // no attested_by
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('attested-if-human')));
  });

  it('passes human execution_mode with attested_by', () => {
    const good = structuredClone(pilot0);
    good.scenario_results[0].execution_mode = 'human';
    good.scenario_results[0].attested_by = 'mike';
    // Note: dogfood-labs policy only allows bot mode for cli surface,
    // so this will fail on execution_mode_policy, not attestation
    const result = validatePolicy(good, { globalPolicy, repoPolicy });
    assert.ok(result.errors.some(e => e.includes('execution_mode')) || result.valid);
  });

  it('rejects blocked verdict without blocking_reason', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].verdict = 'blocked';
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('blocked-needs-reason')));
  });

  it('rejects when evidence requirements not met', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].evidence = [];
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('evidence')));
  });

  it('rejects disallowed execution_mode per surface policy', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].execution_mode = 'human';
    bad.scenario_results[0].attested_by = 'mike';
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('execution_mode')));
  });

  it('rejects failing CI tests when tests_must_pass is true', () => {
    const bad = structuredClone(pilot0);
    bad.ci_checks = [{ id: 'unit-tests', kind: 'test', status: 'fail', value: 20 }];
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('CI tests must pass')));
  });
});

// ── Verdict Computation ────────────────────────────────────────

describe('verdict computation', () => {
  it('confirms pass when everything passes', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'pass' }],
      reasons: []
    });
    assert.equal(result.verified, 'pass');
    assert.equal(result.downgraded, false);
  });

  it('downgrades pass to fail when policy fails', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: false,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'pass' }],
      reasons: ['policy: something']
    });
    assert.equal(result.verified, 'fail');
    assert.equal(result.downgraded, true);
    assert.ok(result.downgrade_reasons.length > 0);
  });

  it('downgrades pass to fail when provenance fails', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: false,
      scenarioResults: [{ verdict: 'pass' }],
      reasons: []
    });
    assert.equal(result.verified, 'fail');
    assert.equal(result.downgraded, true);
  });

  it('never upgrades a proposed fail', () => {
    const result = computeVerdict('fail', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'pass' }],
      reasons: []
    });
    assert.equal(result.verified, 'fail');
    assert.equal(result.downgraded, false);
  });

  it('downgrades pass to partial when worst scenario is partial', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'pass' }, { verdict: 'partial' }],
      reasons: []
    });
    assert.equal(result.verified, 'partial');
    assert.equal(result.downgraded, true);
  });

  it('downgrades pass to blocked when a scenario is blocked', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'blocked' }],
      reasons: []
    });
    assert.equal(result.verified, 'blocked');
    assert.equal(result.downgraded, true);
  });
});

// ── Full Verifier Pipeline (Pilot 0) ──────────────────────────

describe('full verifier pipeline (pilot 0)', () => {
  it('accepts a valid pilot-0 submission', async () => {
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'accepted');
    assert.equal(record.verification.schema_valid, true);
    assert.equal(record.verification.policy_valid, true);
    assert.equal(record.verification.provenance_confirmed, true);
    assert.equal(record.overall_verdict.proposed, 'pass');
    assert.equal(record.overall_verdict.verified, 'pass');
    assert.equal(record.overall_verdict.downgraded, false);
    assert.equal(record.policy_version, '1.0.0');
    assert.equal(record.run_id, pilot0.run_id);
    assert.equal(record.repo, pilot0.repo);
    assert.deepEqual(record.rejection_reasons, undefined);
    assert.deepEqual(record.verification.rejection_reasons, []);
  });

  it('rejects when provenance fails', async () => {
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: rejectingProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'rejected');
    assert.equal(record.verification.provenance_confirmed, false);
    assert.equal(record.overall_verdict.verified, 'fail');
    assert.equal(record.overall_verdict.downgraded, true);
    assert.ok(record.verification.rejection_reasons.some(r => r.includes('provenance')));
  });

  it('rejects when submission contains verifier-owned fields', async () => {
    const bad = { ...structuredClone(pilot0), policy_version: '1.0.0' };
    const record = await verify(bad, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('verifier-field'))
    );
  });

  it('rejects malformed submission', async () => {
    const record = await verify({ schema_version: '1.0.0' }, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'rejected');
    assert.equal(record.verification.schema_valid, false);
  });

  it('sets all verifier-owned fields on persisted record', async () => {
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    // Verifier-owned fields present
    assert.ok(record.policy_version);
    assert.ok(record.verification);
    assert.ok(record.verification.verified_at);
    assert.ok(typeof record.verification.provenance_confirmed === 'boolean');
    assert.ok(typeof record.verification.schema_valid === 'boolean');
    assert.ok(typeof record.verification.policy_valid === 'boolean');
    assert.ok(record.overall_verdict.proposed);
    assert.ok(record.overall_verdict.verified);
    assert.ok(typeof record.overall_verdict.downgraded === 'boolean');
  });

  it('carries through source-authored fields unchanged', async () => {
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.run_id, pilot0.run_id);
    assert.equal(record.repo, pilot0.repo);
    assert.deepEqual(record.ref, pilot0.ref);
    assert.deepEqual(record.source, pilot0.source);
    assert.deepEqual(record.timing, pilot0.timing);
    assert.deepEqual(record.ci_checks, pilot0.ci_checks);
    assert.equal(record.notes, pilot0.notes);
  });
});

// ── githubProvenance run.status guard (F-002109-026) ───────────

describe('githubProvenance requires completed runs', () => {
  const ORIG_FETCH = globalThis.fetch;
  const SOURCE = {
    provider: 'github',
    provider_run_id: '9123456789',
    run_url: 'https://github.com/owner/repo/actions/runs/9123456789',
    repo: 'owner/repo',
    commit_sha: 'c5d6c4e0000000000000000000000000deadbeef'
  };

  function mockRun(overrides) {
    return {
      id: 9123456789,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'c5d6c4e0000000000000000000000000deadbeef',
      repository: { full_name: 'owner/repo' },
      ...overrides
    };
  }

  function mockFetch(run) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => run
    });
  }

  function restoreFetch() {
    globalThis.fetch = ORIG_FETCH;
  }

  it('rejects runs with status: queued', async () => {
    mockFetch(mockRun({ status: 'queued', conclusion: null }));
    try {
      const ok = await githubProvenance('token').confirm(SOURCE);
      assert.equal(ok, false, 'queued run must not be confirmed');
    } finally { restoreFetch(); }
  });

  it('rejects runs with status: in_progress', async () => {
    mockFetch(mockRun({ status: 'in_progress', conclusion: null }));
    try {
      const ok = await githubProvenance('token').confirm(SOURCE);
      assert.equal(ok, false, 'in_progress run must not be confirmed');
    } finally { restoreFetch(); }
  });

  it('rejects runs with status: waiting', async () => {
    mockFetch(mockRun({ status: 'waiting', conclusion: null }));
    try {
      const ok = await githubProvenance('token').confirm(SOURCE);
      assert.equal(ok, false, 'waiting run must not be confirmed');
    } finally { restoreFetch(); }
  });

  it('accepts runs with status: completed', async () => {
    mockFetch(mockRun({ status: 'completed', conclusion: 'success' }));
    try {
      const ok = await githubProvenance('token').confirm(SOURCE);
      assert.equal(ok, true, 'completed run must be confirmed');
    } finally { restoreFetch(); }
  });

  it('accepts completed runs even when conclusion is failure (verifier confirms run RAN, not that it passed — pass/fail is a separate signal)', async () => {
    // Document the contract decision: status === 'completed' is the gate;
    // run-pass-or-fail is conveyed elsewhere (CI checks, scenario verdicts).
    mockFetch(mockRun({ status: 'completed', conclusion: 'failure' }));
    try {
      const ok = await githubProvenance('token').confirm(SOURCE);
      assert.equal(ok, true, 'verifier confirms run executed; pass/fail is a separate signal');
    } finally { restoreFetch(); }
  });
});

// ── Cross-org forgery guard (F-002109-025) ─────────────────────

describe('cross-org forgery guard', () => {
  it('rejects when submission.repo does not match submission.source.repo', async () => {
    // A submitter claims victim-org/victim-repo but supplies a real run from their own repo.
    // Provenance might pass (the run exists, source.repo matches itself), but the
    // verifier MUST reject before persistence so the record cannot be filed under victim org.
    const forged = structuredClone(pilot0);
    forged.repo = 'victim-org/victim-repo';
    // Leave source.repo as the original mcp-tool-shop-org/dogfood-labs (mismatch)

    const record = await verify(forged, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('repo:mismatch')),
      `expected repo:mismatch reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('accepts when submission.repo matches source.repo', async () => {
    // pilot0 already has matching repos — sanity check the guard does not fire on legitimate input
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });
    assert.ok(
      !record.verification.rejection_reasons.some(r => r.includes('repo:mismatch')),
      'repo:mismatch should NOT fire when repos agree'
    );
  });
});

// ── Null/non-object submission cleanly rejected (F-002109-027) ─

describe('null submission produces persistable rejection record', () => {
  it('returns a rejection record with all fields needed for clean persistence', async () => {
    const record = await verify(null, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('null or not an object')),
      `expected null-input reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
    // The rejection record must carry a sentinel `_skipPersist` marker OR
    // contain enough fields to flow through computeRecordPath without throwing.
    // We pick the explicit-skip approach: ingest reads this and skips writeRecord.
    assert.equal(record._skipPersist, true,
      'null-input rejection should be marked _skipPersist so persist layer is bypassed');
  });

  it('handles non-object input (string, number, array) the same way', async () => {
    for (const bad of ['string', 42, ['array']]) {
      const record = await verify(bad, {
        globalPolicy,
        repoPolicy,
        provenance: stubProvenance,
        policyVersion: '1.0.0'
      });
      assert.equal(record.verification.status, 'rejected');
      assert.equal(record._skipPersist, true);
    }
  });
});

// ── githubProvenance fetch timeout (F-246817-014 regression) ──
//
// Bug: githubProvenance called fetch() with no AbortController and no timeout.
// A hung GitHub API call would block the verifier indefinitely (until the
// surrounding GitHub Actions runner timed out, default 6h). The wrapping
// `try { ... } catch { return false; }` did NOT catch hangs — only thrown
// errors. Operators saw nothing in the logs.
//
// Fix: wrap fetch in AbortController with a 30s default timeout. On AbortError
// throw 'provenance: GitHub API timeout after Nms' so the verifier records it
// in rejection_reasons via its existing catch.

describe('githubProvenance fetch timeout (F-246817-014)', () => {
  // A fetch impl that never resolves until we abort it.
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
        // Never resolves on its own.
      });
    };
  }

  it('throws timeout error when fetch hangs longer than timeoutMs', async () => {
    const adapter = githubProvenance('test-token', {
      timeoutMs: 50,
      fetchImpl: makeHangingFetch()
    });
    const source = {
      provider: 'github',
      provider_run_id: '12345',
      run_url: 'https://github.com/owner/repo/actions/runs/12345'
    };
    const start = Date.now();
    await assert.rejects(
      adapter.confirm(source),
      err => {
        assert.match(err.message, /provenance: GitHub API timeout/);
        assert.match(err.message, /50ms/);
        return true;
      }
    );
    const elapsed = Date.now() - start;
    // Should fire close to the timeout, not block forever.
    assert.ok(elapsed < 5000, `expected fast abort, took ${elapsed}ms`);
  });

  it('does NOT throw when fetch returns a normal response within timeout', async () => {
    const fakeRun = {
      id: 99,
      status: 'completed',
      head_sha: 'a'.repeat(40),
      repository: { full_name: 'owner/repo' }
    };
    const fastFetch = async () => ({
      ok: true,
      json: async () => fakeRun
    });
    const adapter = githubProvenance('test-token', {
      timeoutMs: 1000,
      fetchImpl: fastFetch
    });
    const result = await adapter.confirm({
      provider: 'github',
      provider_run_id: '99',
      run_url: 'https://github.com/owner/repo/actions/runs/99',
      commit_sha: 'a'.repeat(40),
      repo: 'owner/repo'
    });
    assert.equal(result, true);
  });

  it('returns false (not throws) on non-AbortError fetch failures', async () => {
    const failingFetch = async () => { throw new Error('connection refused'); };
    const adapter = githubProvenance('test-token', {
      timeoutMs: 1000,
      fetchImpl: failingFetch
    });
    const result = await adapter.confirm({
      provider: 'github',
      provider_run_id: '1',
      run_url: 'https://github.com/owner/repo/actions/runs/1'
    });
    assert.equal(result, false);
  });
});
