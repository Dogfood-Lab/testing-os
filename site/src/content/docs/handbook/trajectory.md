---
title: The trajectory layer
description: How a repo keeps progressing across swarm runs — the compiled roadmap artifact, the advisory attention list, operator notes with structural expiry, and the drain queue with owners and cadence.
sidebar:
  order: 6.8
---

A dogfood-swarm run ends; the next one, weeks later, starts cold. The trajectory
layer is how direction survives that gap **without becoming a stale plan** — this
repo's own operating record shows prose plans rotting in hours, not months, so the
layer is built on one rule:

> **The roadmap is compiled, never authored.** Every factual claim in it is a query
> against the control-plane database and git, executed at compile time. The only
> human-authored content is a small, typed, structurally-expiring set of operator
> notes. Nothing else survives on trust.

## The artifact

`swarm roadmap compile <run-id>` writes `dogfood/roadmap/<run-id>.json` and points
`dogfood/roadmap/latest.json` at it. One artifact per run; a recompile supersedes
with a new sequence number; history is never edited. The shape is governed by
`@dogfood-lab/schemas`' `dogfood-roadmap.schema.json`, and since the wave-43
vocabulary reconciliation (Amendment 3 of the pass contract) the **full
document** is validated in `npm run verify` — not just the `latest.json`
pointer, which for two waves was the only enforced sub-schema while the
full-document check sat loudly suspended pending the drain-cadence decision
(an earlier revision of this page claimed full validation during that window;
the confirming audit caught the overclaim). The two pre-reconciliation
artifacts and the deliberately `sequence`-less byte-identity mirror are
allowlisted **by name** — history is never rewritten to satisfy a gate — and
a missing artifact is *not applicable*, never a vacuous pass.

Compiled sections — all queries, regenerated on every compile:

| Section | Source |
|---|---|
| Open / deferred / approved queues | `findings` table, live statuses |
| Drain queue | two populations with **distinct entry shapes** (Amendment 3.2): the authored `drain_queue` is **runs-ordinal** (`id`, `owner`, `cadence_runs`, `runs_since_review`, `overdue`), matching the shipped `compileAuthoredDrainState`; `grandfathered_drain.outstanding` is **date-cadenced** (`id`, `owner`, `revalidate_by`), matching the frozen pin manifest's own fields. Each shape follows its live producer rather than one shared shape; entries past cadence surface first. |
| Recurrence stats | the same cross-run analytics `swarm trends` reads |
| Attention list | the advisory heuristic below |
| Operator notes | the one authored section, validated at compile |

## The attention list is advisory, and that is load-bearing

Per-file score = **relative churn** (change volume normalized by file size and age)
× **prior-finding recency and count** × **lane fragmentation** (how many distinct
domains touched the file). All three components come from evidence that process
and ownership signals out-predict static code metrics.

What it deliberately is **not**: a defect predictor, a gate, or a blame
assignment. Google deployed a validated bug-prediction algorithm company-wide and
measured no change in developer behavior — the only use that survived was passive
team-level hotspot reporting, which is exactly the role this list plays: the next
run's audit briefs open with it as *context*, and nothing enforces it.

## Operator notes: the only authored section

At most **seven** notes, each typed:

- `theme` — a direction worth holding ("the escaping discipline is the product").
- `open-question` — something a future run should answer, not assume.
- `invariant` — a property that must hold — and an `invariant` **must** carry
  `enforced_by`, a path to the gate or test that mechanically enforces it. The
  compiler verifies the path exists and refuses the note otherwise. A lesson
  without an enforcement pointer is not persisted as a lesson; long-horizon agent
  deployments show narrative corrections alone do not hold.

Every note carries `expires`. Today only an **ISO-8601 date** is honored — the
`<N runs>` shorthand the design envisioned is not yet implemented, and `expires`
values the compiler cannot parse as a date are treated as non-expiring (kept, with
that limitation disclosed in `error-codes.md`) rather than dropped. For a
date-valued note the compiler **drops it loudly once past** — listed as expired in
the compile output, never silently omitted. Only the near horizon is specific;
anything farther out belongs in an `open-question`, not a plan.

## Consumption is explicit

Nothing propagates silently between runs. Seeding a new run from the previous
roadmap is an explicit opt-in (`swarm init --seed-from-roadmap`), and the digest a
brief receives is bounded and injected at the top of the brief, where models
demonstrably attend to it. The full artifact stays on disk for anything that wants
to page deeper.

## What was refused, and why

The design is as much refusals as features, each grounded in the research and
production-system record reviewed in
[the pass dispatch](https://github.com/dogfood-lab/testing-os/blob/main/docs/trajectory-and-closure.dispatch.md):

- **No ML risk model** — simple transparent heuristics matched complex models in
  the defect-prediction literature, and the deployed-predictor record is a null
  result.
- **No auto-blame** — SZZ-style "which change caused this" attribution
  misattributes badly against developer-validated oracles.
- **No staleness bot, no auto-close** — the wrongful-closure record of stale
  bots is why closures here require declarations.
- **No unbounded memory** — suppression registries and memory stores accumulate
  into unaudited debt; everything here is bounded, decaying, or regenerated.
