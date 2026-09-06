---
title: swarm CLI reference
description: Quick reference for every swarm verb — usage synopsis and one-paragraph description for each command, with cross-links to the deep-dive pages where they exist.
sidebar:
  order: 6.7
---

`swarm` is the control-plane CLI shipped by `@dogfood-lab/dogfood-swarm`. The full source of truth is `packages/dogfood-swarm/cli.js`; this page is a per-verb quick-reference so you can scan every verb without `swarm --help`-ing your way through them. (An earlier revision hardcoded the verb count here; it went stale the first time a verb shipped — the count lives in `swarm --help`, not prose.)

For verbs that already have a dedicated handbook page, this page lists the synopsis and a one-line summary, then links out. Those deep-dive pages are:

- [`swarm revalidate`, `swarm rewind`, `swarm redrive`](../recovery/) — the Three R's recovery contract
- [`swarm history`](../swarm-history/) — deep-audit verb for `wave_state_events`

The verbs below are the **rest of the CLI surface** — the ones you reach for during normal day-to-day swarm operation.

## swarm init

Bootstrap a new run against a repo. Walks the file tree, detects domain candidates from `swarms/domain-map-suggestions.json` (or equivalent), creates an entry in the `runs` table, and writes a save-point tag (`swarm-save-<run-id>`) at the current HEAD so `swarm rewind` has a safe target later.

```text
Usage: swarm init <repo-path> [--repo org/name]
                  [--seed-from-roadmap[=<run-id>|latest]]

Example:
  $ swarm init E:/AI/my-repo
  $ swarm init E:/AI/my-repo --repo dogfood-lab/my-repo
  $ swarm init E:/AI/my-repo --seed-from-roadmap
```

The output lists the draft domain map. Review it, then run `swarm domains <run-id> --freeze` (or pass `--auto-freeze` on the first dispatch).

`--seed-from-roadmap` is the T4 consumption side of the [trajectory layer](/testing-os/handbook/trajectory/): it records durable lineage from a prior run's compiled roadmap onto the new run, so the first audit wave's briefs open with that roadmap's bounded digest instead of starting cold. Bare (or `=latest`) resolves `dogfood/roadmap/latest.json`; `=<run-id>` resolves that run's artifact directly. Resolution is fail-fast and validating — a missing artifact refuses with `ROADMAP_SEED_NOT_FOUND`, a malformed one with `ROADMAP_SEED_SCHEMA_INVALID` ([error codes](../error-codes/)) — so a run can never be created against a phantom or broken lineage. Seeding is always an explicit flag; nothing propagates from run to run silently.

## swarm domains

