# Changelog

All notable changes to `testing-os` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] — 2026-05-14

**First npm publish of the `@dogfood-lab/*` monorepo.** Six packages now public on npm: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Headline install: `npm install -g @dogfood-lab/dogfood-swarm`. The seventh package (`@dogfood-lab/portfolio`) remains internal.

**New in this release:** wave-level state machine (Phase 5A) + Three R's recovery contract (Phase 5B-1 `swarm rewind`, 5B-2 `swarm redrive`, plus the existing `swarm revalidate` from earlier in this version cycle) + `swarm history` audit-trail verb (Phase 5B-0). Stage A–D health pass closed at 0 CRIT / 0 HIGH against the pre-Phase-5 baseline. **1105/1105 tests** (was 940 at start of session arc). All packages bump lockstep from 1.1.7 → 1.2.0.

### Security

- **F-W1-BACK-001 — prototype-pollution guard in `deepMerge`** ([`packages/verify/validators/policy.js`](packages/verify/validators/policy.js)). Repo-policy YAML merge now skips `__proto__`, `constructor`, and `prototype` keys before recursing. Adversarial submission can no longer mutate `Object.prototype` through a crafted policy file.
- **F-W1-BACK-002 — prototype-pollution reject in `performAction` field-changes loop** ([`packages/findings/review/review-engine.js`](packages/findings/review/review-engine.js)). The review engine's edit/merge actions now operate against an explicit editable-fields allow-list; `__proto__`/`constructor`/`prototype` keys are rejected rather than written into the finding row.
- **F-W1-BACK-003 — path-traversal + command-injection fix in `createWorktree`** ([`packages/dogfood-swarm/lib/worktree.js`](packages/dogfood-swarm/lib/worktree.js), [`packages/dogfood-swarm/lib/domains.js`](packages/dogfood-swarm/lib/domains.js)). Domain names validated through `isSafeDomainName` before participating in worktree paths; shell-string `execSync` replaced with `execFileSync` argv-array form so domain-string content can no longer be interpreted as shell metacharacters.
- **F-W1-BACK-005 — stale-row regression in `checkGates`** ([`packages/dogfood-swarm/lib/advance.js`](packages/dogfood-swarm/lib/advance.js)). Latest-per-domain `MAX(ar2.id)` filter applied at the third callsite. Closes the wave-9 F-375053-002 regression family for advance-time gate evaluation; previous form treated superseded `failed`/`invalid_output` rows from older waves as still live, producing false-positive gate blocks.
- **BASELINE-1 — `fast-uri` CVE override** ([`package.json`](package.json)). Root `overrides: { "fast-uri": "^3.1.2" }` pulls every transitive dependent off the vulnerable range. Closes GHSA-q3j6-qgpj-74h6 and GHSA-v39h-62p7-jpjc; `npm audit` reports 0 high.
- **F-W1-CI-001 — pa11y pin** ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). `pa11y@^8` floating tag replaced with `pa11y@9.1.1` exact. Aligns with the org-wide "no floating tags in CI" discipline (the $130 GitHub Actions incident memory is the precedent).

### Added

- **`swarm history <wave-id>` — wave-transition deep-audit verb** ([`packages/dogfood-swarm/commands/history.js`](packages/dogfood-swarm/commands/history.js), wired in [`packages/dogfood-swarm/cli.js`](packages/dogfood-swarm/cli.js) as `cmdHistory`). Plain-ASCII table render of `wave_state_events` for a specific wave so the override-and-reason audit row written by `swarm revalidate --apply` (Phase 5A wired the audit row; this verb surfaces it) is reachable without raw SQL. `swarm status` gains a one-line breadcrumb in the current-wave block when the wave has "interesting history" — any override transition out of a BLOCKED source status, OR more than one transition row — pointing the operator at `swarm history <wave-id>` for the full chain. The common-case `dispatched → collected` wave gets NO breadcrumb so steady-state status output stays uncluttered. Reads via the existing `getWaveTransitionHistory(db, waveId)` export at `lib/wave-state-machine.js`; no schema changes. Direct integration assertion added to `revalidate.test.js` (full-repair test now queries `wave_state_events` directly and asserts the operator's `--reason` text lands prefixed with `revalidate: ` — closes the vantage-point gap where `waves.status === 'collected'` could pass while the audit row went missing). 6 subprocess smoke tests in `cli-smoke.test.js` cover the verb's help/no-args/unknown-id/non-integer-id/known-id/fresh-wave paths.
- **`swarm revalidate` — lawful recovery verb for blocked `agent_runs`** ([`packages/dogfood-swarm/commands/revalidate.js`](packages/dogfood-swarm/commands/revalidate.js), wired in [`packages/dogfood-swarm/cli.js`](packages/dogfood-swarm/cli.js) as `cmdRevalidate`). Wraps the override path that has existed in `lib/state-machine.js` (`transitionAgent(..., 'complete', reason, true)`) since the BLOCKED_STATUSES set was introduced but had no operator surface. Dry-run by default; `--apply` required to mutate; `--reason "<text>"` required (recorded in `agent_state_events` for audit). On full repair the wave's `failed` status flips back to `collected` in the same SQLite transaction (mirrors `collect.js`'s set-to-failed direction; same-transaction prevents the torn-state regression). 11 tests in `revalidate.test.js` cover the contract guards (empty/whitespace reason, missing domains), dry-run-vs-apply discipline, validation refusal paths (envelope schema, legacy amend validator, ownership), the partial-vs-full-repair wave-rollback case (N=4 blocked, repair N-1 keeps wave failed; repair all 4 flips to collected), and idempotency on already-complete rows. Architectural grounding: AWS Step Functions Redrive, Temporal reset, Airflow clear/set-state, GitHub Actions `rerun --failed`, Stripe Ledger correction-events; documented inline in the source-file header.
- **`renameWithRetry` Windows EPERM/EBUSY helper** ([`packages/findings/lib/rename-with-retry.js`](packages/findings/lib/rename-with-retry.js), [`packages/ingest/lib/rename-with-retry.js`](packages/ingest/lib/rename-with-retry.js)). Wraps `renameSync` with bounded retry on the EPERM/EBUSY classes that Windows AV scanners produce when a file handle is briefly held open after close. Duplicated across the two packages rather than centralized to avoid deepening the existing `findings → ingest → dogfood-swarm → findings` workspace cycle (per CLAUDE.md §4 graph note). Wired into the `atomic-write` two-phase commit and the `event-log` append-and-rename sites.
- **Domain-map recovery for `ci-tooling` scope** ([`swarms/swarm-1778729265-8a9f/control-plane.db`](swarms/swarm-1778729265-8a9f/control-plane.db) `domain_events`). The init-time frozen domain map omitted `scripts/**` from `ci-tooling`; recovery flow via `swarm domains --unfreeze` → `swarm domains --edit ci-tooling --globs ".github/**,scripts/**"` → `swarm domains --freeze`, with the operational rationale captured in `domain_events.reason` and the truthful `files_changed` audit preserved end-to-end rather than trimming output JSON to hide what the agent did.

