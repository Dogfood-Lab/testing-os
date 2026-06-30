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

/**
 * Total-work budgets (VERIFY-F1 Phase 3 hardening — the depth cap bounds NESTING
 * but not WIDTH or array fan-out). The engine runs synchronously inside the ingest
 * pipeline, so an unbounded tree-walk would block the event loop. Both budgets are
 * generous relative to any real policy (a hand-authored rule is a handful of nodes
 * over a handful of elements) and exist only to refuse a pathological / hostile
 * predicate as a classified `policy-config:` fault rather than letting it spin.
 */
export const PREDICATE_MAX_NODES = 10_000;       // visited predicate nodes per evaluation
export const PREDICATE_MAX_FRONTIER = 500_000;   // selected values from a `[]` fan-out

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
      for (const v of frontier) {
        if (!Array.isArray(v)) continue;
        // Explicit element loop, NOT `next.push(...v)` — the spread form blows the
        // call stack on a large array (RangeError) before any budget check fires.
        for (const el of v) {
          if (next.length >= PREDICATE_MAX_FRONTIER) {
            throw new PredicateError(
              'fanout_budget',
              `field path selection exceeds the limit of ${PREDICATE_MAX_FRONTIER} elements`
            );
          }
          next.push(el);
        }
      }
      frontier = next;
    } else {
      frontier = frontier.map(v => safeGet(v, seg));
    }
  }
  return frontier;
}

/**
 * Decide whether a field's LEADING segment is unknown for a scope, returning the
 * fault rather than throwing it. Factored out so the eval path ({@link checkLeadingField},
 * fail-on-first) and the lint path ({@link lintPredicate}, batch-collect) share one
 * source of truth — a divergence between author-time and runtime diagnostics is
 * impossible by construction. Data-INDEPENDENT (the known-field set is derived from
 * the schema), so it is exactly the kind of check the lint can run without a submission.
 */
function leadingFieldFault(field, scope) {
  const leading = String(field).split('.')[0].replace('[]', '');
  const known = KNOWN_FIELDS[scope];
  if (known && !known.has(leading)) {
    return new PredicateError(
      'unknown_field',
      `field "${field}" references unknown leading field "${leading}" (known ${scope} fields: ${[...known].join(', ')})`
    );
  }
  return null;
}

