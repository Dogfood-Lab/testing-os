# Stage D kickoff — dogfood swarm `swarm-1784091637-5127`

Paste this into a fresh session at `E:/AI/testing-os`. You are the **Coordinator**.

---

## Read these first, in this order

1. `swarms/CLAUDE.md` — the ethos. Read it properly; it is short and it is why the rest works.
2. `swarms/PROTOCOL.md` → **"Fixing a class, not an instance"** (after "Proving a gate"). This is law.
3. `HANDOFF.md` — top block. The **waves 30–33** entry is the state of the world.
4. `CLAUDE.md` (repo root) — repo etiquette.

**Then verify everything below against the live sources.** Do not trust this file. It was written by the previous coordinator, whose prose was found defective by the docs lane on **five consecutive waves**. Ids come from the DB. Scope comes from the frozen map. Coverage comes from the gate's own output.

```bash
node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
git log --oneline -8
gh run list --branch swarm/health-amend-a-1784091637 --limit 3
```

---

## Where things stand (verified 2026-07-17, wave 33)

| | |
|---|---|
| Run | `swarm-1784091637-5127`, wave **33/33**, `health-audit-b [verified]` |
| Branch | `swarm/health-amend-a-1784091637` @ `68abc09`, pushed, **CI green** (last 3 runs) |
| Findings | **0 CRIT · 0 HIGH · 11 MED · 16 LOW** open (337 fixed, 2 deferred, 1 rejected, 12 unverified) |
| Floor | `npm run verify` exit 0 in **both** git-bash and PowerShell · `swarm verify` receipt **#27** PASS |
| Pin gate | 90 declared / 256 grandfathered / 30 allowlisted / **0 orphans** |
| Worktrees | clean — only the unrelated pre-existing `schema-conf` |

**Stage A** (bug/security) exited at 0 CRIT + 0 HIGH. **Stage B** (proactive audit) and **Stage C** (humanization amend) are complete. **Stage D (Visual Polish) is next and is what you are here for.**

---

## Your task: Stage D

Protocol checklist (`swarms/PROTOCOL.md`, ~line 626) — **read it yourself**:

```
HEALTH PASS — STAGE D (Visual Polish)
15. [ ] Launch 5 visual-polish audit agents
16. [ ] Present visual findings to user for approval
17. [ ] Launch 5 stage-d-amend agents with exclusive file ownership
18. [ ] Verify build passes
19. [ ] Clean bill of health confirmed — proceed to Feature Pass
```

