# Next-cycle kickoff — dogfood swarm `swarm-1784091637-5127` (housekeeping cycle 1 + trajectory)

Paste the block below into a fresh Coordinator session at `E:/AI/testing-os`. This file is the rolling live entry point, overwritten each cycle (the executed 2026-07-17 deferred-tail kickoff lives in git history at `bfe9c55`). Written 2026-07-18, right after the burndown sessions closed the tail (487 fixed / 17 rejected / 3 deferred / 0 open), the Director's operator notes landed at roadmap sequence 7, and the housekeeping ritual became law.

---

```
Continue the dogfood swarm on E:/AI/testing-os as Coordinator. Run
swarm-1784091637-5127 is OPEN at the `test` phase — the deferred tail is burned
down (ledger 487 fixed / 17 rejected / 3 deferred / 0 open), dashboard v1.1 is
live, and the Director's operator notes now ride in the roadmap artifact
(sequence 7). This session is the FIRST full housekeeping cycle plus the two
trajectory notes. Do NOT advance the run to `complete` and do NOT archive —
dogfooding continues after.

READ FIRST, in order (then verify everything below against live sources — this
prompt is orientation, not truth):
1. dogfood/roadmap-notes.json — THE DIRECTOR'S VOICE: five STANDING ORDERs +
   two TRAJECTORY notes. Ritual step 0 is reading these back. Render them:
   node packages/dogfood-swarm/cli.js roadmap show swarm-1784091637-5127
2. docs/housekeeping-ritual.md — the protocol this session executes, steps 0-6,
   compensators included.
3. swarms/CLAUDE.md — the ethos ("if nothing surprised you, the wave failed").
4. swarms/PROTOCOL.md → "Fixing a class, not an instance" — law, five sub-laws.
5. docs/case-file-contract.md — model tiering is law: Sonnet executes, the
   non-Claude jury verifies, the coordinator never jurors; pass model= on every
   Agent() call.
6. HANDOFF.md — the top two entries (BURNDOWN SESSION TWO, then DEFERRED-TAIL
   BURNDOWN) are the state of the world, including every disclosed seam.
7. C:/Users/mikey/.claude/projects/E--AI-testing-os/memory/ — especially
   director-conversations-plain-english-first.md (LAW for any Director-facing
   ask) and swarm-blind-spots-need-the-coordinator.md (CI is the only platform
   oracle, version-conditional legs included).

VERIFY STATE (don't trust the numbers here):
  node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
  node packages/dogfood-swarm/cli.js findings swarm-1784091637-5127 --status=deferred
    # expect 3: the pre-v10 NULL-columns pair (waits on a real reader) + the
    # cmdFindings/buildDigest cross-domain seam. The verb exists now — use it.
  git log --oneline -5 ; git fetch origin main   # the ingest loop moves main on
    every push — pull --rebase before pushing; it settles cleanly
  gh run list --branch main --limit 3

THE SESSION, in order:

(0) RITUAL STEP 0 — notes readback. Re-affirm the standing orders; the two
    TRAJECTORY notes are (c) and (d) below. A session that leaves every
    trajectory note untouched must say why.

(a) RITUAL STEPS 1-2 — environment preflight (swarm doctor + the manual checks
    the doctor does not yet cover: disk free, control-plane.db + WAL size,
    swarms/<run>/ brief bloat, stranded worktrees via swarm clean dry-run);
    staleness sweep (drift gate + pins gate bare — delete anything reported
    stale under standing authority; both gates must exit 0 with zero warns).

(b) RITUAL STEP 3 — THE FIRST AUTHORED DRAIN TRANCHE: drain >=5 of the 256
    grandfathered ids. Baseline 2026-07-18: ZERO are drainable for free — each
    drain means authoring the genuine red-able @pins test for that id (or
    establishing it as a removable orphan), then removing the manifest entry
    AND recomputing EXPECTED_GRANDFATHER_MANIFEST_HASH in the SAME commit (the
    recompute command lives in that constant's own doc comment; the gate
    hard-fails otherwise). Pick the tranche from the manifest ids whose
    findings have the clearest still-live fix sites — a Sonnet lane per 2-3
    ids works. Progress is public: the drain meter on the dashboard moves.

(c) TRAJECTORY — guardian-into-doctor: extend swarm doctor's preflight with
    the environment-health checks from (a) so they stop being manual. Direction
    locked by the Director: extend doctor, do NOT fork the guardian repo.
    Check where doctor's checks live before assigning the lane (commands/ vs
    lib/ decides verbs vs core ownership). When it ships, RETIRE the
    open-question note: remove it from dogfood/roadmap-notes.json, recompile,
    and tell the Director in plain English what replaced the manual steps.

(d) TRAJECTORY — dashboard v1.2. DO NOT jump to a prompt. The
    plain-english-first law applies: look at the data WITH the Director first —
    what would trend lines over time, drain-meter progress, ledger movement
    between compiles, and fleet freshness actually show him today — agree on
    the panel set in his words, THEN write the Claude Design prompt (the v1.1
    prompt in HANDOFF/chat history is the template; check-dashboard gate,
    90 KB budget, and the preservation list still bind). Known v1.2 nits
    ledger: the v1.0 aggregate-pill degradation gap, attention scores
    flattening to 0.00 under toFixed(2).

(e) RITUAL STEPS 4-6 + small seams, as the session has room: brief diet check
    (never raise the threshold — Director decision); ledger hygiene (the 3
    deferred still validly waiting?); fleet glance (baseline 12/26 stale,
    record the trend, do not action — fleet reactivation is Director-sequenced).
    Disclosed seams available for pickup: align readOperatorNotes to require
    `expires` (the schema does; the CLI validator does not — they disagreed
    live on 2026-07-18); validate-scenarios.test.mjs's narrower reimplemented
    walk; the cargo measurement pair (dead cargo branch shadowed by the pytest
    regex; multi-crate workspaces measure only the last crate's summary);
    attention.js's churn_available collapse (same class as the fixed drain
    `available` drop).

DISCIPLINE (earned, expensive — every line cost a real defect):
  - Ids from the DB, scope from the frozen domain map (docs now owns
    swarms/*.md; swarm-cp-core owns packages/dogfood-swarm/package.json),
    coverage from the gate's own output. Never memory.
  - Run gates BARE and read the redirected file's own exit line — never trust
    a task-notification's "exit code" for a wrapped command, and never pipe
    the authoritative run (the pipe trap bit twice more on 2026-07-18).
  - ONE serial `npm run verify` on the merged tree before every push; never
    mutate git state while a background verify runs; `git commit -F -` with a
    single-quoted heredoc for any message with backticks.
  - Any test that spawns the CLI pins SWARM_DB INSIDE the spawn call's own
    parens (the WAL meta-sweep enforces; an options object built outside the
    parens gets flagged).
  - Keep live-child canary tests reporter-unpinned — format drift SHOULD red
    them; that canary caught the Node-24 spec-reporter engine gap.
  - Closures: reopen first for deferred items, then
    `swarm close --as fixed --verified-how operator_evidence` with the commit
    + a real execution proof; `swarm defer/reject --reason` otherwise.
  - EVERY Director-facing ask: plain-English conversation first, you do ALL
    the synthesis, read the result back in his words before saving anything.
    Never hand him a jargon artifact to edit. (Memory file above; violated
    once, corrected loudly — do not repay it.)
  - Solutions, not problems: arrive with the fix or the plan (standing order).

ASK THE DIRECTOR BEFORE: raising the brief-size threshold; any fleet-side push
or reactivation; changing the CONTENT of dogfood/roadmap-notes.json beyond
retiring a completed trajectory note with evidence (his voice — readback + his
yes required for anything new); deleting the legacy mcp-tool-shop-org/
dogfood-labs repo; any raw DB write. The v1.11.0 exit ramp is available if the
session lands the doctor extension + a drain tranche: offer the waypoint, the
Director decides — a spotless audit is never the bar (standing order #1).
```
