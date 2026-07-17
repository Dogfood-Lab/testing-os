# Wave 42 kickoff — dogfood swarm `swarm-1784091637-5127`

Paste this into a fresh session at `E:/AI/testing-os`. You are the **Coordinator**. This file supersedes `WAVE-40-KICKOFF.md` (kept as historical record).

---

## Read these first, in this order

1. `swarms/CLAUDE.md` — the ethos.
2. `swarms/PROTOCOL.md` → **"Fixing a class, not an instance"**. Law.
3. `HANDOFF.md` — the **WAVES 40–41** entry is the state of the world; 38–39 is how it got there.
4. `docs/trajectory-and-closure.dispatch.md` — the Feature Pass contract, now carrying TWO dated amendments (C2 `--as` narrowing; C3 event-type-mirrors-status). What wave 42 confirms was built against it.
5. `CLAUDE.md` (repo root) — repo etiquette.

**Then verify everything below against the live sources. Do not trust this file.** The previous coordinator (me) mis-joined a DB query on its first read of finding_events and manufactured a 135-row false alarm; piped a pin-gate run through grep and lost the orphan ids while printing grep's own exit 0; and under-specified a "conform to the schema" work order to four axes, leaving the real vocabulary decision open. Ids come from the DB. Scope from the frozen map. Coverage from the gate's own output.

```bash
node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
node packages/dogfood-swarm/cli.js roadmap show swarm-1784091637-5127
git log --oneline -8
gh run list --branch swarm/health-amend-a-1784091637 --limit 3
```

---

## Where things stand (verified 2026-07-17, end of wave 41)

