---
title: Policy DSL
description: Declarative, no-eval custom policy rules (VERIFY-F1)
sidebar:
  order: 2.5
---

A policy rule used to require a PR into the verifier. As of v1.7.0 you author
rules **declaratively** in YAML — a bounded, **no-eval** predicate the engine
evaluates, no code change per rule. This page is the operator reference; the
full contract is [`docs/policy-dsl.md`](https://github.com/dogfood-lab/testing-os/blob/main/docs/policy-dsl.md).

## Where rules live

Two homes, both **additive** (a rule with no `when` keeps working as before):

- **Global** — `global_rules[]` in `policies/global-policy.yaml`. An optional
  `when` predicate; non-overridable.
- **Surface** — `surfaces.<surface>.custom_rules[]` in a repo policy. Per
  scenario_result; repo-authored; reject/warn/info only.

```yaml
surfaces:
  web:
    custom_rules:
      - id: actor-allowlist
        severity: reject
        description: web proof must come from an allowlisted actor
        when:
          field: attested_by
          op: not_in
          value: [ci-bot, release-bot]
```

## The predicate

A predicate node is **one** of:

| Node | Shape |
|------|-------|
| leaf | `{ field, op, value? }` |
| all  | `{ all: [ … ] }` (AND) |
| any  | `{ any: [ … ] }` (OR) |
| not  | `{ not: … }` |
| implies | `{ implies: [ antecedent, consequent ] }` |

**`when` describes the VIOLATION** — the rule fires when `when` is *true*. A
forbidden combination reads naturally; an "X requires Y" rule uses `implies`
(it matches the inputs that *break* X ⇒ Y, so you write positive clauses
instead of a double negation).

## Operators (closed set)

| Operator | Meaning |
|----------|---------|
| `equals` / `not_equals` | strict scalar compare |
| `in` / `not_in` | membership in an array `value` |
| `contains` / `not_contains` | array membership or string substring |
| `exists` / `not_exists` | **truthy** / falsy (no `value`) |
| `gt` / `gte` / `lt` / `lte` | numeric compare |

There is no `matches` (regex) operator — the named use cases do not need it and
an operator-supplied regex is a ReDoS surface. `exists` is truthiness by design
(an empty string reads as absent), which keeps `attested-if-human` faithful to
its original behavior.

## Field paths and the `[]` footgun

`field` is a dotted path; a `[]` segment means **"any element"** (existential).
`scenario_results[].tags` selects every scenario's tags.

A `[]` path over an **empty/absent** array matches nothing, so a *negative*
operator over `[]` is a fail-open for a reject rule. To say **"reject if no
element satisfies P"**, use the fail-closed idiom:

```yaml
# reject web proof that has no log evidence:
when:
  not:
    any:
      - field: evidence[].kind
        op: contains
        value: log
```

`not(any(...))` fires on an empty collection; a bare `not_contains` over `[]`
would not.

## Scope and reasons

A rule's `scope` is `submission` (default for global rules) or
`scenario_result` (always, for `custom_rules`). At `scenario_result` scope the
predicate runs per element, in array order, emitting one reason per offending
element. A `reason_template` interpolates `{slot}` fields of the matched element:

```yaml
- id: attested-if-human
  severity: reject
  scope: scenario_result
  when:
    implies:
      - field: execution_mode
        op: in
        value: [human, mixed]
      - field: attested_by
        op: exists
  reason_template: >-
    scenario "{scenario_id}": execution_mode is
    "{execution_mode}" but attested_by is missing
```

## Severity, non-weakening, safety

- `reject` fails verification; `warn` is accepted-with-warning; `info` logs only.
- A repo policy can **never weaken** a global gate: `custom_rules` have no
  accept/except verb (the grammar to grant an exception does not exist), and
  combining is deny-overrides.
- The engine is a pure interpreter — no `eval`, `Function`, `vm`, or dynamic
  require. Field reads never touch the prototype chain. Work is bounded:
  combinator depth ≤ 5, width ≤ 64, a per-evaluation node budget, and a `[]`
  fan-out cap. A pathological predicate is refused as a classified fault, never
  a hang.

## When a rule is malformed

Most mistakes (unknown operator, bad node shape, a banned `__proto__` path
segment) are caught when the policy **loads** and inherit the right routing.
An eval-time semantic fault in a **repo** custom rule (a type mismatch, an
unknown field) is a `policy-config:` rejection — the repo fixes its rule. The
same fault in the **global** policy is operational (it pages ops; the studio
fixes its config). See the [error codes](../error-codes/).
