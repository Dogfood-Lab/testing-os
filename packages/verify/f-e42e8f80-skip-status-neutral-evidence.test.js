/**
 * F-e42e8f80 (wave 20, amends F-88fb37ff): the reverse-verdict-consistency
 * check F-88fb37ff added (validateStepResults / validateRequiredSteps) closed
 * the exact "all-pass" shape it was filed against, but the mirror condition
 * — "at least one step actively reports fail/blocked" — conflated two
 * semantically different step statuses this same file's own VALID_STATUSES
 * set (steps.js line ~33) treats as first-class: 'pass' (an ACTIVE
 * CONTRADICTION of a fail/blocked verdict — the step ran and claimed
 * success) and 'skip'/'partial' (NEUTRAL — no evidence either way, exactly
 * what a step that never ran because the scenario was blocked upstream
 * should honestly report).
 *
 * PROVEN END-TO-END pre-fix: cloning pilot-0-submission.json, setting
 * scenario_results[0].verdict='blocked' (with a blocking_reason) or 'fail',
 * and every one of its 7 step_results to status:'skip' — a fully
 * schema-valid, HONEST submission (the scenario was blocked before any step
 * could execute, so nothing ran) — run through the real, unmutated verify()
 * with stubProvenance and the real global+repo policy, yielded
 * verification.status:'rejected' with a "no step reports status fail/blocked"
 * reason. Before wave 18 this shape was correctly accepted; wave 18's fix
 * wrongly started rejecting it. Identical result for 'partial' and for a
 * mixed shape (one step 'pass', the rest 'skip').
 *
 * Fix: the gate now fires only when EVERY reported (or, for
 * validateRequiredSteps, every PRESENT required) step actively says "pass" —
 * a single skip/partial/fail/blocked step is enough to keep a fail/blocked
 * verdict internally consistent. The existing 25 f-88fb37ff-pinned assertions
 * are unaffected: every one of them exercises only pass+fail or pass+blocked
 * combinations, and "not all pass" and "at least one fail/blocked" agree on
 * every shape that mixes ONLY 'pass' with 'fail'/'blocked' — they diverge
 * only on 'skip'/'partial', which the wave-18 suite never exercised (that gap
 * is exactly this finding).
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

function allStepsTo(record, status) {
  const clone = structuredClone(record);
  for (const step of clone.scenario_results[0].step_results) step.status = status;
  return clone;
}

/** @pins F-e42e8f80 */
describe('F-e42e8f80: real verify() pipeline accepts an honest blocked/fail verdict whose steps never ran', () => {
  it('ACCEPTS verdict="blocked" with all 7 steps "skip" (the exact proven repro — steps never ran)', async () => {
    const good = allStepsTo(pilot0, 'skip');
    good.scenario_results[0].verdict = 'blocked';
    good.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `an honestly-reported blocked verdict with all-skip steps must be accepted; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('ACCEPTS verdict="fail" with all 7 steps "skip"', async () => {
    const bad = allStepsTo(pilot0, 'skip');
    bad.scenario_results[0].verdict = 'fail';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('ACCEPTS verdict="blocked" with all 7 steps "partial"', async () => {
    const good = allStepsTo(pilot0, 'partial');
    good.scenario_results[0].verdict = 'blocked';
    good.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('ACCEPTS verdict="fail" with all 7 steps "partial"', async () => {
    const bad = allStepsTo(pilot0, 'partial');
    bad.scenario_results[0].verdict = 'fail';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('ACCEPTS verdict="blocked" with a mixed shape (first step "pass", the rest "skip") — "partial"/"skip" do not launder a contradiction, they are just not one either', async () => {
    const good = allStepsTo(pilot0, 'skip');
    good.scenario_results[0].step_results[0].status = 'pass';
    good.scenario_results[0].verdict = 'blocked';
    good.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';

    const record = await verify(good, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('ACCEPTS verdict="fail" with a mixed shape (first step "pass", the rest "skip")', async () => {
    const bad = allStepsTo(pilot0, 'skip');
    bad.scenario_results[0].step_results[0].status = 'pass';
    bad.scenario_results[0].verdict = 'fail';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });

  it('REGRESSION: still REJECTS verdict="blocked" with every step actively "pass" (the original F-88fb37ff repro is unweakened)', async () => {
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].verdict = 'blocked';
    bad.scenario_results[0].blocking_reason = 'Server failed to start on port 4321';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected',
      `an all-pass blocked verdict must still be rejected; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('no step reports')),
      `got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  it('REGRESSION: an unmutated pilot-0 submission (verdict="pass", all steps pass) is still accepted', async () => {
    const record = await verify(structuredClone(pilot0), baseOptions());
    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
  });
});

describe('F-e42e8f80: validateStepResults — {fail,blocked,partial} x {all-skip, all-partial, mixed-skip-and-pass} matrix (unit level)', () => {
  function scenario(verdict, statuses) {
    return {
      scenario_id: 'matrix',
      verdict,
      step_results: statuses.map((status, i) => ({ step_id: `s${i}`, status }))
    };
  }

  // F-cc198701 (wave 22): 'partial' added to this matrix — it is the third of
  // scenario_results[].verdict's four legal enum values this loop now covers
  // (only 'pass' — the OPPOSITE direction, checked separately above at line
  // ~59 — remains outside this loop's scope). Pre-fix, 'partial' was never a
  // member of this array at all, so the "unweakened" case below silently
  // exercised zero coverage for it; now every row below runs for 'partial'
  // exactly as it does for 'blocked'/'fail'.
  for (const verdict of ['blocked', 'fail', 'partial']) {
    it(`${verdict} + all-skip -> no reverse-consistency error (steps never ran)`, () => {
      const errors = validateStepResults(scenario(verdict, ['skip', 'skip']));
      assert.ok(!errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
    });

    it(`${verdict} + all-partial -> no reverse-consistency error`, () => {
      const errors = validateStepResults(scenario(verdict, ['partial', 'partial']));
      assert.ok(!errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
    });

    it(`${verdict} + mixed (pass, skip) -> no reverse-consistency error`, () => {
      const errors = validateStepResults(scenario(verdict, ['pass', 'skip']));
      assert.ok(!errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
    });

    it(`${verdict} + all-pass -> reverse-consistency error still fires (unweakened)`, () => {
      const errors = validateStepResults(scenario(verdict, ['pass', 'pass']));
      assert.ok(errors.some(e => e.includes('no step reports')), `got: ${JSON.stringify(errors)}`);
    });
  }
});

describe('F-e42e8f80: validateRequiredSteps — same matrix, scoped to REQUIRED steps', () => {
  // F-cc198701 (wave 22): same widening as the validateStepResults matrix
  // above — validateRequiredSteps enumerated only 'fail'/'blocked' too.
  for (const verdict of ['blocked', 'fail', 'partial']) {
    it(`${verdict} + every required step present as "skip" -> no [step-verdict-consistent] error`, () => {
      const sr = {
        verdict,
        step_results: [{ step_id: 'a', status: 'skip' }, { step_id: 'b', status: 'skip' }]
      };
      const errors = validateRequiredSteps(sr, ['a', 'b']);
      assert.ok(!errors.some(e => e.includes('no required step')), `got: ${JSON.stringify(errors)}`);
    });

    it(`${verdict} + every required step present as "partial" -> no [step-verdict-consistent] error`, () => {
      const sr = {
        verdict,
        step_results: [{ step_id: 'a', status: 'partial' }, { step_id: 'b', status: 'partial' }]
      };
      const errors = validateRequiredSteps(sr, ['a', 'b']);
      assert.ok(!errors.some(e => e.includes('no required step')), `got: ${JSON.stringify(errors)}`);
    });

    it(`${verdict} + required steps mixed (pass, skip) -> no [step-verdict-consistent] error`, () => {
      const sr = {
        verdict,
        step_results: [{ step_id: 'a', status: 'pass' }, { step_id: 'b', status: 'skip' }]
      };
      const errors = validateRequiredSteps(sr, ['a', 'b']);
      assert.ok(!errors.some(e => e.includes('no required step')), `got: ${JSON.stringify(errors)}`);
    });

    it(`${verdict} + every required step present and actively "pass" -> [step-verdict-consistent] error still fires (unweakened)`, () => {
      const sr = {
        verdict,
        step_results: [{ step_id: 'a', status: 'pass' }, { step_id: 'b', status: 'pass' }]
      };
      const errors = validateRequiredSteps(sr, ['a', 'b']);
      assert.ok(errors.some(e => e.includes('no required step')), `got: ${JSON.stringify(errors)}`);
    });
  }

  it('REGRESSION: a MISSING required step still reports exactly the ONE [step-results-present] error, not a duplicate (F-88fb37ff fixture shape, byte-pinned)', () => {
    const sr = { verdict: 'fail', step_results: [{ step_id: 'a', status: 'skip' }] };
    const errors = validateRequiredSteps(sr, ['a', 'b']);
    assert.equal(errors.length, 1, `got: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /^\[step-results-present\] required step "b"/);
  });
});

