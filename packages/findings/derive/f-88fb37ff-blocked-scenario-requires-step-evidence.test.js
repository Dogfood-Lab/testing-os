/**
 * F-88fb37ff (downstream amplification): rule-blocked-scenario derived a
 * 'verification_gap'/'missing_precondition' meta-finding purely from
 * scenario_results[].verdict === 'blocked' + blocking_reason, with NO read of
 * step_results at all — so a self-contradictory record (blocked verdict,
 * every step reports pass) caused the intelligence layer to synthesize a
 * plausible-sounding "infrastructure gap" finding that the record's OWN step
 * evidence directly contradicts. Every existing fixture in derive.test.js
 * (makeBlockedRecord, the multi-scenario 'scen-blocked' case) happened to
 * pair verdict:'blocked' with a step_results entry that is ALSO
 * status:'blocked' — the adversarial all-pass shape had zero coverage
 * anywhere in this rule's test history.
 *
 * The sibling rule-scenario-step-failure (verdict==='fail') already requires
 * failedSteps(record).length > 0 in its own applies() — this fix brings
 * rule-blocked-scenario to the evidentiary floor its sibling rule already had.
 *
 * This is a SEPARATE line of defense from packages/verify's fix to
 * validateStepResults/validateRequiredSteps (see
 * f-88fb37ff-reverse-verdict-consistency.test.js there): the derive pipeline
 * reads BOTH accepted AND _rejected records — load-records.js deliberately
 * walks records/_rejected/<org>/<repo> too, specifically so failure patterns
 * can be analyzed — and rule-blocked-scenario never consulted
 * verification.status. So a record the verifier now rejects for this exact
 * contradiction is STILL handed to every derive rule, scenario_results
 * unchanged (verify() never mutates submitter-authored fields). Fixing the
 * producer (verify) does not, by itself, stop this consumer from
 * mis-deriving; the rule needed its own gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFromRecord } from './derive-findings.js';

/** Mirrors derive.test.js's makePassingRecord() shape. */
function baseRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'f-88fb37ff-001',
    repo: 'mcp-tool-shop-org/test-api',
    ref: { commit_sha: 'a'.repeat(40) },
    source: { provider: 'github', workflow: 'dogfood.yml', provider_run_id: '1', run_url: 'https://example.com' },
    timing: { started_at: '2026-03-29T00:00:00Z', finished_at: '2026-03-29T00:01:00Z' },
    ci_checks: [],
    overall_verdict: { proposed: 'blocked', verified: 'fail', downgraded: true },
    verification: {
      status: 'rejected',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
      rejection_reasons: ['steps[api-health]: scenario verdict is "blocked" but no step reports status fail/blocked']
    },
    ...overrides
  };
}

function contradictoryBlockedRecord() {
  return baseRecord({
    scenario_results: [{
      scenario_id: 'api-health',
      product_surface: 'api',
      execution_mode: 'bot',
      verdict: 'blocked',
      blocking_reason: 'Server failed to start on port 4321',
      // Every step reports pass — the record's OWN evidence contradicts its
      // self-reported verdict. This is the exact shape F-88fb37ff proved
      // slips past validateStepResults pre-fix (see the sibling test in
      // packages/verify).
      step_results: [
        { step_id: 'start-server', status: 'pass' },
        { step_id: 'health-check', status: 'pass' }
      ],
      evidence: []
    }]
  });
}

function genuinelyBlockedRecord() {
  return baseRecord({
    verification: {
      status: 'accepted',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
      rejection_reasons: []
    },
    scenario_results: [{
      scenario_id: 'api-health',
      product_surface: 'api',
      execution_mode: 'bot',
      verdict: 'blocked',
      blocking_reason: 'Server failed to start on port 4321',
      step_results: [{ step_id: 'start-server', status: 'blocked' }],
      evidence: []
    }]
  });
}

describe('F-88fb37ff: rule-blocked-scenario requires step evidence, not just the self-reported verdict', () => {
  it('does NOT derive a finding from a blocked verdict whose steps are ALL pass (mirrors the proven verify() repro)', () => {
    const candidates = deriveFromRecord(contradictoryBlockedRecord(), { rejected: true });
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.equal(match, undefined,
      `pre-fix bug: rule-blocked-scenario synthesized a finding from step evidence that directly contradicts the verdict; got: ${JSON.stringify(match)}`);
  });

  it('STILL derives a finding from a genuinely blocked scenario (no false negatives introduced)', () => {
    const candidates = deriveFromRecord(genuinelyBlockedRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.ok(match, 'a blocked verdict backed by an actually-blocked step must still derive');
    assert.ok(match.summary.includes('Server failed to start'));
  });

  it('a fail-status step also counts as backing evidence for a blocked verdict (fail/blocked are one evidentiary class, matching validateStepResults)', () => {
    const record = baseRecord({
      verification: {
        status: 'accepted',
        verified_at: '2026-03-29T00:01:00Z',
        provenance_confirmed: true,
        schema_valid: true,
        policy_valid: true,
        rejection_reasons: []
      },
      scenario_results: [{
        scenario_id: 'api-health',
        product_surface: 'api',
        execution_mode: 'bot',
        verdict: 'blocked',
        blocking_reason: 'Downstream dependency errored',
        step_results: [{ step_id: 'start-server', status: 'fail' }],
        evidence: []
      }]
    });
    const candidates = deriveFromRecord(record);
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.ok(match, 'a "fail"-status step must also satisfy the evidence gate');
  });
});
