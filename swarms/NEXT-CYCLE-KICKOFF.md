# Next-cycle kickoff — dogfood swarm `swarm-1787700871-d537` (post-v1.11.0 housekeeping)

Paste the block below into a fresh Coordinator session at `E:/AI/testing-os`. This file is the rolling live entry point, overwritten each cycle (the executed 2026-07-18 5127 housekeeping kickoff lives in git history). Written 2026-08-26 by the Grok Executor after Phase 10 cut **v1.11.0**.

---

```
Continue the dogfood swarm on E:/AI/testing-os as Coordinator. You are
NOT starting a new run. You are NOT resuming swarm-1784091637-5127
except to leave it at `test`.

Live run: swarm-1787700871-d537
Status:   test  (promotion 78, wave 15 feature-audit advanced)
Shipped:  v1.11.0  (e697247, tag v1.11.0, six @dogfood-lab/* on npm)
Do NOT complete either run. Do NOT dispatch … test. test is a run
status, not a phase.

This session is the housekeeping ritual AFTER the release (standing
order #2). Typed leftovers from Phase 10 are the material, not a new
health pass unless the Director says so.

READ FIRST, in order (then verify everything below against live
sources — this prompt is orientation, not truth):
1. dogfood/roadmap-notes.json — THE DIRECTOR'S VOICE. Ritual step 0.
   Render: node packages/dogfood-swarm/cli.js roadmap show swarm-1787700871-d537
2. docs/housekeeping-ritual.md — steps 0-6, compensators included.
3. docs/dogfood-swarm-3.state-and-trajectory.md — Director-facing NOW/NEXT.
4. swarms/PROTOCOL.md → Phase 9 is a run status; coordinator class;
   isolate default; F-d8699ef5 skip-amend trap.
5. swarms/CLAUDE.md — ethos ("if nothing surprised you, the wave failed").
6. docs/case-file-contract.md — if you dispatch: Sonnet/Grok executes,
   non-Claude jury verifies, coordinator never jurors; pass model= on
   every seat. This swarm's convention: grok-4.5 on domain agents,
   jury excludes xAI.
7. ~/.grok/memory/topics/testing-os.md — pointer only.
   Repo artifacts win on conflict.

VERIFY STATE (don't trust the numbers here):
  node packages/dogfood-swarm/cli.js status swarm-1787700871-d537
    # expect: Status test · docs coordinator · 0 CRIT/0 HIGH open
    #         fixed 33 / deferred 4 / unverified 11
  node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
    # expect: Status test. Do not complete. Do not dispatch.
  node packages/dogfood-swarm/cli.js findings swarm-1787700871-d537 --status=deferred
    # expect 4 HIGH, all from wave-1 Set-1:
    #   F-71d4ce45  checkout still v6.0.3 — reopen to TAKE 7.0.1
    #   F-5764a279  setup-node still v6.4.0 — audit then TAKE v7
    #   F-44eb48f2  handbook CLI verb count (docs leftover)
    #   F-ca8f3e37  PROTOCOL redrive table vs following paragraph
  node packages/dogfood-swarm/cli.js findings swarm-1787700871-d537 --status=unverified
    # expect 11 MED/LOW. Do not close them as a clean-ledger move.
    # F-5e021f01 = Vitest 4.1.9→4.1.11 note (patch, not Vitest 5).
    # F-b7468c6a = six allowlist entries past revalidate_by (WARN).
  node packages/dogfood-swarm/cli.js doctor
    # 7 checks. Env trio (disk-free, control-plane-size, stranded
    # worktrees) shipped in v1.11.0. Brief bloat is still ritual
    # step 4, not a doctor check.
  git log --oneline -5 ; git fetch origin main
    # ingest/self-dogfood move main after a release. pull --rebase
    # before any push; it settles.
  gh run list --branch main --limit 3
  npm view @dogfood-lab/dogfood-swarm version
    # expect 1.11.0

YOU MIGHT THINK / LIVE TRUTH:
  Resume 5127                  → 0-open, status test, T4 already seeded d537
  dispatch … test              → DISPATCH_INVALID_PHASE
  swarm advance off test       → treatment, then complete. Do not.
  docs is owned / shared       → docs is coordinator (exclusive, skipped)
  isolate is opt-in            → isolate is the CLI default; --no-isolate wins
  doctor still misses env      → 7/7 PASS; remaining gap is brief bloat
  #67 / #65 still open         → closed by e697247
  latest.json is 5127.7        → dogfood/roadmap/latest.json → d537.1
  Pop the stashes              → stash@{0} WIP, stash@{1} ingest indexes. Leave them.
  C:\WINDOWS\system32 is cwd   → cd E:/AI/testing-os first

THE SESSION, in order:

(0) RITUAL STEP 0 — notes readback. Re-affirm the five STANDING ORDERs.
    TRAJECTORY notes:
      (a) dashboard v1.2 — still needs Director words before a Claude
          Design prompt. Do not jump to a prompt. Leave unless he is in
          the room.
      (b) guardian-into-doctor — PARTIALLY SHIPPED in v1.11.0 (disk-free,
          control-plane-size, stranded-worktrees). Brief bloat is still
          ritual step 4. Offer retirement of the env half in plain
          English; do not silently drop the note.

(a) RITUAL STEPS 1-2 — doctor (already 7 checks); still measure wave-brief
    size under swarms/swarm-1787700871-d537/ (doctor does not). Staleness
    sweep: drift gate + pins gate BARE. Six allowlist entries are past
    revalidate_by (F-b7468c6a / gate WARN). Standing authority is delete
    if they exempt nothing; refresh revalidate_by with a reason if they
    still hold. Both gates must exit 0. WARNs are not a silent skip.

(b) RITUAL STEP 3 — drain >=5 of the 256 grandfathered ids. Baseline
    still 0 drained. Each drain is an authored @pins test (or a proven
    orphan) + hash recompute in THE SAME commit. Do not skip this because
    a release just shipped — after-release is when the ritual runs.

(c) REOPEN TO TAKE (only these two, and only with --apply after a dry-run):
      swarm reopen swarm-1787700871-d537 --ids F-71d4ce45,F-5764a279 \
        --reason "take Dependabot checkout 7.0.1 and setup-node v7" \
        --evidence "<live SHA / PR #62 #56>"
    Then a right-sized ci-tooling amend. HOLD TS 7 (#55), js-yaml 5 (#50),
    Vitest 5. Vitest 4.1.11 (F-5e021f01) is a patch note, not a new id.

(d) RITUAL STEPS 4-6 as room allows: brief diet (never raise the
    threshold); ledger hygiene (the 4 deferred still validly waiting —
    two are the takes in (c), two are leftover docs HIGHs, not silent
    closes); fleet glance. Record the trend. Do not action fleet
    reactivation.

(e) If the ledger moved: swarm roadmap compile swarm-1787700871-d537
    Sequence 1 is committed and schema-valid. Sequence-free mirror
    d537.json is allowlisted (F-feeaef78 cost). Do not rewrite .1.json
    (T5). top_recurring timestamps are RFC 3339 at the compile boundary
    as of v1.11.0 — do not regress to SQLite 'YYYY-MM-DD HH:MM:SS'.

DISCIPLINE (earned this swarm + prior):
  - test is a run status. dispatch … test is DISPATCH_INVALID_PHASE.
    CLI used to print "Next: dispatch … test" — fixed in e697247.
  - Advance after 0 CRIT/HIGH skips the matching amend (F-d8699ef5).
    Needed amend = dispatch health-amend-b / stage-d-amend, not advance.
  - docs = coordinator. Never reclassify to shared to skip a seat.
  - --isolate is default. --no-isolate shares and wins if both present.
  - Ids from the DB. Coverage from the gate. Never memory.
  - Gates BARE. Read the redirected file's own exit line.
  - ONE serial npm run verify on the merged tree before every push.
  - git commit -F - for any message with backticks.
  - Do not pop stash@{0} / stash@{1}.
  - Dependabot HOLDs stay HOLD until the Director lifts them.
  - Closures: reopen first, then swarm close --as fixed --verified-how
    operator_evidence with commit + execution proof.
  - Director-facing asks: plain English first, read back in his words.
  - Solutions, not problems (standing order).

ASK THE DIRECTOR BEFORE: a new swarm init; completing d537 or 5127;
raising the brief-size threshold; any fleet-side push; changing
roadmap-notes.json beyond retiring a completed trajectory note with
evidence; taking TS 7 / js-yaml 5 / Vitest 5; deleting the legacy
dogfood-labs repo; any raw DB write; popping the parked stashes.
```
