---
title: Recovery — The Three R's
description: Revalidate, Rewind, Redrive — the lawful recovery contract for swarm control-plane state, with operator-supplied reasons recorded in every audit row
sidebar:
  order: 6.5
---

The swarm control plane ships three recovery verbs. They are siblings, not synonyms — each one names a different shape of recovery, and each one writes its own prefix into the audit trail so a future inspector can grep `wave_state_events` / `agent_state_events` for the verb that wrote each row.

| Verb | What it does | Where the row lands |
|------|-------------|---------------------|
| `swarm revalidate` | Repairs blocked agent_runs in place (BLOCKED → `complete`); flips the wave back to `collected` when every latest agent_run reaches `complete` | `agent_state_events` (+ wave row when the wave flips) with `revalidate:` reason prefix |
| `swarm rewind` | Restores the working tree to a save-point tag AND lawfully aborts orphaned in-flight waves + agent_runs (status → `aborted_for_rewind`) | `wave_state_events` + `agent_state_events` with `rewind:` reason prefix |
| `swarm redrive` | Resumes an in-flight wave at the same `wave_id`; completed receipts survive byte-identical, only eligible failed/unstarted agent_runs are made re-dispatchable (status → `dispatched`) | `wave_state_events` + `agent_state_events` with `redrive:` reason prefix |

The product thesis: **Rewind erases, Redrive resumes.** They are not the same verb. A rewind is what you do when the slice itself was a wrong turn and you want the working tree back at the save-point; the in-flight rows survive as forensic evidence with status `aborted_for_rewind`. A redrive is what you do when the slice was right but a subset of agents failed mid-flight; completed receipts are immutable and only the failure tail gets re-dispatched. Revalidate is the third sibling — narrowly, "the agent's output JSON was corrected on disk; ratify it through the override path so the audit trail names who said it was good and why."

## The shared discipline

Every verb is built on the same four contracts:

1. **Dry-run by default; `--apply` required to mutate.** The dry-run renders the full plan (what would change, what would be preserved, what would be refused) so the operator previews the effect before any state leaves disk. Same posture as `pg_resetwal -n` or `kubectl --dry-run=server`.
2. **`--reason "<text>"` is non-optional.** Every verb refuses without a non-empty reason string. The text is recorded verbatim in the matching `_state_events` row, prefixed with the verb name (`revalidate:`, `rewind:`, `redrive:`) so the audit trail is greppable by intent.
3. **Zero raw SQL.** All status mutations go through the canonical `transitionAgent` / `transitionWave` helpers in `packages/dogfood-swarm/lib/state-machine.js` and `packages/dogfood-swarm/lib/wave-state-machine.js`. Raw `UPDATE waves SET status = …` would skip the audit row and corrupt the chain.
4. **Single transaction.** Each verb wraps its DB writes in one `better-sqlite3` transaction so a partial-write cannot leave the control plane in a torn state (e.g. agents `complete` but wave still `failed`). Rewind also runs `git reset --hard` BEFORE the DB transaction so a partial DB-side failure surfaces loudly as "tree at target, DB tx failed — inspect manually."

## `swarm revalidate`

Repair the latest agent_run for one or more domains when its output is now correct on disk but the control plane has it stuck in `invalid_output` or `ownership_violation`.

```text
Usage: swarm revalidate <run-id>
  --reason "<text>"
  --domain=name:path
  [--domain=name:path ...]
  [--apply]
```

Behavior (per `packages/dogfood-swarm/commands/revalidate.js`):

