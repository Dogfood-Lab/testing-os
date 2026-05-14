---
title: State Machines
description: The three distinct status vocabularies in testing-os and which layer each one operates at
sidebar:
  order: 6
---

testing-os has **four distinct state machines** that operate at different layers. They look adjacent — several of them reuse words like `accepted`, `complete`, or `failed`, and the same operator may touch all four in a single debugging session — but conflating them produces wrong fixes. This page names each one explicitly and links to its operating context.

## At a glance

| State machine | Layer | Lives in | What it governs |
|---------------|-------|----------|-----------------|
| **Record classification** | Ingest | `packages/ingest/`, `packages/portfolio/` | Per-record persistence outcome and per-repo freshness rollup |
| **Finding review** | Intelligence | `packages/findings/` | Human review of derived lessons before they become patterns |
| **Wave classification** | Swarm | `packages/dogfood-swarm/` | Cross-wave dedup of findings within a dogfood-swarm run |
| **Agent run lifecycle** | Swarm | `packages/dogfood-swarm/lib/state-machine.js` | Per-agent control-plane transitions and the BLOCKED override path |

These do not share a state; a record being `accepted` says nothing about a finding being `accepted`, and a finding being `accepted` says nothing about a wave classifier seeing it as `recurring` vs `unverified`. An `agent_run` being `complete` says nothing about whether its findings have been promoted in the intelligence layer.

## 1. Record classification (ingest layer)

This is the first vocabulary you meet. It governs what happens when a submission arrives at testing-os.

### `verification.status` — per-record, written by the verifier

Two terminal states, written into every persisted record:

- **`accepted`** — schema valid, provenance confirmed, policy satisfied. Persisted to `records/<org>/<repo>/YYYY/MM/DD/`. Counts toward `latest-by-repo.json`.
- **`rejected`** — at least one verifier check failed. Persisted to `records/_rejected/<org>/<repo>/YYYY/MM/DD/` with `verification.rejection_reasons[]`. Excluded from `latest-by-repo.json`.

```text
                +-------------------+
[submission] -->| Verifier (7 step) |
                +---------+---------+
                          |
              all 7 pass  |  any check fails
                  +-------+-------+
                  v               v
            [ accepted ]     [ rejected ]
            (terminal)       (terminal)
```

