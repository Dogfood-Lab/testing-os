---
title: Read Model Reference
description: The served consumer read API — every index, badge, and record field a downstream repo may fetch, with exact shapes and freshness semantics.
sidebar:
  order: 7
---

testing-os publishes a **read model**: a set of generated JSON artifacts under `indexes/`
(plus the dated record files under `records/`) that downstream repos and tools consume
directly over `raw.githubusercontent.com`. This page is the contract for that surface — the
exact shape of every served file, and the record fields a consumer may read.

These files are **generated, never hand-edited**. `indexes/latest-by-repo.json`,
`failing.json`, and `stale.json` are rebuilt by [`@dogfood-lab/ingest`](../architecture/)
(`packages/ingest/rebuild-indexes.js`) on every accepted submission; `indexes/trends.json`
and `indexes/badges/*.json` are emitted by [`@dogfood-lab/portfolio`](../intelligence-layer/)
(`packages/portfolio/generate.js` + `lib/generate-badges.js`). The `ingest.yml` workflow
commits the regenerated indexes back to `main`, so the raw URLs below always reflect the
latest accepted corpus. The source of truth for every shape is the code that writes it —
this page documents the **shipped** shapes only.

## Raw URL pattern

Fetch any served artifact at
`https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/<file>` — for example,
`.../main/indexes/latest-by-repo.json` or `.../main/indexes/badges/_aggregate.json`. Paths
inside `indexes/` and `records/` are part of the public API — they do not move without a
deliberate contract change.

## `indexes/latest-by-repo.json`

The newest **accepted** record per `repo` → `product_surface`. Only records whose
`verification.status === "accepted"` are counted; "newest" is decided by
`timing.finished_at` compared numerically (an unparseable timestamp sorts oldest).

```json
{
  "<org>/<repo>": {
    "<surface>": {
      "run_id": "run-…",
      "verified": "pass",
      "verification_status": "accepted",
      "finished_at": "2026-06-30T12:00:00Z",
      "path": "records/<org>/<repo>/YYYY/MM/DD/run-….json"
    }
  }
}
```

`verified` is the central verdict (`pass` | `fail` | `blocked` | `partial`). `path` is the
repo-root-relative, forward-slash path to the full record — resolve it against the raw URL
prefix above to fetch the record itself.

## `indexes/failing.json`

The subset of `latest-by-repo` entries whose latest accepted verdict is **not** `pass`. An
array, one object per failing repo+surface:

```json
[
  {
    "repo": "<org>/<repo>",
    "surface": "cli",
    "run_id": "run-…",
    "verified": "fail",
    "finished_at": "2026-06-30T12:00:00Z",
    "path": "records/…/run-….json"
  }
]
```

A repo+surface appears here only if it has a latest **accepted** record; a repo that has
never submitted, or whose latest was rejected, is absent (not "failing").

## `indexes/stale.json`

Repo+surfaces whose latest accepted record is older than the rebuild's `staleDays` window
(default **30**), or whose `finished_at` is missing/unparseable (treated as stale so it is
never silently dropped). An array:

```json
[
  {
    "repo": "<org>/<repo>",
    "surface": "cli",
    "run_id": "run-…",
    "finished_at": "2026-04-01T12:00:00Z",
    "age_days": 90,
    "path": "records/…/run-….json"
  }
]
```

