/**
 * Predicate engine (VERIFY-F1)
 *
 * A bounded, NO-EVAL interpreter for the declarative policy DSL. Operators author
 * rules as structured predicates in their YAML policy file (field-selector +
 * operator + value, composed with all/any/not/implies); this module evaluates
 * them. There is no `eval`, `Function`, `vm`, dynamic import, or template-string
 * execution anywhere in the path — the evaluator is a pure tree-walk. That is the
 * whole safety thesis (see docs/policy-dsl.md).
 *
 * The schema (`policy.schema.json`, recursive `predicate` $def) is the FIRST gate:
 * unknown operators, malformed nodes, banned path segments, and arity errors are
 * rejected at policy-LOAD time by `validatePayload('policy', …)` and inherit the
 * existing origin-based classification (global policy → throws/operational; repo
 * policy → `__torn`/submission-bad). This module is the SECOND gate: the residual
 * SEMANTIC faults the schema cannot express — an unknown leading field, a numeric
 * operator against a non-number, or a predicate nested past the depth cap — surface
 * as a {@link PredicateError} that the caller (policy.js) turns into a
 * `policy-config:` reason, classified by predicate origin. A predicate is never
 * silently skipped and never throws uncaught (fail-closed; Saltzer & Schroeder 1975).
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/** Combinator nesting cap. A predicate nested deeper is a `max_depth` fault. */
export const PREDICATE_MAX_DEPTH = 5;

/** Field-path segments that must never be traversed (prototype-pollution guard). */
const POISON_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** The closed operator set. Mirrors the `op` enum in policy.schema.json. */
const OPERATORS = new Set([
  'equals', 'not_equals', 'in', 'not_in', 'contains', 'not_contains',
  'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte',
]);

/**
 * A structured predicate fault (compile- or eval-time). The `code` is a stable
 * machine token; the message is operator-actionable (names the rule + the exact
 * problem). The caller maps this to a `policy-config:` rejection reason, classified
 * by the predicate's origin (global → operational, repo → submission-bad).
 */
export class PredicateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PredicateError';
    this.code = code;
  }
}

/**
 * Known leading-field sets per scope, derived from the submission schema so the
 * allowlist never drifts from the contract (CLAUDE.md rule #5: schemas via
 * createRequire). Only the LEADING path segment is validated — a deeper typo just
 * resolves to `undefined` (no match), but a wrong leading field is an operator
 * error worth a diagnostic.
 */
const KNOWN_FIELDS = (() => {
  const require = createRequire(import.meta.url);
  const schemaPath = require.resolve('@dogfood-lab/schemas/json/dogfood-record-submission.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const submission = new Set(Object.keys(schema.properties || {}));
  const srProps = schema.properties?.scenario_results?.items?.properties || {};
  const scenario_result = new Set(Object.keys(srProps));
  return { submission, scenario_result };
})();

/** Split a dotted field path into segments, normalizing the `[]` array marker. */
function splitPath(field) {
  // 'scenario_results[].tags' -> ['scenario_results', '[]', 'tags']
  const segments = [];
  for (const raw of String(field).split('.')) {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/);
    if (!m) throw new PredicateError('bad_field', `field path segment "${raw}" is malformed`);
    segments.push(m[1]);
    if (m[2]) segments.push('[]');
  }
  return segments;
}

/** Read one own-property segment without ever touching the prototype chain. */
function safeGet(value, segment) {
  if (POISON_SEGMENTS.has(segment)) {
    // Defense in depth — the schema `pattern` already bans these, but the
    // evaluator never trusts the schema alone for a security-critical read.
    throw new PredicateError('banned_segment', `field path segment "${segment}" is forbidden`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, segment) ? value[segment] : undefined;
}

/**
 * Resolve a field path to the list of values it selects. A path with no `[]`
 * yields exactly one value (possibly `undefined`, preserving "field absent" so
 * `not_exists` works). Each `[]` segment expands the current frontier across the
 * elements of the arrays at that position. The only iteration in the whole DSL.
 */
function resolvePath(root, segments) {
  let frontier = [root];
  for (const seg of segments) {
    if (seg === '[]') {
      const next = [];
      for (const v of frontier) if (Array.isArray(v)) next.push(...v);
      frontier = next;
    } else {
      frontier = frontier.map(v => safeGet(v, seg));
    }
  }
  return frontier;
}

/** Validate the leading field segment against the scope's known-field set. */
function checkLeadingField(field, scope) {
  const leading = String(field).split('.')[0].replace('[]', '');
  const known = KNOWN_FIELDS[scope];
  if (known && !known.has(leading)) {
    throw new PredicateError(
      'unknown_field',
      `field "${field}" references unknown leading field "${leading}" (known ${scope} fields: ${[...known].join(', ')})`
    );
  }
}

/** Apply one operator to a single resolved value + comparand. */
function applyOp(op, value, comparand) {
  switch (op) {
    case 'equals': return value === comparand;
    case 'not_equals': return value !== comparand;
    case 'in': return Array.isArray(comparand) && comparand.includes(value);
    case 'not_in': return Array.isArray(comparand) && !comparand.includes(value);
    case 'contains':
      if (Array.isArray(value)) return value.includes(comparand);
      if (typeof value === 'string') return value.includes(comparand);
      return false;
    case 'not_contains':
      // not_contains is the negation of contains, so a missing/non-collection
      // field genuinely "does not contain" the value (matches the v1.6.0
      // required_tags semantics — a tagless scenario fails required_tags).
      return !applyOp('contains', value, comparand);
    case 'exists': return Boolean(value);
    case 'not_exists': return !value;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PredicateError(
          'type_mismatch',
          `operator "${op}" requires a numeric field value but got ${describe(value)}`
        );
      }
      if (op === 'gt') return value > comparand;
      if (op === 'gte') return value >= comparand;
      if (op === 'lt') return value < comparand;
      return value <= comparand;
    }
    default:
      // Unreachable when the schema gate ran (op is enum-constrained), but the
      // evaluator fails closed rather than trusting the schema.
      throw new PredicateError('unknown_op', `unknown operator "${op}"`);
  }
}