/**
 * F-cc198701 (wave 22, confirming audit of F-e42e8f80/F-88fb37ff):
 * 'partial' is a fully legal, first-class scenario verdict
 * (dogfood-record-submission.schema.json line ~164, the identical enum
 * `["pass","fail","blocked","partial"]` backs both scenario_results[].verdict
 * and overall_verdict) that neither the fail/blocked-direction check above
 * nor the pass-direction check at line ~59 ever enumerated. The two tests
 * below run the REAL, unmutated verify() pipeline end-to-end (same harness as
 * the F-e42e8f80 describe block above: cloned pilot-0, stubProvenance, real
 * global+repo policy) to prove the exact shape this finding's audit proved
 * live, and the exact shape that must NOT change as a result of closing it.
 */
describe('F-cc198701: real verify() pipeline — "partial" backed by zero non-pass evidence is now caught (steps.js)', () => {
  /** @pins F-cc198701 */
  it('REJECTS verdict="partial" with every step actively "pass" (zero corroborating evidence — the exact gap this fix closes)', async () => {
    // Pre-fix: verdict==='partial' never entered the fail/blocked-direction
    // branch at all, so this self-contradictory shape (a verdict claiming
    // something less than full success, backed by SEVEN steps that all
    // actively claim success) sailed through with rejection_reasons=[] —
    // the identical vacuity the F-88fb37ff/F-e42e8f80 lineage already closed
    // for 'blocked'/'fail', just for the one enum value neither ever checked.
    const bad = structuredClone(pilot0);
    bad.scenario_results[0].verdict = 'partial';
    bad.overall_verdict = 'partial';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected',
      `an all-pass "partial" verdict must now be rejected as self-contradictory; reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('no step reports')),
      `got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });

  /** @pins F-cc198701 */
  it('REGRESSION GUARD: still ACCEPTS verdict="partial" with every step actively "fail" — not inherently contradictory, unweakened by this fix', async () => {
    // This is the finding's own PROVEN END-TO-END reproduction shape
    // (verdict:'partial', all 7 steps 'fail') — and its outcome is
    // DELIBERATELY UNCHANGED by this fix: 'partial' backed by non-pass step
    // evidence (even all-fail) is not the self-contradictory shape steps.js
    // guards against — reusing the identical "all present steps actively
    // pass" bar means only a TOTAL ABSENCE of corroborating evidence (every
    // step says pass) is now caught. The corrective signal for THIS
    // (accepted-but-suspicious) shape comes from the derivation layer instead
    // — see rules.js's rule-partial-scenario-evidence, tested in
    // packages/findings/derive/derive.test.js.
    const record = await verify(
      (() => {
        const s = structuredClone(pilot0);
        s.scenario_results[0].verdict = 'partial';
        for (const step of s.scenario_results[0].step_results) step.status = 'fail';
        s.overall_verdict = 'partial';
        return s;
      })(),
      baseOptions()
    );

    assert.equal(record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(record.verification.rejection_reasons)}`);
    assert.deepEqual(record.verification.rejection_reasons, []);
    assert.equal(record.overall_verdict.proposed, 'partial');
    assert.equal(record.overall_verdict.verified, 'partial');
    assert.equal(record.overall_verdict.downgraded, false);
  });

  /** @pins F-cc198701 */
  it('sanity: the SAME all-fail evidence with verdict="pass" instead of "partial" is still REJECTED by the pre-existing, untouched pass-direction check', async () => {
    // Confirms this fix did not touch line ~59's pass-direction check —
    // the exact asymmetry the finding's own audit used to prove 'partial'
    // was completely unchecked pre-fix.
    const bad = structuredClone(pilot0);
    for (const step of bad.scenario_results[0].step_results) step.status = 'fail';
    bad.scenario_results[0].verdict = 'pass';
    bad.overall_verdict = 'pass';

    const record = await verify(bad, baseOptions());

    assert.equal(record.verification.status, 'rejected');
    assert.ok(
      record.verification.rejection_reasons.some(r => r.includes('scenario verdict is "pass" but steps')),
      `got: ${JSON.stringify(record.verification.rejection_reasons)}`
    );
  });
});
