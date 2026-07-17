/**
 * f-7545196d-remediation-parity.test.js — F-7545196d + F-b5cd4274: the two
 * emitters in persist-results.js must agree on remediated findings, and
 * neither may mutate the caller's input.
 *
 * F-7545196d: buildScenarioResults (Path A, the published dogfood
 * submission) built a remediateMap but only consulted it for the
 * `step_results[].remediate` flag — deriveVerdict/openFindings scored the
 * RAW pre-remediation status. buildAuditPayload (Path B, the audit DB
 * payload) DID apply fixes. One CRITICAL finding plus a matching remediate
 * fix produced Path A `overall_verdict: 'fail'` (with a self-contradictory
 * `remediate: pass` next to `verify: fail`) alongside Path B
 * `overall_status: 'pass'` for the IDENTICAL input — and Path A is what gets
 * ingested into the shared records/ corpus other repos read.
 *
 * F-b5cd4274: buildAuditPayload additionally mutated `f.status` through
 * shared finding-object references into the caller's auditResults array, so
 * calling buildAuditPayload BEFORE buildScenarioResults (rather than after,
 * the CLI's incidental fixed order) silently changed buildScenarioResults'
 * answer for the exact same logical input.
 *
 * The fix (persist-results.js: collectFixedIds / applyRemediation) resolves
 * remediation ONCE into brand-new objects and both builders route through
 * it — order-independent and mutation-free.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenarioResults, computeOverallVerdict, buildAuditPayload } from './persist-results.js';

const MANIFEST = { repo: 'org/repo', commit_sha: 'a'.repeat(40) };

function fixture() {
  return [
    {
      component_id: 'core',
      component_type: 'backend',
      findings: [{ id: 'F-1', severity: 'CRITICAL', category: 'security', status: 'open' }],
      controls: [],
    },
  ];
}
const REMEDIATE = [{ component_id: 'core', fixes: [{ finding_id: 'F-1' }] }];

describe('Path A and Path B agree on a remediated CRITICAL (F-7545196d)', () => {
  it('both paths report pass for the SAME (auditResults, remediateResults) input', () => {
    const auditResults = fixture();

    const scenarioResults = buildScenarioResults(auditResults, REMEDIATE);
    const overallVerdict = computeOverallVerdict(scenarioResults);
    assert.equal(overallVerdict, 'pass', 'Path A must apply the remediation fix to its verdict, not just the step flag');
    assert.equal(scenarioResults[0].step_results.find(s => s.step_id === 'verify').status, 'pass');

    const auditPayload = buildAuditPayload(MANIFEST, auditResults, REMEDIATE);
    assert.equal(auditPayload.run.overall_status, 'pass');
    assert.equal(auditPayload.metrics.critical_count, 0);

    assert.equal(overallVerdict, 'pass');
    assert.equal(auditPayload.run.overall_status, 'pass', 'the two paths must agree, not silently diverge');
  });

  it('without a matching remediate fix, both paths still agree (fail/fail — no false green)', () => {
    const auditResults = fixture();
    const scenarioResults = buildScenarioResults(auditResults, []);
    const auditPayload = buildAuditPayload(MANIFEST, auditResults, []);
    assert.equal(computeOverallVerdict(scenarioResults), 'fail');
    assert.equal(auditPayload.run.overall_status, 'fail');
  });
});

describe('buildAuditPayload does not mutate its input (F-b5cd4274)', () => {
  it('auditResults is byte-for-byte identical before and after the call', () => {
    const auditResults = fixture();
    const before = JSON.parse(JSON.stringify(auditResults));

    buildAuditPayload(MANIFEST, auditResults, REMEDIATE);

    assert.deepEqual(auditResults, before, 'buildAuditPayload must never write through to the caller\'s objects');
    assert.equal(auditResults[0].findings[0].status, 'open', 'the ORIGINAL finding object must be untouched');
  });
});

describe('buildScenarioResults is order-independent of buildAuditPayload (F-b5cd4274)', () => {
  it('running buildAuditPayload FIRST does not change buildScenarioResults\' verdict on the same input', () => {
    const auditResultsA = fixture();
    const auditResultsB = fixture(); // a SEPARATE, identical fixture — proves parity, not shared-object luck

    // Baseline: buildScenarioResults called with nothing having run first.
    const baselineVerdict = computeOverallVerdict(buildScenarioResults(auditResultsA, REMEDIATE));

    // buildAuditPayload runs FIRST on its own copy, then buildScenarioResults
    // runs on ITS copy — if either function still wrote through shared
    // references (pre-fix behavior), this ordering would previously have
    // been irrelevant to the bug (the two fixtures are separate objects), so
    // this test also re-confirms fixture separation is not doing the work;
    // the real proof is the identical-object case below.
    buildAuditPayload(MANIFEST, auditResultsB, REMEDIATE);
    const afterVerdict = computeOverallVerdict(buildScenarioResults(auditResultsB, REMEDIATE));

    assert.equal(afterVerdict, baselineVerdict);
    assert.equal(afterVerdict, 'pass');
  });

  it('running buildAuditPayload FIRST on the SAME object graph does not change buildScenarioResults\' verdict', () => {
    // This is the exact regression: pre-fix, buildAuditPayload mutated
    // `f.status` on findings that ARE the objects inside auditResults (no
    // copy), so any caller who ran it before buildScenarioResults on the
    // SAME array got a different (accidentally-correct) answer than a
    // caller who ran buildScenarioResults alone or first.
    const auditResults = fixture();
    buildAuditPayload(MANIFEST, auditResults, REMEDIATE);
    const verdict = computeOverallVerdict(buildScenarioResults(auditResults, REMEDIATE));
    assert.equal(verdict, 'pass', 'buildScenarioResults must independently apply remediation, not rely on a prior mutation');
    assert.equal(auditResults[0].findings[0].status, 'open', 'buildAuditPayload must still not have mutated the shared object');
  });
});
