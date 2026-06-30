/**
 * predicate.test.js — VERIFY-F1 predicate engine unit tests.
 *
 * Test-first per operator and per failure mode. The engine is a pure, no-eval
 * tree-walk; these tests pin every operator's semantics (including the
 * deliberately-chosen `exists` ⇔ truthy rule), the combinator + implies
 * desugaring, the field selector with `[]` and prototype-pollution guards, the
 * depth cap, the unknown-field / type-mismatch faults, and reason templating.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePredicate,
  buildReason,
  PredicateError,
  PREDICATE_MAX_DEPTH,
} from './validators/predicate.js';

// A representative scenario_result root for scope:'scenario_result' tests.
const sr = (over = {}) => ({
  scenario_id: 's1',
  product_surface: 'web',
  execution_mode: 'human',
  attested_by: 'alice',
  verdict: 'pass',
  tags: ['release', 'smoke'],
  ...over,
});

const evalSr = (node, root) => evaluatePredicate(node, root, 'scenario_result');

describe('VERIFY-F1 predicate engine — leaf operators', () => {
  it('equals / not_equals (strict)', () => {
    assert.equal(evalSr({ field: 'product_surface', op: 'equals', value: 'web' }, sr()), true);
    assert.equal(evalSr({ field: 'product_surface', op: 'equals', value: 'cli' }, sr()), false);
    assert.equal(evalSr({ field: 'product_surface', op: 'not_equals', value: 'cli' }, sr()), true);
  });

  it('in / not_in (membership over an array value)', () => {
    assert.equal(evalSr({ field: 'execution_mode', op: 'in', value: ['human', 'mixed'] }, sr()), true);
    assert.equal(evalSr({ field: 'execution_mode', op: 'in', value: ['bot'] }, sr()), false);
    assert.equal(evalSr({ field: 'execution_mode', op: 'not_in', value: ['bot'] }, sr()), true);
  });

  it('contains / not_contains on an array field (membership)', () => {
    assert.equal(evalSr({ field: 'tags', op: 'contains', value: 'release' }, sr()), true);
    assert.equal(evalSr({ field: 'tags', op: 'contains', value: 'wip' }, sr()), false);
    assert.equal(evalSr({ field: 'tags', op: 'not_contains', value: 'wip' }, sr()), true);
  });

  it('contains on a string field (substring)', () => {
    assert.equal(evalSr({ field: 'attested_by', op: 'contains', value: 'lic' }, sr()), true);
    assert.equal(evalSr({ field: 'attested_by', op: 'contains', value: 'zzz' }, sr()), false);
  });

  it('not_contains is true for a missing/non-collection field (a tagless scenario "does not contain")', () => {
    assert.equal(evalSr({ field: 'tags', op: 'not_contains', value: 'release' }, sr({ tags: undefined })), true);
  });

  it('exists / not_exists are TRUTHINESS, not strict key-presence', () => {
    assert.equal(evalSr({ field: 'attested_by', op: 'exists' }, sr()), true);
    assert.equal(evalSr({ field: 'attested_by', op: 'not_exists' }, sr({ attested_by: undefined })), true);
    // The byte-identity edge: an empty string is FALSY -> not_exists is true.
    assert.equal(evalSr({ field: 'attested_by', op: 'not_exists' }, sr({ attested_by: '' })), true);
    assert.equal(evalSr({ field: 'attested_by', op: 'exists' }, sr({ attested_by: '' })), false);
  });

  it('gt / gte / lt / lte over a real numeric field (submission scope)', () => {
    // No scalar numeric field exists at scenario_result scope; `source.attempt` is
    // the submission-level numeric field. (A synthetic field would correctly trip
    // the unknown-leading-field guard — see the field-selector tests.)
    const submission = { source: { attempt: 5 }, scenario_results: [] };
    assert.equal(evaluatePredicate({ field: 'source.attempt', op: 'gt', value: 4 }, submission, 'submission'), true);
    assert.equal(evaluatePredicate({ field: 'source.attempt', op: 'gte', value: 5 }, submission, 'submission'), true);
    assert.equal(evaluatePredicate({ field: 'source.attempt', op: 'lt', value: 5 }, submission, 'submission'), false);
    assert.equal(evaluatePredicate({ field: 'source.attempt', op: 'lte', value: 5 }, submission, 'submission'), true);
  });

  it('a numeric operator against a non-number throws a type_mismatch PredicateError', () => {
    assert.throws(
      () => evalSr({ field: 'execution_mode', op: 'gt', value: 1 }, sr()),
      (e) => e instanceof PredicateError && e.code === 'type_mismatch'
    );
  });
});

describe('VERIFY-F1 predicate engine — combinators + implies', () => {
  it('all is AND', () => {
    assert.equal(evalSr({ all: [
      { field: 'product_surface', op: 'equals', value: 'web' },
      { field: 'execution_mode', op: 'equals', value: 'human' },
    ] }, sr()), true);
    assert.equal(evalSr({ all: [
      { field: 'product_surface', op: 'equals', value: 'web' },
      { field: 'execution_mode', op: 'equals', value: 'bot' },
    ] }, sr()), false);
  });

  it('any is OR', () => {
    assert.equal(evalSr({ any: [
      { field: 'execution_mode', op: 'equals', value: 'bot' },
      { field: 'execution_mode', op: 'equals', value: 'human' },
    ] }, sr()), true);
  });

  it('not inverts', () => {
    assert.equal(evalSr({ not: { field: 'execution_mode', op: 'equals', value: 'bot' } }, sr()), true);
  });

  it('implies is the VIOLATION all(antecedent, not(consequent))', () => {
    const node = { implies: [
      { field: 'execution_mode', op: 'in', value: ['human', 'mixed'] },  // antecedent
      { field: 'attested_by', op: 'exists' },                            // consequent
    ] };
    // human + attested -> implication HOLDS -> NOT a violation -> false
    assert.equal(evalSr(node, sr({ execution_mode: 'human', attested_by: 'a' })), false);
    // human + unattested -> implication VIOLATED -> true
    assert.equal(evalSr(node, sr({ execution_mode: 'human', attested_by: undefined })), true);
    // bot -> antecedent false -> not a violation -> false
    assert.equal(evalSr(node, sr({ execution_mode: 'bot', attested_by: undefined })), false);
  });
});

describe('VERIFY-F1 predicate engine — field selector', () => {
  it('dotted paths resolve into nested objects (submission scope)', () => {
    const submission = { source: { actor: 'ci-bot' }, scenario_results: [] };
    assert.equal(evaluatePredicate({ field: 'source.actor', op: 'in', value: ['ci-bot'] }, submission, 'submission'), true);
  });

  it('the [] segment means "any element" (submission scope over scenario_results)', () => {
    const submission = { scenario_results: [
      { scenario_id: 'a', tags: ['smoke'] },
      { scenario_id: 'b', tags: ['wip'] },
    ] };
    assert.equal(evaluatePredicate({ field: 'scenario_results[].tags', op: 'contains', value: 'wip' }, submission, 'submission'), true);
    assert.equal(evaluatePredicate({ field: 'scenario_results[].tags', op: 'contains', value: 'nope' }, submission, 'submission'), false);
  });

  it('an unknown LEADING field throws an unknown_field PredicateError', () => {
    assert.throws(
      () => evalSr({ field: 'totally_made_up', op: 'exists' }, sr()),
      (e) => e instanceof PredicateError && e.code === 'unknown_field'
    );
  });

  it('a __proto__/constructor/prototype path segment throws banned_segment (engine defense-in-depth)', () => {
    // The schema bans this at load; the evaluator never trusts the schema alone.
    assert.throws(
      () => evalSr({ field: 'attested_by.__proto__.polluted', op: 'exists' }, sr()),
      (e) => e instanceof PredicateError && e.code === 'banned_segment'
    );
  });
});

describe('VERIFY-F1 predicate engine — depth cap', () => {
  it(`rejects a predicate nested past ${PREDICATE_MAX_DEPTH} combinator levels`, () => {
    // 6 nested combinators -> exceeds the cap of 5.
    let node = { field: 'execution_mode', op: 'exists' };
    for (let i = 0; i < 6; i++) node = { not: node };
    assert.throws(
      () => evalSr(node, sr()),
      (e) => e instanceof PredicateError && e.code === 'max_depth'
    );
  });

  it(`allows exactly ${PREDICATE_MAX_DEPTH} combinator levels`, () => {
    let node = { field: 'execution_mode', op: 'exists' };
    for (let i = 0; i < PREDICATE_MAX_DEPTH; i++) node = { not: node };
    assert.doesNotThrow(() => evalSr(node, sr()));
  });
});

describe('VERIFY-F1 predicate engine — reason templating', () => {
  it('renders {slot} placeholders RAW from the matched root, prefixed with [id]', () => {
    const rule = {
      id: 'attested-if-human',
      reason_template: 'scenario "{scenario_id}": execution_mode is "{execution_mode}" but attested_by is missing',
    };
    assert.equal(
      buildReason(rule, sr({ scenario_id: 's7', execution_mode: 'mixed' })),
      '[attested-if-human] scenario "s7": execution_mode is "mixed" but attested_by is missing'
    );
  });

  it('does NOT escape values — a scenario_id with a literal quote/backslash survives verbatim', () => {
    const rule = { id: 'r', reason_template: 'id={scenario_id}' };
    assert.equal(buildReason(rule, sr({ scenario_id: 's"7\\x' })), '[r] id=s"7\\x');
  });

  it('falls back to the description when no reason_template is present', () => {
    assert.equal(buildReason({ id: 'r', description: 'plain body' }, sr()), '[r] plain body');
  });

  it('a {slot} interpolation never reaches the prototype chain', () => {
    const rule = { id: 'r', reason_template: 'x={__proto__}' };
    // __proto__ is not an own enumerable data field; it renders empty, never the chain object.
    assert.equal(buildReason(rule, sr()), '[r] x=');
  });
});

describe('VERIFY-F1 predicate engine — array `[]` existential semantics (Phase 3, the empty-selection contract)', () => {
  it('a `[]` path over an empty/absent array selects no elements, so EVERY operator is false (existential)', () => {
    const empty = { scenario_results: [] };
    assert.equal(evaluatePredicate({ field: 'scenario_results[].verdict', op: 'equals', value: 'fail' }, empty, 'submission'), false);
    // The documented footgun: a NEGATIVE operator over `[]` is ALSO false on an empty
    // selection — it is existential ("some element matches"), NOT "the collection lacks X".
    assert.equal(evaluatePredicate({ field: 'scenario_results[].verdict', op: 'not_equals', value: 'pass' }, empty, 'submission'), false);
    assert.equal(evaluatePredicate({ field: 'scenario_results[].attested_by', op: 'not_exists' }, empty, 'submission'), false);
  });

  it('the fail-CLOSED absence idiom is not(any(...)) — it fires on an empty/absent collection', () => {
    // "reject if NO scenario_result is attested" — the correct phrasing for an absence
    // check, which over an empty collection evaluates not(false) => true (fires).
    const absence = { not: { any: [{ field: 'scenario_results[].attested_by', op: 'exists' }] } };
    assert.equal(evaluatePredicate(absence, { scenario_results: [] }, 'submission'), true, 'fires on empty (fail-closed)');
    assert.equal(evaluatePredicate(absence, { scenario_results: [{ attested_by: 'alice' }] }, 'submission'), false, 'does not fire when present');
  });
});

describe('VERIFY-F1 predicate engine — work budgets (Phase 3 DoS guards)', () => {
  it('a predicate exceeding the node-visit budget throws node_budget', () => {
    // A balanced `all` of width 11, 4 combinator levels deep (within the depth cap of 5):
    // 11^4 = 14641 leaf evals > PREDICATE_MAX_NODES (10000). Every leaf is true, so `every`
    // never short-circuits and the full tree is visited.
    const wide = (d) => d === 0 ? { field: 'execution_mode', op: 'exists' } : { all: Array.from({ length: 11 }, () => wide(d - 1)) };
    assert.throws(
      () => evalSr(wide(4), sr()),
      (e) => e instanceof PredicateError && e.code === 'node_budget'
    );
  });

  it('a `[]` selection exceeding the frontier budget throws fanout_budget', () => {
    // Direct engine call (bypasses the schema's maxItems gate, which would reject this
    // submission first in production). PREDICATE_MAX_FRONTIER is 500000.
    const huge = { scenario_results: Array.from({ length: 510000 }, () => 0) };
    assert.throws(
      () => evaluatePredicate({ field: 'scenario_results[].tags', op: 'contains', value: 'x' }, huge, 'submission'),
      (e) => e instanceof PredicateError && e.code === 'fanout_budget'
    );
  });
});