function describe(value) {
  if (value === undefined) return 'undefined (field absent)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `${typeof value} (${JSON.stringify(value)})`;
}

function isCombinator(node) {
  return node != null && typeof node === 'object' &&
    (Array.isArray(node.all) || Array.isArray(node.any) || node.not != null || Array.isArray(node.implies));
}

/** Evaluate a leaf `{field, op, value?}` against a root, with "any element" semantics. */
function evalLeaf(node, root, scope) {
  if (!OPERATORS.has(node.op)) {
    throw new PredicateError('unknown_op', `unknown operator "${node.op}"`);
  }
  checkLeadingField(node.field, scope);
  const values = resolvePath(root, splitPath(node.field));
  // The predicate is true when ANY selected value satisfies the operator. For a
  // scalar (no `[]`) path this is just that single value; for an empty `[]`
  // selection there is nothing to match, so the leaf is false.
  for (const v of values) {
    if (applyOp(node.op, v, node.value)) return true;
  }
  return false;
}

/**
 * Evaluate a predicate node against a root object (the whole submission for
 * `submission` scope, or a single scenario_result for `scenario_result` scope).
 *
 * @param {object} node - The predicate tree.
 * @param {object} root - The data to evaluate against.
 * @param {'submission'|'scenario_result'} scope - Field-resolution scope.
 * @param {number} [depth] - Internal recursion guard. Do not pass.
 * @returns {boolean} True when the (violation) predicate matches.
 * @throws {PredicateError} On a semantic fault (unknown field, type mismatch, depth).
 */
export function evaluatePredicate(node, root, scope, depth = 1) {
  if (isCombinator(node)) {
    if (depth > PREDICATE_MAX_DEPTH) {
      throw new PredicateError(
        'max_depth',
        `predicate nests deeper than the limit of ${PREDICATE_MAX_DEPTH} combinator levels`
      );
    }
    if (Array.isArray(node.all)) return node.all.every(c => evaluatePredicate(c, root, scope, depth + 1));
    if (Array.isArray(node.any)) return node.any.some(c => evaluatePredicate(c, root, scope, depth + 1));
    if (node.not != null) return !evaluatePredicate(node.not, root, scope, depth + 1);
    // implies: [antecedent, consequent] is the VIOLATION all(antecedent, not(consequent))
    // — it matches the inputs that BREAK the implication antecedent => consequent.
    const [antecedent, consequent] = node.implies;
    return evaluatePredicate(antecedent, root, scope, depth + 1)
      && !evaluatePredicate(consequent, root, scope, depth + 1);
  }
  return evalLeaf(node, root, scope);
}

/**
 * Interpolate a `reason_template`'s `{slot}` placeholders from a root object.
 * Slots are read via the same prototype-safe accessor as the field selector and
 * interpolated RAW (no escaping) — the differential-equivalence oracle wraps
 * values in literal quotes, and any escaping would diverge byte-for-byte. A slot
 * that resolves to nothing renders empty.
 */
function renderTemplate(template, root) {
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, slot) => {
    // A poison slot is rendered empty — never traversed, never thrown. The own-
    // property read avoids the prototype chain entirely (no inherited values leak).
    if (POISON_SEGMENTS.has(slot)) return '';
    const present = root !== null && typeof root === 'object' && Object.hasOwn(root, slot);
    const v = present ? root[slot] : undefined;
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Build the full reason string for a matched rule: `[<id>] <body>`, where the
 * body is the rendered `reason_template` or, absent that, the rule's
 * `description`. The `policy:` prefix is NOT added here — verify/index.js prepends
 * it to every policy error.
 *
 * @param {object} rule - The policy rule ({ id, description?, reason_template? }).
 * @param {object} root - The matched element (scenario_result) or submission.
 * @returns {string}
 */
export function buildReason(rule, root) {
  const body = rule.reason_template != null
    ? renderTemplate(rule.reason_template, root)
    : (rule.description ?? '');
  return `[${rule.id}] ${body}`;
}