`age_days` is `null` when `finished_at` could not be parsed. This index reflects the
rebuild's fixed default window; per-surface operator thresholds are applied by the portfolio
and badge layers instead (see [Freshness](#freshness-semantics)).

## `indexes/trends.json`

Per-repo, per-surface run history and regression signal, keyed `repo` → `surface`. Built by
scanning the full dated `records/` tree (the `_rejected/` subtree is excluded); only accepted
records count toward the verdict trend.

```json
{
  "<org>/<repo>": {
    "<surface>": {
      "history": [
        { "run_id": "run-…", "verified": "pass", "finished_at": "…" }
      ],
      "current":  { "run_id": "run-…", "verified": "pass", "finished_at": "…" },
      "previous": { "run_id": "run-…", "verified": "fail", "finished_at": "…" },
      "regressed": false,
      "recovered": true,
      "pass_rate": 0.8,
      "pass_rate_sample": 5,
      "pass_rate_window_days": 30,
      "latest_path": "records/…/run-….json"
    }
  }
}
```

`history` is ordered oldest → newest. `regressed` is `true` when `previous` was `pass` and
`current` is `fail`; `recovered` is the inverse. `pass_rate` is the fraction of passing runs
within `pass_rate_window_days` (`null` when the window holds no runs); `pass_rate_sample` is
the run count in that window. `current`/`previous` are `null` when fewer than that many
accepted runs exist.

## `indexes/badges/<org>--<repo>--<surface>.json`

One [shields.io endpoint](https://shields.io/badges/endpoint-badge) object per repo+surface,
plus a fleet-wide rollup at `indexes/badges/_aggregate.json`. Filenames sanitize every
filesystem-hostile character to `-` and join `org`, `repo`, `surface` with `--`
(e.g. `dogfood-lab--testing-os--cli.json`).

```json
{
  "schemaVersion": 1,
  "label": "dogfood",
  "message": "pass",
  "color": "brightgreen"
}
```

`message`/`color` are one of:

| Status  | message | color        | When                                                        |
|---------|---------|--------------|-------------------------------------------------------------|
| pass    | `pass`  | `brightgreen`| latest verdict `pass` **and** within the freshness window   |
| fail    | `fail`  | `red`        | latest verdict `fail` (reported regardless of age)          |
| stale   | `stale` | `orange`     | window exceeded, or `finished_at` unparseable, or a non-pass/non-fail verdict on a fresh record |

Staleness wins over a passing verdict — a green pill backed by a months-old run is a lie the
consumer cannot see through — but a **fail is never masked** by staleness. `_aggregate.json`
reports the **worst** status across the fleet (`fail` > `stale` > `pass`), so a single embedded
badge answers "is everything green." Embed a per-surface pill with
`https://img.shields.io/endpoint?url=<RAW_BADGE_URL>`, where `<RAW_BADGE_URL>` is the
raw.githubusercontent URL to `indexes/badges/<org>--<repo>--<surface>.json` (e.g. the
`dogfood-lab--testing-os--cli.json` badge once testing-os dogfoods itself).

A repo that has not yet submitted an accepted record has no badge file; the shields endpoint
then renders its own inaccessible/missing state until the first record lands — which is the
honest signal, not a false green.

## Freshness semantics

Two freshness windows exist and they are intentionally distinct:

- **Index staleness** (`indexes/stale.json`) uses the rebuild's fixed `staleDays` default
  (**30**).
- **Badge and portfolio staleness** honor the per-surface thresholds declared in the repo's
  policy under `surfaces.<surface>.freshness`:

  ```yaml
  surfaces:
    cli:
      freshness:
        max_age_days: 14
        warn_age_days: 7
  ```

  The nested `freshness:` block is the schema-conformant shape and is read **first**; a legacy
  flat `max_age_days` / `warn_age_days` at the surface level remains a fallback
  (fix `F-508a5675`). When neither is set, the defaults are `max_age_days: 30` /
  `warn_age_days: 14`. The badge generator uses a 30-day window by default; the portfolio
  report (`reports/dogfood-portfolio.json`) applies each surface's `max_age_days` and lists
  overruns in its `stale` array, with unparseable timestamps routed to `unknown_freshness`
  rather than silently counted as stale.

## Record fields a consumer may read

Records live at `records/<org>/<repo>/YYYY/MM/DD/run-*.json` (rejected records under
`records/_rejected/…`). The consumer-relevant fields:

- **`verification.status`** — `accepted` | `rejected`. There is no pending state in a
  persisted record.
- **`verification.schema_valid` / `policy_valid` / `provenance_confirmed`** — the three gate
  outcomes behind the status.
- **`verification.rejection_reasons`** — machine-readable reasons; empty when accepted.
- **`verification.warnings`** — accepted-with-warning notes from warn-severity policy rules. A
  record can be `accepted` **and** carry warnings; a populated `warnings` array means the
  submission passed but tripped an advisory rule (the accepted-with-warning channel).
- **`overall_verdict.proposed` / `verified`** — the source-proposed and the central
  post-verification verdict (`pass` | `fail` | `blocked` | `partial`). Consumers should trust
  `verified`, not `proposed`.
- **`overall_verdict.downgraded` / `downgrade_reasons`** — set when the verifier lowered the
  proposed verdict.
- **`timing.started_at` / `finished_at` / `duration_ms`** — `finished_at` is the field every
  freshness computation above keys on.
- **`scenario_results[]`** — per-scenario `scenario_id`, `product_surface`, `verdict`,
  `step_results`, and `evidence`. This is the granular proof behind the top-level verdict.

For how these fields are produced and enforced, see [Contracts](../contracts/) and the
[Operating Guide](../operating-guide/).
