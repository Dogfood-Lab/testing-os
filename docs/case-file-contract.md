# Case-File Contract (jury preparation)

> **Status:** contract spec for testing-os. The neutral briefing a planner-tier
> clerk (a Fable agent) assembles to PREPARE an external, family-different
> verification jury before it judges an artifact. Shape lives in
> `packages/schemas/src/json/case-file.schema.json`; the neutrality lint, the
> fail-closed handoff, and the adjudication logic live in
> `packages/dogfood-swarm/lib/case-file/`.

## Why this exists

The swarm's verification layer is a funnel: a **Sonnet** executor generates, a
family-diverse **jury** (prism-verify over Ollama-Cloud non-Claude seats) renders
the authoritative non-deterministic evidence, and the **deterministic floor**
(`swarm verify` — the real test suite) is the only thing that is *law*. Every
Claude model — Opus, **Fable**, Sonnet, Haiku — is the same family, so no Claude
model can be the independent verifier of another Claude model's work (Panickssery
NeurIPS 2024, arXiv:2404.13076). The jury has to be outside the family.

That raises a subtler problem this contract solves. A jury that is **cold-dropped**
a bundle of files and told "verify this" is judging against a vacuum — "correct"
is undefined for an artifact with no stated objective or acceptance criteria. And
local jurors are badly calibrated toward abstention: they **hallucinate a
confident verdict** on under-specified input instead of saying "I lack the context
to judge." So the jury needs preparing.

Fable is the right seat to prepare it — but preparation must not become
**persuasion**. There are two things that flow from the producer side to the jury,
and they have opposite handling:

- The **producer's justification** ("I did X and it's right *because* Y") is
  persuasion. It is stripped (prism Lock 2; Khalifa 2026, arXiv:2601.14691 —
  manipulated chain-of-thought inflates judge false-positives up to 90%).
- The **task specification** (the objective, the falsifiable criteria, the
  grounding evidence) is the *rubric*. Withholding it is what *causes* the
  under-abstention failure. It must be provided.

The case-file is the second thing, and **only** the second thing. The clerk
renders **no verdict** — it marshals the case file and takes no position. There is
nothing for the jury to anchor on because the clerk never concluded. Neutrality is
**enforced by structure**, not requested of the clerk: the schema forbids a verdict
field by construction, and the lint refuses a briefing that leaks a conclusion, a
reasoning trace, or an ungrounded rubric.

This generalizes a pattern prism already ships: its Groundedness lens is fed the
*retrieved source*, not asked to recall it. "Prep the jury with the specific data"
is that RAG-grounding, applied to every artifact instead of only citations.

## The shape (schema)

`case-file.schema.json` — a swarm-internal envelope (like `agent-output.schema.json`),
resolved via the `@dogfood-lab/schemas` `./json/*` subpath, `additionalProperties:false`
so no verdict-shaped field can be smuggled in.

| Field | Required | Purpose |
|-------|----------|---------|
| `objective` | ✓ | What the artifact must accomplish — the goal, never whether it was met. |
| `artifact_under_test` | ✓ | `{ kind, ref, content? }` — the single object judged. `content` must be free of the producer's reasoning trace. |
| `acceptance_criteria[]` | ✓ | `{ id, check, source? }` — falsifiable checks that define a pass. `from-tests` is the strongest, most-grounded form. |
| `context[]` | | `{ claim, source, ref? }` — the RAG-style grounding pack, each claim provenance-tagged. |
| `out_of_scope[]` | | What the jury should NOT flag. A floor on scrutiny, not a ceiling. |
| `prepared_by`, `correlation_id`, `notes` | | Provenance only — no authority, no verdict. |

`source` provenance enum: `from-spec | from-ticket | from-tests | from-code |
fable-inference`. The four `from-*` values are **extracted** (lifted from a
checkable artifact); `fable-inference` is the clerk's own synthesis and is what the
extraction floor bounds — minimizing the clerk's authorial surface, the part that
could be slanted.

## The neutrality lint

`lib/case-file/lint.js` gates the semantics the shape cannot express — the same
split `policy.schema.json` and [`policy-lint.md`](policy-lint.md) draw between
structural and data-independent checks. It runs four passes and **batch-reports**
every finding (never stops at the first):

