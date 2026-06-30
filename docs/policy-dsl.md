# Policy Predicate DSL (VERIFY-F1)

> **Status:** contract spec for testing-os v1.7.0. This is the authoritative reference for the declarative
> custom-policy-rule engine. The operator-facing handbook page distills it; this file is the contract.
> Read [`policy-contract.md`](policy-contract.md) first for the two-level (global/repo) policy model.

## Why this exists

Before v1.7.0, an operator could not add a verification gate without a PR into the `verify` package: the
policy validator was a fixed ruleset with a config veneer (`global_rules[]` entries were `{id, description?,
severity}` and enforcement was a hardcoded `switch (rule.id)`). VERIFY-F1 makes policy **declarative**:
operators author rules as bounded, structured, **no-eval** predicates in their YAML policy file, and a generic
interpreter evaluates them — no code change per rule.

The engine is **additive and backward-compatible**. A rule without a `when` predicate falls to the existing
id-based switch; seven of the eight built-in global rules stay code-enforced. Exactly one built-in
(`attested-if-human`) is migrated to the declarative form as a forced correctness proof (see
[The forced proof](#the-forced-proof--attested-if-human)).

## The rule model

### Global rules — `global_rules[]`

Each entry keeps its existing `{id, severity, description?}` and gains three **optional** fields:

```yaml
global_rules:
  - id: no-wip-on-web
    severity: reject                # reject | warn | info  (unchanged)
    description: "web-surface scenarios tagged wip cannot count as proof"
    scope: scenario_result          # NEW, optional. submission (default) | scenario_result
    when:                           # NEW, optional. The predicate. Absent => falls to the id-switch.
      all:
        - { field: product_surface, op: equals,   value: web }
        - { field: tags,            op: contains, value: wip }
    reason_template: >-             # NEW, optional. Per-rule reason body (see Reason templating).
      scenario "{scenario_id}": web proof cannot be tagged wip
```

A global rule is **non-overridable**: a repo policy cannot weaken it (see
[Non-weakening](#non-weakening-invariant)).

### Surface custom rules — `surfaces.<surface>.custom_rules[]`

Repo policies attach per-scenario_result predicates to a surface. `custom_rules` live **only** under
`surfaces.<surface>` — they are forbidden under the global `defaults` (the schema rejects them there), because a
declarative rule authored globally belongs in `global_rules` (which fail *operationally*, not submission-bad).
This keeps the origin classification unambiguous: every `custom_rules` fault is repo-origin (submission-bad).

```yaml
surfaces:
  web:
    custom_rules:
      - id: actor-allowlist
        severity: reject
        description: "web proof must come from an allowlisted actor"
        when: { field: "attested_by", op: in, value: [ci-bot, release-bot] }
```

`custom_rules` are **always** evaluated at `scenario_result` scope (they live under a surface, so they apply to
each `scenario_result` whose `product_surface` matches). They carry `severity ∈ {reject, warn, info}` and an
optional `reason_template`. They have **no `scope` field** (it is implied) and — critically — **no
`accept`/`except` verb of any kind** (see [Non-weakening](#non-weakening-invariant)).

## The predicate grammar

A **predicate** is a recursive tree. Every node is exactly one of:

| Node | Shape | Meaning |
|------|-------|---------|
| **Leaf** | `{ field, op, value? }` | Apply `op` to the value at `field`. `exists`/`not_exists` take no `value`. |
| **all** | `{ all: [ <predicate>, … ] }` | Logical AND. True when every child is true. |
| **any** | `{ any: [ <predicate>, … ] }` | Logical OR. True when at least one child is true. |
| **not** | `{ not: <predicate> }` | Logical NOT. |
| **implies** | `{ implies: [ <antecedent>, <consequent> ] }` | Sugar for the violation `all(antecedent, not(consequent))` — matches the inputs that **violate** "antecedent ⇒ consequent" (antecedent holds but consequent does not). |

A node must carry **exactly one** of these keys (`additionalProperties: false`, enforced by the schema).

### `when` describes the VIOLATION

The single most important convention: **`when` is the violation condition.** A rule fires (rejects, warns, or
logs) when its `when` predicate evaluates **true**. This is the Gatekeeper "violation-only" model — the cleanest
mental model for a gate, and the reason a repo policy can never weaken a global one (there is no "true means
allow" path to invert).

- A forbidden combination (`no-wip-on-web`, forbidden-tag combos, actor-not-allowlisted) is a plain
  `all`/`any`/leaf — it reads as "the bad thing."
- An **implication** ("human execution requires an attester") is a violation of the form
  "antecedent AND NOT consequent." You may write it two equivalent ways:

  ```yaml
  # Violation form (single negation — reads "human/mixed AND no attester"):
  when:
    all:
      - { field: execution_mode, op: in,         value: [human, mixed] }
      - { field: attested_by,    op: not_exists }

  # Implies form (sugar — reads "human/mixed implies attested_by exists"):
  when:
    implies:
      - { field: execution_mode, op: in,     value: [human, mixed] }   # antecedent
      - { field: attested_by,    op: exists }                          # consequent
  ```

  Both express the **identical** violation `all(antecedent, not(consequent))` — the `implies` node desugars
  straight to it (it selects the inputs that *break* the implication). The `implies` form exists because the only
  combinator-only alternative for the operator who thinks in requirements is the double-negated
  `not(all(antecedent, not(consequent)))`-style phrasing, which is the empirically worst case for authoring error
  (EASE 2024, ICER 2025 — see [Research grounding](#research-grounding)). Author whichever reads better for the
  rule; the engine and the differential gate see one normalized tree.

## Operators (closed set)

The operator set is **closed**. An `op` outside this set is a schema error caught at policy-load time (see
[Diagnostics](#diagnostics--the-policy-config-class)).

| Operator | `value` | Semantics |
|----------|---------|-----------|
| `equals` / `not_equals` | scalar | Strict `===` / `!==` on the resolved scalar. |
| `in` / `not_in` | array | Resolved scalar **is** / **is not** a member of `value`. |
| `contains` / `not_contains` | scalar | If the resolved value is an **array**: membership. If a **string**: substring. (Type decided by the resolved value, not the operator.) |
| `exists` / `not_exists` | *(none)* | `exists` ⇔ the resolved value is **truthy**; `not_exists` ⇔ **falsy or absent**. |
| `gt` / `gte` / `lt` / `lte` | number | Numeric comparison. A non-numeric resolved value is a `policy-config:` fault (see Diagnostics). |

There is **no `matches` (regex) operator** in v1.7.0. The three named use cases (actor allowlists, field-value
constraints, forbidden tag/scenario combinations) need none, and JavaScript has no built-in linear-time regex
engine — a semi-trusted operator-supplied pattern is a direct ReDoS vector (Cox 2007; OWASP ReDoS; Snyk 2023).
If `matches` is ever added it must be backed by an RE2-class engine with pattern- and subject-length caps,
CI-verified on the Node 22 + 24 matrix — never raw `RegExp`.

### `exists` / `not_exists` are truthiness, by design

`exists` is **truthy**, not strict key-presence. This is deliberate: the migrated `attested-if-human` rule must
be **byte-for-byte behavior-preserving**, and the original arm used `!sr.attested_by` (JS falsy), which treats an
empty-string `attested_by: ""` as missing. Defining `not_exists` ⇔ falsy makes the migration faithful. The edge
to know: a field whose value is `0`, `false`, or `""` reports `not_exists`. For the string/array fields these
operators are meant for (`attested_by`, `actor`, tags) this is the intuitive "present and non-empty." Use
`equals`/`gt`/`lt` for numeric or boolean fields, not `exists`.

## Field selector

`field` is a restricted path into the data the predicate evaluates over.

- **Dotted keys**: `source.actor`, `ref.commit_sha`, `execution_mode`.
- **`[]` segment**: "any element" — **existential**. `scenario_results[].tags` selects the `tags` of every
  scenario_result, and the leaf is true when **any** selected element satisfies the operator. A `[]` path over an
  **empty or absent** array selects *no* elements, so the leaf is **false for every operator** (nothing matches).
  **Footgun (read this):** a *negative* operator over a `[]` path is therefore a latent fail-open for a reject
  rule. `evidence[].kind not_contains log` means "*some* evidence item's kind lacks 'log'", **not** "the evidence
  lacks a log item" — and over an empty `evidence` it is false (does not fire). To say **"reject if no element
  satisfies P"** use the fail-closed idiom **`{ not: { any: [ <P> ] } }`**, which over an empty collection is
  `not(false)` = true (fires). Example — "reject web proof with no log evidence":
  `when: { not: { any: [ { field: "evidence[].kind", op: contains, value: log } ] } }`. (A future `policy-lint`
  verb, VERIFY-F3, will warn on a bare negative operator over a `[]` path.)
- **Banned segments**: `__proto__`, `constructor`, `prototype` are rejected at policy-load time (schema `pattern`)
  **and** never traversed by the evaluator (every segment is read via a null-prototype-hardened accessor). This
  extends the existing `deepMerge` prototype-pollution guard from YAML keys to field-path reads.
- **Unknown leading field**: a path whose first segment is not a known field for the rule's scope is a
  `policy-config:` fault — **not** a silent `false`. The known-field set is derived from
  `dogfood-record-submission.schema.json` (pinned by test), so the diagnostic can suggest the nearest valid
  field name.

### Scope decides what `field` resolves against

| `scope` | `field` resolves against | Emission |
|---------|--------------------------|----------|
| `submission` (default for `global_rules`) | the whole submission (`source.actor`, `overall_verdict`, `scenario_results[].…`, `ci_checks[].…`) | one reason if the predicate matches. |
| `scenario_result` (default for `custom_rules`; opt-in for `global_rules`) | each `scenario_result` independently (`execution_mode`, `attested_by`, `tags`, `product_surface`, `verdict`, `scenario_id`, …) | **one reason per offending element, in `scenario_results` array order.** |

Per-element emission is what makes the differential-equivalence gate pass: the old `attested-if-human` arm emits
one error per offending scenario, in array order, with that element's literal `execution_mode` interpolated.

## Reason templating

When a rule matches, the reason string pushed is always `[<rule.id>] <body>`:

- **With `reason_template`**: `<body>` is the template with `{slot}` placeholders interpolated from the matched
  element (for `scenario_result` scope) or the submission (for `submission` scope). Interpolation is **raw**
  (no escaping — the oracle wraps `scenario_id` in literal double quotes and a `JSON.stringify` would diverge on
  a `scenario_id` containing a `"`). Slots are read via the same null-prototype-hardened accessor as the field
  selector; a slot that resolves to nothing renders empty.
- **Without `reason_template`**: `<body>` is the rule's `description` (mirrors `scenario-minimum`).

The engine emits the reason **without** the `policy:` prefix — `verify/index.js` prepends `policy: ` to every
policy error (and routes warnings to `verification.warnings`). The `[<id>]` bracket is applied by the engine;
templates must not repeat it.

## Severity and the two channels

Severity routing is unchanged from VERIFY-F4 and identical for built-in and custom rules:

- `reject` → `errors[]` → `policy:`-prefixed `rejection_reasons` → flips `policy_valid` false.
- `warn` → `warnings[]` → `verification.warnings` (**accepted-with-warning**; never flips `valid`).
- `info` → logged only; never surfaced in the record.

`valid = errors.length === 0` is preserved. A warn/info rule can never reject.

## Non-weakening invariant

A repo policy must never be able to **weaken** a non-overridable global gate. This is enforced **structurally,
not by a runtime check**:

- The custom-rule grammar has **no `accept`, `except`, or `grant` verb**. A `custom_rule` can only resolve to
  `reject` or `warn` (`severity` enum; schema `additionalProperties: false`). There is no input a repo can
  supply that *enlarges* the accepted set — the grammar to do so does not exist (the OPA Gatekeeper
  violation-only precedent).
- Combining is **deny-overrides** (XACML 3.0; AWS explicit-deny-wins): the engine aggregates rejects from all
  global rules and all surface custom rules into one `errors[]` array; non-empty ⇒ rejected. The accepted set is
  the **intersection** of all gates. Adding any rule can only move a submission toward rejected.

## Safety model

The whole value of VERIFY-F1 is a **safe** declarative engine. The non-negotiable invariants:

1. **No dynamic execution.** No `eval`, `Function`, `vm`, dynamic `require`/`import`, or template-string
   interpolation into any executor. The evaluator is a pure interpreter over the structured tree.
2. **No unbounded iteration / no logic bombs.** The only iteration is `[]` over a submission array
   (`scenario_results`, `step_results`, `tags`, `evidence`) whose size the submission schema bounds with
   `maxItems` (scenario_results ≤ 1000, evidence ≤ 100, tags ≤ 100, step_results ≤ 500, ci_checks ≤ 200). There
   is no loop or recursion primitive in the DSL.
3. **Bounded work: depth, width, and fan-out.** Three caps, because depth alone does not bound a *wide* or
   *fanning* predicate:
   - **Depth** — combinator nesting capped at **5** (`all`/`any`/`not`/`implies` count toward depth).
   - **Width** — `all`/`any` arrays capped at **64** children (schema `maxItems`).
   - **Node budget** — a single evaluation may visit at most **10,000** predicate nodes; beyond that the engine
     throws a `node_budget` fault (bounds the multiplicative wide-tree case the depth cap alone permits).
   - **Fan-out budget** — a `[]` selection may produce at most **500,000** values; beyond that the engine throws
     a `fanout_budget` fault (and the engine flattens with an explicit loop, never `push(...spread)`, so a large
     array cannot blow the call stack).
   Every cap is generous relative to any hand-authored policy and exists only to refuse a pathological/hostile
   predicate as a classified fault — the engine never spins or OOMs. The engine runs synchronously inside the
   ingest pipeline, so an unbounded tree-walk would block the event loop; these budgets are the DoS floor.
4. **Prototype-pollution-safe field reads** (banned segments + null-prototype accessor, above).
5. **No regex** in v1.7.0 (above).
6. **Fail-closed.** A malformed predicate is a rejection, never a silent skip and never an uncaught throw
   (Saltzer & Schroeder 1975, fail-safe defaults). The existing `runValidator` catch is preserved so a predicate
   bug can never fail-open as an accepted submission; a structured `policy-config:` diagnostic is emitted instead.

## Diagnostics — the `policy-config:` class

A bad predicate must produce an **actionable, deterministically-generated** diagnostic naming the rule id + the
exact problem — never a silent pass, never an LLM paraphrase (arXiv:2409.18661). The classification splits by
**predicate origin**, mirroring the load-time `__torn`-vs-throw split that already ships
(`packages/ingest/load-context.js`):

| Fault | Where caught | Origin → class |
|-------|--------------|----------------|
| Structural (unknown `op`, malformed node, banned path segment, `additionalProperties`) | **load** (`validatePayload('policy', …)` against the recursive predicate `$def`) | global → **operational** (`loadGlobalPolicy` throws, fail-loud); repo → **submission-bad** (`loadRepoPolicy` returns `__torn` → `policy: repo policy unreadable`). |
| Semantic, eval-time (`gt` against a non-number, unknown leading field, over-depth, `node_budget`, `fanout_budget`) | **eval** (inside `validatePolicy`) | global rule → **operational** — the engine's `PredicateError` propagates out of `validatePolicy` → `runValidator` synthesizes `VALIDATOR_FAULT_POLICY:` (the existing operational channel; a broken *global* policy is an ops incident, exactly like `loadGlobalPolicy`'s throw). repo custom rule → **submission-bad** — the fault is caught and recorded as a `policy-config:` reason. |

Most malformed predicates are **structural** and are caught at load with the correct origin classification for
free — that is why the predicate `$def` is tight. The new `policy-config:` prefix is reserved for the **residual
eval-time semantic** fault of a **repo custom rule** (the schema cannot catch a type mismatch or an unknown
field that depends on runtime data). The matching **global**-rule fault reuses the existing operational
`VALIDATOR_FAULT_POLICY:` channel rather than a second prefix — so `policy-config:` maps cleanly to a single
class (submission-bad) in `packages/verify/parse-rejection.js`, and the global/operational split stays consistent
with the shipped `loadGlobalPolicy`-throws / `loadRepoPolicy`-`__torn` architecture.

A companion **`policy-lint`** verb (VERIFY-F3, a deferred MEDIUM) is the natural author-time home: load the policy
YAML, run the load-time gate over every predicate, batch-report every fault without needing a submission. Wired
into CI on `policies/**`, it is the `opa check` analogue. v1.7.0 designs toward it; it is not in scope.

## The forced proof — `attested-if-human`

v1.7.0 dogfoods the engine on exactly **one** built-in. `attested-if-human` is chosen because it is the richest
proof: per-element iteration over `scenario_results[]`, the multi-value `in` operator, `exists`/`not_exists`, AND
an if-then implication — the audit's hardest target shape. The other seven built-ins stay code-enforced.

**Declarative form (lands in `policies/global-policy.yaml`):**

```yaml
- id: attested-if-human
  description: "Human or mixed execution_mode requires attested_by field"
  severity: reject
  scope: scenario_result
  when:
    implies:
      - { field: execution_mode, op: in,     value: [human, mixed] }
      - { field: attested_by,    op: exists }
  reason_template: 'scenario "{scenario_id}": execution_mode is "{execution_mode}" but attested_by is missing'
```

This must produce **byte-identical** verdicts AND reason strings versus the old switch arm, kept as a reference
oracle (`attestedIfHumanReference(submission)`, lifted verbatim) in the differential-equivalence test. The fixture
matrix (the contract):

| Fixture | Asserts |
|---------|---------|
| human + attested | no rejection |
| human, no `attested_by` | rejects; reason byte-identical |
| mixed, no `attested_by` | rejects; literal `"mixed"` interpolated (not a constant) |
| bot only | no rejection (bot never requires attestation) |
| empty `scenario_results` | no rejection (nothing to iterate) |
| multiple scenarios, only some attested | one reason per offending element, **in array order** |
| a `scenario_result` with no `execution_mode` | matches the oracle's handling (schema requires it, but the oracle/engine must agree) |
| `attested_by: ""` (empty string) | rejects — pins the `not_exists` ⇔ falsy semantics |
| `scenario_id` containing a literal `"` and `\` | reason reproduces verbatim (raw, unescaped interpolation) |

The switch arm is removed only after the gate is green. The production path uses the engine; the reference exists
solely for the differential test.

## Research grounding

The architecture is grounded in (retrieval-verified, Phase 0 study-swarm):

1. **In-process, cost-bounded eval fails-closed predictably.** KEP-3488 (K8s SIG API Machinery 2023); cel-go
   (Google 2024). → engine in-process, deterministic per-operator cost, hard depth + node caps.
2. **A bounded `{field,op,value}` + `all/any/not` matcher covers the named cases without an expression language.**
   JSON Logic; AWS IAM condition operators; Kyverno. → no CEL/Rego dependency; drop map/filter/reduce/arithmetic.
3. **No mainstream no-eval policy language ships first-class implication; the De Morgan form is the worst case for
   author comprehension.** Rego/CEL/JSON-Logic; Baron et al., EASE 2024 (10.1145/3661167.3661180, n=205 — double
   negations "especially troublesome"); Baron & Feitelson, ICER 2025 (10.1145/3702652.3744213). → ship `implies`
   sugar, normalize to the violation AST at load.
4. **Restriction-only grammar makes "lower scope weakens higher gate" unrepresentable.** OPA Gatekeeper
   violation-only (2019); AWS explicit-deny-wins + permission boundaries; XACML 3.0 deny-overrides (OASIS 2013).
   → no accept verb; deny-overrides; accepted set = intersection.
5. **A malformed security policy must fail closed with a deterministic, actionable diagnostic — not a silent skip,
   not an LLM paraphrase.** Saltzer & Schroeder 1975; Denny et al., CHI 2021 (10.1145/3411764.3445696); Santos &
   Becker 2024 (arXiv:2409.18661). → AST-derived `policy-config:` diagnostics; default-closed.
6. **Prototype pollution via attacker-controlled paths is a repeatedly-CVE'd class.** CVE-2022-25907;
   CVE-2022-24802. → banned segments + null-prototype reads, extending the `deepMerge` guard.
7. **Validate predicate shape statically at load, before eval.** `opa check`; K8s type-checking-at-creation;
   JSON Schema recursive `$defs`/`$ref`. → tight recursive predicate `$def` `$ref`'d from `global_rules` +
   `custom_rules`; the existing load gate catches structural faults and inherits origin classification.

## Standards compliance

Scored against the six [workflow standards](../.claude/rules/workflow-standards.md) (0 missing / 1 partial / 2
present / 3 exemplary):

| Standard | Score | Evidence |
|----------|-------|----------|
| **PIN_PER_STEP** | 2 | The build is test-first per operator/failure-mode with pinned fixtures; the differential-equivalence oracle is a byte-stable regression pin (`scripts/check-finding-regression-pins.mjs` discipline). |
| **ANDON_AUTHORITY** | 3 | `npm run verify` is the halt gate; the differential-equivalence gate is a **release gate** — a non-byte-identical result halts the migration (the switch arm is not removed). Fail-closed `runValidator` catch means a predicate bug halts as a classified rejection, never propagates as an accepted submission. |
| **NAMED_COMPENSATORS** | 3 | Release-side irreversibles (`npm publish`, `gh release create`, `git push <tag>`) carry the compensators table already tabled in `release.yml` (per-package version guard + idempotent publish, hardened in v1.6.0). The migration itself is reversible (re-add the switch arm) until the gate is green. |
| **DECOMPOSE_BY_SECRETS** | 3 | `predicate.js` (the evaluator leaf) is decomposed from `policy.js` (wiring) from `policy.schema.json` (shape) from `parse-rejection.js` (classification) — each changes for a different reason. |
| **UNCERTAINTY_GATED_HUMANS** | 3 | The Phase 0 study-swarm design review was a contrastive uncertainty gate (the director chose build scope + `implies` ergonomics); the v1.7.0 release tag is the director's explicit go. |
| **EXTERNAL_VERIFIER** | 3 | Phase 0 citations retrieval-verified (different mechanism, not parametric recall); Phase 3 runs a cross-family Ollama jury (DeepSeek/GLM/Kimi) on the security-critical re-audit — no model verifies its own output. |
