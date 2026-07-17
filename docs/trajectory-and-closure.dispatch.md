# Feature Pass dispatch — the Trajectory Layer and the Closure Verbs

> **THE CONTRACT.** This document locks the architecture for the two Director-mandated
> features of the run `swarm-1784091637-5127` Feature Pass: (1) a cross-run
> **trajectory layer** so future dogfood-swarms on a repo start targeted instead of
> cold, and (2) the **closure verbs** that end the "no lawful reopen / unclosable row"
> gap. Feature-audit lanes refine and extend this within their domains; they do not
> relitigate the locked decisions without evidence of the caliber below. Sibling
> precedent: [pin-matcher-rewrite.dispatch.md](pin-matcher-rewrite.dispatch.md).

## Standards compliance (.claude/rules/workflow-standards.md)

| Standard | Score | Evidence |
|---|---|---|
| PIN_PER_STEP | 2 | Waves dispatch generated briefs pinned per wave under `swarms/<run>/wave-N/`; agent model + status recorded per `agent_runs` row; this dispatch doc is the pinned feature contract. |
| ANDON_AUTHORITY | 2 | Any lane may refuse out-of-scope work (proven waves 29, 35); `collect` halts the wave on schema/ownership violations (proven on the coordinator, wave 35); the serial verify halts the merge. |
| NAMED_COMPENSATORS | 2 | The pass's irreversible surfaces and their undos: `swarm reopen` ↔ `swarm close` (each undoes the other, both append `finding_events` rows, owner: coordinator); roadmap artifacts are versioned-supersede-only (compensator: point `latest` back to the prior version, owner: coordinator); `git push` to the swarm branch (compensator: revert commit, owner: coordinator). No `npm publish`/`gh release` occurs in this pass. |
| DECOMPOSE_BY_SECRETS | 2 | Work splits by the frozen domain map (verbs/core/tests/ci/docs/backend), which groups by what changes together; the roadmap compiler is a core `lib/` concern, its verbs are `commands/` concerns, its gates are `scripts/` concerns. |
| UNCERTAINTY_GATED_HUMANS | 2 | The Director gated entry to this pass explicitly; feature-audit results are presented before execution; contrastive framing used at each gate ("you probably thought a prose roadmap; the evidence says compiled artifact because…"). |
| EXTERNAL_VERIFIER | 2 | Audit lanes ≠ execute lanes; coordinator mechanism changes require adversarial skeptic rounds (0-for-4 solo record this run, 2-for-2 with skeptics); the non-Claude jury remains available for verdict adjudication. |

No score below 2; no skips claimed.

## Research grounding (study-swarm, 2026-07-17 — five parallel packets, every URL fetch-verified)

**Q1 — agent memory across sessions.** Reflection-distilled beats raw replay (Park et al. 2023, Generative Agents, arXiv:2304.03442; Wang et al. 2024, Agent Workflow Memory, arXiv:2409.07429 — +24.6%/+51.1% task success from abstracted workflows vs raw trajectories). Bounded lesson buffers beat unbounded (Shinn et al. 2023, Reflexion, arXiv:2303.11366). Persist-only-verified: Voyager's skill library accepts nothing that hasn't survived execution feedback (Wang et al. 2023, arXiv:2305.16291). Memory needs decay/reinforcement (Zhong et al. 2023, MemoryBank, arXiv:2305.10250). Injection position matters — buried-middle content is under-used (Liu et al. 2023, Lost in the Middle, arXiv:2307.03172). Addressable-paged beats monolithic injection (Packer et al. 2023, MemGPT, arXiv:2310.08560). **The decisive negative result:** Anthropic's Project Vend (2025, anthropic.com/research/project-vend-1) — a long-horizon agent's narrative correction did not hold across days; persisted lessons are not self-enforcing and must be paired with mechanical verifiers.

