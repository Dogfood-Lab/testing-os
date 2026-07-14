/**
 * case-file-adjudicate.test.js — the adjudication layer: dispatch a neutral
 * case-file to a family-different jury and fuse the panel into an evidence-not-law
 * verdict.
 *
 * Pins the load-bearing, deterministic logic that sits behind the injected jury
 * boundary (the live prism + Ollama call is the boundary the CLI-verb slice
 * smoke-tests):
 *
 *   - buildJurySpec ENFORCES Lock 1 — the producer family (Anthropic/Claude) can
 *     never sit on the jury — and emits the F-14 config-registry env recipe.
 *   - aggregateCriterion is abstention-aware: a criterion the panel could not
 *     reach quorum on is `insufficient_context` (a brief gap), NOT a fail.
 *   - normalizeAdjudication is EVIDENCE-NOT-LAW: even a unanimous corroborate is
 *     advisory and does not advance a wave alone; only the deterministic floor is
 *     law.
 *   - adjudicate is FAIL-CLOSED: a biasing case-file throws before the jury is
 *     ever called.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CaseFileNeutralityError } from './lib/case-file/handoff.js';
import {
  buildJurySpec,
  aggregateCriterion,
  normalizeAdjudication,
  adjudicate,
  DEFAULT_JURY_SEATS,
  EXCLUDED_FAMILY,
} from './lib/case-file/adjudicate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'case-files');
const loadFixture = rel => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf-8'));

// A minimal neutral jury request (the shape handoff.toJuryRequest emits) for the
// pure-function tests — two criteria, no fixture dependency.
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

const juror = (seat, criteria, out_of_brief = []) => ({ seat, criteria, out_of_brief });

describe('buildJurySpec — Lock 1 + the F-14 cross-family recipe', () => {
  it('the default roster is entirely non-Claude (the only valid verifiers of Claude work)', () => {
    for (const seat of DEFAULT_JURY_SEATS) {
      assert.doesNotMatch(seat.family.toLowerCase(), /anthropic|claude/);
    }
  });

  it('emits the F-14 env recipe wiring gpt-oss as the OpenAI-family seat via Ollama', () => {
    const spec = buildJurySpec(REQ);
    assert.equal(spec.env.PRISM_VERIFIER_MODEL_OPENAI, 'gpt-oss:120b-cloud');
    assert.equal(spec.env.PRISM_OPENAI_BASE_URL, 'http://localhost:11434');
    assert.equal(spec.env.OPENAI_API_KEY, 'ollama');
    assert.equal(spec.excluded_family, EXCLUDED_FAMILY);
    assert.equal(spec.reasoning_stripped, true);
    assert.equal(spec.payload.instruction, 'ABSTAIN-RUBRIC');
    assert.equal(spec.payload.artifact.kind, 'diff');
  });

  it('REFUSES a producer-family seat (Lock 1 — no Claude model judges Claude work)', () => {
    assert.throws(
      () => buildJurySpec(REQ, { seats: [{ family: 'anthropic', model: 'claude-opus' }] }),
      /Lock-1 violation/,
    );
    // ...under any naming — the `claude` alias is caught too.
    assert.throws(
      () => buildJurySpec(REQ, { seats: [{ family: 'claude', model: 'whatever' }] }),
      /Lock-1 violation/,
    );
  });
});

describe('aggregateCriterion — abstention-aware panel fusion', () => {
  it('unanimous pass → pass', () => {
    assert.equal(aggregateCriterion(['pass', 'pass', 'pass']).verdict, 'pass');
  });
  it('unanimous fail → fail', () => {
    assert.equal(aggregateCriterion(['fail', 'fail', 'fail']).verdict, 'fail');
  });
  it('split among deciding jurors → contested', () => {
    assert.equal(aggregateCriterion(['pass', 'fail', 'pass']).verdict, 'contested');
  });
  it('below quorum of deciding jurors → insufficient_context (a brief gap, NOT a fail)', () => {
    // 3 jurors, only 1 decides → quorum ceil(3*0.5)=2 not met.
    const agg = aggregateCriterion(['pass', 'insufficient_context', 'insufficient_context']);
    assert.equal(agg.verdict, 'insufficient_context');
    assert.equal(agg.deciding, 1);
  });
});

describe('normalizeAdjudication — evidence, not law', () => {
  it('all criteria pass → corroborate, but ADVISORY and does not advance a wave alone', () => {
    const panel = [
      juror('openai', { 'AC-1': 'pass', 'AC-2': 'pass' }),
      juror('mistral', { 'AC-1': 'pass', 'AC-2': 'pass' }),
      juror('qwen', { 'AC-1': 'pass', 'AC-2': 'pass' }),
    ];
    const r = normalizeAdjudication(panel, REQ);
    assert.equal(r.overall, 'corroborate');
    assert.equal(r.authority, 'advisory');
    assert.equal(r.law, 'deterministic-floor');
    assert.equal(r.advances_wave_alone, false);
  });

  it('a decided fail on any criterion → overall refute (the strongest signal)', () => {
    const panel = [
      juror('openai', { 'AC-1': 'fail', 'AC-2': 'pass' }),
      juror('mistral', { 'AC-1': 'fail', 'AC-2': 'pass' }),
      juror('qwen', { 'AC-1': 'fail', 'AC-2': 'pass' }),
    ];
    assert.equal(normalizeAdjudication(panel, REQ).overall, 'refute');
  });

  it('a split criterion with no decided fail → overall contested', () => {
    const panel = [
      juror('openai', { 'AC-1': 'pass', 'AC-2': 'pass' }),
      juror('mistral', { 'AC-1': 'fail', 'AC-2': 'pass' }),
      juror('qwen', { 'AC-1': 'pass', 'AC-2': 'pass' }),
    ];
    // AC-1 is pass/fail/pass → contested; AC-2 unanimous pass.
    assert.equal(normalizeAdjudication(panel, REQ).overall, 'contested');
  });

  it('a quorum gap with no fail/contested → overall insufficient_context (fill the brief)', () => {
    const panel = [
      juror('openai', { 'AC-1': 'insufficient_context', 'AC-2': 'pass' }),
      juror('mistral', { 'AC-1': 'insufficient_context', 'AC-2': 'pass' }),
      juror('qwen', { 'AC-1': 'pass', 'AC-2': 'pass' }),
    ];
    assert.equal(normalizeAdjudication(panel, REQ).overall, 'insufficient_context');
  });

  it('an omitted criterion answer is treated as abstention — silence is never a pass', () => {
    const panel = [
      juror('openai', { 'AC-1': 'pass', 'AC-2': 'pass' }),
      juror('mistral', { 'AC-1': 'pass' }), // omits AC-2
      juror('qwen', { 'AC-1': 'pass' }), // omits AC-2
    ];
    const r = normalizeAdjudication(panel, REQ);
    const ac2 = r.criteria.find(c => c.id === 'AC-2');
    // Only 1 of 3 decided AC-2 → below quorum → insufficient_context, so overall too.
    assert.equal(ac2.verdict, 'insufficient_context');
    assert.equal(r.overall, 'insufficient_context');
  });

  it('aggregates out-of-brief findings (the rubric is a floor, not a ceiling)', () => {
    const panel = [
      juror('openai', { 'AC-1': 'pass', 'AC-2': 'pass' }, ['Race condition in retry']),
      juror('mistral', { 'AC-1': 'pass', 'AC-2': 'pass' }, ['race condition in retry', 'stale comment']),
      juror('qwen', { 'AC-1': 'pass', 'AC-2': 'pass' }, []),
    ];
    const r = normalizeAdjudication(panel, REQ);
    assert.equal(r.out_of_brief[0].jurors, 2, 'the finding two jurors raised ranks first');
    assert.match(r.out_of_brief[0].finding, /race condition/i);
    assert.equal(r.overall, 'corroborate', 'out-of-brief findings do not change the criteria verdict');
  });
});

describe('adjudicate — fail-closed end-to-end orchestration', () => {
  it('runs the injected jury on a clean case-file and returns an advisory verdict', async () => {
    let receivedSpec = null;
    const runJury = spec => {
      receivedSpec = spec;
      // one all-pass verdict per seat
      return spec.seats.map(s => ({
        seat: s.family,
        criteria: { 'AC-expired-401': 'pass', 'AC-valid-issues': 'pass' },
        out_of_brief: [],
      }));
    };

    const r = await adjudicate(loadFixture('valid/well-formed-auth-fix.json'), { runJury });

    assert.equal(r.overall, 'corroborate');
    assert.equal(r.authority, 'advisory');
    assert.equal(r.advances_wave_alone, false);
    // the jury boundary received the F-14 spec, not raw files
    assert.equal(receivedSpec.env.PRISM_VERIFIER_MODEL_OPENAI, 'gpt-oss:120b-cloud');
    assert.equal(receivedSpec.payload.artifact.ref, 'packages/auth/refresh.js@a1b2c3d');
  });

  it('REFUSES a biasing case-file BEFORE the jury is ever called (fail-closed)', async () => {
    let juryCalled = false;
    const runJury = () => { juryCalled = true; return []; };

    await assert.rejects(
      () => adjudicate(loadFixture('lint/verdict-leak-in-criterion.json'), { runJury }),
      CaseFileNeutralityError,
    );
    assert.equal(juryCalled, false, 'the jury must never see a case-file that failed the neutrality gate');
  });

  it('requires a runJury boundary', async () => {
    await assert.rejects(
      () => adjudicate(loadFixture('valid/well-formed-auth-fix.json'), {}),
      /requires a runJury boundary/,
    );
  });
});
