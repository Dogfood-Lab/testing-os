# Wave 40 kickoff — dogfood swarm `swarm-1784091637-5127`

Paste this into a fresh session at `E:/AI/testing-os`. You are the **Coordinator**. This file supersedes `STAGE-D-KICKOFF.md` (kept as historical record).

---

## Read these first, in this order

1. `swarms/CLAUDE.md` — the ethos. Short, and it is why the rest works.
2. `swarms/PROTOCOL.md` → **"Fixing a class, not an instance"**. Law.
3. `HANDOFF.md` — top block. The **WAVES 38–39** entry is the state of the world; the WAVES 34–37 entry is how it got there.
4. `docs/trajectory-and-closure.dispatch.md` — the Feature Pass contract (T1–T6, C1–C4, the refusals, and its own audit-forced amendments). The features you are auditing were built against it.
5. `CLAUDE.md` (repo root) — repo etiquette.

**Then verify everything below against the live sources. Do not trust this file.** It was written by the previous coordinator, who this very session: pushed once with a gate red because it piped the gate through `tail`; guessed a JSON shape wrong twice before reading the file; and let a contract flip twice by accepting a dispute without amending the contract text. Ids come from the DB. Scope comes from the frozen map. Coverage comes from the gate's own output.

```bash
node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
node packages/dogfood-swarm/cli.js roadmap show swarm-1784091637-5127
git log --oneline -8
gh run list --branch swarm/health-amend-a-1784091637 --limit 3
```

---

## Where things stand (verified 2026-07-17, end of wave 39)

| | |
|---|---|
| Run | `swarm-1784091637-5127`, wave **39/39** (`feature-execute` collected) |
| Branch | `swarm/health-amend-a-1784091637` @ `e3d69bf`, pushed, **CI green** (every push this session) |
| `main` | health pass merged via **PR #58** (`125661c`), handbook deployed, self-dogfood + ingest loop closed; `main` has an ingest-bot commit on top |
| Findings | 447 total ever filed · **379 fixed** · **40 approved** (the built features, awaiting confirmation) · 12 deferred · 16 rejected · 0 unverified |
| Floor | `npm run verify` **EXIT 0** in PowerShell (pass 8 of 8); `swarm verify` receipts recorded |
| Pin gate | 133 declared / 256 grandfathered / 34 allowlisted / **0 orphans** |
| Schema | **v10 live** (the control-plane DB migrated through the ordinary `openDb` ledger path) |
| Roadmap | `dogfood/roadmap/latest.json` exists and is **committed** — the first compiled trajectory artifact; its attention list correctly ranked HANDOFF.md and PROTOCOL.md as this repo's hottest files |
| Worktrees | clean — only the unrelated pre-existing `schema-conf` |

**What shipped in the Feature Pass:** `swarm reopen` and `swarm close --as fixed` (evidence-bearing, dry-run-first, mutually compensating — their inaugural apply closed the three wave-38 mis-declaration strandings), `swarm roadmap compile|show`, schema v10 (`closure_kind`, `verified_how`, `filed_by_domain`, `finding_events.actor`, `roadmap_artifacts`), the roadmap compiler family in `lib/roadmap/`, verify-time roadmap gates, and the full handbook surface (trajectory page, cli-reference, error-codes, state-machines).

