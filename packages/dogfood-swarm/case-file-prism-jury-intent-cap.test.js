/**
 * case-file-prism-jury-intent-cap.test.js — F-ca495e53: buildCriterionIntent
 * enforces prism's 4000-char MAX_INTENT_CHARS ceiling on every OPTIONAL
 * section (evidence, out-of-scope) but never measured the MANDATORY one
 * (objective + the criterion under test). An over-cap head returned
 * `intent: head` — still over the cap — while reporting
 * `omitted: {evidence:0, out_of_scope:0}`, affirmatively claiming nothing was
 * dropped, when in fact the whole request was doomed: prism's own
 * pydantic max_length=4000 rejects it, every seat abstains uniformly, and the
 * operator is told the jury could not reach the artifact (Director
 * disposition) when the real cause is a deterministic, locally-detectable
 * input error.
 *
 * New standalone file rather than an addition to the existing
 * case-file-prism-jury.test.js: that file is concurrently owned and edited by
 * swarm-cp-tests in a parallel worktree for a different finding — see
 * case-file-prism-jury-seat-env.test.js's header for the full reasoning.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCriterionIntent, MAX_INTENT_CHARS } from './lib/case-file/prism-jury.js';
import { normalizeAdjudication } from './lib/case-file/adjudicate.js';
import { CriterionIntentOverflowError } from './lib/errors.js';

const BASE_PAYLOAD = {
  rubric: { objective: 'x', acceptance_criteria: [{ id: 'AC-1', check: 'x' }] },
};

describe('buildCriterionIntent — the mandatory head is measured before the budget is spent (F-ca495e53)', () => {
  it('throws a structured error when the MANDATORY head alone exceeds the intent cap', () => {
    const oversized = { ...BASE_PAYLOAD, rubric: { ...BASE_PAYLOAD.rubric, objective: 'x'.repeat(MAX_INTENT_CHARS) } };
    assert.throws(
      () => buildCriterionIntent(BASE_PAYLOAD.rubric.acceptance_criteria[0], oversized),
      (err) => {
        assert.ok(err instanceof CriterionIntentOverflowError);
        assert.equal(err.code, 'CRITERION_INTENT_OVERFLOW');
        assert.equal(err.criterionId, 'AC-1');
        assert.ok(err.headLength > MAX_INTENT_CHARS, 'headLength must reflect the actual overflow, not a fixed value');
        assert.match(err.message, /AC-1/, 'the offending criterion is named, not just "too long"');
        assert.match(err.message, new RegExp(String(MAX_INTENT_CHARS)), 'the cap itself is named');
        return true;
      },
    );
  });

  it('an oversized criterion.check (not just objective) also overflows the head and throws', () => {
    const oversized = {
      ...BASE_PAYLOAD,
      rubric: { ...BASE_PAYLOAD.rubric, acceptance_criteria: [{ id: 'AC-2', check: 'y'.repeat(MAX_INTENT_CHARS) }] },
    };
    assert.throws(
      () => buildCriterionIntent(oversized.rubric.acceptance_criteria[0], oversized),
      CriterionIntentOverflowError,
    );
  });

  // Deletion-shaped proof that the guard is load-bearing rather than
  // decorative: an objective sized exactly AT the cap boundary must NOT
  // throw — this is "reject only overflow", not "reject anything long". No
  // evidence/out-of-scope in the payload, so intent === head exactly,
  // isolating the boundary from the (separately covered) body-truncation
  // logic.
  it('does not throw when the head is exactly at the cap boundary', () => {
    const criterion = { id: 'AC-1', check: 'x' };
    const bare = { rubric: { objective: '', out_of_scope: undefined }, evidence: undefined };
    const probe = buildCriterionIntent(criterion, bare);
    const headroom = MAX_INTENT_CHARS - probe.intent.length;
    assert.ok(headroom >= 0, 'sanity: an empty-objective head must already fit');

    const exact = { rubric: { objective: 'x'.repeat(headroom), out_of_scope: undefined }, evidence: undefined };
    const result = buildCriterionIntent(criterion, exact);
    assert.equal(result.intent.length, MAX_INTENT_CHARS, 'the constructed head lands exactly on the cap');
    assert.doesNotThrow(() => buildCriterionIntent(criterion, exact));
  });

  it('one char past the boundary throws', () => {
    const criterion = { id: 'AC-1', check: 'x' };
    const bare = { rubric: { objective: '', out_of_scope: undefined }, evidence: undefined };
    const probe = buildCriterionIntent(criterion, bare);
    const headroom = MAX_INTENT_CHARS - probe.intent.length;

    const overByOne = { rubric: { objective: 'x'.repeat(headroom + 1), out_of_scope: undefined }, evidence: undefined };
    assert.throws(() => buildCriterionIntent(criterion, overByOne), CriterionIntentOverflowError);
  });

  it('a normal-sized head still assembles evidence/out-of-scope normally (no regression)', () => {
    const payload = {
      rubric: { objective: 'the endpoint rejects an expired token', acceptance_criteria: [{ id: 'AC-1', check: 'returns 401' }], out_of_scope: ['rate limiting'] },
      evidence: [{ claim: 'isExpired compares exp to now', source: 'from-code' }],
    };
    const { intent, omitted } = buildCriterionIntent(payload.rubric.acceptance_criteria[0], payload);
    assert.match(intent, /AC-1/);
    assert.match(intent, /isExpired compares exp to now/);
    assert.deepEqual(omitted, { evidence: 0, out_of_scope: 0 });
  });
});

/**
 * The scrutiny floor must outrank the evidence pack (sm-oos-001).
 *
 * Assembly was priority-ordered head -> evidence -> out_of_scope, so the
 * out-of-scope block was built LAST and was therefore the FIRST thing the
 * 4000-char cap sacrificed. Measured against the REAL wave-2 case-file (15
 * evidence claims / 6 out_of_scope / 10 criteria): every criterion delivered
 * 9/15 evidence and **0/6 out_of_scope** — the floor was dropped 10 times out
 * of 10, 100% of the time.
 *
 * out_of_scope is the list of things the jury must NOT flag — the contract
 * calls it "a floor on scrutiny, not a ceiling". So the tier reliably discarded
 * the one field that prevents false failures, and the panel then flagged
 * out-of-brief concerns as criterion failures. Two tiers on the identical
 * case-file, which is the evidence that this was OUR assembly order and not the
 * models:
 *
 *   local tier (no cap): 15/15 evidence, 6/6 oos -> pass 2 / fail 0 / insuf 4
 *   prism tier (4000):    9/15 evidence, 0/6 oos -> pass 1 / fail 2-3 / insuf 0-2
 *
 * THE FIXTURE MUST FORCE A TRIM OR THESE TESTS CANNOT FAIL — a small brief
 * delivers everything either way, which is the same vacuous shape as the
 * "an em-dash survives" draft that passed against a broken shim. The evidence
 * pack below is ~22k chars against a 4000 cap, so a trim is guaranteed.
 */
