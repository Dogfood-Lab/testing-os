# Dogfood Swarm Protocol v2.0

## Overview

The Dogfood Swarm Protocol orchestrates a **model-tiered** fleet of Claude Code agents through a 10-phase play (Stage A Bug + Stage B Proactive + Stage C Humanization + Stage D Visual Polish, then Feature Pass phases 5-8, Final test phase 9, and Full Treatment phase 10) that first establishes a clean bill of health, then builds features to production readiness, and finally polishes for ship. A coordinator reads this document and executes it step by step.

**The phases below describe the *play*. They do not describe the *verification*, and the two are not separable.** Sonnet executes, Fable clerks, a family-different non-Claude jury renders the authoritative non-deterministic evidence, and `swarm verify` is the only thing that is law. Read **[The verification funnel](#the-verification-funnel-read-this-before-dispatching-anything)** immediately below before dispatching a single agent — a run that follows the phases while skipping the funnel produces a correlated single-model fleet whose wave advances on nobody's verdict.

All artifacts live under `swarms/<run-id>/` (relative to repo root), where `<run-id>` is minted by `swarm init` as `swarm-<unix-timestamp>-<4-hex>`. Each wave writes agent prompts to `swarms/<run-id>/wave-N/<domain>.md`, and each agent drops its result at `swarms/<run-id>/wave-N/<domain>/output.json` — the layout `swarm collect --all` auto-discovers. The control plane itself is `swarms/control-plane.db`, and it — not any file on disk — is the source of truth for run state.

## The verification funnel (read this before dispatching anything)

> **This section is load-bearing and post-dates the phase mechanics below.** A run that follows the 10-phase play while ignoring this section will dispatch a single-model agent fleet and advance a wave on nobody's verdict. That has happened. The authoritative spec is [`docs/case-file-contract.md`](../docs/case-file-contract.md); this section is the operator-facing summary, and the contract wins on any conflict.

The swarm's verification layer is a **funnel**, and the seats are not interchangeable:

| Seat | Model | Role | Authority |
|------|-------|------|-----------|
| **Coordinator / Director** | Opus | Orchestrates, authors every public surface, disposes. **Never a juror.** | final disposition |
| **Executor** | **Sonnet** | Audit + amend domain agents — the generators | proposes |
| **Scout / mechanical** | **Haiku** | Cheap recon, path sweeps, enum sync, count checks | proposes |
| **Clerk** | **Fable** | Assembles the neutral case-file. **Renders NO verdict.** | advisory, verdict-free by construction |
| **Jury** | **non-Claude**, and the two tiers seat **different rosters**: `--jury=local` (5) — `mistral-small:24b` · `granite4.1:30b` · `qwen2.5:7b` · `gemma4:31b` · `hermes3:8b`; `--jury=prism` (3) — `mistral-small:24b` · `qwen2.5:7b` · `hermes3:8b`, the 30B pair excluded because prism's hard 30s ceiling makes them abstain (`--cloud`: the local tier switches to `DEFAULT_JURY_SEATS` — the same five local seats plus `gpt-oss:120b-cloud` and `glm-4.6:cloud`, seven in all, held in comment-pinned lockstep with `LOCAL_JURY_SEATS` and guarded by a parity test — while the prism tier appends `gpt-oss:120b-cloud` only) | The only family-different verification | **strong evidence** |
| **Floor** | `swarm verify` (the real test suite) | Deterministic | **LAW — the only thing that is** |

**Why the jury cannot be a Claude model.** Every Claude model — Opus, Fable, Sonnet, Haiku — is one family, so no Claude model can independently verify another Claude model's work (Panickssery et al. NeurIPS 2024, arXiv:2404.13076: self-preference correlates linearly with self-recognition). `buildJurySpec` enforces this as **Lock 1** and throws if any seat is the producer family. A same-family "review" is a second opinion, not verification.

**Why a single-model agent fleet is a defect, not a convenience.** Knight & Leveson 1986 (DOI 10.1109/TSE.1986.6312924) and its coding-agent replication (Ron/Baudry/Monperrus 2026, arXiv:2606.20158 — **429 coincident failures vs 115 predicted, z=29.20**) both measure the same thing: independently-developed versions fail together far more than independence predicts. Six auditors on one model share a blind spot **by construction**. Tier the seats.

**The wave gate.** `swarm adjudicate <run-id> --case-file <path> [--jury=local|prism] [--cloud]` dispatches the case-file to the family-different jury and records an **advisory** verdict on the current wave. `checkAdjudication` (schema v9, `lib/advance.js`) then gates advance: **corroborate** clears; anything else is an overridable BLOCK requiring Director disposition (`swarm advance --override --reason`). **An ungated advance is a protocol violation.** Even a unanimous corroborate does not advance a wave alone — `normalizeAdjudication` sets `advances_wave_alone: false`, because the deterministic floor must pass too and outranks the jury in gate precedence.

**The clerk prepares; it must not persuade.** Two things flow from the producer side to the jury and they get opposite handling: the producer's **justification** ("it's right *because* Y") is persuasion and is stripped; the **task specification** (objective, falsifiable criteria, grounding evidence) is the rubric and must be provided — withholding it is what *causes* local jurors to hallucinate confident verdicts instead of abstaining. `toJuryRequest()` is **fail-closed**: it runs the neutrality lint and throws `CaseFileNeutralityError` before the jury is ever called.

**The two tiers.** `--jury=local` (default, free) gives diversity **across** seats — one judgment per seat. `--jury=prism` gives L3 (four decorrelated lenses) + L4 (submodularity collapse-refusal) **within** each seat, per criterion, plus a signed Ed25519 receipt per call. Slower, abstains more, by design. prism needs `PRISM_SIGNING_KEY` or it fails closed on an unsigned receipt.

**Read `docs/case-file-contract.md` before your first `swarm adjudicate`.** Its "honest boundary" tables state what each tier does **not** give you — those are load-bearing, not caveats.

## Standards compliance

Scored against the six [workflow standards](../.claude/rules/workflow-standards.md), 0–3. **Total: 11 / 18.** Last scored 2026-07-15 (run `swarm-1784091637-5127`, Stage A).

| Standard | Score | Evidence | Remediation |
|---|---|---|---|
| PIN_PER_STEP | **2** | Each wave writes its agent prompts to `swarms/<run-id>/wave-N/<domain>.md` (the byte-exact brief is on disk), captures a `domain_snapshot_id` at dispatch that `collect` validates against, and records output artifacts with a SHA-256. So the *prompt* and the *domain contract* are pinned and enforced. | **The resolved model id is not recorded anywhere**, so a wave is reproducible in brief but not byte-for-byte replayable. P1: persist `model` + prompt SHA-256 per `agent_run`. |
| ANDON_AUTHORITY | **2** | Real and firing: `collect` moves a bad output to `invalid_output` / `ownership_violation` — BLOCKED statuses with no outbound transition that require an explicit coordinator override carrying a reason; the wave flips to `failed` on any validation error; `doctor` exits non-zero on hard FAIL. Trial C of the 2026-04-11 dogfood proved a malformed output is blocked, not silently retried. | **Not a 3, because this run proved four gates certified success in exactly the state they exist to catch** (`redrive` receipt-integrity, `fingerprint` deferred-protection, `check-finding-regression-pins`, `PROVENANCE_ADAPTERS`) — all four have since been fixed with mutation-proof pins (waves 2 and 4), but the class outlives its instances. An andon that cannot fire is not authority. P0: every gate ships a meta-test that mutates the protected thing and asserts RED — see [Proving a gate](#proving-a-gate). |
| NAMED_COMPENSATORS | **2** | The compensators table below is now complete and every swarm-state action has a named, dry-run-by-default, reason-required undo (`rewind` / `redrive` / `revalidate` / `clean`), each writing its own audit row. | **Not a 3: no rollback meta-test exists.** A compensator that has never been proven to restore is prose. P1: a drill that mutates state, runs the compensator, and asserts the pre-state is restored. (`redrive`'s integrity assert, previously listed here as running after its transaction commits, now runs inside the transaction and rolls back on mismatch — F-ad3004f4, wave 2.) |
| DECOMPOSE_BY_SECRETS | **2** | The frozen domain map is exactly this standard: draft → edit → freeze, exclusive file ownership, glob-specificity arbitration via `resolveExclusiveOwner`, enforced at collect time against the snapshot captured at dispatch. Every change is logged to `domain_events`. | **The independent attribution is unsound in the default mode.** Without `--isolate`, all agents share one worktree and git cannot attribute a file to an agent, so an agent that silently edits out-of-domain *and* omits the file from `files_changed` is not caught. `--isolate` restores soundness but is opt-in, and Ji et al. 2026 (arXiv:2607.02294) measured **55.8–67.8% of coding-agent runs violating at least one boundary** — so the unsound mode is the default while the base rate is a coin flip. P0: flip the default. See §Ownership attribution in non-isolated parallel amend waves. |
| UNCERTAINTY_GATED_HUMANS | **1** | The `[!] OWNERSHIP PROBE DEGRADED [!]` banner is a genuine uncertainty surface: it tells the operator the guarantee weakened and names the remedy. | **The review gates fire on phase boundary, not uncertainty** — Phase 2 and Phase 6 checkpoint every time regardless of how certain the wave is, which trains the operator to rubber-stamp. No checkpoint uses contrastive framing ("you probably expected X; I did Y because…"). P1: gate the review on disagreement/uncertainty, and frame contrastively (Buçinca et al. 2024, arXiv:2410.04253). |
| EXTERNAL_VERIFIER | **2** | `swarm adjudicate` runs a live cross-family jury with a prism-per-seat tier (L3/L4 per seat), and the citation gate defers to a different model family with the caller's reasoning stripped. The standard is implemented, not just named. | **One live hole, and one closed.** CLOSED: `buildSeatEnv` was a *denylist* over the ambient env; it is now an explicit `AMBIENT_PASSTHROUGH_KEYS` allowlist (Saltzer & Schroeder 1975 — base access decisions on permission, not exclusion), so ambient config can no longer silently weaken what the jury guarantees. OPEN (P0): **severity is assigned by the same agent that authored the finding** — the self-preference configuration Panickssery et al. 2024 (arXiv:2404.13076) predicts inflates. Remedy: a cross-family severity panel (Verga et al. 2024, arXiv:2404.18796) with an anchored rubric (Kim et al. 2024, arXiv:2310.08491); keep pointwise labels — Tripathi et al. 2025 (arXiv:2504.14716) measures pairwise flipping 35% vs pointwise 9%. |

> **A retracted number, kept visible on purpose (2026-07-15).** Earlier revisions of this table
> cited "this repo's measured 16→6 HIGH deflation" as established history, and it circulated for a
> full session as the local evidence for the severity remediation above. **It is unsubstantiated.**
> A wave-3 audit queried the control plane directly: the cited run shows **9 HIGH / 35 MEDIUM /
> 16 LOW**, all `approved`, with **no evidence of any re-rating** — and no 16, and no 6.
>
> The reason it could never have been checked is the useful part: **`findings` has no
> `severity_original` column.** The schema cannot record that a severity ever changed, so a
> deflation claim is unfalsifiable here *by construction*. The number wasn't measured and couldn't
> have been. It reached a public spec because a coordinator propagated it from a memory file
> without running the one query that refutes it — while, in the same session, instructing agents to
> verify a finding's named mechanism against source before trusting its severity.
>
> **The remediation above still stands, on the literature rather than on us.** Panickssery et al.
> 2024 predicts inflation for exactly this configuration; that citation was independently verified
> against the paper, as were the other two 2026 arXiv citations in this document. What died is only
> the "and we measured it ourselves" claim. **If the repo wants that evidence, it has to build the
> column first** — which is itself a finding: this protocol cannot currently measure the bias it
> names as a P0.

### Compensators

Every world-touching action this protocol performs, its named undo, the post-rollback state, and the owner. **No skip** — the org rule forbids it for any workflow with irreversible calls, and Phase 10 has several.

**Swarm execution (Phases 1–9).** All reversible; all dry-run by default and reason-required.

| Action | Irreversible? | Compensator | Post-rollback state | Owner |
|---|---|---|---|---|
| Agents edit the working tree | No | **`swarm rewind <save-point-tag> --reason "<text>" --apply`** | Tree restored to the save point; orphaned in-flight rows → `aborted_for_rewind`, preserved as forensic evidence | coordinator |
| Wave dispatched; a subset of agents failed | No | **`swarm redrive <run-id> --reason "<text>" --apply`** | Same `wave_id` resumed; completed receipts survive byte-identical; only the failure tail is re-dispatchable | coordinator |
| `agent_run` blocked (`invalid_output` / `ownership_violation`) | No | **`swarm revalidate <run-id> --domain=… --reason "<text>" --apply`** | Agent → `complete` via the override path, with the reason recorded in `agent_state_events`; refuses if the corrected state still fails the checks | coordinator |
| `--isolate` created per-agent git worktrees | No | **`swarm clean <run-id> --apply`** | Worktrees removed; unchanged ones auto-pruned | coordinator |
| Control-plane rows written | Append-only by design | **none needed** — `*_state_events` is the audit trail; never `UPDATE` around it | History is the record; correct forward via the verbs above | coordinator |
| N paid LLM agents dispatched | **Yes** — spent tokens have no undo | **`none` — bounded, owner-accepted cost** (honest treatment of an unavoidable spend, not a real undo) | Tokens spent | coordinator — bounds via ≤10 agents/wave and the per-wave finding cap |

**Full Treatment (Phase 10).** These leave the machine. Each one needs its named undo *before* it is invoked.

| Action | Irreversible? | Compensator | Post-rollback state | Owner |
|---|---|---|---|---|
| `npm publish` | **Yes** — unpublish is only permitted within 72h, and the name@version is burned permanently either way | **`npm deprecate <pkg>@<version> "<reason>"`** + publish a corrected patch | Version still resolvable but flagged at install; consumers steered to the patch. **You cannot un-ship it** | coordinator |
| `gh release create` | Mostly | **`gh release delete <tag> --yes`** | Release page gone; the git tag survives unless also deleted | coordinator |
| `git push <tag>` | Mostly | **`git push --delete origin <tag>`** | Tag gone from the remote; anyone who already fetched it keeps it | coordinator |
| `git push` to `main` | Mostly | **`git revert <sha> && git push`** — never force-push a shared branch | Change reverted forward; history preserved | coordinator |
| GitHub Pages deploy | No | **Re-run `pages.yml` from the prior commit** | Previous site restored | coordinator |
| `gh repo edit` (description/homepage/topics) | No | **Re-apply the prior values** (capture them first) | Metadata restored | coordinator |
| repo-knowledge DB write | No | **Re-run `scan`** | DB regenerated from source | coordinator |
| A consumer submission committed to `main` by `ingest.yml` | Mostly | **`git revert <sha>` + `rebuild-indexes`** | Record removed and indexes rebuilt; the commit stays in history | coordinator |

### Proving a gate

A gate is not verified because its suite is green. **"Passes N/N" ≠ "seals."** A gate is verified when a **meta-test mutates the thing it protects and asserts the gate goes RED** — delete the documented code and the drift check must fire; force a second module instance and the counter must tick 1→2; empty the watch-set and the integrity check must report `not_applicable`, never a vacuous `true`.

Include **deletion and emptiness** operators explicitly, not just value perturbation. Just et al. 2014 (DOI 10.1145/2635868.2635929) measured that mutant detection tracks real-fault detection more strongly than coverage does — **but that 17% of real faults couple to no mutant at all, "mostly involving algorithmic changes or code deletion."** Every vacuous gate this protocol has shipped was deletion-shaped: an empty watch-set, an empty agent list, a pattern matching nothing. Value-perturbing mutation is blind to exactly that class.

Keep it cheap. Petrovic et al. 2022 (DOI 10.1109/TSE.2021.3107634) report Google made mutation testing viable at scale by surfacing **one mutant per covered line in code review and reporting no mutation score** — no overhead complaints from thousands of developers. Mutate one gate per diff; do not build a mutation matrix.

### Fixing a class, not an instance

**An amend is not done when the named instance is green. It is done when you have swept for siblings and found none.** This is the single most expensive lesson this protocol has: run `swarm-1784091637-5127` spent waves 16→21 rediscovering it, and every wave's confirming audit caught the previous wave's fixes patching the one instance in front of them. The audit is not a formality that finds churn — **it is the mechanism that catches instance-patches masquerading as class-fixes**, and it worked every single time.

This repo already encoded this lesson **for documentation** — doc-drift Class #11, "multi-occurrence fix completeness … per-instance fixes are anti-pattern" (see the comment above `## The 10-Phase Play`). It was never generalized to code. Generalize it:

**Before writing any fix, grep for the defect's shape across the whole tree. Put the sweep's result in your output — including "swept, found none."** A sweep that finds nothing is evidence; a sweep you didn't run is a finding waiting to be filed against you. Measured on the run above: a coordinator sweep for one bad identifier found it in **four** files where the audit had named one; a sweep for a stale claim found it inside the gate's own console output, echoed on every run for two waves after the "fix."

Five sub-laws, each earned by a real defect on that run:

1. **The authoritative source, never memory.** Finding ids come from the control-plane DB (the brief is generated from it) — never from an audit's `output.json`, whose ids are agent-local labels. Scope comes from the frozen domain map — never from a coordinator's prose. Coverage comes from the gate's own output — never from recollection. Three consecutive waves shipped auditor-local ids into briefs, and one reached four code artifacts as an id that does not exist.
2. **A detector's blind spot IS the defect.** When a sweep misses an instance, the instance is the symptom; fix the sweep. A sweep searching for `spawnSync` missed `execFileSync` twice — and when it was made call-shape-agnostic it immediately surfaced a further instance using **the very name the original searched for**, proving the gap was never the spelling but that no sweep had enumerated the population. **Enumerate the population independently and diff it against what your detector sees.**
3. **Prose is not code.** Any gate that greps raw source will eventually credit a comment (false grant) or trip on one (false positive). Both happened here: the pin matcher leaked on seven consecutive audits crediting prose, and a wave-2 pin false-positived when a comment mentioned the very call it forbids. **Strip comments before asserting** — `packages/dogfood-swarm/test-support/strip-comments.js` exists for this.
4. **"Passes against real data" can be true and useless.** A verification that cannot fail is not a verification. One wave claimed "zero false rejections against the real corpus" — true, and worthless: the corpus contained zero records of the shape under test. The next wave's matrix varied every axis except the one its own warning was about. **Exercise the shape, not the corpus** — and state which axes you varied.
5. **A fix is not done until its consumer is wired, and a count is not integrity.** A helper exported and unit-tested but imported by zero production code does not close its finding (the finding's own stated goal went unmet for two waves). A frozen manifest guarded by `length === 256` is guarded by a headcount: swap a drained id for a fresh one and the count holds. **Content-address what must not change** (RFC 8785 + SHA-256 — as the grandfather-manifest gate now does via `EXPECTED_GRANDFATHER_MANIFEST_HASH`, and as `packages/ingest/lib/integrity.js` does for the record hash-chain), and check the consumer, not just the artifact.

---

## Prerequisites

- Target repo exists under `mcp-tool-shop-org` or `dogfood-lab` (or `mcp-tool-shop` for marketing repos)
- Local clone of the target repo on disk; `origin` points to the correct remote
- Git working tree clean on the target repo (no uncommitted changes)
- Save point tag created before first wave for easy revert

---

<!-- drift-checked by scripts/check-doc-drift.mjs — see Class #11 (multi-occurrence fix completeness). Update all Stage D / 10-Phase mentions together; per-instance fixes are anti-pattern. -->

## The 10-Phase Play

The protocol has two repeating passes plus a final test phase and full treatment:

- **Health Pass** (Phases 1-4) — Audit and fix bugs, security, code quality, type safety, test coverage, doc accuracy across **four pre-feature stages** (A bug/security, B proactive health, C humanization, D visual polish). Repeat until clean bill of health.
- **Feature Pass** (Phases 5-8) — Audit and build missing capabilities, feature gaps, UX improvements. Repeat until production-ready.
- **Final** (Phase 9) — Comprehensive test validation.
- **Full Treatment** (Phase 10) — Shipcheck, branding, landing page, handbook, translations, repo-knowledge DB. The repo is not "done" until it's whole.

---

## Health Pass (Phases 1-4) — Four stages to clean bill of health

The Health Pass has four distinct stages, each applying a different lens. Stages A and D each run a full Audit → Review → Amend → Repeat cycle (Phases 1-4) within the stage itself. Stages B and C instead split one such cycle across the stage boundary — B audits and reviews, C amends what B found — rather than each independently repeating the whole cycle:

- **Stage A: Bug/Security Fix** — Find and fix defects. Repeat until 0 CRITICAL + 0 HIGH.
- **Stage B: Proactive Health** — Fresh audit with proactive lens (defensive coding, observability, graceful degradation, future-proofing). Review findings.
- **Stage C: Humanization** — Amend the proactive findings with emphasis on USER EXPERIENCE: error messages that help, reconnection feedback, responsive layouts, loading states, state persistence, accessibility. This is the bridge between "not broken" and "actually good to use."
- **Stage D: Visual Polish** — Final pre-feature pass focused on the visual surface: typography/spacing/layout, iconography & assets, color/theming/dark-mode, animated demonstrations, command palette presentation, status bar integration, first-run welcome, settings UI grouping, marketplace/landing-page visuals.

**Key insight:** Proactive health, humanization, and visual polish findings are NOT afterthoughts — they represent the gap between "code that works" and "code that respects the user." The Stage C and Stage D amend waves treat these findings with the same rigor as bug fixes because polish IS quality.

---

### Phase 1: HEALTH AUDIT

Launch 5 parallel agents, one per domain, to audit all components.

1. Create a save point tag before the first wave:
   ```bash
   cd <repo-root>
   git tag swarm-save-$(date +%s)
   ```

2. Launch 5 agents with these domain assignments:

   | Domain | Scope | Typical Files |
   |--------|-------|---------------|
   | Backend | Core server logic | server.py, main modules |
   | Bridge | Secondary services | ws_bridge.py, API bridges |
   | Tests | Test suite | tests/*.py, conftest.py |
   | CI/Docs | Infrastructure + docs | .github/workflows/, *.md, config |
   | Frontend | UI layer | *.html, *.css, *.js |

   For larger repos, expand up to 10 agents by splitting domains.

3. Each agent audits its domain. The audit lens depends on the current stage:

   **Stage A (Bug/Security Fix):**
   - Bugs and logic errors
   - Security vulnerabilities
   - Code quality issues
   - Type safety violations
   - Test coverage gaps
   - Documentation accuracy

   **Stage B (Proactive Health):**
   - Defensive coding gaps (missing guards, unchecked returns)
   - Observability (logging, metrics, health checks)
   - Graceful degradation (offline behavior, partial failure handling)
   - Future-proofing (extensibility, migration paths)

   **Stage C (Humanization):**
   - Error messages: do they help the user fix the problem?
   - Reconnection/retry feedback: does the user know what's happening?
   - Responsive layouts: does the UI work at all breakpoints?
   - Loading states: is there feedback during async operations?
   - State persistence: does the app remember user context across sessions?
   - Accessibility: keyboard navigation, screen reader support, contrast

   **Stage D (Visual Polish):**
   - Typography, spacing, and layout consistency across surfaces
   - Iconography and asset quality (logos, screenshots, social cards, favicons)
   - Color, theming, and dark-mode parity
   - Animated demonstrations / GIFs / motion
   - Command palette and status bar presentation (for editor-integrated tools)
   - First-run welcome and onboarding visuals
   - Settings UI grouping and labeling
   - Marketplace listing visuals and landing-page polish

4. Agent output format:
   ```json
   {
     "domain": "backend",
     "stage": "A|B|C|D",
     "findings": [
       {
         "id": "F-001",
         "severity": "CRITICAL|HIGH|MEDIUM|LOW",
         "category": "bug|security|quality|types|tests|docs|defensive|observability|degradation|future-proofing|ux|accessibility|hygiene|error_message_quality|cli_help_quality|silent_failure|tests_coverage",
         "file": "path/to/file.py",
         "line": 42,
         "description": "What is wrong",
         "recommendation": "How to fix it"
       }
     ],
     "summary": "Brief domain health assessment"
   }
   ```

### Phase 2: REVIEW

Coordinator presents consolidated findings to the user.

1. Merge all agent outputs into a single findings list.
2. Sort by severity: CRITICAL > HIGH > MEDIUM > LOW.
3. Present to user with counts per severity level.
4. User approves, modifies, or rejects findings before any code is written.
5. Record the approvals in the control plane: `swarm approve <run-id> --ids F-…` (or `--all`).

### Phase 3: AMEND

Launch 5 parallel agents with exclusive file ownership to fix all approved findings.

1. Map approved findings back to domain agents. Each agent only edits files within its domain.
2. HARD RULE: No agent edits a file outside its assignment. Validate with:
   ```bash
   cd <repo-root>
   git diff --name-only | sort > /tmp/changed-files.txt
   ```
   Cross-reference every changed file against domain assignments.

3. After all agents complete, verify build passes:
   ```bash
   # Node/TypeScript
   npm run lint && tsc --noEmit && npm test

   # Rust
   cargo check && cargo test

   # Python
   ruff check . && pytest
   ```

4. If build fails, dispatch targeted fix agents for the failing domain only.

### Phase 4: REPEAT

Return to Phase 1 for a fresh audit against the remediated codebase.

- Each cycle is a clean audit — agents do not carry forward prior findings.
- **Checkpoint with user every 3 iterations** to confirm direction.
- **Stage A:** Continue until audit returns 0 CRITICAL + 0 HIGH. Then advance to Stage B.
- **Stage B:** Run one proactive audit cycle. Review findings. Then advance to Stage C.
- **Stage C:** Amend the proactive findings through the humanization lens. When complete, proceed to Stage D.
- **Stage D:** Run one visual-polish audit cycle, then a visual-amend wave. When complete = **clean bill of health**. Proceed to Feature Pass.

---

## Feature Pass (Phases 5-8) — Repeat until production-ready

### Phase 5: FEATURE-FOCUSED AUDIT

Agents audit for capabilities, not defects.

1. Launch 5 agents (same domain split) to evaluate:
   - Missing capabilities and feature gaps
   - Production readiness (error handling, logging, graceful degradation)
   - UX improvements (CLI ergonomics, API surface, user-facing messages)
   - Performance opportunities
   - Integration completeness

2. Agent output format:
   ```json
   {
     "domain": "backend",
     "features": [
       {
         "id": "F-001",
         "priority": "CRITICAL|HIGH|MEDIUM|LOW",
         "category": "missing-feature|ux|performance|integration|production-readiness",
         "description": "What is needed",
         "scope": ["file1.py", "file2.py"],
         "effort": "small|medium|large",
         "recommendation": "How to implement"
       }
     ],
     "summary": "Domain feature assessment"
   }
   ```

### Phase 6: REVIEW

Coordinator presents feature findings to user BEFORE any code is written.

1. Merge all feature findings, sorted by priority.
2. Present to user with effort estimates.
3. User approves which features to build in this wave.
4. **No code is written until user approves the feature list.**

### Phase 7: EXECUTION

Agents build/improve approved features with exclusive file ownership.

1. Map approved features to domain agents.
2. HARD RULE: No agent edits a file outside its assignment.
3. Launch up to 5 agents in parallel.
4. After all agents complete, verify build passes (lint + typecheck + tests).
5. If new tests are needed for new features, the Tests domain agent writes them.

### Phase 8: REPEAT

Return to Phase 5 for a fresh feature audit.

- **Checkpoint with user every 3 iterations.**
- Continue until the codebase is production-ready (no CRITICAL or HIGH feature gaps remain).

---

## Final (Phase 9)

### Phase 9: TEST

Final comprehensive test pass validating everything works together.

1. Run the full test suite:
   ```bash
   # Node/TypeScript
   npm run lint && tsc --noEmit && npm test

   # Rust
   cargo check && cargo test

   # Python
   ruff check . && pytest
   ```

2. Run integration/E2E tests if they exist.
3. Verify no regressions from any wave.
4. Record the final test count and pass rate in the control plane: `swarm verify <run-id>` writes the verification receipt.
5. If any failures, dispatch targeted fix agents and re-run.
6. Proceed to Phase 10 (Full Treatment).

---

## Full Treatment (Phase 10)

The swarm is not complete until the repo receives the Full Treatment. This phase ensures the repo is not just working but *whole* — branded, documented, searchable, and catalogued.

### Prerequisites

- Phase 9 tests must be green.
- Read `memory/full-treatment.md` AND `memory/handbook-playbook.md` from the canonical memory path before starting.
- Shipcheck must pass: `npx @mcptoolshop/shipcheck audit` — if it fails, fix before proceeding.

### Execution

Follow the 7 phases from `full-treatment.md` in order:

1. **Phase 0 — Shipcheck gate**: `npx @mcptoolshop/shipcheck init` + audit. Version bump (v0.x → v1.0.0, or patch bump).
2. **Phase 1 — README + translations**: Logo, badges, footer. Hand user the translation command (user runs locally, NEVER Claude).
3. **Phase 2 — Landing page**: `npx @mcptoolshop/site-theme init`, scaffold site-config, verify base path.
4. **Phase 3 — Handbook**: `npx @mcptoolshop/site-theme handbook --accent <color>`, expand README into 3-7 real doc pages, build + verify.
5. **Phase 4 — Repo metadata + coverage**: GitHub description/homepage/topics, coverage badge if applicable.
6. **Phase 5 — Repo Knowledge DB**: `node dist/cli.js scan`, add thesis/architecture/relationships.
7. **Phase 6 — Commit + deploy**: Stage explicitly (never `git add .`), push, verify landing page + handbook render.

### Completion

After Phase 7 (post-deploy verification) passes:
- Advance the run to `complete`: `swarm advance <run-id>` from the treatment phase records the final promotion.
- Record final metrics: test count, findings fixed, features shipped, treatment phases completed (`swarm verify` receipt + `swarm status`).

### Do NOT

- Skip any treatment phase — they are sequential and interdependent.
- Run translations from Claude — user runs locally via Ollama (zero cost).
- Skip the repo-knowledge DB entry — it's part of the swarm now.
- Mark the swarm complete before the landing page + handbook are live.

---

## Serial final verification after parallel agents

When parallel agents each run `npm test` / `npm run verify` against a worktree containing other agents' WIP edits, the verify reads against cumulative state. Sibling agents see "failures" that are not contract violations but measurement artifacts: an integration test fails because backend hasn't yet landed its half of a coordinated fix; `check-regression-pins` fails because the source pin landed and the sibling pin hasn't yet. This is a Class #14 fractal at the verifier layer — the verifier is in the thing being verified.

The serial-final-verify discipline closes the gap:

1. **Coordinator dispatches with `--skip-verify`** when running an amend wave with parallel agents: `swarm dispatch <run-id> health-amend-a --skip-verify` (see `packages/dogfood-swarm/commands/dispatch.js` SKIP_VERIFY_DIRECTIVE).
2. **Agents make edits, write their output JSON, and stop.** No per-agent `npm test`. Agents emit `verification_skipped: true` at the top level of their output JSON to make the contract explicit (`packages/schemas/src/json/agent-output.schema.json` `verification_skipped`).
3. **`swarm collect` propagates the flag.** When any agent marks `verification_skipped: true`, the collect report sets `serial_verify_required: true` and the CLI surfaces a Next-step hint (`packages/dogfood-swarm/commands/collect.js` `serial_verify_required`).
4. **Coordinator runs ONE `npm run verify` against the cumulative tree** before promoting the wave. This is the only authoritative verification for the wave.

Skip the directive when dispatching a single-agent wave or when agents are not running in parallel — the per-agent verify is then a legitimate independent check, not a vantage-point artifact.

## Ownership attribution in non-isolated parallel amend waves

`swarm collect` enforces exclusive file ownership (Key Principle #1) against the **union** of two sets: the agent's self-reported `files_changed`, and an **independently-computed** touched-file set probed straight from git via `lib/git-touched-files.js` — `git status --porcelain` (uncommitted + untracked) **plus a committed-delta diff against the dispatch base** (the worktree's fork point under `--isolate`, `runs.commit_sha` otherwise; F-4ba6036b — without the committed half, an agent that `git commit`ed inside its worktree vanished from the probe entirely). The independent probe is the part that catches an agent which under-reports `files_changed` — it is the external check on a self-reported field (a Class #14 "verifier in the thing being verified" surface).

That independent check has a **hard prerequisite: per-agent isolation.** When a wave runs WITHOUT `--isolate`, every agent shares one worktree (`run.local_path`), so the git probe returns the cumulative whole-tree diff of *all* agents' edits. git cannot attribute a given file to a given agent. Attributing that union to each agent would flag every *other* domain's legitimate edits as ownership violations and fail a clean wave on phantom cross-domain edits (the bug fixed in `d3b-collect-A-002`). To avoid that, in a non-isolated wave `collect` narrows each agent's independent contribution to the files that agent **exclusively owns** — resolved by the same glob-specificity arbitration `checkOwnership` enforces with (`resolveExclusiveOwner`), NOT by bare glob membership. (`wave2-live-001`: membership-narrowing over-collects when globs overlap — a `**/*.test.*` domain was phantom-flagged for sibling package domains' test-file edits, because membership admitted files whose *exclusive* owner was the package domain.)

The narrowing is correct for the phantom-violation problem, but it carries a **deliberate, documented soundness reduction**:

> **In a non-isolated amend wave, ownership enforcement is sound only for an agent's SELF-REPORTED edits.** An agent that silently edits a file **outside** its domain **and** omits that file from its `files_changed` is no longer caught by the independent probe — the out-of-domain file is filtered out of the independent set because another domain exclusively owns it. The self-reported `files_changed` is still checked in full, so a self-confessed out-of-domain edit is still caught; only the *silent + unreported* case slips through.

**`--isolate` is REQUIRED for full independent cross-domain attribution.** Under `--isolate` each agent gets its own git worktree (`dispatch.js` → `lib/worktree.js`), so the worktree diff holds only that agent's edits, the full diff is attributable, and the independent under-report catch is preserved across domains. Use `--isolate` whenever the wave's ownership guarantee must be sound against an unreported cross-domain edit — i.e. any multi-domain amend wave where you are not hand-reviewing every agent's diff yourself.

How the weakened guarantee is surfaced (so it is never silent):

- **Per agent:** the agent's collect record carries an `ownership_probe_degraded` note (`{ isolated: false, reason: … }`) pointing the operator at `--isolate` (`packages/dogfood-swarm/commands/collect.js`).
- **Per wave:** when two or more domains were degraded in one shared worktree, the collect report sets `ownership_probe_degraded.multi_domain = true` and the CLI prints an `[!] OWNERSHIP PROBE DEGRADED [!]` banner recommending `--isolate`. This is observability only — like the `files_changed` divergence note, it never changes the exit code or the wave gate.

The gate itself is unchanged: a real, self-reported out-of-domain edit still flips the agent to `ownership_violation` and the wave to `failed` in either mode. `--isolate` widens *what the independent probe can prove*, not what the gate does once a violation is known.

## Recovery from blocked agent_runs: `swarm revalidate`

Sometimes an amend wave's `swarm collect` rejects every agent's output for a schema or ownership reason that is real but **recoverable**: the agent did the work, the work is correct on disk, the JSON envelope drifted from the canonical shape (`fixes_applied` vs `fixes`; `files_edited` vs `files_changed`), or the coordinator-frozen domain map omitted a glob the brief told the agent to edit. In those cases the four `agent_runs` move to a blocked status, the wave moves to `failed`, and nothing in the audit lane offers a path back. The lawful recovery verb for that exact shape is `swarm revalidate`.

### The two blocked statuses

`packages/dogfood-swarm/lib/state-machine.js` defines a 9-status state machine for `agent_runs` (pending, dispatched, running, complete, failed, timed_out, invalid_output, ownership_violation, aborted_for_rewind — matching the handbook's "The 9 canonical statuses"). Two of those statuses form the BLOCKED_STATUSES set declared in the same module — `invalid_output` and `ownership_violation`. Neither has any outbound transition in the normal `TRANSITIONS` map; the state-machine deliberately requires explicit coordinator override to move them.

- **`invalid_output`** — the agent's JSON failed the canonical `agent-output.schema.json` envelope, the legacy `validateAuditOutput` / `validateFeatureOutput` / `validateAmendOutput`, or one of the legacy normalization passes downstream. The output is on disk; the gate refused it.
- **`ownership_violation`** — the agent's `files_changed` set contains paths that lie outside the agent's frozen domain map. The work landed in the worktree; ownership accounting refused to claim it.

These are repairable but never auto-retryable: the source of failure was not transient, and any retry without operator review would either repeat the violation or paper over a real drift.

### The override primitive (library level)

The canonical override has lived in `packages/dogfood-swarm/lib/state-machine.js` since the BLOCKED_STATUSES set was introduced:

```text
transitionAgent(
  db,
  agentRunId,
  'complete',
  reason,
  /* override */ true
)
```

Override requires a non-empty `reason` (`state-machine.js` line 106: `throw new Error('Override requires a reason …')`). The transition writes a row to `agent_state_events` capturing `from_status`, `to_status`, the reason, and the timestamp — the same audit trail every normal transition produces, but explicitly flagged as an override. Until `v1.1.7-…`, this primitive had no operator-facing CLI surface; recovery required raw SQL.

### The CLI verb

`swarm revalidate` exposes the override lawfully:

```text
Usage: swarm revalidate <run-id>
  --reason "<text>"
  --domain=name:path
  [--domain=name:path ...]
  [--apply]
```

Behavior (from `packages/dogfood-swarm/commands/revalidate.js`):

1. **Dry-run by default.** No `--apply` ⇒ revalidate inspects each corrected output JSON against the same envelope schema + legacy validator + ownership check that `collect` would have run, builds a `report.repairs[]` list of "would transition", and returns without touching the DB. The repair preview lets the operator see what would change before any state leaves disk.
2. **`--apply` is required to mutate.** With `--apply` and at least one repair planned, revalidate opens a single SQLite transaction and per repair: calls `transitionAgent(db, ar.id, 'complete', reason, true)`, records the output artifact with its SHA-256, mirrors the `file_claims` rows `collect` would have written for amend outputs.
3. **`--reason "<text>"` is mandatory.** The library rejects empty/whitespace reasons before any DB connection is opened. The reason is recorded verbatim in `agent_state_events` for every override transition in the wave.
4. **Refusals are first-class.** If the corrected JSON still fails the envelope, the legacy validator, or the ownership check, revalidate refuses the repair and records the refusal in `report.refusals[]` — the agent_run stays in its blocked status, and the operator sees a structured reason rather than a silent ignore. Already-complete rows are skipped idempotently.
5. **Wave-level rollback in the same transaction.** `collect.js:373-377` sets `waves.status='failed'` when `validation_errors > 0`. Revalidate mirrors the inverse direction: after every per-repair override, if every latest `agent_run` in the wave is now `complete` AND the wave was `failed`, the same transaction also runs `UPDATE waves SET status='collected', completed_at=datetime('now') WHERE id = ?`. Same transaction prevents the torn-state regression (agents complete, wave still `failed`) if the process crashes mid-flight. Partial repair (N=4 blocked, repair N-1) keeps the wave in `failed` deliberately — only full repair flips the wave back.

### When to use it (and when not)

Use `swarm revalidate` when:

- `swarm collect` reports `validation_errors > 0` and the wave is `failed`.
- The output JSON on disk is correct (or has been hand-corrected) and reflects work the agent actually did.
- The reason is documentable in one sentence (it becomes part of the run's audit history).

Do NOT use `swarm revalidate` to bypass a real ownership violation. If an agent genuinely edited files outside its domain, the lawful response is to roll back the work, fix the domain map (or the brief), and re-dispatch — not to override the gate. Revalidate refuses repairs that still fail ownership checks for exactly this reason: the override path only opens when the corrected state passes the same checks `collect` would have applied.

### Architectural grounding

The shape — "executed but produced invalid output is repairable in place, with a required reason captured in audit history" — appears across the workflow-orchestration field: AWS Step Functions Redrive, Temporal workflow reset, Airflow `clear` / `set-state`, Argo retry, GitHub Actions `rerun --failed`. Direct DB intervention is universally last-resort; toolchains mediate state mutation through tooled commands that emit an event-sourced audit row alongside the UPDATE (Stripe Ledger correction-event pattern). `swarm revalidate` is the testing-os instance of that family.

### Cross-references

- State-machine contract and override primitive: [Handbook → State Machines](../site/src/content/docs/handbook/state-machines.md) `agent_runs` section.
- Source: `packages/dogfood-swarm/commands/revalidate.js` (file header documents the architectural grounding in line-numbered detail).
- Tests: `packages/dogfood-swarm/revalidate.test.js` (11 cases; the partial-vs-full-repair wave-rollback is the regression anchor for this section).

---

## Key Principles

0. **Public surfaces are coordinator-authored (LAW)** — README + translations, docs/handbook, landing page, CHANGELOG, repo metadata, package descriptions, and any marketing copy are authored PERSONALLY by the coordinator. Never assign a public-surface file to a subagent or spawn a docs/readme/landing-page/marketing agent. The docs domain may be a frozen domain (so no other agent touches it) but the coordinator executes it by hand. In-code user-facing strings (CLI `--help`, error messages) a feature agent drafts get a personal coordinator review-and-rewrite pass. Earned 2026-06-20 (backpropagate v1.7).
1. **Exclusive File Ownership** — No agent edits a file outside its assignment. Violations trigger revert. The *independent* (non-self-reported) ownership check is sound across domains only under `--isolate`; in a non-isolated parallel amend wave it covers each agent's self-reported edits plus its own domain's files — see §Ownership attribution in non-isolated parallel amend waves.
2. **Wave Size** — Max 5 agents per wave (one per domain). Expand to max 10 for large repos by splitting domains.
3. **Severity Triage** — All findings are triaged CRITICAL/HIGH/MEDIUM/LOW. Remediation follows severity order.
4. **Build After Every Wave** — Build must pass after every amend/execution wave (lint + typecheck + tests).
5. **Save Point** — Tag before first wave for easy revert.
6. **Four-Stage Pre-Feature** — Stage A fixes bugs/security, Stage B applies proactive hardening, Stage C humanizes behavior/text, Stage D polishes visuals. All four complete before features.
7. **Health Before Features** — Feature execution only begins after clean bill of health.
8. **User Reviews First** — User reviews feature audit BEFORE execution begins. No code without approval.
9. **Control-Plane Checkpoint** — the SQLite control plane (`swarms/control-plane.db`) is the single source of swarm state for resumability. See §Run state — there is no `manifest.json`.
10. **Evidence Persisted** — Evidence persisted to repo-knowledge DB after each wave.

---

## Domain Agent Assignments

| Domain | Scope | Typical Files |
|--------|-------|---------------|
| Backend | Core server logic | server.py, main modules, core packages |
| Bridge | Secondary services, APIs | ws_bridge.py, API bridges, middleware |
| Tests | Test suite, fixtures | tests/*.py, conftest.py, test helpers |
| CI/Docs | Infrastructure + documentation | .github/workflows/, *.md, config files |
| Frontend | UI layer | *.html, *.css, *.js, templates |

Adjust domains to match the repo's architecture. The key constraint is that every file belongs to exactly one domain, and no two agents share files.

---

## Run state — the control plane, not a manifest

**There is no `manifest.json`.** Run state lives in the SQLite control plane at `swarms/control-plane.db`, created by `swarm init` and mutated only through the CLI verbs. The DB is canonical; every JSON artifact on disk (wave receipts, collect reports, adjudication receipts) is a derived export of it.

This supersedes the hand-maintained manifest the protocol described before the control plane existed; Key Principle #9 (Control-Plane Checkpoint) states the same rule. The vestigial `swarms/manifest-schema.json` — the schema for the artifact this section retires — carries a deprecation `$comment` and is kept only because paths under `swarms/` are published API.

Read state with `swarm status <run-id>` — it renders the run, the frozen domain map, the current wave, per-agent status, finding counts by severity, and the next action. Add `--format=json` for the structured object. `swarm runs` lists every run; `swarm history <wave-id>` renders a wave's transition chain, including any override-and-reason record.

---

## Resuming an Interrupted Swarm

```bash
swarm status <run-id>    # what phase/wave, which agents completed vs. missing
swarm resume <run-id>    # redispatch only the incomplete agents
```

`swarm resume` is state-machine-driven: it reads `agent_runs` from the control plane, applies the run's timeout policy to transition stale agents deterministically, and redispatches only what is genuinely incomplete. Agents already `complete` are never re-run.

Three distinct recovery verbs exist, and picking the wrong one wastes a wave — see [Recovery verbs](#recovery-verbs) below for when each applies.

---

## Recovery verbs

**Rewind erases. Redrive resumes. Revalidate ratifies.** They are siblings, not synonyms.

| Verb | Use it when | Effect |
|------|-------------|--------|
| `swarm revalidate <run-id>` | An agent did the work correctly but its output JSON was rejected by the schema or ownership gate, and the JSON on disk is now correct | Repairs blocked `agent_runs` in place (BLOCKED → `complete`); flips the wave back to `collected` only when every latest agent_run is `complete` |
| `swarm rewind <save-point-tag>` | The slice itself was a wrong turn and you want the working tree back at the save point | Restores the tree to the tag and lawfully aborts orphaned in-flight rows (status → `aborted_for_rewind`, preserved as forensic evidence) |
| `swarm redrive <run-id>` | The slice was right but a subset of agents failed mid-flight | Resumes the same `wave_id`; completed receipts survive byte-identical, only eligible failed/unstarted agents become re-dispatchable |

All three share four contracts: **dry-run by default** (`--apply` required to mutate), **`--reason "<text>"` is mandatory** (recorded verbatim in the audit row, prefixed by verb name so the trail is greppable by intent), **zero raw SQL** (all mutations go through `transitionAgent` / `transitionWave` so no write skips its audit row), and **single transaction** (a partial write cannot leave agents `complete` while the wave stays `failed`).

Do NOT use `revalidate` to bypass a real ownership violation. If an agent genuinely edited outside its domain, roll back, fix the domain map or the brief, and re-dispatch. Revalidate refuses repairs that still fail the checks `collect` would have applied — the override path opens only when the corrected state passes those same checks.

The full contract, including the state machine and the `--force-arbitrary-ref` edge, lives in the handbook: [Recovery — The Three R's](../site/src/content/docs/handbook/recovery.md).

### The rest of the verb surface

`swarm --help` is authoritative. The verbs this protocol leans on most: `init`, `domains` (show/edit/freeze/unfreeze/history), `dispatch`, `collect`, `approve`, `defer`, `reject`, `findings`, `status`, `receipt`, `verify`, `adjudicate`, `persist`, `clean`, `doctor`, `runs`, `trends`, `history`.

Two are worth calling out because they are easy to miss:

- **`swarm doctor`** — read-only preflight. Run it before `init` on a new rig: it checks Node ≥ 22, that the control-plane dir is writable **and hardlink-capable** (the file-lock CAS needs `link(2)`; exFAT/FAT32 fail), that the on-disk schema is not newer than the build, and that git is available for the ownership probe and `--isolate` worktrees.
- **`swarm defer` / `swarm reject`** — dispose of a finding without a fix. `defer` = consciously accepted/postponed; `reject` = triaged away as not-a-defect. Both close the finding for the gate, both require `--ids` and `--reason`, and neither has an `--all`. Use them instead of leaving a finding open to keep failing the exit gate.

---

## Proven Results

| Repo | Waves | Start Tests | End Tests | Findings Fixed | Evidence |
|------|-------|-------------|-----------|----------------|----------|
| testing-os v1.9.0 | Stage A–D health pass + feature pass | ~2,106 | ~2,700+ | ~162 pinned | run `swarm-1783007856-9fdb` in `swarms/control-plane.db` (`swarm status`, `swarm receipt`) |
| claude-collaborate | Stage A (2) + B (1) + C (1) | 35 | 71 | 106 | pre-control-plane; hand-recorded, not reconstructible |
| stillpoint | Stage A (3) + B (1) + C (2) + Feature (3) | 26 | 136 | 70 health + ~50 features | pre-control-plane; hand-recorded, not reconstructible |

The two 2026-03 rows predate the control plane, so their numbers cannot be re-derived from any artifact — they are reported here as history, not as evidence. The `testing-os` row is the first that a reader can independently check: the run is in the control plane, and `swarm status <run-id>` / `swarm receipt <run-id>` will render it. Prefer control-plane-backed rows when adding to this table; a number nobody can recompute is a claim, not a proof.

---

## Coordinator Checklist (Quick Reference)

```
HEALTH PASS — STAGE A (Bug/Security Fix)
 1. [ ] Create save point tag
 2. [ ] Launch 5 health audit agents (bug/security lens)
 3. [ ] Collect findings, sort by severity
 4. [ ] Present findings to user for approval
 5. [ ] Launch 5 amend agents with exclusive file ownership
 6. [ ] Verify build passes (lint + typecheck + tests)
 7. [ ] Repeat until 0 CRITICAL + 0 HIGH
 8. [ ] Checkpoint with user every 3 iterations

HEALTH PASS — STAGE B (Proactive Health)
 9. [ ] Launch 5 audit agents (proactive lens: defensive coding, observability, degradation, future-proofing)
10. [ ] Present proactive findings to user for approval

HEALTH PASS — STAGE C (Humanization)
11. [ ] Launch 5 amend agents to fix proactive findings with UX emphasis
12. [ ] Focus: error messages, reconnection feedback, loading states, state persistence, accessibility
13. [ ] Verify build passes
14. [ ] Stage C complete — proceed to Stage D

HEALTH PASS — STAGE D (Visual Polish)
15. [ ] Launch 5 visual-polish audit agents (typography/spacing, iconography, color/theming, motion, command palette, status bar, first-run, settings UI, marketplace visuals)
16. [ ] Present visual findings to user for approval
17. [ ] Launch 5 stage-d-amend agents with exclusive file ownership
18. [ ] Verify build passes
19. [ ] Clean bill of health confirmed — proceed to Feature Pass

FEATURE PASS
20. [ ] Launch 5 feature audit agents
21. [ ] Present feature findings to user for approval
22. [ ] Launch 5 execution agents for approved features
23. [ ] Verify build passes
24. [ ] Repeat until production-ready
25. [ ] Checkpoint with user every 3 iterations

FINAL
26. [ ] Run comprehensive test pass
27. [ ] Record final test count and pass rate

FULL TREATMENT (Phase 10)
28. [ ] Read full-treatment.md + handbook-playbook.md
29. [ ] Shipcheck: npx @mcptoolshop/shipcheck audit (must exit 0)
30. [ ] Version bump (v0.x → v1.0.0, or patch bump)
31. [ ] Logo to brand repo, README finalized
32. [ ] Hand user translation command (user runs locally)
33. [ ] Scaffold landing page (site-theme init)
34. [ ] Scaffold + write handbook (3-7 pages from README)
35. [ ] Build + verify site: npm run build in site/
36. [ ] GitHub metadata: description, homepage, topics
37. [ ] Repo-knowledge DB: scan, thesis, architecture, relationships
38. [ ] Commit + deploy (explicit staging, never git add .)
39. [ ] Post-deploy verify: landing page, handbook, pagefind, CI green
40. [ ] Advance the run to complete (swarm advance <run-id> — final promotion)
```
