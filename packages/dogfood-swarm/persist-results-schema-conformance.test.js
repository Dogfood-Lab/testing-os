/**
 * persist-results-schema-conformance.test.js
 *
 * F-242040-001 (Wave A1 D3, finding C1):
 * Swarm-emitted submissions were silently broken — the previous
 * persist-results.js `buildScenarioResults()` / `stepResult()` shapes
 * violated the dogfood-record-submission schema in three ways:
 *
 *   1. step_results[].step → schema requires `step_id` (additionalProperties:false)
 *   2. scenario_results[].evidence → schema requires ARRAY of {kind, url}; was an OBJECT
 *   3. scenario_results[].execution_mode → required by schema; was absent
 *
 * The verifier loudly rejected swarm-emitted submissions (exit 2,
 * INGEST_FAILED). Testing-os literally could not record its own dogfood
 * evidence until this fix landed.
 *
 * This test pushes BOTH emitter paths (the swarm `scenario_results` path
 * AND the dogfood-bridge wave path) through `validatePayload('recordSubmission')`
 * and asserts the submission validates clean. The two halves of the
 * invariant:
 *   - PRE-FIX: validation FAILS with at least one of {step_id, evidence
 *     array, execution_mode} complaints from the swarm path.
 *   - POST-FIX: both paths produce schema-clean submissions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePayload } from '@dogfood-lab/schemas';
import { buildSubmission } from '@dogfood-lab/report/build-submission.js';

import { buildScenarioResults, computeOverallVerdict } from './persist-results.js';
import { buildDogfoodSubmission } from './lib/persist/dogfood-bridge.js';

const COMMIT_SHA = 'a'.repeat(40);
const STARTED_AT = '2026-05-31T00:00:00.000Z';
const FINISHED_AT = '2026-05-31T00:01:00.000Z';

function makeSwarmSubmission(scenarioResults, overallVerdict = 'pass') {
  return buildSubmission({
    repo: 'mcp-tool-shop-org/test-repo',
    commitSha: COMMIT_SHA,
    branch: 'main',
    workflow: 'swarm-audit',
    providerRunId: 'swarm-run-123',
    runUrl: 'https://github.com/mcp-tool-shop-org/test-repo',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    scenarioResults,
    overallVerdict,
  });
}

describe('persist-results.js — schema conformance (C1)', () => {
  it('buildScenarioResults output validates against recordSubmission schema (swarm path)', () => {
    const audits = [
      {
        component_id: 'core',
        component_type: 'backend',
        findings: [
          { id: 'f1', severity: 'medium', status: 'open' },
          { id: 'f2', severity: 'low', status: 'open' },
        ],
        controls: [{ id: 'c1', status: 'pass' }],
      },
      {
        component_id: 'ui',
        component_type: 'frontend',
        findings: [
          { id: 'f3', severity: 'high', status: 'open' },
        ],
        controls: [{ id: 'c2', status: 'fail' }],
      },
    ];
    const remediate = [{ component_id: 'core', fixes: [{ finding_id: 'f1' }] }];

    const scenarioResults = buildScenarioResults(audits, remediate);
    const overall = computeOverallVerdict(scenarioResults);

    const submission = makeSwarmSubmission(scenarioResults, overall);
    const result = validatePayload('recordSubmission', submission);

    if (!result.valid) {
      const lines = result.errors.map(e => `${e.path || '/'} ${e.message}`);
      assert.fail(`swarm submission failed schema validation:\n  ${lines.join('\n  ')}`);
    }
    assert.equal(result.valid, true);
  });

  it('step_results[] use step_id (not step) and execution_mode is present', () => {
    const audits = [{
      component_id: 'core',
      component_type: 'backend',
      findings: [],
      controls: [],
    }];
    const scenarioResults = buildScenarioResults(audits, []);
    // Family probe: every scenario must include execution_mode and every step
    // must include step_id (the two schema invariants that were broken).
    for (const s of scenarioResults) {
      assert.equal(typeof s.execution_mode, 'string', `scenario ${s.scenario_id} missing execution_mode`);
      for (const step of s.step_results) {
        assert.equal(typeof step.step_id, 'string', `step in scenario ${s.scenario_id} missing step_id`);
        // step_id must match the schema pattern ^[a-z0-9][a-z0-9-]*$
        assert.match(step.step_id, /^[a-z0-9][a-z0-9-]*$/,
          `step_id "${step.step_id}" violates schema pattern`);
        // The pre-fix shape used `step`; assert that it is GONE so a regression
        // cannot silently bring it back (the schema's additionalProperties:false
        // would still reject it, but this asserts the family-of-shape fix).
        assert.equal(step.step, undefined,
          `step (legacy field) must be removed from step_results items`);
      }
    }
  });

  it('evidence is an array (not object) when present, with {kind, url} items', () => {
    const audits = [{
      component_id: 'core',
      component_type: 'backend',
      findings: [
        { id: 'f1', severity: 'medium', status: 'open' },
      ],
      controls: [],
    }];
    const scenarioResults = buildScenarioResults(audits, []);
    for (const s of scenarioResults) {
      if (s.evidence !== undefined) {
        assert.ok(Array.isArray(s.evidence),
          `evidence on ${s.scenario_id} must be an array, got ${typeof s.evidence}`);
        for (const item of s.evidence) {
          assert.equal(typeof item.kind, 'string',
            `evidence item missing kind`);
          assert.equal(typeof item.url, 'string',
            `evidence item missing url`);
        }
      }
    }
  });

  it('buildDogfoodSubmission output validates against recordSubmission schema (dogfood-bridge path)', () => {
    // Synthesise an export-shape input as the real bridge consumes
    const exportData = {
      run: {
        id: 'run-abc',
        repo: 'mcp-tool-shop-org/test-repo',
        branch: 'main',
        commit_sha: COMMIT_SHA,
        created: STARTED_AT,
        completed: FINISHED_AT,
      },
      waves: [
        {
          number: 1,
          phase: 'health-audit-a',
          status: 'collected',
          agents: [
            { domain: 'core', status: 'complete' },
            { domain: 'ui', status: 'complete' },
          ],
          verification: { passed: true, adapter: 'node', test_count: 100 },
          violations: [],
        },
      ],
      verification: [{ wave: 1, phase: 'health-audit-a', passed: true, test_count: 100 }],
      findings: { summary: { total: 5, by_severity: { CRITICAL: 0, HIGH: 1 } } },
      promotions: [],
    };

    const submission = buildDogfoodSubmission(exportData, 'pass');
    const result = validatePayload('recordSubmission', submission);

    if (!result.valid) {
      const lines = result.errors.map(e => `${e.path || '/'} ${e.message}`);
      assert.fail(`dogfood-bridge submission failed schema validation:\n  ${lines.join('\n  ')}`);
    }
    assert.equal(result.valid, true);
  });

  it('full pipeline: swarm scenario_results survive buildSubmission + precheck end-to-end', () => {
    // End-to-end: the same path persist-results.js (CLI main) follows.
    const audits = [{
      component_id: 'core',
      component_type: 'backend',
      findings: [
        { id: 'f1', severity: 'critical', status: 'open' },
      ],
      controls: [],
    }];
    const scenarioResults = buildScenarioResults(audits, []);
    const overall = computeOverallVerdict(scenarioResults);
    assert.equal(overall, 'fail');

    const submission = makeSwarmSubmission(scenarioResults, overall);
    // Re-validate the full envelope at the same gate the ingest pipeline uses.
    const result = validatePayload('recordSubmission', submission);
    assert.equal(result.valid, true,
      `end-to-end pipeline must produce schema-clean submission: ${JSON.stringify(result.errors)}`);
  });
});