describe('buildCriterionIntent — out_of_scope is mandatory; evidence yields to the cap', () => {
  const OUT_OF_SCOPE = [
    'rate limiting', 'CORS preflight', 'logging verbosity',
    'metric naming', 'retry backoff', 'cache TTL',
  ];
  /** ~22k chars of evidence against a 4000-char cap — a trim is unavoidable. */
  const FAT = {
    rubric: {
      objective: 'the endpoint rejects an expired token',
      acceptance_criteria: [{ id: 'AC-1', check: 'returns 401 on expiry' }],
      out_of_scope: OUT_OF_SCOPE,
    },
    evidence: Array.from({ length: 200 }, (_, i) => ({
      claim: `claim ${i} ${'x'.repeat(100)}`, source: 'from-code',
    })),
  };
  const CRITERION = FAT.rubric.acceptance_criteria[0];

  it('delivers EVERY out_of_scope entry even when the evidence pack blows the cap', () => {
    const { intent, omitted } = buildCriterionIntent(CRITERION, FAT);
    assert.ok(intent.length <= MAX_INTENT_CHARS, `intent ${intent.length} exceeds ${MAX_INTENT_CHARS}`);
    for (const entry of OUT_OF_SCOPE) {
      assert.ok(intent.includes(entry), `out_of_scope entry "${entry}" must survive the trim`);
    }
    assert.equal(omitted.out_of_scope, 0, 'the scrutiny floor must never be omitted');
  });

  it('drops EVIDENCE instead, and reports how much', () => {
    const { omitted } = buildCriterionIntent(CRITERION, FAT);
    assert.ok(omitted.evidence > 0, 'evidence is what must yield to the cap');
    assert.equal(omitted.out_of_scope, 0);
  });

  it('still fits the cap with the floor reserved (the floor is not bought by overflowing)', () => {
    const { intent } = buildCriterionIntent(CRITERION, FAT);
    assert.ok(intent.length <= MAX_INTENT_CHARS);
    assert.match(intent, /OUT OF SCOPE \(do not flag\)/);
  });

  // POSITIVE CONTROL — a brief that fits must still deliver everything, in the
  // documented order (head -> evidence -> out_of_scope). Reserving the floor's
  // budget first must not reorder the emitted intent.
  it('a brief that fits delivers everything, in the documented order', () => {
    const small = {
      rubric: {
        objective: 'the endpoint rejects an expired token',
        acceptance_criteria: [{ id: 'AC-1', check: 'returns 401 on expiry' }],
        out_of_scope: ['rate limiting'],
      },
      evidence: [{ claim: 'isExpired compares exp to now', source: 'from-code', ref: 'expiry.js:12' }],
    };
    const { intent, omitted } = buildCriterionIntent(small.rubric.acceptance_criteria[0], small);
    assert.deepEqual(omitted, { evidence: 0, out_of_scope: 0 });
    const iHead = intent.indexOf('OBJECTIVE:');
    const iEvidence = intent.indexOf('EVIDENCE (grounding facts');
    const iOos = intent.indexOf('OUT OF SCOPE (do not flag)');
    assert.ok(iHead >= 0 && iEvidence > iHead && iOos > iEvidence,
      `documented order must hold: head(${iHead}) < evidence(${iEvidence}) < out_of_scope(${iOos})`);
  });

  it('an out_of_scope pack that cannot fit alongside the head is a structured overflow, not a silent drop', () => {
    // Widens F-ca495e53's guard: the mandatory section is now head +
    // out_of_scope, so an unfittable FLOOR must fail fast at the boundary
    // rather than emit a brief that reads complete while missing it.
    const oversized = {
      rubric: {
        objective: 'x',
        acceptance_criteria: [{ id: 'AC-1', check: 'y' }],
        out_of_scope: ['z'.repeat(MAX_INTENT_CHARS)],
      },
      evidence: [],
    };
    assert.throws(
      () => buildCriterionIntent(oversized.rubric.acceptance_criteria[0], oversized),
      (err) => {
        assert.equal(err.code, 'CRITERION_INTENT_OVERFLOW');
        assert.equal(err.criterionId, 'AC-1');
        return true;
      },
    );
  });

  it('handles a case-file with no out_of_scope at all', () => {
    const bare = {
      rubric: { objective: 'o', acceptance_criteria: [{ id: 'AC-1', check: 'c' }], out_of_scope: undefined },
      evidence: [],
    };
    const { intent, omitted } = buildCriterionIntent(bare.rubric.acceptance_criteria[0], bare);
    assert.doesNotMatch(intent, /OUT OF SCOPE/);
    assert.deepEqual(omitted, { evidence: 0, out_of_scope: 0 });
  });
});


