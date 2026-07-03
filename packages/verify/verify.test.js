import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify, parseRejectionReason } from './index.js';
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

  it('does not throw on a null step element under a pass verdict (verify-B-004)', () => {
    // A null step element is submission-bad and must surface as a returned error,
    // NOT a TypeError. Pre-fix the pass-verdict consistency filter dereferenced
    // `s.status` without a null-guard (its sibling loops guard `step == null`),
    // so a null element threw — which runValidator in index.js would then
    // misclassify as VALIDATOR_FAULT_STEPS (operational) instead of submission-bad.
    const scenario = structuredClone(pilot0.scenario_results[0]);
    scenario.verdict = 'pass';
    scenario.step_results.push(null);
    let errors;
    assert.doesNotThrow(() => {
      errors = validateStepResults(scenario);
    });
    assert.ok(
      errors.some(e => e.includes('malformed')),
      `expected a malformed-step error, got: ${JSON.stringify(errors)}`
    );
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
    assert.ok(
      result.errors.some(e => e.includes('attested-if-human')),
      `expected an attested-if-human policy error, got: ${JSON.stringify(result.errors)}`
    );
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
    assert.ok(
      result.errors.some(e => e.includes('blocked-needs-reason')),
      `expected a blocked-needs-reason policy error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('rejects when evidence requirements not met', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].evidence = [];
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('evidence')),
      `expected an evidence-requirement policy error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('rejects disallowed execution_mode per surface policy', () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].execution_mode = 'human';
    bad.scenario_results[0].attested_by = 'mike';
    const result = validatePolicy(bad, { globalPolicy, repoPolicy });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(e => e.includes('execution_mode')),
      `expected an execution_mode policy error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('enforces min_evidence_count PER scenario, not aggregated across scenarios [F-VERIFY-002]', () => {
    // The policy.schema.json description for min_evidence_count documents the
    // contract; the verifier enforces it per scenario. This pins per-scenario
    // semantics with a submission that PASSES under an aggregate reading but
    // FAILS per scenario: scenario A has 0 evidence, scenario B has 4. The total
    // (4) clears a min of 2 — so an aggregate interpretation would accept — while
    // scenario A (0 < 2) must reject under the real per-scenario rule.
    const policy = {
      policy_version: '1.0.0',
      defaults: {
        evidence_requirements: { required_kinds: [], min_evidence_count: 2 }
      }
    };
    const submission = {
      scenario_results: [
        { scenario_id: 'sc-a', product_surface: 'cli', execution_mode: 'bot', evidence: [] },
        {
          scenario_id: 'sc-b',
          product_surface: 'cli',
          execution_mode: 'bot',
          evidence: [
            { kind: 'log' }, { kind: 'log' }, { kind: 'log' }, { kind: 'log' }
          ]
        }
      ]
    };

    const result = validatePolicy(submission, { globalPolicy: policy, repoPolicy: null });
    assert.equal(result.valid, false, 'scenario A has 0 of 2 required evidence items — must reject per scenario');
    assert.ok(
      result.errors.some(e => e.includes('requires 2 evidence items, got 0')),
      `expected a per-scenario evidence error for scenario A, got: ${JSON.stringify(result.errors)}`
    );
    // Scenario B (4 ≥ 2) individually satisfies the requirement — the rejection
    // is attributable to A alone, which is the per-scenario signature.
    assert.ok(
      !result.errors.some(e => e.includes('got 4')),
      'scenario B satisfies the requirement on its own and must not error'
    );
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

  it('propagates a thrown provenance fault as a coded operational error [F-VERIFY-001 / F-82429f90]', async () => {
    // verify-A-002: the real adapters THROW on operational provider faults
    // (429 rate-limit, 5xx outage, 401/403 token). F-82429f90 (wave 4):
    // verify() must NOT convert that throw into a persisted `_rejected`
    // record — during an outage window the duplicate guard would then block
    // a clean resubmission under the same run_id FOREVER. The fault
    // propagates as a coded PROVENANCE_FAULT error whose message keeps the
    // `provenance-fault:` prefix parseRejectionReason classifies as
    // operational (page ops, never bounce to the submitter).
    const faultingProvenance = {
      async confirm() {
        throw new Error('provenance: GitHub API returned 503');
      }
    };
    await assert.rejects(
      verify(pilot0, {
        globalPolicy,
        repoPolicy,
        provenance: faultingProvenance,
        policyVersion: '1.0.0'
      }),
      (err) => {
        assert.equal(err.code, 'PROVENANCE_FAULT',
          `expected code PROVENANCE_FAULT; got ${err.code} (${err.message})`);
        assert.match(err.message, /^provenance-fault: verification failed: /);
        assert.ok(err.message.includes('GitHub API returned 503'),
          'underlying adapter detail must be carried');
        assert.equal(parseRejectionReason(err.message).class, 'operational',
          `thrown provenance fault must classify operational, got: ${err.message}`);
        return true;
      },
      'an operational provider fault must propagate out of verify(), never assemble a rejected record'
    );
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

  it('emits a reason that classifies operational, not unknown (verify-B-003)', async () => {
    // A null submission is a malfunctioning dispatcher (operational), not a
    // bad-but-shaped submitter payload. The end-to-end signal must route to ops.
    const record = await verify(null, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });
    const classes = record.verification.rejection_reasons.map(r => parseRejectionReason(r).class);
    assert.ok(
      classes.includes('operational'),
      `expected an operational class, got: ${JSON.stringify(classes)}`
    );
    assert.ok(
      !classes.includes('unknown'),
      `null-submission reason should not classify 'unknown', got: ${JSON.stringify(classes)}`
    );
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

  it('throws provenance: network error on persistent non-AbortError fetch failures (F-dac7e08c)', async () => {
    // Pre-F-dac7e08c this pinned `return false` — which classified a network
    // outage as submission-bad. The contract is now: retry within budget,
    // then THROW so parseRejectionReason routes the incident to ops.
    const failingFetch = async () => { throw new Error('connection refused'); };
    const adapter = githubProvenance('test-token', {
      timeoutMs: 1000,
      retries: 1,
      sleepImpl: async () => {},
      fetchImpl: failingFetch
    });
    await assert.rejects(
      adapter.confirm({
        provider: 'github',
        provider_run_id: '1',
        run_url: 'https://github.com/owner/repo/actions/runs/1'
      }),
      /provenance: network error: connection refused/
    );
  });
});

// ── githubProvenance binds persisted ref.commit_sha to the run (verify-A-001) ─
//
// HIGH/security: the commit a record attests to is submission.ref.commit_sha
// (index.js persists submission.ref verbatim). Pre-fix, provenance only compared
// the run head against source.commit_sha — a DIFFERENT, OPTIONAL field — so an
// authenticated submitter who owns a real completed run could set ref.commit_sha
// to any arbitrary 40-hex sha and earn a provenance_confirmed 'pass' record for a
// commit the run never executed. The fix binds the run head to the persisted
// commit by passing ref.commit_sha into confirm() and rejecting any mismatch.

describe('githubProvenance binds ref.commit_sha to the run (verify-A-001)', () => {
  const RUN_HEAD = 'c5d6c4e0000000000000000000000000deadbeef';
  const FORGED = 'f0f0f0f0000000000000000000000000baddecaf';

  function fetchReturning(run) {
    return async () => ({ ok: true, json: async () => run });
  }
  const completedRun = {
    id: 9123456789,
    status: 'completed',
    conclusion: 'success',
    head_sha: RUN_HEAD,
    repository: { full_name: 'owner/repo' }
  };
  const source = {
    provider: 'github',
    provider_run_id: '9123456789',
    run_url: 'https://github.com/owner/repo/actions/runs/9123456789',
    repo: 'owner/repo'
  };

  // Schema-valid source for the full-pipeline cases: the source schema requires
  // `workflow` and forbids additional properties, so the pilot-0 source shape is
  // reused and only the run-locating fields are pointed at owner/repo.
  function pipelineSource() {
    return {
      ...pilot0.source,
      run_url: 'https://github.com/owner/repo/actions/runs/9123456789',
      provider_run_id: '9123456789'
    };
  }

  it('rejects when the persisted ref.commit_sha differs from the run head_sha', async () => {
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(completedRun)
    });
    const ok = await adapter.confirm(source, { refCommitSha: FORGED });
    assert.equal(ok, false,
      'a ref.commit_sha that does not match the confirmed run head must NOT be confirmed');
  });

  it('confirms when the persisted ref.commit_sha matches the run head_sha', async () => {
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchReturning(completedRun)
    });
    const ok = await adapter.confirm(source, { refCommitSha: RUN_HEAD });
    assert.equal(ok, true,
      'a ref.commit_sha equal to the confirmed run head must be confirmed');
  });

  it('full pipeline: a forged ref.commit_sha is rejected with a provenance reason', async () => {
    // Real githubProvenance through verify(): index.js must pass the persisted
    // ref.commit_sha into confirm so the forgery is caught before persistence.
    const forged = structuredClone(pilot0);
    forged.repo = 'owner/repo';
    forged.source = pipelineSource();
    forged.ref = { ...forged.ref, commit_sha: FORGED };

    const record = await verify(forged, {
      globalPolicy,
      repoPolicy,
      provenance: githubProvenance('token', {
        timeoutMs: 1000,
        fetchImpl: fetchReturning(completedRun)
      }),
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.provenance_confirmed, false);
    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.startsWith('provenance:')),
      `expected a provenance: rejection, got ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('full pipeline: a matching ref.commit_sha is confirmed', async () => {
    const honest = structuredClone(pilot0);
    honest.repo = 'owner/repo';
    honest.source = pipelineSource();
    honest.ref = { ...honest.ref, commit_sha: RUN_HEAD };

    const record = await verify(honest, {
      globalPolicy,
      repoPolicy,
      provenance: githubProvenance('token', {
        timeoutMs: 1000,
        fetchImpl: fetchReturning(completedRun)
      }),
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.provenance_confirmed, true,
      `expected confirmed provenance, got reasons ${JSON.stringify(record.verification.rejection_reasons)}`);
  });
});

// ── githubProvenance distinguishes ops outages from missing runs (verify-A-002) ─
//
// MEDIUM/silent_failure: `if (!resp.ok) return false` collapsed every non-2xx
// (401/403 expired token, 429 rate limit, 5xx outage) into the SAME 'unconfirmed'
// result a genuinely-missing run (404) produces. index.js then records a
// submission-bad 'provenance: source run could not be confirmed' and routing
// bounces an ops outage to submitters. Mirroring the timeout fix, auth/operational
// statuses now THROW so the verifier records them as operational; only 404 (run
// genuinely absent) returns the not-found rejection.

describe('githubProvenance distinguishes ops failures from missing runs (verify-A-002)', () => {
  const source = {
    provider: 'github',
    provider_run_id: '12345',
    run_url: 'https://github.com/owner/repo/actions/runs/12345'
  };

  function fetchWithStatus(status) {
    return async () => ({ ok: false, status, json: async () => ({}) });
  }

  for (const status of [401, 403, 429, 500, 503]) {
    it(`throws an operational error on HTTP ${status} (not a submission-bad false)`, async () => {
      const adapter = githubProvenance('token', {
        timeoutMs: 1000,
        retries: 0,
        fetchImpl: fetchWithStatus(status)
      });
      await assert.rejects(
        adapter.confirm(source),
        err => {
          assert.match(err.message, /provenance: GitHub API returned/);
          assert.match(err.message, new RegExp(String(status)));
          return true;
        }
      );
    });
  }

  it('still returns false (run genuinely absent) on HTTP 404', async () => {
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      fetchImpl: fetchWithStatus(404)
    });
    const ok = await adapter.confirm(source);
    assert.equal(ok, false, '404 means the run does not exist — a real rejection, not an outage');
  });
});

