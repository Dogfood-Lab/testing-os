<p align="center">
  <a href="https://github.com/dogfood-lab/testing-os">
    <img src="https://raw.githubusercontent.com/dogfood-lab/testing-os/main/assets/logo.png" alt="testing-os" width="280">
  </a>
</p>

# @dogfood-lab/dogfood-swarm

> 10-phase parallel-agent protocol runner for testing-os. SQLite-backed control plane, durable receipts, domain-aware orchestration. Three R's recovery contract: `revalidate` / `rewind` / `redrive`.

Part of the [`testing-os`](https://github.com/dogfood-lab/testing-os) monorepo — the operating system for testing in the AI era.

The `swarm` CLI runs parallel-agent audits against a codebase. Each wave dispatches multiple agents under exclusive file ownership, collects their outputs through the verifier, and persists durable receipts to a SQLite control plane. The wave-level and agent-level state machines surface every status transition as an auditable event; the recovery verbs (`revalidate`, `rewind`, `redrive`) handle wave failures lawfully without raw SQL surgery.

## Install

```bash
npm install -g @dogfood-lab/dogfood-swarm
```

Binary: `swarm`. Requires Node ≥ 22.

## Quick start

```bash
# Initialize a swarm run — detects domains, records a save-point
swarm init <repo-path>

# Review the detected domain draft, then freeze it (dispatch refuses
# to run until the domain map is frozen)
swarm domains <run-id> --freeze

# Dispatch a wave for a named phase (NOT a wave number — phase names below)
swarm dispatch <run-id> <phase>

# (Agents execute externally — e.g., parallel Claude sessions — and write
#  their outputs to swarms/<run-id>/wave-N/<domain>/output.json)

# Collect outputs through the verifier — one --domain per dispatched agent
swarm collect <run-id> \
  --domain=backend:swarms/<run-id>/wave-N/backend/output.json \
  --domain=tests:swarms/<run-id>/wave-N/tests/output.json

# Inspect current wave + agent state
swarm status <run-id>

# Preflight the environment before dispatching (read-only checks)
swarm doctor

# Same status as a structured object for machine consumers / scripts
swarm status <run-id> --format=json

# List all runs (text), or as a JSON array of per-run rollups
swarm runs
swarm runs --format=json

# Inspect wave transition history (full audit chain)
swarm history <wave-id>

# Generate per-wave receipt artifact
swarm receipt <run-id>

# Advance to the next phase once gates pass
swarm advance <run-id>
```

### Collecting outputs — `--all` vs explicit `--domain`

`swarm collect` needs one agent-output path per dispatched domain. You can
hand-type them, or let `--all` auto-discover them from the deterministic
dispatch layout (`swarms/<run-id>/wave-N/<domain>/output.json`):

```text
# Auto-discover the latest dispatched wave's agent outputs
swarm collect <run-id> --all

# Equivalent explicit form (--all expands to this)
swarm collect <run-id> \
  --domain=backend:swarms/<run-id>/wave-N/backend/output.json \
  --domain=tests:swarms/<run-id>/wave-N/tests/output.json
```

`--all` reads the latest dispatched wave from the control plane and resolves
each dispatched domain's expected output path. A domain whose output file is
**missing** is a non-fatal warning — collect proceeds with the present ones,
and the absent agent is reported `failed` (re-run it, or supply its path with
`--domain`). `--all` and explicit `--domain` are **mutually exclusive**: pass
a `--domain` and it overrides `--all` (the manual path stays unchanged).

### Preflight — `swarm doctor`

Before a real dispatch, `swarm doctor` runs cheap **read-only** environment
checks and prints a structured pass/warn/fail report:

```bash
swarm doctor
```

It verifies Node ≥ 22 (the `engines.node` floor), that the control-plane
directory is writable **and** hardlink-capable (the cross-process file lock
uses `link(2)`, which exFAT/FAT32 do not support — the documented FS trap),
and that the on-disk `control-plane.db` schema is not newer than this build.
It exits non-zero **only** on a hard FAIL; warnings exit `0`.

Every other verb is scoped to a single run. `swarm trends` is the one
**cross-run** verb — it reads the data the control plane accumulates across
runs (content-addressed finding fingerprints, per-run rollups) and answers
"what keeps coming back?" Pick a query with `--query`, optionally `--format=json`:

```bash
# Findings whose fingerprint was seen in more than one run (a fix that
# regressed, or a defect class the swarm keeps re-discovering)
swarm trends --query recurring

# Per-run history, newest first — optionally filtered by repo substring
swarm trends --query history --repo my-repo

# Recurrence-rate stats over the run population (optional trailing window)
swarm trends --query recurrence --window-days 30 --format=json
```

`<phase>` is a named phase, not a wave number. The valid values are:
`health-audit-a`, `health-audit-b`, `health-audit-c`, `stage-d-audit`,
`feature-audit` (audit phases) and `health-amend-a`, `health-amend-b`,
`health-amend-c`, `stage-d-amend`, `feature-execute` (amend phases). Run
`swarm dispatch --help` for the same list.

## Recovery — the Three R's

| Verb | When to use | Behavior |
|---|---|---|
| `swarm revalidate` | Agents wrote `invalid_output` — schema mismatch, validator rejection | Repairs in place; transitions agent_runs out of BLOCKED status via override (with operator `--reason`); wave-level rollback if all 4 agents repaired |
| `swarm rewind` | Wave needs full restart from a save-point; tree state needs reset | Restores tree via `git reset --hard <tag>`; lawfully aborts orphaned in-flight runs to terminal `aborted_for_rewind`; preserves audit chain (append-only) |
| `swarm redrive` | Some agents failed, others completed; want to resume the failing tail without re-running completed work | Same `wave_id`, completed receipts preserved byte-identical, only failed/pending agents made re-dispatchable |

All three recovery verbs share the same operator-safety contract:

- **Dry-run by default** — `--apply` required to mutate
- **`--reason "<text>"` required, non-empty** — recorded in `wave_state_events` / `agent_state_events` with a verb-specific prefix (`revalidate:` / `rewind:` / `redrive:`)
- **Zero raw SQL on `agent_runs.status` or `waves.status`** — every state mutation routes through `transitionAgent` / `transitionWave`; static-scan guard test (Pattern #10) blocks regressions

Example session:

```bash
# Failed wave needs schema-mismatch repair (re-supply the agent's output path)
swarm revalidate <run-id> --reason "wave-2 schema mismatch corrected" \
  --domain=backend:swarms/<run-id>/wave-2/backend/output.json --apply

# Wedged wave — restart from save-point tag
swarm rewind <save-point-tag> --reason "rolling back wedged amend wave" --apply

# Transient infra failure — resume only the failed agents
swarm redrive <wave-id> --reason "GitHub API outage retry" --apply

# Audit the full transition chain for any wave
swarm history <wave-id>
```

## Exit codes

The verbs designed to gate CI propagate a machine-readable exit code, not just human-readable stdout. Wire these into a workflow step or a `&&` chain and the gate fails closed:

| Verb | Exit code contract |
|---|---|
| `swarm verify` | `0` **only** when the verdict is `pass`; `1` for every other verdict (`fail`, `skip`, `no_tests`, `tool_missing`). Each non-pass verdict is "not a verified pass" — see [Verify verdicts](#verify-verdicts) — so the machine signal matches the human one and a CI `&&` chain fails closed (a `no_tests` or `tool_missing` never reads as success). |
| `swarm verify-fixed` | `0` clean / `1` threshold exceeded (`regressed + claimed-but-still-present > --threshold`, default 0) / `2` audit pipeline broken |
| `swarm verify-recurring` | `0` / `1` / `2` (same 3-way contract as `verify-fixed`) |
| `swarm verify-unverified` | `0` / `1` / `2` (same 3-way contract) |
| `swarm verify-approved` | `0` / `1` / `2` — exit `2` (broken finding anchor) is the pre-amend gate that blocks subsequent `swarm dispatch` of an amend phase |
| `swarm findings` | `0` clean / `1` findings present / `2` audit pipeline broken |
| `swarm persist --ingest` | `0` when the dogfood ingest succeeded (or was a `--dry-run`); `1` when the ingest failed. A bare `swarm persist` with no `--ingest` exits `0`. |

Any command also exits `1` on a structured operator error (the typed `code` / `message` / `Next:` envelope). Exit `2` is reserved for the "pipeline broken" case on the verbs above so a CI gate can tell *findings/regressions exist* (1) apart from *the audit itself could not run* (2).

## Troubleshooting — when a wave fails

Every command emits its stage transitions as **NDJSON on stderr**, so the first move in an incident is to capture that forensic stream and read it back:

```bash
swarm collect <run-id> \
  --domain=backend:swarms/<run-id>/wave-N/backend/output.json 2>collect.ndjson
grep '"stage"' collect.ndjson   # the ordered chain of what happened, with codes
```

Then map the symptom to the recovery verb:

| Symptom | What it means | Recovery |
|---|---|---|
| `collect` failed mid-upsert (`COLLECT_UPSERT_FAILED`) | One agent's output failed validation or the merge transaction aborted; the wave is `failed`. | `swarm revalidate <run-id> --reason "..." --domain=name:path --apply` — re-runs the same validators on the re-supplied output, and on pass flips the wave back to `collected` in one transaction. |
| Wave stuck in `dispatched` — never reached `collected` | Agents didn't all finish, or the run was interrupted before `collect`. | `swarm resume <run-id>` to re-dispatch the incomplete agents; or `swarm redrive <wave-id> --reason "..." --apply` to resume only the failed/unstarted tail while preserving completed receipts byte-identical. |
| Agents `BLOCKED` (`invalid_output` / `ownership_violation`) | Schema mismatch, or an agent wrote outside its frozen domain. | `invalid_output` → `swarm revalidate`. `ownership_violation` → extend the domain via `swarm domains --unfreeze … --edit … --freeze`, then `swarm revalidate`. |
| Wave wedged — tree state needs a full reset | The working tree drifted and the wave must restart from a save-point. | `swarm rewind <save-point-tag> --reason "..." --apply` — `git reset --hard <tag>` plus lawful abort of orphaned in-flight runs, audit chain preserved. |

All recovery verbs are **dry-run by default** — run them without `--apply` first to preview the transitions, then add `--apply`. Every error carries a typed `code` and a `Next:` hint; the full table is in the handbook.

📖 Deeper incident docs: **[Recovery](https://dogfood-lab.github.io/testing-os/handbook/recovery/)** · **[Error codes](https://dogfood-lab.github.io/testing-os/handbook/error-codes/)**

## State machines

Two parallel state machines:

- **Agent runs** (`lib/state-machine.js`): `pending → dispatched → running → complete | failed | timed_out | invalid_output | ownership_violation | aborted_for_rewind`
- **Waves** (`lib/wave-state-machine.js`): `dispatched → collected → verified → advanced | failed | aborted_for_rewind`

Discipline:

- **Terminal statuses** (`complete`, `advanced`, `aborted_for_rewind`) cannot be transitioned out of — not even with `override=true`.
- **BLOCKED statuses** (`failed`, `invalid_output`, `ownership_violation`) require explicit `override=true` + non-empty `reason` to transition out.
- Every transition lands in `wave_state_events` / `agent_state_events` **atomically** with the underlying status mutation, inside the same SQLite transaction.

## Verify verdicts

`swarm verify <run-id>` runs the build-verification adapter and prints `Verification: <VERDICT>`. Only `pass` advances the wave to `verified` — the other four verdicts are deliberately distinct so a no-op never masquerades as a clean pass:

| Verdict | Means | Advances the wave? |
|---|---|---|
| `pass` | Every required step ran and passed. | Yes |
| `fail` | A required step ran and failed — the code is broken. | No |
| `skip` | No required steps ran (every step was optional or filtered away). Nothing was verified. | No |
| `no_tests` | The repo has no `test` script; `npm test --if-present` ran zero tests. **Not** a verified pass — supply a real test command via a step override or pick an explicit `--adapter`. | No |
| `tool_missing` | A required tool (e.g. `npm`, `npx`) is absent from `PATH`, so verification could not run in this environment. **Not** a failure of the code under test — install the tool or run on a host that has it. | No |

`no_tests` and `tool_missing` exist precisely so the wave gate stays honest: it refuses to advance without positive evidence, but it does not falsely report `FAIL` when the cause is a missing test script or a missing build tool rather than a real regression.

## Control plane

SQLite-backed. Each swarm run gets `swarms/<run-id>/control-plane.db`:

| Table | Purpose |
|---|---|
| `waves` | Wave records (status, phase, wave_number, run_id, snapshot, serial_verify_required) |
| `agent_runs` | Per-agent dispatch records (status, domain, output_path, verification_skipped) |
| `wave_state_events` | Append-only wave-status audit log (from_status, to_status, reason, created_at) |
| `agent_state_events` | Append-only agent-status audit log (mirror shape of wave_state_events) |
| `findings` | Findings derived from agent outputs |
| `domain_events` | Domain-map mutation audit log (unfreeze / edit / freeze) |

Read via `swarm status`, `swarm history`, `swarm receipt`. Never via raw SQL in scripts — the state-machine helpers are the supported interface and the audit chain depends on going through them.

## Environment variables

Four environment variables are part of the scriptable surface:

| Variable | Accepted values | Effect |
|---|---|---|
| `SWARM_DB` | a filesystem path | Overrides the control-plane DB path. Unset → the default `swarms/<run-id>/control-plane.db`. Point this at a non-default DB to run against an alternate control plane. |
| `DOGFOOD_FINDINGS_FORMAT` | `raw` \| `human` \| `json` | Forces the `swarm findings` output format, overriding both the `--format` flag and TTY auto-detection. `raw` → markdown, `human` → text, `json` → JSON. |
| `DOGFOOD_LOG_HUMAN` | `0` \| `1` | Controls the human-readable companion banner printed alongside the NDJSON stage stream on **stderr**. `0` → never emit the banner (deterministic machine-readable stderr for CI), `1` → always emit it. Unset → emit only when stderr is a TTY. |
| `INGEST_REPO_ROOT` | a filesystem path | Overrides the **data root** the dogfood ingest writes to when `swarm persist --ingest` (or `persist-results.js`) shells out to `packages/ingest/run.js`. Unset → the real repo root (the live `records/` + `indexes/` corpus). Point it at a scratch dir to ingest without touching the real tree — the test suite sets it so ingest stays side-effect-free. |

Stage transitions are emitted as **NDJSON on stderr** — one JSON object per line, greppable — while stdout carries the command's parse target. Set `DOGFOOD_LOG_HUMAN=0` when you want a clean, machine-parseable stderr stream (e.g. `swarm collect ... 2>collect.ndjson`).

## 10-phase protocol

| Phase | Purpose |
|---|---|
| 1–4 (Health Pass) | Audit → Review → Amend → Repeat. Three stages: A (bug/security fix), B (proactive health), C (humanization), D (visual/presentation truth). Closes at 0 CRIT / 0 HIGH. |
| 5–8 (Feature Pass) | Feature audit → user review → execution → repeat. Production-readiness focus. |
| 9 | Final test pass — comprehensive validation across the whole system. |
| 10 | Full Treatment — shipcheck, README finalize + translations, landing page, handbook, repo-knowledge DB entry, deploy + verify. |

Each wave produces a manifest (`swarms/<run-id>/manifest.json`) and per-wave receipts (`swarms/<run-id>/wave-N/receipt.md`) for durable audit. A swarm is **not complete** until Phase 10 finishes.

## Domain ownership

Agents in a wave have exclusive file ownership scoped to their domain (typical domains: backend, bridge, tests, ci-tooling, frontend, docs). The frozen domain map at dispatch time is the canonical authority; the agent prompt is derived from the frozen state so dispatch + agent + verifier all consume the same shape.

Cross-domain mutation surfaces at collect time as status `ownership_violation` (BLOCKED). Recovery options:

- `swarm domains --unfreeze --reason "..." → --edit <domain> --globs "..." → --freeze` — to legitimately extend a domain's scope (recorded in `domain_events`)
- `swarm revalidate` — if the agent's `files_changed` self-report turns out to match the original frozen scope after coordinator review

## Save-point discipline

The repo's git tags + commits ARE the save points. Commits on `main` are the durable mechanism for "I can roll back to here." `swarm rewind` accepts any git tag matching `swarm-save-*` by default (`--force-arbitrary-ref` opts into any ref). Rewind is dry-run safe; verified by an explicit HEAD-guard test that confirms the actual repo's HEAD is unchanged after the rewind test suite runs (cordoned-test discipline).

## Docs

📖 Full handbook: **<https://dogfood-lab.github.io/testing-os/handbook/>**

## License

MIT © 2026 mcp-tool-shop
