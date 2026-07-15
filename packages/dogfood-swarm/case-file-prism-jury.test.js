/**
 * case-file-prism-jury.test.js — the pure, CI-safe pieces of the prism-per-seat jury
 * boundary: env isolation, criterion-intent assembly, verdict mapping, and response
 * parsing, plus the seat-major panel loop over a MOCK prism.
 *
 * The live subprocess (a real `python prism_seat.py`) is exercised by the manual
 * on-rig smoke (scripts/case-file-prism-smoke.mjs), never here — CI has neither prism
 * nor Ollama. What IS pinned here is everything that decides WHICH model judges, WHAT
 * it is asked, and HOW its answer becomes swarm data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRISM_JURY_SEATS,
  PRISM_CLOUD_SEATS,
  PRISM_VERDICT_TO_ANSWER,
  MAX_PRISM_LATENCY_MS,
  MAX_INTENT_CHARS,
  SCRUBBED_ENV_KEYS,
  buildSeatEnv,
  buildCriterionIntent,
  buildPrismRequest,
  mapVerdictToAnswer,
  parsePrismVerdict,
  makePrismJury,
} from './lib/case-file/prism-jury.js';

const PAYLOAD = {
  artifact: { kind: 'diff', ref: 'src/x.js@1', content: 'GUARD_CODE_HERE' },
  rubric: {
    objective: 'the endpoint rejects an expired token',
    acceptance_criteria: [
      { id: 'AC-1', check: 'returns 401 on expiry' },
      { id: 'AC-2', check: 'issues on a valid token' },
    ],
    out_of_scope: ['rate limiting'],
  },
  evidence: [{ claim: 'isExpired compares exp to now', source: 'from-code', ref: 'expiry.js:12' }],
  instruction: 'ABSTAIN-INSTRUCTION-TEXT',
};

const SPEC = { seats: PRISM_JURY_SEATS, payload: PAYLOAD };

/** A prism VerifyResponse, trimmed to the fields the parser reads. */
function prismResponse(verdict, { rho = { 'a,b': 0.1, 'a,c': 0.2 }, findings = [] } = {}) {
  return JSON.stringify({
    verdict,
    confidence: 0.9,
    retryable: false,
    lens_results: [
      { lens: 'contract_completeness', outcome: 'pass', findings },
      { lens: 'cross_boundary', outcome: 'pass', findings: [] },
      { lens: 'invariant', outcome: 'pass', findings: [] },
      { lens: 'groundedness', outcome: 'pass', findings: [] },
    ],
    pairwise_rho: rho,
    receipt: { id: 'prism-test', alg: 'Ed25519' },
  });
}

