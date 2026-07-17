# Next-cycle kickoff — dogfood swarm `swarm-1784091637-5127` (deferred-tail burndown)

Paste the block below into a fresh Coordinator (Opus) session at `E:/AI/testing-os`. This file supersedes `WAVE-42-KICKOFF.md` as the live entry point (that file is kept as historical record). Written 2026-07-17, right after v1.10.0 shipped.

---

```
Continue the dogfood swarm on E:/AI/testing-os as Coordinator (Opus). Run
swarm-1784091637-5127 is OPEN at the `test` phase — v1.10.0 shipped (all six
@dogfood-lab/* packages on npm, GitHub Release live) but that was a WAYPOINT,
not closure. Your job this session: burn down the 18-item deferred tail the
wave-44 confirming audit left, honestly. Do NOT advance the run to `complete`
and do NOT archive anything — dogfooding continues after.

READ FIRST, in order (then verify everything below against live sources — this
prompt is orientation, not truth):
1. swarms/CLAUDE.md — the ethos ("we find solutions; closing findings is a side
   effect"; "if nothing surprised you, the wave failed").
2. swarms/PROTOCOL.md → "Fixing a class, not an instance" — law.
3. docs/case-file-contract.md — THE verification funnel (Sonnet executes, a
   family-diverse non-Claude jury verifies, `swarm verify` is the only law;
   Opus coordinates and never jurors). Model-tier every lane: pass model= on
   each Agent() call — all-Opus is a protocol violation.
4. HANDOFF.md → the "WAVE 44 + RELEASE" entry is the state of the world; it also
   lists three self-inflicted process traps from last session — don't repay them.
5. C:/Users/mikey/.claude/projects/E--AI-testing-os/memory/ →
   confirming-audit-is-never-clean.md (the release bar is "the pass's findings
   are lawfully disposed", not "zero new findings").

VERIFY STATE (don't trust the numbers here):
  node packages/dogfood-swarm/cli.js status swarm-1784091637-5127
  node packages/dogfood-swarm/cli.js findings swarm-1784091637-5127   # or query
    the DB directly for status='deferred' — 18 rows, the authoritative queue
  git log --oneline -5 ; git fetch origin main   # main moves via the self-dogfood
    ingest loop on every push — pull --rebase before pushing, it settles cleanly
  gh run list --branch main --limit 3 ; npm view @dogfood-lab/dogfood-swarm version

THE TASK — triage the 18 deferred, then act by category (get the ids from the DB,
never from memory):
  (a) ACTIONABLE small fixes → `swarm reopen` them (deferred→recurring, needs
      --reason + --evidence), then a right-sized amend wave (this tail is small —
      3-4 lanes or coordinator-direct for trivia; the protocol scales down, don't
      force 6 lanes + jury for ~10 small items). Candidates worth a look:
      F-857ea625 (stale EXPECTED-RED test comments), F-92a05b18 (win32-only
      resolveSh branch), F-c7752910 (dogfood/ has no .gitignore), F-04ecea6d
      (swarm verify has no --format=json), F-920a93bf (ROADMAP_UNDO_INVALID_
      SEQUENCE shadowed by an untyped CLI guard), F-8c6c0deb (allowlist has no
      staleness detection).
  (b) ACCEPT-FOREVER / no-reader-yet → leave deferred, refresh the disclosure:
      F-ad2d6318 + F-c2a22b93 (pre-v10 NULL closure_kind/verified_how — reopen
      only when an aggregate READER lands), F-00c2b7fd (degraded-drain
      observability), F-b48cb209 (grandfather-manifest crypto disclosure).
  (c) DESIGN QUESTIONS for the Director (don't decide solo): F-6a5eb347 +
      F-d0c33457 — the frozen domain map owns neither root package.json nor the
      swarms/*.md coordinator surface, so some findings are structurally
      unclosable by declaration. This wants a domain-map decision, not a patch.
      Feature-shaped ones (F-a7c10cee findings-by-status listing, F-e4557bf5
      finding event-history verb) — confirm they aren't already covered by
      `swarm findings`, then propose before building.

DISCIPLINE (earned, expensive):
  - Ids from the DB, scope from the frozen domain map, coverage from the gate's
    own output — never memory. Every substitution shipped a defect.
  - Run gates BARE and read the redirected file's own exit line — never trust a
    task-notification "exit code" for a `cmd && echo || echo` wrapper (it reports
    the wrapper's 0), and never pipe a gate through grep for the authoritative run.
  - Never `git commit -m "…backticks…"` (bash runs them as command substitution
    and drops them) — use `git commit -F -` with a single-quoted heredoc.
  - Never mutate git state (amend/tag/checkout) while a background verify runs —
    the cordoned-HEAD guard will fail the suite.
  - `swarm close --as fixed --verified-how operator_evidence` (with the commit +
    a real execution proof as evidence) is the honest close for what you fix;
    `swarm defer --reason` for what you don't. Don't leave fixed work showing open.

ASK THE DIRECTOR BEFORE: the domain-map ownership decisions above; any raw DB
write (the lawful verbs cover the known cases); deleting the legacy
mcp-tool-shop-org/dogfood-labs repo; authoring the first operator notes
(dogfood/roadmap-notes.json is the Director's voice — offer, never author).
```

---

## Coordinator notes (not part of the paste block)

- **Right-size the wave.** The tail is small MED/LOW items across backend / ci-tooling / core / verbs. A full 6-lane + jury swarm is overkill for ~10 actionable fixes; reopen the actionable subset and run a targeted amend (or fix the trivia coordinator-direct with an adversarial-skeptic pass on anything mechanism-shaped). Confirm the shape against the live queue first.
- **The genuinely-blocked item is the domain map.** `F-6a5eb347` (root `package.json` matches no domain) and `F-d0c33457` (the `swarms/*.md` coordinator surface is unowned) are structurally unclosable-by-declaration until the frozen map gets an owner for those paths — that's a Director decision, not a patch.
- **The run stays open.** v1.10.0 was a waypoint. Leave the phase at `test`; the deferred tail is this cycle's material, and whatever this cycle defers is the next one's.