### Changed

- **Prevention-A: `scripts/doc-drift-patterns.json` `agent-output-schema` targets glob expanded** to include `swarms/swarm-*/wave-*/outputs/*.json` (was scoped to `swarms/__schema-fixtures__/*.json` only). The schema-conformance gate now fires at every `check-doc-drift` run against live agent outputs — wave-2's first collect rejected outputs for `fixes_applied`/`files_edited` vs canonical `fixes`/`files_changed` drift after agents had already run; expanding the glob fires that gate at push time so coordinator-brief drift surfaces before agents are dispatched. The hint comment at `doc-drift-patterns.json:237` had explicitly flagged this expansion as a deferred step; this release lands it.
- **Documentation reconciliation of "all 7 packages private" claim** — README.md `## Versioning`, SHIP_GATE.md D-48 + D-50, SECURITY.md `## Scope`, and four HANDOFF.md locations now consistently state: **six of seven `@dogfood-lab/*` packages are `private: true`; `@dogfood-lab/schemas` is publish-ready (declares `publishConfig.access=public` and a `files` whitelist) but has not been published to npm**. No code change to `packages/schemas/package.json` — the schemas package was always publish-ready by design; the docs had drifted to assert a blanket `private: true` that was never literally true. The npm publish decision remains deferred per HANDOFF.md Session G.
- **CLAUDE.md `Cross-package imports` rule extended with a workspace-dependency-graph note** — documents that `findings → ingest → dogfood-swarm → findings` forms a cycle by design (npm workspaces resolve it via symlinks), explains why it's accepted, and supersedes the v1.1.4 CHANGELOG's "one-way edge, no cycle" framing which became stale when v1.1.5 added the `ingest → dogfood-swarm` `logStage` edge.
- **SECURITY.md `## Scope` rewrite** — removed the dishonest "published as `@dogfood-lab/*` on npm" claim and replaced with the real attack surface: adversarial submissions arriving over the `repository_dispatch` ingest seam, the JSON evidence schema, the policy-merge path. F-W1-DOCS-006.

### Test Infrastructure

- **F-084568-005 regression-pin tests added to [`packages/dogfood-swarm/advance.test.js`](packages/dogfood-swarm/advance.test.js)** exercising the latest-per-domain `MAX(ar2.id)` filter in `checkGates`. No longer an orphan source pin in `check-finding-regression-pins`; net 92 test pins / 40 source pins.
- **F-W1-TEST-001…004 vacuous-pass tests refactored to honest pass-or-fail.** Adapter probes now operate against synthetic `tmpdir()` fixtures rather than no-op against missing files; the silent-pass else-branch in `wave17-*.test.js` now `assert.fail`s; in-process "concurrency" smoke tests renamed to "serial smoke" with honest comments (multi-process forks remain the canonical race detectors).
- **Windows event-log-race teardown stabilization** ([`packages/ingest/event-log-race.test.js`](packages/ingest/event-log-race.test.js), [`packages/ingest/wave22-log-stage-discipline.test.js`](packages/ingest/wave22-log-stage-discipline.test.js)). `TEST_ROOT` relocated to `os.tmpdir()` and teardown uses an `rmSyncWithRetry` helper for the AV-scan handle-release window. Production `renameWithRetry` (above) untouched.

### Notes

- The Wave 2 health-amend-a wedge (four agent_runs stuck in `invalid_output` after a brief/schema mismatch on `fixes_applied` vs `fixes`) was recovered through `swarm revalidate` rather than raw SQL — a deliberate proof-of-discipline that this release's recovery verb is the right shape.
- Phase 2-B candidates filed for future work (NOT in this release): coordinator-brief vs frozen-state drift detection (N=2 instances observed in this swarm); schema-derived prompt-injection so the brief's JSON example is generated from `agent-output.schema.json` rather than hand-typed.
- Final swarm version of Phase 7 commentary preserved below for history: wave-31 audit findings + Pattern #9/#10 reframes + the closing fence-tag self-incrimination instance. Phase 7 swarm declared complete (Option I — ship-and-stop): ~31 waves, ~115 fixes verified holding, 14 audit-coverage classes, 5 cross-pollination chains, Class #14 5-iteration recursion arc. Cross-swarm methodology takeaways + 7-session post-swarm roadmap captured in [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md).

### Fixed (Phase 7 wave-31 — preserved from prior `[Unreleased]`)

