---
title: swarm history
description: Deep-audit verb for the wave_state_events transition chain — see who wrote what reason for each wave-level transition
sidebar:
  order: 6.6
---

`swarm history <wave-id>` renders the full `wave_state_events` transition chain for a wave. It is the read surface for the audit-row record written by every wave-level transition — including the override transitions that the recovery verbs ([revalidate, rewind, redrive](../recovery/)) write with their `--reason` text prefixed by the verb name.

## What it does

The verb is a read-only deep-audit primitive. It does not mutate. It calls `getWaveTransitionHistory(db, waveId)` (the same canonical query used by `swarm status` for the breadcrumb), renders the rows as a plain-ASCII fixed-column table, and exits.

Source: `packages/dogfood-swarm/commands/history.js`.

```text
Usage: swarm history <wave-id>
```

The single positional argument is the integer `waves.id`. There are no flags.

## Output shape

The first line names the wave (id, run_id, wave_number, phase, current status). Then a blank line, then either a fixed-column table of every transition, or a single `No transitions yet.` notice when the wave has had no state changes (the common state for a fresh `dispatched` wave whose first transition has not yet landed).

Example (abbreviated values for display; live output uses full IDs and ISO timestamps):

```text
Wave 42 (run abc, wave 3, phase health-a) — status: collected

FROM         TO           WHEN       REASON
----------------------------------------------------------
dispatched   failed       09:12:08   collect: 2 errors
failed       collected    09:14:33   revalidate: fix typos

(2 transitions)
```

The columns are:

| Column | Width | Content |
|--------|------:|---------|
| FROM | 12 | `from_status` of the transition (left-padded) |
| TO | 12 | `to_status` of the transition |
| WHEN | 19 | `created_at` timestamp from the row |
| REASON | 60 | `reason` column; `(none)` rendered for null; long reasons truncated with `...` |

The output is plain-ASCII — no ANSI, no emoji, no Unicode glyphs — so the table renders identically under CI plaintext logs, screen-readers, and Markdown. Same visual discipline as the `D-STRUCT-001` frames in `swarm status`.

## The breadcrumb in `swarm status`

`swarm status <run-id>` surfaces a one-line breadcrumb pointing at `swarm history` when the current wave has "interesting history." The breadcrumb does NOT render for steady-state common-case waves (single `dispatched → collected` transition); it renders only when the audit chain has something worth showing.

Source: `summarizeWaveHistory` in `packages/dogfood-swarm/commands/status.js`.

A wave has interesting history when any one of these is true:

1. **Any override transition out of a BLOCKED source status.** Currently `failed → anything`; this is the canonical `swarm revalidate --apply` audit row.
2. **Any rewind transition** (`to_status === 'aborted_for_rewind'`). Rewinds are always operator-initiated through a destructive verb and should never blend into steady-state status output.
3. **More than one transition row recorded.** A legitimate happy path (`dispatched → collected → advanced`) is fine but worth a hint that the audit chain has multiple steps.

When interesting, the breadcrumb shows the transition count, optionally an excerpt of the most recent reason text (truncated to 60 characters if longer), and a pointer at `swarm history <wave-id>`. Example:

```text
  History: 2 transitions — see `swarm history 42`
```

When a `--reason` is present (e.g. after `swarm revalidate --apply`), it appears in parentheses between the count and the pointer: `2 transitions (last reason: "fix typos") — see ...`. The pointer is the canonical route from natural scan-mode reads of `swarm status` into the deep-audit verb.

## Error cases

| Input | Behavior | Exit code |
|-------|---------|----------|
| No arguments | Prints `Usage: swarm history <wave-id>` to stderr | `1` |
| Non-integer wave id (e.g. `abc`) | Prints `history: wave id must be a positive integer (got "abc")` to stderr | `1` |
| Negative or zero wave id | Same error class (positive integer required) | `1` |
| Unknown wave id (no row in `waves`) | Prints `history: wave not found: <id>` to stderr; the underlying error carries `code: 'WAVE_NOT_FOUND'` | `1` |
| `--help` / `-h` | Prints usage and exits clean | `0` |

The verb does NOT consult `agent_state_events`. That table holds per-agent_run transitions; `swarm history` is wave-scoped because the wave is the natural unit of recovery (the recovery verbs operate at the wave granularity even when they touch many agent_runs underneath). A future `swarm history --agents` or a parallel `swarm agent-history` verb is the right extension if operators surface a need for per-agent audit drill-down.

## Cross-references

- The recovery verbs whose `--reason` text shows up in this verb's REASON column: [Recovery — The Three R's](../recovery/)
- Wave-level state machine and the `BLOCKED_STATUSES` enum: [State Machines](../state-machines/)
- Per-verb quick reference for `swarm history` and all 27 sibling verbs: [swarm CLI reference](../cli-reference/)
