---
title: State Machines
description: The three distinct status vocabularies in testing-os and which layer each one operates at
sidebar:
  order: 6
---

testing-os has **three distinct state machines** that operate at different layers. They look adjacent — each uses words like `accepted` and the same operator may touch all three in a single debugging session — but conflating them produces wrong fixes. This page names each one explicitly and links to its operating context.

## At a glance

| State machine | Layer | Lives in | What it governs |
|---------------|-------|----------|-----------------|
| **Record classification** | Ingest | `packages/ingest/`, `packages/portfolio/` | Per-record persistence outcome and per-repo freshness rollup |
| **Finding review** | Intelligence | `packages/findings/` | Human review of derived lessons before they become patterns |
| **Wave classification** | Swarm | `packages/dogfood-swarm/` | Cross-wave dedup of findings within a dogfood-swarm run |

These do not share a state; a record being `accepted` says nothing about a finding being `accepted`, and a finding being `accepted` says nothing about a wave classifier seeing it as `recurring` vs `unverified`.

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

## Cross-references

- Record classification operations: [Architecture](../architecture/), [Operating Guide](../operating-guide/)
- Finding review operations: [Intelligence Layer](../intelligence-layer/)
- Error codes that surface from any of these layers: [Error Code Reference](../error-codes/)
