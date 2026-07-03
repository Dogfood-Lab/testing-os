# Changelog

All notable changes to `testing-os` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] — 2026-07-03

The full-dogfood-swarm release: a four-stage health pass (bug/security → proactive → humanization → visual polish, ~162 verified fixes, every one pinned by a RED-then-GREEN test) followed by an approved feature pass. The suite grew from ~2,106 to ~2,700+ tests.

### Added

- **`swarm defer` / `swarm reject`** — the two missing finding-disposition verbs. Both take `--ids` + a mandatory `--reason` recorded in the finding's event history. A deferred finding is now terminal for classification, so a full-coverage re-audit no longer silently closes deferred work as "fixed."
- **`dogfood-verify lint --scenario <file>`** — author-time scenario linting (the companion to policy lint): structural schema gate + `required_step_undeclared` / `duplicate_step_id` checks + an advisory filename↔`scenario_id` match, with the same honest static-coverage note.
- **Required-steps enforcement, wired end-to-end.** For `github` submissions the receiver fetches your committed `dogfood/scenarios/<scenario_id>.yaml` at the attested commit (size-capped, schema-validated) and enforces `required_steps` / verdict consistency. **Opt-in by absence:** no committed definition → the submission is still accepted, with a visible `required_steps unenforced` warning. The starter kit ships `scenario.example.yaml`.
- **testing-os dogfoods itself.** A `self-dogfood.yml` workflow submits this repo's own CI verdict through the same public dispatch path consumers use (honest `fail` submissions included), and the README wears its own dogfood badge.
- **Read-model reference** — a new handbook page documenting every served consumer surface: `latest-by-repo.json`, `failing.json`, `stale.json`, `trends.json`, and the shields.io badge endpoints.
- **`swarm revalidate` now re-runs full-coverage classification** when its repair flips an audit wave to `collected`, so a repaired wave settles the findings ledger the same way a clean collect does.

### Fixed

- **Operational faults no longer persist rejected records.** Provider outages during provenance or scenario fetches (including exhausted timeouts) now exit 2 without writing `records/_rejected/` — an outage window can no longer poison a `run_id` against clean resubmission. New operational classes: `scenario-fetch-fault:`, `PROVENANCE_FAULT`, and the `VALIDATOR_FAULT_*` family are thrown, not persisted.
- **Consumer onboarding actually works.** The documented `npx` invocation now uses the explicit `npx --yes --package @dogfood-lab/report dogfood-report` form (the published package ships multiple bins, so the bare form exited 127), and the scenario-fetch wiring no longer rejects consumers who haven't committed scenario definitions.
- **`@dogfood-lab/findings` runs its whole suite.** The hand-enumerated test script silently skipped 16 committed test files (73 tests, including path-traversal and DoS regression pins); bare `node --test` discovery plus a repo-wide orphaned-test floor prevent the class.
- **Evidence preservation in `ingest.yml`.** Every pipeline fault now defers past the record-commit step — a badge-generation crash or unparseable result can no longer discard a consumer's already-persisted submission with the runner.
- **Swarm control-plane trust gates hardened**: the serial-verify gate is non-overridable and wave-scoped; `advance --override` is consent to one named overridable gate (never a master key) with a complete `gates_checked` audit trail; the independent ownership probe sees committed edits (diff against the dispatch base) and attributes by glob specificity; terminal cleanup skips dirty/unmerged worktrees instead of destroying work.
- **Portfolio freshness reads the schema-nested policy thresholds** — per-repo `freshness.max_age_days` now actually applies, so staleness is honestly reported (13 stale repos surfaced the day of the fix); trends + badge endpoints are seeded and committed.
- Scores of smaller fixes across error messages, `--help` surfaces, recovery-verb guidance, handbook accuracy, and CI workflow hardening — see the swarm records for the full audit trail.

### Changed

- `swarm advance` prints refused overrides with the refusing gate; `swarm status` surfaces ownership-probe degradation; collect summaries report every finding status dynamically.
- The error-code reference, recovery guide, state-machines page, architecture page, and threat model are trued to shipped behavior (scenario-fetch disclosure included).

## [1.8.0] — 2026-06-30

**VERIFY-F3: `policy-lint` — an author-time static check for policy files.** VERIFY-F1 (v1.7.0) validated predicates at policy *load* and at *eval* (against a real submission); an operator editing a policy only learned a rule was malformed when a submission hit it — and for a repo predicate, not until their CI dispatched. `dogfood-verify lint <policy-file>` closes that loop: load the YAML, run the structural gate + the data-independent predicate checks over every `when`, batch-report every fault — no submission needed. It is the `opa check` analogue this engine's docs already promised. Lockstep minor bump across all seven `@dogfood-lab/*` packages.

### The lint verb

- **`dogfood-verify lint <policy-file> [--json]`** — a new subcommand on the existing bin (the verify path is unchanged). Exit codes mirror the verify path: `0` clean or warnings-only, `1` errors, `2` operator error.
- **Three passes:** (1) the structural schema gate (`validatePayload('policy', …)` — unknown op, malformed/banned field, mixed node, arity, `custom_rules`-under-`defaults`); (2) a static predicate walk for the schema-*inexpressible* semantic faults — an **unknown leading field**, combinator **over-depth**, and a **node-budget** overrun — reusing the engine's own `KNOWN_FIELDS` and depth/node constants so author-time and runtime can never disagree about a limit; (3) the **`[]`-footgun advisory**.
- **Honest coverage boundary (the VERIFY-F2 over-claim lesson).** A `type_mismatch` (a numeric op over a non-number) and a `fanout_budget` overrun are **data-dependent** and cannot be caught statically. The lint says so in its own output — a clean lint means "no static fault and no footgun," not "this policy can never produce a `policy-config:` rejection."

### The `[]`-footgun warning (advisory)

- A negative operator (`not_equals` / `not_in` / `not_contains` / `not_exists`) over a `[]` path fails **open** on an empty/absent array. The lint **warns** (never errors, never auto-applies), names the rule + field, and prints the fail-closed `{ not: { any: [ <positive> ] } }` rewrite as a suggestion the author confirms. It is advisory because legitimate existential-negatives exist (`scenario_results[].verdict not_equals pass`) and because the rewrite changes semantics, not just the empty-case — a human decides intent (deterministic, AST-derived diagnostics; never an LLM paraphrase).
- **Suppression by negation parity.** A leaf inverted an *even* number of times still fails open (flagged); an *odd* number fails closed (suppressed), counting both `not` combinators and the `implies` consequent.

### Cross-family adversarial hardening

The footgun heuristic was pressure-tested by a cross-family Ollama jury (DeepSeek-V4-Pro / GLM-5.2 / MiniMax-M3, refute-by-default, reasoning-stripped), which **improved** it: the jury converged on a real false-negative — `not(not(X))` over `[]` fails open but the original "any `not` ancestor suppresses" rule wrongly silenced it — and a false-positive (a negative-op `implies`-consequent fails closed but was flagged). Both were fixed by switching to negation parity; the jury's two over-reaching suggestions (flag *every* op; make it a hard error) were checked against the engine and rejected. The jury's findings are pinned as regression tests.

