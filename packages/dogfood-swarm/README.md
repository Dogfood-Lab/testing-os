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

Binary: `swarm`. Requires Node ≥ 20.

## Quick start

```bash
# Initialize a swarm run
swarm dispatch <run-id> <wave-number>

# (Agents execute externally — e.g., parallel Claude sessions — and write
#  their outputs to swarms/<run-id>/wave-N/<domain>/output.json)

# Collect outputs through the verifier
swarm collect <run-id>

# Inspect current wave + agent state
swarm status <run-id>

# Inspect wave transition history (full audit chain)
swarm history <wave-id>

# Generate per-wave receipt artifact
swarm receipt <run-id>

# Advance to the next phase once gates pass
swarm advance <run-id>
```

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
# Failed wave needs schema-mismatch repair
swarm revalidate <run-id> --reason "wave-2 schema mismatch corrected" --apply

# Wedged wave — restart from save-point tag
swarm rewind <save-point-tag> --reason "rolling back wedged amend wave" --apply

# Transient infra failure — resume only the failed agents
swarm redrive <wave-id> --reason "GitHub API outage retry" --apply

# Audit the full transition chain for any wave
swarm history <wave-id>
```

## State machines

Two parallel state machines:

- **Agent runs** (`lib/state-machine.js`): `pending → dispatched → complete | failed | invalid_output | ownership_violation | aborted_for_rewind`
- **Waves** (`lib/wave-state-machine.js`): `dispatched → collected → verified → advanced | failed | aborted_for_rewind`

Discipline:

- **Terminal statuses** (`complete`, `advanced`, `aborted_for_rewind`) cannot be transitioned out of — not even with `override=true`.
- **BLOCKED statuses** (`failed`, `invalid_output`, `ownership_violation`) require explicit `override=true` + non-empty `reason` to transition out.
- Every transition lands in `wave_state_events` / `agent_state_events` **atomically** with the underlying status mutation, inside the same SQLite transaction.

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