| Diagnostic | Severity | What it catches |
|------------|----------|-----------------|
| `case-file-schema` | error | Structural gate (`lib/case-file/schema.js`). A malformed shape is reported, not thrown, so it sits alongside the semantic findings. |
| `case-file-verdict-leak` | error | A lexical conclusion-word ("correct(ly)", "the bug is", "works as expected") in a criterion `check` or a `context` claim — the clerk grading instead of specifying. |
| `case-file-reasoning-leak` | error | A producer reasoning trace (`<thinking>`, `<reasoning>`, `reasoning.summary`, …) leaked into artifact content / claims. Enforces prism's Lock-2 boundary at the briefing seam. |
| `case-file-grounding` | error / warning | The extraction floor. All-`fable-inference` context (the rubric authored from imagination) is an **error**; a thin extraction ratio (below `MIN_EXTRACTION_RATIO`, 0.5) is a **warning**. |

`ok` is true when no error-severity finding is produced; warnings do not block
(the `policy-lint` exit contract). The `VERDICT_LEAK_PATTERNS` and
`REASONING_LEAK_PATTERNS` sets are **exported and test-pinned**, so the exact
vocabulary the gate enforces cannot drift silently and a reviewer can audit it.

### The honest boundary (the VERIFY-F2 over-claim lesson)

A lint that implies full neutrality proof is worse than none — it manufactures
false confidence. This lint catches **lexical** leak and **structural** grounding
only. It **cannot** catch:

| Unreachable statically | Who catches it |
|------------------------|----------------|
| **Semantic slant** — a criterion that is lexically clean but framed to lead ("verify the guard was added" presupposes the guard is the fix). | The jury's cold read + the human reviewer. |
| **Extraction faithfulness** — whether a `from-code` claim actually reflects the code, or was mis-transcribed. | The `ref` pointer + a human/jury spot-check. |
| **Criterion falsifiability** — whether a check is genuinely testable, versus vague. | The jury returning `insufficient_context` (below). |

A clean lint means "no lexical verdict-leak, no reasoning-leak, a grounded pack" —
**not** "this case-file cannot bias the jury." The verdict-leak pass is
deliberately **high-precision** (only conclusion-shaped phrases; never bare
"valid" / "pass" / "works" / "safe" that appear in legitimate checks), because a
false positive blocks a legitimate criterion. The residual — semantic slant — is
disclosed here and handed to the jury and the human, not papered over.

## The handoff

`lib/case-file/handoff.js` — `toJuryRequest(caseFile)` is **fail-closed**: it runs
the lint and throws `CaseFileNeutralityError` on any error-severity finding, so a
biasing briefing never reaches the jury. On a clean case-file it builds the neutral
request:

```json
{
  "artifact":  { "kind": "diff", "ref": "…", "content": "…" },
  "rubric":    { "objective": "…", "acceptance_criteria": [ { "id": "AC-…", "check": "…" } ], "out_of_scope": [ "…" ] },
  "evidence":  [ { "claim": "…", "source": "from-code", "ref": "…" } ],
  "abstention": "…the abstention rubric…",
  "neutrality": { "verdict_free": true, "reasoning_stripped": true, "gated_by": "case-file-lint", "warnings": 0 }
}
```

Two deliberate asymmetries in the jury-facing shape:

- **Rubric criteria expose `{ id, check }` only** — the jury judges the *check*; a
  criterion's provenance is a grounding concern (the lint's), not a judging input,
  and withholding it avoids biasing the verdict.
- **Evidence keeps `{ claim, source, ref }`** — provenance *is* a judging input
  here; the jury should weight a `from-code` claim above a `fable-inference` one,
  the way prism feeds the retrieved source to its Groundedness lens.

### The abstention rubric

Every juror receives `ABSTENTION_RUBRIC` alongside the case-file. It names
`insufficient_context` as a **correct, non-penalized** per-criterion answer — the
structural fix for under-abstention — keeps judgment on artifact-vs-criteria, and
licenses out-of-brief findings so an incomplete case-file does not make the clerk's
blind spots the jury's. And jury abstention becomes a **briefing-quality signal**:
a panel that keeps returning `insufficient_context` on a criterion is evidence the
case-file (or the spec) has a gap to fill.

## Where this sits (the funnel)