/**
 * The omission record must reach the RECEIPT, not just the console.
 *
 * makePrismJury already attached `omitted` to each seat's per-criterion detail,
 * and the trim printed a warning to the operator's terminal — but
 * normalizeAdjudication dropped the whole `prism` block when fusing, so the
 * signed receipt (`swarms/<run>/adjudications/wave-N-<hash>.json`) carried no
 * record of it at all. Checked against the real wave-2 receipt: `omitted` does
 * not appear, and neither does `prism`.
 *
 * A signed receipt that attests a verdict while omitting the single fact most
 * likely to undermine it makes the contract's honest-boundary claim — "anything
 * that does not fit is REPORTED, not silently dropped" — true only for whoever
 * happened to be watching the terminal at the time. The receipt is the durable
 * artifact; that is where "REPORTED" has to land.
 */
describe('normalizeAdjudication — the brief-completeness record reaches the receipt', () => {
  const REQUEST = {
    rubric: {
      objective: 'o',
      acceptance_criteria: [{ id: 'AC-1', check: 'c1' }, { id: 'AC-2', check: 'c2' }],
    },
  };

  /** A prism-tier juror: carries per-criterion detail including `omitted`. */
  function prismJuror(seat, answers, omissions) {
    return {
      seat,
      criteria: answers,
      out_of_brief: [],
      prism: {
        tier: 'prism-per-seat',
        criteria: Object.entries(omissions).map(([criterion, omitted]) => ({ criterion, omitted })),
      },
    };
  }

  it('records per-criterion omissions on the fused result', () => {
    const jurors = [
      prismJuror('mistral', { 'AC-1': 'pass', 'AC-2': 'pass' },
        { 'AC-1': { evidence: 10, out_of_scope: 0 }, 'AC-2': { evidence: 6, out_of_scope: 0 } }),
      prismJuror('qwen', { 'AC-1': 'pass', 'AC-2': 'pass' },
        { 'AC-1': { evidence: 10, out_of_scope: 0 }, 'AC-2': { evidence: 6, out_of_scope: 0 } }),
    ];
    const result = normalizeAdjudication(jurors, REQUEST);
    const ac1 = result.criteria.find(c => c.id === 'AC-1');
    const ac2 = result.criteria.find(c => c.id === 'AC-2');
    assert.deepEqual(ac1.brief_omitted, { evidence: 10, out_of_scope: 0 });
    assert.deepEqual(ac2.brief_omitted, { evidence: 6, out_of_scope: 0 });
  });

  it('records a ZERO omission explicitly, so "nothing dropped" is distinguishable from "not recorded"', () => {
    const jurors = [prismJuror('mistral', { 'AC-1': 'pass', 'AC-2': 'pass' },
      { 'AC-1': { evidence: 0, out_of_scope: 0 }, 'AC-2': { evidence: 0, out_of_scope: 0 } })];
    const result = normalizeAdjudication(jurors, REQUEST);
    assert.deepEqual(result.criteria.find(c => c.id === 'AC-1').brief_omitted, { evidence: 0, out_of_scope: 0 });
  });

  it('reports the WORST omission across seats rather than the first', () => {
    // Seat-independent in practice (buildCriterionIntent is a pure function of
    // criterion+payload), but a receipt must not under-report if that ever
    // stops being true — e.g. a future per-seat budget.
    const jurors = [
      prismJuror('mistral', { 'AC-1': 'pass', 'AC-2': 'pass' },
        { 'AC-1': { evidence: 2, out_of_scope: 0 }, 'AC-2': { evidence: 0, out_of_scope: 0 } }),
      prismJuror('qwen', { 'AC-1': 'pass', 'AC-2': 'pass' },
        { 'AC-1': { evidence: 9, out_of_scope: 1 }, 'AC-2': { evidence: 0, out_of_scope: 0 } }),
    ];
    const result = normalizeAdjudication(jurors, REQUEST);
    assert.deepEqual(result.criteria.find(c => c.id === 'AC-1').brief_omitted, { evidence: 9, out_of_scope: 1 });
  });

  it('omits the record entirely for a tier that does not trim (the local jury)', () => {
    // POSITIVE CONTROL — absence must mean "this tier delivers the whole brief",
    // not "we forgot to look". The local tier has no cap and no prism block.
    const jurors = [
      { seat: 'mistral', criteria: { 'AC-1': 'pass', 'AC-2': 'pass' }, out_of_brief: [] },
      { seat: 'qwen', criteria: { 'AC-1': 'pass', 'AC-2': 'pass' }, out_of_brief: [] },
    ];
    const result = normalizeAdjudication(jurors, REQUEST);
    for (const c of result.criteria) {
      assert.equal('brief_omitted' in c, false, 'an untrimmed tier must record no omission');
    }
  });

  it('does not disturb the existing fused shape', () => {
    const jurors = [prismJuror('mistral', { 'AC-1': 'pass', 'AC-2': 'fail' },
      { 'AC-1': { evidence: 1, out_of_scope: 0 }, 'AC-2': { evidence: 1, out_of_scope: 0 } })];
    const result = normalizeAdjudication(jurors, REQUEST);
    assert.equal(result.authority, 'advisory');
    assert.equal(result.law, 'deterministic-floor');
    assert.equal(result.advances_wave_alone, false);
    assert.equal(result.panel_size, 1);
    assert.ok(result.criteria.every(c => c.id && c.verdict));
  });
});

