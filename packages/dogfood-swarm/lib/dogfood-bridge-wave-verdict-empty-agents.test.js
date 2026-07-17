/**
 * dogfood-bridge-wave-verdict-empty-agents.test.js — F-1f8fd647:
 * buildDogfoodSubmission's per-wave verdict used
 * `w.agents.every(a => a.status === 'complete')` (lib/persist/dogfood-bridge.js)
 * with no guard for an EMPTY agents array. Array.prototype.every on [] is
 * vacuously true, so a wave that dispatched ZERO agents (the
 * already-established all-domains-'shared' 0-agent dispatch shape — a prior
 * finding in this run's do-not-report list already proves dispatch() can
 * legitimately return `{agents:[]}` for a wave without throwing) reported a
 * clean scenario_result verdict of 'pass' with an empty step_results array —
 * a claim of success backed by literally no evidence.
 *
 * THE FIX. An empty agents array is its own case, checked BEFORE the
 * vacuous-truth `.every()` ever runs: it now reports 'blocked' (with a
 * `blocking_reason`, matching the dogfood-record-submission schema's own
 * {verdict, blocking_reason} pairing for this exact case — see
 * packages/schemas/src/json/dogfood-record-submission.schema.json and the
 * pairing enforcement in packages/verify/validators/policy.js) rather than
 * silently falling through to 'pass'.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) for the same reason as
 * export-verdict-complete-open-findings.test.js in this same directory — the
 * swarm-cp-core wave-14 domain owns `packages/dogfood-swarm/lib/**` only.
 *
 * WAVE-16 UPDATE (F-8451abe4). The second `it` below ("zero agents but a
 * REAL verification receipt...") originally asserted `step_results.length
 * === 1` — that pinned a shape that was itself a defect: a 'blocked'
 * verdict backed by exactly one 'pass' step, with no blocked/fail step
 * anywhere in the record. dogfood-bridge.js's step-synthesis guard now
 * fires whenever `noAgentsDispatched` is true (previously it guarded on the
 * narrower `agentSteps.length === 0`, which the verification push had
 * already made false), so this case now emits BOTH the verification step
 * and the synthesized blocked dispatch step. See
 * dogfood-bridge-blocked-verdict-step-parity.test.js in this same directory
 * for the full state-matrix pin this fix added.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePayload } from '@dogfood-lab/schemas';

import { buildDogfoodSubmission } from './persist/dogfood-bridge.js';

const COMMIT_SHA = 'c'.repeat(40);

function makeExport(wave) {
  return {
    run: {
      id: 'run-empty-wave', repo: 'dogfood-lab/testing-os', branch: 'main',
      commit_sha: COMMIT_SHA, created: '2026-07-01T00:00:00Z', completed: '2026-07-01T01:00:00Z',
    },
    waves: [wave],
    verification: wave.verification
      ? [{ wave: wave.number, phase: wave.phase, passed: wave.verification.passed, test_count: wave.verification.test_count }]
      : [],
    findings: { summary: { total: 0 }, items: [] },
    promotions: [],
  };
}

describe('F-1f8fd647 — a zero-agent wave is never a vacuous pass', () => {
  it('zero agents + no verification receipt reports "blocked" (with a blocking_reason), never "pass"', () => {
    const exp = makeExport({ number: 1, phase: 'health-audit-a', agents: [], verification: null, violations: [] });
    const submission = buildDogfoodSubmission(exp, 'partial');
    const scenario = submission.scenario_results[0];

    // Fixture sanity: genuinely a zero-evidence wave, not a mislabeled real
    // run. This originally asserted `step_results.length === 0`, which pinned a
    // shape the submission contract rejects outright (schema minItems:1 —
    // buildDogfoodSubmission now synthesizes the one 'dispatch' step that
    // states nothing ran; see persist-results-schema-conformance.test.js). The
    // zero-evidence property is now expressed as what it always meant: no step
    // came from an agent.
    assert.deepEqual(scenario.step_results.map(s => s.step_id), ['dispatch']);
    assert.ok(!scenario.step_results.some(s => s.step_id.startsWith('agent-')),
      'fixture sanity: no agent ran, so no agent-* step may appear');
    assert.notEqual(scenario.verdict, 'pass',
      "pre-fix: [].every(...) is vacuously true, so a 0-agent wave reported 'pass' with step_results: []");
    assert.equal(scenario.verdict, 'blocked');
    assert.equal(typeof scenario.blocking_reason, 'string');
    assert.ok(scenario.blocking_reason.length > 0, 'blocking_reason must be a non-empty explanation, matching the schema pairing');
  });

  it('zero agents but a REAL verification receipt still reports blocked, not pass — dispatching zero agents is never success on its own', () => {
    const exp = makeExport({
      number: 2, phase: 'treatment', agents: [],
      verification: { passed: true, adapter: 'node', test_count: 12 },
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'partial');
    const scenario = submission.scenario_results[0];

    assert.equal(scenario.verdict, 'blocked');

    // F-8451abe4: the verification step is recorded (real evidence, kept),
    // AND the synthesized dispatch/blocked step is now ALSO present — a
    // 'blocked' verdict must carry at least one blocked/fail step, and
    // before this fix it carried only the passing verification step. See
    // dogfood-bridge-blocked-verdict-step-parity.test.js for the full pin.
    assert.equal(scenario.step_results.length, 2,
      'both the verification step and the synthesized dispatch/blocked step must be present');
    assert.ok(scenario.step_results.some(s => s.step_id === 'verification' && s.status === 'pass'),
      'the real verification evidence must still be recorded');
    assert.ok(scenario.step_results.some(s => s.status === 'blocked'),
      "pre-fix: the 'blocked' verdict carried zero blocked-status steps — only a passing verification step");

    // This shape (non-empty step_results) is schema-clean; assert it stays
    // that way so the vacuous-pass fix does not trade one defect for a
    // schema-validity regression in the realistic zero-agent case.
    const result = validatePayload('recordSubmission', submission);
    if (!result.valid) {
      assert.fail(`schema validation failed: ${result.errors.map(e => `${e.path || '/'} ${e.message}`).join('; ')}`);
    }
  });

  it('a NON-empty agents array with all agents complete is unaffected — still pass (regression guard on the non-empty path)', () => {
    const exp = makeExport({
      number: 3, phase: 'health-audit-a',
      agents: [{ domain: 'core', status: 'complete' }],
      verification: { passed: true, adapter: 'node', test_count: 5 },
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'pass');
    assert.equal(submission.scenario_results[0].verdict, 'pass');
    assert.equal(submission.scenario_results[0].blocking_reason, undefined,
      'a real pass must not carry a blocking_reason left over from the empty-agents branch');
  });

  it('a NON-empty agents array with an incomplete agent is still partial (regression guard on the non-empty path)', () => {
    const exp = makeExport({
      number: 4, phase: 'health-audit-a',
      agents: [{ domain: 'core', status: 'dispatched' }],
      verification: null,
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'partial');
    assert.equal(submission.scenario_results[0].verdict, 'partial');
  });
});
