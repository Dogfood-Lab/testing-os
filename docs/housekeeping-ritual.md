# The Housekeeping Ritual

> **Standing authority.** Director directive, 2026-07-18: *"you have the authority to delete as needed for housekeeping. Pay down as needed, and make sure that there's a protocol to prevent this from happening again in the future."* This document is that protocol. It exists because two debt piles were found frozen with no paydown schedule (the 256-entry grandfathered pin manifest at 0 drained after two release cycles, and 4 stale allowlist exemptions that outlived their reason) — the pattern to prevent is *debt that accumulates because no ritual ever touches it*.

## Standards compliance (.claude/rules/workflow-standards.md)

| Standard | Score | Evidence |
|---|---|---|
| PIN_PER_STEP | 2 | Every step names its exact command and its oracle; no model calls are involved, so the replayable unit is the command line itself, stated per step. |
| ANDON_AUTHORITY | 2 | The ritual runs gates bare; any red gate halts the session's other work until resolved or lawfully dispositioned — step 2's own text forbids proceeding past a red. |
| NAMED_COMPENSATORS | 2 | Compensators table below covers every irreversible action this ritual performs, each with the undo command and an owner. No skip — deletions are in scope. |
| DECOMPOSE_BY_SECRETS | 2 | Steps are grouped by the surface that changes together (environment, exemption registries, the frozen manifest, brief corpus, ledger, fleet) — a change to one step's mechanism does not ripple into the others. |
| UNCERTAINTY_GATED_HUMANS | 2 | The three Director gates are named inline (threshold raises, fleet reactivation, operator-note authoring), each framed contrastively when raised ("the ritual would normally X; this case differs because Y"). |
| EXTERNAL_VERIFIER | 2 | The executor never self-certifies: the verifiers are the deterministic gates (drift, pins, `npm run verify`) plus CI's cross-platform legs, none of which read the executor's claims. |

## When it runs

- At the **start of every swarm session** on this repo, before new work is dispatched.
- Immediately **after every release** (the exit-ramp rule ships waypoints with a queued tail — the ritual is where the tail gets serviced).

## The steps

**1. Environment preflight.** `node packages/dogfood-swarm/cli.js doctor`, then check what doctor does not yet cover: disk free on the repo volume, `swarms/control-plane.db` + WAL sidecar size, wave-brief bloat under `swarms/<run-id>/` (precedent: 82 MB of briefs accumulated unnoticed), and stranded worktrees (`swarm clean <run-id>` dry-run). *Open item: absorb these into `swarm doctor` itself (the claude-guardian question — see HANDOFF 2026-07-18); until that lands, run them by hand.* Done when: doctor exits 0 and no check is silently skipped.

**2. Staleness sweep — delete what exempts nothing.** Run `node scripts/check-doc-drift.mjs` bare. Every `stale allowlist entry` warn is a deletion under standing authority: remove the entry, re-run the gate, confirm it stays green (the file is now under full enforcement — that is the point). Same for `unused_allow_entries` from `node scripts/check-finding-regression-pins.mjs --json`. A red gate here halts the session until resolved. Done when: both gates exit 0 with zero staleness warns.

**3. Grandfathered paydown — drain at least 5 per session.** The 256-entry manifest (`scripts/grandfathered-pins.json`) only ever shrinks: for each id in the tranche, either author the genuine declared pin (`/** @pins F-… */` on a real red-able test) or establish the id as a removable orphan, then remove the entry and recompute `EXPECTED_GRANDFATHER_MANIFEST_HASH` **in the same commit** (the recompute command lives in that constant's own doc comment; the gate hard-fails any manifest edit without it). Progress is public: the roadmap artifact's `grandfathered_drain` section and the dashboard's drain meter. Cross-check first — `declared_ids ∩ manifest` (2026-07-18 baseline: 0 free drains; every drain is authored work). Done when: ≥5 drained or the session's written rationale for fewer.

**4. Brief diet check.** Measure the newest wave's briefs against `WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES` (750 KB, `commands/dispatch.js`). Over the line → diet the brief content before the next audit wave. **Never raise the threshold to accommodate growth** — that is a Director decision, framed contrastively, not a ritual step.

**5. Ledger hygiene.** `swarm findings <run-id> --status=deferred` — every deferred item must still carry a live reason (its waiting-condition not yet met). A deferred item whose condition has been met gets reopened and dispositioned. If the ledger moved this session: `swarm roadmap compile <run-id>` so the published artifact tells the truth.

**6. Fleet glance.** Read the dashboard's stale count (baseline 2026-07-18: 12 of 26 surfaces stale ~4 months). Record the trend in HANDOFF. Fleet reactivation is **scheduled work the Director sequences** (the swarm is being built up precisely to test those repos next) — the glance keeps the number visible, not actioned unilaterally.

## Compensators (no skip — deletions are irreversible tool calls)

| Action | Undo | Post-rollback state | Owner |
|---|---|---|---|
| Allowlist-entry deletion (drift patterns / pin allowlist) | `git revert <commit>` — entries live in git history | Exemption restored verbatim; gate loosens back | Coordinator |
| Manifest drain (grandfathered-pins.json + hash recompute) | `git revert <commit>` (entry + hash restore together — they travel in one commit by rule) | Id re-frozen, gate green again | Coordinator |
| Roadmap recompile | `swarm roadmap compile <run-id> --undo <sequence> --apply` | Prior sequence's pointer restored; artifact file remains on disk (T5: nothing rewrites) | Coordinator |
| Wave-brief / worktree cleanup (`swarm clean --apply`) | None — residue is regenerable, never unique state. Dry-run first is mandatory; junction-unlink discipline applies (unlink non-recursively before removal) | n/a | Coordinator |

## What this ritual never does

No scheduled/cron automation (workspace law: org repos stay manual/paths-gated — cadence is per-session, human-triggered). No raw DB writes (the lawful verbs cover every case). No authoring of `dogfood/roadmap-notes.json` (the Director's voice — offer, never author). No fleet-side pushes without Director sequencing.