### Wiring + docs

- **No 5th workflow.** The lint runs over the live `policies/**` tree via `scripts/lint-policies.test.mjs` (part of `test:scripts`, which runs in both `npm run verify` and CI). `ci.yml` now triggers on `policies/**` so a policy-only edit fires the gate. All 15 shipped policy files lint clean.
- New contract spec [`docs/policy-lint.md`](docs/policy-lint.md); the deferred-companion notes in [`docs/policy-dsl.md`](docs/policy-dsl.md) and the [handbook policy-DSL page](https://dogfood-lab.github.io/testing-os/handbook/policy-dsl/) now point at the shipped verb; `@dogfood-lab/verify` README gains a CLI section.

## [1.7.0] — 2026-06-30

**VERIFY-F1: a declarative, no-eval policy-rule engine.** An operator can now add a verification gate by writing a bounded predicate in YAML — field-selector + operator + value, composed with `all` / `any` / `not` / `implies` — instead of opening a PR into the verifier. The engine is additive and backward-compatible (a rule with no `when` is enforced exactly as before). The one tightening: a set of generous `maxItems` resource caps on submission arrays (see Safety). Lockstep minor bump across all seven `@dogfood-lab/*` packages.

### The declarative engine

- **Author rules in YAML.** `global_rules[]` gains an optional `when` predicate; a repo policy's `surfaces.<surface>` gains `custom_rules[]` (evaluated per scenario_result). Closed operator set: `equals`/`not_equals`, `in`/`not_in`, `contains`/`not_contains`, `exists`/`not_exists`, `gt`/`gte`/`lt`/`lte`. `when` describes the *violation* (the rule fires when it is true); `implies` is sugar for the "X requires Y" shape so authors write positive clauses instead of a double negation. Full reference: [`docs/policy-dsl.md`](docs/policy-dsl.md) and the [handbook policy-DSL page](https://dogfood-lab.github.io/testing-os/handbook/policy-dsl/).
- **The named use cases land:** actor allowlists, field-value constraints, and forbidden scenario/tag combinations — no code change per rule.
- **Forced correctness proof.** Exactly one built-in — `attested-if-human` — is migrated from its hardcoded `switch` arm to a declarative `when` predicate in `global-policy.yaml`, gated by a **differential-equivalence release test**: the old arm (lifted verbatim as an oracle) must produce byte-identical verdicts AND reason strings vs the engine across an adversarial fixture matrix. The arm was removed only because that gate is green. The other seven built-ins stay code-enforced.

### Safety — the whole point of a declarative engine

- **No eval.** No `eval` / `Function` / `vm` / dynamic-require / template-string anywhere in the predicate path; it is a pure tree-walk.
- **Fail-closed and bounded.** A malformed predicate is a classified rejection, never a silent pass or an uncaught throw. Field reads never touch the prototype chain (banned `__proto__` / `constructor` / `prototype` segments + a null-prototype accessor). Work is bounded — combinator depth ≤ 5, `all`/`any` width ≤ 64, a 10k-node per-evaluation budget, and a 500k `[]` fan-out cap — and new `maxItems` on submission arrays (scenario_results ≤ 1000, evidence/tags ≤ 100, step_results ≤ 500, ci_checks ≤ 200) close the synchronous-DoS surface at the contract gate. Every cap is far above any real run.
- **Non-weakening, structurally.** A repo `custom_rule` has no accept/except verb, so it can only ADD a constraint — a repo policy can never weaken a global gate. Combining is deny-overrides.
- **Origin-classified diagnostics.** A malformed *repo* custom-rule predicate is a new `policy-config:` submission-bad rejection (the repo fixes its rule); the same fault in the *global* policy is operational (`VALIDATOR_FAULT_POLICY` — the studio fixes its config).

### Cross-family adversarial hardening

A composed re-audit (5 attack lenses) plus a cross-family cloud jury (DeepSeek / Z.ai / MiniMax, refute-by-default) found and fixed three issues before release: a `[]`-path negative-operator fail-open (documented existential semantics + the fail-closed `not(any(...))` idiom + regression tests), a width/fan-out DoS (the node + frontier budgets + schema caps above), and a global-`defaults` custom-rule origin misclassification (`custom_rules` are now schema-forbidden under `defaults`). Prototype-pollution and field-path exfiltration held.

Architecture grounded in (Phase 0 study-swarm, retrieval-verified citations):
- Kubernetes CEL / KEP-3488 + cel-go — in-process, cost-bounded, non-Turing-complete evaluation
- JSON Logic, AWS IAM condition operators, Kyverno — a bounded matcher beats an expression language for the named cases
- OPA Gatekeeper violation-only + XACML 3.0 deny-overrides — structural non-weakening
- Baron et al. EASE 2024 + ICER 2025 — the `implies` ergonomics over double negation
- Saltzer & Schroeder 1975 (fail-safe defaults); Santos & Becker 2024 (deterministic, not LLM-paraphrased, diagnostics)

This entry is the user-facing summary; full per-phase detail lives in the swarm record.

## [1.6.0] — 2026-06-29

**A full dogfood-swarm pass: a four-stage health pass, then an honesty + capability feature pass.** testing-os ran its own 10-phase swarm protocol on itself again — 7 domain auditors per wave, an adversarial Opus jury, and a cross-family cloud jury (DeepSeek / GLM / Kimi) cross-validating every HIGH; every fix test-first. Lockstep minor bump across all seven `@dogfood-lab/*` packages. No breaking changes — new schema fields are optional and new verbs/flags are opt-in.

### Health pass (A→B→C→D, 41 findings, 0 critical / 0 high at close)

- **Bug / security (Stage A).** The review engine's `performAction` / `performMerge` now schema-validate a finding **before** the on-disk write — an operator edit with a typo'd enum or unknown field can no longer silently corrupt the canonical store (every sibling writer already gated; these two were the gap). Operational provenance faults (provider 429 / 5xx / 401 / 403) now emit a distinct `provenance-fault:` reason classified **operational** — an outage pages ops instead of bouncing a clean submission back to the submitter as "fix your payload" (the v1.5.0 adapter fix is now honored end-to-end by the classifier).
- **Proactive + humanization (Stages B/C, 22 findings).** `performMerge` pre-validates every source before writing the canonical (no torn lineage on a schema-invalid source); `findings derive` names torn/unreadable records instead of silently under-deriving with a green exit; `--verify-chain` gains orphan reconciliation (`--reconcile`) + report-all-breaks (`--all`); the anchor post path surfaces a distinct WARNING with the on-chain tx hash when a mainnet anchor lands but the local receipt write fails (no double-post); provenance adapters retry transient 429/5xx with backoff; a wrong-shape committed index degrades to a structured error instead of a raw `TypeError`. Plus a shared `correlation-id` leaf helper, a migration-version invariant, a `swarm doctor` git-availability check, and a `collect` lifecycle log pair.
- **Output polish (Stage D).** `swarm verify-*` `--format=json` no longer leaks a human "Delta written to:" footer (the JSON now pipes cleanly to `jq`); `findings validate` is verdict-first; `verify --explain` uppercases the verdict word to match the house banner style. `getOutputDir` now tracks the active control plane (`SWARM_DB`) instead of the build dir — a relocated control plane (or a test) no longer writes deltas into the canonical `swarms/` tree.

### Feature pass (honesty fixes + new capabilities)

- **Honesty fixes (false shipped-doc claims, now real).** The README's "forbidden tags" policy gate is **implemented** — scenario tags are threaded into the submission + record schema (optional) and `forbidden_tags` / `required_tags` policy rules now actually reject. The shields.io status badges + `trends.json` are **served** — `ingest.yml` regenerates and commits `indexes/badges/` + `indexes/trends.json` after each accepted submission, so the documented raw-URL endpoints are live (they used to 404); a fleet-wide `_aggregate.json` rollup pill was added.
- **`swarm clean <run-id>`** — a dry-run-by-default recovery verb to list and reclaim stranded `--isolate` worktrees + branches for a run (the 24th `swarm` verb), closing the lifecycle for runs that don't promote to `complete`.
- **`dogfood-report --status --repo <org/repo>`** — consumer-side confirmation that a dispatched submission was recorded / accepted / fresh, read from the public served index (no auth); exits non-zero on rejected/absent so a consumer CI fails loud instead of going green on a silent non-record. Wired into the scaffolded `dogfood.yml`. **`dogfood-init --check`** adds an onboarding preflight doctor (token / scenario file / slug / workflow trigger / policy).
- **Accepted-with-warning channel.** `severity: warn` / `severity: info` policy rules now surface on `verification.warnings` instead of being silently dropped.
- **Operator ergonomics.** `swarm dispatch --dry-run` previews a wave's shape with zero side effects; `--format=json` lands on `swarm advance --check-only` / `receipt` / `history`; `findings list/show/history/queue` + synthesis list/show gain `--json`; `findings list --grep` adds free-text search over title/summary/doctrine.

Deferred (logged backlog): a declarative custom-policy-rule engine (VERIFY-F1) and the remaining medium/low ergonomics. This entry is the user-facing summary; full per-wave detail lives in the swarm record.

## [1.5.0] — 2026-06-21

**A full dogfood-swarm pass: health hardening, record integrity, and consumer onboarding.** testing-os ran its own 10-phase swarm protocol on itself again — every finding cross-validated by a five-vendor cloud jury (Qwen / DeepSeek / Moonshot / Z.ai / OpenAI-OSS), every fix test-first. Lockstep minor bump across all seven `@dogfood-lab/*` packages. No breaking changes — new fields are optional and new providers/commands are opt-in.

### New capabilities

- **Record integrity (tamper-evident).** Every persisted record now carries an `integrity` block (`submission_digest` + `prev_digest`) forming an append-only hash chain; `dogfood ingest --verify-chain` validates it fully offline. An **optional, off-by-default XRPL anchor** (`dogfood ingest --anchor-compute|--anchor-post|--anchor-verify`) witnesses the chain head to the public XRP Ledger, making truncation or rewrite below an anchored point detectable. See the README threat model for the honest ceiling (tamper-evident, not tamper-proof) and why the existing GitHub OIDC run-binding — not a per-submission signature — is the attestation.
- **GitLab CI provenance (opt-in).** A submission may declare `source.provider: gitlab`; the verifier confirms the GitLab pipeline/job via the GitLab API and binds the commit, mirroring the GitHub anti-forgery guard. GitHub remains the default and only-by-default network surface.
- **Consumer onboarding.** A copy-paste [`examples/` starter kit](examples/) (a `dogfood.yml` workflow with a loud `DOGFOOD_TOKEN` preflight, a scenario template, and a starter policy) plus a `dogfood-init` scaffolder on `@dogfood-lab/report`. `@dogfood-lab/report` and `@dogfood-lab/verify` now ship working bins (`dogfood-report`, plus `verify --explain` to dry-run a submission and classify each rejection as submission-bad vs operational).
- **Consumable intelligence + read API.** `findings advise --json` emits the advice bundle as machine-readable JSON; the portfolio's per-surface trends and shields.io badges are now served as committed read-API artifacts (`indexes/trends.json`, `indexes/badges/`); `@dogfood-lab/schemas` exports per-payload TypeScript interfaces (Submission, ScenarioResult, Record, Finding).

### Health pass

- **Security / correctness.** A verified record can no longer attest to a commit its CI run never executed — `submission.ref.commit_sha` is now bound mandatorily to the confirmed run head. Operational provenance faults (expired token, rate limit, 5xx) are distinguished from a genuinely-absent run, so an outage no longer bounces to submitters as "fix your payload". A write-side path-traversal guard now matches the read side. A transiently-unreadable `records/` root no longer overwrites the read-side indexes with empty content.
- **Concurrency.** The review event log moved from a shared daily YAML array (read-modify-rewrite under a file lock) to one immutable file per event — no shared mutable file, so concurrent appends cannot lose an event. (A 50-fork detector proved no lock *file* is reliably exclusive on NTFS under saturation; the sharded-file design removes the dependence on it entirely.)
- **Observability + honesty.** `swarm collect` surfaces and persists the non-isolated ownership-probe degradation; lookup paths now name torn/unreadable files instead of a bare not-found; the doc-drift gate now counts the real command map; the release workflow fails loud on an empty CHANGELOG section; the Dependabot lockfile-drift gate no longer false-fails dependency PRs. Three package READMEs were rewritten to match their shipped APIs.

This entry is the user-facing summary; full per-wave detail lives in the swarm record.

## [1.4.0] — 2026-06-13

**Dogfood swarm: a full health pass + a four-wave feature pass.** testing-os ran its own 10-phase dogfood-swarm protocol on itself — a health pass (bug/security → proactive → humanization → visual) that closed ~55 verified findings at 0 critical / 0 high, then a feature pass that closed the intelligence layer's learning loop and added migration, trend, and ergonomics capabilities. Lockstep minor bump across all seven `@dogfood-lab/*` packages. No breaking changes.

### New capabilities (feature pass)

- **The intelligence loop closes.** Derived patterns, recommendations, and doctrine can now be *promoted* to the advice surface: `findings <patterns|recommendations|doctrine> accept|reject|invalidate <id>` (+ `queue`) reviews a synthesis artifact, and the `advise` query surface now returns what you accept (previously nothing the layer derived could reach it). Re-derivation preserves an operator-set status instead of clobbering it. `findings recommendations apply <id> --dry-run|--write` applies an accepted recommendation's structured action back into a repo policy (honest refusal for free-text-only intent).
- **Schema-version safety.** Submissions declaring an incompatible contract `schema_version` are refused with typed `CONTRACT_SCHEMA_TOO_NEW` / `CONTRACT_SCHEMA_TOO_OLD` reasons (`SUPPORTED_SCHEMA_VERSIONS` is the single source). The control-plane schema-too-new refusal is the typed `CONTROL_PLANE_SCHEMA_TOO_NEW`, and the flat migration list is now an ordered, ledger-backed migration runner with a retroactive bootstrap for existing DBs.
- **Trends + visibility.** `swarm trends --query recurring|history|recurrence` is a cross-run lens over the control-plane corpus. The portfolio now computes a per-repo+surface trend/regression surface over the full records history, emits a shields.io status badge per repo+surface, and `swarm status` / `swarm runs` accept `--format=json`.
- **Operator ergonomics.** `swarm collect --all` auto-discovers a dispatched wave's agent outputs (no more one `--domain=` per agent); `swarm doctor` runs a read-only preflight (node version, hardlink-capable control-plane dir, schema version). The contract enums (`PRODUCT_SURFACES` / `EXECUTION_MODES` / `EVIDENCE_KINDS`) and a `parseRejectionReason` taxonomy parser are now importable from `@dogfood-lab/schemas` / `@dogfood-lab/verify`.

### Health pass

- **Stage A (bug/security).** A contract-valid `partial` step status is no longer falsely rejected by the central validator; the swarm's release-gate severity rollup is fixed (it compared lowercase against the canonical UPPERCASE, reporting "healthy" over open criticals); `swarm dispatch` validates the phase before mutating the control plane (a typo no longer commits a corrupt, un-resumable wave); persisted record/index paths are posixified (portable across OSes); and `npm run verify` is now idempotent on the working tree (a test no longer leaks into the real records tree).
- **Stages B/C/D (proactive · humanization · visual).** Per-agent worktrees are cleaned up after a run; unguarded IO is handled with operator-legible errors; the cross-contract enum drift seal became single-source enforcement; CI treats a rejected submission as a designed outcome rather than a job failure; handbook + docs accuracy throughout.

This entry is the user-facing summary; full per-wave detail lives in the swarm record.

## [1.3.2] — 2026-06-02

**`@dogfood-lab/dogfood-swarm` self-audit health pass.** The swarm runner audited itself with its own 10-phase protocol. Stage A (bug/security) landed 28 fixes; Stage C (hardening / operator-UX) followed with exit-code-contract and documentation closure; two deferred follow-ups then landed — fp-p-005 made the finding fingerprint a pure, injective function of the finding's own stable content (an edit-stable context-snippet hash), and fp-p-006 consolidated the agent-output schema into `@dogfood-lab/schemas`. The only package-shape change is one new internal workspace dependency (`@dogfood-lab/dogfood-swarm` → `@dogfood-lab/schemas`, see below); no breaking changes (fp-p-005's behavior change is backward-compatible — see below). Findings recorded under the run in [`swarms/swarm-1780390764-7dab/`](swarms/swarm-1780390764-7dab/).

