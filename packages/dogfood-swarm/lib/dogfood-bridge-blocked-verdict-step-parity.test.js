/**
 * dogfood-bridge-blocked-verdict-step-parity.test.js — F-8451abe4:
 * the chip commit 52c9ac2 synthesized a 'blocked' dispatch step guarded on
 * `agentSteps.length === 0`, and the wave verdict guarded on the DIFFERENT
 * condition `noAgentsDispatched` (lib/persist/dogfood-bridge.js). Whenever a
 * wave dispatched zero agents but DID have an independent verification
 * receipt, the verification push populated `agentSteps` with one entry
 * BEFORE the `agentSteps.length === 0` guard ran, so the synthesized
 * dispatch/blocked step never fired — while `noAgentsDispatched` (reading
 * `w.agents.length === 0` directly) still forced a 'blocked' verdict.
 * Proven live: {verdict:'blocked', blocking_reason:'...no evidence to
 * verify', step_results:[{step_id:'verification', status:'pass', ...}]} —
 * a 'blocked' record whose only step is a PASSING one, and whose own
 * blocking_reason claims no evidence exists next to a step that is exactly
 * that evidence.
 *
 * THE FIX. The step-synthesis guard now keys off the SAME
 * `noAgentsDispatched` flag that drives the wave verdict (hoisted to the top
 * of the per-wave closure so the two literally cannot read different
 * conditions again), and the dispatch step's `notes` / the scenario's
 * `blocking_reason` are worded to stay true whether or not a verification
 * receipt happens to coexist with zero dispatched agents.
 *
 * WHAT THIS FILE PINS. The brief's three-state matrix — zero-agent+receipt,
 * zero-agent+no-receipt, agents+steps — each must produce a
 * self-consistent verdict/step_results pair. "Passes packages/verify" here
 * means three distinct checks, run explicitly rather than by importing
 * `@dogfood-lab/verify`:
 *
 *   1. Schema-valid — `validatePayload('recordSubmission', ...)` from
 *      `@dogfood-lab/schemas`, the same call the sibling
 *      dogfood-bridge-wave-verdict-empty-agents.test.js and
 *      persist-results-schema-conformance.test.js already make.
 *   2. steps.js's pass/blocked consistency rule ("a scenario cannot be
 *      pass if any step is fail/blocked" — packages/verify/validators/
 *      steps.js lines 58-73) — reimplemented locally as
 *      `passVerdictHasNoFailingSteps()` below.
 *   3. policy.js's 'blocked-needs-reason' global reject rule
 *      (packages/verify/validators/policy.js lines 196-204) —
 *      reimplemented locally as `blockedVerdictHasReason()` below.
 *
 * These two are reimplemented rather than imported from
 * `@dogfood-lab/verify` because that package is not a declared dependency
 * of `@dogfood-lab/dogfood-swarm` (only `@dogfood-lab/findings`,
 * `@dogfood-lab/report`, and `@dogfood-lab/schemas` are — see
 * packages/dogfood-swarm/package.json), and that package.json is outside
 * this domain's owned globs (packages/dogfood-swarm/{lib/**,db/**,
 * persist-results.js}) — see this agent's output.json for the note. The
 * mirrored checks are deliberately narrow transcriptions of the real
 * validators' own logic (cited by file:line above), not a reinterpretation.
 *
 * A FOURTH check — new in this fix, and stronger than anything steps.js or
 * policy.js enforce today (the finding's own text: steps.js's check is
 * "one-directional... never on verdict==='blocked' requiring at least one
 * blocked/fail step") — is the actual invariant this fix adds:
 * `blockedVerdictHasBlockedStep()`. Without this file, that invariant has
 * no pin anywhere in the suite.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) for the same reason
 * as the sibling F-1f8fd647/F-b721038e files in this directory — the
 * swarm-cp-core wave-16 domain owns `packages/dogfood-swarm/lib/**` only.
 *
 * F-33941cd2 (LOW, wave 24): assertConsistent()'s three local invariants
 * (mirroring steps.js/policy.js) plus this file's own
 * blockedVerdictHasBlockedStep only ever check the 'pass' and 'blocked'
 * verdicts — 'partial' is never checked in either direction, even though the
 * "agents present but incomplete" case below already constructs a
 * 'partial'-verdict submission and passes it to assertConsistent(). This is
 * F-cc198701's class (verdict-enumeration coverage gaps in a hand-rolled
 * mirror of steps.js) reproduced independently in THIS file's own copy of
 * that check, filed by a sibling domain sweeping for stale F-88fb37ff/
 * F-cc198701 pins during an unrelated task and routed here because this file
 * lives inside packages/dogfood-swarm/lib/** — this wave's frozen domain map
 * (not the filing domain's own, narrower test-glob) assigns it to
 * swarm-cp-core; see this domain's output.json for the note on that
 * discrepancy. Verified NOT currently reachable (dogfood-bridge.js's
 * waveVerdict derivation: a 'partial' result requires either an incomplete
 * agent or a failed verification, and either condition guarantees at least
 * one non-'pass' step_result via the SAME status mapping that drives
 * allAgentsPass) — a coverage hole today, not a live defect, but one that
 * would go unnoticed if a future refactor of dogfood-bridge.js decoupled
 * that structural coincidence. `partialVerdictHasNonPassEvidence` below
 * closes it, mirroring `blockedVerdictHasBlockedStep`'s own shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePayload } from '@dogfood-lab/schemas';

import { buildDogfoodSubmission } from './persist/dogfood-bridge.js';

const COMMIT_SHA = 'e'.repeat(40);

function makeExport(wave) {
  return {
    run: {
      id: 'run-blocked-parity', repo: 'dogfood-lab/testing-os', branch: 'main',
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

/**
 * Mirrors packages/verify/validators/steps.js#validateStepResults' pass/
 * blocked structural rule (lines 58-73): "A scenario cannot be 'pass' if
 * any step is 'fail' or 'blocked'." One-directional by design in the real
 * validator — it says nothing about non-'pass' verdicts, which is exactly
 * the gap `blockedVerdictHasBlockedStep` below closes for 'blocked'.
 */