Inspect, edit, freeze, or unfreeze the per-run domain map. The domain map is what determines per-agent file ownership; freezing it locks the surface so dispatch can produce verifiable per-agent prompts. Ownership classes: `owned` (exclusive, dispatched), `shared` (multi-writer, never dispatched), `bridge` (non-exclusive, dispatched), `coordinator` (exclusive like owned, **skipped at dispatch** — F-ef270b6e / GitHub #67). Subcommands (all via flags) cover the full lifecycle: `--freeze`, `--unfreeze --reason "..."`, `--edit <name>`, `--add <name> --globs '[...]'`, `--remove <name>`, `--history`.

```text
Usage:
  swarm domains <run-id>             # show current map
  swarm domains <run-id> --freeze    # lock for the run
  swarm domains <run-id> --unfreeze --reason "."
                                     # unlock (reason required)
  swarm domains <run-id> --history   # change events
```

Every mutation lands in `domain_events` with the operator-supplied reason — same audit discipline as the wave/agent state events.

## swarm dispatch

Create a new wave for a phase and write per-agent prompts to `swarms/<run-id>/wave-<N>/`. The phase names the work shape — `health-audit-a`, `health-amend-b`, `stage-d-amend`, `feature-execute`, and friends. Pass `--skip-verify` on amend phases to enable the parallel-wave verification discipline (agents skip per-agent `npm test`; coordinator runs one serial verify after `swarm collect`). Under `--skip-verify` every agent brief also carries the cost bounds (Protocol § "Cost bounds for parallel amend waves"): no full-suite runs by an agent, no per-agent pin re-derivation, relay posts under 300 words of facts, probes as scripts by path, one reverted-red proof per finding, stop at the list — bounds that override any coordinator brief that says otherwise.

```text
Usage: swarm dispatch <run-id> <phase>
                      [--auto-freeze]
                      [--isolate | --no-isolate]
                      [--skip-verify]
                      [--seed-roadmap]
                      [--roadmap-digest=<run-id>]
                      [--no-roadmap-digest]
                      [--dry-run]        # alias --preview

Example:
  $ swarm dispatch <run-id> health-audit-a
  $ swarm dispatch <run-id> health-amend-b --skip-verify
  $ swarm dispatch <run-id> feature-execute --dry-run
  $ swarm dispatch <run-id> health-amend-a --no-isolate
```

For a run initialized with `--seed-from-roadmap`, the first audit-phase dispatch automatically injects the seeded roadmap's bounded digest (top-K attention list + unexpired notes + drain summary) at the **top** of every generated brief — the T4 positioning rule. `--no-roadmap-digest` suppresses the injection for one dispatch; `--roadmap-digest=<run-id>` injects a specific run's roadmap explicitly (refusing with `DISPATCH_ROADMAP_DIGEST_NOT_FOUND` if that run has no compiled artifact — the check runs *before* the wave-build transaction, so a bad reference can never strand a half-built wave). `--seed-roadmap` opts an unseeded run's dispatch into the same injection.

`--dry-run` (alias `--preview`) previews the wave shape with **zero side effects** — which domains become agents, the prompt paths that would be written, the per-domain approved-finding routing (on amend phases), and (under `--isolate`) the worktrees that would be created — without opening the wave-build transaction or touching the working tree.

Phases: `health-audit-a/b/c`, `health-amend-a/b/c`, `stage-d-audit`, `stage-d-amend`, `feature-audit`, `feature-execute`.

**`--isolate` is the default** (F-80afe435). Omitted, each dispatched agent gets its own git worktree. `--isolate` is accepted and still isolates. `--no-isolate` is the explicit shared-worktree escape (if both flags are present, `--no-isolate` wins). Per-agent worktrees are **required for sound cross-domain ownership enforcement on a multi-domain amend wave**: only then can `swarm collect` independently attribute an edit to the agent that made it. Under `--no-isolate`, an agent that silently edits a file outside its domain *and* omits it from `files_changed` is not independently caught — the check falls back to the agent's self-report for cross-domain edits (see [swarm collect](#swarm-collect) and the Protocol's "Ownership attribution in non-isolated parallel amend waves" section). Bare `swarm dispatch <run> <phase>` now isolates; that is a breaking change for anyone who relied on a shared worktree.

## swarm collect

Validate every agent's output JSON against the canonical Ajv envelope and the phase-specific legacy validator, enforce file-ownership per the frozen domain map, and merge findings into the control plane. This is the gate that flips a wave from `dispatched` to `collected` (or to `failed` when any agent's output is BLOCKED).

```text
Usage: swarm collect <run-id>
                     (--all
                      | --domain=name:path
                        [--domain=name:path ...])

Example:
  $ swarm collect <run-id> --all
  $ swarm collect <run-id> \
      --domain=backend:outputs/backend.json \
      --domain=tests:outputs/tests.json
```

`--all` auto-discovers the dispatched agents' outputs from the deterministic dispatch layout (`swarms/<run-id>/wave-N/<domain>/output.json`) so you don't hand-type one `--domain=name:path` per agent. It reads the latest dispatched wave from the control plane and resolves each dispatched domain's expected output path. A domain whose output file is **missing** is a non-fatal warning — collect proceeds with the present ones, and the absent agent is reported `failed` (re-run it, or supply its path with `--domain`). `--all` and explicit `--domain` are **mutually exclusive**: an explicit `--domain` overrides `--all`, leaving the manual path unchanged.

When `--skip-verify` was used on dispatch, the output ends with a `[!] SERIAL VERIFY REQUIRED [!]` banner; run `npm run verify` against the cumulative tree before `swarm status` to advance the wave.