describe('buildSeatEnv — nothing ambient survives into a seat', () => {
  it('pins the seat model into its prism family slot', () => {
    const env = buildSeatEnv({ family: 'qwen', model: 'qwen2.5:7b', prism_family: 'local' }, {});
    assert.equal(env.PRISM_VERIFIER_MODEL_LOCAL, 'qwen2.5:7b');
  });

  it('scrubs ambient provider keys that would hijack the route or spend money', () => {
    const base = {
      GOOGLE_API_KEY: 'real-google-key',
      OPENAI_API_KEY: 'real-openai-key',
      ANTHROPIC_API_KEY: 'real-anthropic-key',
      OPENROUTER_API_KEY: 'real-openrouter-key',
      PATH: '/usr/bin',
    };
    const env = buildSeatEnv({ family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' }, base);
    for (const k of SCRUBBED_ENV_KEYS) assert.equal(env[k], undefined, `${k} must not survive`);
    assert.equal(env.PATH, '/usr/bin', 'unrelated env is preserved');
  });

  it('scrubs the specialist endpoints that would be PREPENDED ahead of the seat', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b' },
      { PRISM_LOCAL_VERIFIER_ENDPOINT: 'http://x', PRISM_SYCOPHANCY_ENDPOINT: 'http://y' },
    );
    assert.equal(env.PRISM_LOCAL_VERIFIER_ENDPOINT, undefined);
    assert.equal(env.PRISM_SYCOPHANCY_ENDPOINT, undefined);
  });

  it('drops a previous seatic pin so it cannot leak into the next seat', () => {
    const env = buildSeatEnv(
      { family: 'qwen', model: 'qwen2.5:7b', prism_family: 'local' },
      { PRISM_VERIFIER_MODEL_LOCAL: 'mistral-small:24b', PRISM_VERIFIER_MODEL_OPENAI: 'stale' },
    );
    assert.equal(env.PRISM_VERIFIER_MODEL_LOCAL, 'qwen2.5:7b');
    assert.equal(env.PRISM_VERIFIER_MODEL_OPENAI, undefined);
  });

  it('wires the cloud seat through the Ollama OpenAI-compatible endpoint (F-14)', () => {
    const seat = { family: 'openai', model: 'gpt-oss:120b-cloud', prism_family: 'openai', base_url: 'http://localhost:11434' };
    const env = buildSeatEnv(seat, {});
    assert.equal(env.PRISM_VERIFIER_MODEL_OPENAI, 'gpt-oss:120b-cloud');
    assert.equal(env.OPENAI_API_KEY, 'ollama');
    assert.equal(env.PRISM_OPENAI_BASE_URL, 'http://localhost:11434');
  });

  it('does not set an OpenAI key for a local seat (free by default)', () => {
    const env = buildSeatEnv({ family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' }, {});
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  it('ignores undefined values rather than passing "undefined" strings to the child', () => {
    const env = buildSeatEnv({ family: 'qwen', model: 'qwen2.5:7b' }, { NOPE: undefined });
    assert.ok(!('NOPE' in env));
  });
});

describe('buildCriterionIntent — one criterion is the intent', () => {
  it('names exactly the criterion under test and scopes out the others', () => {
    const { intent } = buildCriterionIntent(PAYLOAD.rubric.acceptance_criteria[0], PAYLOAD);
    assert.match(intent, /AC-1/);
    assert.match(intent, /returns 401 on expiry/);
    assert.match(intent, /the endpoint rejects an expired token/);
    assert.doesNotMatch(intent, /issues on a valid token/, 'the other criterion must not leak in');
  });

  it('includes provenance-tagged evidence and the out-of-scope floor', () => {
    const { intent, omitted } = buildCriterionIntent(PAYLOAD.rubric.acceptance_criteria[0], PAYLOAD);
    assert.match(intent, /\[from-code\] isExpired compares exp to now \(expiry\.js:12\)/);
    assert.match(intent, /OUT OF SCOPE \(do not flag\): rate limiting/);
    assert.deepEqual(omitted, { evidence: 0, out_of_scope: 0 });
  });

  it('stays within prism’s intent cap and REPORTS what it dropped', () => {
    const fat = {
      ...PAYLOAD,
      evidence: Array.from({ length: 200 }, (_, i) => ({ claim: `claim ${i} ${'x'.repeat(100)}`, source: 'from-code' })),
    };
    const { intent, omitted } = buildCriterionIntent(PAYLOAD.rubric.acceptance_criteria[0], fat);
    assert.ok(intent.length <= MAX_INTENT_CHARS, `intent ${intent.length} exceeds ${MAX_INTENT_CHARS}`);
    assert.ok(omitted.evidence > 0, 'dropped evidence must be reported, never silent');
    assert.match(intent, /AC-1/, 'the criterion survives truncation');
  });

  it('handles a case-file with no evidence or out-of-scope', () => {
    const bare = { ...PAYLOAD, evidence: undefined, rubric: { ...PAYLOAD.rubric, out_of_scope: undefined } };
    const { intent, omitted } = buildCriterionIntent(PAYLOAD.rubric.acceptance_criteria[0], bare);
    assert.match(intent, /AC-1/);
    assert.deepEqual(omitted, { evidence: 0, out_of_scope: 0 });
  });
});

describe('buildPrismRequest', () => {
  it('declares the PRODUCER family as the caller so prism excludes it (L1)', () => {
    const { request } = buildPrismRequest(PAYLOAD.rubric.acceptance_criteria[0], PAYLOAD);
    assert.equal(request.caller_family, 'anthropic');
    assert.match(request.caller_model, /claude/);
  });

  it('carries the artifact content', () => {
    const { request } = buildPrismRequest(PAYLOAD.rubric.acceptance_criteria[0], PAYLOAD);
    assert.equal(request.content, 'GUARD_CODE_HERE');
  });

  it('substitutes an explicit absence for empty artifact content', () => {
    const { request } = buildPrismRequest(
      PAYLOAD.rubric.acceptance_criteria[0],
      { ...PAYLOAD, artifact: { kind: 'diff', ref: 'x' } },
    );
    assert.match(request.content, /no inline content/);
  });

  it('clamps the budget to prism’s hard 30s ceiling', () => {
    const { request } = buildPrismRequest(PAYLOAD.rubric.acceptance_criteria[0], PAYLOAD, { maxLatencyMs: 999_000 });
    assert.equal(request.max_latency_ms, MAX_PRISM_LATENCY_MS);
  });
});

describe('mapVerdictToAnswer — the pinned verdict mapping', () => {
  it('pins the four prism verdicts', () => {
    assert.deepEqual(PRISM_VERDICT_TO_ANSWER, {
      accept: 'pass',
      refuse: 'fail',
      revise: 'fail',
      escalate: 'insufficient_context',
    });
  });

  it('maps revise to fail (the intent IS the criterion, so fixable = unmet)', () => {
    assert.equal(mapVerdictToAnswer('revise'), 'fail');
  });

  it('maps escalate to abstention, not a fail', () => {
    assert.equal(mapVerdictToAnswer('escalate'), 'insufficient_context');
  });

  it('abstains on an unknown or missing verdict', () => {
    assert.equal(mapVerdictToAnswer('maybe'), 'insufficient_context');
    assert.equal(mapVerdictToAnswer(undefined), 'insufficient_context');
  });
});

describe('parsePrismVerdict — garbage and refusals never mint a pass', () => {
  it('parses an accept into a pass and surfaces the L3/L4 signals', () => {
    const r = parsePrismVerdict(prismResponse('accept'));
    assert.equal(r.answer, 'pass');
    assert.equal(r.verdict, 'accept');
    assert.equal(r.lenses, 4);
    assert.equal(r.rho_max, 0.2);
    assert.equal(r.error, null);
  });

  it('parses a refuse into a fail', () => {
    assert.equal(parsePrismVerdict(prismResponse('refuse')).answer, 'fail');
  });

  it('abstains on a prism refusal and keeps the reason', () => {
    const r = parsePrismVerdict('{"error":{"reason":"BUDGET_EXCEEDED","detail":"Lens fan-out exceeded"}}');
    assert.equal(r.answer, 'insufficient_context');
    assert.match(r.error, /BUDGET_EXCEEDED/);
  });

  it('abstains on LENS_COLLAPSE — L4 firing means no independent signal', () => {
    const r = parsePrismVerdict('{"error":{"reason":"LENS_COLLAPSE","detail":"rho above threshold"}}');
    assert.equal(r.answer, 'insufficient_context');
    assert.match(r.error, /LENS_COLLAPSE/);
  });

  it('abstains on non-JSON garbage', () => {
    const r = parsePrismVerdict('Traceback (most recent call last): ...');
    assert.equal(r.answer, 'insufficient_context');
    assert.match(r.error, /unparseable/);
  });

  it('abstains on empty output', () => {
    assert.equal(parsePrismVerdict('').answer, 'insufficient_context');
  });

  it('extracts the JSON span from surrounding noise', () => {
    const r = parsePrismVerdict(`warning: something\n${prismResponse('accept')}\n`);
    assert.equal(r.answer, 'pass');
  });

  it('collects lens findings for the receipt', () => {
    const r = parsePrismVerdict(prismResponse('refuse', { findings: [{ category: 'guard', evidence: 'no expiry check', severity: 'major' }] }));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].category, 'guard');
  });

  it('reports rho_max as null when prism returned no pairs', () => {
    assert.equal(parsePrismVerdict(prismResponse('accept', { rho: {} })).rho_max, null);
  });
});

describe('makePrismJury — the seat-major panel loop', () => {
  it('returns one verdict per seat, keyed by every criterion id', async () => {
    const runJury = makePrismJury({ runSeat: async () => prismResponse('accept') });
    const verdicts = await runJury(SPEC);

    assert.equal(verdicts.length, PRISM_JURY_SEATS.length);
    for (const v of verdicts) {
      assert.deepEqual(Object.keys(v.criteria).sort(), ['AC-1', 'AC-2']);
      assert.deepEqual(v.criteria, { 'AC-1': 'pass', 'AC-2': 'pass' });
    }
    assert.deepEqual(verdicts.map(v => v.seat), ['mistral', 'qwen', 'hermes']);
  });

  it('issues exactly one call per (seat × criterion), seat-major', async () => {
    const order = [];
    const runJury = makePrismJury({
      runSeat: async (env, request) => {
        order.push(`${env.PRISM_VERIFIER_MODEL_LOCAL}:${request.intent.match(/\((AC-\d)\)/)[1]}`);
        return prismResponse('accept');
      },
    });
    await runJury(SPEC);

    assert.equal(order.length, PRISM_JURY_SEATS.length * 2);
    assert.deepEqual(order, [
      'mistral-small:24b:AC-1', 'mistral-small:24b:AC-2',
      'qwen2.5:7b:AC-1', 'qwen2.5:7b:AC-2',
      'hermes3:8b:AC-1', 'hermes3:8b:AC-2',
    ], 'all criteria for one seat before the next — one weight-load per seat');
  });

  it('resolves each criterion independently (the whole point of per-criterion)', async () => {
    const runJury = makePrismJury({
      runSeat: async (_env, request) => prismResponse(request.intent.includes('AC-1') ? 'refuse' : 'accept'),
    });
    const verdicts = await runJury(SPEC);
    // F-c729644d: this test's whole point is pinning per-criterion
    // discrimination (the L3/L4 within-seat tier) — an unguarded loop over
    // an empty verdicts array would report that discrimination is pinned
    // when nothing was actually checked.
    assert.equal(verdicts.length, PRISM_JURY_SEATS.length, 'every seat returns a verdict');
    for (const v of verdicts) {
      assert.deepEqual(v.criteria, { 'AC-1': 'fail', 'AC-2': 'pass' }, 'a per-seat verdict would have flattened these');
    }
  });

  it('a dead seat abstains on every criterion instead of crashing the panel', async () => {
    const runJury = makePrismJury({
      runSeat: async (env) => (env.PRISM_VERIFIER_MODEL_LOCAL === 'qwen2.5:7b'
        ? '{"error":{"reason":"VERIFIER_UNAVAILABLE","detail":"ollama down"}}'
        : prismResponse('accept')),
    });
    const verdicts = await runJury(SPEC);

    const dead = verdicts.find(v => v.seat === 'qwen');
    assert.deepEqual(dead.criteria, { 'AC-1': 'insufficient_context', 'AC-2': 'insufficient_context' });
    assert.equal(verdicts.find(v => v.seat === 'mistral').criteria['AC-1'], 'pass', 'the panel survives');
  });

  it('never emits out_of_brief — prism findings are criterion-scoped, not panel signal', async () => {
    const runJury = makePrismJury({
      runSeat: async () => prismResponse('refuse', { findings: [{ category: 'x', evidence: 'y', severity: 'major' }] }),
    });
    const verdicts = await runJury(SPEC);
    assert.equal(verdicts.length, PRISM_JURY_SEATS.length, 'every seat returns a verdict');
    for (const v of verdicts) {
      assert.deepEqual(v.out_of_brief, [], 'classifying these as out-of-brief would be invention');
      assert.equal(v.prism.criteria[0].findings.length, 1, 'but they are preserved for a human');
    }
  });

  it('attaches per-criterion prism detail for the receipt', async () => {
    const runJury = makePrismJury({ runSeat: async () => prismResponse('accept') });
    const [first] = await runJury(SPEC);
    assert.equal(first.prism.tier, 'prism-per-seat');
    assert.equal(first.prism.criteria.length, 2);
    assert.equal(first.prism.criteria[0].rho_max, 0.2);
  });

  it('reads the roster from spec.seats, not from its own options', async () => {
    const runJury = makePrismJury({ runSeat: async () => prismResponse('accept') });
    const verdicts = await runJury({ seats: [{ family: 'granite', model: 'granite4.1:30b' }], payload: PAYLOAD });
    assert.deepEqual(verdicts.map(v => v.seat), ['granite']);
  });
});

describe('the roster — free by default, non-Claude by construction', () => {
  it('carries no producer-family seat and no paid cloud seat', () => {
    assert.ok(PRISM_JURY_SEATS.length >= 3, 'a panel needs a panel');
    for (const seat of PRISM_JURY_SEATS) {
      assert.doesNotMatch(seat.family.toLowerCase(), /anthropic|claude/);
      // Match `cloud` loosely, not `:cloud` — Ollama's paid seats are named BOTH ways
      // (`glm-4.6:cloud` but `gpt-oss:120b-cloud`), so a colon-anchored guard reads as
      // a free-by-default proof while missing half the paid roster.
      assert.doesNotMatch(seat.model.toLowerCase(), /cloud/, 'the default roster must stay free');
    }
  });

  it('is family-diverse — distinct lineages, not one model wearing name tags', () => {
    const families = new Set(PRISM_JURY_SEATS.map(s => s.family));
    const models = new Set(PRISM_JURY_SEATS.map(s => s.model));
    assert.equal(families.size, PRISM_JURY_SEATS.length);
    assert.equal(models.size, PRISM_JURY_SEATS.length);
  });

  it('opts the paid seat in only via the cloud roster', () => {
    assert.ok(PRISM_CLOUD_SEATS.some(s => /cloud/.test(s.model)));
    assert.ok(PRISM_CLOUD_SEATS.length > PRISM_JURY_SEATS.length);
    for (const seat of PRISM_CLOUD_SEATS) {
      assert.doesNotMatch(seat.family.toLowerCase(), /anthropic|claude/, 'L1 holds on the cloud roster too');
    }
  });
});