### Security & correctness (Stage A)

- **Verify engine — honest verdicts** ([`packages/dogfood-swarm/lib/verify/runner.js`](packages/dogfood-swarm/lib/verify/runner.js), [`packages/dogfood-swarm/lib/verify/adapters/node.js`](packages/dogfood-swarm/lib/verify/adapters/node.js)). The wave gate no longer reports a clean `pass` for non-evidence. `no_tests` (ve-004) distinguishes "the repo has no `test` script and `npm test --if-present` ran nothing" from a real pass; `tool_missing` (ve-p-001) distinguishes "a required build tool is absent from `PATH`" from a code failure; `skip` (ve-005) stops an empty required-step set from being a vacuous `pass`. A typo'd `--threshold` now fails loud (`CLI_INVALID_THRESHOLD`, ve-002) instead of silently disabling the CI gate via a `NaN` comparison. Step output is bounded and per-step timeouts are tagged `timed_out` rather than misread as fast failures.
- **Finding-id & agent-output integrity** (ve-001 verify-classifier, fp-001 agent-output schema validation as the two criticals; fp-002 within-wave fingerprint collisions, fp-003 non-ASCII git paths, fp-004 TOCTOU byte-gate, sm-001/002 domain handling, cli-001 rewind among the highs). Agent outputs are schema-validated at collect time with a structured `AgentOutputValidationError`; fingerprints stay collision-resistant within a wave and across non-ASCII paths.

