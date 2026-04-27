---
title: Error Code Reference
description: Structured error codes surfaced by testing-os CLIs — what triggers each, what the operator hint says, what to do
sidebar:
  order: 7
---

testing-os' CLIs surface structured errors at the top-level seam via `renderTopLevelError` (`packages/dogfood-swarm/lib/error-render.js`). Every typed error carries:

- `code` — stable identifier (e.g. `ISOLATION_FAILED`)
- `message` — operator-facing prose
- `hint` — explicit next step (or a per-code derived hint when the error class did not set one)
- optional `cause` (`Caused by: …`), `runId`, `waveId`, `agentRunId`, `findingsAttempted`

CLI output shape:

```text
ERROR [<CODE>]: <message>
  Next: <hint>
  Caused by: <inner error message>
  Wave: <waveId>
```

Untyped errors keep the original `ERROR: <message>` single-line shape. A leading `ERROR [<CODE>]:` is the signal that one of the codes below is in play.

## Severity tiers — fix order at a glance

| Severity | Visual cue | Meaning | Operator response |
|----------|------------|---------|-------------------|
| **CRITICAL** | `:::danger` callout (red ⊘) | Persistent state corrupted or contract broken; a record / index is wrong, not just absent | Stop ingesting, repair the underlying state, then resume |
| **HIGH** | `:::caution` callout (orange ⚠) | Operator action required before the system can make progress; one run lost | Diagnose using the hint, fix the upstream cause, re-dispatch |
| **MEDIUM** | `:::note` callout (blue ℹ) | Informational — a race or transient issue handled gracefully | Inspect the persisted state with the suggested CLI, then continue |
| **LOW** | `:::tip` callout (green ✓) | Caller bug surfaced as a state-machine reject; system state is consistent | Fix the caller; no recovery needed on the testing-os side |

Severity is encoded by the **Starlight callout type** at the top of each code below — color is paired with the icon and the bolded `Severity:` title, so a color-blind operator gets the same fix-order signal from the icon + word as a sighted operator gets from the hue. WCAG AA contrast ratios for each callout variant are asserted by `scripts/check-severity-contrast.test.mjs`.

## Codes

### `RECORD_SCHEMA_INVALID`

:::danger[Severity: CRITICAL]
A persisted record file is on disk but fails the schema contract. The record is unusable until repaired or replaced.
:::

