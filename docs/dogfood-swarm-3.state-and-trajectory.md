# testing-os — state and trajectory (2026-08-25)

This is the Director-facing artifact for dogfood-swarm 3. It is compiled from live measurement, not authored as a plan. Forward-looking content is the short NEXT list at the bottom — typed moves, no horizon prose.

**You might think** Phase 10 is still open. **The control plane and npm show** v1.11.0 shipped (`e697247`). `swarm-1787700871-d537` stays at run status **`test`** (promotion 78). Phase 10 leftovers sit parked for housekeeping. Prior run `swarm-1784091637-5127` is still `test` and must not be completed.

## NOW — measured 2026-08-26

| Surface | Live value |
|---|---|
| Repo | `E:\AI\testing-os` · origin `dogfood-lab/testing-os` |
| Shipped | **v1.11.0** (this treatment) · six `@dogfood-lab/*` packages lockstep · `portfolio` workspace-internal |
| This swarm | **`swarm-1787700871-d537`** · run status **`test`** · 15 waves · 33 fixed / 4 deferred / 11 unverified / 0 CRIT / 0 HIGH · save `swarm-save-1787700871` |
| Freeze | `ad5b4f5a3434e765` · **docs = coordinator** (exclusive, skipped at dispatch) |
| Working tree | `main` @ **`e697247`** (v1.11.0), origin in sync. Stashes still parked (`stash@{0}` WIP, `stash@{1}` ingest indexes). Do not pop them. |
| Domain-map foil | Interval file `2026-08-25-interval-01a03b2e.md` still talks about a 9-domain / next-cycle-kickoff map. **Live GitHub #67 and the artifacts on disk win** — inherit the 5127 freeze; build a `coordinator` class in Stage A. |
| Node | local **v22.22.3** · `engines: >=22` · CI matrix 22+24 · Node 25 is **EOL** |
| `swarm doctor` | **7/7 PASS** (node, writable, schema v10, git, disk-free, control-plane-size, stranded-worktrees). Brief bloat is still ritual step 4. |
| Control plane | `swarms/control-plane.db` ~9.6 MB · schema v10 |
| Prior self-swarm | `swarm-1784091637-5127` · 44 waves · 507 findings ever · verify PASS (4246 tests at last receipt) · **do not advance to `complete`** |
| Roadmap pointer | sequence **1** · `dogfood/roadmap/latest.json` → `swarm-1787700871-d537.1.json` (5127 sequence 7 remains in the archive) |
| Grandfathered pins | frozen_total **256**, drained **0** (ritual step 3 still owed) |
| Deferred (d537, 4 HIGH) | `F-71d4ce45` checkout 7.0.1 take · `F-5764a279` setup-node v7 audit-then-take · `F-44eb48f2` / `F-ca8f3e37` leftover docs HIGHs (not silent closes) |
| GitHub issues | **#67** and **#65** **CLOSED** by `e697247`. **#16** already closed. |
| Product PRs | **#64 MERGED** `04adf3d` (read-only liveness; resume moves a failed wave) · **#66 MERGED** `02bf481` (Python `--isolate` containment) |
| Open Dependabot | TS 6→7 (#55) **HOLD** · js-yaml 4→5 (#50) **HOLD** · checkout 7.0.1 (#62) **take** · setup-node 7 (#56) **audit then take** |

### What the repo is (seven packages)

| Package | Role in this swarm |
|---|---|
| `@dogfood-lab/dogfood-swarm` | **Main focus.** Control plane, CLI, isolation, jury, verify, closure verbs, roadmap. |
| `@dogfood-lab/schemas` | Contract spine. Polish + notes; real CRIT/HIGH still file. |
| `@dogfood-lab/verify` | Submission validator + `dogfood-verify lint`. Same. |
| `@dogfood-lab/findings` | Derive/review/synthesis/advise. Same. |
| `@dogfood-lab/ingest` | Dispatch → persist → indexes. Same. |
| `@dogfood-lab/report` | Consumer submission builder. Same. |
| `@dogfood-lab/portfolio` | Internal portfolio generator. Same. |

Also in-tree, not a package: `site/` (Astro Starlight handbook), `records/` `indexes/` `policies/` `fixtures/` `dogfood/` `swarms/` (published API paths).

### Domain map (inherit 5127, freeze after review)

Six agent-bearing domains + one shared. This is the map that survived 44 waves. Do not auto-detect over it.

| Domain | Class | Dispatched? | Globs | Focus |
|---|---|---|---|---|
| **swarm-cp-core** | owned | yes | `packages/dogfood-swarm/lib/**`, `db/**`, `persist-results.js`, `package.json` | **Main.** Isolation, ownership, fingerprints, classify, case-file, roadmap compiler. |
| **swarm-cp-verbs** | owned | yes | `packages/dogfood-swarm/commands/**`, `cli.js` | **Main.** dispatch/collect/status/resume/advance/doctor/close/reopen. #67 + #65 live here too. |
| **swarm-cp-tests** | **bridge** | yes | `packages/dogfood-swarm/*.test.js` | **Main.** Flat root tests. Bridge so every code domain can still author its own `*.test.js` (test-first). `lib/**/*.test.js` belongs to core. |
| **backend** | owned | yes | `packages/{verify,findings,ingest,report,portfolio,schemas}/**` | Polish + notes. File CRIT/HIGH. Do not invent a new product layer. |
| **ci-tooling** | owned | yes | `.github/**`, `scripts/**`, `tsconfig*.json`, `tsconfig.base.json` | Latest-software findings. Pin-gate, doc-drift, CI Node 22+24. |
| **docs** | **coordinator** | skipped at dispatch | `*.md`, `docs/**`, `site/**`, `swarms/*.md`, `swarms/templates/**`, `swarms/manifest-schema.json` | Exclusive; coordinator authors. `swarm dispatch` does not open a docs agent. Shipped as the #67 class. |
| **shared** | shared | never | root `package.json`, lockfiles, `*.toml`/`*.json`/`*.yaml`/`*.yml` | Write-valid for every agent. Never make `docs` shared to skip dispatch. |

**Deliberate unowned (do not assign unless a wave needs them):** `dogfood/**`, `packages/*/README.md`.

**Shipped in v1.11.0:** the `coordinator` ownership class is exclusive AND skipped at dispatch ([dogfood-lab/testing-os#67](https://github.com/dogfood-lab/testing-os/issues/67)). Transiently reclassifying `docs` to `shared` remains forbidden — that inverts the public-surface law with no warning.

### Contrastive foils

| You might think | Control plane / filesystem shows |
|---|---|
| Resume 5127 | 0 open; phase `test`; new run + `--seed-from-roadmap` is the T4 path |
| Still on the liveness feature branch | Advisor merged #64/#66 and checked out `main` @ `02bf481` |
| Checkout is already v7 | Live workflows still pin `actions/checkout` **v6.0.3** SHA `9c091bb…` |
| TypeScript 7 is a free bump | 7.0 has **no programmatic API**; this repo's handbook is Astro — HOLD #55 |
| Local Node 25 is current | Node 25 is **EOL**; 24 and 22 are LTS; 26 is Current |
| `shared` is how you skip a domain | `shared` makes the files world-writable. That is the opposite of coordinator-owned |
| A green `swarm collect` means every `fixes[]` id landed | Pre-v1.11.0 that was #65. Unknown ids now reach `status`/`receipt` (`fixes_skipped`). |
| Grok memory's 9-domain / `next-cycle-kickoff` map | That interval file is stale. Live map is the freeze (six agents + shared; docs = coordinator). |

## MEANING — standing orders still in force

From `dogfood/roadmap-notes.json` (Director voice, sequence 7). Standing orders expire 2027-07-18; trajectory notes 2026-10-16.

1. Releases are waypoints. A spotless audit is never the ship bar.
2. Housekeeping ritual at the start of every swarm session (`docs/housekeeping-ritual.md`).
3. Grandfathered pin manifest **only shrinks** (`scripts/check-finding-regression-pins.mjs`).
4. Solutions, not problem reports without a path.
5. This repo is built to test the fleet. Surfaces other repos touch stay first-class.

Trajectory notes:

- Dashboard visual build-up (v1.2 needs Director words before a Claude Design prompt) — still live.
- Fold guardian health-checks into `swarm doctor` — **env trio shipped in v1.11.0**. Brief bloat is still ritual step 4. Offer retirement of the env half; do not silently drop the note.

## NEXT — typed moves (not a plan)

These are the only forward-looking lines in this file. Each is a verb a Coordinator can run. None is a schedule.

1. **Waypoint.** d537 is at `test`. Do not `complete`. Do not `dispatch … test`. 5127 stays `test`.
2. **Housekeeping ritual** after the release — [`swarms/NEXT-CYCLE-KICKOFF.md`](../swarms/NEXT-CYCLE-KICKOFF.md). Steps 0–3 bind (notes, doctor + brief-bloat, staleness sweep, drain ≥5 grandfathered).
3. **Reopen to take:** F-71d4ce45 checkout 7.0.1, F-5764a279 setup-node v7. Vitest F-5e021f01 still a note (4.1.11 patch).
4. **HOLD:** TS 7, js-yaml 5, Vitest 5.
5. **Allowlist six overdue** — WARN only; delete or refresh, do not ignore.
6. **Do not drain** the 4 deferred / 11 unverified as a silent clean ledger.
7. **Offer the Director** retirement of the guardian-into-doctor trajectory note (env half shipped; brief bloat remains).

Grok Executor brief (this swarm, historical): [`docs/dogfood-swarm-3.executor-brief.md`](./dogfood-swarm-3.executor-brief.md).
Study-swarm: [`docs/dogfood-swarm-3.study-swarm.dispatch.md`](./dogfood-swarm-3.study-swarm.dispatch.md).
