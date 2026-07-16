/**
 * F-e42e8f80 (wave 20, amends F-88fb37ff): rule-blocked-scenario's evidence
 * gate (hasNonPassStepEvidence, formerly hasFailOrBlockedStep) required at
 * least one step to ACTIVELY report fail/blocked, which had the identical
 * status-set blind spot the verifier-level fix
 * (f-e42e8f80-skip-status-neutral-evidence.test.js, packages/verify) closed:
 * a genuinely blocked scenario whose steps honestly report 'skip' (never ran
 * because the scenario was blocked upstream) has ZERO fail/blocked steps, so
 * the old gate silently dropped the 'verification_gap'/'missing_precondition'
 * finding for exactly the class of record most likely to deserve it —
 * proven directly against the real, unmutated RULES export below.
 *
 * This is the SAME record shape f-e42e8f80-skip-status-neutral-evidence's
 * "ACCEPTS verdict=blocked with all 7 steps skip" test proves the verifier
 * now accepts — once accepted, it persists to records/ (or, if some OTHER
 * validator also rejects it, to records/_rejected/), and load-records.js
 * reads both, so this rule must derive the finding either way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFromRecord } from './derive-findings.js';

/** Mirrors f-88fb37ff-blocked-scenario-requires-step-evidence.test.js's baseRecord(). */
function baseRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'f-e42e8f80-001',
    repo: 'mcp-tool-shop-org/test-api',
    ref: { commit_sha: 'a'.repeat(40) },
    source: { provider: 'github', workflow: 'dogfood.yml', provider_run_id: '1', run_url: 'https://example.com' },
    timing: { started_at: '2026-03-29T00:00:00Z', finished_at: '2026-03-29T00:01:00Z' },
    ci_checks: [],
    overall_verdict: { proposed: 'blocked', verified: 'blocked', downgraded: false },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
      rejection_reasons: []
    },
    ...overrides
  };
}

function blockedRecordWithSteps(statuses) {
  return baseRecord({
    scenario_results: [{
      scenario_id: 'api-health',
      product_surface: 'api',
      execution_mode: 'bot',
      verdict: 'blocked',
      blocking_reason: 'Server failed to start on port 4321',
      step_results: statuses.map((status, i) => ({ step_id: `step-${i}`, status })),
      evidence: []
    }]
  });
}

/** @pins F-e42e8f80 */
describe('F-e42e8f80: rule-blocked-scenario derives on honest skip/partial step evidence (the silently-dropped shape pre-fix)', () => {
  it('DERIVES a finding when every step honestly reports "skip" (steps never ran — the class most likely to deserve this finding)', () => {
    const candidates = deriveFromRecord(blockedRecordWithSteps(['skip', 'skip']));
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.ok(match,
      'pre-fix bug: an all-skip blocked scenario (the honest "blocked before any step ran" shape) synthesized NO infrastructure-gap finding');
    assert.ok(match.summary.includes('Server failed to start'));
  });

  it('DERIVES a finding when every step reports "partial"', () => {
    const candidates = deriveFromRecord(blockedRecordWithSteps(['partial', 'partial']));
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.ok(match, `got: ${JSON.stringify(candidates.map(c => c.derived.rule_id))}`);
  });

  it('DERIVES a finding for a mixed shape (one step "pass", the rest "skip")', () => {
    const candidates = deriveFromRecord(blockedRecordWithSteps(['pass', 'skip', 'skip']));
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.ok(match, `got: ${JSON.stringify(candidates.map(c => c.derived.rule_id))}`);
  });

  it('REGRESSION: still does NOT derive when every step is actively "pass" (the F-88fb37ff contradiction case is unweakened)', () => {
    const candidates = deriveFromRecord(blockedRecordWithSteps(['pass', 'pass']));
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.equal(match, undefined,
      `rule-blocked-scenario must still refuse to synthesize a finding when step evidence directly contradicts the verdict; got: ${JSON.stringify(match)}`);
  });

  it('REGRESSION: an empty step_results array still does not derive (unchanged pre-existing edge, out of scope for this fix)', () => {
    const candidates = deriveFromRecord(blockedRecordWithSteps([]));
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.equal(match, undefined);
  });
});
