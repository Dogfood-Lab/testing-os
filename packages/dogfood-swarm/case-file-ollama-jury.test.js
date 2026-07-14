/**
 * case-file-ollama-jury.test.js — the pure, CI-safe pieces of the local-Ollama
 * jury boundary: prompt construction and response parsing.
 *
 * The live HTTP dispatch (makeOllamaJury) is exercised by the manual on-rig smoke
 * (scripts/case-file-adjudicate-smoke.mjs), never here — CI has no Ollama. What
 * IS pinned here is the logic that turns a model's raw text into a per-criterion
 * verdict, because that parse is where a real jury's answer becomes swarm data,
 * and it must never mint a `pass` from garbage or silence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJurorPrompt,
  parseJurorResponse,
  LOCAL_JURY_SEATS,
} from './lib/case-file/ollama-jury.js';

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

describe('buildJurorPrompt', () => {
  it('embeds the abstention instruction and demands strict JSON', () => {
    const { system } = buildJurorPrompt(PAYLOAD);
    assert.match(system, /ABSTAIN-INSTRUCTION-TEXT/);
    assert.match(system, /insufficient_context/);
    assert.match(system, /STRICT JSON/i);
  });

  it('includes the objective, artifact content, every criterion, evidence, and out-of-scope', () => {
    const { user, criterionIds } = buildJurorPrompt(PAYLOAD);
    assert.match(user, /the endpoint rejects an expired token/);
    assert.match(user, /GUARD_CODE_HERE/);
    assert.match(user, /AC-1: returns 401 on expiry/);
    assert.match(user, /AC-2: issues on a valid token/);
    assert.match(user, /isExpired compares exp to now/);
    assert.match(user, /rate limiting/);
    assert.deepEqual(criterionIds, ['AC-1', 'AC-2']);
  });
});

describe('parseJurorResponse — garbage and silence never mint a pass', () => {
  const IDS = ['AC-1', 'AC-2'];

  it('parses clean JSON', () => {
    const r = parseJurorResponse('{"criteria":{"AC-1":"pass","AC-2":"fail"},"out_of_brief":["leak"]}', IDS);
    assert.deepEqual(r.criteria, { 'AC-1': 'pass', 'AC-2': 'fail' });
    assert.deepEqual(r.out_of_brief, ['leak']);
  });

  it('parses fenced JSON (```json … ```)', () => {
    const r = parseJurorResponse('```json\n{"criteria":{"AC-1":"pass","AC-2":"insufficient_context"}}\n```', IDS);
    assert.equal(r.criteria['AC-1'], 'pass');
    assert.equal(r.criteria['AC-2'], 'insufficient_context');
  });

  it('extracts the JSON span from surrounding prose', () => {
    const r = parseJurorResponse('Here is my verdict:\n{"criteria":{"AC-1":"fail","AC-2":"pass"}}\nDone.', IDS);
    assert.equal(r.criteria['AC-1'], 'fail');
    assert.equal(r.criteria['AC-2'], 'pass');
  });

  it('normalizes an omitted criterion to insufficient_context (silence is not a pass)', () => {
    const r = parseJurorResponse('{"criteria":{"AC-1":"pass"}}', IDS);
    assert.equal(r.criteria['AC-2'], 'insufficient_context');
  });

  it('normalizes a non-whitelisted verdict value to insufficient_context', () => {
    const r = parseJurorResponse('{"criteria":{"AC-1":"maybe","AC-2":"pass"}}', IDS);
    assert.equal(r.criteria['AC-1'], 'insufficient_context');
    assert.equal(r.criteria['AC-2'], 'pass');
  });

  it('yields all-insufficient_context on non-JSON garbage', () => {
    const r = parseJurorResponse('I am unable to produce JSON, sorry.', IDS);
    assert.deepEqual(r.criteria, { 'AC-1': 'insufficient_context', 'AC-2': 'insufficient_context' });
  });

  it('filters non-string out_of_brief entries', () => {
    const r = parseJurorResponse('{"criteria":{},"out_of_brief":["real", 42, "", null]}', IDS);
    assert.deepEqual(r.out_of_brief, ['real']);
  });
});

describe('LOCAL_JURY_SEATS — the free-local guarantee', () => {
  it('is entirely non-Claude and carries no paid :cloud seat', () => {
    assert.ok(LOCAL_JURY_SEATS.length >= 3);
    for (const seat of LOCAL_JURY_SEATS) {
      assert.doesNotMatch(seat.family.toLowerCase(), /anthropic|claude/, 'no producer-family seat');
      assert.doesNotMatch(seat.model.toLowerCase(), /:cloud/, 'the free-local roster carries no cloud seat');
    }
  });
});
