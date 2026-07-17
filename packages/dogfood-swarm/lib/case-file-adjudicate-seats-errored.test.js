/**
 * case-file-adjudicate-seats-errored.test.js — F-993df146: normalizeAdjudication
 * silently discarded every juror's typed `error` string before it reached the
 * durable receipt, so a jury that abstained because its own infrastructure was
 * down (Ollama offline, an unpulled model, prism's subprocess unreachable) was
 * indistinguishable, in every artifact an operator can inspect after the fact,
 * from a jury that genuinely reviewed the case and found insufficient context.
 *
 * Both jury tiers already capture this at the source:
 *   - ollama-jury.js's makeOllamaJury sets a WHOLE-JUROR `error` string when a
 *     seat dies (network failure, HTTP error, ...) — every criterion for that
 *     seat is then forced to insufficient_context.
 *   - prism-jury.js's makePrismJury sets a PER-CRITERION `error` inside
 *     `prism.criteria[]` (VERIFIER_UNAVAILABLE / BUDGET_EXCEEDED /
 *     LENS_COLLAPSE / an unparseable response) — a seat can fail on ONE
 *     criterion and answer normally on another.
 *
 * normalizeAdjudication is the ONE place both shapes converge before
 * commands/adjudicate.js serializes the result verbatim into the receipt — the
 * only artifact holding per-criterion detail (the adjudications DB row is a
 * summary with no criteria column, by design — see db/schema.js's v9 comment).
 *
 * This file pins the fix: per-criterion `errors` (mirroring how `brief_omitted`
 * is already aggregated, sparse — absent, not `[]`, when nobody errored) plus a
 * panel-level `seats_errored` flag readable without walking every criterion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAdjudication } from './case-file/adjudicate.js';

const REQ = {
  artifact: { kind: 'diff', ref: 'src/x.js@1' },
  rubric: {
    objective: 'the widget renders without throwing',
    acceptance_criteria: [
      { id: 'AC-1', check: 'render() returns an element' },
      { id: 'AC-2', check: 'render() does not throw on empty props' },
    ],
    out_of_scope: [],
  },
  evidence: [],
  abstention: 'ABSTAIN-RUBRIC',
  neutrality: { verdict_free: true, gated_by: 'case-file-lint' },
};

// A dead ollama seat: whole-juror `.error`, every criterion forced to
// insufficient_context (mirrors ollama-jury.js's makeOllamaJury catch branch).
const deadOllamaSeat = {
  seat: 'hermes',
  model: 'hermes3:8b',
  criteria: { 'AC-1': 'insufficient_context', 'AC-2': 'insufficient_context' },
  out_of_brief: [],
  error: 'ECONNREFUSED 127.0.0.1:11434',
};

// A prism seat with a PER-CRITERION error on AC-1 only, a normal pass on AC-2
// (mirrors prism-jury.js's makePrismJury per-(seat x criterion) detail shape).
const prismSeatWithCriterionError = {
  seat: 'mistral',
  model: 'mistral-small:24b',
  criteria: { 'AC-1': 'insufficient_context', 'AC-2': 'pass' },
  out_of_brief: [],
  prism: {
    tier: 'prism-per-seat',
    prism_family: 'local',
    criteria: [
      { criterion: 'AC-1', answer: 'insufficient_context', verdict: null, confidence: null, rho_max: null, lenses: 0, findings: [], error: 'VERIFIER_UNAVAILABLE: connection refused', omitted: { evidence: 0, out_of_scope: 0 } },
      { criterion: 'AC-2', answer: 'pass', verdict: 'accept', confidence: 0.9, rho_max: 0.1, lenses: 4, findings: [], error: null, omitted: { evidence: 0, out_of_scope: 0 } },
    ],
  },
};

// A fully healthy seat — no errors anywhere, both criteria genuinely judged.
const healthySeat = {
  seat: 'qwen',
  model: 'qwen2.5:7b',
  criteria: { 'AC-1': 'pass', 'AC-2': 'pass' },
  out_of_brief: [],
};

describe('normalizeAdjudication — WHY insufficient_context, not just THAT (F-993df146)', () => {
  /** @pins F-993df146 */
  it('threads a whole-juror error onto EVERY criterion that juror was asked to judge, plus panel-level seats_errored', () => {
    const result = normalizeAdjudication([deadOllamaSeat, healthySeat], REQ);
    const ac1 = result.criteria.find(c => c.id === 'AC-1');
    const ac2 = result.criteria.find(c => c.id === 'AC-2');

    assert.deepEqual(ac1.errors, [{ seat: 'hermes', error: 'ECONNREFUSED 127.0.0.1:11434' }]);
    assert.deepEqual(ac2.errors, [{ seat: 'hermes', error: 'ECONNREFUSED 127.0.0.1:11434' }],
      'hermes abstained on AC-2 too (whole seat is dead) — its error must be attributed there as well');
    assert.deepEqual(result.seats_errored, [{ seat: 'hermes', error: 'ECONNREFUSED 127.0.0.1:11434' }]);
  });

  it('threads a per-criterion prism error onto ONLY the criterion it failed, never a criterion the same seat answered normally', () => {
    const result = normalizeAdjudication([prismSeatWithCriterionError, healthySeat], REQ);
    const ac1 = result.criteria.find(c => c.id === 'AC-1');
    const ac2 = result.criteria.find(c => c.id === 'AC-2');

    assert.deepEqual(ac1.errors, [{ seat: 'mistral', error: 'VERIFIER_UNAVAILABLE: connection refused' }]);
    assert.equal(ac2.errors, undefined,
      'mistral answered AC-2 normally (verdict accept) — no error should be attributed there');
    // A per-criterion prism error is NOT a whole-juror error: the juror object
    // itself carries no top-level `.error`, so it must not inflate the
    // panel-level seats_errored flag (that flag means "this seat never ran AT
    // ALL", not "this seat had a rough patch on one criterion").
    assert.deepEqual(result.seats_errored, []);
  });

  it('both shapes together: per-criterion errors accumulate across jurors, sorted by nothing in particular but complete', () => {
    const result = normalizeAdjudication(
      [deadOllamaSeat, prismSeatWithCriterionError, healthySeat],
      REQ,
    );
    const ac1 = result.criteria.find(c => c.id === 'AC-1');
    assert.equal(ac1.errors.length, 2);
    assert.ok(ac1.errors.some(e => e.seat === 'hermes'));
    assert.ok(ac1.errors.some(e => e.seat === 'mistral'));
    assert.deepEqual(result.seats_errored, [{ seat: 'hermes', error: 'ECONNREFUSED 127.0.0.1:11434' }]);
  });

  it('GATE (negative control): a fully healthy panel has NO errors field on any criterion and an EMPTY seats_errored', () => {
    // Proves the mechanism actually discriminates — without this control, a
    // helper that always attached an `errors` array (even empty) would make
    // the positive assertions above meaningless as evidence of a REAL signal.
    const result = normalizeAdjudication([healthySeat, { ...healthySeat, seat: 'granite', model: 'granite4.1:30b' }], REQ);
    for (const cr of result.criteria) {
      assert.equal(cr.errors, undefined, `criterion ${cr.id} must have no errors field when nobody errored`);
    }
    assert.deepEqual(result.seats_errored, []);
  });
});