Ownership is enforced against the **union** of each agent's self-reported `files_changed` and an independently-probed git diff. That independent probe can only attribute edits per-agent when the wave was dispatched with `--isolate`. In a **non-isolated** amend wave every agent shares one worktree, so the probe is narrowed to each agent's own domain globs to avoid flagging siblings' legitimate edits — which means **cross-domain ownership is sound only for self-reported edits**: a silent, unreported out-of-domain edit is not independently caught. When two or more domains run this way, collect prints an `[!] OWNERSHIP PROBE DEGRADED [!]` banner recommending a re-dispatch with `--isolate`. The banner is advisory — it does not change the exit code or the wave gate; a self-reported violation still fails the wave in either mode. Re-dispatch with `--isolate` when the guarantee must hold against an unreported edit.

## swarm doctor

Run cheap, **read-only** preflight checks before a real dispatch wastes your time on a misconfigured environment. Prints a structured pass/warn/fail report and exits non-zero **only** on a hard FAIL (warnings exit `0`). No `<run-id>` required — doctor probes the environment and the control-plane DB path.

Seven checks, each grounded in a real dependency of the running control plane (no fictional probes). The first three **fail** the process; git-available and the three environment-health checks are **WARN** (exit still `0`). Repair for stranded worktrees stays `swarm clean` — doctor never deletes.

- **node-version** — Node ≥ 22, the package `engines.node` floor.
- **control-plane-writable** — the directory that will hold `control-plane.db` is writable **and** hardlink-capable. The cross-process file lock claims the lock via `link(2)`; exFAT/FAT32 do not support hardlinks (the documented FS trap), so a dispatch there fails opaquely. Doctor surfaces it up front.
- **schema-version** — the on-disk `control-plane.db` is not a **newer** schema than this build understands. A too-new DB means "upgrade the tool," not "delete the DB" — doctor reads the version read-only and reports it as a hard FAIL.
- **git-available** — `git --version` on PATH. WARN, not a hard fail: the SQLite control plane runs without git, but the ownership probe and `--isolate` worktrees degrade.
- **disk-free** — free space on the volume that holds `SWARM_DB` / `.swarm` worktrees. WARN below the documented floor.
- **control-plane-size** — combined size of `control-plane.db` + `.db-wal` + `.db-shm`. WARN at/above the documented ceiling. Doctor does not vacuum.
- **stranded-worktrees** — leftover `--isolate` trees under `<repo>/.swarm/worktrees` (git-listed and fs-only orphans). WARN if any remain. Hint: `swarm clean <run-id>` (dry-run by default).

```text
Usage: swarm doctor [--format=text|json]

Example:
  $ swarm doctor
  $ swarm doctor --format=json
```

## swarm verify

Run build verification on the run's repo. Auto-detects the toolchain (node / python / rust) by probing for `package.json`, `pyproject.toml`, `Cargo.toml`, etc., or accepts an explicit `--adapter`. Use `--probe-only` to see which adapters would match without running anything.

```text
Usage: swarm verify <run-id>
                    [--adapter node|python|rust]
                    [--probe-only]

Example:
  $ swarm verify <run-id>                    # auto-detect
  $ swarm verify <run-id> --adapter python   # force python
  $ swarm verify <run-id> --probe-only       # dry probe
```

Two environment overrides shape a step: `SWARM_VERIFY_MAX_BUFFER_BYTES` (the stdout+stderr capture ceiling, default 64 MB) and `SWARM_VERIFY_STEP_TIMEOUT_MS` (the per-step wall-clock timeout; a suite that legitimately runs longer than the adapter default — a 7,500-test suite on a shared rig needed `900000` — sets it rather than splitting the suite). A step that exceeds either limit is a FAIL receipt that names the limit, never a hung verify.

## swarm verify-fixed

Re-audit findings that an amend agent marked `[fixed]`. Classifies each into `verified`, `regressed`, `claimed-but-still-present`, or `unverifiable`, and writes a delta JSON to `swarms/<run-id>/verify-fixed-<wave>.json`. Used as a CI gate: exits non-zero when `regressed + claimed-but-still-present > --threshold` (default 0).

