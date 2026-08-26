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

### `CONTROL_PLANE_SCHEMA_CORRUPT`

:::caution[Severity: HIGH]
The on-disk `control-plane.db` has a `kv.schema_version` that is not a number at all — it was hand-edited or otherwise damaged, as opposed to merely being older or newer than your build. `openDb` refuses it **fail-closed**: it closes the handle and throws rather than operate on a DB whose schema it cannot identify.
:::

- **Class:** `ControlPlaneSchemaCorruptError` (`packages/dogfood-swarm/lib/errors.js`), thrown by `getSchemaVersion` and surfaced through `openDb` — `packages/dogfood-swarm/db/connection.js`. Carries `code: 'CONTROL_PLANE_SCHEMA_CORRUPT'`, so it renders through `renderTopLevelError` as the structured `ERROR [CONTROL_PLANE_SCHEMA_CORRUPT]:` envelope like the rest of the family.
- **Trigger:** `getSchemaVersion()` read a `schema_version` row from the `kv` table whose value fails `Number.isFinite` — e.g. `"abc"`, or any text `Number()` turns into `NaN`. Distinct from [`CONTROL_PLANE_SCHEMA_TOO_NEW`](#control_plane_schema_too_new) on purpose: the two conditions get separate codes so an operator is never told to "upgrade" a DB that is actually damaged, or to restore-from-backup a DB that is merely newer.
- **Not every junk value reaches this code.** `Number('')` is **`0`**, not `NaN` — finite — so an **empty** `schema_version` does *not* throw here; it reads as version 0 and takes the bootstrap path, and a whitespace-only `" "` coerces to `0` the same way. Do **not** generalize that to every coercible string: a value that parses to a **nonzero** finite number never reaches this code either, but it does not take the bootstrap path — it is treated as a real on-disk version and routed by magnitude. `"0x10"` parses to `16`, which sits above today's schema ceiling and throws [`CONTROL_PLANE_SCHEMA_TOO_NEW`](#control_plane_schema_too_new) instead: a damaged value masquerading as version skew, where that code's "upgrade your build" hint is the wrong remediation — run the inspect query below before believing it. This is the `Number('') === 0` trap that `F-b5fd9887` fixed one module over in `cross-run-analytics.js`. An earlier revision of this bullet listed `""` as a trigger — wrong; the revision that corrected it then filed `"0x10"` under the bootstrap path — also wrong. Both were caught by audits that ran the code instead of reading the prose.
- **Message shape:** `control-plane.db at <dbPath> has a corrupted kv.schema_version value: <rawValue> — expected a finite number.` — where `<rawValue>` is `JSON.stringify`'d, so a string value renders **quoted** (`"abc"`, not `abc`). That is deliberate: it makes a whitespace-only or empty-looking value visible instead of vanishing into the sentence.
- **Carries:** `rawValue` (the unparseable value as read from disk), `dbPath`, `hint`.
- **Hint:** `kv.schema_version is not a finite number — the control-plane.db is corrupted or was hand-edited, not merely older/newer. Restore control-plane.db from a known-good backup, or remove it to bootstrap a fresh one (only if this run's history is not needed) — do not hand-write schema_version without reading db/migrate.js's ledger first.`
- **Why it fails loud instead of coping (F-9587adda):** `Number('abc')` is `NaN`, and **every** comparison against `NaN` is false. A silent `NaN` therefore defeated *both* of `openDb`'s guards at once — the too-new refusal (`onDisk > SCHEMA_VERSION`) and the bootstrap gate (`onDisk === 0`) — so a corrupted DB sailed past the exact two checks written to stop it and got operated on as though its schema were understood. This is the ordinary NaN-poisoning shape with an unusually bad blast radius: not one guard bypassed, but a matched pair.
- **Recovery:**
  1. Inspect the value the error names: `sqlite3 swarms/control-plane.db "SELECT * FROM kv WHERE key='schema_version'"`.
  2. Restore `control-plane.db` from a known-good backup if this run's history matters.
  3. Only if it does not, delete the DB and let `openDb` bootstrap a fresh one.
  4. Do **not** hand-write `schema_version` back to a plausible-looking integer — read `db/migrate.js`'s migration ledger first, or you will claim a shape the DB does not have.

### `CONTROL_PLANE_SCHEMA_TOO_NEW`

:::caution[Severity: HIGH]
The on-disk `control-plane.db` was written by a **newer** `@dogfood-lab/dogfood-swarm` build than the one you are running. `openDb` refuses to operate on it **fail-closed** — it closes the handle and throws rather than risk silent corruption (a newer schema may have renamed/repurposed a column or added a `NOT NULL` column this older writer can't populate). No write happens; the DB is left untouched.
:::

- **Class:** `ControlPlaneSchemaTooNewError` (`packages/dogfood-swarm/lib/errors.js`), thrown by `openDb` — `packages/dogfood-swarm/db/connection.js`. Carries `code: 'CONTROL_PLANE_SCHEMA_TOO_NEW'`, the on-disk + build versions, and a `hint`, so it renders through `renderTopLevelError` as the structured `ERROR [CONTROL_PLANE_SCHEMA_TOO_NEW]:` envelope like the rest of the family (F4-CP-03 / F5-07 promoted it from the earlier untyped `throw new Error(...)`).
- **Trigger:** `openDb()` read `schema_version` from the DB's `kv` table and found it **greater than** the `SCHEMA_VERSION` this build understands. The shared `swarms/control-plane.db` is committed back to `main` by `ingest.yml`; an operator on an older checkout (or a stale CI cache) can open a DB that a newer `main` already migrated. The refusal fires **before** the create/upgrade/bootstrap path, fail-closed: `openDb` closes the handle and drops it from the pool before throwing, so no write happens against the unknown-newer shape.
- **Message shape:** `control-plane.db at <dbPath> is schema v<version> but this @dogfood-lab/dogfood-swarm build only understands v<SCHEMA_VERSION>. Pull the latest @dogfood-lab/dogfood-swarm before opening this DB.`
- **Carries:** `onDiskVersion`, `buildVersion`, `dbPath`, `hint`.
- **Hint:** `Pull the latest @dogfood-lab/dogfood-swarm so your build SCHEMA_VERSION >= the on-disk control-plane version. Do NOT hand-edit or delete the DB — its state is the newer build's correctly migrated state, not corruption.`
- **Recovery (the message + hint say it too):** this is **not** DB corruption and needs **no** manual DB surgery — the remedy is to upgrade the tool to match the DB:
  1. Pull the latest `main` / re-install `@dogfood-lab/dogfood-swarm` so your build's `SCHEMA_VERSION` is `>=` the on-disk version.
  2. Re-run the command. `openDb` will then take the normal create/upgrade path (and the [migration ledger](../contracts/#control-plane-schema-version--migration-ledger) will reconcile).
  3. Do **not** hand-edit `swarms/control-plane.db` or delete it to "fix" the version — that discards the newer migrated state the newer build wrote.

### `DISPATCH_RUN_NOT_FOUND`

:::caution[Severity: HIGH]
`swarm dispatch <run-id> <phase>` was invoked with a `run-id` that does not exist in the control plane. No wave is created; no agents are dispatched.
:::

- **Class:** `DispatchPreconditionError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `dispatch()` looked up `runs.id` and got no row. Either the run id is mistyped, or no `swarm init` has been run for this repo.
- **Message shape:** `Run not found: <run-id>`
- **Hint:** `check \`swarm runs\` for the correct run id, or \`swarm init <repo>\` to create a fresh run`
- **NDJSON event emitted before throw:** `dispatch_precondition_failed` with `code=DISPATCH_RUN_NOT_FOUND`, `runId`, `phase`, `correlation_id`.
- **Operator action:**
  1. `swarm runs` to list all known runs.
  2. If the run doesn't exist, `swarm init <repo-path>` to create it.

### `DISPATCH_DOMAINS_NOT_FROZEN`

:::caution[Severity: HIGH]
`swarm dispatch` refused because the domain map is still in DRAFT state. Domains must be frozen before dispatching to lock the ownership contract that `swarm collect` will enforce.
:::

- **Class:** `DispatchPreconditionError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `aredomainsFrozen(runId)` returned false and `--auto-freeze` was not passed.
- **Message shape:** `Domains are not frozen. Review and freeze before dispatching, or pass --auto-freeze.`
- **Hint:** `run \`swarm domains <run-id> --freeze\` after reviewing, or re-run dispatch with --auto-freeze`
- **NDJSON event emitted before throw:** `dispatch_precondition_failed` with `code=DISPATCH_DOMAINS_NOT_FROZEN`.
- **Operator action:**
  1. `swarm domains <run-id>` to inspect the current draft.
  2. `swarm domains <run-id> --freeze` to lock the map, OR re-run with `--auto-freeze`.

### `DISPATCH_NO_DOMAINS`

:::caution[Severity: HIGH]
`swarm dispatch` refused because the run has zero domains defined. There's nothing to dispatch.
:::

- **Class:** `DispatchPreconditionError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `getDomains(runId).length === 0`. Usually means `swarm init` produced no auto-detected domains and the operator hasn't added any manually.
- **Message shape:** `No domains defined for this run`
- **Hint:** `run \`swarm domains <run-id> --add <name> --globs "[...]"\` then --freeze`
- **NDJSON event emitted before throw:** `dispatch_precondition_failed` with `code=DISPATCH_NO_DOMAINS`.
- **Operator action:**
  1. `swarm domains <run-id> --add <name> --globs '["packages/foo/**"]'` to define at least one domain.
  2. `swarm domains <run-id> --freeze`.

### `DISPATCH_INVALID_PHASE`

:::caution[Severity: HIGH]
`swarm dispatch <run-id> <phase>` was invoked with a phase outside `AUDIT_PHASES ∪ AMEND_PHASES`. The dispatch is refused as a **pre-commit precondition** — no wave row, no `agent_runs` rows, and `runs.status` is left unchanged. Pre-fix, a phase typo slipped past every guard and `buildWave()` committed a DB state promising agents that never got prompts before a flat untyped `Unknown audit phase` error threw after the commit.
:::

- **Class:** `DispatchPreconditionError` (`packages/dogfood-swarm/lib/errors.js`) — same class as the other `DISPATCH_*` preconditions; `code` is part of the JSDoc union contract.
- **Trigger:** `dispatch()` checked `opts.phase` against `AUDIT_PHASES` and `AMEND_PHASES` (in `packages/dogfood-swarm/commands/dispatch.js`) before any DB mutation and found neither matched — i.e. a mistyped phase such as `helth-audit-a`.
- **Message shape:** `Unknown phase: <phase>`
- **Hint:** `valid phases: <AUDIT_PHASES ∪ AMEND_PHASES>` — currently `health-audit-a, health-audit-b, health-audit-c, stage-d-audit, feature-audit, health-amend-a, health-amend-b, health-amend-c, stage-d-amend, feature-execute`. When the thrown error carries no `.hint`, `renderTopLevelError` derives the same enumeration.
- **NDJSON event emitted before throw:** `dispatch_precondition_failed` with `code=DISPATCH_INVALID_PHASE`, `runId`, `phase`.
- **Carries:** `runId`, `phase`.
- **Operator action:**
  1. Re-invoke with a phase from the list above, e.g. `swarm dispatch <run-id> health-audit-a`.
  2. The control plane is untouched — no cleanup is needed before retrying.

### `DISPATCH_NO_AGENT_DOMAINS`

:::caution[Severity: MEDIUM]
Every domain in the run's frozen map is `ownership_class: 'shared'` — a shared zone is not an agent-bearing domain, so dispatching would create a wave with **zero** `agent_runs`. Refused as a pre-commit precondition; nothing is written.
:::

- **Class:** `DispatchPreconditionError` (`packages/dogfood-swarm/lib/errors.js`).
- **Trigger:** `dispatch()`'s pre-transaction sweep of the frozen domain map (`packages/dogfood-swarm/commands/dispatch.js`) finds no `owned` or `bridge` domain to become an agent.
- **NDJSON event emitted before throw:** `dispatch_precondition_failed` with `code=DISPATCH_NO_AGENT_DOMAINS`.
- **Operator action:** edit the domain map (`swarm domains <run-id> --edit/--add`) so at least one domain is `owned` (or `bridge`), re-freeze, then dispatch.

### `DISPATCH_WAVE_IN_FLIGHT`

:::caution[Severity: MEDIUM]
The run's latest wave is still `dispatched` or `collecting` — opening a new wave now would strand it mid-flight. Refused as a pre-commit precondition; nothing is written.
:::

- **Class:** `DispatchPreconditionError` (`packages/dogfood-swarm/lib/errors.js`).
- **Trigger:** `dispatch()`'s pre-transaction wave-status check (`packages/dogfood-swarm/commands/dispatch.js`) finds the newest `waves` row in a non-terminal collecting state.
- **NDJSON event emitted before throw:** `dispatch_precondition_failed` with `code=DISPATCH_WAVE_IN_FLIGHT`.
- **Operator action:** finish the in-flight wave first — `swarm collect <run-id> --all` (or `swarm resume <run-id>` if agents died) — then dispatch the next one. `swarm clean` mirrors this guard on `--apply` (`CLEAN_WAVE_IN_FLIGHT`).

### `CLI_INVALID_GLOBS_JSON`

:::note[Severity: MEDIUM]
The operator-supplied `--globs <JSON>` could not be parsed or has the wrong shape (not an array, empty array, non-string element). System state is unchanged; the command refused before mutating anything.
:::

- **Class:** `CliInvalidGlobsError` (`packages/dogfood-swarm/lib/errors.js`)
- **Trigger:** `swarm domains --add` / `--edit --globs <raw>` invoked with a `raw` value that:
  - is empty
  - fails `JSON.parse`
  - parses to a non-array
  - parses to an empty array
  - contains a non-string element
- **Message shape:** `--globs requires a JSON array of glob strings; <specific reason>`
- **Hint:** `pass --globs '["packages/foo/**"]' — wrap the JSON in single quotes so the shell preserves it, and use double quotes for each glob string`
- **Carries:** `received` (the raw input, possibly truncated), `cause` (the inner JSON.parse error message).
- **Operator action:**
  1. Re-invoke with shell-safe quoting: `--globs '["packages/foo/**", "packages/bar/**"]'`.
  2. On Windows PowerShell, escape inner double quotes or use the single-quote outer form per shell rules.

### `CLI_INVALID_THRESHOLD`

:::note[Severity: MEDIUM]
The operator-supplied `--threshold <value>` is not a non-negative integer. System state is unchanged; the command refused before running the gate rather than silently coercing the bad value to a number (which would disable or mis-set the gate).
:::

- **Class:** plain `Error` with `e.code = 'CLI_INVALID_THRESHOLD'` set in `parseVerifyFlags` — `packages/dogfood-swarm/cli.js`. Surfaced through the same top-level seam (`renderTopLevelError`) as `CLI_INVALID_GLOBS_JSON`.
- **Trigger:** `swarm verify --threshold <raw>` (space-form `--threshold N` or equals-form `--threshold=N`) invoked with a `raw` value that is not a non-negative integer — e.g. `foo`, `-1`, or a partially-numeric `3abc`. Both flag forms route through the same validator, so a typo like `--threshold=1O` (letter O) is rejected rather than silently becoming the strictest gate (`0`).
- **Message shape:** `--threshold expects a non-negative integer; got '<raw>'`
- **Hint:** `pass an integer >= 0, e.g. \`--threshold 0\` or \`--threshold=3\``
- **Carries:** `received` (the raw input).
- **Operator action:**
  1. Re-invoke with an integer `>= 0`: `swarm verify <run-id> --threshold 0`.
  2. A typo'd threshold exits non-zero by design — a CI gate keyed on `$?` will not mistake a malformed threshold for a passing run.

### `FINDING_ID_COLLISION`

:::caution[Severity: HIGH]
A second write attempted the same `finding_id` as a finding already written. The collision is refused fail-closed; the first finding remains on disk untouched. Pre-fix, the second write silently clobbered the first via atomic temp+rename — operator-invisible data loss.
:::

- **Class:** object-literal `{ code: 'FINDING_ID_COLLISION', findingId, error }` (in `writeFindings` errors array) AND `FindingIdCollisionError` class (in `writeFinding` singleton) — `packages/findings/derive/write-findings.js`
- **Trigger:** Two derivation rules generate the same `dfind-<repoSlug>-<lessonSlug>` for the same submission (the id generator does NOT yet discriminate by `rule_id`), and the resulting batch — OR two same-process singleton calls — try to write to the same path. The batch helper `writeFindings` collects collisions into `errors[]`; the singleton `writeFinding` throws.
- **Message shape:** `intra-batch finding_id collision: '<id>' already claimed by index <N>; refused write at index <M> to avoid silent clobber (D2B-008)` (batch) or `finding_id collision: '<id>' already written in this process; refused to silently clobber (D2B-008 / L3-001 family-seal)` (singleton).
- **Hint:** rename or skip the colliding finding before re-running `dogfood findings derive --write`. If two rules legitimately share a lesson slug, the structural fix is to differentiate them in `generateFindingId` (rule_id in the slug) — deferred to a follow-on wave.
- **Operator action:**
  1. Run `dogfood findings derive` (without `--write`) to see which rule pairs are colliding.
  2. Either skip the duplicate at the source rule, or extend the id generator to include `rule_id` in the slug.
  3. If a re-write is legitimate (e.g. after an intentional disk wipe in a test), call `resetSeenWrites(rootDir)` between the two calls.

### `PATTERN_ID_COLLISION`

:::caution[Severity: HIGH]
A second write attempted the same `pattern_id` as a pattern already written. Same silent-clobber data-loss class as `FINDING_ID_COLLISION`, now fail-closed.
:::

- **Class:** object-literal `{ code: 'PATTERN_ID_COLLISION', patternId, error }` (in `writePatterns` errors array) AND `PatternIdCollisionError` class (in `writePattern` singleton) — `packages/findings/synthesis/write-artifacts.js`
- **Trigger:** Two synthesis rules emit the same `dpat-<slug>` (cluster-key collision) and the resulting batch tries to write both, or two same-process singleton calls collide.
- **Message shape:** `intra-batch pattern_id collision: '<id>' already claimed by index <N>; refused write at index <M> to avoid silent clobber (D2B-008)` (batch) or singleton variant.
- **Hint:** same as `FINDING_ID_COLLISION` — fix the duplicating rule or wipe and re-run.
- **Operator action:** as above, for patterns.

### `RECOMMENDATION_ID_COLLISION`

:::caution[Severity: HIGH]
A second write attempted the same `recommendation_id` as a recommendation already written. Same silent-clobber data-loss class, fail-closed.
:::

- **Class:** object-literal `{ code: 'RECOMMENDATION_ID_COLLISION', recommendationId, error }` (batch) AND `RecommendationIdCollisionError` (singleton) — `packages/findings/synthesis/write-artifacts.js`
- **Trigger:** Two recommendation derivations emit the same `drec-<slug>`.
- **Message shape:** as above, with `recommendation_id` in the message.
- **Hint:** as above.
- **Operator action:** as above, for recommendations.

### `DOCTRINE_ID_COLLISION`

:::caution[Severity: HIGH]
A second write attempted the same `doctrine_id` as a doctrine already written. Same silent-clobber data-loss class, fail-closed.
:::

- **Class:** object-literal `{ code: 'DOCTRINE_ID_COLLISION', doctrineId, error }` (batch) AND `DoctrineIdCollisionError` (singleton) — `packages/findings/synthesis/write-artifacts.js`
- **Trigger:** Two doctrine derivations emit the same `ddoc-<slug>`.
- **Message shape:** as above, with `doctrine_id` in the message.
- **Hint:** as above.
- **Operator action:** as above, for doctrine.

### `FINDING_SCHEMA_INVALID`

:::danger[Severity: CRITICAL]
A finding payload failed `dogfood-finding.schema.json` validation BEFORE touching the filesystem. The write is refused fail-closed; no orphan file lands on disk.
:::

- **Class:** `FindingValidationError` (`packages/findings/derive/write-findings.js`)
- **Trigger:** `writeFinding` / `writeFindings` invoked with a finding object that fails AJV validation. Pre-fix, library-path writers had no schema gate (the CLI gated, but programmatic callers did not).
- **Message shape:** `finding failed schema validation (<finding_id>): <path> <message>; <path> <message>; …`
- **Hint:** inspect each path against `packages/schemas/src/json/dogfood-finding.schema.json` and fix the upstream emitter. Schema is a contract.
- **Carries:** `findingId`, `errors[]` (AJV-shaped `{ path, message }`).
- **Operator action:** same as `RECORD_SCHEMA_INVALID` — fix the emitter, not the schema.

### `PATTERN_SCHEMA_INVALID`

:::danger[Severity: CRITICAL]
A pattern payload failed `dogfood-pattern.schema.json` validation BEFORE touching the filesystem. Write refused; no orphan file.
:::

- **Class:** `PatternValidationError` (`packages/findings/synthesis/write-artifacts.js`)
- **Trigger:** `writePattern` / `writePatterns` invoked with a malformed pattern. Pre-fix, the synthesis writers had ZERO validation (not even CLI-side) — this was the worst gap of the family.
- **Message shape:** `pattern failed schema validation (<pattern_id>): <path> <message>; …`
- **Hint:** inspect against `packages/schemas/src/json/dogfood-pattern.schema.json` and fix the derivation rule.
- **Carries:** `patternId`, `errors[]`.
- **Operator action:** fix the derivation rule.

### `RECOMMENDATION_SCHEMA_INVALID`

:::danger[Severity: CRITICAL]
A recommendation payload failed `dogfood-recommendation.schema.json` validation BEFORE touching the filesystem. Write refused; no orphan file.
:::

- **Class:** `RecommendationValidationError` (`packages/findings/synthesis/write-artifacts.js`)
- **Trigger:** `writeRecommendation` / `writeRecommendations` invoked with a malformed recommendation.
- **Message shape:** `recommendation failed schema validation (<recommendation_id>): <path> <message>; …`
- **Hint:** inspect against the recommendation schema and fix the rule.
- **Carries:** `recommendationId`, `errors[]`.
- **Operator action:** fix the derivation rule.

### `DOCTRINE_SCHEMA_INVALID`

:::danger[Severity: CRITICAL]
A doctrine payload failed `dogfood-doctrine.schema.json` validation BEFORE touching the filesystem. Write refused; no orphan file.
:::

- **Class:** `DoctrineValidationError` (`packages/findings/synthesis/write-artifacts.js`)
- **Trigger:** `writeDoctrine` / `writeDoctrines` invoked with a malformed doctrine.
- **Message shape:** `doctrine failed schema validation (<doctrine_id>): <path> <message>; …`
- **Hint:** inspect against the doctrine schema and fix the rule.
- **Carries:** `doctrineId`, `errors[]`.
- **Operator action:** fix the derivation rule.

### `FINDING_UNSAFE_REPO`

:::caution[Severity: HIGH]
A finding's `repo` field carried a path-traversal segment (`..` or a path separator) and was refused **before any write**. No file lands; the write side now matches the read side, which already rejected such segments. Same fail-closed input-guard class as the `SCHEMA_INVALID` family, but the threat is filesystem escape rather than a malformed payload.
:::

- **Class:** `FindingUnsafeRepoError` (`packages/findings/derive/write-findings.js`)
- **Trigger:** `writeFinding` / `writeFindings` invoked with a finding whose `repo` splits into an `org`/`repo` segment containing `..` or a separator. The `dogfood-finding` schema's `repo` pattern admits `.`/`..`, so a schema-valid `repo: '../policies'` previously resolved one directory level under `rootDir` and wrote outside `findings/` (into sibling runtime dirs like `policies/`, `indexes/`, `reports/`). The read path (`loadRecordsForRepoWithSkips`) already guarded this via `isUnsafeSegment`; this closes the write side (findings-A-001).
- **Message shape:** `unsafe repo path segment in finding (<finding_id>): '<repo>' contains a path-traversal or separator and was refused before any write (findings-A-001).`
- **Carries:** `repo`, `findingId`.
- **Operator action:**
  1. Inspect the offending record/finding — the `repo` field is malformed (contains `..` or `/` inside the org or repo name).
  2. Fix the upstream emitter (the source repo's submission builder), not the guard. A legitimate `repo` is exactly `<org>/<repo>` with no traversal segments.
  3. Re-run `dogfood findings derive --write` once the emitter is corrected.

### `RECOMMENDATION_UNSAFE_POLICY`

:::caution[Severity: HIGH]
The operator-supplied `--policy <org/repo>` carried a path-traversal segment and was refused on **both** the dry-run (path would leak in the preview) and write (file would be touched) paths, before either branch resolved a path. Sibling guard to `FINDING_UNSAFE_REPO`.
:::

- **Class:** structured error `{ code: 'RECOMMENDATION_UNSAFE_POLICY', … }` (`packages/findings/synthesis/apply-recommendation.js`)
- **Trigger:** `dogfood findings advise --policy <org/repo>` (apply-recommendation) invoked with an `org`/`repo` that is empty or contains `..` / a separator. `policyPathFor` resolves `policies/repos/<org>/<repo>.yaml`; an unsafe segment would escape the `policies/` tree.
- **Message shape:** `policy repo "<repo>" is not a safe org/repo path segment`
- **Hint:** `Pass --policy <org/repo> with no ".." or path separators inside the org or repo name.`
- **Operator action:**
  1. Re-invoke `--policy` with a clean `<org>/<repo>` value — no `..`, no extra separators.
  2. The control plane and filesystem are untouched; no cleanup is needed before retrying.

### `VALIDATOR_FAULT_SCHEMA`

:::caution[Severity: HIGH]
The schema validator itself threw an internal exception while processing a submission. This is an **operational fault** in the verifier, NOT a submission-bad signal — the operator should investigate the verifier itself, not route this back to the submitter as a "fix your payload" message.
:::

- **Class:** template-literal `\`VALIDATOR_FAULT_${cls}\`` emitted by `runValidator('schema', fn)` catch — `packages/verify/index.js`
- **Trigger:** the `validateSchema` call threw (e.g. AJV crash on a pathological regex, an unexpected reference resolution failure, or an internal assertion). The error string-prefix discriminates `VALIDATOR_FAULT_SCHEMA:` from the submission-bad `schema:` prefix.
- **Message shape:** appears as a string entry in `verification.rejection_reasons`: `VALIDATOR_FAULT_SCHEMA: <thrown message>`.
- **Hint:** the verifier itself crashed mid-validation — escalate to ops; do not page the submitter. Inspect the validator stack and patch the verifier.
- **Operator action:**
  1. Pull the `VALIDATOR_FAULT_SCHEMA:` reasons out of `verification.rejection_reasons` and triage them as a system incident.
  2. Re-run with verbose logging on the schema validator to capture the throw site.
  3. Patch the validator; the submission is a useful repro fixture, NOT the bug.

### `VALIDATOR_FAULT_POLICY`

:::caution[Severity: HIGH]
The policy validator itself threw an internal exception. Same operational-fault class as `VALIDATOR_FAULT_SCHEMA`.
:::

- **Class:** template-literal `\`VALIDATOR_FAULT_${cls}\`` emitted by `runValidator('policy', fn)` catch — `packages/verify/index.js`
- **Trigger:** the policy-validator call threw (e.g. deep-merge corrupted by a prototype-pollution probe, an unexpected policy shape from `loadRepoPolicy`).
- **Message shape:** `VALIDATOR_FAULT_POLICY: <thrown message>` in `rejection_reasons[]`.
- **Hint:** as above — verifier-side incident, not submission-bad.
- **Operator action:** triage as a system incident, patch the policy validator.

### `VALIDATOR_FAULT_STEPS`

:::caution[Severity: HIGH]
The steps validator itself threw an internal exception. Same operational-fault class.
:::

- **Class:** template-literal `\`VALIDATOR_FAULT_${cls}\`` emitted by `runValidator('steps', fn)` catch — `packages/verify/index.js`
- **Trigger:** the step-contract checker threw (e.g. an evidence-shape walk hit an unexpected nesting, a gate-accumulation arithmetic edge).
- **Message shape:** `VALIDATOR_FAULT_STEPS: <thrown message>` in `rejection_reasons[]`.
- **Hint:** as above — verifier-side incident.
- **Operator action:** triage as a system incident, patch the steps validator.

### `VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION`

:::caution[Severity: HIGH]
The contract-schema-version gate threw while checking the submission's declared schema version. Same operational-fault class as the three above — a verifier-side incident, NOT a submission-bad signal. This is the fourth `VALIDATOR_FAULT_*` sibling; all four share one prefix family.
:::

- **Class:** template-literal `\`VALIDATOR_FAULT_${cls}\`` emitted by the `runValidator('contract_schema_version', fn)` catch — `packages/verify/index.js`
- **Trigger:** `validateSchemaVersion(submission, 'recordSubmission')` threw — reached when the gate is invoked with an **unknown contract key** (a programmer error at the call site, not a submission fault). The version *mismatch* cases are the submission-bad `CONTRACT_SCHEMA_TOO_NEW:` / `CONTRACT_SCHEMA_TOO_OLD:` reasons below; only a genuine throw from the gate surfaces here.
- **Message shape:** `VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION: <thrown message>` in `rejection_reasons[]`.
- **Hint:** as above — verifier-side incident; matched by the same `VALIDATOR_FAULT_*` prefix family (F-82429f90: operational, thrown-not-persisted).
- **Operator action:** triage as a system incident, patch the version gate / its contract-key wiring.

### Consuming `rejection_reasons[]` — `parseRejectionReason`

:::note[Severity: MEDIUM]
The `verification.rejection_reasons[]` entries above are stable **prefixed strings**, not typed errors. Rather than hand-roll `.startsWith()` chains at every call site, import the classifier exported by `@dogfood-lab/verify`.
:::

- **Class:** `parseRejectionReason(reason)` — `packages/verify/parse-rejection.js` (re-exported from the package root `index.js`).
- **Returns:** `{ class, prefix, detail }` where `class` is one of:
  - **`submission-bad`** — the submitter fixes the payload (`schema:`, `policy:`, `policy-config:`, `steps[<id>]:`, `provenance:`, `repo:`, `submission-contains-verifier-field:`, `CONTRACT_SCHEMA_TOO_NEW:`, `CONTRACT_SCHEMA_TOO_OLD:`). Here `provenance:` is the genuine-absence case only — a 404 / not-confirmable run, i.e. the submitted run does not exist or does not bind. `policy-config:` (VERIFY-F1, v1.7.0) is a **repo** custom-rule predicate that hit an eval-time semantic fault the schema could not catch — an unknown leading field, a numeric operator over a non-number, or a depth/width budget overrun; the repo authored the bad rule YAML, so the submitter fixes it. Its **global** counterpart is operational — a malformed global predicate surfaces as `VALIDATOR_FAULT_POLICY` above.
  - **`operational`** — the verifier/tooling faulted; page ops, do NOT bounce to the submitter (the `VALIDATOR_FAULT_*` family above, matched by prefix family so a future fault class needs no parser edit; `provenance-fault:` for a provider 429/5xx/401/403 fault confirming the run; `scenario-fetch-fault:` for the same fault classes — including exhausted timeouts — while fetching a scenario definition; and `submission-malformed:` for a null/non-object payload from a malfunctioning dispatcher). As of the wave-4 hardening these faults are **thrown, not persisted**: production ingest exits 2 with no `_rejected` record, so an outage window never poisons a `run_id` against clean resubmission — you will only see the `VALIDATOR_FAULT_*` / `provenance-fault:` string forms in records persisted before that change.
  - **`ingest`** — an ingest-side load fault (`scenario-load:`), with typed reasons `parse_error | invalid_id | too_large | schema_invalid | malformed_entry | fetch_cap`. A missing definition file (`not_found`) is NOT in this set — it is not a rejection at all; the submission is accepted and the record carries a `verification.warnings` entry (`scenario definition not found for "<id>" — required_steps unenforced`). More than 20 scenario-load reasons collapse into a count summary in the persisted record.
  - **`unknown`** — unrecognized prefix (including the prefix-less null-submission reason); log + surface raw.
- **Usage:**

```js
import { parseRejectionReason } from '@dogfood-lab/verify';

for (const r of record.verification.rejection_reasons) {
  const { class: cls, prefix, detail } =
    parseRejectionReason(r);
  if (cls === 'operational') notifyOps(prefix, detail);
  else if (cls === 'submission-bad') reject(prefix, detail);
  else if (cls === 'ingest') triageLoad(detail);
  else log.warn('unknown rejection_reason', r);
}
```

- **Source of truth:** the full prefix taxonomy table lives in `packages/verify/README.md` → "Prefix taxonomy"; the parser enumerates the same set from the actual emitters (`verify/index.js`, `validators/schema-version.js`, `packages/ingest/run.js`).

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
- **Hint:** `e.hint` is set per-kind by the throwing site (e.g. "use `swarm revalidate` to lawfully recover from blocked states" for BLOCKED, "this agent is already complete; check why the caller tried to re-advance it" for TERMINAL).
- **Carries:** `kind`, `from`, `to`, `agentRunId`, `allowedTransitions[]` (legal `to` set from the current `from`).
- **Operator action:**
  - **BLOCKED:** look at the `Next:` hint — usually points at an override flag or a missing prerequisite.
  - **TERMINAL:** the agent is done; the bug is upstream. Inspect the caller for a re-advance loop.
  - **INVALID:** check `allowedTransitions[]` for what the state machine *will* accept from this `from`. Either reroute the call or, if the transition should be legal, file a finding to add the edge to `TRANSITIONS`.

### `INGEST_FAILED`

:::caution[Severity: HIGH]
A `swarm verify --ingest` run (or `persist-results.js`) reached the dogfood-ingest seam but the corpus write did not complete — the verifier rejected the swarm-emitted submission, or `packages/ingest/run.js` exited non-zero. The command exits **1** (never 0) so a CI gate keyed on `$?` cannot mistake a failed corpus write for success.
:::

- **Class:** structured stderr envelope (not a thrown typed error) — `console.error('ERROR [INGEST_FAILED]: …')` emitted at the swarm CLI ingest seam (`packages/dogfood-swarm/cli.js`) and from `packages/dogfood-swarm/persist-results.js`. Mirrors the documented `ERROR [<CODE>]:` shape even though it is printed rather than rendered through `renderTopLevelError`.
- **Trigger:** the `--ingest` path attempted to record the run's own dogfood submission and the downstream ingest either returned `ingested !== true` (CLI seam, with the verifier's `reason`) or exited non-zero (`persist-results.js` seam). Common underlying cause: the swarm-emitted submission failed schema validation in `packages/ingest/run.js`.
- **Message shape:**
  - CLI seam: `ERROR [INGEST_FAILED]: dogfood ingest did not complete — <reason>`
  - persist-results seam: `ERROR [INGEST_FAILED]: dogfood ingest exited non-zero`
  - Both follow the failure line with `  Submission: <path>` and a copy-pasteable `  Reproduce:  node "<repo>/packages/ingest/run.js" --provenance=stub --file "<submission>"` line; the persist-results seam also prints `  Exit code:  <n>` when available.
- **Operator action:**
  1. Run the printed `Reproduce:` command to replay the ingest in isolation with full output.
  2. The most common cause is a schema-invalid submission — inspect the AJV failure against `packages/schemas/src/json/dogfood-record.schema.json` and fix the swarm's submission emitter, not the schema.
  3. Re-run `swarm verify --ingest` once the emitter is corrected. The human-readable summary still prints `Ingested: NO` to stdout so the failure is visible in both streams.

### `CRITERION_INTENT_OVERFLOW`

:::note[Severity: MEDIUM]
A locally-detectable input error in the case-file, caught before any jury seat is dispatched. Nothing is spent, nothing is written, nothing is corrupted — the operator edits the case-file and re-runs.
:::

- **Class:** `CriterionIntentOverflowError` (`packages/dogfood-swarm/lib/errors.js`).
- **Trigger:** Assembling a `--jury=prism` seat call, when the **mandatory** section — `rubric.objective` + one criterion's `check` + the whole `out_of_scope` block — already exceeds prism's 4000-char `intent` cap, before any evidence is added. Raised by `buildCriterionIntent` in `packages/dogfood-swarm/lib/case-file/prism-jury.js`.
- **Message shape:** `rubric.objective + criterion '<id>' + out_of_scope exceed prism's 4000-char intent cap by <n> chars — shorten the objective, split the criterion, or trim the out-of-scope list`
- **Hint:** `Next: criterion <id> intent is <n> chars over the <max>-char cap — shorten rubric.objective, split the criterion, or trim out_of_scope`. `CriterionIntentOverflowError` sets `.hint` in the constructor; `deriveHintForCode()` also has a `CRITERION_INTENT_OVERFLOW` fallback for round-tripped objects that kept `.code` but not `.hint` (F-4b72faf9). `renderTopLevelError` therefore prints `ERROR [CRITERION_INTENT_OVERFLOW]:` plus that `Next:` line. Structured fields (`criterionId`, `headLength`, `maxChars`) remain on the error.
- **Operator action:**
  1. Shorten `objective`, split the named criterion, or trim `out_of_scope` — the three levers the message names. **All three sections are mandatory** on this tier: only the evidence pack yields to the cap, so an over-cap mandatory section cannot be resolved by dropping evidence.
  2. Re-run `swarm adjudicate <run-id> --case-file <path> --jury=prism`.
- **Why this fails fast rather than trimming:** everything droppable is already reported per-criterion on the receipt as `criteria[].brief_omitted`. An over-cap **mandatory** section, though, was neither reported nor droppable — it was a fixed cost measured against the budget but never checked. prism's own pydantic `max_length=4000` then rejected the request on **every seat uniformly**, so the panel returned `insufficient_context` and the operator was told the jury could not reach the artifact — when the real cause was a deterministic input error knowable without spending a single ~27s seat call. This is the [case-file contract](https://github.com/dogfood-lab/testing-os/blob/main/docs/case-file-contract.md)'s "anything that does not fit is REPORTED, not silently dropped" applied to the one section that had escaped it.

### `UNSAFE_RECORD_PATH`

:::caution[Severity: HIGH]
A submission passed the record schema but its on-disk path could not be safely computed. **Nothing is written** — the traversal guard holds and the ingest fails closed. The submission is rejected, not persisted.
:::

- **Class:** `UnsafeRecordPathError` (`packages/ingest/persist.js`), cause-chained to the underlying `computeRecordPath` failure.
- **Trigger:** `writeRecord()`, when `computeRecordPath()` throws *after* `validateRecord()` has already passed. The gap it closes: the record schema's `repo` pattern (`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`) **permits embedded `..`** — `../etc` matches — while `isUnsafeSegment` correctly refuses it. So a schema-valid-but-unsafe repo reached path computation and threw a bare, unclassified `Error`.
- **Message shape:** `record passed schema validation but its path could not be safely computed (repo: <repo>, run_id: <run_id>): <cause message>`
- **Fields:** `repo`, `runId`, plus the chained `cause` (rendered as `Caused by: …`).
- **Operator action:**
  1. Read the `Caused by:` line — it names the specific guard that refused (`invalid repo format` / `unsafe repo segment` / `unsafe run_id`).
  2. Fix the submission's `repo` or `run_id` and resubmit. **The run_id is not consumed** — nothing was written, so a corrected resubmission is not a duplicate.
- **Why a distinct code rather than reusing `RECORD_SCHEMA_INVALID`:** the record is *not* schema-invalid — it passed. Reporting it as a schema failure would send the operator to the schema, which is exactly the confusion this code exists to end. The two checks disagree by design: the schema is a permissive contract shared with consumers, and `isUnsafeSegment` is the stricter filesystem-safety gate. A submission can satisfy the first and fail the second, and that state now has a name.

### `CLI_INVALID_VERIFIED_HOW`

:::note[Severity: MEDIUM]
The operator-supplied `--verified-how <value>` on `swarm close` is not one of the three accepted verification modes. System state is unchanged; the command refuses before mutating rather than silently defaulting a load-bearing field.
:::

- **Class:** plain `Error` with `e.code = 'CLI_INVALID_VERIFIED_HOW'`, thrown by `verifiedHowError()` — `packages/dogfood-swarm/cli.js`. It throws (unlike the guard clauses below), so it reaches `renderTopLevelError` and renders the full `ERROR [CLI_INVALID_VERIFIED_HOW]:` envelope, matching `CLI_INVALID_GLOBS_JSON` / `CLI_INVALID_THRESHOLD`'s format.
- **Trigger:** `swarm close --verified-how <raw>` invoked with a `raw` value outside `independent | self_attested | operator_evidence`. A *missing* `--verified-how` is a separate, untyped guard-clause refusal (see the Usage-errors bullet below) — only an out-of-enum value reaches this typed code.
- **Message shape:** `--verified-how expects one of independent|self_attested|operator_evidence; got '<raw>'`
- **Hint:** `pass one of: independent, self_attested, operator_evidence — e.g. \`--verified-how independent\``
- **Carries:** `received` (the raw input).
- **Operator action:**
  1. Re-invoke with one of the three accepted values.
  2. This field is load-bearing, not decoration — review-verified fixes demonstrably reopen less than self-attested ones (Zimmermann et al., ICSE-SEIP 2012).

### `swarm reopen` / `swarm close` / `swarm roadmap` — failure modes

:::note[Severity: LOW]
An earlier revision of this section claimed the recovery and trajectory verbs introduce one new typed error code. That was a source-verified undercount, caught and re-counted by successive confirming audits (the class-level JSDoc in `lib/errors.js` was itself three codes stale). The reopen/close/roadmap family carries **thirteen typed codes**: `CLI_INVALID_VERIFIED_HOW` (above), the reopen/close-specific narrow `CLI_INVALID_FORMAT` (below), the four from `commands/roadmap.js` (`ROADMAP_RUN_NOT_FOUND`, `ROADMAP_ARTIFACT_MISSING`, `ROADMAP_UNDO_INVALID_SEQUENCE`, `ROADMAP_UNDO_NOT_FOUND`), and the seven-code operator-notes validation family — **sixteen** counting the **three added with the roadmap seeding flags** (`ROADMAP_SEED_NOT_FOUND`, `ROADMAP_SEED_SCHEMA_INVALID`, `DISPATCH_ROADMAP_DIGEST_NOT_FOUND`). Each has its own entry below. The untyped-guard-clause and per-id-refusal conventions described here still govern everything else.
:::

- **Usage errors** (missing `--ids`, empty `--reason` or `--evidence`, missing `--verified-how` on `close`, an `--as` value other than `fixed`): each guard clause calls `console.error` directly and `process.exit(1)` — it never throws, so `renderTopLevelError` never sees it: there is no typed `ERROR [<CODE>]:` envelope and no untyped `ERROR: <message>` line either. The printed text is a plain, mostly verb-prefixed sentence (e.g. `reopen: --evidence "<text>" is required (non-empty) — …`, or the bare `Specify --ids F-001,F-002 (reopen is targeted — there is no --all)`). No usage synopsis prints alongside any of these — the `Usage: swarm reopen ...` / `Usage: swarm close ...` synopsis is reserved for the one case where the run-id itself is missing. Unrecognized flags (e.g. a typo'd `--this-flag-does-not-exist`) are silently ignored, not rejected — verified live against both verbs. Both mutation verbs are **dry-run by default** — forgetting `--apply` is not an error; it prints the would-do report and changes nothing.
- **The narrow `--format` enum:** `swarm reopen`/`swarm close` accept `--format=text|json` only — deliberately excluding `markdown` — and an out-of-enum value throws the typed `CLI_INVALID_FORMAT` from their own `closureFormatError()` (`cli.js`), a distinct call site from the shared `text|markdown|json` parser other verbs use. Same code string, narrower contract; the message names the two accepted values.
- **Ineligible ids — and the reopen/close asymmetry.** `swarm close` is idempotent over ineligible rows the way `defer`/`reject` are: closing an id that is not open, or an id that names no finding in the run, is **listed per-id in the dry-run/apply report** rather than thrown, so a typo'd or hallucinated id can never vacuously transition anything. `swarm reopen` is stricter: reopening an id that is **not in a closed state hard-refuses** — non-zero exit, no report line — rather than reporting it as a skipped row. The two verbs are deliberately not symmetric here (an earlier revision of this page claimed they were): closing is a batch disposition where a no-op member is unremarkable, while a reopen names a specific closed finding to revive and an ineligible target is more likely an operator mistake worth failing on. Either way, no ineligible id is ever silently transitioned.
- **`swarm roadmap compile`** validates operator notes at compile time, before any core compile work, via the seven typed `ROADMAP_NOTES_*`/`ROADMAP_NOTE_*`/`ROADMAP_TOO_MANY_NOTES`/`ROADMAP_INVARIANT_NO_ENFORCER`/`ROADMAP_ENFORCER_NOT_FOUND` codes (grouped entry below); nothing is written on refusal — compile is atomic. `expires` is never a validation trigger — `validateNote()` does not inspect it, so a malformed `expires` cannot refuse the compile; an unparseable value (e.g. the `<N runs>` shorthand — only ISO-date `expires` is implemented today, a disclosed scope gap) is treated as non-expiring, never a refusal. Both buckets land in the artifact — `operator_notes` (active) and `expired_notes` (required, empty-allowed; the cross-run carrier for loud expiry) — and `roadmap show` renders expired notes as EXPIRED rather than silently dropping them.
- **Provenance guarantees on every transition:** each applied reopen/close writes an append-only `finding_events` row — `event_type='reopened'` for `swarm reopen`; for `swarm close`, `event_type` mirrors the `--as` target status (`'fixed'` today, the only value `--as` accepts) rather than a distinct `operator_closed` event type — carrying reason, evidence, and the acting authority. The original closure a reopen reverses is never rewritten — it remains in the event history.

Documented at contract level alongside the verbs' first shipped wave; the next confirming audit re-verifies this section against the implementation, per this page's standing discipline.

### `ROADMAP_RUN_NOT_FOUND`

:::note[Severity: LOW]
A `swarm roadmap compile|show` (or `compile --undo`) named a run id with no `runs` row. Nothing is read or written.
:::

- **Class:** plain `Error` with `e.code` via the `roadmapError()` factory (`commands/lib/roadmap-notes.js`), thrown by `requireRun()` in `commands/roadmap.js`.
- **Trigger:** the `<run-id>` argument matches no row in the control-plane DB the CLI resolved.
- **Operator action:** `swarm runs` lists real run ids; check `SWARM_DB` if the id looks right but the DB is wrong.

### `ROADMAP_ARTIFACT_MISSING`

:::caution[Severity: MEDIUM]
The roadmap ledger names an artifact sequence whose file is missing on disk — the ledger and the tree disagree. `show` refuses with the named sequence instead of crashing on a raw `ENOENT`.
:::

- **Class:** `roadmapError()` in `commands/roadmap.js` — the raw fs error is caught and re-thrown as this named, recoverable state (the F-d875b3c1 compensator lineage).
- **Trigger:** `swarm roadmap show` resolving a `roadmap_artifacts` row whose `path` does not exist under the run's `local_path`.
- **Operator action:** either re-run `swarm roadmap compile <run-id>` (a fresh sequence supersedes; history is never rewritten) or remove the orphaned ledger row with `swarm roadmap compile <run-id> --undo <sequence> --apply` — the named compensator documented in the [CLI reference](../cli-reference/#swarm-roadmap).

### `ROADMAP_UNDO_INVALID_SEQUENCE` / `ROADMAP_UNDO_NOT_FOUND`

:::note[Severity: LOW]
The `--undo` compensator refuses bad targeting before touching anything: a non-positive-integer sequence (`ROADMAP_UNDO_INVALID_SEQUENCE`) or a sequence with no ledger row for that run (`ROADMAP_UNDO_NOT_FOUND`). Zero mutation in both cases — verified live.
:::

- **Class:** `roadmapError()` in `commands/roadmap.js` (`undoRoadmapCompile`).
- **Operator action:** the hint names the discovery path — `swarm roadmap show <run-id> --format=json` lists the sequences that actually exist.

### `ROADMAP_NOTES_*` — the operator-notes validation family

:::note[Severity: LOW]
Seven typed codes, all minted by `commands/lib/roadmap-notes.js`'s `roadmapError()` factory during `swarm roadmap compile`'s T3 seed validation. All refuse the compile atomically — nothing is written on any of them.
:::

| Code | Trigger |
|------|---------|
| `ROADMAP_NOTES_UNPARSEABLE` | the notes seed file exists but is not valid JSON |
| `ROADMAP_NOTES_SHAPE_INVALID` | the parsed seed is neither a top-level array nor `{"notes": [...]}` |
| `ROADMAP_TOO_MANY_NOTES` | more than 7 notes (the T3 Reflexion bound) |
| `ROADMAP_NOTE_INVALID` | a note missing a non-empty `text` |
| `ROADMAP_NOTE_INVALID_KIND` | `kind` outside `theme\|open-question\|invariant` |
| `ROADMAP_INVARIANT_NO_ENFORCER` | an `invariant` note without `enforced_by` — a lesson without a mechanical verifier is not persisted as a lesson |
| `ROADMAP_ENFORCER_NOT_FOUND` | an `enforced_by` path that resolves to no file on disk |

- **Operator action:** fix the named note in the seed file and re-run compile; the per-note report names which note and which rule.

### `ROADMAP_SEED_NOT_FOUND`

:::caution[Severity: MEDIUM]
`swarm init --seed-from-roadmap` could not resolve a roadmap artifact to seed from. Init fails fast — no run row is created against a phantom lineage.
:::

- **Class:** `roadmapError()` via `commands/lib/roadmap-seed.js` (`resolveRoadmapSeed`).
- **Trigger:** any of the four nothing-resolves shapes — `dogfood/roadmap/latest.json` missing, unparseable, missing a usable `path` field, or the resolved artifact file absent on disk (explicit `=<run-id>` resolves `dogfood/roadmap/<run-id>.json` directly).
- **Operator action:** run `swarm roadmap compile` on the source run first, or drop the flag to init cold.

### `ROADMAP_SEED_SCHEMA_INVALID`

:::caution[Severity: MEDIUM]
The seed artifact resolved but failed validation — invalid JSON, an Ajv failure against `dogfood-roadmap.schema.json`, or a missing `run_id`/`sequence` belt-and-braces field. Init refuses rather than recording lineage to a malformed artifact.
:::

- **Class:** `roadmapError()` via `commands/lib/roadmap-seed.js`.
- **Operator action:** recompile the source run's roadmap (a conformant fresh sequence supersedes the malformed one), then retry.

### `DISPATCH_ROADMAP_DIGEST_NOT_FOUND`

:::note[Severity: LOW]
An explicit `swarm dispatch --roadmap-digest=<run-id>` named a run with no compiled roadmap artifact on disk. The refusal fires before `buildWave()`'s transaction — a bad reference can never strand a half-built wave.
:::

- **Class:** `DispatchPreconditionError` (`lib/errors.js`), like the other six `DISPATCH_*` codes above.
- **Operator action:** compile the referenced run's roadmap, or omit the flag (auto-injection only fires for runs initialized with `--seed-from-roadmap`; `--no-roadmap-digest` suppresses it entirely).

## Cross-references

- Hard Gate B (Errors): structured shape (code/message/hint), exit codes for CLI, no raw stacks. See [README threat model](https://github.com/dogfood-lab/testing-os#threat-model).
- The state machine these errors come out of: [State Machines](../state-machines/).
- Where rejected records land when ingest throws `RECORD_SCHEMA_INVALID` or `DUPLICATE_RUN_ID`: `records/_rejected/` ([Beginner's Guide → Investigating a failure](../beginners/#investigating-a-failure)).
