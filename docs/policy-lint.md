# Policy lint (VERIFY-F3)

> **Status:** contract spec for testing-os v1.9.0. The author-time companion to the
> declarative policy engine ([`policy-dsl.md`](policy-dsl.md)). Read that first — this file
> assumes the predicate grammar, the operator set, the `[]` field-selector semantics, and the
> `policy-config:` diagnostic class.

## Why this exists

VERIFY-F1 (v1.7.0) shipped the declarative engine: operators author `when` / `custom_rules`
predicates in YAML, validated at policy **load** (the schema gate) and at **eval** (against a real
submission). The gap it left, named in `policy-dsl.md` itself:

> *"A companion **`policy-lint`** verb (VERIFY-F3, a deferred MEDIUM) is the natural author-time
> home: load the policy YAML, run the load-time gate over every predicate, batch-report every fault
> without needing a submission … the `opa check` analogue. v1.7.0 designs toward it."*

Without it, an operator editing `policies/repos/<org>/<repo>.yaml` or `global-policy.yaml` only
learns a predicate is malformed when a **real submission** hits it — and for a *repo* predicate that
means waiting until their CI dispatches a dogfood run. `policy-lint` closes that loop: it is the
**author-time** check, run locally or in CI on `policies/**`, that needs no submission.

This verb **closes a promise the shipped docs already made** — it does not add a new claim.

## What it does — and the honest boundary of what it cannot

`policy-lint` runs three passes over a policy file and batch-reports every finding (it never stops at
the first):

1. **Structural gate** — `validatePayload('policy', parsed)` against `policy.schema.json`. Catches
   everything the recursive `predicate` `$def` expresses: unknown `op`, malformed/banned field path,
   a mixed combinator node, value-arity (`exists` with a `value`, `in` with a non-array),
   `additionalProperties`, a `custom_rules` block under `defaults`. This is the same gate
   `loadGlobalPolicy` / `loadRepoPolicy` run at load time.
2. **Static predicate walk** — for every `when` predicate, the **data-independent** semantic checks the
   schema *cannot* express: an **unknown leading field** for the rule's scope (`unknown_field`),
   combinator nesting past the depth cap (`max_depth`), and a predicate whose static node count blows the
   evaluation budget (`node_budget`). These reuse the engine's own `KNOWN_FIELDS` / depth / node-budget
   constants, so the lint and the evaluator can never disagree about a limit.