### Hardening & operator UX (Stage C)

- **Exit-code contract closed on the CI-gate verbs** ([`packages/dogfood-swarm/cli.js`](packages/dogfood-swarm/cli.js)). `swarm verify` now exits non-zero on a `fail` verdict, and `swarm persist --ingest` exits non-zero when the dogfood ingest fails — aligning both with the 3-way (`0`/`1`/`2`) contract the `verify-*` and `findings` verbs already honored, so a non-interactive CI step can no longer go green on a hard failure.
- **Operator documentation** ([`packages/dogfood-swarm/README.md`](packages/dogfood-swarm/README.md)). The package README now documents the exit-code contract for every gate-capable verb, the five verify verdicts (`pass`/`fail`/`skip`/`no_tests`/`tool_missing`), the three scriptable environment variables (`SWARM_DB`, `DOGFOOD_FINDINGS_FORMAT`, `DOGFOOD_LOG_HUMAN`) with the NDJSON-on-stderr diagnostic channel, and a symptom→recovery-verb troubleshooting table that deep-links the handbook recovery and error-codes pages.
- **README→CLI contract test hardened** ([`packages/dogfood-swarm/meta-amendA-readme-contract.test.js`](packages/dogfood-swarm/meta-amendA-readme-contract.test.js)). The td-006 guard now also pins the operator-facing env-var vocabulary: it reads the real `process.env.*` literals from source and asserts each documented var appears in the README, closing the drift class (undocumented env vars) that the command-only check left open.

### Schema consolidation (fp-p-006)

- **One source of truth for the agent-output schema** ([`packages/schemas/src/json/agent-output.schema.json`](packages/schemas/src/json/agent-output.schema.json), [`packages/dogfood-swarm/lib/validate-agent-output.js`](packages/dogfood-swarm/lib/validate-agent-output.js), [`packages/dogfood-swarm/lib/templates.js`](packages/dogfood-swarm/lib/templates.js)). The fp-001 packaging fix had shipped a package-local copy at `packages/dogfood-swarm/schema/` guarded by a byte-equality drift test, because the repo-root `scripts/agent-output.schema.json` was absent from the published tarball. fp-p-006 (deferred from the same self-audit) removes the controlled duplication: the schema now lives in `@dogfood-lab/schemas`, and both the collect-time validator and the dispatch prompt-builder resolve it via `createRequire('@dogfood-lab/schemas/json/agent-output.schema.json')` — the same `./json/*` subpath pattern the eight contract schemas already use. `@dogfood-lab/dogfood-swarm` gains `@dogfood-lab/schemas` as a dependency; the package-local copy, the repo-root copy, and the `meta-amendA-schema-packaging.test.js` drift guard are deleted. The schema's `$id` moves to the canonical `packages/schemas/src/json/` path — a contract field, hence the lockstep bump. The schema ships as a raw JSON subpath (not registered in `validatePayload`): it stays a swarm output envelope compiled with a local Ajv, allowlisted in the single-canonical-validator gate ([`scripts/check-validator-cache-singleton.test.mjs`](scripts/check-validator-cache-singleton.test.mjs)).