function passVerdictHasNoFailingSteps(scenario) {
  if (scenario.verdict !== 'pass') return true;
  return !scenario.step_results.some(s => s.status === 'fail' || s.status === 'blocked');
}

/**
 * Mirrors packages/verify/validators/policy.js's 'blocked-needs-reason'
 * global reject rule (lines 196-204): a 'blocked' verdict must carry a
 * non-empty blocking_reason.
 */
function blockedVerdictHasReason(scenario) {
  if (scenario.verdict !== 'blocked') return true;
  return typeof scenario.blocking_reason === 'string' && scenario.blocking_reason.length > 0;
}

/**
 * F-8451abe4's OWN invariant — NOT enforced by any validator in
 * packages/verify today (the finding's reachability proof confirms
 * steps.js's check never runs in this direction). A 'blocked' verdict must
 * be backed by at least one step that itself reports 'blocked' (or 'fail'),
 * or the record can claim "blocked, no evidence" while its step_results
 * shows only passing evidence.
 */
function blockedVerdictHasBlockedStep(scenario) {
  if (scenario.verdict !== 'blocked') return true;
  return scenario.step_results.some(s => s.status === 'blocked' || s.status === 'fail');
}

/**
 * F-33941cd2's OWN invariant, mirroring blockedVerdictHasBlockedStep's shape
 * one verdict over: a 'partial' verdict must be backed by at least one
 * step_result that is NOT 'pass'. Derived directly from dogfood-bridge.js's
 * own waveVerdict computation (lines 97-101): 'partial' is only reachable
 * when `!allAgentsPass` (at least one agent's step maps to 'fail'/'blocked',
 * never 'pass') OR `!verifyPass` (the verification step maps to 'fail') —
 * so today this can never actually fire false, but nothing in this file
 * pinned that coupling explicitly before this fix; a future refactor that
 * decoupled step-status derivation from the verdict computation would slip
 * through unnoticed otherwise.
 */
function partialVerdictHasNonPassEvidence(scenario) {
  if (scenario.verdict !== 'partial') return true;
  return scenario.step_results.some(s => s.status !== 'pass');
}

/**
 * Validates the REAL submission object buildDogfoodSubmission returned
 * (not a hand-rolled stand-in) against the actual schema, then runs the
 * four mirrored packages/verify invariants against its first scenario_result.
 */
function assertConsistent(submission, label) {
  const schemaResult = validatePayload('recordSubmission', submission);
  if (!schemaResult.valid) {
    assert.fail(`[${label}] schema validation failed: ${schemaResult.errors.map(e => `${e.path || '/'} ${e.message}`).join('; ')}`);
  }

  const scenario = submission.scenario_results[0];
  assert.ok(passVerdictHasNoFailingSteps(scenario),
    `[${label}] steps.js parity: verdict 'pass' must not carry a fail/blocked step`);
  assert.ok(blockedVerdictHasReason(scenario),
    `[${label}] policy.js parity: verdict 'blocked' must carry a non-empty blocking_reason`);
  assert.ok(blockedVerdictHasBlockedStep(scenario),
    `[${label}] F-8451abe4: verdict 'blocked' must carry at least one blocked/fail step — a 'blocked' record whose only steps are 'pass' is self-contradictory`);
  assert.ok(partialVerdictHasNonPassEvidence(scenario),
    `[${label}] F-33941cd2: verdict 'partial' must carry at least one non-'pass' step — a 'partial' record whose steps are ALL 'pass' is self-contradictory in the same way an all-pass 'blocked' record is`);
}