**Director grants recorded 2026-07-17 (this session's messages):** GO on the Feature Pass; **full authority to merge, push, and send study-swarms**; GO on closing the reopen gap. Rely on them; re-confirm only if you are changing their scope.

---

## Your task: Wave 40 — the confirming audit

The 40 approved findings are features-with-code-landed. By design they close ONLY when their **owning domains** verify them by execution and declare them in `confirmed[]` — the same lawful path wave 36 used for wave 35's fixes. This is also the audit that attacks the Feature Pass's own work (the confirming audit catches instance-patches — it has on effectively every amend this run).

```bash
node packages/dogfood-swarm/cli.js dispatch swarm-1784091637-5127 feature-audit --preview   # check the routing sum
node packages/dogfood-swarm/cli.js dispatch swarm-1784091637-5127 feature-audit
# launch 6 Sonnet lanes against the generated briefs (docs lane audits, never writes)
node packages/dogfood-swarm/cli.js collect swarm-1784091637-5127 --all
```

Then: triage (the closure verbs now exist for strandings) → amend wave 41 if the audit warrants → merge → **one unpiped serial `npm run verify`** → commit → `swarm verify` → `swarm clean --apply --force` → HANDOFF.

**Hand the wave-40 lanes the residuals list below** — each is a disclosed defect or seam awaiting a canonical finding id. Do not fix them yourself; the lanes file them, the DB mints the ids.

### Residuals the previous session disclosed (audit fodder, not hidden)

- **Schema-vs-envelope vocabulary split**: `dogfood-roadmap.schema.json` says `operator_notes`/`run_id`/`generated_at`; the CLI artifact writes flat `notes`/`runId`/`compiledAt` + a nested `sections` duplicate. Two concrete exhibits already: the notes-integrity gate had to be re-aimed at the live shape, and the drift gate deliberately validates only the `latest.json` pointer.
- **`notesPath` bakes an absolute machine path** into the committed artifact (`commands/roadmap.js` → `readOperatorNotes`), against the adapter's own repo-relative principle.
- **`operator_closed` exists in `EVENT_TYPES` but nothing writes it** — `cmdClose` writes event type `'fixed'` (mirrors status) with `closure_kind='operator'` carrying provenance. Either the constant is dead or the event type is wrong; the audit decides.
- **F-07895c2c (dispatch seeding flags) is approved-unbuilt** — the digest injection is wired but dormant; its allowlist entry must convert to a real `@pins` tag when built.
- **`commands/resume.js:335`** passes a domain-name-less object that silently no-ops the new `filed_by_domain` fallback (core's seam note, unaddressed).
- **`commands/collect.js`** still carries its own hardcoded phase lists instead of importing `AUDIT_PHASES`/`AMEND_PHASES` from `lib/phases.js` (the F-274e7ac5 completion).
- **Five wave-39 allowlist entries** carry `revalidate_by: 2026-08-17`.
- **`dogfood/roadmap-notes.json` does not exist** — the notes array is empty. The DIRECTOR may want to author the first operator notes (≤7, typed `theme|open-question|invariant`, each with `expires`; an `invariant` must name its `enforced_by` gate). Offer this; do not author them yourself.

---

## Traps that WILL bite you (every one cost the previous session real time)

**UNPIPED means every gate, not just verify.** The previous coordinator ran `check-doc-drift.mjs | tail -1` in a `&&` chain — the pipe's exit status is `tail`'s, the chain proceeded, and a red gate got pushed. Run gates bare; read exit codes from the tool result.

**An accepted dispute is not a decision until the contract text says it.** The `--as` enum flipped twice: a narrowing dispute was accepted at triage, the dispatch doc was never amended, and the merge reconciler lawfully converged to the stale document. When you accept a design change, amend the contract IN THE SAME ACTION.

**`approve --all` takes only `new` + `recurring`.** `unverified` is unroutable to an amend. The recovery is now lawful — `swarm reopen`/`swarm close` — but the sequencing rule stands: amend promptly after approving; an intervening full-coverage audit flips absent, undeclared `approved` rows to `unverified`.

**Feature findings may be file-less.** `filed_by_domain` (v10) now routes them — but **check the dispatch preview's routing sum every time**. If it under-routes, the wave-39 precedent is a DB-generated per-domain work order (never hand-typed ids); the generator pattern is in that session's transcript and trivially recreated: match lane outputs to DB rows by exact description.

**The ownership gate fires on unowned surfaces, including on you.** `fixtures/` at the repo root, `packages/dogfood-swarm/README.md`, and every `swarms/*.md` match NO domain. A lane touching one fails collect; the lawful split is: amend the lane commit to drop the file, `swarm revalidate --apply`, reland as disclosed coordinator work. And when amending: `git rm -r` over-deletes — restore the path from the base commit instead (`git checkout <base> -- <path>`), which the previous session learned by nearly deleting the whole fixtures tree.

**Re-reports match by declared id + EXACT file** (owner-gated, mechanical since `0685ab1`). The brief says so. Believe the brief, not older folklore about fingerprint luck.

**Feature-audit briefs carry the CONFIRM queue only since `f7b5445`.** Wave 40 is the first wave to exercise that fix live — verify the generated briefs actually contain the "Known OPEN findings" section before launching lanes; if they don't, that is a finding, and the lanes fall back to DB-sourced verification like wave 38 did.

**Cross-lane seams are normal; the serial verify is the oracle.** Red-in-isolation contract tests, fixture-level bridges, and a dedicated reconciliation lane that ESCALATES conflicts instead of bending tests — all proven this run. Expect multiple verify passes on a big merge; every one of the eight passes last session caught something real.

**Coordinator mechanism changes require adversarial review.** The running score: 0-for-4 shipping solo, 2-for-2 with skeptic rounds — and round 2 exists because round 1's fixes are new mechanism too.

**`swarm advance` still routes wrong and gates only on CRIT/HIGH.** Dispatch the phase you want directly.

**Isolated worktrees contain junctions.** `swarm clean --apply --force` is the sanctioned destruction. Never manually recursive-delete a worktree.

---

## Standing discipline

- Serial final verify: ONE unpiped `npm run verify` on the merged tree, in PowerShell.
- The lanes are better at this than you are. Give your own work to skeptics told to break it.
- A finding is a claim too — verify what lanes hand you (this session refuted a claimed id-collision with one DB query).
- Honest partial beats overclaim. Disclose residuals in the output, not in a drawer.
- Read the source, don't recall it. The previous session's worst half-hour was two wrong guesses at a JSON shape that one `Object.keys()` resolved.

## Ask the Director before

- Entering Phase 9 (final test) / Phase 10 (full treatment) or cutting **v1.10.0** (the CHANGELOG's Unreleased section is already written).
- Any `swarm rewind` or raw DB repair (the closure verbs cover the known cases now — repairs should be rarer than ever).
- Deleting the legacy `mcp-tool-shop-org/dogfood-labs` repo (grace window long passed; still explicitly gated on Mike).
- Authoring the first operator notes (offer it — it is the Director's voice the trajectory layer was built to carry).