The lens (PROTOCOL.md ~206–214): typography/spacing/layout, iconography & asset quality, color/theming/**dark-mode parity**, animated demos/motion, command-palette & status-bar presentation, first-run/onboarding visuals, settings UI grouping, marketplace/landing-page visuals.

**This repo's real visual surface**, since it is a CLI monorepo and not a web app:
- `site/**` — the Astro Starlight handbook (the genuine one; `pages.yml` already runs **pa11y** against it)
- The **CLI's terminal presentation** — `swarm status`, findings render, error envelopes. For a CLI, the terminal *is* the UI.
- README badges/logos, social cards, `SCORECARD.md`.
- Existing gates worth reading first: `scripts/check-accent-color.test.mjs`, `scripts/check-dashboard.test.mjs`.

### Commands

```bash
# Dispatch directly. Do NOT use `swarm advance` — see the trap below.
node packages/dogfood-swarm/cli.js dispatch swarm-1784091637-5127 stage-d-audit --preview
node packages/dogfood-swarm/cli.js dispatch swarm-1784091637-5127 stage-d-audit

# ... launch 6 Sonnet lanes against the generated briefs ...

node packages/dogfood-swarm/cli.js collect swarm-1784091637-5127 --all
node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
```

Then: present findings → `swarm approve` → `dispatch stage-d-amend --isolate --skip-verify` → merge → **one serial `npm run verify`** → commit → `swarm verify` → `swarm clean --apply --force`.

---

## Traps that WILL bite you (every one of these cost this run real time)

**`swarm advance` will send you to the wrong place.** From `health-audit-b` its `next` is `health-audit-c`, not `stage-d-audit`. Worse, its finding-gate only checks CRIT/HIGH — so with Stage B/C/D lenses producing almost nothing but MED/LOW, it will **always** skip past an amend. `dispatch` does not gate on the run's phase pointer (proven), so **dispatch the phase you want directly**. PROTOCOL.md contradicts itself here: line 149 says every stage is audit→amend; the operator checklist and lines 279–280 say B=audit, C=amend. **The checklist is the concrete one and is what this run followed.**

**The dispatch preview's routing sum is your tell.** If it sums to N-1 of N approved, a finding is orphaned. This bit twice, and it is **two different gaps**: root `package.json` → the `shared` domain, which dispatch never gives an agent (`F-3af2f9c8`); `packages/<name>/package.json` → matches **no domain at all**, because `shared`'s globs are root-level and minimatch does not cross a separator without a globstar (`F-6a5eb347`). Both need coordinator disposal. **Check the sum every dispatch.**

**Silence no longer closes a finding — and this is the most important mechanism to not break.** An absent prior closes ONLY if its **owning** domain declares its id in a `confirmed[]` array. Undeclared → `unverified` (open, re-asked). A wrong-domain declaration is discarded. This exists because wave 28 closed 9 untouched findings on manufactured silence, and because two later fixes reintroduced the same defect one layer down. `classifyFindings` has **three non-test call sites across two files** — `collect.js:1058` and `revalidate.js:609` are the two that can close by absence, and both are gated; `revalidate.js:491` passes **no scope at all** and its caller hardcodes `fixed:[]/unverified:[]`, so it is structurally inert to this and closes nothing (verified by both the verbs lane and by grep). If you touch this mechanism, that is the sweep — and note the previous coordinator first wrote "exactly two callers" in this very file and caught it only by running the grep it tells you to run. **Your Stage D briefs carry the CONFIRM queue automatically. Do not tell agents their silence closes anything.**

**Do not restate finding ids or scope in agent prompts.** Point at the brief. The previous coordinator made three prompt errors doing this — assigning one lane another lane's finding (they would have collided in separate worktrees on the same file), and citing `F-7d3a91ec`, an id that exists in **no run**, because it relayed an agent's *reported* id instead of querying the DB. `upsertFindings` **derives** content-addressed ids; the agent-reported id and the stored id are different objects. Every time, a lane caught it by checking the map. Let the brief be the contract.

**Citing an F-id in a source comment creates a source pin.** It caught the previous coordinator **four times**; there are now 4 allowlist entries because of it. If your comment genuinely cross-references (no fix behind it), allowlist it with a real justification. **Never allowlist a real fix pin — that is the laundering the AST rewrite exists to prevent.** A test-internal fix with no source change gets **no** tag (F-7d4ac5ce precedent; a dangling tag blocks the gate).

**Never write a literal glob containing star-slash into a block comment.** It closes the comment. The suite went 161-red on exactly that, in `collect.js`, an hour before this file was written.

**Windows/Linux parity is real here.** `runStep` spawns with `shell: true`, so args are shell-interpreted: an unquoted `(` dies on `/bin/sh` and passes on `cmd.exe`. `scripts/check-step-fixtures.test.mjs` gates it. And **verify in the shell you actually ship** — that gate itself shipped broken in PowerShell because it was "verified" from git-bash, the one shell where its defect is invisible.

**Isolated worktrees contain junctions.** Agents junction `node_modules` to reach `better-sqlite3`. **A recursive delete follows the junction into the real `node_modules` and destroys it.** Unlink non-recursively first (`[System.IO.Directory]::Delete(path, $false)`), then remove. This repo has already eaten 462 recursive junctions and a hung git once.

---

## Standing discipline

- **Serial final verify.** Amend lanes run `--skip-verify`; **you** run ONE unpiped `npm run verify` on the merged tree. It has caught real cross-lane defects every single time.
- **The lanes are better at this than you are.** Every mechanism the previous coordinator shipped solo had a defect a lane found: a missed second call site, a missing domain check, a gate verified in the wrong shell. **Give your own work to the skeptics and tell them to attack it.** Three lanes independently cleared its modified pins; two confirmed its ownership-authority choice. That only worked because they were asked to disprove it.
- **The coordinator is not above any of this.** The most reliable failure mode on this run was the coordinator — instance-patching, citing ids that don't exist, prose defects five waves running. When an agent says you are wrong, it read the map; you remembered it.
- **A finding is a claim too.** The wave-31 docs amend **withdrew** a finding after re-deriving it (`F-989a2c28`: "17 checked" was correct for its stated A–D scope). Apply the same scrutiny to findings you are handed as to the code.
- **Honest partial beats an overclaim.** "I swept and found none" is evidence. A sweep you did not run is a finding waiting to be filed against you.

## Open debt (disclosed, not hidden — do not re-file, siblings are fair game)

- `lib/log-stage.js:90` — unguarded primary `console.error`; the shared root cause of the retry-warn class (canonical id `F-36fdebca`, open — an earlier revision of this line carried the lane's local label `F-7f2a9c4d`, which exists in no run).
- `revalidate.js`'s call site is correct but has **no** cross-domain regression test — revert it and the whole suite still passes (canonical id `F-a9c399ce`, open, filed independently by two lanes — the two ids an earlier revision cited here were agent-local labels, not DB ids).
- `init.js`/`persist.js`/`adjudicate.js` — zero `logStage` despite being consequential.
- `wave_receipts` can't go append-only without a `db/schema.js` edit (`UNIQUE(wave_id)`, `foreign_keys=ON`).
- **No lawful verb reopens a wrongly-closed finding.** The "Three R's" contract has no answer for a bad classification; the previous coordinator used a guarded, dry-run-first DB repair with a `finding_events` row per finding.
- Open question nobody resolved: should a **`bridge`**-class domain's confirmations carry the same trust as an `owned`-class domain's?

---

## Ask the Director before

- Advancing past Stage D into the Feature Pass.
- Merging this branch to `main` (31+ commits; prior swarm work landed via PR — #31/#33/#34).
- Any `swarm rewind` (it erases) or DB repair.
