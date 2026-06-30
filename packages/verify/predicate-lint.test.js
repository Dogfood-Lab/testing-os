/**
 * predicate-lint.test.js (VERIFY-F3) — unit tests for the two static analyzers
 * extracted from the predicate engine: `lintPredicate(node, scope)` (the
 * data-independent validity checks the schema cannot express) and
 * `findEmptyArrayFootguns(node)` (the advisory `[]`-negative heuristic).
 *
 * These are pure functions over a predicate AST — no submission, no policy file.
 * They are the reusable leaf the lint and any future eager-validation path share,
 * and they must agree with the evaluator's own limits (PREDICATE_MAX_DEPTH /
 * PREDICATE_MAX_NODES) by reusing the engine's constants, never copied literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  lintPredicate,
  findEmptyArrayFootguns,
  PREDICATE_MAX_DEPTH,
  PREDICATE_MAX_NODES,
} from './validators/predicate.js';

// ── lintPredicate: unknown leading field (the core value-add over the schema) ──

describe('lintPredicate: unknown leading field', () => {
  it('flags an unknown scenario_result field with code unknown_field', () => {
    const findings = lintPredicate({ field: 'nonexistent_field', op: 'equals', value: 'x' }, 'scenario_result');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'unknown_field');
    assert.match(findings[0].message, /nonexistent_field/);
  });

  it('flags an unknown submission field too', () => {
    const findings = lintPredicate({ field: 'not_a_real_field', op: 'equals', value: 'x' }, 'submission');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'unknown_field');
  });

  it('does NOT flag a known field (verdict at scenario_result scope)', () => {
    assert.deepEqual(lintPredicate({ field: 'verdict', op: 'equals', value: 'pass' }, 'scenario_result'), []);
  });

  it('validates only the LEADING segment (a deeper typo is not a static fault)', () => {
    // source.actor → leading `source` is known; a deeper typo resolves to undefined at eval, not a static error.
    assert.deepEqual(lintPredicate({ field: 'source.whatever', op: 'equals', value: 'x' }, 'submission'), []);
  });

  it('never throws — it batch-collects rather than failing on the first fault', () => {
    const findings = lintPredicate(
      { all: [
        { field: 'bogus_one', op: 'equals', value: 'a' },
        { field: 'bogus_two', op: 'equals', value: 'b' },
      ] },
      'scenario_result'
    );
    assert.equal(findings.filter(f => f.code === 'unknown_field').length, 2);
  });
});

// ── lintPredicate: depth cap (schema cannot bound recursion) ──

describe('lintPredicate: combinator depth', () => {
  const nest = (n) => {
    let node = { field: 'verdict', op: 'equals', value: 'fail' };
    for (let i = 0; i < n; i++) node = { all: [node] };
    return node;
  };

  it(`does NOT flag nesting at the cap (${PREDICATE_MAX_DEPTH} combinators)`, () => {
    const findings = lintPredicate(nest(PREDICATE_MAX_DEPTH), 'scenario_result');
    assert.equal(findings.filter(f => f.code === 'max_depth').length, 0);
  });

  it(`flags nesting one past the cap (${PREDICATE_MAX_DEPTH + 1} combinators) with code max_depth`, () => {
    const findings = lintPredicate(nest(PREDICATE_MAX_DEPTH + 1), 'scenario_result');
    assert.equal(findings.filter(f => f.code === 'max_depth').length, 1);
  });
});

// ── lintPredicate: node budget (bounds the lint walk itself) ──

describe('lintPredicate: node budget', () => {
  it('flags a tree whose static node count exceeds the budget with code node_budget', () => {
    const wide = { any: Array.from({ length: PREDICATE_MAX_NODES + 2 },
      () => ({ field: 'verdict', op: 'equals', value: 'p' })) };
    const findings = lintPredicate(wide, 'scenario_result');
    assert.ok(findings.some(f => f.code === 'node_budget'));
  });
});

// ── lintPredicate is DEFENSIVE — a malformed node never crashes the walk ──

describe('lintPredicate: defensive against malformed nodes', () => {
  it('does not throw on a leaf missing op/field (the schema gate reports that)', () => {
    assert.doesNotThrow(() => lintPredicate({}, 'scenario_result'));
    assert.doesNotThrow(() => lintPredicate({ field: 'verdict' }, 'scenario_result'));
    assert.doesNotThrow(() => lintPredicate(null, 'scenario_result'));
  });
});

// ── findEmptyArrayFootguns: the advisory []-negative heuristic ──

describe('findEmptyArrayFootguns', () => {
  it('flags a negative op over a [] path', () => {
    const guns = findEmptyArrayFootguns({ field: 'evidence[].kind', op: 'not_contains', value: 'log' });
    assert.equal(guns.length, 1);
    assert.equal(guns[0].field, 'evidence[].kind');
    assert.match(guns[0].suggestion, /not.*any/s);
  });

  it('flags every negative operator over a [] path', () => {
    for (const op of ['not_equals', 'not_in', 'not_contains', 'not_exists']) {
      const node = op === 'not_exists'
        ? { field: 'scenario_results[].attested_by', op }
        : { field: 'scenario_results[].verdict', op, value: 'pass' };
      assert.equal(findEmptyArrayFootguns(node).length, 1, `expected ${op} over [] to be flagged`);
    }
  });

  it('does NOT flag a POSITIVE op over a [] path', () => {
    assert.deepEqual(findEmptyArrayFootguns({ field: 'evidence[].kind', op: 'contains', value: 'log' }), []);
  });

  it('does NOT flag a negative op over a non-[] path (operates on the whole array)', () => {
    // `tags not_contains release` is the correct idiom — `tags` resolves to the array as one value.
    assert.deepEqual(findEmptyArrayFootguns({ field: 'tags', op: 'not_contains', value: 'release' }), []);
  });

  it('does NOT flag a negative-over-[] already inside a not (the fail-closed inversion)', () => {
    const node = { not: { any: [{ field: 'evidence[].kind', op: 'not_contains', value: 'log' }] } };
    assert.deepEqual(findEmptyArrayFootguns(node), []);
  });

  it('does NOT flag the recommended fail-closed idiom not(any(positive over []))', () => {
    const node = { not: { any: [{ field: 'evidence[].kind', op: 'contains', value: 'log' }] } };
    assert.deepEqual(findEmptyArrayFootguns(node), []);
  });

  it('finds a footgun nested inside all/any combinators', () => {
    const node = { all: [
      { field: 'product_surface', op: 'equals', value: 'web' },
      { field: 'evidence[].kind', op: 'not_contains', value: 'log' },
    ] };
    assert.equal(findEmptyArrayFootguns(node).length, 1);
  });

  // Negation-parity refinement — the VERIFY-F3 cross-family jury (deepseek/glm/minimax 2026-06-30)
  // found the original "any not ancestor suppresses" rule was both unsound and noisy. These pin the fix.

  it('FLAGS not(not(neg over [])) — even parity still fails open (jury false-negative, now fixed)', () => {
    const node = { not: { not: { field: 'evidence[].kind', op: 'not_contains', value: 'log' } } };
    assert.equal(findEmptyArrayFootguns(node).length, 1);
  });

  it('does NOT flag a neg op over [] as the implies CONSEQUENT (implicit not → fails closed)', () => {
    // implies:[A, C] === all(A, not(C)); the consequent is inverted, so it does not fail open.
    const node = { implies: [
      { field: 'product_surface', op: 'equals', value: 'web' },
      { field: 'evidence[].kind', op: 'not_contains', value: 'log' },
    ] };
    assert.deepEqual(findEmptyArrayFootguns(node), []);
  });

  it('FLAGS a neg op over [] as the implies ANTECEDENT (even parity — not inverted)', () => {
    const node = { implies: [
      { field: 'scenario_results[].verdict', op: 'not_equals', value: 'pass' },
      { field: 'overall_verdict', op: 'equals', value: 'fail' },
    ] };
    assert.equal(findEmptyArrayFootguns(node).length, 1);
  });
});