/**
 * Per-criterion evidence budgeting (sm-oos-003).
 *
 * The clerk's `context[]` is GLOBAL: all 15 claims were assembled into all 10
 * criteria, and most are irrelevant to any given one — `AC-yaml-merge-inert`
 * does not need the seat-env allowlist's evidence. The 4000-char cap then
 * discarded two thirds indiscriminately. Receipt from run 4 (the real one,
 * adjudications/wave-2-85bf3172.json) records the damage precisely:
 * `brief_omitted: {"evidence":10,"out_of_scope":0}` on every criterion — the
 * floor restored, and STILL 10 of 15 claims dropped, with all 10 criteria
 * landing `contested`. Restoring out_of_scope did not fix the failures; the
 * starvation is the cause.
 *
 * `context[].criterion_ids?: string[]` scopes a claim:
 *   absent  -> global; grounds every criterion (backward-compatible default)
 *   present -> grounds ONLY the listed criteria
 *
 * THE FIXTURE MUST FORCE A TRIM OR THESE TESTS CANNOT PROVE ANYTHING — a
 * fixture too small to overflow the cap would pass this suite whether or not
 * per-criterion scoping is even implemented, the same vacuous shape as the
 * "an em-dash survives" draft. This test originally proved that with the
 * LITERAL wave-2 case-file, read from a hardcoded absolute path
 * (`E:/AI/testing-os/swarms/swarm-1784091637-5127/wave-2/case-file.json`).
 * That was itself a defect (F-4a7309f9 / F-2a8f4d17): the path is this
 * swarm's own ephemeral output — every `swarm-` prefixed run directory under
 * swarms/ is gitignored (swarms/.gitignore:6) — so it resolves on no machine
 * but the one that produced it, and worse, a describe()-body throw on a
 * missing file is swallowed by node:test as a silent per-suite skip
 * (`# fail` stays 0, exit code 0), not a build break. The five tests below
 * covering this fix could vanish on every other clone or CI runner with
 * `npm test` still reporting green.
 *
 * CASE_FILE below is a COMMITTED, PORTABLE STAND-IN, not the real wave-2
 * file — same shape (10 criteria / 15 context claims / 6 out_of_scope
 * entries) and calibrated to the same budget proportions, verified by
 * running it through the real buildCriterionIntent:
 *
 *   head (objective + criterion + boilerplate)   1360 chars  (real: ~1322)
 *   out_of_scope floor                            1119 chars  (real: ~1093)
 *   ------------------------------------------------------
 *   mandatory before any evidence                 2479  (real: ~2415)
 *   left for evidence                             1521  (real: ~1585)
 *
 * Scoped to 4 claims/criterion (below), every one of the 10 criteria fits
 * with ~209 chars to spare (intent length 3789-3791 of the 4000 cap) and
 * ZERO omission; offering a criterion a 5th claim already omits one — the
 * same "roughly five is the ceiling" shape the original incident measured.
 * Sent GLOBALLY instead (the backward-compat test below, reproducing the
 * pre-fix behavior on the IDENTICAL claim pool), the cap omits 11 of 15 for
 * the first criterion. That contrast — scoped: 0 omitted, unscoped: 11
 * omitted, off the same claims — is the deletion-proof: revert the
 * criterion_ids scoping and this suite goes red, not green.
 *
 * The criterion_ids are assigned here deterministically (round-robin, 4
 * criteria per claim) rather than by editorial judgement about which claim
 * grounds which criterion: the property under test is "every claim tagged
 * for a criterion reaches it", and that property must hold regardless of who
 * did the tagging.
 */