// ── githubProvenance bounded retry over transient faults (PROACT-VERIFY-001) ──
//
// MEDIUM/resilience: a single 429 rate-limit or 5xx provider blip used to fail
// the whole submission as an operational incident, even though one retry would
// have confirmed the run. The adapter now retries 429/5xx a BOUNDED number of
// times (opts.retries, default 2) with exponential backoff (honoring
// Retry-After), and still THROWS on exhaustion so a genuinely-down provider
// surfaces as operational — never a false 'confirmed'. 404 is NOT retried.

describe('githubProvenance bounded retry (PROACT-VERIFY-001)', () => {
  const RUN_HEAD = 'a'.repeat(40);
  const source = {
    provider: 'github',
    provider_run_id: '12345',
    run_url: 'https://github.com/owner/repo/actions/runs/12345',
    commit_sha: RUN_HEAD,
    repo: 'owner/repo'
  };
  const completedRun = {
    id: 12345,
    status: 'completed',
    head_sha: RUN_HEAD,
    repository: { full_name: 'owner/repo' }
  };

  // A fetch impl that returns the given statuses in order, then a 200 with body.
  function fetchSequence(statuses, body) {
    let i = 0;
    return async () => {
      if (i < statuses.length) {
        const status = statuses[i++];
        return { ok: false, status, headers: { get: () => null }, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => body };
    };
  }

  it('retries a 429 then confirms on the following 200 (retry worked)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => completedRun };
    };
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      backoffMs: 1,
      fetchImpl
    });
    const ok = await adapter.confirm(source, { refCommitSha: RUN_HEAD });
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
      return { ok: true, status: 200, json: async () => completedRun };
    };
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      sleepImpl: ms => { waited.push(ms); return Promise.resolve(); },
      fetchImpl
    });
    const ok = await adapter.confirm(source, { refCommitSha: RUN_HEAD });
    assert.equal(ok, true);
    assert.deepEqual(waited, [2000], 'Retry-After: 2 must drive a 2000ms wait');
  });

  it('THROWS on exhausted 5xx retries (a genuinely-down provider still surfaces)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    };
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      retries: 2,
      backoffMs: 1,
      fetchImpl
    });
    await assert.rejects(
      adapter.confirm(source),
      err => {
        assert.match(err.message, /provenance: GitHub API returned 500/);
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
    const adapter = githubProvenance('token', {
      timeoutMs: 1000,
      retries: 2,
      backoffMs: 1,
      fetchImpl
    });
    const ok = await adapter.confirm(source);
    assert.equal(ok, false);
    assert.equal(calls, 1, '404 must not be retried');
  });
});