- **`scripts/apply-finding-migration.mjs`** entrypoint detection — switched from `file://${process.argv[1]}` to canonical `pathToFileURL` pattern. Previous form silently no-op'd on Windows because `process.argv[1]` uses backslashes while `import.meta.url` is always POSIX/URL form. Caught by wave-31 audit-the-audit. Class #14 5th-iteration instance (productization caught its own incomplete productization).
- **Untagged code fence** in [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md) (the `verified_via_distribution` display block — line number intentionally omitted because the file is live and the offset drifts on each edit; the section anchor is the stable reference) — closed by the doc-drift `untagged-fence` handler (Pattern #5, wave-23 origin) firing against the swarm's own closure receipt. Most fitting self-incrimination instance of the entire 31-wave run: the discipline closed on its own closing artifact.

### Changed (Phase 7 wave-31 — preserved from prior `[Unreleased]`)

- **`cross_ref` data refinements** per wave-31 audit calibration: F-375053-003 symbol `MAX(ar2.id)` (non-identifier SQL) → `agentRuns` (line 72 variable). F-246817-002 symbol `validate` (too generic) → `remediated_at` line 177. F-129818-002 evidence wording tightened. F-091578-041 cross_ref entry added (was missed in v1.1.6). v2 `verified_via_distribution` shifted from `{ anchor:185, cross_ref:3, allowlist:5 }` to **`{ anchor:182, cross_ref:5, allowlist:6, unverifiable:6 }`**. claimed-but-still-present: 19 → 16. verified: 150 → 153.
- **Pattern #9 reframe** (post-wave-31 two-instance evidence): wave 2 = 1.79× cascade leverage, wave 3 = 1.00×. Reframed from "structural fixes WILL produce 1.5×+ leverage" to "structural fixes CAN produce cascade closures." Cascade is a bonus, not a planning input.
- **Pattern #10 prior-art reframe** (post-wave-31 ci-tooling audit): 3 organically-emerging instances predate wave-30's pattern naming (`sync-version.mjs --check`, `apply-finding-migration.mjs --check`, doc-drift `framework-self-test` handler). Wave 30 documented an organic practice rather than originating it. Future patterns: audit prior art before claiming origination.

### Notes (Phase 7 wave-31)

- Tests: 965/965 (no test changes; structural-only cleanup).
- **Coordinator scope expansion** (2nd consecutive). Same 5-factor test as v1.1.6 holds. NOT blanket precedent — a 3rd instance warrants policy revisit.
- [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md) is the authoritative catalog for the entire Phase 7 swarm and the 7-session post-swarm roadmap (Sessions A–G). Read it before dispatching any future swarm against testing-os.

## [1.1.6] — 2026-04-27

Wave-30 v2 capability data infrastructure. Schema migration + data migration to wire `verify-fixed v2`'s vantage-point fields through the production data path (not just function-level mocks). Class #14 self-application: the v2 capability shipped at function level had a Class #14 vulnerability of its own at the data layer, caught at the migration boundary by coordinator semantic check.

### Added

- **`cross_ref TEXT`**, **`coordinator_resolved INTEGER NOT NULL DEFAULT 0`**, **`verified_via_evidence TEXT`** columns on `findings` table. SCHEMA_VERSION bumped 3 → 4 via existing idempotent `MIGRATIONS_SQL` pattern; mirrored in `db/schema.js` `CREATE TABLE` for fresh DBs.
- **`scripts/apply-finding-migration.mjs`** — idempotent migration runner with `--check` mode, transaction-wrapped UPDATEs, per-finding skip-if-already-set check.
- **`swarms/migrations/wave-30-incidental-cross-refs.json`** — manifest with 6 cross_ref + 5 coordinator_resolved entries; full audit trail including the 5-factor scope-expansion log.

### Changed

- **`loadFixedFindings`** (`lib/verify-fixed.js`) extended to SELECT new columns. Hydrates `cross_ref` JSON → object, `coordinator_resolved` 0/1 → boolean. v2 classifier now reads vantage-point fields from production data.
- **`verified_via_distribution`** shifted from `{ anchor: 193, cross_ref: 0, allowlist: 0 }` to **`{ anchor: 185, cross_ref: 3, allowlist: 5, unverifiable: 6 }`**. claimed-but-still-present: 27 → 19 (-8); verified: 141 → 150 (+9). 3 cross_ref entries fell through to anchor (primary anchor matched in current state) — fall-through path of v2 worked as designed.

### Notes

- **Pattern #10 (NEW)** documented in [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md): 2-step FAILS-then-PASSES proof gate. Distinct from Pattern #2 (`doesNotMatch` unit-level) — Pattern #10 is safety-mechanism efficacy at integration / concurrency level. (Subsequently reframed in v1.1.7 as "documented organic practice, not original.")
- **Class #14 maturation — 4th evidence class:** methodology self-application. Future productization waves should include "wired through to production data path" verification as part of the wave's own closure check, not just function-level test coverage.
- **Coordinator scope expansion** (1st instance): schema + data migration applied without agent dispatch under a documented 5-factor test (antecedents in place; bounded scope ~50 LoC across 5 files; authority alternative cost ≥10×; methodology stakes; full coordinator context). NOT blanket coordinator authority for small dev tasks.
- Tests: 965/965 unchanged from v1.1.5 (schema + query plumbing exercised end-to-end via the production v2 run).

## [1.1.5] — 2026-04-27

Phase 7 wave 3. `verify-fixed v2` verb family + pipeline atomicity. Class #14b productization (classifier vantage-point limit surfaced wave-29) and structural-concurrency closures on event-log + index rebuild. Tests: 899 → 965 (+66; backend +45, ingest +21).

### Added

- **`lib/verify-classifier-v2.js`** — shared base with 5-value `verified_via` vantage-point disclosure (anchor / cross_ref / allowlist / agent_attestation / unverifiable). Decision order: allowlist → agent_attestation → anchor. cross_ref overrides `claimed-but-still-present` (Class #14b core: symbol is the target of consumer-side fix) but NOT `regressed` (anchor movement is real signal). Pattern #8 shared envelope with `verified_via_distribution`.
- **`swarm verify-recurring`**, **`swarm verify-unverified`**, **`swarm verify-approved`** sibling commands (FT-BACKEND-EXTRA-A/B/C — completes the verb family).
- **`findings/lib/file-lock.js`** — cross-process advisory lock. `writeFileSync(tmp, pid) + linkSync(tmp, lockPath)` one-syscall publication closes the `open(wx)+writeSync` race. Dead-PID stale recovery via rename-to-graveyard CAS (necessary because unlink+create produces double-owner race on holder-release / stale-detect collision). Closes Windows dirent-cache TOCTOU on `existsSync → readFileSync` via try/catch on ENOENT inside the locked critical section.
- **`packages/ingest/lib/atomic-write.js`** — sibling helper for ingest, cycle-blocked from importing the findings/lib copy. Two-phase commit + journal `.in-progress.<pid>.<rand>.json` for `rebuildIndexes` 3-file transactional atomicity. Promote in dependency order; idempotent `cleanupCrashedJournals` at every entry.
- **2-step FAILS-then-PASSES proof gate** for the lock — `DISABLE_APPEND_LOCK=1` reproduces race (3 multi-process iterations fail); without env var 12/12 pass × 30 consecutive runs. Switch preserved as documented proof gate.

### Changed

- **`commands/verify-fixed.js`** refactored to v2 (schema `verify-fixed-delta/v2`). Closes F-WAVE29-001 (verify-fixed v1 vantage-point limit surfaced wave 29).
- **F-091578-041** message-shape pin in `wave12-observability.test.js` (carryover).

### Notes

- **Class #14 reframed as fractal** with sub-modes 14a (human claim, productized as verify-fixed v1) and 14b (classifier vantage-point limit, productized as v2). Methodology axiom: verification has fractal structure.
- **New methodology section** in [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md): "Methodology recursion — three evidence classes" capturing progression from substantive → methodology → methodology-efficacy across waves 1-29.
- **Pattern #9 first numerical leverage measurement:** wave 2 dispatched 14 items → 25 effective closures = **1.79× cascade leverage** (interpretation reframed in v1.1.7).
- Wave 30 (Phase 7 feature-execute): 2 active domains, 0 ownership violations, 0 NEW CRIT, 0 NEW HIGH. Invariants intact: F-742442-041 LIVE catch unchanged; W2-BACK-001 `validateAgentOutput` still wired; W2-PIPE-EXTRA `unsafe-segment.js` still sole definition.

## [1.1.4] — 2026-04-27

Phase 7 wave 2. Wave-1 follow-through + Class #14 LIVE catch. 12 cross-fix-deps + wave-27 addition + Phase 5 #1 canonical extraction (`unsafeSegment` helper). Tests 806 → 861 (+55). 4 active domains, 3 coordinator cleanups, zero ownership violations.

### Added

- **`lib/validate-agent-output.js`** (Ajv2020 + `AgentOutputValidationError` typed) wired into `collect.js` BEFORE legacy validators — schema-conformance enforced at write time, not just CI. Closes Class #11 end-to-end (W2-BACK-001).
- **`packages/ingest/lib/unsafe-segment.js`** — Phase 5 #1 canonical extraction. `UNSAFE_SEGMENT` regex + `isUnsafeSegment` predicate. Workspace plumbing: ingest exports `./lib/*`; findings adds `@dogfood-lab/ingest` dep (one-way edge, no cycle). 3 callsites adopted: `persist.js`, `load-context.js` (both `loadRepoPolicy` + `githubScenarioFetcher`), `findings/derive/load-records.js`. Plus `wave28-unsafe-segment-discipline.test.js` mirrors wave-22 log-stage shape.
- **`scripts/check-finding-regression-pins.mjs`** CI gate consuming wave-1 `parse-regression-pins.js`. Asymmetric: exits 1 only on `orphan_source_ids`. 15-test suite. Allowlist for parser permissive-prose limitation (3 entries).
- **`AUDIT_CATEGORIES`** extended with 5 historical reused categories (`hygiene`, `error_message_quality`, `cli_help_quality`, `silent_failure`, `tests_coverage`). Coordinator mirrored into `agent-output.schema.json`.
- **correlation_id** at backend logStage callsites (`collect.js:upsert_findings_failed`, `dispatch.js:isolate_failed`). `coord-<base36-ts>-<rand4>` sibling to FT-PIPELINE-004's `ing-*` pattern. `lib/log-stage.js` `formatHumanBanner()` surfaces correlation_id (handles snake_case + camelCase defensively).
- **`--write-index`** opt-in flag (default null). Mike-controlled workflow enablement.

### Changed

- **6 dogfood-swarm/ atomic-write callers** migrated to the shared helper. `lib/verify/runner.js` confirmed STALE (no callsites — removed). Raw `writeFileSync` count in dogfood-swarm/ source: 11 → 0.
- **F-id pin sweep** across `packages/dogfood-swarm/test/` (68 → 69) and `packages/{verify,findings,ingest}/`. `findings.test.js` 0 → 9 pins; `advise.test.js` 0 → 7 pins. Anchor: F-742442-047 (advise/query.js dead-code filter regression target).
- **verify chain** extended with `check-regression-pins` as hard-gate before `test:scripts`. test:scripts: 75 → 91 (+16).
- **SVG currency assertion** in `check-handbook-imagery.test.mjs` (W2-CI-004, NEW from wave-27 D27-DOCS-001) — reads `checks.length=13` from `doc-drift-patterns.json` + parses `verify-output.svg` caption + desc; asserts 13/13/13 match. Self-reflexive Class #11 instance.
- **`verify-output.svg` + `beginners.md` alt text** refreshed (5 → 13 checks).
- **`packages/portfolio/package.json`** adds `exports` field per CLAUDE.md rule #4 (coordinator cleanup).

### Fixed

- **F-742442-041 path-traversal guard** missing in `loadRecordsForRepo` despite being marked [fixed] in wave-11/13. Canonical wave-1 incomplete-fix CONFIRMED LIVE — one of the 27 claimed-but-still-present findings the wave-27 verify-fixed run predicted. Helper-adoption sweep simultaneously closed Class #9 propagation gap AND re-established the F-742442-041 contract.

### Notes

- **Pattern #8 (parallel cross-pollination)** validated again: backend's W2-BACK-004 `unsafeSegment` surfacing → pipeline's W2-PIPE-EXTRA delivered in parallel without sequential handoff. Two confirmed instances now.
- **Class #14 maturation:** wave-24 prediction → wave-27 productized verify-fixed (27 claimed-but-still-present) → wave-28 surfaced ONE concrete instance (F-742442-041 missing guard). The discipline is no longer hypothetical.
- Coordinator cleanups (3, mechanical): `agent-output.schema.json` category enum mirror; `doc-drift-patterns.json` atomic-write allowlist 13 → 6 entries; portfolio `exports` field.
- Tests at v1.1.4: 861/861 (test:scripts 91; dogfood-swarm 335 (+31 wave28-cross-fix); ingest 64 (+8 net; wave28-unsafe-segment +18, refactors -10)).

## [1.1.3] — 2026-04-27

Phase 7 wave 1. Drift-checker framework + Class #14 productization. 6 features (2 CRIT + 4 HIGH), 4 active domains, 0 ownership violations. 12 of 14 audit-coverage classes now tooling-or-config-enforced. Tests 704 → 844 (+140; 731 workspace JS + 38 schemas vitest + 75 scripts).

### Added

- **`scripts/check-doc-drift.mjs` 7-handler framework** — generalized from single-purpose to `helper-adoption-sweep`, `schema-conformance`, `framework-self-test` + 4 refactored. Closes Class #9 systematically — drift-checker family becomes truly general. 17 → 41 tests in scripts/. (FT-CITOOLING-001)
- **`scripts/agent-output.schema.json`** — JSON Schema 2020-12 collect-time schema-conformance gate, lockstep with `packages/dogfood-swarm/lib/output-schema.js`. Closes Class #11 as write-time contract. Re-routed from `swarms/` → `scripts/` per Phase 5 #7 edit_path discipline (third instance of audit-surface != edit-surface routing class). (FT-CITOOLING-002)
- **`swarm verify-fixed`** command + `lib/verify-fixed.js` classifier (`verify-fixed-delta/v1` shape, 4-way classification with +/-2-line tolerance, anchor preference for symbol then identifier, exit codes per wave-18 3-way 0/1/2). 269 → 304 tests. **First live run on `swarm-1777234130-30e3` across 199 fixed findings: 141 verified / 27 claimed-but-still-present / 25 regressed / 6 unverifiable. 52 of 199 (26%) need re-investigation.** Class #14 productization caught at scale what wave-by-wave audits missed. (FT-BACKEND-002)
- **Regression-on-historical-bugs harness** — F-id pin sweep across `packages/{report,portfolio,schemas}` + `parse-regression-pins.js` library function. Asymmetric design: only `orphan_source_ids` trigger CI failure. Portfolio 21 → 57 tests. (FT-OUTPUTS-001)
- **`--verify-only` flag** — filesystem side-effect-free verify path; `would_persist_to` via `computeRecordPath`; `verifyOnly()` exported from `@dogfood-lab/ingest`. 90% built before audit (existing internal `_skipPersist` path) — validates the "rich `lib/`, thin CLI veneer" thesis. (FT-PIPELINE-001)
- **correlation IDs** flow through 12 `logStage` callsites (8 in ingest + 4 in verifyOnly). `run_id` for valid submissions; synthetic `ing-<base36-ts>-<rand4>` for invalid. Wave-22 wrapper-strip pattern preserved. 42 → 56 ingest tests. (FT-PIPELINE-004)
- **[`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md)** — Phase 10 Refinement-4 evidence catalog (24 waves, 4 stages, ~82 fixes, 14 audit-coverage classes, 7 positive design patterns, 5 cross-pollination chains, 10 Phase 5 candidates with 2 confirmed). Markdown fallback after `rk init` failed during Phase 10 with `ENOENT: schema.sql not found` in npm-cached `@mcptoolshop/repo-knowledge@1.0.5` (broken-package, sibling to wave-1 ai-loadout build issue).

### Fixed

- **`classifyFile` cross-platform path normalization** (portfolio) — used `filePath.split(sep).join(posix.sep)` which is a no-op when `sep === '/'` on the GHA Linux runner. Windows-format inputs (`C:\repo\...\test\...`) hit regex/includes checks with backslashes still in place — `'\test\'` does not match `'/test/'`. Fix: replace `\` globally after split/join. Documented `path.sep` blind-spot family (`memory/feedback_audit_path_sep_blind_spot.md`). Test was correctly written from the start; implementation lagged because wave-1 work was authored on Windows.
- **pa11y `--no-sandbox` shim** for GHA puppeteer — wave-22 pa11y CI gate (D-OUT-003) failed first run because GitHub Actions ubuntu-latest disables the SUID sandbox. Inline `/tmp/pa11y-ci.json` with `chromeLaunchConfig.args [--no-sandbox, --disable-setuid-sandbox]`. Kept inline rather than checked-in `.pa11yrc.json` because the only reason the config exists is the GHA runner kernel constraint. CI run 24977857262 surfaced this.
- **Light-mode accent ramp** — `--sl-color-accent: #34d399` (logo emerald) gives 1.92:1 contrast against light-mode white, failing WCAG AA 4.5:1. Pa11y reported 6 violations across links / TOC / breadcrumbs. Resolves D-DOCS-004 per audit option (a): `html[data-theme='light']` block with `#008857` (darker emerald, same hue, 4.55:1 = WCAG AA pass). Dark mode unchanged at `#34d399` (logo-matching). `check-accent-color.test.mjs` still asserts dark-mode value matches logo; light-mode is a derived value, intentionally NOT asserted. **Methodology finding**: TEST SURFACE != VISUAL SURFACE. Wave-23 contrast unit test only audited callout body text. Pa11y on real deployed site caught violations the unit test didn't reach. New Phase 5 candidate #10: contrast unit test should sweep ALL text-using-accent surfaces in BOTH modes.

### Notes

- **Positive design pattern #8 (NEW):** contract-specified parallel cross-pollination. Outputs and backend produced compatible JSON shapes from briefing-specified contract alone — no serialized hand-off, no consumer awareness of producer's prior output. The strongest cross-pollination form yet observed.
- **Class #9 maturation 4-stage progression:** briefing-only → audit-time sweep → amend-time sweep → execution-time sweep. Backend agent surfaced 3 sibling commands (`verify-recurring`, `verify-unverified`, `verify-approved`) DURING execution of FT-BACKEND-002 — Class #9 sweep discipline now agent-internalized at execution time.
- Phase 5 audit calibration validated: effort estimates exact (4M + 2S delivered as predicted). "Rich `lib/*`, thin CLI veneer" thesis held — many "missing capabilities" were wiring for already-shipped library code.
- Wave 27 re-audit: 0 NEW CRIT / 0 NEW HIGH / 1 NEW MED / 9 LOW. Remaining un-tooled classes: #5 worktree filesystem behavior (architectural); #12 under-triaged observability calibration (human discipline).
- Cross-pollination chain #2 (logStage extraction): VERIFIED COMPLETE four ways (wave-22 sweep, wave-24 re-sweep, Phase 9 stress test, Phase 7 wave 1 correlation_id pinning).

## [1.1.2] — 2026-04-27

Comprehensive dogfood swarm execution across 24 waves and 4 stages, applied to testing-os itself (the swarm tooling auditing the swarm tooling). Total: ~82 verified-holding fixes; +231 tests over baseline (473 → 704).

### Added

- **Stage A** (waves 1-6): 22 amends, bug/security pass — 508 tests.
- **Stage B** (waves 7-15): 28 amends, proactive defensive pass + 12 audit-coverage taxonomy classes documented — 643 tests.
- **Stage C** (waves 16-20): 21 amends, humanization pass + 5 cross-pollination chains validated + 2 Stage C reference pages (`state-machines.md`, `error-codes.md`) — 688 tests.
- **Stage D** (waves 21-24): 11 amends, visual-polish pass — 704 tests. Headline deliverables: pa11y CI gate (`.github/workflows/pages.yml`) on deployed handbook; severity-tier visual distinction in `error-codes.md` via Starlight Asides; mobile nav `<details>` disclosure under 768px; accent-color reconciled to logo (`#34d399` emerald, verified against logo file — caught a verifiable lie in the prior comment); architecture SVG diagram + CLI screenshot SVG (real, accessible); 3 ASCII state diagrams matching prose+tables exactly; TTY-aware findings renderer (`lib/findings-render.js`) extending wave-17 `shouldEmitHuman` pattern with `DOGFOOD_FINDINGS_FORMAT` env override.
- **Cross-pollination chain #2** (logStage extraction) verified COMPLETE end-to-end via wave-22 sweep + wave-24 re-sweep + Phase 9 stress test.
- **Wave 22 ingest atomicity:** D-PIPE-001 ingest private logStage → shared helper migration + sweep invariant test (regression catches future private logStage definitions); D-PIPE-002 stage-collision spread-last-wins → `failed_stage` rename + defensive wrapper-strip belt-and-braces; D-OUT-003 minimum visual regression CI gate (pa11y + cross-wave-deferred contrast unit test slot).

### Changed

- **Wave 22 collect-time normalize** for pipeline.json (lowercase severities; summary/detail field names; fingerprint disambiguation).
- **Wave 23 `package.json` test:scripts** wire-up (3 new docs-written test files: `check-severity-contrast`, `check-accent-color`, `check-handbook-imagery`; 28 → 52 tests).
- **Phase 9 F-916867-001:** `state-machines.md` "default 14 days" → "default 30 days" matching `DEFAULT_MAX_AGE` in `portfolio/generate.js`.
- **Wave 23 ownership-violation override:** docs agent edited 6 files in `scripts/` (ci-tooling domain) per under-specified coordinator briefing on cross-wave handoff. Override logged in `agent_state_events` with full rationale. Routing model deficit promoted to confirmed Phase 5 #7 deliverable. Wave-24 re-audit confirmed the work belongs in scripts/ stylistically.

### Notes

- **Methodology corrections** (Stage D closure receipt — 8 items): cross-pollination claim shape (validate against new + pre-existing callers + sweep automation in place + invariant test); within-stage vs across-stage convergence are distinct properties; Class #9 sweep-automation now evidence-backed; wrapper-strip / choke-point pattern (fix at choke-point so bug-class is impossible to recur); cross-wave-dependency as first-class skip reason; logo-verification-first (read the file, not the comment); state-machine-aware drift handler; `edit_path` field distinct from `file_path`.
- **Positive design patterns documented** (cumulative): verdict-first banner, doesNotMatch sanity check, reference-page-as-glossary, choke-point-fix-makes-bug-class-impossible, state-machine-aware drift handler, cross-wave-dependency formalized.
- **Phase 5 candidates surfaced** (9 total, 2 confirmed at v1.1.2): CONFIRMED — `check-shared-helper-adoption.mjs` / `check-drift.mjs` generalization; `edit_path` field distinct from `file_path`. Candidates: swarm tail real-time human banner; provenance-on-display for resolve-vs-stored values; visual regression CI gate productization (beyond pa11y); cross-repo drift-checker (Class #13 propagation); collect-time normalize step for agent-format-drift; cross-wave-dependency formal skip in briefing template; vitest config narrowing (Phase 9).
- **Self-incrimination tally** (swarm tooling bugs caught + fixed by the swarm running on it): findings-digest severity arithmetic + file-glob (waves 8-9); fingerprint description-hash + ID-as-symbol disambiguation (wave 8); classifier marking deferrals as fixed without evidence (wave 7); `dispatch.js --isolate` silent fallback (wave 12); `dispatch.js` domain-filter dumping all findings to all agents (wave 2.5); logStage cross-pollination chain incomplete (wave 22).
- Wave 24 deferred to Phase 5: F-916867-002/003 (wave-1 "marked [fixed]" without actually landing — recurring incomplete fix detection); F-916867-004 (portfolio CLI verdict-first carryover); F-916867-005 (path-traversal helper missing in 1 of 3 callsites); GHA UI screenshot from D-DOCS-008; Mermaid stateDiagram-v2 (build-time SVG, not runtime).
- Brand canon discipline: `site/public/logo.png` byte-untouched (sha256 30093bd6..., 950504 bytes). Translations: Mike runs polyglot-mcp locally per discipline.
- Tests at v1.1.2: 704/704 pass, 0 fail. Vitest separately reports 38 schema-package tests passing; 6 file-load "failures" are pre-existing config issue (vitest walking workspace, trying to load node:test format files). Phase 5 candidate #9.

## [1.1.1] — 2026-04-25

Bug fix release. Two Stage D dispatch blockers shipped in v1.1.0 caught at first dispatch (no agents ran yet):

### Fixed

- **`lib/output-schema.js`** — `validateAuditOutput` stage enum was hardcoded `['A', 'B', 'C']`. Stage D outputs (stage = 'D') failed validation, causing `swarm collect` to reject every audit row even though dispatch and prompt generation succeeded. Enum extended to `['A', 'B', 'C', 'D']`. Error message updated. Validator now accepts Stage D outputs.
- **`lib/templates.js`** — JSON output template extracted stage letter via `opts.phase.split('-').pop().toUpperCase()`. The naming convention isn't symmetric: `health-audit-{a,b,c}` puts the letter last, but `stage-d-{audit,amend}` puts the action last. For phase `stage-d-audit` the extraction returned `'AUDIT'`, not `'D'`. Replaced with explicit `PHASE_TO_STAGE` map keyed on phase name. Documented inline why the symmetry break exists.

Both bugs are the same B.7 blind-spot pattern (`memory/feedback_intra_workspace_downstream_audit.md`) that motivated v1.1.0: Stage D added at protocol-spec layer, downstream code that depends on phase strings didn't follow. The v1.1.0 patch covered the obvious downstream (PHASE_MAP, AUDIT_PHASES, AMEND_PHASES, FINDING_GATED_PHASES, CLI help) but missed the validator's stage enum and the template's stage-letter extraction. Both now have explicit test coverage in `control-plane.test.js`.

### Added

- **Stage D prompt template test** — `buildAuditPrompt({phase: 'stage-d-audit'})` asserted to embed `"stage": "D"` in the JSON output schema.
- **Stage D validator test** — `validateAuditOutput({stage: 'D', ...})` asserted to accept (parallel to existing A/B/C tests).
- **PHASE_TO_STAGE map** — explicit phase-name → stage-letter table in `lib/templates.js`. Future phase additions update the map alongside the validator's stage enum (single change, two-side update).

### Notes

- 178 tests pass in `@dogfood-lab/dogfood-swarm` (was 176 in v1.1.0). Net +2 tests for Stage D regression coverage.
- No behavioral change for existing Stage A/B/C consumers; Stage D consumers were broken pre-v1.1.1 and now work.

## [1.1.0] — 2026-04-25

Stage D Visual Polish becomes a first-class phase in the swarm protocol. Added at the protocol-spec layer (`memory/dogfood-swarm.md`) on 2026-04-25 after the runforge-vscode v1.1.0 swarm exposed the Stage C gap; this release propagates the spec into the `@dogfood-lab/dogfood-swarm` CLI implementation so consumers can dispatch `stage-d-audit` / `stage-d-amend` as recognized phases. Receipts from the first reference run land at `swarms/mcp-tool-shop-org--runforge-vscode/stage-d/`.

### Added

- **`stage-d-audit` + `stage-d-amend` phases** in `packages/dogfood-swarm/`. Recognized by `swarm dispatch`, `swarm collect`, `swarm advance`, and `swarm resume`.
- **Visual Polish lens** in `packages/dogfood-swarm/lib/templates.js` (`STAGE_LENS['stage-d-audit']`). Mirrors the canonical bullet list from `memory/dogfood-swarm.md` verbatim — typography/spacing/layout, iconography & assets, color/theming/dark-mode, animated demonstrations, command palette presentation, status bar integration, first-run welcome, settings UI grouping, marketplace listing visuals.
- **Stage D in `FINDING_GATED_PHASES`** (`lib/advance.js`). HIGH/CRITICAL visual findings block advance, same severity rigor as bug fixes.
- **CLI help + error messages** updated to list the new phases.
- **`advance.test.js`** coverage: PHASE_MAP includes `stage-d-{audit,amend}`, finding-gating asserted, multi-phase progression test extended to `health-audit-a → b → c → stage-d-audit → feature-audit`.

### Changed

- **`PHASE_MAP` restructured** to slot Stage D between the health pass and feature pass. `health-audit-c.next` flips from `feature-audit` to `stage-d-audit`. `stage-d-audit.next` is `feature-audit`. The amend lane returns: `stage-d-amend.next = stage-d-audit`. Existing health and feature transitions are unchanged.
- **`health-audit-c` (Humanization) lens copy** now explicitly scopes itself to BEHAVIORAL polish (text, behavior, accessibility-of-content) and points readers at Stage D for visual polish. Prevents the "Stage C interpreted as covering visual" gap that triggered Stage D's creation.

### Notes

- Backward-compatible: existing runs that have already promoted past `health-audit-c` still advance normally. New runs flow through Stage D before reaching `feature-audit`.
- Cross-references: pattern #18 in `memory/dogfood-swarm.md`; runforge-vscode `swarms/mcp-tool-shop-org--runforge-vscode/stage-d/` is the reference run for future Stage D dispatches.

## [1.0.0] — 2026-04-25

First stable release. The migration from `mcp-tool-shop-org/dogfood-labs` is complete and the post-migration polish in [HANDOFF.md](HANDOFF.md) sessions A–G has shipped. Consumers can now pin to `^1.0.0` confidently.

### Added

- **`@dogfood-lab/schemas`** — TypeScript package with the 8 JSON schemas (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). 5 vitest tests.
- **`@dogfood-lab/verify`** — central submission validator (290 `node:test` tests across the JS packages).
- **`@dogfood-lab/findings`** — finding contract + derive/review/synthesis/advise pipelines.
- **`@dogfood-lab/ingest`** — pipeline glue: dispatch → verify → persist → indexes.
- **`@dogfood-lab/report`** — submission builder for source repos.
- **`@dogfood-lab/portfolio`** — cross-repo portfolio generator.
- **`@dogfood-lab/dogfood-swarm`** — 10-phase parallel-agent protocol + SQLite control plane + `swarm` CLI bin (173 tests).
- **`.github/workflows/ingest.yml`** — receives `repository_dispatch` of type `dogfood_submission` from consumers, runs the ingest pipeline, commits new records and indexes back to `main`. Concurrency-safe (per-repo group, no cancel-in-progress) with retry-on-conflict push loop.
- **`.github/workflows/pages.yml`** — builds and deploys the Astro Starlight handbook to [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Includes a verify-200 curl loop that fails the deploy on stale CDN.
- **`site/`** — Astro Starlight handbook with 7 pages (architecture, beginners, contracts, integration, intelligence layer, operating guide, and the index landing). Migrated from the legacy repo with full link rewrites for the new layout.
- **README.md badges + version-sync block** — CI, Pages, License, Node ≥ 20 badges; `<!-- version:start -->` block auto-stamped from `package.json` via `scripts/sync-version.mjs` (runs as `prebuild`).
- **`CONTRIBUTING.md`** — points at `CLAUDE.md` as the operating manual.
- **`SHIP_GATE.md`** + **`SCORECARD.md`** — `shipcheck`-driven product standards. Hard gates A–D pass at 100%.
- **README.md threat model paragraph** — what this code touches, what it doesn't, permissions required, telemetry posture.
- **Logo** at `assets/logo.png` and `site/public/logo.png` — wired into the README header and the handbook's Starlight chrome.
- **7 README translations** (ja, zh, es, fr, hi, it, pt-BR) via polyglot-mcp's `translate-all.mjs`. Language nav bar at the top of every variant.
- **GitHub repo metadata** — description, homepage, topics (`ai-tooling`, `dogfood-lab`, `mcp-tool-shop`, `monorepo`, `npm-workspaces`, `testing`).

### Changed

- All 8 JSON schemas (`packages/schemas/src/json/*.json`) now have `$id` URLs pointing at the canonical monorepo location: `https://github.com/dogfood-lab/testing-os/packages/schemas/src/json/<name>.schema.json`. Replaces the legacy `mcp-tool-shop-org/dogfood-labs/schemas/...` URLs.
- npm scope `@dogfood-labs/*` (legacy, plural) is retired; everything is `@dogfood-lab/*` (singular).
- HANDOFF.md tracks Sessions A–G as complete; Session H (legacy-repo deletion) is gated on Mike's explicit approval and a 30-day grace window per the doc.

### Deprecated

- The legacy repo `mcp-tool-shop-org/dogfood-labs` is **archived** (read-only). Its raw URLs continue to serve until Session H deletes the repo.
- `repo-knowledge`'s back-compat fallback for `tools/findings/cli.js` (legacy layout) remains intentional until Session H confirms no callers depend on it.

### Verified end-to-end (Session A)

- Consumer dogfood (`mcp-tool-shop-org/claude-guardian`) → manual dispatch (because consumer `DOGFOOD_TOKEN` secret is missing — tracked as a follow-up) → `ingest.yml` run [24922250743](https://github.com/dogfood-lab/testing-os/actions/runs/24922250743) → record [`records/mcp-tool-shop-org/claude-guardian/2026/04/25/run-claude-guardian-24922209099-1.json`](records/mcp-tool-shop-org/claude-guardian/2026/04/25/run-claude-guardian-24922209099-1.json) → `latest-by-repo.json` updated → `shipcheck dogfood` exits 0 → `repo-knowledge sync-dogfood` populates 91 facts.

### Known follow-ups

- `DOGFOOD_TOKEN` secret missing on every consumer repo — dispatch step skips with a warning. User-side action.
- ai-loadout `main` build is broken (`tsc` errors on missing `@types/node`); independent of this migration.
- All pinned action SHAs (`actions/checkout@34e1148`, `actions/setup-node@49933ea`, etc.) are Node 20 — GitHub deprecates Node 20 by 2026-09-16.
- `site/` `npm audit` reports 8 vulnerabilities (5 moderate, 3 high) inherited from the legacy lockfile; not blocking deployment.
- Workspace dep scanning + Dependabot config not yet wired into CI; tracked under SHIP_GATE.md hygiene SKIPs.
- All 7 packages are `private: true`. The `npm publish` decision is deferred per HANDOFF.md Session G.