```text
Usage: swarm verify-fixed <run-id>
                          [--threshold=N]
                          [--format=text|markdown|json]
                          [--legacy-v1]

Example:
  $ swarm verify-fixed <run-id> --threshold=0
  $ swarm verify-fixed <run-id> --format=markdown > delta.md
```

Schema v2 is default (vantage-point disclosure via `verified_via`); pass `--legacy-v1` for backward-compat consumers.

## swarm verify-recurring

Audit findings that have **multiple** `[fixed]` events in their history — the regression-and-reclaim pattern. Writes a delta JSON to `swarms/<run-id>/verify-recurring-<wave>.json` so you can see at a glance which findings keep coming back. Output schema `verify-recurring-delta/v1`.

```text
Usage: swarm verify-recurring <run-id>
                              [--threshold=N]
                              [--format=text|markdown|json]

Example:
  $ swarm verify-recurring <run-id>
```

## swarm verify-unverified

Re-classify findings that were deferred as `unverified` against the current code state. The wave classifier marks findings `unverified` when no scope is supplied for re-checking; this verb resolves them. Writes delta JSON to `swarms/<run-id>/verify-unverified-<wave>.json`. Output schema `verify-unverified-delta/v1`.

```text
Usage: swarm verify-unverified <run-id>
                               [--threshold=N]
                               [--format=text|markdown|json]

Example:
  $ swarm verify-unverified <run-id>
```

## swarm verify-approved

Pre-amend gate that confirms approved findings still have valid anchors in the current code state. **Exit code 2** (broken anchor) blocks subsequent amend dispatch — wired into CI as a check so amend agents never run against a finding whose anchor has drifted. Writes delta JSON to `swarms/<run-id>/verify-approved-<wave>.json`.

```text
Usage: swarm verify-approved <run-id>
                             [--threshold=N]
                             [--format=text|markdown|json]

Example:
  $ swarm verify-approved <run-id>  # gate before amend
```

## swarm receipt

Export a durable wave receipt — JSON + Markdown — to `swarms/<run-id>/wave-<N>/` and store the paths in the control plane. The receipt is the auditable, portable record of the wave's outcome (counts, agents, findings, recommendation). Defaults to the latest wave; pass a wave number to export an older one.

```text
Usage: swarm receipt <run-id> [wave-number]
                    [--format=text|json]

Example:
  $ swarm receipt r-2026-05-20-001        # latest wave
  $ swarm receipt r-2026-05-20-001 3      # wave 3
```

`--format=json` emits the receipt object to stdout (pure JSON) for an automation harness, alongside the durable on-disk export.

## swarm advance

Check the phase-advancement gates and (if they pass) promote the run to the next phase. Use `--check-only` to see gate results without mutating, `--history` to read the promotion log, or `--override --reason "..."` to force-promote past a soft block. Hard blocks (e.g. blocked agent_runs) cannot be overridden — fix the underlying state first.

Amend routing is **CRITICAL/HIGH only.** After `health-audit-b`, `swarm advance` promotes to `health-amend-b` only when open CRITICAL or HIGH remain; otherwise it promotes to `health-audit-c` and skips Stage C (humanization) entirely. Stage B findings are usually MED/LOW, so a blind advance after Stage B review **will skip** `health-amend-b`. PROTOCOL still requires that amend. Dispatch it yourself after approve:

```bash
swarm dispatch <run-id> health-amend-b --isolate --skip-verify
```

The same CRIT/HIGH-only gate applies at `health-audit-a`, `health-audit-c`, and `stage-d-audit`. `swarm advance` is not a substitute for `swarm dispatch <phase>` when you need an amend the severity gate did not force.

```text
Usage: swarm advance <run-id>
                     [--check-only]
                     [--history]
                     [--override --reason "..."]
                     [--format=text|json]

Example:
  $ swarm advance <run-id> --check-only
  $ swarm advance <run-id>
  $ swarm advance <run-id> \
      --override --reason "operator accepts soft warn"
```

## swarm adjudicate

