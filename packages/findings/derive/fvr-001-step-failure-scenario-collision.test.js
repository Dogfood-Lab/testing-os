/**
 * fvr-001-step-failure-scenario-collision.test.js — the step-failure rule's
 * finding_id must be scenario-scoped, not derived from the first failed step
 * id alone.
 *
 * AT HEAD: ruleScenarioStepFailure builds its slug as
 * `${repoSlug}-step-failure-${stepIds[0]}` — from the FIRST failed step id
 * only. The derive engine (derive-findings.js) presents each scenario_result
 * to every rule as its own per-scenario VIEW, so a record with TWO different
 * scenarios that each fail a step with the SAME step_id produces the SAME slug
 * → the SAME finding_id for both. `dedupeWithinBatch` keys on finding_id, so
 * the second scenario's finding is silently deduped away — a real, distinct
 * failure lost.
 *
 * AFTER FIX: the slug includes the scenario id
 * (`${repoSlug}-step-failure-${sid}-${stepIds[0]}`), mirroring the sibling
 * per-scenario rules (rule-blocked-scenario, rule-execution-mode-gap). Two
 * scenarios failing the same step id derive TWO distinct finding_ids and both
 * survive dedupe.
 *
 * Counter-test (load-bearing): a single-scenario step failure still emits
 * exactly one finding tied to that scenario — the fix cannot regress the
 * happy path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFromRecord } from './derive-findings.js';

/**
 * Two-scenario record whose scenarios fail a step with the SAME step_id but
 * carry DIFFERENT scenario_ids. Verification is clean (accepted, no rejection
 * reasons, not downgraded, bot mode, no blocked verdict) so ONLY
 * rule-scenario-step-failure fires — nothing else muddies the finding count.
 * The step_id `run-entrypoint` avoids the /verify|output|check/ and
 * /flag|arg|param/ classifiers, so both scenarios land in the same default
 * classification: the ONLY differentiator between the two findings is the
 * scenario id.
 */
function makeTwoScenarioSameStepRecord() {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'fvr-001-collide-001',
    repo: 'mcp-tool-shop-org/collide-test',
    ref: { commit_sha: 'a'.repeat(40) },
    source: { provider: 'github', workflow: 'dogfood.yml', provider_run_id: '1', run_url: 'https://example.com' },
    timing: { started_at: '2026-03-29T00:00:00Z', finished_at: '2026-03-29T00:01:00Z' },
    ci_checks: [],
    scenario_results: [
      {
        scenario_id: 'scen-alpha',
        product_surface: 'cli',
        execution_mode: 'bot',
        verdict: 'fail',
        step_results: [{ step_id: 'run-entrypoint', status: 'fail' }],
        evidence: [{ kind: 'log', url: 'https://example.com/log' }]
      },
      {
        scenario_id: 'scen-beta',
        product_surface: 'cli',
        execution_mode: 'bot',
        verdict: 'fail',
        step_results: [{ step_id: 'run-entrypoint', status: 'fail' }],
        evidence: [{ kind: 'log', url: 'https://example.com/log' }]
      }
    ],
    overall_verdict: { proposed: 'fail', verified: 'fail', downgraded: false },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
      rejection_reasons: []
    }
  };
}

describe('fvr-001: step-failure finding_id is scenario-scoped, not step-id-only', () => {
  it('two scenarios failing the SAME step_id derive TWO distinct finding_ids', () => {
    const candidates = deriveFromRecord(makeTwoScenarioSameStepRecord());
    const stepFail = candidates.filter(c => c.derived.rule_id === 'rule-scenario-step-failure');

    assert.equal(stepFail.length, 2,
      'both scenarios\' step failures must survive as distinct findings; pre-fix the ' +
      `shared slug collapses them to 1 via dedupe. Got ${stepFail.length}.`);

    const ids = new Set(stepFail.map(c => c.finding_id));
    assert.equal(ids.size, 2, 'the two step-failure findings must have distinct finding_ids');

    const scenarioIds = stepFail.map(c => (c.scenario_ids || []).join(',')).sort();
    assert.deepEqual(scenarioIds, ['scen-alpha', 'scen-beta'],
      'one finding per scenario, each tied to the right scenario_id');
  });

  it('single-scenario step failure still emits exactly one finding (no regression)', () => {
    const record = makeTwoScenarioSameStepRecord();
    record.scenario_results = [record.scenario_results[0]];
    const candidates = deriveFromRecord(record);
    const stepFail = candidates.filter(c => c.derived.rule_id === 'rule-scenario-step-failure');
    assert.equal(stepFail.length, 1, 'single scenario still emits exactly one step-failure finding');
    assert.deepEqual(stepFail[0].scenario_ids, ['scen-alpha']);
  });
});