- **Class:** `RecordValidationError` (`packages/ingest/validate-record.js`)
- **Trigger:** A persisted record fails AJV validation against `dogfood-record.schema.json`. Surfaced from `validateRecord()` during ingest.
- **Message shape:** `persisted record failed schema validation: <path> <ajv message>; <path> <ajv message>; …`
- **Hint:** `inspect the failing record against packages/schemas/src/json/dogfood-record.schema.json and fix the invalid fields before re-ingesting`
- **Operator action:**
  1. Open `packages/schemas/src/json/dogfood-record.schema.json` and locate each path from the message.
  2. The error object also carries `errors[]` with `{ path, keyword, message }` for programmatic inspection.
  3. Fix the upstream emitter (the source repo's submission builder), not the schema. Schema is a contract.
  4. Re-dispatch the source workflow to produce a clean record.

### `DUPLICATE_RUN_ID`

:::note[Severity: MEDIUM]
A TOCTOU race resolved correctly — the first writer won and the system is consistent. This is informational; the second writer's attempt was correctly refused.
:::

- **Class:** `DuplicateRunIdError` (`packages/ingest/persist.js`)
- **Trigger:** `writeRecord` lost a TOCTOU race for the same canonical record path. Two concurrent writers tried to persist the same `run_id`; the first won.
- **Message shape:** `duplicate run_id: <run_id> — another writer won the race for <path>`
- **Hint:** `a run with this id already exists — use a fresh run id or \`swarm runs\` to inspect the existing one`
- **Carries:** `runId`, `path`
- **Operator action:**
  - In ingest: this is informational — the first writer succeeded, the system is consistent. Re-running the source workflow with a fresh `run_id` produces a new record.
  - In swarm: `swarm runs` lists existing runs by id. Either re-dispatch with a fresh id or accept the existing record.

### `ISOLATION_FAILED`

:::caution[Severity: HIGH]
Isolation was requested but could not be granted. The dispatch is refused (no silent fallback), and operator action is required to either clear the worktree state or re-dispatch without `--isolate`.
:::

- **Class:** `IsolationError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `--isolate` was requested on a `swarm dispatch` but `createWorktree()` failed. Pre-fix, dispatch silently fell back to running the agent in the main repo; isolation is now a contract — only valid responses are "isolated" or "loud failure".
- **Message shape:** the underlying worktree error wrapped with the explicit isolation context. Inspect `e.cause.message` for the git-level reason.
- **Hint:** `run \`git worktree list\` to inspect existing worktrees, or re-dispatch without --isolate`
- **Operator action:**
  1. `git worktree list` from the repo root to see what's already attached.
  2. `git worktree prune` to clean stale references; `git worktree remove <path>` to clear specific entries.
  3. Re-dispatch with `--isolate`, or drop `--isolate` if isolation is not required for this run (accepting the shared-workspace risk).

### `COLLECT_UPSERT_FAILED`

:::danger[Severity: CRITICAL]
A wave is now in a half-written state: artifact rows + file_claims + agent state transitions committed, but the findings upsert and wave-status UPDATE did not. The control-plane DB is internally inconsistent until you re-run `swarm collect` for this wave.
:::

- **Class:** `CollectUpsertError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `swarm collect`'s findings upsert transaction threw. Common underlying causes: SQLite `busy_timeout` exhaustion, fingerprint UNIQUE collision, prepared-statement crash. The artifact rows + file_claims + agent state transitions had already committed; the wave-status UPDATE had not.
- **Message shape:** structured wrapper with `e.cause.message` carrying the SQLite-level reason.
- **Hint:** `wave <id> has artifacts persisted but findings missing — inspect with \`swarm status\`, then re-run \`swarm collect\` once the underlying SQLite issue is resolved (busy_timeout or fingerprint UNIQUE collision)`
- **Carries:** `waveId`, `findingsAttempted`, `cause`
- **Operator action:**
  1. `swarm status` to confirm the wave is in a half-written state (artifacts present, findings missing).
  2. Diagnose the underlying SQLite issue from `Caused by:`. `busy_timeout` usually means another process holds the DB; check for stuck `swarm` processes. UNIQUE collision usually means the fingerprint algorithm matched an existing row — check `swarms/control-plane.db` for the colliding finding.
  3. Re-run `swarm collect` for the same wave once resolved. The outer wrapper is idempotent at the upsert level.

### `STATE_MACHINE_<KIND>` — `BLOCKED`, `TERMINAL`, `INVALID`

:::tip[Severity: LOW]
The state machine refused an illegal transition; persistent state is consistent. `BLOCKED` is operator-fixable (override or clear the dependency); `TERMINAL` and `INVALID` are caller bugs — fix the calling code, not the state machine.
:::

- **Class:** `StateMachineRejectionError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `transitionAgent()` rejected a state-machine transition. The `kind` field discriminates *why*:
  - **`STATE_MACHINE_BLOCKED`** — the transition is legal in the abstract but blocked by a guard (e.g. dependencies not met, override required). Operator's problem.
  - **`STATE_MACHINE_TERMINAL`** — the agent is in a terminal state (`complete`, `rejected`, etc.) — no transitions allowed. Caller bug — something tried to advance an already-finished agent.
  - **`STATE_MACHINE_INVALID`** — the transition is missing from the `TRANSITIONS` table. Legitimate disallowed transition (e.g. `idle → complete` skipping `running`).
- **Message shape:** `Illegal transition <from> → <to>: <reason>` with explicit kind in `e.code`.
- **Hint:** `e.hint` is set per-kind by the throwing site (e.g. "use `swarm override` to force …" for BLOCKED, "this agent is already complete; check why the caller tried to re-advance it" for TERMINAL).
- **Carries:** `kind`, `from`, `to`, `agentRunId`, `allowedTransitions[]` (legal `to` set from the current `from`).
- **Operator action:**
  - **BLOCKED:** look at the `Next:` hint — usually points at an override flag or a missing prerequisite.
  - **TERMINAL:** the agent is done; the bug is upstream. Inspect the caller for a re-advance loop.
  - **INVALID:** check `allowedTransitions[]` for what the state machine *will* accept from this `from`. Either reroute the call or, if the transition should be legal, file a finding to add the edge to `TRANSITIONS`.

## Cross-references

- Hard Gate B (Errors): structured shape (code/message/hint), exit codes for CLI, no raw stacks. See [README threat model](https://github.com/dogfood-lab/testing-os#threat-model).
- The state machine these errors come out of: [State Machines](../state-machines/).
- Where rejected records land when ingest throws `RECORD_SCHEMA_INVALID` or `DUPLICATE_RUN_ID`: `records/_rejected/` ([Beginner's Guide → Investigating a failure](../beginners/#investigating-a-failure)).