describe('buildCriterionIntent — per-criterion evidence budgeting', () => {
  /**
   * Deterministic filler sized to an exact target length — same idiom as the
   * FAT fixture above (`'x'.repeat(100)`), just shaped like prose so a reader
   * skimming a failure diff sees claim-shaped text instead of a wall of x's.
   * The seed sits at position 0, so every generated string is unique from its
   * first few characters — that uniqueness is what lets
   * `intent.includes(e.claim)` (below) tell "this exact claim survived the
   * trim" apart from "some other claim that merely shares filler text did".
   */
  function sizedText(seed, targetLength) {
    const phrase = `${seed} grounding fact spanning the referenced module and its adjacent call sites in the diff under test, cross-checked against the suite. `;
    let out = '';
    while (out.length < targetLength) out += phrase;
    return out.slice(0, targetLength);
  }

  const N_CRITERIA = 10;
  const N_CONTEXT = 15;
  const N_OUT_OF_SCOPE = 6;

  const CASE_FILE = {
    objective: sizedText('objective', 1050),
    artifact_under_test: {
      kind: 'diff',
      ref: 'packages/example/module.js@synthetic',
      content: '(synthetic fixture — buildCriterionIntent never reads payload.artifact)',
    },
    acceptance_criteria: Array.from({ length: N_CRITERIA }, (_, i) => ({
      id: `AC-${i + 1}`,
      check: sizedText(`criterion ${i + 1}`, 150),
    })),
    out_of_scope: Array.from({ length: N_OUT_OF_SCOPE }, (_, i) => sizedText(`out-of-scope item ${i + 1}`, 180)),
    context: Array.from({ length: N_CONTEXT }, (_, i) => ({
      claim: sizedText(`claim ${i}`, 300),
      source: i % 2 === 0 ? 'from-tests' : 'from-code',
    })),
  };

  /**
   * CASE_FILE with each CRITERION scoped to 4 claims — the "3–4 relevant
   * claims" shape real budgeting produces. Built criterion-major on purpose:
   * a claim-major round-robin skews (some criteria would draw far more claims
   * than others) and would overrun a budget that is tighter than it looks.
   * See the block docstring above for the measured numbers this relies on.
   */
  function scopedPayload() {
    const ids = CASE_FILE.acceptance_criteria.map(c => c.id);
    const claimsFor = new Map(
      ids.map((id, j) => [id, [0, 1, 2, 3].map(k => (j * 3 + k) % CASE_FILE.context.length)]),
    );
    return {
      artifact: CASE_FILE.artifact_under_test,
      rubric: {
        objective: CASE_FILE.objective,
        acceptance_criteria: CASE_FILE.acceptance_criteria,
        out_of_scope: CASE_FILE.out_of_scope,
      },
      evidence: CASE_FILE.context.map((c, i) => ({
        claim: c.claim,
        source: c.source,
        ...(c.ref ? { ref: c.ref } : {}),
        criterion_ids: ids.filter(id => claimsFor.get(id).includes(i)),
      })),
    };
  }

  it('delivers EVERY relevant claim for each criterion, omitting none (the live starvation)', () => {
    const payload = scopedPayload();
    for (const c of CASE_FILE.acceptance_criteria) {
      const { intent, omitted } = buildCriterionIntent(c, payload);
      const relevant = payload.evidence.filter(e => e.criterion_ids.includes(c.id));
      assert.ok(relevant.length > 0, `fixture sanity: ${c.id} must have relevant claims`);
      assert.equal(
        omitted.evidence, 0,
        `${c.id}: every relevant claim must fit once irrelevant ones are not sent (was 10/15 dropped)`,
      );
      for (const e of relevant) {
        assert.ok(intent.includes(e.claim), `${c.id} must carry its relevant claim: ${e.claim.slice(0, 40)}…`);
      }
      assert.ok(intent.length <= MAX_INTENT_CHARS, `${c.id}: intent ${intent.length} over cap`);
    }
  });

  it('does NOT send a criterion the claims scoped to other criteria', () => {
    const payload = scopedPayload();
    const c = CASE_FILE.acceptance_criteria[0];
    const { intent } = buildCriterionIntent(c, payload);
    const irrelevant = payload.evidence.filter(e => !e.criterion_ids.includes(c.id));
    assert.ok(irrelevant.length > 0, 'fixture sanity: some claims must be out of scope for this criterion');
    for (const e of irrelevant) {
      assert.ok(!intent.includes(e.claim), `${c.id} must not carry an unscoped claim`);
    }
  });

  // ANTI-VACUITY — the counter must not lie in the other direction. A claim
  // filtered out as IRRELEVANT was never owed to this criterion, so counting it
  // as an omission would make brief_omitted over-report and turn the receipt
  // back into noise.
  it('omitted.evidence counts only RELEVANT-and-dropped claims, never irrelevant-filtered ones', () => {
    const payload = {
      rubric: {
        objective: 'o',
        acceptance_criteria: [{ id: 'AC-1', check: 'c1' }, { id: 'AC-2', check: 'c2' }],
        out_of_scope: [],
      },
      evidence: [
        { claim: 'relevant and small', source: 'from-code', criterion_ids: ['AC-1'] },
        { claim: 'x'.repeat(500), source: 'from-code', criterion_ids: ['AC-2'] },
        { claim: 'y'.repeat(500), source: 'from-code', criterion_ids: ['AC-2'] },
      ],
      artifact: {},
    };
    const { intent, omitted } = buildCriterionIntent(payload.rubric.acceptance_criteria[0], payload);
    assert.match(intent, /relevant and small/);
    assert.equal(omitted.evidence, 0, 'two AC-2 claims were filtered as irrelevant — not omissions');
  });

  // BACKWARD-COMPAT CONTROL — every existing case-file, and
  // fixtures/case-files/valid/well-formed-auth-fix.json, has no criterion_ids
  // and must behave EXACTLY as before: all claims global.
  it('a case-file with NO criterion_ids behaves exactly as today (all claims global)', () => {
    const payload = {
      artifact: CASE_FILE.artifact_under_test,
      rubric: {
        objective: CASE_FILE.objective,
        acceptance_criteria: CASE_FILE.acceptance_criteria,
        out_of_scope: CASE_FILE.out_of_scope,
      },
      evidence: CASE_FILE.context.map(c => ({ claim: c.claim, source: c.source, ...(c.ref ? { ref: c.ref } : {}) })),
    };
    const c = CASE_FILE.acceptance_criteria[0];
    const { intent, omitted } = buildCriterionIntent(c, payload);
    // Unscoped => all 15 compete for the budget => the documented trim still bites.
    assert.ok(omitted.evidence > 0, 'global claims must still be trimmed against the cap');
    assert.ok(intent.length <= MAX_INTENT_CHARS);
    assert.equal(omitted.out_of_scope, 0, 'the floor stays mandatory regardless');
  });

  it('a mixed pack (some scoped, some global) sends the global ones to every criterion', () => {
    const payload = {
      rubric: {
        objective: 'o',
        acceptance_criteria: [{ id: 'AC-1', check: 'c1' }, { id: 'AC-2', check: 'c2' }],
        out_of_scope: [],
      },
      evidence: [
        { claim: 'global claim', source: 'from-code' },
        { claim: 'scoped to two', source: 'from-code', criterion_ids: ['AC-2'] },
      ],
      artifact: {},
    };
    const { intent } = buildCriterionIntent(payload.rubric.acceptance_criteria[0], payload);
    assert.match(intent, /global claim/, 'an untagged claim grounds every criterion');
    assert.doesNotMatch(intent, /scoped to two/);
  });
});