| | |
|---|---|
| Run | `swarm-1784091637-5127`, wave **41/41** (`feature-execute` collected, receipt exported, ADVANCE recommended) |
| Branch | `swarm/health-amend-a-1784091637` @ `7737fa0`+, pushed, **CI green** |
| Findings | 26 `approved` (wave-40's, amended by wave 41, awaiting confirmation) · 39 `unverified` (the backfilled feature findings, awaiting their first lawful confirm) · 380 fixed · 12 deferred · 16 rejected |
| Floor | serial `npm run verify` EXIT 0 (doc-drift 21/21 + ONE deliberate WARN); `swarm verify` receipt recorded |
| Pin gate | 150 declared / 256 grandfathered / 36 allowlisted / 0 orphans |
| Roadmap | sequence 2 live (compiled by the fixed emitter); `roadmap show` works; the orphan row is repaired |
| Worktrees | clean (wave-41's six destroyed via `swarm clean --apply --force`) |

**What wave 41 changed structurally:** file-less findings are now routable (`findingsForDomain` fallback), vouchable (`scopeConfirmedToOwningDomain` fallback — F-8a15be4c CRITICAL, revalidate inherits), fingerprint-distinct (description folding, fusion red-proven), and backfilled (all 40 pre-v10 rows carry `filed_by_domain` from the workorder placement table). `swarm roadmap compile --undo` exists and repaired the live orphan. The `operator_closed` class is resolved code+docs+contract: event mirrors `--as`, `closure_kind` carries provenance.

---

## Your task: Wave 42 — the confirming audit that can finally close the pass

Dispatch `feature-audit`. The briefs' CONFIRM queue will carry **65 open findings** (26 approved + 39 unverified) — and for the first time in this run's history, **owning-domain `confirmed[]` declarations can lawfully close file-less findings**. This is the first live exercise of the wave-41 vouching fallback: watch the collect's classification like a hawk.

```bash
node packages/dogfood-swarm/cli.js dispatch swarm-1784091637-5127 feature-audit --preview
node packages/dogfood-swarm/cli.js dispatch swarm-1784091637-5127 feature-audit
# 6 Sonnet lanes; docs audits only; hand lanes the residuals below
node packages/dogfood-swarm/cli.js collect swarm-1784091637-5127 --all
```

Confirm-queue routing note: the 39 unverified route by `filed_by_domain` = the FILING lane (wave-38 auditor), which for F-274e7ac5 and F-f86e42eb is **docs** even though core built the fixes — a docs lane can verify both by read+run. The wave-41 26 route by their filers as stamped at upsert.

### Residuals awaiting canonical ids (audit fodder, not hidden)

- **THE VOCABULARY DECISION (the big one):** `dogfood-roadmap.schema.json`'s required sections (`run_id`, `compiled_from`, `open_summary`, `grandfathered_drain`, `recurrence_stats`, `drain_queue`) are emitted by NO compiler, and `$defs/drainEntry` models cadence in RUNS while every implementation models DATES (`revalidate_by`). Contract-vs-mechanism, spans backend+core+verbs+ci. The full-document gate carries it as a `suspendedTargets` WARN on every verify run until resolved. Consider whether it deserves a mini design dispatch before the amend.
- **The fingerprint-fusion fix (lib/fingerprint.js description-folding) and the backfill mechanism (lib/filed-by-domain-backfill.js) are riders without canonical ids** — their pins are deliberately untagged; the audit mints ids, then tags land.
- **Backend's swallowed B40-002** (transitions.js reopen-asymmetry comment, fixed as a rider) — the allowlist entry F-B40-002 names a NON-DB label; canonicalize it.
- **`compiled_at` still equals run-creation time by design** (determinism) — re-described honestly, but the artifact's real compile time lives only in `roadmap_artifacts.created_at`. The schema's description now says so; verify the claim holds.
- **F-07895c2c (T4 seeding flags) remains unbuilt**, now `unverified`, digest injection wired-but-dormant.
- **The two open CRITs (F-8595faf8, F-8a15be4c) are amended-awaiting-confirm, not live defects** — verify by execution, then confirm.
- Wave-40 lane outputs sit in `swarms/swarm-1784091637-5127/wave-40/*/output.json` with the per-finding execution evidence the confirms can cite.

---

## Traps that WILL bite you

**UNPIPED means every gate AND every intel run.** This session piped a pin-gate check through grep — the FAIL text survived but the orphan ids didn't, and `$?` was grep's 0. Run gates bare; if you must filter, run twice.

**Watch the collect's keeper log.** `fingerprint_disambiguated` lines with `keeper_is_prior_match: true` are where fusion used to hide. The fix is in, with pins — but this collect is its first full-scale live run. Three swallowed reports and one false recurrence took ~an hour of forensics to untangle last time; the queries are in the wave-40 section of the session transcript pattern: match lane outputs' filed counts against DB row deltas, per lane.

**`approve --all` takes new + recurring only.** Close/repair any false recurrence BEFORE approving (this run's precedent: `swarm close --as fixed` with forensic evidence).

**The ownership gate fires on `fixtures/` at the repo root and every `swarms/*.md`.** The lawful split: drop from the lane branch (restore-from-base for pre-existing files — `git rm -r` over-deletes), fix the output's files_changed to match reality, `swarm revalidate --apply`, reland as disclosed coordinator work.

**Cross-lane seams are normal; the serial verify is the oracle.** Wave 41's merge caught a real two-derivations content_hash defect that was green in BOTH worktrees separately. Expect the same class wherever two lanes touched one contract.

**The suspendedTargets WARN is supposed to be there.** One WARN naming three skipped roadmap files = correct current state. Zero WARNs after the vocabulary decision lands = delete the suspension entry. Any OTHER warn = investigate.

**Coordinator mechanism changes still require adversarial review** — but completing lane work against a lane-authored contract with the lane's own gate as oracle is merge reconciliation, not mechanism invention. Know which one you're doing; when in doubt, resume the owning lane (SendMessage works post-completion and preserves its context — proven this session with ci-tooling's rescope).

## Ask the Director before

- Entering Phase 9 (final test) / Phase 10 (full treatment) or cutting **v1.10.0** (CHANGELOG Unreleased is written).
- Any raw DB write (the lawful verbs + backfill module cover the known cases).
- Merging the swarm branch to `main` (the pass boundary).
- Deleting the legacy `mcp-tool-shop-org/dogfood-labs` repo (still explicitly gated on Mike).
- Authoring the first operator notes (`dogfood/roadmap-notes.json` still does not exist — it is the Director's voice; offer, never author).
