# testing-os — state and trajectory (2026-08-25)

This is the Director-facing artifact for dogfood-swarm 3. It is compiled from live measurement, not authored as a plan. Forward-looking content is the short NEXT list at the bottom — seven typed moves, no horizon prose.

**You might think** this swarm is still in health-audit. **The control plane shows** `swarm-1787700871-d537` at run status **`test`** (promotion 78). v1.11.0 is the waypoint. Phase 10 leftovers sit parked. Prior run `swarm-1784091637-5127` is still `test` and must not be completed.

## NOW — measured 2026-08-26

| Surface | Live value |
|---|---|
| Repo | `E:\AI\testing-os` · origin `dogfood-lab/testing-os` |
| Shipped | **v1.11.0** (this treatment) · six `@dogfood-lab/*` packages lockstep · `portfolio` workspace-internal |
| This swarm | **`swarm-1787700871-d537`** · run status **`test`** · 15 waves · 33 fixed / 4 deferred / 11 unverified / 0 CRIT / 0 HIGH · save `swarm-save-1787700871` |
| Freeze | `ad5b4f5a3434e765` · **docs = coordinator** (exclusive, skipped at dispatch) |
| Working tree | on `main`. `#64` `04adf3d`; `#66` `02bf481`. Stashes still parked (`stash@{0}` WIP, `stash@{1}` ingest indexes). Do not pop them. |
| Domain-map foil | Interval file `2026-08-25-interval-01a03b2e.md` still talks about a 9-domain / next-cycle-kickoff map. **Live GitHub #67 and the artifacts on disk win** — inherit the 5127 freeze; build a `coordinator` class in Stage A. |
| Node | local **v22.22.3** · `engines: >=22` · CI matrix 22+24 · Node 25 is **EOL** |
| `swarm doctor` | PASS (schema v10, git 2.54, hardlink-capable) |
| Control plane | `swarms/control-plane.db` ~9.6 MB · schema v10 |
| Prior self-swarm | `swarm-1784091637-5127` · 44 waves · 507 findings ever · verify PASS (4246 tests at last receipt) · **do not advance to `complete`** |
| Roadmap pointer | sequence **7** · `dogfood/roadmap/latest.json` → `swarm-1784091637-5127.7.json` |
| Grandfathered pins | frozen_total **256**, drained **0** (ritual step 3 still owed) |
| Deferred (3) | `F-ad2d6318`, `F-c2a22b93` (pre-v10 NULL `closure_kind`/`verified_how` — wait on a reader) · `F-3b70bc65` (cmdFindings/buildDigest seam) |
| GitHub issues | **#67** and **#65** ship in this release (coordinator class; unknown `finding_id` reaches `status`/`receipt`). **#16** already closed. |
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
| A green `swarm collect` means every `fixes[]` id landed | #65: unknown ids are dropped and never reach `status`/`receipt` |
| Grok memory's 9-domain / `next-cycle-kickoff` map | That interval file is stale. Live map is the 5127 freeze (six agents + shared). Issue #67 is the missing `coordinator` class, not a v1.11.0 tracking ticket |

## MEANING — standing orders still in force

From `dogfood/roadmap-notes.json` (Director voice, sequence 7). Standing orders expire 2027-07-18; trajectory notes 2026-10-16.

1. Releases are waypoints. A spotless audit is never the ship bar.
2. Housekeeping ritual at the start of every swarm session (`docs/housekeeping-ritual.md`).
3. Grandfathered pin manifest **only shrinks** (`scripts/check-finding-regression-pins.mjs`).
4. Solutions, not problem reports without a path.
5. This repo is built to test the fleet. Surfaces other repos touch stay first-class.

Trajectory notes still live (not retired this session):

- Dashboard visual build-up (v1.2 needs Director words before a Claude Design prompt).
- Fold guardian health-checks into `swarm doctor` (extend doctor, do not fork guardian).

## NEXT — seven typed moves (not a plan)

These are the only forward-looking lines in this file. Each is a verb an Executor can run. None is a schedule.

1. **Waypoint.** d537 is at `test`. Do not `complete`. Do not `dispatch … test`. 5127 stays `test`.
2. **v1.11.0.** Lockstep publish of six `@dogfood-lab/*` packages via tag-push `release.yml`.
3. **`swarm clean --apply`** already removed 88 isolate worktrees this treatment. Do not re-clean unless `swarm doctor` WARNs of stranded trees.
4. **Reopen to take:** F-71d4ce45 checkout 7.0.1, F-5764a279 setup-node v7. Vitest F-5e021f01 still a note.
5. **HOLD:** TS 7, js-yaml 5, Vitest 5.
6. **Allowlist six overdue** — WARN only; How-to-fix present; not drained.
7. **Do not drain defers / unverified as a silent clean ledger.**

Executor contract: [`docs/dogfood-swarm-3.executor-brief.md`](./dogfood-swarm-3.executor-brief.md).
Study-swarm: [`docs/dogfood-swarm-3.study-swarm.dispatch.md`](./dogfood-swarm-3.study-swarm.dispatch.md).