describe('F-8451abe4 — the synthesized dispatch step and the wave verdict are driven by the same condition', () => {
  it('zero agents + a real verification receipt: blocked verdict now carries the synthesized blocked step ALONGSIDE the passing verification step', () => {
    const exp = makeExport({
      number: 1, phase: 'health-audit-a', agents: [],
      verification: { passed: true, adapter: 'node', test_count: 10 },
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'partial');
    const scenario = submission.scenario_results[0];

    assert.equal(scenario.verdict, 'blocked');

    // Pre-fix: step_results was exactly [{step_id:'verification', status:'pass'}] —
    // one step, and it was 'pass'. Post-fix: the synthesized 'dispatch' step is
    // ALSO present, so the blocked verdict has real cover.
    assert.equal(scenario.step_results.length, 2,
      'the verification step AND the synthesized dispatch/blocked step must both be present');
    const stepIds = scenario.step_results.map(s => s.step_id).sort();
    assert.deepEqual(stepIds, ['dispatch', 'verification']);

    const dispatchStep = scenario.step_results.find(s => s.step_id === 'dispatch');
    assert.equal(dispatchStep.status, 'blocked');
    const verificationStep = scenario.step_results.find(s => s.step_id === 'verification');
    assert.equal(verificationStep.status, 'pass',
      'the real verification evidence is preserved, not discarded — it just no longer stands ALONE under a blocked verdict');

    // The wording must not claim "no evidence to verify" next to a passing step.
    assert.ok(!scenario.blocking_reason.includes('no evidence to verify'),
      'blocking_reason must not contradict the passing verification step_result');
    assert.match(scenario.blocking_reason, /verification receipt/);

    assertConsistent(submission, 'zero-agent+receipt');
  });

  it('zero agents + no verification receipt: blocked verdict carries exactly the one synthesized blocked step (unchanged shape)', () => {
    const exp = makeExport({ number: 2, phase: 'health-audit-a', agents: [], verification: null, violations: [] });
    const submission = buildDogfoodSubmission(exp, 'partial');
    const scenario = submission.scenario_results[0];

    assert.equal(scenario.verdict, 'blocked');
    assert.deepEqual(scenario.step_results.map(s => s.step_id), ['dispatch']);
    assert.equal(scenario.step_results[0].status, 'blocked');
    assert.match(scenario.blocking_reason, /no evidence to verify/);

    assertConsistent(submission, 'zero-agent+no-receipt');
  });

  it('agents present with real steps: pass verdict, no synthesized step, unaffected by the noAgentsDispatched guard', () => {
    const exp = makeExport({
      number: 3, phase: 'health-audit-a',
      agents: [{ domain: 'core', status: 'complete' }],
      verification: { passed: true, adapter: 'node', test_count: 5 },
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'pass');
    const scenario = submission.scenario_results[0];

    assert.equal(scenario.verdict, 'pass');
    const stepIds = scenario.step_results.map(s => s.step_id).sort();
    assert.deepEqual(stepIds, ['agent-core', 'verification'],
      'no synthesized dispatch step when agents were actually dispatched');
    assert.equal(scenario.blocking_reason, undefined);

    assertConsistent(submission, 'agents+steps');
  });

  it('agents present but incomplete: partial verdict, still no synthesized dispatch step (regression guard)', () => {
    const exp = makeExport({
      number: 4, phase: 'health-audit-a',
      agents: [{ domain: 'core', status: 'dispatched' }],
      verification: null,
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'partial');
    const scenario = submission.scenario_results[0];

    assert.equal(scenario.verdict, 'partial');
    assert.deepEqual(scenario.step_results.map(s => s.step_id), ['agent-core']);

    assertConsistent(submission, 'agents+incomplete');
  });

  it('all agents complete but verification FAILED: partial verdict via the OTHER reachability branch (allAgentsPass true, verifyPass false)', () => {
    // F-33941cd2: the prior test reaches 'partial' via an incomplete agent
    // (allAgentsPass false). This reaches it via the DIFFERENT branch —
    // every agent 'complete' (allAgentsPass true) but the verification
    // receipt itself failed (verifyPass false) — varying the axis rather
    // than repeating the same one (PROTOCOL.md: "exercise the shape, not
    // the corpus — state which axes you varied").
    const exp = makeExport({
      number: 5, phase: 'health-audit-a',
      agents: [{ domain: 'core', status: 'complete' }],
      verification: { passed: false, adapter: 'node', test_count: 3 },
      violations: [],
    });
    const submission = buildDogfoodSubmission(exp, 'partial');
    const scenario = submission.scenario_results[0];

    assert.equal(scenario.verdict, 'partial');
    const stepIds = scenario.step_results.map(s => s.step_id).sort();
    assert.deepEqual(stepIds, ['agent-core', 'verification']);
    const verificationStep = scenario.step_results.find(s => s.step_id === 'verification');
    assert.equal(verificationStep.status, 'fail');

    assertConsistent(submission, 'all-agents-complete+verification-failed');
  });
});

/**
 * F-33941cd2 (LOW, wave 24): assertConsistent()'s pass/blocked invariants
 * above never checked 'partial' in either direction, even though this same
 * file already constructs 'partial'-verdict submissions in three of its own
 * test cases. This describe block makes the coupling explicit — a companion
 * regression test, distinct from the mutation-control proof that
 * partialVerdictHasNonPassEvidence can actually fire on a synthetic
 * self-contradictory scenario (the exact "partial + all-pass" shape
 * F-88fb37ff/F-cc198701 named for the sibling steps.js check).
 *
 * No @pins tag: like the F-7d4ac5ce/F-8f735719 precedent elsewhere in this
 * package, this fix is entirely inside a test file's own local mirror of a
 * packages/verify invariant, not a change to dogfood-bridge.js itself — no
 * source-side pin exists for a declared tag to resolve against.
 */
describe('assertConsistent — the partial-verdict invariant is checked, not just the pass/blocked pair (F-33941cd2)', () => {
  it('GATE (mutation control): a synthetic partial-verdict scenario whose steps are ALL pass is caught', () => {
    // Structurally unreachable through the real buildDogfoodSubmission today
    // (see this file's module docstring), but directly constructing the
    // self-contradictory shape proves partialVerdictHasNonPassEvidence — and
    // therefore assertConsistent() — can actually go RED, not just that
    // today's real code happens to never produce it (PROTOCOL.md "Proving a
    // gate": a gate is verified when a meta-test mutates the thing it
    // protects and asserts the gate goes red).
    const selfContradictoryScenario = {
      scenario_id: 'synthetic', scenario_name: 'synthetic', product_surface: 'cli',
      execution_mode: 'bot', verdict: 'partial',
      step_results: [{ step_id: 'agent-core', status: 'pass' }],
    };
    assert.equal(partialVerdictHasNonPassEvidence(selfContradictoryScenario), false,
      'a partial verdict whose only step is pass must be reported as inconsistent');

    // Build a REAL, schema-valid submission via buildDogfoodSubmission (verdict
    // 'pass', one all-pass agent step, no verification receipt) then corrupt
    // ONLY its verdict string to 'partial' — a minimal, targeted mutation of
    // an otherwise-valid object, rather than hand-assembling a submission
    // shape (which would fail schema validation for unrelated reasons and
    // never reach the invariant this test means to exercise).
    const submission = buildDogfoodSubmission(
      makeExport({
        number: 6, phase: 'health-audit-a',
        agents: [{ domain: 'core', status: 'complete' }],
        verification: null, violations: [],
      }),
      'pass',
    );
    const preCorruptionSteps = submission.scenario_results[0].step_results;
    assert.equal(preCorruptionSteps.length, 1, 'sanity: the real submission before corruption has exactly one step');
    assert.equal(preCorruptionSteps[0].step_id, 'agent-core');
    assert.equal(preCorruptionSteps[0].status, 'pass', 'sanity: the one step is pass — no non-pass evidence exists');
    submission.scenario_results[0].verdict = 'partial';

    assert.throws(
      () => assertConsistent(submission, 'synthetic-partial-all-pass'),
      /F-33941cd2/,
      'assertConsistent must reject a partial verdict backed by zero non-pass evidence',
    );
  });

  it('non-regression: a genuinely all-pass scenario with verdict \'pass\' (not \'partial\') is untouched by the new check', () => {
    const passScenario = {
      scenario_id: 'synthetic', scenario_name: 'synthetic', product_surface: 'cli',
      execution_mode: 'bot', verdict: 'pass',
      step_results: [{ step_id: 'agent-core', status: 'pass' }],
    };
    assert.equal(partialVerdictHasNonPassEvidence(passScenario), true,
      'the new check is scoped to verdict === "partial" only — a "pass" verdict is out of its jurisdiction, same as blockedVerdictHasBlockedStep is for "blocked" only');
  });
});