Dispatch a neutral case-file to the cross-family jury and record the advisory verdict on the run's current wave — the wave gate `swarm advance` reads (`corroborate` clears; anything else needs Director disposition). Two tiers: `--jury=local` (default, free local seats, whole-brief reads) and `--jury=prism` (per-criterion, multi-lens, signed receipts, 4,000-char brief cap); `--cloud` opts into the paid seats and **spends Ollama-Cloud credits**. Exits 0 only on corroborate. The full contract — case-file shape, neutrality lint, tier trade-offs, compensators — lives in [`docs/case-file-contract.md`](https://github.com/dogfood-lab/testing-os/blob/main/docs/case-file-contract.md); read it before your first adjudication.

`--wave <n>` binds the verdict to a specific wave instead of the run's latest — the case when an amend wave was dispatched before the audit wave's jury ran. A wave the run does not have refuses with `CLI_WAVE_NOT_FOUND` before the jury is called, and the dry-run header names the wave resolved.

```text
Usage: swarm adjudicate <run-id>
           --case-file <path>
           [--wave <n>]
           [--jury=local|prism] [--cloud]
           [--dry-run] [--format=text|json]
       swarm adjudicate <run-id>
           --undo <adjudication-id> [--apply]

Example:
  $ swarm adjudicate <run> \
      --case-file case-file.json --dry-run
  $ swarm adjudicate <run> \
      --case-file case-file.json --jury=local --cloud
```

## swarm status

Render the full control-plane status for a run — phase, waves, agent states, findings counts, recovery breadcrumbs. The scan-first surface: read this when you want to know "what is this run, where is it in the lifecycle, what's blocking it, and what do I run next." The trailing `Next:` line is the canonical pointer to the next action.

`--format=json` emits the full structured status object (`run`, `domains`, `waves`, `agents`, `findings`, `assessment`) instead of the text frame — the same object the text formatter consumes, so a script never sees a divergent shape. The default is text. Exit code is unchanged (status is informational).

```text
Usage: swarm status <run-id> [--format=text|json]

Example:
  $ swarm status r-2026-05-20-001
  $ swarm status r-2026-05-20-001 --format=json \
      | jq '.assessment.state'
```

When a wave has interesting history (override transitions, multiple state changes), a breadcrumb points at `swarm history <wave-id>` — see [swarm history](../swarm-history/).

## swarm resume

Redispatch incomplete agents in the latest wave. Useful when an agent crashed or was cancelled mid-run and its output never arrived. Re-creates the prompt and re-issues the dispatch; the agent_run row's state machine ensures completed agents in the same wave aren't redispatched (their work is preserved).

```text
Usage: swarm resume <run-id> [--dry-run] [--force]

Example:
  # preview first — what would it redispatch?
  $ swarm resume r-2026-05-20-001 --dry-run
  $ swarm resume r-2026-05-20-001
```

**The wave moves with the agents.** When resume redispatches at least one agent on a wave that is not already `dispatched` — most often a `failed` wave, the state a missing or rejected output leaves behind — it also returns the wave to `dispatched`, recorded in `wave_state_events` with a `resume:` reason. Without that, the loop resume itself prints ("run the redispatched agent(s), then `swarm collect`") could not close: `swarm collect` requires a `dispatched` wave. A resume that redispatches nothing leaves the wave exactly as it found it.

`swarm redrive` remains the verb purpose-built for a failed wave — it takes a wave_id and a required `--reason`, moves the whole failure tail at once, and preserves every `complete` agent's receipt byte-identical. Use resume when you want fresh prompts and worktrees for the agents that did not report; see [`swarm redrive`](../recovery/#swarm-redrive) for the alternative.

## swarm clean

Reclaim the stranded `--isolate` worktrees + `swarm/<run>/...` branches a run left behind. Two things leave worktrees on disk: (1) a run you stop after `collect` — or any single-purpose audit run that never promotes — never reaches the teardown at all; and (2) as of the wave-4 hardening, even a run that promotes all the way to phase `complete` (`swarm advance`) — or a `swarm rewind --apply` — now **preserves** (and loudly names) any worktree with uncommitted edits or unmerged commits, rather than force-destroying agent work that never merged. So a `complete` run can still leave per-agent worktrees on disk when their work was never merged. `swarm clean` is the operator-facing reclaim for both cases, run-scoped by the run's branch prefix so it never sweeps a sibling run — and `swarm clean --apply` is the only verb that removes such preserved work.