- `--reason "<text>"` and at least one `--domain=name:path` are required; the verb throws on either missing.
- Each `--domain` value names a domain on the run and a path to its corrected output JSON. The output is re-run through the same Ajv envelope gate, phase-specific legacy validator (audit / feature / amend), and ownership check that `swarm collect` uses — the verb does not have its own validator; the gate is the same gate.
- On pass per domain, the verb calls `transitionAgent(db, agent_run_id, 'complete', reason, /* override */ true)`. The override branch is required because the source statuses (`invalid_output`, `ownership_violation`) are in `BLOCKED_STATUSES`; the canonical `canTransition` law would otherwise refuse them.
- For a repaired **audit** output, the corrected findings are ingested with the same fingerprint/classify/upsert pipeline `swarm collect` runs (sourceText-parity fingerprints, classification against the run's prior map) — so the finding-severity advancement gate sees them, and a repaired wave can lawfully move the gate to AMEND. A repair is not just a status flip.
- For a repaired **amend** output, `verification_skipped: true` propagates exactly as it does at collect: the agent row records it and the wave's `serial_verify_required` flag is set, so the mandatory serial-verify discipline survives the recovery path.
- After every latest agent_run on the wave is `complete`, if the wave is currently `failed`, the same transaction calls `transitionWave(db, wave.id, 'collected', 'revalidate: <reason>', true)`. The wave-level override is required because `failed` is a BLOCKED wave status. The findings ingestion and discipline-flag propagation above ride in this same transaction.
- Partial repair (some agents repaired, others still BLOCKED) keeps the wave in `failed` deliberately. The applied-summary spells out the "Wave NOT recovered" clause with a count of still-blocked agents so the operator's natural read of "Repaired: N" + clean exit code cannot be misread as "wave fully recovered."

## `swarm rewind`

Restore the working tree to a named save-point AND lawfully tear down any orphaned in-flight rows that pre-date the save-point.

:::danger[Destructive — can discard uncommitted work]
`swarm rewind` runs `git reset --hard <save-point>`. With `--force` it discards **uncommitted working-tree changes irreversibly** — the same blast radius as `git reset --hard`. Without `--force` a dirty tree is refused (the safe default). Always run the dry-run first (omit `--apply`) to preview exactly what is reset and what is preserved before you commit to it.
:::

```text
Usage: swarm rewind <save-point-tag> --reason "<text>"
  [--apply]
  [--force]
  [--force-arbitrary-ref]
```

Behavior (per `packages/dogfood-swarm/commands/rewind.js`):

- `<save-point-tag>` must match `swarm-save-*` by default; `--force-arbitrary-ref` opts into arbitrary refs (tags, branches, commits). Destructive verb; the conservative default lives on the safer surface.
- `--reason "<text>"` is required and non-empty. The text is prefixed with `rewind: ` and recorded in every `wave_state_events` and `agent_state_events` row this verb writes.
- Uncommitted changes in the working tree are refused without `--force`. This mirrors `git reset --hard`'s documented destructive surface — silently discarding uncommitted work would be the worst kind of operator surprise.
- Order of operations: validate → `git reset --hard <tag>` → DB transaction. Git cannot roll back inside a SQL transaction; the reverse order would leave the tree reset if SQL succeeded and git failed. A partial DB-side failure surfaces as a `state_split: true` error in the report.
- Affected rows transition to the new `aborted_for_rewind` terminal status (parallel agent + wave statuses; introduced for this verb). Reusing `failed` would be semantically wrong (the wave was not a logic failure; it was operator-aborted); a same-status no-op write would erase the lifecycle signal entirely.
- Terminal rows (advanced waves, complete agent_runs, prior `aborted_for_rewind` entries) survive byte-identical. The plan summary names the preserved count alongside the affected count — "rewind erases the failure tail but preserves history" is the operator's mental model and the surface reflects it.

## `swarm redrive`

Resume an in-flight wave at the same `wave_id`. Completed work survives byte-identical, only the failure tail is re-dispatched. Step Functions Redrive semantics on the swarm control plane.

```text
Usage: swarm redrive <wave-id> --reason "<text>" [--apply]
```

Behavior (per `packages/dogfood-swarm/commands/redrive.js`):

- `<wave-id>` must be a positive integer matching `waves.id`. `--reason "<text>"` is required and non-empty; the text is prefixed with `redrive: ` and lands on every `_state_events` row this verb writes.
- Wave-level eligibility: `advanced` and `aborted_for_rewind` are TERMINAL and refused (promotion is immutable; a `aborted_for_rewind` wave is run-a-fresh-wave territory). `collected`, `verified`, `dispatched` use the normal `transitionWave` path; `failed` uses the override branch because it is BLOCKED.
- Per-agent_run eligibility table:

| Source status | Outcome | Reason |
|---------------|---------|--------|
| `complete` | PRESERVED | Receipt is immutable; appears in the report as informational |
| `pending`, `dispatched` | ELIGIBLE | Redriven to `dispatched` (source == target → audit row only) |
| `failed` | ELIGIBLE | Redriven via override (BLOCKED source) |
| `timed_out` | ELIGIBLE | Normal path; `timed_out → dispatched` edge already exists |
| `invalid_output` | REFUSED | Use `swarm revalidate` instead (wrong verb) |
| `ownership_violation` | REFUSED | Operator unblocks ownership first; not a redrive case |
| `aborted_for_rewind` | REFUSED | Terminal; run a fresh wave at the same phase |
| `running` | REFUSED | Let the timeout policy fire, then redrive the resulting `timed_out` |

- **Receipt-byte-identity contract.** Before `--apply` the verb computes a sha256 hash over the identity-carrying fields (status, output_path, completed_at) plus the full `agent_state_events` chain for every `complete` agent_run on the wave. After `--apply` it recomputes the same hash and asserts equality. A future regression that accidentally writes to a complete row trips this gate and the verb throws.
- `serial_verify_required` on the wave is preserved across redrive. The flag marks operator discipline ("this wave was dispatched with `--skip-verify`; coordinator owes one serial `npm run verify` against the cumulative tree"); resetting it would silently re-arm the bug the flag exists to prevent.

## Example session

A walked example, end-to-end. The repo has a dispatched wave (id `42`) that finished with two agents reporting `invalid_output`. The save-point tag is `swarm-save-1789450000`.

```bash
# Step 1: inspect the wave's state.
swarm status <run-id>
# Output names blocked agents and points at swarm revalidate.

# Step 2: try revalidate first (dry-run).
swarm revalidate <run-id> \
  --reason "fix typos in output JSON" \
  --domain=backend:outputs/backend.json \
  --domain=tests:outputs/tests.json
# Dry-run renders the plan; if every agent passes the
# validators and would transition cleanly, --apply commits.

# Step 3: revalidate apply.
swarm revalidate <run-id> \
  --reason "fix typos in output JSON" \
  --domain=backend:outputs/backend.json \
  --domain=tests:outputs/tests.json \
  --apply
# Wave flips from failed to collected in the same transaction.

# Alternate path — wave unsalvageable; rewind erases.
swarm rewind swarm-save-1789450000 \
  --reason "slice abandoned; wrong architectural direction"
# Dry-run. Inspect, then re-run with --apply.
swarm rewind swarm-save-1789450000 \
  --reason "slice abandoned; wrong architectural direction" \
  --apply
# Tree reset to save-point; in-flight rows aborted_for_rewind.

# Alternate — wave right but two agents failed; redrive resumes.
swarm redrive 42 \
  --reason "transient net failures on 2 agents; re-dispatch tail"
# Dry-run names what's preserved vs eligible vs refused.
swarm redrive 42 \
  --reason "transient net failures on 2 agents; re-dispatch tail" \
  --apply
# Completed receipts unchanged; failure tail back at dispatched.

# In every case, audit the chain afterwards.
swarm history 42
```

The audit chain is the canonical record. Direct DB intervention is universally last-resort across the industry (`pg_resetwal`, `etcdctl snapshot restore`, Modern Treasury, Stripe Ledger) — every one of them mediates state mutation through tooled commands that emit an event-sourced audit row alongside the UPDATE. The Three R's are this repo's expression of that pattern.

## Cross-references

- Wave transition history inspection: [`swarm history <wave-id>`](../swarm-history/)
- Agent run lifecycle and the BLOCKED override primitive: [State Machines](../state-machines/)
- CLI error codes surfaced by these verbs: [Error Code Reference](../error-codes/)
- Phantom `violation=1` file_claims stranded on terminal waves — the repair class the Three R's cannot reach: [`swarm clean-claims`](../cli-reference/#swarm-clean-claims)
