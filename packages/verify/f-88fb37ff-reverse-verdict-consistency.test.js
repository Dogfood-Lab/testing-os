/**
 * F-88fb37ff: the verdict/step_results consistency check in validateStepResults
 * and its sibling validateRequiredSteps enforced consistency in only ONE
 * direction — a scenario could not be "pass" while a step reported fail/blocked
 * (the security-critical direction, correctly closed), but nothing checked the
 * reverse: a scenario claiming "fail" or "blocked" while EVERY step reported
 * "pass" sailed through both validators with zero errors. computeVerdict()
 * (validators/verdict.js) never re-derives a scenario's verdict from its
 * step_results either — it trusts scenario_results[].verdict verbatim — so the
 * mismatch was never cross-checked anywhere in the pipeline.
 *
 * PROVEN END-TO-END pre-fix: cloning pilot-0-submission.json, setting
 * scenario_results[0].verdict='blocked' (with a blocking_reason, so the
 * separate 'blocked-needs-reason' policy rule does not fire) while leaving all
 * 7 of its step_results at status:'pass' unchanged, run through the real,
 * unmutated verify() with stubProvenance and the real global+repo policy,
 * yielded verification.status:'accepted' with rejection_reasons:[] — a
 * self-contradictory record (claims blocked, evidence shows every step passed)
 * published exactly as submitted. Identical result for verdict:'fail'.
 *
 * Fix: mirror the existing pass-direction check in both validators — a
 * fail/blocked verdict now requires at least one step reporting fail/blocked
 * status (validateStepResults: among ALL reported steps; validateRequiredSteps:
 * among the scenario's REQUIRED steps that are actually PRESENT — a MISSING
 * required step is already caught unconditionally by the sibling
 * [step-results-present] check regardless of verdict, so it is deliberately
 * excluded from "evidence of failure" here to avoid piling a second,
 * verdict-specific error onto the exact same gap). Originally scoped to
 * fail/blocked only; wave 22 (F-cc198701) widened the same check to "partial" —
 * a partial claim backed by zero non-pass step evidence is the same
 * self-contradiction shape, and leaving it unchecked was a free
 * verdict-inflation path. Partial WITH non-pass evidence stays accepted, and
 * the existing pass-direction check is not weakened.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify } from './index.js';
import { validateStepResults, validateRequiredSteps } from './validators/steps.js';
import { stubProvenance } from './validators/provenance.js';

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

function baseOptions() {
  return { globalPolicy, repoPolicy, provenance: stubProvenance, policyVersion: '1.0.0' };
}

describe('F-88fb37ff: real verify() pipeline rejects a self-contradictory blocked/fail verdict', () => {
  it('REJECTS verdict="blocked" with a valid blocking_reason when every step reports "pass" (the exact proven repro)', async () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].verdict = 'blocked';
    bad.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';
    // All 7 step_results are left at status:'pass' — unchanged from pilot0.

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected',
      `pre-fix bug: a self-contradictory blocked verdict with all-pass steps was accepted; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
    // pilot0 is otherwise policy/schema/provenance-clean (see "passes for valid
    // pilot-0 submission" in verify.test.js), so mutating ONLY the verdict must
    // produce EXACTLY one new reason — the reverse-consistency check.
    assert.equal(record.verification.rejection_reasons.length, 1,
      `expected exactly one rejection reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`);
    assert.ok(
      record.verification.rejection_reasons.some(r =>
        r.includes('steps[record-ingest-roundtrip]') &&
        r.includes('verdict is "blocked"') &&
        r.includes('no step reports')
      ),
      `expected a steps[...] reverse-consistency reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
    // overall_verdict.verified is sealed by F-a0a4d806 (non-empty rejection
    // reasons force a fail floor). This finding stays scoped to
    // validateStepResults/validateRequiredSteps reverse-consistency.
  });

  it('REJECTS verdict="fail" when every step reports "pass" (same gap, other verdict value)', async () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].verdict = 'fail';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected',
      `pre-fix bug: a self-contradictory fail verdict with all-pass steps was accepted; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
    assert.ok(
      record.verification.rejection_reasons.some(r =>
        r.includes('verdict is "fail"') && r.includes('no step reports')
      ),
      `expected a reverse-consistency reason, got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('CONTROL: a genuinely blocked scenario (one step actually blocked) is still accepted', async () => {
    const good = structuredClone(pilot0);
    good.scenario_results[0].verdict = 'blocked';
    good.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';
    good.scenario_results[0].step_results[0].status = 'blocked';

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `a blocked verdict WITH backing step evidence must not be rejected; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('CONTROL: a genuinely failed scenario (one step actually failed) is still accepted for verdict="fail"', async () => {
    const good = structuredClone(pilot0);
    good.scenario_results[0].verdict = 'fail';
    good.scenario_results[0].step_results[0].status = 'fail';

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `a fail verdict WITH backing step evidence must not be rejected; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('REGRESSION: the pre-existing pass-direction control still rejects a pass verdict with a failing step', async () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].step_results[0].status = 'fail';
    // verdict stays 'pass'

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('have status fail/blocked')),
      `expected the EXISTING pass-direction reason to still fire; got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('REGRESSION: an unmutated pilot-0 submission (verdict="pass", all steps pass) is still accepted', async () => {
    const record = await verify(structuredClone(pilot0), baseOptions());
    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  // Remaining cells of the {pass,fail,blocked} x {all-pass,some-fail,some-blocked}
  // matrix, run against the REAL pipeline (the cells above already cover
  // blocked x all-pass, fail x all-pass, blocked x some-blocked, fail x
  // some-fail, pass x some-fail, pass x all-pass). These three prove fail/
  // blocked are treated as ONE evidentiary class at the full-pipeline level,
  // not just in the unit-level matrix below.

  it('MATRIX: pass verdict with a some-blocked step is rejected (forward direction, blocked variant)', async () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].step_results[0].status = 'blocked';
    // verdict stays 'pass'

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('have status fail/blocked')),
      `got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('MATRIX: blocked verdict with a some-fail (not some-blocked) step is accepted', async () => {
    const good = structuredClone(pilot0);
    good.scenario_results[0].verdict = 'blocked';
    good.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';
    good.scenario_results[0].step_results[0].status = 'fail'; // fail, not blocked

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `a "fail"-status step must satisfy a "blocked" verdict's evidence requirement; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('MATRIX: fail verdict with a some-blocked (not some-fail) step is accepted', async () => {
    const good = structuredClone(pilot0);
    good.scenario_results[0].verdict = 'fail';
    good.scenario_results[0].step_results[0].status = 'blocked'; // blocked, not fail

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `a "blocked"-status step must satisfy a "fail" verdict's evidence requirement; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });
});

describe('F-88fb37ff: validateStepResults — verdict x step-evidence matrix (unit level)', () => {
  function scenario(verdict, statuses) {
    return {
      scenario_id: 'matrix',
      verdict,
      step_results: statuses.map((status, i) => ({ step_id: `s${i}`, status }))
    };
  }

  it('blocked + all-pass -> new reverse-consistency error', () => {
    const errors = validateStepResults(scenario('blocked', ['pass', 'pass']));
    assert.ok(errors.some(e => e.includes('verdict is "blocked" but no step reports')),
      `got: ${JSON.stringify(errors)}`);
  });

  it('fail + all-pass -> new reverse-consistency error', () => {
    const errors = validateStepResults(scenario('fail', ['pass', 'pass']));
    assert.ok(errors.some(e => e.includes('verdict is "fail" but no step reports')),
      `got: ${JSON.stringify(errors)}`);
  });

  it('blocked + some-blocked -> no reverse-consistency error', () => {
    const errors = validateStepResults(scenario('blocked', ['pass', 'blocked']));
    assert.ok(!errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
  });

  it('blocked + some-fail -> no reverse-consistency error (fail/blocked are one evidentiary class)', () => {
    const errors = validateStepResults(scenario('blocked', ['pass', 'fail']));
    assert.ok(!errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
  });

  it('fail + some-blocked -> no reverse-consistency error', () => {
    const errors = validateStepResults(scenario('fail', ['pass', 'blocked']));
    assert.ok(!errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
  });

  it('pass + all-pass -> clean (happy path unaffected)', () => {
    const errors = validateStepResults(scenario('pass', ['pass', 'pass']));
    assert.deepEqual(errors, []);
  });

  it('pass + some-fail -> the EXISTING forward error still fires, unweakened', () => {
    const errors = validateStepResults(scenario('pass', ['pass', 'fail']));
    assert.ok(errors.some(e => e.includes('have status fail/blocked')), `got: ${JSON.stringify(errors)}`);
  });

  // Wave 22 (F-cc198701) brought 'partial' INTO scope: the reverse-consistency
  // check now covers all three non-pass verdicts. The two cases below pinned the
  // pre-wave-22 behavior under "out of scope" titles; the scope has arrived.
  it('partial + all-pass -> reverse-consistency error (in scope since F-cc198701, wave 22)', () => {
    const errors = validateStepResults(scenario('partial', ['pass', 'pass']));
    assert.ok(
      errors.some(e => e.includes('scenario verdict is "partial"')),
      `partial backed by zero non-pass evidence must be rejected; got: ${JSON.stringify(errors)}`
    );
  });

  it('partial + all-fail -> accepted (deliberately preserved by F-cc198701: non-pass evidence supports a partial claim)', () => {
    const errors = validateStepResults(scenario('partial', ['fail', 'fail']));
    assert.deepEqual(errors, []);
  });
});

describe('F-88fb37ff: validateRequiredSteps — reverse direction scoped to REQUIRED steps', () => {
  it('blocked verdict, every required step present and passing -> new [step-verdict-consistent] error', () => {
    const sr = {
      verdict: 'blocked',
      step_results: [{ step_id: 'a', status: 'pass' }, { step_id: 'b', status: 'pass' }]
    };
    const errors = validateRequiredSteps(sr, ['a', 'b']);
    assert.ok(
      errors.some(e =>
        e.startsWith('[step-verdict-consistent]') &&
        e.includes('verdict is "blocked"') &&
        e.includes('no required step')
      ),
      `got: ${JSON.stringify(errors)}`
    );
  });

  it('blocked verdict, one required step actually blocked -> no new error', () => {
    const sr = {
      verdict: 'blocked',
      step_results: [{ step_id: 'a', status: 'pass' }, { step_id: 'b', status: 'blocked' }]
    };
    const errors = validateRequiredSteps(sr, ['a', 'b']);
    assert.ok(!errors.some(e => e.includes('no required step')), `got: ${JSON.stringify(errors)}`);
  });

  it('REGRESSION: fail verdict with ONE required step missing (F-3bfc2885 fixture shape) still reports exactly the ONE [step-results-present] error, not a duplicate', () => {
    // Pinned byte-for-byte from f-3bfc2885-required-steps-wiring.test.js's
    // "tags missing required steps with [step-results-present]" — a missing
    // required step is already unconditionally rejected there; this fix must
    // not pile a second, verdict-specific error onto the exact same gap.
    const sr = { verdict: 'fail', step_results: [{ step_id: 'a', status: 'pass' }] };
    const errors = validateRequiredSteps(sr, ['a', 'b']);
    assert.equal(errors.length, 1, `got: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /^\[step-results-present\] required step "b"/);
  });

  it('pass verdict is unaffected by the reverse-direction addition (existing behavior)', () => {
    const sr = { verdict: 'pass', step_results: [{ step_id: 'a', status: 'pass' }] };
    const errors = validateRequiredSteps(sr, ['a']);
    assert.deepEqual(errors, []);
  });
});