:::caution[`--apply` removes preserved work — no undo]
`swarm clean --apply` is the **only** verb that deletes worktrees the promotion/rewind cleanup deliberately preserved — including branches carrying **unmerged commits**. Run the dry-run first (the default) and read the `[!] DIRTY / UNMERGED` annotations before you `--apply`; the deletion is irreversible.
:::

Like the [Three R's recovery verbs](../recovery/), it is **dry-run by default** — it lists what it *would* remove (with the `{removed, stranded, total}` rollup) and only acts with `--apply`. Each at-risk entry in the preview is annotated inline — `[!] DIRTY: uncommitted edits + UNMERGED commits — --apply destroys this work` — so `--apply` is informed consent, never a blind force-delete. Supports `--format=json`.

```text
Usage: swarm clean <run-id> [--apply] [--format=text|json]
       # default: dry-run preview; --apply actually removes

Example:
  $ swarm clean <run>          # preview stranded worktrees
  $ swarm clean <run> --apply  # remove them + branches
```

## swarm clean-claims

Delete phantom `violation=1` file_claims rows stranded on **terminal** waves (`advanced` / `aborted_for_rewind`) — rows no lawful verb can revisit: `collect` only runs on a `dispatched` wave, `revalidate` only repairs blocked agents on the run's latest wave, and `redrive` refuses terminal waves outright. The class is real: a corrected pass (a revalidate repair, a fixed diff base) supersedes an earlier pass's violation claims, and before the reconcile fix landed, nothing cleaned the stale rows once the wave advanced — they permanently corrupted `swarm status`'s violation count and every exported `swarm receipt` for that wave.

file_claims rows are **claims about what a pass observed, not audit events** — deleting a superseded claim is the lawful write. The `agent_state_events` audit trail is never touched; the dry-run preview shows each agent_run's rows *plus* the state-event evidence that supersedes them, so `--apply` is informed consent. Rows on non-terminal waves are refused with the verb that still owns them; `violation=0` rows and other runs' rows are never touched (re-verified inside the delete transaction — a violated invariant rolls everything back). On `--apply`, one restorable audit row per affected domain lands in `domain_events` (`event_type: file_claims_cleaned`, visible via `swarm domains <run-id> --history`).

```text
Usage: swarm clean-claims <run-id> [--wave=N] [--agent-run=ID]
                          [--apply --reason "<text>"]
                          [--format=text|json]
       # default: dry-run preview
       # --apply --reason deletes

Example:
  $ swarm clean-claims <run>       # preview rows + evidence
  $ swarm clean-claims <run> --wave=4 \
      --apply --reason "diff base superseded"   # audited
```

## swarm approve

Mark findings as approved-for-amend. Either `--all` to approve every `new` or `recurring` finding on the run, or `--ids F-001,F-002,...` to approve a specific subset. Findings must be approved before the amend phase can pick them up; the `approved` status is recorded in `finding_events` with a bulk-approve event marker.

```text
Usage: swarm approve <run-id>
                     [--all | --ids F-001,F-002]

Example:
  $ swarm approve <run-id> --all
  $ swarm approve <run-id> --ids F-091578-034,F-091578-042
```

## swarm defer

Give a targeted set of findings the terminal `deferred` disposition — consciously accepted or postponed work that does **not** block the stage. `--ids` and a non-empty `--reason` are both required (there is no `--all`: disposition is deliberate, per-finding). The flip is recorded as a reason-bearing `finding_events` row, and `deferred` is a **closed** status for the advancement gate — so deferred work stops being silently re-closed as "fixed-by-absence" by a later full-coverage audit. Idempotent over already-terminal findings.

```text
Usage: swarm defer <run-id> --ids F-001,F-002 --reason "<text>"

Example:
  $ swarm defer <run-id> --ids F-001 --reason "accepted risk"
```

## swarm reject

Give a targeted set of findings the terminal `rejected` disposition — triaged away as not-a-defect. Same shape as `swarm defer`: `--ids` + non-empty `--reason` required, reason recorded in `finding_events`, `rejected` counts as closed for the gate, idempotent over terminal findings.

```text
Usage: swarm reject <run-id> --ids F-001,F-002 --reason "<text>"

Example:
  $ swarm reject <run-id> --ids F-002 --reason "not a defect"
```

## swarm reopen

Reopen wrongly-closed findings — the recovery path the "Three R's" contract never had. Moves `fixed` / `deferred` / `rejected` rows back to `recurring` (open, amendable). `--ids`, a non-empty `--reason`, **and** a non-empty `--evidence` are all required (no `--all`: reopening is deliberate, per-finding, evidence-bearing). Dry-run by default; `--apply` mutates; `--format=text|json` selects the render (json emits the same report object read-only calls already return). The reopen resets the row's closure-provenance fields while the original closure survives immutably in `finding_events`, and the acting authority is recorded on the event — closer and reopener are distinct authorities by design. There is deliberately no automatic reopen beyond the pre-existing regression-rediscovery path (a re-reported fingerprint reopening a `fixed` row): reopen-prediction does not generalize, and stale-bot-style automation has a documented wrongful-closure record.

```text
Usage: swarm reopen <run-id> --ids F-001,F-002
                    --reason "<text>" --evidence "<text>"
                    [--apply] [--format=text|json]

Example:
  $ swarm reopen <run-id> --ids F-001 \
      --reason "fix regressed in v1.9.1" \
      --evidence "repro: wave12 pin fails" --apply
```

## swarm close

Operator closure for findings that cannot close by owning-domain declaration — the unowned-file class (a finding on a path no domain's globs match) and Director-directed disposals. Narrow by design: `--as fixed` is the only disposition (deferring and rejecting stay the standalone `swarm defer` / `swarm reject` verbs). Requires `--ids`, `--reason`, `--evidence`, and `--verified-how independent|self_attested|operator_evidence` — the verification mode is load-bearing, not decoration: review-verified fixes demonstrably reopen less than self-attested ones. Dry-run by default; `--apply` mutates; `--format=text|json` selects the render. Writes `closure_kind='operator'` and a `finding_events` row whose `event_type` mirrors the `--as` target status (`'fixed'` today, the only value `--as` accepts) — never a distinct `operator_closed` event type — carrying the acting authority; the by-absence closure kind is never reachable from any verb.

```text
Usage: swarm close <run-id> --ids F-001,F-002 --as fixed
                   --reason "<text>" --evidence "<text>"
                   --verified-how <mode> [--apply]
                   [--format=text|json]

Example:
  $ swarm close <run-id> --ids F-001 --as fixed \
      --reason "fixed in 93afb83; unclosable by \
                declaration (file matches no domain)" \
      --evidence "gate re-run green; wave-37 receipt" \
      --verified-how operator_evidence --apply
```

## swarm roadmap

Compile and inspect the trajectory artifact — the compiled-never-authored roadmap that lets the next run on this repo start targeted instead of cold. `compile` regenerates `dogfood/roadmap/<run-id>.json` (+ the `latest.json` pointer) from the control-plane DB and git alone: open/deferred queues, the drain queue with per-entry provenance and cadence, recurrence stats, the advisory attention list, and the bounded operator notes (validated at compile — an `invariant` note must name an existing `enforced_by` gate; expired notes are dropped loudly). `show` renders the latest artifact, or an earlier one via `--version=N`. `compile --undo <sequence> --apply` is the named compensator for a partial or wrong compile: it removes exactly that sequence's ledger row and, when that sequence was the latest, repoints `latest.json` at the prior version (dry-run without `--apply`; a nonexistent sequence refuses with `ROADMAP_UNDO_NOT_FOUND`, zero mutation). See the [trajectory layer](/testing-os/handbook/trajectory/) page for the full design and its refusals.

```text
Usage: swarm roadmap compile <run-id> [--format=text|json]
                             [--undo <sequence> --apply]
       swarm roadmap show <run-id> [--version=N]
                          [--format=text|json]

Example:
  $ swarm roadmap compile <run-id>
  $ swarm roadmap compile <run-id> --undo 3 --apply
  $ swarm roadmap show <run-id> --format=json
```

## swarm persist

Export the canonical truth from the swarm control plane to downstream systems — typically the testing-os ingest pipeline for cross-repo intelligence. Use `--dry-run` to preview the export without writing, `--ingest` to invoke the downstream ingester after the export lands.

```text
Usage: swarm persist <run-id> [--ingest] [--dry-run]

Example:
  $ swarm persist r-2026-05-20-001 --dry-run
  $ swarm persist r-2026-05-20-001 --ingest
```

## swarm findings

Print a findings digest for a wave (default: the latest). Format auto-detects — `text` on a TTY, `markdown` when piped or redirected — so the same command works for human scanning and for CI gates. Override with `--format=text|markdown|json` or the `DOGFOOD_FINDINGS_FORMAT` env var (`raw|human|json`).

```text
Usage: swarm findings <run-id> [wave-number]
                      [--format=text|markdown|json]

Example:
  $ swarm findings <run-id>            # latest wave, auto fmt
  $ swarm findings <run-id> 3 --format=json   # wave 3 JSON
  $ swarm findings <run-id> > digest.md       # md to file
```

Exit codes are 3-way: `0` clean, `1` findings present, `2` audit pipeline broken — so CI can distinguish "no findings" from "pipeline broke."

## swarm runs

List every run in the control-plane DB, with wave + findings counts and the created-at timestamp. The orientation verb: run this first when you've forgotten what runs exist or which run id is the latest one.

`--format=json` emits a JSON array of per-run rollups (`id`, `repo`, `status`, `branch`, `waveCount`, `findingCount`, `created`) — always an array, so an empty DB yields `[]` rather than the human "No runs found." text. The default is text.

```text
Usage: swarm runs [--format=text|json]

Example:
  $ swarm runs
  $ swarm runs --format=json | jq '.[].id'
```

## swarm trends

Cross-run analytics — the **only** cross-run verb. Every other verb is scoped to a single `<run-id>`, but the control plane accumulates data that is only meaningful across runs: finding fingerprints are content-addressed and stored `UNIQUE(run_id, fingerprint)`, so the same fingerprint observed in two runs produces two rows. `swarm trends` reads that cross-run signal. Pick a query with `--query`; render text (default) or JSON with `--format`.

- `--query recurring` — fingerprints seen in **more than one run** (a fix that regressed, or a defect class the swarm keeps re-discovering), with `{fingerprint, description, run_count, severity, first_seen, last_seen}`.
- `--query history` — per-run rollup (`{run_id, repo, wave_count, finding_count, status, created_at}`), newest first. Optional `--repo <substring>` filters runs by a repo LIKE match.
- `--query recurrence` — recurrence-rate stats (`total_runs`, `distinct_fingerprints`, `recurring_fingerprints`, `recurrence_rate`). Optional `--window-days N` restricts to a trailing window anchored at the newest run.

```text
Usage: swarm trends --query <recurring|history|recurrence>
                    [--format=text|json]
                    [--repo <substring>]    (history only)
                    [--window-days N]       (recurrence only)

Example:
  $ swarm trends --query recurring
  $ swarm trends --query history --repo my-repo --format=json
  $ swarm trends --query recurrence --window-days 30
```

A missing or out-of-enum `--query` exits `1` with a Usage error (fail-loud, never a silent no-op); an out-of-enum `--format` is rejected by the shared `CLI_INVALID_FORMAT` guard.

## See also

- [Operating guide](../operating-guide/) — day-to-day workflows for record ingestion + portfolio review.
- [Recovery (the Three R's)](../recovery/) — full reference for `revalidate`, `rewind`, `redrive`.
- [swarm history](../swarm-history/) — deep-audit verb for `wave_state_events`.
- [State machines](../state-machines/) — the four distinct status vocabularies, including agent_run lifecycle and BLOCKED override path.
- [Error codes](../error-codes/) — referenced from CLI error output; severity tiers + hint text.
