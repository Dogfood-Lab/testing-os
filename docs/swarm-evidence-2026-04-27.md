# Dogfood Swarm Evidence — Stage A–D + Phase 9 (2026-04-27)

> **What this is**: Rich evidence catalog from the 24-wave dogfood swarm
> applied to testing-os itself between 2026-04-25 and 2026-04-27. Captured
> for future swarms consulting this repo: testing-os has been hammered
> hard, and the work documented here is the baseline. Don't redo what's
> done; use this as the starting point.
>
> Companion to the v1.1.2 commit message (which is the executive summary).
> This file is the long-form catalog suitable for repo-knowledge sync,
> Stage E carryover, and post-treatment audits.

## Run identifier

| Field | Value |
|-------|-------|
| Swarm run ID | `swarm-1777234130-30e3` |
| Save point | `swarm-save-1777234130` (revertable) |
| Commit | `b1ae259` (after pa11y fixes); originated at `0479436` (v1.1.2 first push) |
| Branch | `main` |
| Version delivered | `1.1.1 → 1.1.2` |
| Test count | `473 → 704` (+231, +49%) |
| CI state | GREEN (CI 19s + Pages deploy 54s with pa11y) |

## Stage outcomes

| Stage | Waves | Amends | Tests | Headline outcomes |
|-------|-------|--------|-------|-------------------|
| A (bug/security) | 1–6 | 22 | 508 | Initial pass; classifier + dispatch + fingerprint bugs surfaced (self-incrimination cluster); v1.0.0 follow-ups identified |
| B (proactive defensive) | 7–15 | 28 | 643 | 12 audit-coverage taxonomy classes documented; structured-error infrastructure (RecordValidationError, DuplicateRunIdError, IsolationError, CollectUpsertError); validate-record + atomic-write helpers extracted |
| C (humanization) | 16–20 | 21 | 688 | 5 cross-pollination chains validated; 2 reference pages added (state-machines.md, error-codes.md); wave-17 verdict-first banner format established; check-doc-drift.mjs config-driven introduced |
| D (visual polish) | 21–24 | 11 | 704 | pa11y CI gate live; severity tiers visually distinct; mobile nav; accent reconciled to logo (#34d399); architecture SVG + CLI screenshot; 3 ASCII state diagrams; TTY-aware findings renderer |

## Audit-coverage taxonomy (14 classes)

> A "class" = a category of audit gap that recurs across waves and benefits
> from sweep automation. Each class has a first-instance + verifying
> instance(s) + sweep-automation status.

| # | Class | First instance | Verifying instances | Sweep automation |
|---|-------|----------------|---------------------|------------------|
| 1 | Severity arithmetic in digest | wave 8 (findings-digest) | wave 9 file-glob pattern | inline test |
| 2 | Fingerprint description-hash drift | wave 8 | waves 9–24 (used by all collects) | unit test |
| 3 | Classifier marking deferrals as fixed | wave 7 (broken) → wave 8 (introduced `unverified` status) | waves 22–24 (status holds) | unit test |
| 4 | Dispatch domain-filter dumping all findings | wave 2.5 (findingsForDomain helper extracted) | every subsequent dispatch | unit test |
| 5 | Worktree absolute path normalization | wave 12 | F-693631-009 carryover | (none — Phase 5 candidate) |
| 6 | Atomic-write temp+rename | wave 12 (helper extracted) | findings/lib/atomic-write callers | unit test |
| 7 | NDJSON / human dual-emit | wave 9 (logStage) → wave 17 (verdict-first banner) | wave 22 + 24 sweep | sweep invariant test |
| 8 | Structured error envelope | wave 12 (typed errors) → wave 17 (error-render.js) | All commands using throw → exit | inline tests |
| 9 | **Sibling-pattern propagation gap** | wave 22 D-PIPE-001 (logStage) | wave 23 D-CI-001 (untagged-fence) + wave 24 LOW (path-traversal) + **Phase 7 wave 1 (verify-* family extension surfaced at execution time)** | **wave-22 sweep invariant + Phase 7 wave 1 helper-adoption-sweep handler (productized) → 4-stage maturation: briefing-only → audit-time sweep → amend-time sweep → execution-time sweep** |
| 10 | Stage collision in spread-last-wins | wave 22 D-PIPE-002 (run.js:209) | wave 22 wrapper-strip belt-and-braces | regression test |
| 11 | Data-shape drift between agents and schema | wave 8 (severity case) → wave 22 (normalize) → wave 24 (pipeline.summary type) | every collect | (none — Phase 5 candidate #6) |
| 12 | Under-triaged observability/silent-failure (wave-1 calibration) | wave 8 promotion pattern | waves 9–14 (Mike's MED→HIGH upgrades) | (briefing-only — no automation) |
| 13 | Cross-repo Class drift (consumed package contract) | Stage C site-theme (BaseLayout skip-link + favicon) | **Now multi-instance**: Phase 10 surfaced `@mcptoolshop/repo-knowledge@1.0.5` missing `schema.sql` in published artifact (broke `rk init` for every consumer). Pattern: swarms find upstream bugs in shared tooling. | Phase 5 #5 candidate |
| 14 | **Claimed-fixed without verification (fractal — sub-modes 14a + 14b)** | **14a (human claim)**: wave-24 F-916867-002 + F-916867-003 — coordinator/wave marks `[fixed]` without checking current state. **14b (classifier claim)**: wave-29 F-WAVE29-001 — verify-fixed v1 itself has vantage-point limits; narrow file scope misses cross-file fixes (consumer-side recommendations classified `claimed-but-still-present` even after closure). | **14a**: wave-27 productized verify-fixed v1 (FT-BACKEND-002); wave-28 LIVE catch F-742442-041 maturation arc complete (claimed wave 11/13 → caught wave 27 → closed wave 28 → verified wave 29). **14b**: wave-29 surfaced via CLI-vs-agent disagreement on 11 incidental closures (CLI: 0 closures; agents: 11). | **14a**: verify-fixed v1 productized. **14b**: verify-fixed v2 (wave-3 candidate, classifier-base + `cross_ref` field + `verified_via` disclosure). **Methodology axiom: verification has fractal structure — each verification layer becomes a claimed-fixed surface needing its own verify-\* discipline at the next layer.** |

## Positive design patterns (10)

> Patterns the swarm DEVELOPED in flight, suitable for adoption by future
> swarms or Stage E productization.

| # | Pattern | Canonical example | Reference code |
|---|---------|-------------------|----------------|
| 1 | Verdict-first banner format | wave 17 logStage `[component:stage] VERDICT field=val` | `packages/dogfood-swarm/lib/log-stage.js` |
| 2 | doesNotMatch sanity check | wave 18 disambiguation in `renderWithStatus` 3-way exit codes | `packages/dogfood-swarm/lib/findings-digest.js` |
| 3 | Reference page as canonical glossary | wave 18 `state-machines.md` + `error-codes.md` | `site/src/content/docs/handbook/{state-machines,error-codes}.md` |
| 4 | Choke-point fix makes bug-class impossible | wave 22 wrapper-strip (`run.js:51-59` defensively strips inner `stage:` before delegating) + wave 23 findings-render single source | `packages/ingest/run.js`, `packages/dogfood-swarm/lib/findings-render.js` |
| 5 | State-machine-aware drift handler | wave 23 `untagged-fence` check kind in `check-doc-drift.mjs` (opener/closer aware, not regex) | `scripts/check-doc-drift.mjs` |
| 6 | Cross-wave-dependency formalized skip reason | wave 22 ci-tooling deferred contrast test → wave 23 docs delivered it | wave-22 ci-tooling.json + wave-23 docs.json + `scripts/check-severity-contrast.test.mjs` |
| 7 | **Graceful degradation / fallback execution** | Phase 10 — `rk init` failed (broken npm package) → wrote rich evidence catalog as structured markdown in same repo. Same data, more primitive durable form. | `docs/swarm-evidence-2026-04-27.md` (this file) |
| 8 | **Contract-specified parallel cross-pollination** | Phase 7 wave 1 — outputs's parser (F-id → test_files with `orphan_source_ids`) + backend's verify-fixed delta (F-id → classification with anchor + tolerance) joined cleanly in the same wave. Both agents produced compatible JSON shapes from briefing-specified contract alone. No serialized hand-off, no consumer awareness of producer's prior output. | `packages/portfolio/lib/parse-regression-pins.js` × `packages/dogfood-swarm/lib/verify-fixed.js` |
| 9 | **Beneficial side-effect cascade** | Phase 7 wave 2 — W2-BACK-001 `validateAgentOutput` discipline cascaded into ingest pipeline (`validateRecord` → `persist.js:131` → `precheckSubmission` delegates to `validatePayload`), incidentally closing 1 CRIT + 7 HIGH + 3 MED beyond the explicit ledger. **First numerically-quantified cascade leverage: 14 items dispatched, 25 effective closures = 1.79× leverage.** Distinct from #7 (graceful degradation, workflow-layer) and #8 (parallel cross-pollination, intentional) — incidental but reproducible. | `packages/dogfood-swarm/lib/validate-agent-output.js` × `packages/ingest/validate-record.js` × `packages/findings/derive/load-records.js` |
| 10 | **2-step FAILS-then-PASSES proof gate** | Phase 7 wave 3 — `DISABLE_APPEND_LOCK=1` env var preserved in production behind env-gated branch. With disable ON, `event-log-race.test.js` reproduces the original race (3 multi-process iterations fail with rename collisions + dropped events). With disable OFF, 12/12 pass reproducibly across 30 consecutive runs. Proves the safety mechanism (file lock + linkSync atomic publish + rename-to-graveyard CAS) is doing the work, not coincidence. **Distinct from Pattern #2 (doesNotMatch)** — Pattern #2 is message-text contract teeth at unit level; Pattern #10 is safety-mechanism efficacy at integration / concurrency level. | `packages/findings/lib/file-lock.js` × `packages/ingest/event-log-race.test.js` (DISABLE_APPEND_LOCK env-gate) |

> Pattern #7 generalizes: when a tool dependency breaks, capture the same
> data in a more primitive durable form. The primitive form is the
> contract; the tool is the convenience. Same family as wave-22
> wrapper-strip (defensive choke-point) but applied at the workflow
> layer rather than the code layer.
>
> Pattern #8 is the strongest cross-pollination form yet observed.
> Sequential chains (chains #1-5) require deliberate consumer awareness
> of prior infrastructure. Parallel chains (#8) require only contract-
> specified briefing. Methodology delta: briefing-as-contract-
> specification scales cross-domain coordination without requiring
> sequential dependency. Future Phase 7 waves should leverage this when
> two findings touch joinable surfaces — specify the contract in the
> briefing rather than serializing the work.
>
> **Pattern #9 (beneficial side-effect cascade)** is the first numerical
> leverage measurement of the swarm. When a wave installs a contract gate
> (write-time validator, helper extraction, schema lockstep), all
> downstream consumers of that contract effectively close their related
> findings without explicit dispatch. Wave 2: 14 items dispatched, 25
> effective closures, **1.79× cascade leverage**. Wave 28's
> `validateAgentOutput` → `validateRecord` → `precheckSubmission`
> cascade closed 4 outputs findings (1 CRIT + 2 HIGH + 1 MED) via shared
> validation contract propagation alone.
>
> **Pattern #9 weak-generalization update (post wave 31, two-instance
> evidence).** Wave 3 produced 1.00× cascade leverage (18 dispatched, 18
> effective: 7 v1.1.5 capability work + 9 of 11 v1.1.6 migration flips +
> 2 incidental cascade closures). Below the wave-2 baseline of 1.79×.
>
> **Reframe:** "structural fixes CAN produce cascade closures" — not
> "structural fixes WILL produce 1.5×+ leverage." The pattern is real
> (cascade closures DO happen beyond the explicit ledger) but the
> leverage RATIO is variable, not predictable. Wave-2's 1.79× appears to
> have been an unusually high-collateral closure case, not the norm.
>
> **Practical implication for prioritization:** structural fixes are
> still preferred for first-order reasons — they prevent recurrence, not
> just fix instances. Cascade is a bonus when it lands, **not a planning
> input**. Don't optimize prioritization for cascade ratio.
>
> Implication for prioritization: structural fixes (contract gates,
> helper extraction) have measurably higher cascade-closure ratios than
> localized fixes. Future Phase 7 / Phase 8 triage can prefer structural
> fixes first when cascade potential is high — they pay forward into
> incidentally-closed findings. **The wave-31 re-audit (closure check on
> wave 30) should explicitly measure cascade leverage** to establish
> whether Pattern #9 has two-instance evidence; ≥1.5× indicates the
> pattern generalizes, <1.0× indicates it was wave-2-specific. Either
> result is methodology evidence worth recording.
>
> **Pattern #10 (2-step FAILS-then-PASSES proof gate)** is methodology
> evidence at the test-rigor layer. A passing concurrency test without
> this gate is ambiguous — "the bug just didn't manifest this run" is
> indistinguishable from "the safety mechanism worked." The gate forces
> the test to prove BOTH halves of the safety contract: the failure mode
> is real (disable=1, test fails) AND the mitigation works (disable=0,
> test passes consistently). For any future test of concurrency, file
> locking, retry/backoff, or environmental safety property, ask: can a
> reviewer prove the safety mechanism is doing the work? If not, add a
> 2-step proof gate. The DISABLE_APPEND_LOCK env-gated branch is the
> reference implementation.
>
> **Pattern #10 prior-art reframe (post wave 31, ci-tooling audit).**
> Wave 30's event-log race detection was the first NAMED instance of the
> 2-step proof gate, but **three prior-art instances exist in the
> codebase predating the naming:**
> - `scripts/sync-version.mjs --check` — preview-vs-apply split
> - `scripts/apply-finding-migration.mjs --check` — wave-30 instance with the same shape
> - `scripts/check-doc-drift.mjs` `framework-self-test` handler — structural Pattern #10 instance via negative-fixture proof
>
> The `--check` mode flag pattern across CLI scripts IS Pattern #10
> already. Wave 30 didn't INVENT Pattern #10 — it documented an
> organically-emerging practice. **Methodology honesty:** when documenting
> patterns, audit the codebase for prior art before claiming origination.
> Most "patterns" emerge before they're named. Reframe: "the swarm
> recognized and named a pattern already operative in the codebase"
> rather than "the swarm invented a new pattern."

## Cross-pollination chains (5, with corrected claim shape)

> The Stage D methodology correction: chain validation requires audit
> against new + pre-existing callers + sweep automation in place.
> Status here uses the corrected shape.

| # | Chain | Original wave | Validation status |
|---|-------|---------------|-------------------|
| 1 | `validatePayload` extraction | waves 8 → 9 → 12 | Validated against new callers + pre-existing callers audited at wave 12 + sweep automation: regression test |
| 2 | `logStage` extraction (`lib/log-stage.js`) | wave 9 → wave 17 → wave 22 | **Validated three ways**: wave-22 sweep, wave-24 re-sweep, Phase 9 stress test (DOGFOOD_LOG_HUMAN=1 ingest path). Sweep invariant test catches future regressions. |
| 3 | atomic-write helper | wave 9 → wave 12 | Validated against new callers + pre-existing callers audited at wave 12 |
| 4 | Typed-error infrastructure | wave 12 → wave 17 | Validated against new callers; pre-existing audit pending Phase 5 |
| 5 | Reference-page-as-canonical-glossary | wave 18+ | Validated as documentation pattern; Stage E candidate to extend to handbook authoring guidelines |

## Methodology corrections (8 from Stage D closure receipt)

1. **Cross-pollination claim shape**: validate against new + pre-existing callers + sweep automation in place + invariant test
2. **Within-stage vs across-stage convergence**: distinct properties; cross-stage convergence is illusory when a new lens hits a never-audited surface
3. **Class #9 sweep-automation requirement**: insight → evidence-backed conclusion (D-PIPE-001 + untagged-fence + path-traversal helper)
4. **Wrapper-strip / choke-point pattern**: fix at the choke-point so the bug-class is impossible to recur
5. **`cross-wave-dependency`**: first-class skip reason (operationalized wave-22 → wave-23)
6. **Logo-verification-first**: read the file, not the comment (caught a verifiable lie in starlight-custom.css)
7. **State-machine-aware drift handler**: positive design pattern (opener/closer aware drift checks)
8. **`edit_path` field distinct from `file_path`**: confirmed Phase 5 deliverable (twice-validated by routing misses)

## Phase 5 candidates (10 total, 2 CONFIRMED)

| # | Candidate | Status | Evidence base |
|---|-----------|--------|---------------|
| 1 | `check-shared-helper-adoption.mjs` / `check-drift.mjs` generalization | **CONFIRMED** | D-PIPE-001 (wave 22) + wave-23 untagged-fence handler caught 2 wave-22 misses + wave-24 LOW: path-traversal helper missing in 1 of 3 callsites |
| 7 | `edit_path` field distinct from `file_path` | **CONFIRMED** | Wave 22 D-OUT-003 (file:site/styles → reroute to .github/workflows/pages.yml) + Wave 23 docs→scripts cross-wave handoff routing miss |
| 2 | `swarm tail` real-time human banner surface | candidate | wave-9 NDJSON + wave-17 banner imply it; folds in F-916867-004 verdict-first carryover |
| 3 | Provenance-on-display for resolve-vs-stored values | candidate | feedback memory standing |
| 4 | Visual regression CI gate productization (beyond pa11y) | candidate | Stage D wave 22 partially delivered; generalize beyond one page; Mermaid stateDiagram via build-time SVG export folds in here |
| 5 | Cross-repo drift-checker (Class #13 propagation) | candidate | Stage C site-theme upstream PR pending |
| 6 | Collect-time normalize step for agent-format-drift | candidate | Wave 22 + 24 — recurring pipeline.json normalize + fingerprint collision disambiguation |
| 8 | Cross-wave-dependency formal skip reason in briefing template | candidate | Wave 22 ci-tooling agent's correct deferral instinct |
| 9 | Vitest config narrowing | candidate | Phase 9 surfaced — vitest walks workspace and tries to load node:test format files; should narrow to `packages/schemas/test/**/*.test.ts` only |
| 10 | Contrast unit test sweep across all text-using-accent surfaces | candidate | Pa11y caught 6 light-mode link/nav contrast violations the wave-23 unit test missed (test surface ≠ visual surface) |

## Self-incrimination tally (6+)

Swarm tooling bugs caught + fixed by the swarm running on it (testing-os auditing testing-os):

1. `findings-digest.js` — severity arithmetic bug + file-glob pattern (`*.output.json` → `<domain>.json`) — waves 8–9
2. `lib/fingerprint.js` — description-hash drift + ID-as-symbol disambiguation — wave 8
3. Classifier — marked deferrals as `fixed` without positive evidence; introduced `unverified` status — wave 7 → wave 8
4. `commands/dispatch.js` — `--isolate` silent fallback to non-isolated mode — wave 12
5. `commands/dispatch.js` — domain-filter dumping all findings to all agents — wave 2.5
6. `lib/log-stage.js` — cross-pollination chain #2 incompleteness (private logStage in ingest bypassed shared helper) — wave 22

## Wave-1 deferred follow-ups (5, still tracked)

From the testing-os v1.0.0 ship (2026-04-25). Not Stage A-D scope; surface here for repo-knowledge continuity:

1. `DOGFOOD_TOKEN` secret missing on consumers
2. `ai-loadout` build broken
3. Action SHAs Node-20 deprecated
4. `site/` npm audit
5. Dep scanning gap

## Override discipline (1 instance)

**Wave 23 docs ownership violation override**: docs agent edited 6 files in `scripts/**` (ci-tooling domain) per under-specified coordinator briefing on cross-wave handoff. Override logged in `agent_state_events` for `agent_run=199` with full rationale. Routing model deficit promoted to confirmed Phase 5 #7 deliverable. Wave-24 re-audit confirmed the work belongs in `scripts/` stylistically (indistinguishable from native ci-tooling work — verified by independent ci-tooling re-audit agent).

Discipline preserved: work was substantively correct, briefing was under-specified, model gap documented for Phase 5.

## Coordinator cleanups (4 instances + 1 scope-expanded)

Mechanical, no design judgment, same authority class across the first four:

1. **Wave 22 collect-time normalize** for `pipeline.json` (lowercase severities → uppercase, summary/detail field names → description, fingerprint disambiguation via ID-as-symbol)
2. **Wave 23 `package.json` test:scripts wire-up** — added 3 new docs-written test files (check-severity-contrast, check-accent-color, check-handbook-imagery); 28 → 52 tests in `test:scripts`
3. **Phase 9 F-916867-001 fix** (state-machines.md "default 14 days" → "default 30 days" matching `DEFAULT_MAX_AGE` in `portfolio/generate.js:32`)
4. **Wave 28 schema enum mirror + atomic-write allowlist shrink + portfolio exports field** — three mirror cleanups landed post-collect by coordinator (W2-BACK-002 AUDIT_CATEGORIES enum 12→17 in scripts/agent-output.schema.json; W2-BACK-003 atomic-write allowlist 13→6 in scripts/doc-drift-patterns.json; outputs-domain-surfaced exports field gap in packages/portfolio/package.json per CLAUDE.md rule #4)

### Scope-expanded cleanup — v1.1.6 (NEW from wave 30)

**Distinct authority class.** The first four cleanups above are pure mechanical transcription with no design judgment. v1.1.6 added schema infrastructure (`ALTER TABLE findings` + 3 columns) + a query update (`loadFixedFindings` SELECT + JSON hydration) + a data migration script — ~50 LoC of small dev work, not pure transcription. Authorized by advisor under a **5-factor test** documented in `swarms/migrations/wave-30-incidental-cross-refs.json` (`scope_expansion_audit_log`):

| Factor | Why this case warranted expansion |
|--------|-----------------------------------|
| Antecedents in place | Wave-29 attestations supply the cross_ref data; wave-30 design supplies the schema shape; no new design judgment |
| Bounded scope | ~50 LoC across 5 files, fully listed in v1.1.6 commit body |
| Authority alternative cost | Mini-wave dispatch overhead exceeds the work effort by ≥10× |
| Methodology stakes | Pattern #9 second-instance cascade-leverage measurement requires the migration; deferring loses the cleanest measurement opportunity |
| Coordinator has full context | Wave-29 attestations + wave-30 design + Class #14 framing all live in coordinator scope |

**Discipline conditions honored:**
- Logged in artifact (`swarms/migrations/wave-30-incidental-cross-refs.json`)
- Documented in v1.1.6 commit message body (5 factors disclosed)
- Wave-31 audit briefing targets the scope-expanded work for design-judgment-drift assessment
- **Precedent-limited.** Future "small dev tasks" default to mini-wave dispatch unless they meet the same 5-factor test.

**Migration outcome (idempotent):** 11/11 finding records updated; v2 `verified_via_distribution` shifted from `{ anchor: 193, cross_ref: 0, allowlist: 0 }` to `{ anchor: 185, cross_ref: 3, allowlist: 5, unverifiable: 6 }`. Verified count moved 141 → 150 (+9); claimed-but-still-present moved 27 → 19 (-8). The 3 cross_ref entries that "didn't reclassify" fell through cleanly because their primary anchor matched at the original location in current state — fall-through path of v2 worked as designed.

## Stage D wave-by-wave summary

| Wave | Phase | Findings | Outcome |
|------|-------|----------|---------|
| 21 | stage-d-audit | 6 HIGH / 16 MED / 20 LOW (42 total) | Audit baseline; D-PIPE-001 headline finding (cross-pollination chain incompleteness) |
| 22 | stage-d-amend | 3 fixes (D-PIPE-001/002, D-OUT-003) | Foundation slice. Wrapper-strip + sweep invariant test. Cross-wave handoff initiated. |
| 23 | stage-d-amend | 8 fixes (D-DOCS-001/002/003/008, D-CI-001/002, D-DOCS-007, D-BACK-002) | Polish cluster. Logo lie caught + reconciled. Cross-wave handoff delivered. Override applied. |
| 24 | stage-d-audit | 0 CRIT / 0 HIGH / 2 MED / 3 LOW | Re-audit clean. Stage D closed. |

## Wave 24 deferred → post-treatment / Phase 5 dispositions

| Finding | Disposition |
|---------|-------------|
| F-916867-001 (state-machines.md "14 days" → "30 days") | Coordinator cleanup applied at Phase 9 |
| F-916867-002 (wave-1 schema descriptions incomplete) | **Phase 5 #1 first deliverable** — re-audit wave-1 [fixed] findings (Class #14) |
| F-916867-003 (schemas package.json files: missing) | Same as F-916867-002 — folds into wave-1 [fixed] re-audit |
| F-916867-004 (portfolio CLI verdict-first) | Folds into Phase 5 #2 (`swarm tail`) |
| F-916867-005 (path-traversal helper missing in 1 of 3 callsites) | **Phase 5 #1 canonical instance** |
| GHA UI screenshot from D-DOCS-008 | Mike-driven asset add post-treatment |
| Mermaid stateDiagram-v2 | Phase 5 #4 (build-time SVG export, not runtime browser) |

## Phase 9 specific findings

| Investigation | Outcome |
|---------------|---------|
| Vitest 6 file-load failures | Pre-existing config issue (vitest walks workspace + tries to load node:test format files). NOT Stage A-D regression. Phase 5 #9. |
| Override cleanup verification | `npm run test:scripts` produces 52/52. Wired correctly. |
| Cross-pollination chain #2 stress test | Verified via DOGFOOD_LOG_HUMAN=1 direct logStage call. NDJSON + verdict-first banner both emit. Outer stage='error' preserves with failed_stage='foo' separately. Wave-17 contract satisfied through ingest path. |
| Save-point reachability | Both `swarm-save-1777234092` and `swarm-save-1777234130` reachable. 0 commits between save and HEAD before commit cadence (now 3 commits since: 0479436, cae59cb, b1ae259). |
| Numerical correction | Wave-24 ci-tooling agent's "742 tests" was double-counting (vitest 38-pass = schemas package, already in workspace count). Actual unique: 704. |

## Post-Phase-9 commit cadence (3 commits)

| Commit | What |
|--------|------|
| `0479436` | chore(swarm): Stage A-D dogfood swarm + Phase 9 — v1.1.2 (111 files, +11698/-484) |
| `cae59cb` | fix(ci): pa11y --no-sandbox shim for GHA puppeteer |
| `b1ae259` | fix(site): light-mode accent ramp — pa11y WCAG AA on white |

The pa11y CI gate caught a real Stage D regression on first deploy (light-mode contrast at 1.92:1) that the wave-23 unit test missed because its surface was narrower than the visual surface affected. **Test surface ≠ visual surface** is a sibling to the wave-22/23 routing-miss class. Phase 5 candidate #10 added.

## Brand identity verification

| Asset | Hash | Bytes | mtime | Status |
|-------|------|-------|-------|--------|
| `site/public/logo.png` | `30093bd6...` | 950504 | 2026-04-25 (pre-Stage-D) | byte-untouched, sacrosanct |
| `assets/logo.png` | `30093bd6...` (same) | 950504 | 2026-04-25 | byte-untouched, sacrosanct |

Wave-23 logo verification (read the file, not the comment) determined the logo IS green (`#34d399` emerald-400). The starlight-custom.css comment claiming "matches blue cube logo" was provably wrong. Reconciled handbook accent → green. Light-mode accent darkened to `#008857` (Phase 9 follow-up) for WCAG AA without disturbing brand canon.

## Repo state at Phase 10

- `npm run verify`: 704/704 pass, 0 fail
- `shipcheck audit`: 100% on hard gates A-D (20 checked / 17 skipped-with-justification / 0 unchecked)
- Landing page: HTTP 200 (`https://dogfood-lab.github.io/testing-os/`)
- Reference pages: HTTP 200 each (`/handbook/error-codes/`, `/handbook/state-machines/`)
- Repo metadata: description set, homepage set, 6 topics
- Mike-supplied logo: byte-untouched
- Cross-pollination chain #2: verified complete (sweep + re-sweep + stress test)

## Methodology recursion — four evidence classes (Waves 29-30)

The run has produced four distinct evidence classes — each a higher-order output than the last:

| Class | Wave range | Output |
|-------|------------|--------|
| 1 — Substantive evidence | Waves 1-26 | ~100 fixes, 70+ features, 14-class taxonomy |
| 2 — Methodology evidence | Waves 26-28 | 9 design patterns, 5 cross-pollination chains, Class #14 LIVE catch (F-742442-041 maturation arc) |
| 3 — Methodology efficacy evidence | Wave 29 | Pattern #9 cascade measurement (1.79× leverage), Class #14b discovery, fractal-structure framing |
| 4 — Methodology self-application | Wave 30 | Class #14 caught at the wave-30 productization boundary itself: v2 capability shipped at function level but not data layer; coordinator semantic check during ruling-2 execution caught the gap before wave 31 dispatched. |

The progression: *"we're producing fixes" → "we're producing methodology" → "we're measuring methodology efficacy" → "the discipline catches its own incomplete productizations."* Each step is a higher-order output.

**Class 4 framing — Class #14 self-application:** the discipline catches its own incomplete productizations. The Class #14 productization (verify-fixed v2) caught its own Class #14 vulnerability before wave 31 dispatched: v2 the *code* shipped in v1.1.5 with mock-tested function-level coverage; v2 the *data infrastructure* (schema columns + finding-record migration) was discovered missing at the migration boundary and shipped in v1.1.6. Class #14 prevention is **recursive** — any productization can itself become a claimed-fixed surface needing its own verify-\* discipline at the next layer.

**Practical implication for future productization waves:** include explicit "wired through to production data path" verification as part of the wave's own closure check, not just function-level test coverage. Mock-based testing is necessary but not sufficient; production data exercise is the real closure signal. Wave 30 backend agent's mock-based tests passed (33 v2 classifier tests + 18 verb-family tests), but the production seam (DB schema → loadFixedFindings query → classifier) wasn't exercised in the same wave. The wave-31 `verified_via_distribution` measurement IS the production exercise.

This is the strongest justification yet for the multi-wave / multi-stage discipline: it produces **self-referential evidence that single-wave or single-stage work cannot**. Future swarms should expect that each wave's output is BOTH substantive AND methodology-validating — record both.

## Swarm complete — final closure (2026-04-27)

**Phase 7 wave 3 closed; swarm declared complete after v1.1.7 cleanup.**

This swarm ran from 2026-04-25 through 2026-04-27 across ~31 dispatched waves (1–28 wave executions + 29/31 re-audits + 4 cleanup commits v1.1.4–v1.1.7). Mike chose **Option I (ship-and-stop)** at the wave-31 closure ack, reasoning that the methodology-evidence catalog is rich enough to compound across other repos rather than continue accumulating in one. Phase 5 deferred candidates (FT-CITOOLING-007 + Slices C/D/F) and the 16 still-present `claimed-but-still-present` MED/LOW entries become post-swarm session-tracked work.

### Final repo state

| Metric | Value |
|--------|-------|
| Final version | v1.1.7 |
| Final commit | `5f4571a` |
| Tests | **965/965** (473 baseline → +492, **+104%**) |
| CI | GREEN (29s + 31s + 34s across last 3 commits) |
| Pages deploy | GREEN with pa11y WCAG2AA threshold 0 |
| Logo identity | byte-untouched: sha256 `30093bd6...`, 950504 bytes |
| Save-point | `swarm-save-1777234130` (revertable) |
| Branch hygiene | clean main, no orphan branches |

### Cumulative output

- ~31 waves dispatched (Stage A–D + Phase 5 + Phase 7 waves 1–3)
- ~115 fixes verified holding (199 fixed-status findings; 153 verified, 24 regressed, 16 claimed-but-still-present, 6 unverifiable per final v2 distribution)
- **10 positive design patterns** documented (with prior-art audit calibration on Pattern #10)
- **14 audit-coverage classes** with multi-instance evidence; Class #14 productized to v1 + v2 across two iterations
- **5 cross-pollination chains** validated (sweep automation + invariant test + stress reproduction)
- **Class #14 5-iteration recursion arc** complete (human claim → v1 productization → v1 vantage limit → v2 productization → v1.1.6 data layer → v1.1.7 Windows path)
- **Methodology evidence at 5 layers** (substantive → methodology → efficacy → self-application → audit-the-audit)
- **8+ self-incrimination bugs** caught and fixed in swarm tooling
- **2 numerical cascade-leverage measurements** (1.79× wave 2; 1.00× wave 3) → Pattern #9 reframed to weak-generalization
- **2 coordinator scope-expansion commits** (v1.1.6, v1.1.7) under bounded 5-factor test, precedent-limited

### Final v2 verified_via_distribution

```
total: 199
verified: 153 / regressed: 24 / claimed-but-still-present: 16 / unverifiable: 6

verified_via_distribution:
  anchor:            182 (legacy v1 path; primary file:line still matches)
  cross_ref:           5 (consumer-side fix anchored in different file)
  allowlist:           6 (coordinator_resolved with attestation evidence)
  agent_attestation:   0 (channel reserved for future use)
  unverifiable:        6 (neither anchor nor cross_ref produced verdict)
```

The v2 capability is exercised in production data path with a working migration discipline. Future swarms inherit a tested classifier base + manifest format + idempotent migration runner.

## Post-swarm session roadmap

Work deferred at swarm close, organized by self-contained sessions Mike can pick up at his cadence. Each session is bounded scope + stated effort + clear done-criteria. **No session is required**; pick up only when testing-os is the active focus.

### Session A: Cross-repo drift-checker (FT-CITOOLING-007)

**Effort:** half-day to full session
**Value:** HIGH — Class #13 productization with strongest multi-instance evidence in the swarm

**Scope:**
- New CLI `check-cross-repo-drift.mjs` consuming `raw.githubusercontent.com/dogfood-lab/testing-os/main/...` URLs
- Detects drift between testing-os schemas/protocols and consumer repos
- Tested against the 2 known instances:
  - site-theme: BaseLayout skip-link + favicon
  - repo-knowledge@1.0.5: missing `schema.sql` in published artifact (broke `rk init`)

**Done-criteria:** CLI flags both known instances + 1 synthetic test case; CI gate optional (low blast radius until a third consumer materializes).

### Session B: Operator-experience trilogy (Slice C)

**Effort:** full session
**Value:** HIGH — completes the verb family with operator-facing surfaces

**Scope:**
- `swarm tail` real-time human banner (folds in F-916867-004 verdict-first carryover; Phase 5 candidate #2)
- `swarm worktree` CLI surface (currently internal; expose for inspection/cleanup)
- JSON modes for query commands (`status`, `verify-fixed`, `verify-recurring/unverified/approved` already have JSON; extend to `dispatch`, `collect`, `receipt`)

**Done-criteria:** 3 new operator surfaces wired with tests + handbook reference section.

### Session C: Docs canonical-glossary trilogy (Slice D)

**Effort:** half-day
**Value:** MEDIUM — productizes Pattern #3 (reference page as canonical glossary) to 3 more handbook pages

**Scope:**
- Pick 3 handbook pages currently lacking canonical-glossary discipline
- Apply the `state-machines.md` / `error-codes.md` reference pattern
- Cross-link from operating-guide.md and beginners.md

**Done-criteria:** 3 new reference pages live + cross-linked + pa11y green.

### Session D: Test infrastructure (Slice F)

**Effort:** half-day to full session
**Value:** MEDIUM — adds capacity for future test discipline

**Scope:**
- Fuzz / property-based testing harness (e.g., for fingerprint, classifier, validator inputs)
- End-to-end smoke test (full `swarm` flow against a fixture repo)
- Schema versioning gate (CI check that schema bumps include lockstep version updates)

**Done-criteria:** Harness in place + 1 fuzz example + 1 e2e example + schema versioning gate passing.

### Session E: Wave-4 cleanup batch

**Effort:** half-day
**Value:** MEDIUM-LOW — bounded edge cases, maintenance hygiene

**Scope (6 items):**
- `linkSync` no-fallback for FAT32/exFAT/ENOTSUP filesystems (degrade path)
- Stale-graveyard janitor in `findings/lib/file-lock.js` (cleanup `.gy.*` files orphaned by crash-after-rename-before-unlink)
- Pattern #10 propagation × 3 candidates: `ingest.test.js:640` writeRecord TOCTOU, `rebuild-indexes-atomicity.test.js:244` journal-disable, `review.test.js:544` temp+rename bypass
- Missing `apply-finding-migration.test.mjs` (Class #9 sibling-test gap)

**Done-criteria:** 6 small fixes shipped, all idiomatic.

### Session F: Cumulative MED/LOW Class #14 triage

**Effort:** variable (one session for triage decisions; more for fixes)
**Value:** LOW individually, MEDIUM cumulatively

**Scope:** 16 still-present `claimed-but-still-present` entries (down from 27 pre-migration). Mostly MED/LOW quality findings.

**Done-criteria:** each entry classified `fix-now` / `defer` / `dismiss` with rationale; fixes shipped for `fix-now` set.

### Session G: M5 Max migration validation (when M5 arrives ~2026-04-24)

**Effort:** half-day
**Value:** HIGH for hardware-stage transition

**Scope:**
- Cross-platform validation of all atomic primitives on Darwin/APFS
- `linkSync` semantics on macOS HFS+ vs APFS vs network mounts
- File-lock `rename-to-graveyard` CAS behavior on Darwin
- Full test suite + CI run on M5 Max

**Done-criteria:** testing-os runs cleanly on M5 Max; any platform-specific gaps surfaced as wave-X candidates.

### Session ordering recommendation

If Mike picks up testing-os again, **Session A (FT-CITOOLING-007) first** — Class #13 evidence is strongest now and the productization is bounded. Then Session B if operator UX is the focus, or Session E if "one quick cleanup batch" is the mood. Sessions C/D/F are independent; pick by whichever pulls Mike's interest at the moment.

**No session is required.** The swarm declared testing-os in best state of its life. The roadmap exists to make resumption frictionless if Mike returns; it is not a backlog Mike owes.

## Cross-swarm methodology takeaways

For future swarms on OTHER repos consuming this catalog:

1. **Pattern #9 is real but variable.** Don't optimize for cascade ratio. Structural fixes are still preferred for first-order recurrence-prevention reasons.

2. **The 5-factor test for coordinator scope expansion holds at 2 instances** (v1.1.6, v1.1.7) but is precedent-limited. Default "small dev tasks" to mini-wave dispatch unless they meet all 5 factors. A 3rd instance would warrant policy revisit.

3. **Class #14 prevention is recursive.** Any productization can become a claimed-fixed surface needing its own verify-* discipline at the next layer. Closure-check sub-conditions for productization waves: "wired through to production data path" + "verified to run on the production OS surface."

4. **Audit-the-audit is the ultimate safety mechanism.** The wave-31 audit caught W31-BACK-001 (Windows path bug in coordinator-scope work) — the discipline catches its own incompleteness. Class 4 + Class 5 evidence layers are reproducible.

5. **Pattern naming should follow prior-art audit.** Most "patterns" emerge organically before they're named (Pattern #10 had 3 prior-art instances predating wave-30). When documenting a pattern, audit the codebase first.

6. **Cross-pollination chain shape requires:** new callers + pre-existing callers audited + sweep automation in place + invariant test. Anything less is partial validation.

7. **Save-point reachability is non-negotiable.** Every commit during a swarm should leave the run revertable. testing-os's `swarm-save-1777234130` tag is the discipline reference.

8. **Mike's Windows-primary workflow is a real test surface.** Cross-platform path semantics (`pathToFileURL` over hand-rolled `file://` strings, backslash vs POSIX) need explicit verification in any productization that ships scripts.

## What's NOT in this catalog

- Per-wave agent JSON outputs (gitignored under `swarms/swarm-*/`)
- SQLite control plane (gitignored as `swarms/control-plane.db`)
- Translations (Mike runs polyglot-mcp locally per discipline)
- Internal SDLC artifacts not relevant to a future swarm consulting this evidence

## For future swarms

If you are a swarm operator landing on testing-os post-2026-04-27:

1. **Read this file before dispatching Stage A.** Most of the easy wins are already taken.
2. **Read `swarms/PROTOCOL.md`** — it has been refined through Stage A-D.
3. **Class #14 (claimed-fixed without verification)** means: don't trust prior `[fixed]` markers without re-validating. Wave-1 fixes were self-reported, sometimes inaccurately.
4. **The 2 confirmed Phase 5 deliverables** (`check-shared-helper-adoption.mjs` + `edit_path` field) would dramatically reduce future swarm overhead. If you have time, productize them first.
5. **Cross-pollination chain #2 (logStage)** is the canonical example of a chain done RIGHT (sweep + invariant test). Use it as the reference pattern.
6. **Mike-supplied assets are sacrosanct.** The logo is `#34d399` emerald. Don't propose a redesign.