### Fingerprint stability (fp-p-005)

- **Edit-stable context-snippet hash → injective base fingerprints** ([`packages/dogfood-swarm/lib/fingerprint.js`](packages/dogfood-swarm/lib/fingerprint.js), [`packages/dogfood-swarm/commands/collect.js`](packages/dogfood-swarm/commands/collect.js)). The base fingerprint was `sha256(category | rule_id | path | symbol | 10-line-bucket)`. Two genuinely-distinct symbol-less findings in the same file and bucket collided on the base fp; fp-002's `disambiguateFingerprints` salted the collision apart, correctly but with bounded residual new/recurring churn when a collision group grew or shrank across waves. fp-p-005 (deferred from the same self-audit) folds in an **edit-stable context-snippet hash** — the surrounding ~7 source lines around the finding, whitespace-collapsed and line-ending-normalized — as the LOCATION component when the source file is readable at collect time. This is the CodeQL `primaryLocationLineHash` design (hash the surrounding *content*, not the line number): it survives reflow, re-indentation, and code inserted elsewhere that shifts the finding's line number, while giving two findings at different points in one file *different* base fingerprints. The base fp is now a pure, injective function of the finding's own stable content, so `disambiguateFingerprints` is demoted from the primary collision mechanism to a **safety net** that fires only on the no-source fallback path and the rare case of two findings with byte-identical surrounding source. `computeFingerprint(finding, { sourceText })` reads no filesystem itself — `collect.js` reads each finding's file once (cached, size-guarded at 2 MB, path-contained to the worktree) and threads the text in. Coverity's enclosing-function key is the same idea at function granularity; the existing `symbol` component already carries the enclosing function name when the auditor reports one.
- **Backward-compatible by construction.** When no source is available (synthetic finding, deleted/unresolvable file, file-level finding with no line, or a path that escapes the worktree), LOCATION degrades to the historical 10-line bucket and the fingerprint is **byte-for-byte** what it was before — so the B-BACK-002 description-stability contract and the existing cross-wave dedup of source-less findings are untouched. The optional second argument means every existing `computeFingerprint(finding)` call site is unaffected.
- **Semantics note (one-time re-fingerprint).** Because the LOCATION encoding changes when source is present, a finding carried in a pre-upgrade `control-plane.db` will get a *new* (context-folded) fingerprint the first time it is re-audited with source available — a one-time `new` + `fixed`/`unverified` churn on that first post-upgrade wave, after which it is stable. The live `control-plane.db` on this rig holds zero findings, so there is no migration impact here; long-lived stores elsewhere will see the one-time churn once and then settle.
- **Tests** ([`packages/dogfood-swarm/meta-amendA-findings-persist.test.js`](packages/dogfood-swarm/meta-amendA-findings-persist.test.js), [`packages/dogfood-swarm/d3b-006-finding-id-collision.test.js`](packages/dogfood-swarm/d3b-006-finding-id-collision.test.js)). New coverage locks: `extractContextSnippet` null/edge cases + reflow/CRLF/indentation invariance; `computeFingerprint` injectivity for distinct same-bucket locations, B-BACK-002 stability via source (not prose), reflow survival, and byte-identical no-source fallback; the fp-002 cross-wave scenario re-run **in both input orders** with source, proving no collision group forms (A keeps its `finding_id` as `recurring`, B inserts as `new`, identically regardless of order) and nothing is salted; a real-worktree `collect()` integration test proving two same-bucket findings persist as two distinct rows whose fingerprints are the context-hash fps (not the shared no-source bucket fp); and the D3B-006 content-addressed `finding_id` derivation composed with a context-folded fingerprint. The fp-002/fp-r-001/fp-p-001 occurrence-salting tests stay green — they now exercise the no-source safety-net path.

## [1.3.1] — 2026-06-01

**Targeted hardening fast-follow on v1.3.0.** Two deferred items from the v1.3.0 swarm, both shipped under Protocol-v2-lite (test-first per item, advisor-verified, non-vacuity META test for the new gate). No breaking changes from v1.3.0. No package shape changes. Lockstep patch bump.

### Data integrity

- **D3B-006 — content-addressed `finding_id` + `UNIQUE(run_id, finding_id)` index** ([`packages/dogfood-swarm/lib/fingerprint.js`](packages/dogfood-swarm/lib/fingerprint.js), [`packages/dogfood-swarm/db/schema.js`](packages/dogfood-swarm/db/schema.js), [`packages/dogfood-swarm/d3b-006-finding-id-collision.test.js`](packages/dogfood-swarm/d3b-006-finding-id-collision.test.js)). The prior mint scheme (`F-${Date.now().slice(-6)}-${counter}` with a per-call counter reset) could produce identical finding_ids for distinct findings when two `swarm collect` invocations fired within the same wall-clock millisecond — and the schema had no UNIQUE constraint on `finding_id`, so the duplicate row inserted silently and `swarm approve --ids` keyed on an ambiguous handle. Fix: `finding_id = F-${fingerprint.slice(0, 8)}` (content-addressed, deterministic across invocations; the 24-hex SHA-256 fingerprint was already collision-resistant), plus `CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_run_finding_id ON findings(run_id, finding_id)` on both fresh-DB (`SCHEMA_SQL`) and existing-DB (`MIGRATIONS_SQL`) paths. `SCHEMA_VERSION` bumped 5 → 6. Live `control-plane.db` audited pre-flight (zero findings) — UNIQUE ships additively without requiring D3B-005's general migration runner. The fingerprint-prefix birthday-collision residual (~1.16e-4 at 1000 findings/run) fails LOUD via the UNIQUE index rather than silent double-insert. Six subtests cover content-addressed shape, fingerprint-deterministic id, sub-second collision (Date.now pinned), UNIQUE rejection, fresh-DB index materialization, and migration idempotency.

### Documentation gates