See [Architecture → Verifier Pipeline](../architecture/#verifier-pipeline-7-steps).

### Portfolio buckets — per-repo, per-surface rollup

The portfolio generator (`packages/portfolio/generate.js`) sorts every entry in `latest-by-repo.json` into one of:

- **healthy** — within freshness threshold (default 30 days)
- **`stale`** — `freshness_days > max_age_days`. Re-run the dogfood workflow.
- **`unknown_freshness`** — `record.timing.finished_at` was unparseable; `computeFreshnessDays` returned `null`. The entry silently bypassed the `stale` check before this bucket existed (F-246817-005). Investigate the source repo's submission emitter.
- **`missing`** — repo has a policy file but no record in the index. Run the workflow at least once.

### `rebuild-indexes` per-record outcomes

`packages/ingest/rebuild-indexes.js` returns four arrays for each rebuild call: `accepted`, `rejected`, `corrupted`, `skipped`.

- **`accepted` / `rejected`** — record loaded cleanly and routed by its `verification.status`.
- **`corrupted`** — `JSON.parse` failed on the record file. The rebuild continues but the record is excluded from all indexes. The stderr line `[rebuild-indexes] corrupted record skipped: <path> — <error>` is the operator signal.
- **`skipped`** — record loaded but missing `run_id` (cannot be indexed safely).

`corrupted` is the one operators most often miss because it produces no test failure and the stderr line vanishes from old CI logs.

#### Recovery procedure for `corrupted`

1. Get the path from `corrupted[].path` (or grep the rebuild stderr).
2. Open the file. Either:
   - **Repair** — fix the JSON if the cause is obvious (truncation, encoding bleed) and re-run `node packages/ingest/rebuild-indexes.js`.
   - **Remove** — if the record cannot be salvaged, identify it by `run_id` (from the path), re-dispatch the source workflow to produce a clean record, then delete the corrupted file and rebuild.
3. Verify the record now appears in `indexes/latest-by-repo.json`.

## 2. Finding review (intelligence layer)

This is a different vocabulary on different objects. Findings are derived lessons — extracted from accepted records by the derivation engine — and they move through their own lawful state machine before they qualify as portfolio memory.

### Status lifecycle

```text
   [ candidate ]
        |
   review |  reject
        v        \
   [ reviewed ]   \
        |          \
   accept |         v
        v        [ rejected ]
   [ accepted ] --invalidate--> [ invalidated ]

   reopen: rejected --> candidate
   reopen: accepted  --> reviewed
```

- **`candidate`** — machine- or human-created, not yet reviewed.
- **`reviewed`** — looked at by a human, may need refinement.
- **`accepted`** — approved as trustworthy reusable learning. Counts toward pattern derivation.
- **`rejected`** — declined with explicit reason; never promoted.
- **`invalidated`** — previously `accepted`, now declared no longer true (source truth changed). Excluded from advice queries; retained for history.

Available actions: `accept`, `reject`, `review`, `edit`, `merge`, `reopen`, `invalidate`. Every action is logged in an append-only event log.

See [Intelligence Layer → Review Workflow](../intelligence-layer/#review-workflow).

**The collision with record classification is purely lexical.** A finding being `accepted` says nothing about the underlying record's `verification.status`. A finding can be derived from a record whose own `verification.status` is `rejected` (e.g. a finding that says "these submissions keep being rejected for the same reason").

## 3. Wave classification (swarm layer)

This is the third vocabulary, and it operates on a still-different object: each finding emitted by an agent inside a `dogfood-swarm` wave.

The classifier (`packages/dogfood-swarm/lib/fingerprint.js`) compares each wave's findings against the prior wave's fingerprints and emits one of:

```text
   prior fingerprints + current fingerprints + scope
                         |
                         v
        +----------------+-----------------+
        |                |                 |
  not in prior       in both        in prior, NOT
        |                |          in current
        v                v                 |
     [ new ]      [ recurring ]            v
                                  +--------+--------+
                                  |                 |
                            scope covered     scope did NOT
                                  |           cover
                                  v                 |
                              [ fixed ]             v
                                            [ unverified ]
                                            (carries fwd)

   coordinator terminal states:
     [ deferred ]   [ rejected ]
```

- **`new`** — first time this fingerprint appears.
- **`recurring`** — same fingerprint seen in a prior wave AND in current.
- **`fixed`** — fingerprint was in prior, NOT in current, AND the current wave's scope covered the finding's path. Requires positive evidence that the agent actually looked.
- **`unverified`** — fingerprint was in prior, NOT in current, BUT the current wave's scope did NOT cover the finding's path. We do not know whether the defect was fixed or simply not looked at. Carried into the next wave's prior map for re-evaluation.
- **`deferred` / `rejected`** — coordinator-assigned terminal states.

`unverified` is the wave-classifier's safe default: when no scope is supplied, all not-rediscovered prior findings are classified `unverified` rather than silently invented `fixed` verdicts. This is what shows up in your `swarm collect` digest as `unverified: <n>`.

**The collision with finding-review is exact.** `accepted` exists in both vocabularies; `rejected` exists in both vocabularies. They mean different things:

| Word | Finding review (intelligence) | Wave classification (swarm) |
|------|-------------------------------|------------------------------|
| `accepted` | Human approved as portfolio memory | (not a wave-classifier state) |
| `rejected` | Human declined with reason | Coordinator dropped this finding from the wave |

When a digest shows `new: 0, recurring: 0, fixed: 0, unverified: 3`, that says nothing about whether any of those 3 underlying findings have ever been promoted to `accepted` in the intelligence layer.

## 4. Agent run lifecycle (swarm layer)

This is the fourth vocabulary. It governs the per-agent rows in the swarm's SQLite control plane — every dispatched Claude-Code instance gets one `agent_runs` row, and that row moves through a strict state machine defined in `packages/dogfood-swarm/lib/state-machine.js`. The vocabulary is internal control-plane plumbing (operators interact with it indirectly through `swarm dispatch` / `swarm collect` / `swarm revalidate`), but the BLOCKED override path means it occasionally surfaces in audit logs and recovery sessions — operators need it named.

### The 8 canonical statuses

The header comment of `state-machine.js` documents the full set:

- **`pending`** — created, not yet dispatched.
- **`dispatched`** — prompt generated, waiting for agent to start.
- **`running`** — agent actively working.
- **`complete`** — agent finished successfully (terminal — no outbound transitions).
- **`failed`** — agent crashed or produced no output (redispatchable).
- **`timed_out`** — exceeded timeout policy (deterministic, not guessed; redispatchable).
- **`invalid_output`** — output failed schema validation (BLOCKED — manual fix only, no auto-retry).
- **`ownership_violation`** — agent touched files outside its domain (BLOCKED — manual fix only, no auto-retry).

### The transition table

The legal transitions are an explicit map in `state-machine.js` (the `TRANSITIONS` object, lines 35–44). Any transition not in this map throws a `StateMachineRejectionError`:

```text
pending             → dispatched
dispatched          → running | complete | failed
                    | timed_out | invalid_output
                    | ownership_violation
running             → complete | failed | timed_out
                    | invalid_output
                    | ownership_violation
complete            → (terminal — no outbound)
failed              → dispatched (redispatch)
timed_out           → dispatched (redispatch)
invalid_output      → (blocked — override only)
ownership_violation → (blocked — override only)
```

The error type carries a `kind` field — `TERMINAL`, `BLOCKED`, or `INVALID` — so calling code (and CLI top-level handlers) can render a status-class-specific actionable hint. Callers must not attempt to short-circuit transitions; `transitionAgent` is the single audit-logged seam.

### The two BLOCKED statuses

Two statuses are members of `BLOCKED_STATUSES` (a `Set` declared at `state-machine.js:50`):

- `invalid_output` — produced output that failed the envelope schema or a legacy validator. The output is on disk; the gate refused it.
- `ownership_violation` — produced output whose `files_changed[]` lies outside the agent's frozen domain map.

Neither has any outbound entry in `TRANSITIONS`. Automatic retry is impossible by design — these failures are deterministic, not transient, and re-dispatching without operator review would either reproduce the violation or paper over real drift.

### The override path

The only way out of a BLOCKED status is the explicit override:

```text
transitionAgent(
  db, agentRunId, 'complete',
  reason, /* override */ true,
)
```

The override:

- Is **gated by the `BLOCKED_STATUSES` check** — passing `override=true` on a terminal status (`complete`) or any non-blocked transition does not bypass the normal `canTransition` law.
- **Requires `reason`** — `state-machine.js:106` throws `Error('Override requires a reason …')` on empty/missing reason.
- Records the transition through `executeTransition`, which writes the `agent_state_events` row with the operator's reason captured verbatim — preserves the audit trail (Stripe Ledger correction-event pattern).

### The CLI surface: `swarm revalidate`

Until recently this primitive had no operator-facing CLI surface. `swarm revalidate` exposes it lawfully:

```text
Usage: swarm revalidate <run-id>
  --reason "<text>"
  --domain=name:path
  [--domain=name:path ...]
  [--apply]
```

Behavior is dry-run by default; `--apply` is required to mutate; `--reason "<text>"` is mandatory. On full repair, the wave's `failed` status flips back to `collected` in the same SQLite transaction — partial repair (some agents repaired, others still BLOCKED) keeps the wave in `failed` deliberately. The recovery operating procedure is documented in [`swarms/PROTOCOL.md`](../../../../../swarms/PROTOCOL.md) under "Recovery from blocked agent_runs."

### The collision with other vocabularies

`complete` appears here and means "successfully terminated"; nothing in the agent_run lifecycle is the same as `accepted` in record-classification or finding-review. `failed` appears here as a redispatchable transient state — the same word appears on `waves.status` (set by `collect` when validation_errors > 0) but the **wave-level `failed` is the rollback target, not a redispatchable status**. The two operate at different scopes and `swarm revalidate` is the verb that bridges them: it repairs blocked `agent_runs` and, if every latest agent_run in the wave is then `complete`, also flips the wave's `failed` back to `collected` in the same transaction.

## Cross-references

- Record classification operations: [Architecture](../architecture/), [Operating Guide](../operating-guide/)
- Finding review operations: [Intelligence Layer](../intelligence-layer/)
- Agent-run recovery operations: [swarms/PROTOCOL.md `Recovery from blocked agent_runs`](../../../../../swarms/PROTOCOL.md)
- Error codes that surface from any of these layers (including `STATE_MACHINE_BLOCKED` / `_TERMINAL` / `_INVALID`): [Error Code Reference](../error-codes/)

### When validation fails (operator runbook)

If `swarm collect` reports blocked agents, see `swarm revalidate` (documented in [swarms/PROTOCOL.md](../../../../../swarms/PROTOCOL.md) under "Recovery from blocked agent_runs"). The verb is the canonical, audited path back from `invalid_output` / `ownership_violation` to `complete`; direct DB intervention is universally last-resort and leaves no audit trail.