| Layer | Seat | Authority |
|-------|------|-----------|
| Director | Opus | final disposition (the jury advises; the caller enforces) |
| Planner + **clerk** | **Fable** | assembles the case-file; **renders no verdict** — advisory |
| Executor | Sonnet | generates the artifact |
| Scout / screen | Haiku | recon, dedup, cheap refutation |
| **Jury** | `--jury=local`: mistral/granite/qwen/gemma/hermes · `--jury=prism`: the same non-Claude seats, each adjudicated by prism per criterion (`--cloud` adds gpt-oss/glm) | family-different, reasoning-stripped; multi-lens + submodularity on the prism tier — **strong evidence** |
| **Floor** | `swarm verify` (tests) + prism retrieval/numeric floors | deterministic — **law** |

Only the deterministic floor is law; every model verdict — the clerk's (there is
none), the jury's — is evidence, weighted by independence.

## Adjudication

`lib/case-file/adjudicate.js` dispatches a neutral case-file to the family-different
jury and fuses the panel into an **advisory** verdict. Three pure, tested pieces
behind an injected jury boundary (the live prism call is the boundary the CLI verb
smoke-tests):

- **`buildJurySpec(request)`** maps the neutral request to the cross-family
  invocation spec and **enforces Lock 1**: it throws if any seat is the producer
  family (`anthropic` / `claude`). Your whole crew is Claude-family, so only the
  non-Claude roster (`gpt-oss` OpenAI · `glm` Zhipu · local mistral/granite/qwen/
  gemma) can independently verify Claude work. It emits the F-14 env recipe
  (`PRISM_VERIFIER_MODEL_OPENAI=gpt-oss:120b-cloud`, `PRISM_OPENAI_BASE_URL=…`,
  `OPENAI_API_KEY=ollama`).
- **`aggregateCriterion(answers)`** is abstention-aware panel fusion. A criterion
  the panel could not reach quorum on (fewer than `minDecidingRatio` of jurors
  decided) is `insufficient_context` — a **brief gap to fill, not a fail**. Among
  the deciding jurors: unanimity → that verdict; disagreement → `contested`.
- **`normalizeAdjudication(verdicts, request)`** produces the overall verdict by
  precedence `refute > contested > insufficient_context > corroborate`, and is
  explicitly **evidence, not law**: `authority: 'advisory'`, `law:
  'deterministic-floor'`, `advances_wave_alone: false` — even a unanimous
  corroborate does not advance a wave alone; the deterministic floor (`swarm
  verify`) must pass too. Out-of-brief findings the jurors raise are aggregated
  separately (the rubric is a floor, not a ceiling), and a panel that keeps
  returning `insufficient_context` is the abstention-as-signal loop telling you the
  case-file has a gap.

`adjudicate(caseFile, { runJury })` is the fail-closed orchestrator: neutrality
gate → build spec → run the injected jury → normalize. A biasing case-file throws
`CaseFileNeutralityError` **before the jury is ever called**.

## The wave-gated CLI verb (shipped)

`swarm adjudicate <run-id> --case-file <path> [--cloud] [--format=json]`
(`commands/adjudicate.js` + `cmdAdjudicate` in `cli.js`) dispatches a case-file to
the jury and records the advisory verdict on the run's current wave. The
`checkAdjudication` gate (schema v9, `lib/advance.js`) then gates advance:
**corroborate** clears; a non-corroborate verdict is an overridable BLOCK requiring
Director disposition (`swarm advance --override --reason`). The deterministic floor
stays the only non-overridable gate, and outranks the jury in gate precedence.