- **R9 — `source-of-truth-cross-ref` doc-drift check** ([`scripts/check-doc-drift.mjs`](scripts/check-doc-drift.mjs), [`scripts/doc-drift-patterns.json`](scripts/doc-drift-patterns.json), [`scripts/check-doc-drift.test.mjs`](scripts/check-doc-drift.test.mjs)). New check kind cross-references current-state claims on honesty surfaces (SHIP_GATE / SCORECARD / CLAUDE / README) against authoritative resolvers (`package.json` field, publishability declaration, regex-pattern count on `cli.js`). Closes the drift class that bit the v1.3.0 release: the bump correctly stamped the gated surfaces (`package.json` ×8, `sync-version`, README version block) but left stale `v1.2.3` text on the ungated honesty surfaces, shipping a release whose own SHIP_GATE "version matches tag" row was false. Per the v1.3.0 lesson #5, hand-maintained current-state claims recur as drift at every bump until a gate cross-checks them — this IS that gate. 11 claims at ship-time, each anchored to an explicit per-surface current-state pattern (NOT free-floating version-string classification) so historical references like "release v1.2.3 cut 2026-05-20" and "since v1.2.0" are left alone. The companion META test mutates every LIVE claim's captured value to a stale stand-in (versions: `0.0.0` ↔ `9.9.9`; integers: `0` ↔ `999`) and asserts the gate fires drift naming the surface — without this meta-loop, R9 would itself become a vacuous gate (v1.3.0 lesson #3, bit twice at the FIX layer). Three resolver kinds shipped: `package-json-field` (dotted path), `package-json-publishable` (`!private && publishConfig.access === 'public'`), `pattern-count` (regex over source file with 100k-match runaway guard). Vacuity is reported as `config-error` severity (NOT silent pass), so silent-truncation-by-rename cannot land a green-but-protects-nothing gate. Explicitly excluded from R9: wall-clock date arithmetic (time-bomb — goes red on every calendar day with zero code/doc change) and absolute test-count resolvers (R6 dropped that claim from the README at v1.3.0 — reintroducing it would re-introduce the unit-mismatch risk).

### Verification

`npm run verify` green on Node 22 + 24 in CI; 1344+ tests across 7 workspace packages + repo scripts; 14/14 doc-drift checks pass; R9 LIVE META asserts every configured claim is non-vacuous (fires drift on mutation). The R9 gate is itself adversarially-verified by the META test it ships alongside.

## [1.3.0] — 2026-06-01

**Health-pass + structural-seal release.** A full A→B→C→D dogfood swarm closed the original Stage-A C1 critical (two distinct Ajv instances of the same schema — swarm emitter vs production gate — meant testing-os could not record its own dogfood evidence). The H3 follow-on collapsed the four sibling Ajv compile sites to one canonical `validatePayload` per process, then sealed the seam with a process-global module-instance detector so a workspace-hoist split (load `@dogfood-lab/schemas` twice → two `validatorCache` Maps → C1 relocated to the cache layer instead of sealed) is now a hard gate. Phase 10 Step 1 added four verified hardening items before the release commit. No package shape changes, no breaking changes from v1.2.3. Lockstep minor bump (the structural seal + humanization + handbook polish + validator consolidation are substantial new internal behaviour without a contract break).

### Validation (H3 + Phase 10 Step 1)

- **H3 — canonical-validator consolidation** ([`packages/schemas/src/validate.ts`](packages/schemas/src/validate.ts), [`packages/findings/synthesis/validate-artifacts.js`](packages/findings/synthesis/validate-artifacts.js), [`packages/findings/validate.js`](packages/findings/validate.js), [`packages/verify/validators/schema.js`](packages/verify/validators/schema.js), [`packages/ingest/validate-record.js`](packages/ingest/validate-record.js)). The four sibling Ajv compile sites now delegate to the canonical `validatePayload` from `@dogfood-lab/schemas`. `ValidationError` extended with `keyword` so ingest's `RecordValidationError.errors[].keyword` pin (`packages/ingest/ingest.test.js:208-220`) is preservable across the boundary. Schema README signature corrected (`validatePayload(name, payload)`, `result.valid`).
- **D2B-015 — single-cache invariant test** ([`scripts/check-validator-cache-singleton.test.mjs`](scripts/check-validator-cache-singleton.test.mjs)). The structural C1 seal. Three layers: STATIC (`grep new Ajv` across `packages/` — only canonical + allowlisted survive), DYNAMIC (process-global `Symbol.for('@dogfood-lab/schemas.instances')` counter; `count === 1` after every consumer imported), DETECTOR PROOF (force-load `dist/validate.js` via cachebust URL; assert counter ticks `before+1` — proves the gate is real, not vacuous-by-different-mechanism). The DYNAMIC test's first iteration was caught vacuous by the advisor (cache-read before/after returned the test's own cached validator both times, regardless of split) and rebuilt to the counter pattern.
- **D2B-005 — policy YAML schema-gated at load time** ([`packages/ingest/load-context.js`](packages/ingest/load-context.js), [`packages/ingest/d2b-005-policy-schema-validation.test.js`](packages/ingest/d2b-005-policy-schema-validation.test.js)). `loadGlobalPolicy` throws fail-loud on a schema-invalid global policy (matches the YAML-torn sibling — global is load-once-required). `loadRepoPolicy` reuses the D1B-006 `__torn` sentinel for schema-invalid repo policies; the verifier's existing single-branch handler at `verify/index.js:189` catches both classes (YAML parse fail + schema invalid) with one branch. Closes the "verifier accepts everything for a structurally invalid policy" gap. Regression-pin asserts all 14 shipping policies (1 global + 13 repos) pass the new gate.
- **D3B-014 — export-envelope schema_version single-sourced** ([`packages/dogfood-swarm/lib/persist/export.js`](packages/dogfood-swarm/lib/persist/export.js)). Surfaced and corrected a silent two-version drift: the export envelope hardcoded `provenance.schema_version: 3` while `db/schema.js` had bumped to `SCHEMA_VERSION = 5` with no compile-time signal. `EXPORT_VERSION` constant introduced for the envelope's own version (lives where it's used); `SCHEMA_VERSION` imported from its owner. Test pins both as constants so a future bump can't drift again.

### Security

- **C1 — sealed against the cache-relocation failure mode.** See "Validation" above. The original Stage-A finding (two Ajv instances for the same schema) is now structurally sealed end-to-end: STATIC + DYNAMIC + DETECTOR PROOF + KEYWORD pins, with the seal-test itself adversarially verified for non-vacuity. The advisor's overrule on the first seal-test (cache-read before/after, which would pass whether or not a split existed) is documented in the test file's header so the L2-003 lesson is preserved in source.

### Observability

- **Stage C humanization cluster** (multiple files across `packages/{ingest,verify,dogfood-swarm}/`). Every CLI failure path now routes through a structured error envelope with stable codes (`ISOLATION_FAILED`, `DUPLICATE_RUN_ID`, `COLLECT_UPSERT_FAILED`, `DISPATCH_*`, `STATE_MACHINE_*`, `VALIDATOR_FAULT_*`, `RECORD_SCHEMA_INVALID`, `FINDING_ID_COLLISION`, `PATTERN_/RECOMMENDATION_/DOCTRINE_ID_COLLISION`, `CLI_INVALID_GLOBS_JSON`, `FINDING_/PATTERN_/RECOMMENDATION_/DOCTRINE_SCHEMA_INVALID`) and a `Next:` hint per code. NDJSON `logStage` discipline closes the prior unstructured-stderr gaps in `applyTimeoutPolicy`, `tryTransition`, and several dispatch precondition paths.
- **A2.1 FX2 — error-codes drift gate non-vacuity** ([`scripts/doc-drift-patterns.json`](scripts/doc-drift-patterns.json), [`scripts/check-doc-drift.test.mjs`](scripts/check-doc-drift.test.mjs)). The `error-codes` source-vs-target-coverage check was vacuous for 6 of 19 codes (the `VALIDATOR_FAULT_*` extractor regex matched zero lines because `verify/index.js` pushed a variable; the `DISPATCH_*` family had no extractor at all). Fixed extractors target the mint site (template-literal definition + JSDoc type union) rather than the assignment site, asserted non-vacuous by a META test that strips each enforced code from the handbook and confirms the gate fires.

