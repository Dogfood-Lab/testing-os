# Grok Executor brief — testing-os dogfood-swarm 3

**Seat:** Grok Executor (this brief is the contract). Advisor wrote it 2026-08-25.
**Repo:** `E:\AI\testing-os` (origin `dogfood-lab/testing-os`).
**Do not treat `C:\WINDOWS\system32` as the workspace.** `cd E:\AI\testing-os` first.
**Human-facing state:** [`docs/dogfood-swarm-3.state-and-trajectory.md`](./dogfood-swarm-3.state-and-trajectory.md) — leave it true; do not invent wave numbers into `HANDOFF.md`.

You are **not** resuming `swarm-1784091637-5127`. That run is at `test` with a zero-open ledger. This is a **new** run whose job is to dogfood dogfood-swarm itself. Other packages get a health audit and polish notes. The main focus is making the swarm tool solid.

Pass `model=` on every dispatched seat. An omitted model inherits Fable. Domain agents this swarm: **grok-4.5**. Jury: **exclude xAI** (Panickssery 2024 arXiv:2404.13076; Spiliopoulou 2025 arXiv:2508.06709). Anthropic is optional diversity, not a required ban. Clerk (case-file) may be Fable — neutrality is schema-enforced. `swarm verify` is the only law.

---

## 0. Preflight — advisor already landed the product PRs

Measured again 2026-08-25 after advisor merge:

- HEAD is **`main`**. `#64` squash-merged as `04adf3d`. `#66` squash-merged as `02bf481` (current `origin/main` before this docs commit).
- Dirty ingest indexes parked as `stash@{1}` (`park ingest indexes before swarm-3 init`). Untracked WIP parked as `stash@{0}` (`park untracked WIP before swarm-3 init`: `openrouter-jury.js`, extra records, `ESCAPE-THE-VALLEY-SWARM-2.md`). **Do not pop them before init.**
- `swarm init` requires empty porcelain (`commands/init.js`). After this docs commit, porcelain must stay empty.