**Q2 — reopen/close semantics.** GitHub's two-states-plus-mandatory-`state_reason` model is sufficient machinery (docs.github.com REST issues; 2022 changelog). Closer and verifier are distinct authorities (WebKit bug life cycle, webkit.org/bug-life-cycle). Reopen must reset closure provenance, not just flip status, and gate authority explicitly (Atlassian KB, "allow issues to be reopened"). Record *how* a fix was verified — review-caught bugs reopen less than self-attested ones (Zimmermann et al., ICSE-SEIP 2012, Windows reopened-bugs). Closure rationale text is predictive, therefore required and indexed (Shihab et al., WCRE 2010 / EMSE 2013). Reopen-prediction does not generalize — 34% of projects reach usable AUC; 94% of reopens trace to bad patches (Tagra et al., EMSE 2022, arXiv:2202.08701). Auto-closure on staleness is empirically unsafe (actions/stale wrongful-closure record). 

**Q3 — prioritization.** Google deployed validated bug prediction and measured **no developer behavior change**; only passive team-level hotspot reports survived (Lewis et al., ICSE 2013, research.google/pubs/pub41145). Process metrics beat static code metrics (Rahman & Devanbu, ICSE 2013). Relative — not absolute — churn discriminates (Nagappan & Ball, ICSE 2005). Ownership fragmentation predicts failures better than churn+complexity+coverage combined (Bird et al., ESEC/FSE 2011; Nagappan et al., ICSE 2008). SZZ-style blame misattributes against developer oracles (Rosa et al., ICSE 2021, arXiv:2102.03300). Simple early-lifecycle heuristics match retrained models (Shrikanth et al. 2021, arXiv:2011.13071). Severity language already drives human prioritization more than computed scores (Cassee et al. 2024, arXiv:2501.01068).

**Q4 — plan rot.** Detail only the near horizon (PMI rolling-wave). Records are immutable; direction changes are supersessions, never edits (Nygard 2011, ADRs). Half of ADR-adopting repos abandon the habit unless it rides an existing workflow step (Buchgeher et al., IEEE Access 2023, 921-repo MSR). Most repos eventually carry docs referencing code that no longer exists — "current state" must be regenerated on read (Tan et al., EMSE 2022, arXiv:2212.01479). Derived artifacts fail loudly; authored prose fails silently (Martraire 2019, Living Documentation). Outcome-themes survive; feature-and-date commitments rot (Perri 2018). Freshness timers must be structural, not honor-system (SWE at Google ch. 10, abseil.io). **This repo's own HANDOFF records plan rot in hours, not months — stricter than every cadence in the literature.**

**Q5 — cross-run mechanics in production systems.** Gate on a rolling new-code window, not per-finding relitigating (SonarQube Clean as You Code). Finding identity = composite key; cross-run triage propagation is explicit opt-in, never silent (Semgrep baseline docs) — *this validates the fingerprint + owner-gated id-reuse mechanism Stage D shipped.* Quarantines are recurrence-driven with named owners and never silent (Google flaky-test system, Micco 2016 / Memon et al. ICSE-SEIP 2017; Chromium disabling policy — "no forcing function" is the failure). Per-finding decaying confidence beats binary flags (Meta probabilistic flakiness, 2020). Persist per-detector file-touch sets to skip untouched ground (Ekstazi, ISSTA 2015). **The failure-mode study:** suppression registries accumulate as unaudited debt masking real issues across 1,425 projects (Liargkovas et al. 2023, arXiv:2311.07482) — the fate of our 256-entry grandfathered manifest unless each entry carries provenance and a re-review cadence.

## The architectural lock

### Feature 1 — the Trajectory Layer

**T1. The roadmap is compiled, never authored.** A new verb `swarm roadmap compile <run-id>` generates `dogfood/roadmap/<run-id>.json` (+ a `latest.json` pointer) at run end, from the control-plane DB and git alone. Factual sections are queries executed at compile time: open/deferred/approved findings; the grandfathered-manifest drain state; recurrence stats (`swarm trends` internals); per-file process signals. Rides the existing run-close step — no new ceremony (Q4: ADR abandonment; living documentation).

**T2. Targeting is a simple, transparent, advisory heuristic.** Per-file attention score = normalized recent churn (churn relative to file size — Q3 Nagappan & Ball) × prior-finding recency/count (process metrics — Q3 Rahman & Devanbu) × lane-fragmentation (distinct domains that touched it — Q3 Bird et al.). Emitted as a ranked top-K list **labeled advisory**, consumed only as audit-brief context. It is never a gate, never a predictor, never auto-blame (Q3: the Google negative result; SZZ misattribution).