### Handbook & visual surface (Stage D)

- **D5B-006 — `cli-reference` nav orphan closure** ([`site/src/content/docs/handbook/index.md`](site/src/content/docs/handbook/index.md), [`site/src/content/docs/handbook/operating-guide.md`](site/src/content/docs/handbook/operating-guide.md), [`site/src/content/docs/handbook/swarm-history.md`](site/src/content/docs/handbook/swarm-history.md)). Added to the curated Getting-Started list; cross-linked from operating-guide and swarm-history. Total inbound links 0 → 2.
- **State-machine count reconciliation** ([`site/src/content/docs/handbook/state-machines.md`](site/src/content/docs/handbook/state-machines.md), 4 sibling pages). Derived truth from source first: **3 formal transition-based state machines** (`wave-state-machine.js`, `state-machine.js`, `findings/review/transitions.js`), **4 status vocabularies operators encounter** (per the handbook's 4 sections). Different numbers, kept distinct. Frontmatter "three vocabularies" → "four vocabularies"; body parenthetical names the 3-vs-4 distinction; beginners.md scope-narrows to "three of the four"; intelligence-layer and index.md updated in lockstep.
- **Light-mode diagram parity** ([`site/public/diagrams/architecture.svg`](site/public/diagrams/architecture.svg), [`site/public/screenshots/verify-output.svg`](site/public/screenshots/verify-output.svg)). Both SVG backplates flipped to `fill: transparent` so light-theme handbook pages no longer render the diagrams as full-width dark slabs. `verify-output.svg` version literal stamped to `@1.3.0` (was `@1.1.1`, with an `@1.2.3` waypoint during Stage D that the release-time doc-drift regression-pin caught and lockstep-bumped to the final value); per-test-file counts replaced with version-stable narration to remove the per-release lockstep burden.
- **D4B-015 — pa11y CI retry + coverage expansion** ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). 3-attempt retry with `10s/20s` backoff; coverage extended from 1 page (`error-codes`) to 4 (`error-codes`, `architecture`, `state-machines`, `cli-reference`). Each attempt emits `::warning::` annotations naming the target and attempt; final `::error::` only when all 3 fail.
- **F-FA-001 — receiver push-retry backoff** ([`.github/workflows/ingest.yml`](.github/workflows/ingest.yml)). Mirrors the pa11y pattern: 3 attempts with backoff, per-attempt `::warning::` annotations naming the run-id, `::notice::` on the recovering attempt. The receiver is the highest-traffic CI surface; closing the asymmetry with the pa11y leg keeps operator signals consistent across both flake-recovery paths.

### Internal

- **H3 dead-dep cleanup** ([`packages/ingest/package.json`](packages/ingest/package.json), [`packages/findings/package.json`](packages/findings/package.json), [`packages/verify/package.json`](packages/verify/package.json), [`scripts/check-package-deps-hygiene.test.mjs`](scripts/check-package-deps-hygiene.test.mjs)). Unused `ajv` + `ajv-formats` direct deps removed from the three packages that migrated to `@dogfood-lab/schemas`. The canonical home (`@dogfood-lab/schemas`) retains both as direct deps. Regression-pin asserts the migrated consumers stay clean; counter-test pins the canonical home as the legitimate owner.
- **`@dogfood-lab/schemas` exposes `_schemasModuleInstanceCount`** ([`packages/schemas/src/validate.ts`](packages/schemas/src/validate.ts), [`packages/schemas/src/index.ts`](packages/schemas/src/index.ts)). Test-only export reading the process-global counter. Production code has no reason to call it.
- **`@dogfood-lab/ingest` subpath export `./validate-record.js`** ([`packages/ingest/package.json`](packages/ingest/package.json)). Added so the cross-consumer D2B-015 dynamic test can import the migrated `validateRecord` from outside the ingest package.

### Documentation

- **R6 — drop the brittle absolute test-count** ([`README.md`](README.md)). The Status block's hand-maintained `N tests` claim had drifted to `1204` against an actual `1281`. Replaced with a stable, non-drifting indicator (CI badge + descriptive). Per-package test counts now read from `npm run verify` locally / the CI badge above — no more hand-maintained number that decays every release.
- **CHANGELOG.md** — this entry.

### Verification

`npm run verify` green on Node 22 + 24 in CI; shipcheck audit: 21 checked / 16 SKIP-with-justification / 0 unchecked / **100% pass on hard gates A–D**. Adversarially-verified seals: STATIC + DYNAMIC + DETECTOR PROOF + KEYWORD × 2 across the validator-consolidation seam; META + count-coherence + nav-orphan + verify-output-version regression-pins on the doc-drift gates.

## [1.2.3] — 2026-05-20

**Health-pass cleanup release.** Four-stage dogfood swarm (Stage A bug/security → Stage B proactive → Stage C humanization → Stage D visual polish) against v1.2.2 surfaced 50+ findings; this release lands the load-bearing fixes. No package shape changes, no breaking changes from 1.2.2. **1204 tests (7 workspace packages + repo scripts).**

### Security

- **BR-001 — `execFileSync` argv form in verify runner** ([`packages/dogfood-swarm/lib/verify/runner.js`](packages/dogfood-swarm/lib/verify/runner.js)). Mirrors the v1.2.0 `F-W1-BACK-003` doctrine: replace shell-string `execSync` with `execFileSync(cmd, args[])` so a future adapter author who lands a user-influenced `step.args` cannot re-introduce shell-metacharacter interpretation in the argument vector. Current adapters all pass hardcoded safe args — this is defense-in-depth.
- **BR-B-001 — bounded JSON.parse on agent output** ([`packages/dogfood-swarm/commands/collect.js`](packages/dogfood-swarm/commands/collect.js)). `swarm collect` now checks output file size via `statSync` before reading; rejects oversized outputs (>50 MB) with an operator-actionable error naming the size, the limit, the likely cause (logging loop / raw stdout), and the remediation. Prevents memory exhaustion of the coordinator on malicious or runaway agent output. Bundled fix: `agent_runs.error_message` and `report.validation_errors[*].error` are truncated to 512 chars before persistence (BR-B-004).
- **CI-B-002 — defensive guard against null `repository_dispatch` payload** ([`.github/workflows/ingest.yml`](.github/workflows/ingest.yml)). Receiver workflow now emits a `::error::` annotation and exits 1 when `client_payload.submission` is missing/null, before invoking the ingest script. Previously the downstream verify pipeline rejected null gracefully but produced no GitHub error annotation, so an operator debugging a misconfigured consumer dispatcher would see a green workflow with a silent rejection record.

