/**
 * f-3ed78d6f-comparand-type.test.ts — the predicate comparand (`value`) type
 * is a POLICY-FILE fact, so a mistyped comparand is data-independent and must
 * be caught structurally, not at eval time.
 *
 * Before this fix the schema's allOf only required `value` to be PRESENT for
 * gt/gte/lt/lte and to be an array for in/not_in. The classic YAML footgun
 * `value: "95"` (quoted number) passed the structural gate, applyOp's
 * field-side numeric check never fired (the FIELD is numeric), and
 * `200 > "95"` string-compared / NaN-compared silently false — a
 * severity:reject rule that never rejects, blessed as CLEAN by
 * `dogfood-verify lint`.
 *
 * The fix mirrors the existing in/not_in array constraint:
 *   - gt/gte/lt/lte      => value must be a number
 *   - equals/not_equals/contains/not_contains => value must be a scalar
 *     (string | number | boolean | null) — object/array comparands are
 *     reference-equality and always-false (equals/contains) or always-true
 *     (not_equals/not_contains)
 *   - in/not_in          => array elements must be scalars (same
 *     reference-equality footgun per element)
 *
 * lintPolicy runs validatePayload('policy') first, so these branches surface
 * through the author-time `dogfood-verify lint` verb with no extra wiring.
 */

import { describe, expect, it } from 'vitest';
import { validatePayload } from '../src/index.js';

function policyWithLeaf(leaf: Record<string, unknown>): Record<string, unknown> {
  return {
    policy_version: '1.0.0',
    repo: 'org/example',
    surfaces: {
      cli: {
        custom_rules: [{ id: 'comparand-rule', severity: 'reject', when: leaf }],
      },
    },
  };
}

function expectInvalid(leaf: Record<string, unknown>) {
  const result = validatePayload('policy', policyWithLeaf(leaf));
  expect(result.valid, `expected invalid for ${JSON.stringify(leaf)}`).toBe(false);
}

function expectValid(leaf: Record<string, unknown>) {
  const result = validatePayload('policy', policyWithLeaf(leaf));
  expect(result.valid, JSON.stringify(result.errors)).toBe(true);
}

describe('F-3ed78d6f — numeric ops require a number comparand', () => {
  for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
    it(`rejects ${op} with a quoted-number string comparand (the YAML footgun)`, () => {
      expectInvalid({ field: 'coverage', op, value: '95' });
    });

    it(`accepts ${op} with a number comparand`, () => {
      expectValid({ field: 'coverage', op, value: 95 });
    });
  }

  it('rejects gt with an object comparand', () => {
    expectInvalid({ field: 'coverage', op: 'gt', value: { min: 95 } });
  });

  it('rejects lte with an array comparand', () => {
    expectInvalid({ field: 'duration_ms', op: 'lte', value: [5000] });
  });
});

describe('F-3ed78d6f — equality/containment ops require a scalar comparand', () => {
  it('rejects equals with an object comparand (reference-equality: always false)', () => {
    expectInvalid({ field: 'verdict', op: 'equals', value: { verdict: 'pass' } });
  });

  it('rejects equals with an array comparand', () => {
    expectInvalid({ field: 'verdict', op: 'equals', value: ['pass'] });
  });

  it('rejects not_equals with an object comparand (reference-equality: always TRUE — rule always fires)', () => {
    expectInvalid({ field: 'verdict', op: 'not_equals', value: { verdict: 'pass' } });
  });

  it('rejects contains with an object comparand', () => {
    expectInvalid({ field: 'tags', op: 'contains', value: { tag: 'wip' } });
  });

  it('rejects not_contains with an array comparand', () => {
    expectInvalid({ field: 'tags', op: 'not_contains', value: ['wip'] });
  });

  for (const [label, value] of [
    ['string', 'pass'],
    ['number', 3],
    ['boolean', true],
    ['null', null],
  ] as const) {
    it(`accepts equals with a ${label} comparand`, () => {
      expectValid({ field: 'verdict', op: 'equals', value });
    });
  }
});

describe('F-3ed78d6f — in/not_in elements must be scalars', () => {
  it('rejects in with object elements (reference-equality per element: never matches)', () => {
    expectInvalid({ field: 'execution_mode', op: 'in', value: [{ mode: 'human' }] });
  });

  it('rejects not_in with nested-array elements', () => {
    expectInvalid({ field: 'execution_mode', op: 'not_in', value: [['human']] });
  });

  it('accepts in with scalar elements', () => {
    expectValid({ field: 'execution_mode', op: 'in', value: ['human', 'mixed'] });
  });
});

describe('F-3ed78d6f — untouched siblings stay valid', () => {
  it('exists still takes no value', () => {
    expectValid({ field: 'attested_by', op: 'exists' });
  });

  it('global-policy attested-if-human predicate shape still validates', () => {
    const result = validatePayload('policy', {
      policy_version: '1.0.0',
      global_rules: [
        {
          id: 'attested-if-human',
          severity: 'reject',
          scope: 'scenario_result',
          when: {
            implies: [
              { field: 'execution_mode', op: 'in', value: ['human', 'mixed'] },
              { field: 'attested_by', op: 'exists' },
            ],
          },
        },
      ],
    });
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
});