The `runJury` boundary is injected, and **two tiers now plug into it** (see [The two
jury tiers](#the-two-jury-tiers) below), selected with `--jury=local|prism`. The
default is the **free local-Ollama panel** (`lib/case-file/ollama-jury.js` —
Mistral/Granite/Qwen/Gemma/Hermes, all non-Claude, zero cost); `--cloud` opts into the
paid gpt-oss/glm seats on either tier. The verb exits `0` only on corroborate
(mirroring `swarm verify`), writes the full per-criterion receipt under
`swarms/<run>/adjudications/`, and persists the gate-readable summary row.

## The two jury tiers

Both satisfy the same `runJury(spec)` boundary and are fused by the same
`normalizeAdjudication`; they differ in what one seat's judgment *is*.

| | `--jury=local` (default) | `--jury=prism` |
|---|---|---|
| One seat = | one model call over all criteria | one **prism verification per criterion** |
| Calls | N seats | N × M (seats × criteria) |
| L1 family-different | ✓ (buildJurySpec guard) | ✓ **twice** — the guard, plus prism excluding the caller family itself |
| L2 reasoning-stripped | ✓ (the lint) | ✓ the lint, **plus** prism re-stripping (receipted) |
| L3 multi-lens ≥3 | ✗ one judgment | ✓ 4 decorrelated lenses **per criterion** |
| L4 submodularity | ✗ | ✓ collapse-**refusal** (`LENS_COLLAPSE` → abstain) |
| Out-of-brief findings | ✓ (asked for explicitly) | ✗ — see below |
| Receipt | the swarm's | the swarm's **+ prism's signed Ed25519 receipt per call** |
| Cost | free (local seats) | free (local seats), slower |

`--jury=prism` is the stronger tier: it is the only one that answers "would four
decorrelated lenses, on a family-different model, agree about *this specific
criterion*?" That is bought with wall clock, and with the seams below.

### Why per-(seat × criterion), and why it is not free

prism is **one adjudicator over one artifact** — `verdict ∈ accept|revise|refuse|
escalate` against a single `intent` — not a per-criterion panel. Making the intent a
single criterion is what converts prism's contract into an answer this panel can fuse:
`accept`→`pass`, `refuse`/`revise`→`fail` (the intent IS the criterion, so "fixable"
means unmet), `escalate`→`insufficient_context` (prism routing to a human is an
abstention, not a fail). Any prism refusal — `BUDGET_EXCEEDED`, `LENS_COLLAPSE`,
`VERIFIER_UNAVAILABLE` — abstains: a seat that did not judge is a coverage gap.

The alternative (one call per seat over the whole case-file) is cheaper and **lossy in
a way that matters**: an artifact that satisfies AC-1 and fails AC-2 yields one
`revise`, which marks *both* criteria failed — a false fail on AC-1. The live smoke
demonstrates the difference concretely: on the FIXED case-file the panel returned
`AC-expired-401: pass [3/0/0]` but `AC-valid-issues: contested [2 pass / 1 fail]`. A
per-seat design cannot represent that split at all.

Calls run **seat-major** (every criterion for one seat before the next). Ollama swaps
weights per model, so seat-major pays one weight-load per seat rather than one per
call — the same swap cost as a per-seat design, with only extra inference on top. The
measured smoke (3 seats × 2 criteria × 2 case-files = 12 calls) ran in **1.4 min**:
the first call on each seat carries the load (13.3s / 6.0s / 9.9s), the rest are
2–5s.

### The honest boundary (what this tier does NOT give you)

| Seam | Why | Consequence |
|------|-----|-------------|
| **No out-of-brief findings.** | prism's response has no per-criterion channel and its `Finding` is free text (`{file,line,category,evidence,severity}`), so findings are scoped to the criterion-intent that produced them. Classifying them as "out of brief" would be invention, and would double-count one finding once per criterion. | They are preserved verbatim in each verdict's `prism` detail for a human, and never reach the aggregator. The rubric-is-a-floor property is **weaker** here than on the local tier, which asks for out-of-brief explicitly. |
| **The abstention rubric is not delivered to the model.** | prism owns its lens prompts; this tier only controls `intent`. `ABSTENTION_RUBRIC` therefore does not reach the juror. | Abstention on this tier is **structural, not instructed** — it comes from prism's own `UNCERTAIN → ESCALATE` lens outcome. That is arguably stronger (a mechanism, not a request), but it is a different mechanism, and a seat can still under-abstain: the smoke's 7B seat returned a confident `refuse` on a criterion the diff satisfies, rather than `insufficient_context`. The under-abstention failure this contract exists to fix is **mitigated, not eliminated**. |
| **A hard 30s ceiling per call.** | prism's `Budget.max_latency_ms` is capped at 30 000 by construction (the local tier uses a 180s timeout and cannot here). | Seats must FIT the ceiling; one that overruns returns `BUDGET_EXCEEDED` and abstains on that criterion. The roster is chosen for fit, not size — larger local models (`granite4.1:30b`, `gemma4:31b`) are excluded for this reason, so the prism roster is deliberately **not** a copy of the local one. |
| **The brief can be trimmed.** | prism caps `intent` at 4 000 chars. | Assembly is priority-ordered (objective + criterion mandatory, then evidence, then out-of-scope) and anything dropped is **reported**, never silent. A large evidence pack reaches this tier thinner than it reaches the local one. |

A `contested` verdict from a weak seat is the panel working as designed, not a defect:
2-pass/1-fail is genuine disagreement, and the tier surfaces it rather than averaging
it away. The cost is a Director disposition on an artifact that may be fine — which is
the honest price of a free, diverse, deliberately-not-tuned panel.

### The transport (why a Python shim, not `prism verify`)

`lib/case-file/prism-jury.js` drives prism through `lib/case-file/prism_seat.py`
rather than shelling the `prism verify` CLI. This is **not** a preference — the CLI
cannot seat a per-seat model, verified against prism-verify 1.6.0:

- `resolve_routing_map()` — the F-14 config registry, the only reader of
  `PRISM_VERIFIER_MODEL_*` — is reached solely through `build_default_engine()`
  (`core/setup.py`), which only prism's MCP server uses. Both `prism verify`
  (`cli/main.py`) and the HTTP API (`http/app.py`) construct `VerificationEngine` with
  a default `FamilyRouter`, pinning the hardcoded `DEFAULT_ROUTING_MAP`.
- Observed directly: with `PRISM_VERIFIER_MODEL_LOCAL=qwen2.5:7b`, `prism verify`
  returns `verifier_models: ["mistral-small:24b"]`; the shim returns
  `["qwen2.5:7b"]`. Same env, same pin, two transports.
- The CLI also registers only `ollama` **or** `anthropic`, so an OpenAI-compatible
  cloud seat is unreachable there regardless.

Shelling the CLI per seat would therefore run **every seat on `mistral-small:24b`** —
five identical jurors wearing five different name tags, which would silently destroy
the cross-seat diversity that is the panel's entire point. The shim calls prism's own
shared factory, and holds its stdout shape **byte-identical to `prism verify`'s**, so
if the upstream gap is fixed the transport can swap with no parser change.

Each seat's env is built from a **scrubbed** base plus exactly that seat's recipe.
Two hazards, one fix: for `caller_family=anthropic` prism routes GOOGLE → OPENAI →
LOCAL and takes the first family with a registered provider, so a stray ambient
`GOOGLE_API_KEY` both **hijacks the seat** (the "mistral seat" silently becomes
gemini-2.5-pro) and **spends money**, breaking the free-by-default guarantee with no
log line. The specialist endpoints (`PRISM_LOCAL_VERIFIER_ENDPOINT`,
`PRISM_SYCOPHANCY_ENDPOINT`) are scrubbed for the same reason — `build_default_engine`
*prepends* them as the primary verifier for every caller.

### Compensators (prism tier)

Unchanged from the verb's table above: the pure adapter performs **no** irreversible
action. It spawns a subprocess that makes local, free model calls and writes nothing
to the world; prism writes a signed receipt to its own local receipt DB
(`~/.prism/receipts.db`), which is append-only local state, not a published artifact.
The irreversibles remain the verb's (the adjudication row, the receipt file) and carry
the named compensators listed above. `--cloud` on this tier consumes Ollama-Cloud
credits and is the operator's explicit opt-in, as on the local tier.

`CaseFileNeutralityError` is rendered directly by the handler (a biasing case-file
prints `ADJUDICATION REFUSED` + hint and exits 1) rather than graduated to the
central error table — the verb owns its error surface.

Live-verified on-rig end to end: a corroborated case-file cleared all six advance
gates; the neutrality gate refused a verdict-leaking case-file before any jury call.

### Compensators (owned by the `swarm adjudicate` slice — no skip)

The verb performs irreversible actions, so it carries the compensators table the
workflow standards require:

| Irreversible action | Compensator | Post-rollback state | Owner |
|---------------------|-------------|---------------------|-------|
| Persist the adjudication row to the control plane | `deleteAdjudication(db, id)` (`lib/adjudication-store.js`) — the named compensator, no raw SQL | the row is removed; the gate reads the prior latest adjudication (or none) | `swarm adjudicate` |
| Write the receipt artifact under `swarms/<run>/adjudications/` | delete the receipt file (content-addressed name; safe to re-create) | receipt removed from disk | `swarm adjudicate` |
| Live jury dispatch (default: **free local Ollama** — no spend; `--cloud` consumes Ollama-Cloud credits) | none for spend when `--cloud` (bounded per run); the local default has nothing to compensate | — | operator (via `--cloud` opt-in) |

The pure library (`adjudicate.js`, `handoff.js`, `lint.js`) still performs **no**
irreversible action — only the verb persists, and only the local jury runs by
default (free).

## Standards compliance

Scored against the six [workflow standards](../.claude/rules/workflow-standards.md)
(0 missing / 1 partial / 2 present / 3 exemplary).

| Standard | Score | Evidence |
|----------|-------|----------|
| **PIN_PER_STEP** | 3 | The schema is the single source of shape; `VERDICT_LEAK_PATTERNS` / `REASONING_LEAK_PATTERNS` / `MIN_EXTRACTION_RATIO` are exported and pinned by `case-file.test.js`, so the enforced vocabulary can't drift silently. Real fixtures under `fixtures/case-files/{valid,invalid,lint}/` pin one case per pass and severity. |
| **ANDON_AUTHORITY** | 2 | The handoff **fail-closes** — `toJuryRequest` throws `CaseFileNeutralityError` on any error finding, so a defective briefing halts before it reaches the jury (tested). *Remediation (owner: `swarm adjudicate` slice):* wire the lint into `npm run verify` / CI as a repo-wide halt gate over any committed case-file, the way `policy-lint` is wired. |
| **NAMED_COMPENSATORS** | 3 | This slice performs **no irreversible tool calls** — it is a pure lint + transform that writes no world-state, so there is nothing to compensate (not a skip: genuinely no irreversible action). The irreversibles — dispatching to the jury, persisting a signed receipt — land in the `swarm adjudicate` verb, which carries the compensators table per the no-skip rule. |
| **DECOMPOSE_BY_SECRETS** | 3 | `schema.js` (shape) / `lint.js` (neutrality semantics) / `handoff.js` (transform + fail-closed gate) each change for a different reason; the verdict-leak, reasoning-leak, and grounding passes are separate functions; the pattern sets are data, not control flow. A clean Parnas split. |
| **UNCERTAINTY_GATED_HUMANS** | 3 | The abstention rubric makes `insufficient_context` first-class; the grounding **warning** (vs error) gates on confidence — high-precision errors block, genuinely-ambiguous thin grounding only warns; the whole contract exists so the clerk *proposes* and the Director *disposes* with the human above, framed contrastively. |
| **EXTERNAL_VERIFIER** | 3 | This feature **is** external-verifier plumbing — it prepares a family-different jury whose verdict is evidence, gated so no Claude model grades Claude work, with the deterministic floor as law. The `--jury=prism` tier raises this from *present* to *exemplary*: the verifier is now family-different **twice** (the seat guard, plus prism excluding the caller family from its own selection), multi-lens, submodularity-checked, and it returns a signed Ed25519 receipt per call — the generator's reasoning is stripped and re-stripped, and the whole panel is live-verified to DISCRIMINATE (fixed→contested, broken→refute; the broken guard was caught 3/3) rather than rubber-stamping. *Open remediation (owner: next slice):* run a cross-family jury on `VERDICT_LEAK_PATTERNS` / `REASONING_LEAK_PATTERNS` precision-recall — the "jury on the heuristic" pass `policy-lint` ran on its footgun — so the gate's own vocabulary is adversarially checked rather than author-verified. |

Nothing scores below 2; the single remaining 2 (ANDON_AUTHORITY) carries a named
remediation owned by the next slice. EXTERNAL_VERIFIER reached 3 when the
`--jury=prism` tier shipped with a live discrimination proof.

## Research grounding

**No new study-swarm.** The design space — verifier family-independence, reasoning-
stripping, contrastive/withheld-justification judging, and the under-abstention
failure — is already grounded by the prism-verify research dispatch (mirrored in
`prism-verify/design/01-research-grounding.md`): Panickssery NeurIPS 2024
(arXiv:2404.13076, self-preference), Khalifa 2026 (arXiv:2601.14691, CoT
contamination), Buçinca CHI 2025 (arXiv:2410.04253, contrastive/withheld
justification improves independent judgment). This contract is a focused feature on
that already-grounded layer; the adversarial jury (the EXTERNAL_VERIFIER
remediation above) is the verifier, not a fresh dispatch.