3. **`[]`-footgun advisory** — a deterministic, AST-derived **warning** (never a hard error) on the one
   shape that silently fails open. See [The `[]` footgun](#the--footgun-advisory).

### The boundary (the VERIFY-F2 over-claim lesson)

A lint that implies full coverage is worse than no lint, because it manufactures false confidence. Two
predicate faults are **data-dependent** and **cannot** be caught without a real submission — the lint
says so in its own output rather than letting a clean result read as "fully checked":

| Fault | Why it is unreachable statically |
|-------|----------------------------------|
| `type_mismatch` (a numeric op `gt`/`gte`/`lt`/`lte` against a field that resolves to a non-number) | The resolved value's *type* depends on the submission data. `{ field: coverage_pct, op: gt, value: 80 }` is well-formed; whether `coverage_pct` is a number is a runtime fact. |
| `fanout_budget` (a `[]` selection exceeding 500,000 elements) | Fan-out is the product of array *sizes* in the submission, which the policy file does not contain. |

The data-dependence above is strictly the **field** side. The **comparand** side (the literal `value:` in
the policy file) *is* static, and the policy schema enforces its type per operator — a number for
`gt`/`gte`/`lt`/`lte`, a scalar for the `equals`/`contains` families, scalar elements for `in`/`not_in` —
so a YAML-quoted numeric (`value: "95"`) or an object comparand is rejected at the structural gate, in
both the verify path and the lint verb.

`policy-lint` prints a one-line **coverage note** stating this. A clean lint means *"no static fault and
no footgun"* — not *"this policy can never produce a `policy-config:` rejection."* Surface a real submission
(`dogfood-verify --file … --explain`) to exercise the data-dependent path.

## The `[]` footgun (advisory)

A **negative** operator (`not_equals`, `not_in`, `not_contains`, `not_exists`) over a `[]` field path
fails **open** on an empty or absent array. With the engine's existential ("any selected element") leaf
semantics, an empty `[]` selection matches *nothing*, so a negative-op leaf evaluates `false` — the
violation predicate is false — and a `reject` rule **silently does not fire** when the author almost
certainly meant it to. This is `policy-dsl.md`'s documented footgun:

> `evidence[].kind not_contains log` means *"some evidence item's kind lacks 'log'"*, **not** *"the evidence
> lacks a log item"* — and over an empty `evidence` it is false (does not fire). To say *"reject if no element
> satisfies P"* use the fail-closed idiom **`{ not: { any: [ <P> ] } }`**.

`policy-lint` **warns** on this shape, names the rule id + the offending field, and prints the fail-closed
rewrite as a **suggestion the author confirms** — it never auto-applies it. Three reasons it is advisory,
not a hard error:

- **Legitimate existential-negatives exist.** `scenario_results[].verdict not_equals pass` = *"reject if any
  scenario isn't pass"* is a real, correct rule. A false positive here is acceptable; the author reads the
  warning and confirms intent. A false *negative* (a silent fail-open in production) is the expensive failure,
  so the heuristic errs toward warning.
- **The rewrite changes semantics, not just the empty-case.** `not_equals pass` (any element) means *"at least
  one element is not pass"*; `not(any(equals pass))` means *"no element is pass"* (= *all* are not pass). They
  differ on non-empty input too. So the rewrite is a **suggestion for a different intent** (universal /
  fail-closed), not a mechanical equivalence — which is exactly why a human must confirm it.
- **Deterministic, AST-derived suggestions only** — never an LLM paraphrase (the structured-suggestion model:
  Rust RFC 1644; Denny et al., CHI 2021; Santos & Becker 2024, arXiv:2409.18661, grounded in the VERIFY-F1
  Phase-0 study-swarm Q5).

A path **without** `[]` is never flagged: `tags not_contains release` operates on the whole array as a single
value and is the correct idiom (it is the live `prefer-release-tag` warn-rule in
`fixtures/policies/valid/surface-custom-rules.yaml`). The footgun is specifically the `[]`-existential shape.

**Heuristic — suppression by negation parity:** the warning fires for a negative-op leaf over a `[]` path that
has been inverted an **even** number of times (zero or two `not`s). A leaf inverted an **odd** number of times
fails *closed*, so it is suppressed. Two inversion sources are counted: a `not` combinator, and the **consequent**
(second element) of an `implies` (since `implies:[A,C]` desugars to the violation `all(A, not(C))`). This parity
rule replaced a naive "is there *any* `not` above me" flag after the VERIFY-F3 cross-family adversarial jury
(`deepseek-v4-pro` / `glm-5.2` / `minimax-m3`, 2026-06-30) converged on two real defects in the naive rule:
`not(not(X))` over `[]` fails open but was wrongly suppressed (a false **negative** — the dangerous direction),
and a negative-op `implies`-consequent fails closed but was wrongly flagged (a false **positive**). The jury's two
other suggestions were rejected after checking them against the engine: flagging *every* operator over `[]` (not
just negative) would flood noise on the normal `contains` idiom, and making the bare case a hard error would block
legitimate existential-negatives. The scope stays negative-ops-only and advisory. False positives remain
acceptable by design; a false negative (a silent production fail-open) is the expensive failure, so the heuristic
errs toward warning, and the author is the verifier of intent.

## CLI shape

A **subcommand on the existing `dogfood-verify` bin**, not a new bin and not a flag on the verify path:

```text
dogfood-verify lint <policy-file> [--json]
```

- **Why a subcommand, not `--lint <file>`.** Linting a policy and verifying a submission are different
  operations with different inputs (a policy YAML vs a submission JSON), different output, and a different
  notion of "pass." A subcommand reads naturally (`dogfood-verify lint policies/global-policy.yaml`, the
  `opa check <file>` shape) and keeps the lint parser/renderer **fully separate** from the verify
  `parseArgs`/`run` path — that path is not touched, so the shipped verify contract cannot regress. The bin's
  entry dispatches on `argv[0] === 'lint'`; previously that token threw `unknown argument: lint`, so this is a
  purely additive change.
- **Why not a dedicated bin.** The repo caps published bins deliberately; the lint shares `verify`'s leaf-package
  dependency set (`@dogfood-lab/schemas` + `js-yaml`) and its house output style. A second bin would duplicate
  packaging for no benefit. *(Director checkpoint — confirmed: fold into `dogfood-verify`.)*
- **Output** mirrors `--explain`: verdict-first, then findings grouped ERROR-before-WARNING, each naming the
  policy origin (global vs repo, derived from the file path), the rule id, the field, a stable diagnostic code,
  and an actionable message. `--json` emits the machine-readable equivalent for CI.

### Exit codes (consistent with the `dogfood-verify` verify path)

| Code | Meaning |
|------|---------|
| `0` | Clean **or warnings-only** — no structural/static error. Footgun advisories do not block (they are warnings). |
| `1` | One or more **errors** — schema-invalid, a static predicate fault, or unparseable YAML (the policy fails the check). |
| `2` | **Operator error** — the file is missing/unreadable, or the invocation is malformed (bad flags). |

YAML that fails to parse is exit **1** (a lint *finding* about the policy the author must fix — surfacing
"line 4: bad indentation" is the lint's job), not exit 2. A file that does not exist is exit **2** (the author
pointed at the wrong path).

## Diagnostic vocabulary

The lint reuses the runtime taxonomy where it overlaps and adds only lint-scoped labels where the runtime has no
equivalent:

| Lint label | Severity | Source | Runtime equivalent |
|------------|----------|--------|--------------------|
| `policy-schema:` | error | the structural gate (`validatePayload`) | the load-time gate (`loadGlobalPolicy` throw / `loadRepoPolicy` `__torn`) |
| `policy-config:` | error | the static predicate walk (`unknown_field`, `max_depth`, `node_budget`) | the eval-time `policy-config:` reason (repo) / `VALIDATOR_FAULT_POLICY:` (global) — **same `PredicateError.code` tokens** |
| `policy-footgun:` | **warning** | the `[]`-negative advisory | none (this is the author-time check the runtime cannot make) |

`policy-config:` is taken verbatim from `parse-rejection.js`; the predicate codes (`unknown_field`, `max_depth`,
`node_budget`) are the engine's own `PredicateError.code` values, so author-time and runtime diagnostics speak one
vocabulary. `policy-schema:` and `policy-footgun:` are lint-only and are **not** registered in `parse-rejection.js`
(they never appear in a persisted record's `rejection_reasons`).

## Standards compliance

Scored against the six [workflow standards](../.claude/rules/workflow-standards.md)
(0 missing / 1 partial / 2 present / 3 exemplary).

| Standard | Score | Evidence |
|----------|-------|----------|
| **PIN_PER_STEP** | 3 | Test-first per fault-mode with pinned fixtures (`fixtures/policies/{valid,invalid}`, extended with footgun + static-fault cases). The lint reuses the engine's own `KNOWN_FIELDS` / `PREDICATE_MAX_DEPTH` / `PREDICATE_MAX_NODES` constants and `PredicateError.code` tokens, so a limit can never drift between author-time and runtime — the pin is structural, not a copied literal. |
| **ANDON_AUTHORITY** | 3 | The lint is wired into `npm run verify` as a halt gate over the live `policies/**` tree (a structural/static error → non-zero → CI red). A malformed policy that ships is caught before merge, not at the next dispatch. |
| **NAMED_COMPENSATORS** | 3 | The v1.8.0 release irreversibles (`npm publish`, `gh release create`, `git push <tag>`) carry the compensators table already tabled in `release.yml` (per-package version guard + idempotent publish). The feature itself writes no world-state — it reads policy files and reports. |
| **DECOMPOSE_BY_SECRETS** | 3 | `lintPredicate` / `findEmptyArrayFootguns` (predicate-AST analysis) are extracted from `evalLeaf` (evaluation) by factoring the data-independent checks into return-fault helpers shared by both paths; `lintPolicy` (wiring + origin classification) sits in its own `validators/lint-policy.js`; the CLI subcommand (parse + render) is separate from the verify `run`. Each changes for a different reason. The footgun heuristic is its own function (an advisory that will evolve independently of the correctness gate). |
| **UNCERTAINTY_GATED_HUMANS** | 3 | The footgun is advisory **because** intent is genuinely ambiguous — the lint surfaces the choice with a contrastive frame ("you may have meant the universal/fail-closed reading; here is the rewrite") and the author confirms. The CLI-shape decision and the release go are director checkpoints. |
| **EXTERNAL_VERIFIER** | 3 | A cross-family Ollama jury (re-fetched roster, reasoning-stripped) pressure-tests the footgun heuristic itself — does it false-negative on a real fail-open shape, or false-positive into noise? — before release. No model verifies its own output; the heuristic is adversarially checked, not self-confirmed. |

**No new study-swarm:** the design space (author-time static validation; `opa check` / K8s
type-check-at-creation; deterministic, non-paraphrased diagnostics) was grounded by the VERIFY-F1 Phase-0
study-swarm Q5 ([`policy-dsl.md` → Research grounding](policy-dsl.md#research-grounding)). VERIFY-F3 is a focused
feature on an already-grounded layer; the adversarial jury is the verifier, not a fresh dispatch.