**T3. Forward-looking content is bounded, typed, and expires structurally.** Operator notes are the ONLY human-authored section: at most 7 (Q1 Reflexion bounds), each `{kind: theme|open-question|invariant, text, expires: <N runs | date>, enforced_by?: <gate/test path>}`. Compile drops expired notes loudly (listed in output as EXPIRED, not silently omitted). A note claiming `invariant` **must** carry `enforced_by`, and compile verifies the referenced gate/test exists — a lesson without a mechanical verifier is not persisted as a lesson (Q1: Voyager, Project Vend; this repo's own "mechanism, not memoranda").

**T4. Consumption is explicit, bounded, and positioned.** `swarm init`/`dispatch` for a NEW run on the same repo injects a bounded roadmap digest (top-K attention list + unexpired notes + drain-queue summary) at the TOP of audit briefs (Q1: Lost in the Middle), with the full artifact addressable on disk (Q1: MemGPT paging). Nothing propagates silently: seeding a new run from a prior roadmap is an explicit flag (Q5: Semgrep's opt-in triage propagation).

**T5. Versions supersede; nothing rewrites.** One artifact per run; `latest.json` points at the newest; a recompile within a run supersedes with a new sequence number. History is never edited (Q4: Nygard).

**T6. The drain queue gets owners and cadence.** The roadmap's drain section lists the grandfathered manifest and deferred findings with per-entry provenance (why, who, when) and a re-review cadence in runs; entries past cadence surface at the top of the next run's digest (Q5: Chromium's no-forcing-function lesson; the suppression-staleness study).

### Feature 2 — the Closure Verbs

**C1. `swarm reopen <run-id> --ids … --reason "…" --evidence "…"`** — moves `fixed|deferred|rejected` → `recurring` (open, amendable). Requires non-empty reason AND evidence. Resets closure provenance fields (Q2: Jira KB) while the prior closure survives immutably in `finding_events`. Records the acting authority; the event note distinguishes it from the original closer (Q2: WebKit distinct authorities). No auto-reopen exists anywhere (Q2: Tagra — prediction doesn't generalize; stale-bot harms).

**C2. `swarm close <run-id> --ids … --as fixed|rejected|deferred --reason "…" --evidence "…" --verified-how independent|self_attested|operator_evidence`** — operator closure for rows structurally unclosable by declaration (unowned files — the F-6a5eb347 class) or where the Director directs disposal. The `verified_how` field is load-bearing, not decoration (Q2: Zimmermann — verification mode predicts reopen risk).

**C3. Schema (v10 migration): additive only.** `findings` gains `closure_kind (declared|operator|absence)` and `verified_how`; `finding_events` gains event types `reopened` and `operator_closed`. No column repurposing; append-only event discipline unchanged (GitHub `state_reason` shape — Q2).

**C4. Both verbs are dry-run-first, idempotent, and mutually compensating.** Reopen undoes close; close undoes reopen; every transition leaves an evidence-bearing event row. This retires the "guarded DB repair" precedent for wrongly-closed findings.

### What we refuse to build (the negative-results section)

- **No defect predictor, no risk model, no ML ranking** — Google's deployed predictor changed nothing (Q3); simple heuristics match complex models (Q3).
- **No auto-blame of lanes/waves via SZZ-style attribution** (Q3: developer-oracle misattribution).
- **No auto-close, no staleness bot, no auto-reopen** (Q2: wrongful-closure record; reopen-prediction non-generalization).
- **No unbounded memory, no raw-transcript persistence, no prose "current state"** (Q1: distillation evidence; Q4: doc-decay evidence).
- **No lesson without an enforcement pointer** (Q1: Project Vend — narrative corrections do not hold).

## Feature-audit lanes: your job

Refine these within your domain (schemas for the artifact/migration; core for compile internals; verbs for the CLI surface; tests for the gates that make T3/T6 red-able; ci-tooling for any verify-wiring; docs for the handbook pages). Propose domain-local feature findings — including gaps in this design — with the same severity rigor as health findings. The locked decisions (T1–T6, C1–C4, the refusals) require contrary evidence of the caliber above to overturn, not preference.