### Observability

- **BE-B-001 — actionable error messages from `loadGlobalPolicy`** ([`packages/ingest/load-context.js`](packages/ingest/load-context.js)). Missing/malformed `policies/global-policy.yaml` now throws a structured Error naming the resolved path, the failure mode (ENOENT vs YAML parse, with line/column from `yaml.YAMLException`), and the operator action. Closes the asymmetric defensive-posture gap with `loadRepoPolicy` (which already wrapped its read).
- **BE-B-002 — rebuild-indexes failure carries stack and recovery hint** ([`packages/ingest/run.js`](packages/ingest/run.js)). The `rebuild_indexes` catch block now enriches both the structured logStage event and the console warning with `err.stack` (truncated), `record_persisted_at` so the operator knows the record DID land, and a `recovery` hint ("next ingest will trigger a full rebuild of indexes/"). Preserves the F-827321-035 outer `stage='error'` invariant.

### Documentation

- **CI-001+002 — Node version honesty pass** ([`README.md`](README.md)). Node badge corrected from `>=20` to `>=22` to match `package.json` `engines.node`; the "CI matrix runs Node 20 + 22" claim updated to "Node 22 + 24" to match `.github/workflows/ci.yml` matrix.
- **CI-003 — CHANGELOG accuracy** ([`CHANGELOG.md`](CHANGELOG.md)). The v1.2.2 entry's claim that `engines.node` "remains `">=20"` — tightening to `">=22"` is tracked as a follow-up" was wrong: the tightening shipped in v1.2.2 itself. Corrected to "is tightened from `>=20` to `>=22` in this release, matching the CI matrix."
- **CI-B-001 — concurrency claim matches implementation** ([`CLAUDE.md`](CLAUDE.md)). The workflow table row for `ingest.yml` previously claimed "Concurrency-safe per-repo"; in reality the workflow's `concurrency.group` is workflow-global and safety comes from a git-pull-rebase retry loop. CLAUDE.md now honestly describes both.

### Handbook & visual surface

- **FE-B-001 — new CLI reference page** ([`site/src/content/docs/handbook/cli-reference.md`](site/src/content/docs/handbook/cli-reference.md)). Covers 17 previously-undocumented `swarm` verbs (`init`, `domains`, `dispatch`, `collect`, `verify`, `verify-fixed`, `verify-recurring`, `verify-unverified`, `verify-approved`, `receipt`, `advance`, `status`, `resume`, `approve`, `persist`, `findings`, `runs`) with usage synopses sized to fit a 320px-wide phone (handbook's 64-char fence-width discipline).
- **FE-B-002 — custom 404 page** ([`site/src/pages/404.astro`](site/src/pages/404.astro)). Replaces the GitHub Pages default 404 with a handbook-branded page offering three recovery links (handbook home, README on GitHub, search hint via Ctrl-K). Inherits skip-link + brand header from `BaseLayout`.
- **VD-001 — hero badge synced to release** ([`site/src/site-config.ts`](site/src/site-config.ts)). Hero badge and description updated to v1.2.3.
- **VD-002 — social card meta** ([`site/astro.config.mjs`](site/astro.config.mjs)). Added `og:image`, `og:image:alt`, `og:type`, `twitter:card`, `twitter:image` head tags pointing at the deployed logo so links shared in Slack / GitHub / Mastodon preview with the brand mark instead of a bare text fallback.

### Verification

`npm run verify` 1204 tests (7 workspace packages + repo scripts), 0 failures; doc-drift + regression-pin + script tests + workspace tests all green. Shipcheck audit: 21 checked / 17 SKIP-with-justification / 0 unchecked / **100% pass on hard gates A–D**.

## [1.2.2] — 2026-05-14

**Bump `better-sqlite3` runtime dependency from `^11.0.0` to `^12.10.0`** ([#25](https://github.com/dogfood-lab/testing-os/pull/25)). `@dogfood-lab/dogfood-swarm` now bundles SQLite 3.53.1 (was 3.50.x). Native prebuilds added for Node.js v26; prebuilds dropped for Node.js v20 + v23. The repo's CI matrix is Node 22 + 24, so internal verification is unaffected, but consumers running `@dogfood-lab/dogfood-swarm` on Node 20 will now need to build the native binding from source. The repo's `engines.node` field is tightened from `">=20"` to `">=22"` in this release, matching the CI matrix.

**Dev-only:** `vitest` and `@vitest/coverage-v8` bumped from `3.2.4` to `4.1.6` ([#21](https://github.com/dogfood-lab/testing-os/pull/21), [#24](https://github.com/dogfood-lab/testing-os/pull/24)). Test runtime only; no published-package impact.

**Verification:** `npm run verify` reported 1105/1105/0 (byte-identical to v1.2.1) at time of release; on re-baseline at HEAD it now reports 1204 tests (7 workspace packages + repo scripts) — net +99 tests added in v1.2.3's swarm-A1 corrective wave. Targeted transaction-semantics tests (`wave-state-machine.test.js`, `revalidate.test.js`, `rewind.test.js`, `redrive.test.js`) pass 118/118; SQLite native binding loads and reports `sqlite_version() = 3.53.1` on Node 22.21.1.

## [1.2.1] — 2026-05-14

**Add testing-os logo to every per-package README.** The v1.2.0 publish shipped `@dogfood-lab/schemas`, `@dogfood-lab/verify`, and `@dogfood-lab/report` to npm before the logo got added to their READMEs — those three v1.2.0 packages render on their npm pages without the logo. v1.2.1 lockstep bump prepends the canonical logo (via `raw.githubusercontent.com` absolute URL so it renders cross-context) to all 7 per-package READMEs and re-publishes all 6 publishing packages. No code changes; this is a documentation-only patch release.

## [1.2.0] — 2026-05-14

**First npm publish of the `@dogfood-lab/*` monorepo.** Six packages now public on npm: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Headline install: `npm install -g @dogfood-lab/dogfood-swarm`. The seventh package (`@dogfood-lab/portfolio`) remains internal.

**New in this release:** wave-level state machine (Phase 5A) + Three R's recovery contract (Phase 5B-1 `swarm rewind`, 5B-2 `swarm redrive`, plus the existing `swarm revalidate` from earlier in this version cycle) + `swarm history` audit-trail verb (Phase 5B-0). Stage A–D health pass closed at 0 CRIT / 0 HIGH against the pre-Phase-5 baseline. **1204 tests (7 workspace packages + repo scripts)** (was 940 at start of session arc; the v1.2.0 release notes originally cited 1105 — corrected at re-baseline in v1.2.3). All packages bump lockstep from 1.1.7 → 1.2.0.

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
