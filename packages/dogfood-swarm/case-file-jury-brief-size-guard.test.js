/**
 * case-file-jury-brief-size-guard.test.js — the local jury tier's fail-closed
 * brief-size guard.
 *
 * Observed in run swarm-1784601601-bd4a wave 5 (ai-rpg-engine): `swarm
 * adjudicate --jury=local` dispatched a 252KB case-file (≈216K-char embedded
 * diff) to the five local seats. Every seat completed fast and returned
 * insufficient_context on all 14 criteria — the rendered prompt exceeded the
 * seats' EFFECTIVE context windows (the applied Ollama num_ctx, not the trained
 * `context_length` /api/show reports), the server silently truncated, the
 * models judged a document they never read and correctly abstained, and the
 * runner gave the operator ZERO signal the brief never fit. A 42K-char wave-1
 * brief on the same panel produced clean 4/0/1 verdicts — the contrast that
 * localizes the failure to brief size, not the panel.
 *
 * The guard (lib/case-file/ollama-jury.js): measure the rendered prompt
 * (chars + a labeled chars/4 token estimate) against every seat's resolved
 * context minus the num_predict output reserve, BEFORE any seat call; any
 * overflow throws JuryBriefOverflowError for the WHOLE panel (dispatching only
 * the seats that fit is the roster-shrink failure the case-file contract
 * documents for prism). Fitting runs stamp `brief_fit` on every verdict, fused
 * by normalizeAdjudication onto the receipt as `brief_size`, so a post-hoc
 * read can tell "the seats read the whole brief" from "unknown".
 *
 * Both directions are proven here with an INJECTED seat-context resolver and
 * an injected transport (the same injected-boundary discipline as the mock
 * jury in case-file-adjudicate-cmd.test.js — CI has no Ollama):
 *   - RED: an oversized case-file refuses before any /api/chat call (the
 *     transport recorder stays empty), with the structured error shape and the
 *     per-seat fit map asserted, and nothing persisted at the verb core.
 *   - GREEN: a fitting case-file does NOT trigger the guard, dispatches one
 *     call per seat, and the fused result + receipt carry brief_size.
 *
 * RED-ABLE, proven by temporary mutation: with the `throw new
 * JuryBriefOverflowError(...)` line in makeOllamaJury commented out, the
 * refusal tests below fail (the recorder captures 5 dispatched calls and
 * assert.rejects sees a resolved promise) while the fitting-path tests keep
 * passing — a discriminating red. Restoring the throw returns the suite to
 * green.
 *
 * The --allow-oversize escape hatch (a separate commit on this branch) is
 * pinned at the bottom: it must dispatch, must log, and must receipt
 * all_fit:false — an oversize read is allowed to happen knowingly, never
 * silently.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { getLatestAdjudication } from './lib/adjudication-store.js';
import { adjudicate, normalizeAdjudication } from './lib/case-file/adjudicate.js';
import { runAdjudicate, formatAdjudication } from './commands/adjudicate.js';
import {
  LOCAL_JURY_SEATS,
  DEFAULT_NUM_PREDICT,
  DEFAULT_ASSUMED_NUM_CTX,
  FALLBACK_SEAT_CONTEXTS,
  PROMPT_TOKEN_ESTIMATOR,
  estimateTokensFromChars,
  measureRenderedPrompt,
  assessSeatFit,
  JuryBriefOverflowError,
  makeOllamaJury,
} from './lib/case-file/ollama-jury.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'case-files');
const loadFixture = rel => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf-8'));

// The valid auth fixture, with the artifact inflated to the observed wave-5
// scale (216K chars of diff). '#' filler: inert to every neutrality-lint
// pattern, so the ONLY gate this case-file can trip is the size guard.
function oversizedCaseFile() {
  const cf = loadFixture('valid/well-formed-auth-fix.json');
  cf.artifact_under_test.content += '\n' + '#'.repeat(216_000);
  return cf;
}

// Injected resolver: every seat resolves to the same context, source-labeled
// so the receipt/error assertions can prove the injected value was used.
const fixedContexts = tokens => async seats =>
  Object.fromEntries(seats.map(s => [s.model, { context_tokens: tokens, source: 'injected-test' }]));

// Injected transport: records every /api/chat call; answers pass on both
// fixture criteria so the green path fuses to corroborate.
const PASS_CONTENT = JSON.stringify({
  criteria: { 'AC-expired-401': 'pass', 'AC-valid-issues': 'pass' },
  out_of_brief: [],
});
const recordingFetch = (calls, content = PASS_CONTENT) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, json: async () => ({ message: { content } }) };
};

describe('measureRenderedPrompt + estimateTokensFromChars — the labeled estimate', () => {
  it('measures system+user chars and estimates tokens at ceil(chars/4), estimator pinned', () => {
    const m = measureRenderedPrompt({ system: 'ab', user: 'cdefg' }); // 7 chars
    assert.equal(m.chars, 7);
    assert.equal(m.estimated_tokens, 2); // ceil(7/4)
    assert.equal(m.estimator, PROMPT_TOKEN_ESTIMATOR);
    assert.equal(estimateTokensFromChars(8192), 2048);
  });
});

describe('assessSeatFit — budget = context − output reserve, boundary-exact', () => {
  const SEATS = [{ family: 'qwen', model: 'qwen2.5:7b' }];
  const measurementOf = tokens => ({ chars: tokens * 4, estimated_tokens: tokens, estimator: PROMPT_TOKEN_ESTIMATOR });

  it('fits exactly at budget; overflows by 1 token past it', () => {
    const contexts = { 'qwen2.5:7b': { context_tokens: 1000, source: 'injected-test' } };
    const atBudget = assessSeatFit(measurementOf(488), SEATS, contexts, { outputReserveTokens: 512 });
    assert.deepEqual(atBudget, [{
      seat: 'qwen', model: 'qwen2.5:7b',
      context_tokens: 1000, context_source: 'injected-test',
      budget_tokens: 488, fits: true, overflow_tokens: 0,
    }]);
    const overByOne = assessSeatFit(measurementOf(489), SEATS, contexts, { outputReserveTokens: 512 })[0];
    assert.equal(overByOne.fits, false);
    assert.equal(overByOne.overflow_tokens, 1);
  });

  it('a seat the resolver omitted degrades to the fallback floor, never dispatches unmeasured', () => {
    const [fit] = assessSeatFit(measurementOf(10), SEATS, {}, { outputReserveTokens: 512 });
    // qwen2.5:7b trained ceiling (32768) ∧ assumed default (32768) — labeled fallback.
    assert.equal(fit.context_tokens, Math.min(FALLBACK_SEAT_CONTEXTS['qwen2.5:7b'], DEFAULT_ASSUMED_NUM_CTX));
    assert.equal(fit.context_source, 'fallback-table+assumed-default');
    const [unknown] = assessSeatFit(measurementOf(10), [{ family: 'x', model: 'not-a-model' }], {}, { outputReserveTokens: 512 });
    assert.equal(unknown.context_tokens, DEFAULT_ASSUMED_NUM_CTX);
    assert.equal(unknown.context_source, 'assumed-default');
  });
});

describe('the guard refuses an oversized brief BEFORE any jury call (fail-closed)', () => {
  it('throws JuryBriefOverflowError with the structured shape + per-seat fit map; the transport is never touched', async () => {
    const calls = [];
    const runJury = makeOllamaJury({
      resolveSeatContexts: fixedContexts(4096),
      fetchImpl: recordingFetch(calls),
    });

    let err;
    await assert.rejects(
      () => adjudicate(oversizedCaseFile(), { runJury, seats: LOCAL_JURY_SEATS }),
      (e) => { err = e; return e instanceof JuryBriefOverflowError; },
    );

    assert.equal(err.code, 'JURY_BRIEF_OVERFLOW');
    assert.equal(err.output_reserve_tokens, DEFAULT_NUM_PREDICT);
    assert.equal(err.measurement.estimator, PROMPT_TOKEN_ESTIMATOR);
    assert.ok(err.measurement.chars > 216_000, 'measures the whole rendered prompt, artifact included');
    assert.equal(err.measurement.estimated_tokens, estimateTokensFromChars(err.measurement.chars));
    assert.match(err.message, /jury brief overflow/);
    assert.match(err.message, /5 of 5 seat\(s\)/);
    assert.match(err.hint, /[Ss]plit the case-file|trim the artifact/);

    // The per-seat fit map: every roster seat present, every one overflowing
    // at the injected limit, provenance of the number on each entry.
    assert.equal(err.seat_fit.length, LOCAL_JURY_SEATS.length);
    for (const seat of LOCAL_JURY_SEATS) {
      const fit = err.seat_fit.find(s => s.model === seat.model);
      assert.ok(fit, `fit map covers ${seat.model}`);
      assert.equal(fit.seat, seat.family);
      assert.equal(fit.context_tokens, 4096);
      assert.equal(fit.context_source, 'injected-test');
      assert.equal(fit.budget_tokens, 4096 - DEFAULT_NUM_PREDICT);
      assert.equal(fit.fits, false);
      assert.ok(fit.overflow_tokens > 0);
    }

    assert.equal(calls.length, 0, 'no seat may ever receive a brief it cannot read');
  });

  it('refuses when only SOME seats overflow — a silently-shrunk panel is the prism roster-shrink failure', async () => {
    const calls = [];
    const bigSmall = async seats => Object.fromEntries(seats.map(s => [
      s.model,
      { context_tokens: /granite|gemma/.test(s.model) ? 1_000_000 : 4096, source: 'injected-test' },
    ]));
    const runJury = makeOllamaJury({ resolveSeatContexts: bigSmall, fetchImpl: recordingFetch(calls) });

    let err;
    await assert.rejects(
      () => adjudicate(oversizedCaseFile(), { runJury, seats: LOCAL_JURY_SEATS }),
      (e) => { err = e; return e instanceof JuryBriefOverflowError; },
    );

    const fitting = err.seat_fit.filter(s => s.fits).map(s => s.model).sort();
    const overflowing = err.seat_fit.filter(s => !s.fits).map(s => s.model).sort();
    assert.deepEqual(fitting, ['gemma4:31b', 'granite4.1:30b'], 'the map shows exactly who could read it');
    assert.deepEqual(overflowing, ['llama3.1:8b', 'mistral-small:24b', 'qwen2.5:7b']);
    assert.equal(calls.length, 0, 'the fitting seats are refused too — whole panel or nothing');
  });
});

describe('a fitting brief dispatches normally and receipts its measurement', () => {
  it('does NOT trigger the guard, calls every seat once, and fuses brief_size onto the result', async () => {
    const calls = [];
    const runJury = makeOllamaJury({
      resolveSeatContexts: fixedContexts(32_768),
      fetchImpl: recordingFetch(calls),
    });

    const result = await adjudicate(loadFixture('valid/well-formed-auth-fix.json'), {
      runJury,
      seats: LOCAL_JURY_SEATS,
    });

    assert.equal(calls.length, LOCAL_JURY_SEATS.length, 'one /api/chat call per seat');
    assert.ok(calls.every(c => String(c.url).endsWith('/api/chat')));
    assert.equal(result.overall, 'corroborate');

    const bs = result.brief_size;
    assert.ok(bs, 'a measured run always receipts brief_size');
    assert.ok(bs.chars > 0);
    assert.equal(bs.estimated_tokens, estimateTokensFromChars(bs.chars));
    assert.equal(bs.estimator, PROMPT_TOKEN_ESTIMATOR);
    assert.equal(bs.output_reserve_tokens, DEFAULT_NUM_PREDICT);
    assert.equal(bs.all_fit, true);
    assert.equal(bs.seats.length, LOCAL_JURY_SEATS.length);
    for (const s of bs.seats) {
      assert.equal(s.context_tokens, 32_768);
      assert.equal(s.context_source, 'injected-test');
      assert.equal(s.fits, true);
    }
  });

  it('a dead seat still carries brief_fit — the receipt proves what it COULD read', async () => {
    let call = 0;
    const dieOnSecond = async (url, init) => {
      call += 1;
      if (call === 2) throw new Error('ECONNREFUSED 127.0.0.1:11434');
      return { ok: true, json: async () => ({ message: { content: PASS_CONTENT } }) };
    };
    const runJury = makeOllamaJury({ resolveSeatContexts: fixedContexts(32_768), fetchImpl: dieOnSecond });
    const result = await adjudicate(loadFixture('valid/well-formed-auth-fix.json'), {
      runJury,
      seats: LOCAL_JURY_SEATS,
    });
    assert.equal(result.seats_errored.length, 1);
    assert.equal(result.brief_size.seats.length, LOCAL_JURY_SEATS.length,
      'the errored seat is still on the brief_size map');
  });
});

describe('normalizeAdjudication — brief_size fusion conventions', () => {
  const REQ = {
    artifact: { kind: 'diff', ref: 'src/x.js@1' },
    rubric: {
      objective: 'the widget renders without throwing',
      acceptance_criteria: [{ id: 'AC-1', check: 'render() returns an element' }],
      out_of_scope: [],
    },
    evidence: [],
    abstention: 'ABSTAIN-RUBRIC',
    neutrality: { verdict_free: true, gated_by: 'case-file-lint' },
  };
  const fitOf = over => ({
    chars: 100, estimated_tokens: 25, estimator: PROMPT_TOKEN_ESTIMATOR,
    output_reserve_tokens: 512, context_tokens: 4096, context_source: 'injected-test',
    fits: !over,
  });

  it('ABSENT when no verdict measured (prism tier, pre-guard receipts, plain mocks) — absent means unknown, not zero', () => {
    const result = normalizeAdjudication(
      [{ seat: 'qwen', model: 'qwen2.5:7b', criteria: { 'AC-1': 'pass' }, out_of_brief: [] }],
      REQ,
    );
    assert.equal('brief_size' in result, false);
  });

  it('fuses worst-across-seats (max chars/tokens) and all_fit as the panel AND', () => {
    const result = normalizeAdjudication([
      { seat: 'qwen', model: 'qwen2.5:7b', criteria: { 'AC-1': 'pass' }, out_of_brief: [], brief_fit: fitOf(false) },
      { seat: 'hermes', model: 'hermes3:8b', criteria: { 'AC-1': 'pass' }, out_of_brief: [], brief_fit: { ...fitOf(true), chars: 140, estimated_tokens: 35 } },
    ], REQ);
    assert.equal(result.brief_size.chars, 140);
    assert.equal(result.brief_size.estimated_tokens, 35);
    assert.equal(result.brief_size.all_fit, false);
    assert.deepEqual(result.brief_size.seats.map(s => s.fits), [true, false]);
  });
});

describe('runAdjudicate — the verb core under the guard', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  function setupRun(runId = 'r1') {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(runId);
    return { runId, waveId: Number(wave.lastInsertRowid) };
  }

  it('an oversized brief refuses at the verb core — no receipt written, nothing persisted', async () => {
    const { runId, waveId } = setupRun();
    const calls = [];
    let receiptWrites = 0;
    await assert.rejects(
      () => runAdjudicate(db, {
        runId,
        caseFile: oversizedCaseFile(),
        runJury: makeOllamaJury({ resolveSeatContexts: fixedContexts(4096), fetchImpl: recordingFetch(calls) }),
        seats: LOCAL_JURY_SEATS,
        swarmDir: '/virtual/swarms/r1',
        writeReceipt: () => { receiptWrites += 1; },
      }),
      JuryBriefOverflowError,
    );
    assert.equal(calls.length, 0);
    assert.equal(receiptWrites, 0, 'no receipt for a refused dispatch');
    assert.equal(getLatestAdjudication(db, waveId), undefined, 'nothing persisted on refusal');
  });

  it('a fitting brief persists a receipt whose artifact carries brief_size (post-hoc distinguishable from unknown)', async () => {
    const { runId, waveId } = setupRun();
    const receipts = [];
    const out = await runAdjudicate(db, {
      runId,
      caseFile: loadFixture('valid/well-formed-auth-fix.json'),
      runJury: makeOllamaJury({ resolveSeatContexts: fixedContexts(32_768), fetchImpl: recordingFetch([]) }),
      seats: LOCAL_JURY_SEATS,
      swarmDir: '/virtual/swarms/r1',
      writeReceipt: (path, content) => receipts.push({ path, content }),
    });
    assert.equal(out.result.overall, 'corroborate');
    assert.equal(getLatestAdjudication(db, waveId).overall, 'corroborate');
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(receipts[0].content);
    assert.ok(receipt.result.brief_size, 'the durable artifact carries the measurement');
    assert.equal(receipt.result.brief_size.seats.length, LOCAL_JURY_SEATS.length);
    assert.equal(receipt.result.brief_size.seats[0].context_source, 'injected-test');

    // The human render is not blind to the field (the F-9acd2df3 lesson).
    assert.match(formatAdjudication(out), /Brief: \d+ chars .*read whole by all 5 seats/);
  });
});

describe('--allow-oversize — the escape hatch is recorded, never silent', () => {
  it('dispatches despite overflow, warns per overflowing seat, and receipts all_fit:false', async () => {
    const calls = [];
    const logged = [];
    const runJury = makeOllamaJury({
      allowOversize: true,
      resolveSeatContexts: fixedContexts(4096),
      fetchImpl: recordingFetch(calls),
      log: m => logged.push(m),
    });

    const result = await adjudicate(oversizedCaseFile(), { runJury, seats: LOCAL_JURY_SEATS });

    assert.equal(calls.length, LOCAL_JURY_SEATS.length, 'the hatch dispatches every seat');
    assert.equal(
      logged.filter(m => /OVERSIZE \(--allow-oversize\)/.test(m)).length,
      LOCAL_JURY_SEATS.length,
      'one loud warning per overflowing seat — the wave-5 silence is the failure this line ends',
    );
    assert.equal(result.brief_size.all_fit, false, 'the receipt records the overflow fact');
    assert.ok(result.brief_size.seats.every(s => s.fits === false), 'per-seat map on the receipt');
    assert.match(
      formatAdjudication({ result, adjudicationId: 1, receiptPath: null }),
      /OVERFLOWED 5 of 5 seats — dispatched under --allow-oversize/,
      'the human surface names the hatch and the truncated reads',
    );
  });

  it('without the hatch the same jury still refuses (the default stays fail-closed)', async () => {
    const calls = [];
    const runJury = makeOllamaJury({
      resolveSeatContexts: fixedContexts(4096),
      fetchImpl: recordingFetch(calls),
    });
    await assert.rejects(
      () => adjudicate(oversizedCaseFile(), { runJury, seats: LOCAL_JURY_SEATS }),
      JuryBriefOverflowError,
    );
    assert.equal(calls.length, 0);
  });
});