/** Validate the leading field segment against the scope's known-field set (eval path: throws). */
function checkLeadingField(field, scope) {
  const fault = leadingFieldFault(field, scope);
  if (fault) throw fault;
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
 * @returns {boolean} True when the (violation) predicate matches.
 * @throws {PredicateError} On a semantic fault (unknown field, type mismatch, depth, budget).
 */
export function evaluatePredicate(node, root, scope) {
  // The budget is per-evaluation (one call over one root). It bounds the WIDTH a
  // single predicate can consume, complementing the per-node depth cap.
  return evalNode(node, root, scope, 1, { nodes: 0 });
}

function evalNode(node, root, scope, depth, budget) {
  if (++budget.nodes > PREDICATE_MAX_NODES) {
    throw new PredicateError(
      'node_budget',
      `predicate exceeds the evaluation budget of ${PREDICATE_MAX_NODES} nodes`
    );
  }
  if (isCombinator(node)) {
    if (depth > PREDICATE_MAX_DEPTH) {
      throw new PredicateError(
        'max_depth',
        `predicate nests deeper than the limit of ${PREDICATE_MAX_DEPTH} combinator levels`
      );
    }
    if (Array.isArray(node.all)) return node.all.every(c => evalNode(c, root, scope, depth + 1, budget));
    if (Array.isArray(node.any)) return node.any.some(c => evalNode(c, root, scope, depth + 1, budget));
    if (node.not != null) return !evalNode(node.not, root, scope, depth + 1, budget);
    // implies: [antecedent, consequent] is the VIOLATION all(antecedent, not(consequent))
    // — it matches the inputs that BREAK the implication antecedent => consequent.
    const [antecedent, consequent] = node.implies;
    return evalNode(antecedent, root, scope, depth + 1, budget)
      && !evalNode(consequent, root, scope, depth + 1, budget);
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

/* ───────────────────────── Static analysis (VERIFY-F3 policy-lint) ─────────────────────────
 *
 * The two functions below analyze a predicate AST WITHOUT a submission. They are the reusable
 * leaf the `policy-lint` verb (and any future eager-validation path) builds on. Co-located here,
 * not in a separate module, so they reuse this file's private engine internals (KNOWN_FIELDS via
 * leadingFieldFault, isCombinator, the depth/node-budget constants) without exporting the guts —
 * predicate.js owns *everything about a predicate node*: eval AND static analysis.
 *
 * Coverage boundary (the VERIFY-F2 over-claim lesson — see docs/policy-lint.md):
 *   - DATA-INDEPENDENT, caught here: unknown leading field, combinator over-depth, node budget.
 *   - STRUCTURAL (unknown op, banned/malformed segment, arity): caught earlier by the schema gate
 *     (`validatePayload('policy', …)`), so lintPredicate does not re-report them.
 *   - DATA-DEPENDENT, NOT catchable statically: `type_mismatch` (a numeric op over a non-number)
 *     and `fanout_budget` (a `[]` selection size) — both need a real submission. The lint says so.
 */

/** A static lint finding: a machine `code` (mirrors {@link PredicateError} codes) + an operator message. */

/**
 * Statically lint a predicate tree against one scope, batch-collecting the data-independent
 * semantic faults the schema cannot express. Unlike {@link evaluatePredicate} this NEVER throws —
 * a lint reports every fault rather than failing on the first — and it is DEFENSIVE: a malformed
 * node (already flagged by the schema gate) is skipped, not crashed on. The walk mirrors the
 * evaluator's own depth + node accounting (same constants), so a lint verdict agrees with what the
 * engine would do at eval time, and the walk is itself bounded (it cannot become a DoS on a
 * pathological policy file).
 *
 * @param {unknown} node - The predicate tree (any value; non-objects are skipped).
 * @param {'submission'|'scenario_result'} scope - Field-resolution scope.
 * @returns {{ code: string, field?: string, message: string }[]}
 */
export function lintPredicate(node, scope) {
  const findings = [];
  walkLint(node, scope, 1, { nodes: 0, depthReported: false, budgetReported: false }, findings);
  return findings;
}

function walkLint(node, scope, depth, state, findings) {
  if (state.budgetReported) return;
  if (++state.nodes > PREDICATE_MAX_NODES) {
    if (!state.budgetReported) {
      state.budgetReported = true;
      findings.push({
        code: 'node_budget',
        message: `predicate exceeds the evaluation budget of ${PREDICATE_MAX_NODES} nodes`,
      });
    }
    return;
  }
  if (node === null || typeof node !== 'object') return;

  if (isCombinator(node)) {
    if (depth > PREDICATE_MAX_DEPTH) {
      // Mirror the evaluator, which throws when a combinator is reached past the cap; report once
      // and stop descending this branch (siblings are still walked — batch reporting).
      if (!state.depthReported) {
        state.depthReported = true;
        findings.push({
          code: 'max_depth',
          message: `predicate nests deeper than the limit of ${PREDICATE_MAX_DEPTH} combinator levels`,
        });
      }
      return;
    }
    const children =
      Array.isArray(node.all) ? node.all :
      Array.isArray(node.any) ? node.any :
      node.not != null ? [node.not] :
      Array.isArray(node.implies) ? node.implies : [];
    for (const child of children) walkLint(child, scope, depth + 1, state, findings);
    return;
  }

  // Leaf: the only data-independent semantic check is the unknown leading field. The op set and
  // path shape are schema-gated; a numeric-op type mismatch is data-dependent (not checkable here).
  if (typeof node.field === 'string') {
    const fault = leadingFieldFault(node.field, scope);
    if (fault) findings.push({ code: fault.code, field: node.field, message: fault.message });
  }
}

/** Negative operators that fail OPEN over an empty/absent `[]` selection (the footgun). */
const NEGATIVE_OPS = new Set(['not_equals', 'not_in', 'not_contains', 'not_exists']);

/** The positive counterpart used in the fail-closed `not(any(...))` rewrite suggestion. */
const POSITIVE_OF = { not_equals: 'equals', not_in: 'in', not_contains: 'contains', not_exists: 'exists' };

/** Build the deterministic, AST-derived fail-closed rewrite suggestion for a footgun leaf. */
function footgunSuggestion(field, op) {
  const pos = POSITIVE_OF[op] || 'contains';
  const valuePart = pos === 'exists' ? ' ' : ', value: … ';
  return `if you meant "reject when no element satisfies it", use the fail-closed idiom ` +
    `{ not: { any: [ { field: "${field}", op: ${pos}${valuePart}} ] } }`;
}

/**
 * Find `[]`-footgun leaves: a NEGATIVE operator over a `[]` field path, which fails OPEN on an
 * empty/absent array (existential vacuous truth — see docs/policy-lint.md). ADVISORY only: there
 * are legitimate existential-negatives, so the caller surfaces these as warnings the author
 * confirms, never as hard errors, and never auto-applies the rewrite.
 *
 * Suppression by negation PARITY, not a bare "is there a `not` above me" flag. A leaf inverted an
 * EVEN number of times (0, 2, …) still fails open and is flagged; an ODD number of inversions makes
 * it fail CLOSED, so it is suppressed. Two sources of inversion are counted: a `not` combinator,
 * and the CONSEQUENT (second element) of an `implies` (since `implies:[A,C]` desugars to the
 * violation `all(A, not(C))`). This refinement came from the VERIFY-F3 cross-family adversarial
 * jury (deepseek-v4-pro / glm-5.2 / minimax-m3, 2026-06-30), which converged on two real defects in
 * the original boolean rule: `not(not(X))` over `[]` fails open but was suppressed (false negative),
 * and a negative-op consequent of `implies` fails closed but was flagged (false positive). Parity
 * fixes both. Scope stays NEGATIVE-ops-only and ADVISORY (the jury's "flag every op" and "make it a
 * hard error" suggestions were rejected — the former floods noise on the normal `contains` idiom,
 * the latter blocks legitimate existential-negatives). False positives remain acceptable by design;
 * a false negative (a silent production fail-open) is the expensive failure, so it errs toward warning.
 *
 * @param {unknown} node - The predicate tree.
 * @returns {{ field: string, op: string, suggestion: string }[]}
 */
export function findEmptyArrayFootguns(node) {
  const guns = [];
  walkFootgun(node, false, { nodes: 0 }, guns);
  return guns;
}

function walkFootgun(node, inverted, state, guns) {
  if (node === null || typeof node !== 'object') return;
  if (++state.nodes > PREDICATE_MAX_NODES) return; // bounded; lintPredicate reports node_budget

  if (isCombinator(node)) {
    if (Array.isArray(node.all)) { for (const c of node.all) walkFootgun(c, inverted, state, guns); return; }
    if (Array.isArray(node.any)) { for (const c of node.any) walkFootgun(c, inverted, state, guns); return; }
    if (node.not != null) { walkFootgun(node.not, !inverted, state, guns); return; }
    if (Array.isArray(node.implies)) {
      // implies:[A, C] === all(A, not(C)) — only the consequent (index 1) flips parity.
      node.implies.forEach((c, i) => walkFootgun(c, i === 1 ? !inverted : inverted, state, guns));
      return;
    }
    return;
  }

  if (!inverted &&
      typeof node.op === 'string' && NEGATIVE_OPS.has(node.op) &&
      typeof node.field === 'string' && node.field.includes('[]')) {
    guns.push({ field: node.field, op: node.op, suggestion: footgunSuggestion(node.field, node.op) });
  }
}