| PR | What | Call |
|---|---|---|
| [#64](https://github.com/dogfood-lab/testing-os/pull/64) | Read-only liveness; `resume` moves a failed wave back to `dispatched` | **MERGED** `04adf3d` |
| [#66](https://github.com/dogfood-lab/testing-os/pull/66) | Python `--isolate` containment | **MERGED** `02bf481` |

CLI:

```bash
node packages/dogfood-swarm/cli.js
```

Housekeeping ritual (`docs/housekeeping-ritual.md`) steps 0–2 before init. `swarm doctor` already PASS; still run it on this HEAD.

**Advisor authorization:** you MAY `swarm init --seed-from-roadmap=swarm-1784091637-5127` from this clean `main`. You may NOT advance 5127 to `complete`.

---

## 1. Init

```bash
git fetch origin
git checkout main
git pull --rebase origin main
node packages/dogfood-swarm/cli.js init E:\AI\testing-os --seed-from-roadmap=swarm-1784091637-5127
```

Save-point tag is created by init. Record the new `run-id`. Do not advance or archive 5127.

### Domain map — review, edit if needed, freeze

Do **not** accept auto-detect. Reproduce the 5127 map:

| Domain | Class | Globs |
|---|---|---|
| swarm-cp-core | owned | `packages/dogfood-swarm/lib/**`, `packages/dogfood-swarm/db/**`, `packages/dogfood-swarm/persist-results.js`, `packages/dogfood-swarm/package.json` |
| swarm-cp-verbs | owned | `packages/dogfood-swarm/commands/**`, `packages/dogfood-swarm/cli.js` |
| swarm-cp-tests | bridge | `packages/dogfood-swarm/*.test.js` |
| backend | owned | `packages/verify/**`, `packages/findings/**`, `packages/ingest/**`, `packages/report/**`, `packages/portfolio/**`, `packages/schemas/**` |
| ci-tooling | owned | `.github/**`, `scripts/**`, `tsconfig*.json`, `tsconfig.base.json` |
| docs | owned | `*.md`, `docs/**`, `site/**`, `swarms/*.md`, `swarms/templates/**`, `swarms/manifest-schema.json` |
| shared | shared | `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `poetry.lock`, `go.mod`, `go.sum`, `*.toml`, `*.json`, `*.yaml`, `*.yml` |

**docs:** audit-only for agents. Coordinator authors every docs amend. Never reclassify docs to `shared` to skip dispatch — that is the #67 footgun.

Leave `dogfood/**` and `packages/*/README.md` unowned until a wave needs them.

```bash
node packages/dogfood-swarm/cli.js domains <run-id> --freeze
```

---

## 2. Wave 1 — `health-audit-a`

```bash
node packages/dogfood-swarm/cli.js dispatch <run-id> health-audit-a --isolate
```

`--isolate` is mandatory this swarm (Ji et al. 2026 arXiv:2607.02294: 55.8–67.8% boundary-violation base rate; PROTOCOL already cites it; the default shared worktree is unsound). Making `--isolate` the CLI default is a feature-pass item, not a Wave-1 silent flip.

Six agents. Focus:

| Domain | Hunt for |
|---|---|
| swarm-cp-core | #67 class (`coordinator` exclusive + skip-at-dispatch); ownership/fingerprint/classify; prove-red gaps; case-file/jury; `--isolate` default still opt-in |
| swarm-cp-verbs | #65 `fixes_skipped` never reaches `status`/`receipt`; `doctor` still missing disk/WAL/worktree (trajectory note). Liveness/resume from #64 is already on this HEAD — hunt remaining holes, don't re-file the merged fix. |
| swarm-cp-tests | Discovery completeness; WAL isolation; mutants that should go red and don't |
| backend | Real CRIT/HIGH only. Polish notes for MED/LOW. No new product layer. |
| ci-tooling | Live checkout pin is still **v6.0.3** (SHA `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`) despite Dependabot #62; Vitest 4.1.9 vs 4.1.11; HOLD TS 7 / js-yaml 5 / Vitest 5; Node 25 EOL |
| docs | Drift, handbook vs shipped verbs, PROTOCOL contradictions on `advance` vs amend. **Do not edit.** File findings. |

Known in-scope (do not "discover" them as if new — file against live HEAD and give them canonical ids):

- GitHub **#67** — no ownership class exclusive AND skipped at dispatch.
- GitHub **#65** — unknown `finding_id` in `fixes[]` dropped off coordinator surfaces.
- GitHub **#16** — feature-execute prompt template vs `agent-output.schema.json` (file if still live; do not fix in Wave 1).

Test-first on amend waves. `finding_id` in `fixes[]` **must** be a canonical id from `## Findings to Fix`, never `F-001`. The brief example below uses `F-xxxxxxxx` as a shape, not a live id.

Serial verify: agents set `"verification_skipped": true`. You run **one unpiped** `npm run verify` on the merged tree. Piping through `tail`/`head` masks the exit code.

---

## 3. Output contract (audit)

Write `swarms/<run-id>/wave-N/<domain>/output.json`. First JSON block in this brief is the envelope collect will validate. `evidence` is an array of strings when the inner schema asks for it.

```json
{
  "domain": "swarm-cp-core",
  "stage": "A",
  "summary": "Stage A audit of swarm-cp-core against live HEAD; filed #67 class if still inexpressible.",
  "findings": [
    {
      "id": "F-xxxxxxxx",
      "severity": "HIGH",
      "category": "bug",
      "file": "packages/dogfood-swarm/lib/domains.js",
      "line": 1,
      "description": "What is wrong, with a live proof.",
      "recommendation": "How to fix it as a class, not an instance."
    }
  ],
  "confirmed": [],
  "skipped": [
    {
      "finding_id": "F-xxxxxxxx",
      "reason": "out of domain"
    }
  ],
  "verification_skipped": true
}
```

Severity enum: `CRITICAL` | `HIGH` | `MEDIUM` | `LOW`.
Category enum (audit): `bug`, `security`, `quality`, `types`, `tests`, `docs`, `defensive`, `observability`, `degradation`, `future-proofing`, `ux`, `accessibility`, `hygiene`, `error_message_quality`, `cli_help_quality`, `silent_failure`, `tests_coverage`.

Amend outputs use `fixes` + `files_changed` (not `fixes_applied` / `files_edited`). Each fix:

```json
{
  "domain": "swarm-cp-core",
  "summary": "Amended approved Stage A findings in swarm-cp-core.",
  "fixes": [
    {
      "finding_id": "F-xxxxxxxx",
      "file": "packages/dogfood-swarm/lib/domains.js",
      "description": "What changed."
    }
  ],
  "files_changed": ["packages/dogfood-swarm/lib/domains.js"],
  "skipped": [],
  "verification_skipped": true
}
```

Run `python ~/.claude/skills/cross-family-rerate/check_brief_template.py` on any brief you hand a lane, `--kind audit|amend|feature`.

---

## 4. After collect

1. `swarm collect <run-id> --all` (or explicit `--domain=`).
2. Cross-family re-rate **before** you treat author severities as real. Strip authorship and self-assigned severity. Exclude xAI. Median, not mean. Jury is advisory.
3. Present the consolidated findings to the Director before any amend. Stage A exit = 0 CRIT + 0 HIGH after a confirming audit. Open MED/LOW do not block.
4. `swarm receipt <run-id>`.
5. One unpiped `npm run verify`. Then `swarm verify <run-id>` so advance has a receipt.
6. Docs amends: you write them. Agents do not.

Fix classes, not instances (`swarms/PROTOCOL.md` §Fixing a class). Sibling-sweep every abstraction you touch.

---

## 5. Software policy (ci-tooling, not a surprise bump)

| Item | Call | Why |
|---|---|---|
| Node CI 22+24 | keep | Both LTS. Node 25 EOL. Node 26 Current — do not require. |
| `actions/checkout` 7.0.1 | take | Live pin is still v6.0.3. |
| `actions/setup-node` v7 | audit then take | Removes dummy `NODE_AUTH_TOKEN` when `registry-url` is set. OIDC release path should be fine. |
| Vitest 4.1.9 → 4.1.11 | take | Patch. Vitest 5 is RC — wait. |
| TypeScript 7.0.2 | **HOLD** | No programmatic API until 7.1; Astro handbook. Dependabot #55. |
| js-yaml 5 | **HOLD** | Breaking rewrite. #50. |
| better-sqlite3 13 | after health | N-API major. Dogfood on 22+24 before merge. |
| Ajv | stay 8.x | 8.20.0 latest. No Ajv 9. |

---

## 6. Do not

- Init on `feat/read-only-liveness-probe`, any dirty tree, or after popping the parked stashes.
- Resume or `advance` `swarm-1784091637-5127` to `complete`.
- Reclassify `docs` to `shared` to skip dispatch.
- Let two agents edit the same owned file.
- Dispatch without `--isolate`.
- Seat xAI on the jury.
- Treat jury verdict as law.
- Pipe `npm run verify`.
- Hardcode suite counts into `HANDOFF.md`.
- Merge Dependabot #50 or #55 as "latest software" without the holds above.
- Author `dogfood/roadmap-notes.json` (Director voice).
- Start feature-pass work before a clean Stage A bill of health.

---

## 7. Research lock (short)

Study-swarm: [`docs/dogfood-swarm-3.study-swarm.dispatch.md`](./dogfood-swarm-3.study-swarm.dispatch.md).

- `--isolate` default for this run because agents guess under underspecification (Ji 2026).
- Jury excludes xAI; median; strip CoT (Panickssery 2024, Spiliopoulou 2025, Khalifa 2026, Acharya 2026).
- Prove gates red (Bhadra 2026). #65 and #67 are that class.
- Trajectory artifact is compiled NOW/NEXT, contrastive, not an authored plan (Buçinca 2024, Silva 2023).
