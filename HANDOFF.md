# HANDOFF.md — testing-os migration completion

> **Purpose.** This is the session-based roadmap that took testing-os from "Wave 7 archived legacy" to "v1.0.0 stable + dogfood-labs safely deletable." Sessions A–G are done; Session H is the only piece left and it requires Mike's explicit approval + a 30-day grace window.
>
> ## Where we are (end of session 2, 2026-04-25)
>
> **All seven sessions A–G shipped this session.** [Release v1.0.0](https://github.com/dogfood-lab/testing-os/releases/tag/v1.0.0) is live. Receiver chain verified end-to-end. Handbook deployed. Translated. Branded. Schemas cut over. External audit closed. Hard gates A–D pass at 100%.
>
> **What's left to do tomorrow (or whenever you pick it up):**
>
> 1. **Session H — delete legacy `mcp-tool-shop-org/dogfood-labs`.** Pre-flight checklist below is satisfied for items A–G; the 30-day grace window started 2026-04-25 and **passed on 2026-05-25** (already past as of the last update to this note, 2026-07-02). Remaining gates: Mike's explicit "yes delete it" go/no-go on the deferred close, archiving issues + PR history + Actions runs into `legacy/`, and a final traffic re-check just before delete. No additional waiting required — this is now a deliberate hold pending Mike's call.
> 2. **Five surfaced follow-ups** (each is its own small session, none blocks H):
>    - Set `DOGFOOD_TOKEN` secret on consumer repos so dispatch actually fires (currently skipped silently). User-side: mint a fine-grained PAT with `contents: write` on `dogfood-lab/testing-os`, add as `DOGFOOD_TOKEN` to ai-loadout / claude-guardian / glyphstudio / site-theme / shipcheck.
>    - Fix ai-loadout's broken `main` build (TS errors on missing `@types/node` config).
>    - ~~Bump pinned action SHAs from Node 20 → Node 24 across `ci.yml`, `ingest.yml`, `pages.yml`, `release.yml`. The `actions/checkout@v4.3.1` pin still runs on Node 20 (deprecation cliff 2026-06-02 → forced-Node-24, 2026-09-16 → Node 20 removed); the other pinned actions are already Node 24.~~ — Done 2026-05-31 (Wave A1 D4). Bumped `actions/checkout` to v6.0.2 (node24 runtime, SHA `de0fac2e4500dabe0009e67214ff5f5447ce83dd`) in all 4 workflows ahead of the 2026-06-02 deprecation.
>    - Run `npm audit fix` on `site/package-lock.json` (8 vulns inherited from legacy lockfile, 5 mod / 3 high).
>    - Wire dependency scanning + Dependabot config into `ci.yml`. Currently SKIPped in SHIP_GATE.md.
> 3. **npm publish — landed.** Six of seven `@dogfood-lab/*` packages are published on npm since v1.2.0 (2026-05-14): `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Headline install: `npm install -g @dogfood-lab/dogfood-swarm`. The seventh (`@dogfood-lab/portfolio`) remains intentionally workspace-internal. The deferred "Mike's call" from v1.0.0 → v1.1.x closed at v1.2.0.
>
> **Resumable from a cold start:** read this file and [CLAUDE.md](CLAUDE.md), then pick from the list above. The state is documented; you won't have to reconstruct anything from git log.

> ## Original session intent (preserved for context)
>
> Each session below was a discrete unit of work that closed one of these gaps:
>
> - The Astro Starlight handbook + GitHub Pages deployment never moved over → ✅ Session B
> - Schema `$id` URLs still resolved to the legacy path → ✅ Session E
> - testing-os had no logo, no README badges, no translations, no Pages site → ✅ Sessions B/C/D
> - We hadn't actually verified a single live dogfood run lands in testing-os end-to-end → ✅ Session A
> - Unknown external consumers may still be hitting `raw.githubusercontent.com/mcp-tool-shop-org/dogfood-labs/main/...` → ✅ Session F
> - Issues, PR history, Actions runs, and Pages site of the old repo aren't archived externally → ⏳ Session H pre-flight

---

## Session A — Live verification of the cutover

**Completed 2026-04-25.** End-to-end verified against `mcp-tool-shop-org/claude-guardian` (ai-loadout's build is broken on main — see "Things we didn't have time for"). Run trail:

- ai-loadout dogfood run [24922190504](https://github.com/mcp-tool-shop-org/ai-loadout/actions/runs/24922190504) — failed at `npm run build` (pre-existing TS config issue, unrelated to migration)
- claude-guardian dogfood run [24922209099](https://github.com/mcp-tool-shop-org/claude-guardian/actions/runs/24922209099) — success but `DOGFOOD_TOKEN not set` warning, dispatch skipped
- Manually dispatched the same submission shape from `mcp-tool-shop` user → testing-os ingest run [24922250743](https://github.com/dogfood-lab/testing-os/actions/runs/24922250743) ✓
- Record at [records/mcp-tool-shop-org/claude-guardian/2026/04/25/run-claude-guardian-24922209099-1.json](records/mcp-tool-shop-org/claude-guardian/2026/04/25/run-claude-guardian-24922209099-1.json) on commit 4fb1913 (auto-committed by ingest.yml)
- `latest-by-repo.json` updated to point at the new record
- `node F:/AI/shipcheck/bin/shipcheck.mjs dogfood --repo mcp-tool-shop-org/claude-guardian --surface mcp-server` → ✓ "verified pass, 0d old"
- `node F:/AI/repo-knowledge/dist/cli.js sync-dogfood --local F:/AI/dogfood-lab/testing-os` → ✓ "13 repos synced, 91 facts upserted"

Bundled the missing `ingest.yml` workflow into Session A (per the plan); shipped via [PR #1](https://github.com/dogfood-lab/testing-os/pull/1) (squash `e808d77`).

**Goal.** Confirm the merged PRs actually work in production, not just in CI.

**Why first.** If something's broken about the new dispatch path, every other session is wasted effort.

**Steps:**

1. Trigger a real `dogfood.yml` run on one of the cut-over repos (ai-loadout is smallest, simplest):
   ```bash
   gh workflow run dogfood.yml --repo mcp-tool-shop-org/ai-loadout
   gh run watch --repo mcp-tool-shop-org/ai-loadout
   ```
2. Check that the dispatch lands in `dogfood-lab/testing-os`:
   ```bash
   gh api repos/dogfood-lab/testing-os/dispatches  # returns 204 even on success — check Actions log instead
   gh run list --repo dogfood-lab/testing-os --workflow ingest.yml --limit 3
   ```
3. Confirm a new record appears in `records/mcp-tool-shop-org/ai-loadout/<year>/<month>/<day>/`.
4. Run shipcheck Gate F against the new repo:
   ```bash
   npx @mcptoolshop/shipcheck dogfood --repo mcp-tool-shop-org/ai-loadout --surface cli
   ```
   Should succeed using the new `DEFAULT_DOGFOOD_REPO = "dogfood-lab/testing-os"`.
5. Run repo-knowledge sync against the new repo:
   ```bash
   cd F:/AI/repo-knowledge
   node dist/cli.js sync-dogfood --local F:/AI/dogfood-lab/testing-os
   ```
   Should populate facts using the new path.

**Done when:** dogfood evidence has flowed end-to-end (dispatcher → testing-os ingest → indexes updated → consumers see it). At least one real run, one shipcheck audit, one rk sync — all using the new repo. Snapshot the run IDs in this file.

**Estimated effort:** 30 min.

---

## Session B — Migrate the Astro Starlight handbook

**Completed 2026-04-25.** Live at [https://dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) — root, `/handbook/`, and `/handbook/beginners/` all return 200. Shipped via [PR #3](https://github.com/dogfood-lab/testing-os/pull/3) (squash `9108082`). Pages workflow [run 24922508507](https://github.com/dogfood-lab/testing-os/actions/runs/24922508507) — build + deploy + verify-200 all green. Pages source configured via `gh api -X POST repos/dogfood-lab/testing-os/pages -f build_type=workflow`.

**Goal.** Bring the documentation site over from `dogfood-labs/site/` and deploy it to `dogfood-lab.github.io/testing-os/`.

**Why.** The old Pages site at `mcp-tool-shop-org.github.io/dogfood-labs/` is the public-facing docs. It dies when we delete the old repo. testing-os needs an equivalent.

**Steps:**

1. Copy `F:/AI/dogfood-labs/site/` → `F:/AI/dogfood-lab/testing-os/site/`. The Starlight site is self-contained.
2. Update internal links in `site/src/content/docs/`:
   - `mcp-tool-shop-org/dogfood-labs` → `dogfood-lab/testing-os`
   - `tools/<name>/` → `packages/<name>/`
   - GitHub URLs to the new repo
3. Update `site/astro.config.mjs`:
   - `site:` → `https://dogfood-lab.github.io/`
   - `base:` → `/testing-os/`
4. Update root CI to also build the site (mirror world-forge's `site-build` job in `.github/workflows/ci.yml`).
5. Add `.github/workflows/pages.yml` for deployment (model after world-forge or repo-knowledge — both have one).
6. Configure GitHub Pages: Settings → Pages → Source: GitHub Actions.
7. Push, verify deployment at `https://dogfood-lab.github.io/testing-os/`.

**Acceptance:** new site is live, navigates correctly, all internal links resolve.

**Estimated effort:** 90 min.

---

## Session C — Brand testing-os

**Completed 2026-04-25 (logo deferred).** 3 of 4 items shipped via [PR #5](https://github.com/dogfood-lab/testing-os/pull/5) (squash `4ba9f06`):
- 4 badges in README.md (CI, Pages, License, Node ≥ 20)
- `scripts/sync-version.mjs` adopted from world-forge, wired as `prebuild`. README version block auto-stamped.
- CONTRIBUTING.md added, points at CLAUDE.md
- Status/Packages/Layout sections updated to reflect the migration is done

Logo (step 1) deferred to its own session — wants Sprite Foundry pipeline + Mike's directional input. Tracking under "Things we didn't have time for tonight."

**Goal.** Logo, badges, polished README — match the world-forge / motif standard.

**Why.** testing-os is the flagship of the new org. A bare-bones README erodes trust before anyone reads the code.

**Steps:**

1. **Logo.** Generate (via the Sprite Foundry pipeline) or commission a `testing-os` logo in the same family as `dogfood-labs/readme.png`. Add it to the brand repo (`mcp-tool-shop-org/brand` or wherever the org's brand assets live — see `.claude/rules/canonical-ownership.md`). Reference it from the README via `https://raw.githubusercontent.com/<brand-repo>/main/logos/testing-os/readme.png`.
2. **Badges in README.md.** Add (mirror world-forge):
   ```markdown
   [![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
   [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
   [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
   ```
   Plus a `<!-- version:start --> v0.1.0-pre — 7 packages, 468 tests <!-- version:end -->` block once we add `scripts/sync-version.mjs`.
3. **Adopt `scripts/sync-version.mjs`** (copy from world-forge, see `F:/AI/world-forge/scripts/sync-version.mjs`). Wire as `prebuild` in root `package.json`.
4. **CONTRIBUTING.md** at the repo root — short, points at CLAUDE.md for repo etiquette.

**Done when:** README looks like a flagship — readers know in 5 seconds what this is, what state it's in, and how to use it.

**Estimated effort:** 60 min (skip if Mike wants to commission the logo separately; do steps 2–4 anyway).

---

## Session D — Translation pass

**Completed 2026-04-25.** Generated by `polyglot-mcp/scripts/translate-all.mjs` — all 7 languages translated successfully on first pass. Language nav bar injected into all 8 READMEs. Mike granted explicit permission for Claude to run the translator directly during this session, overriding the standard "translations are user-side" default. Shipped via [PR #10](https://github.com/dogfood-lab/testing-os/pull/10) (squash `6aed594`).

**Goal.** README in 7 languages (ja, zh, es, fr, hi, it, pt-BR) — same languages dogfood-labs supported.

**Why.** Mike's full-treatment standard. Old repo had translations; new repo should too.

**Steps:**

1. From the user's local machine (translations are run locally per the rules — see `memory/translation-workflow.md`):
   ```powershell
   cd F:\AI\dogfood-lab\testing-os
   npx @mcptoolshop/polyglot translate --langs ja,zh,es,fr,hi,it,pt-BR
   ```
2. The CLI generates `README.{ja,zh,es,fr,hi,it,pt-BR}.md` and adds the language nav bar at the top of `README.md`.
3. Commit + push.

**Note for Claude:** **never run `polyglot` from a Claude session.** It must run on the user's machine. Surface the command, let the user run it, then commit the output.

**Acceptance:** 7 translation files exist; language nav bar is present at the top of each; CI passes.

**Estimated effort:** 15 min of Claude time + 5 min of user-side run.

---

## Session E — Schema `$id` URL update

**Completed 2026-04-25.** All 8 schemas in `packages/schemas/src/json/` now point at the new canonical path. Lockstep bump `0.1.0-pre` → `0.2.0-pre` across root + 7 packages. Shipped via [PR #7](https://github.com/dogfood-lab/testing-os/pull/7) (squash `7a04dc2`). README version block auto-stamped via the `prebuild` hook.

**Goal.** Update `$id` fields in all 8 JSON schemas to point at `dogfood-lab/testing-os`.

**Why.** `$id` is informational but JSON Schema dereferencing tools (`$ref`, validators that fetch via URL) follow them. Right now they 404-via-archive — readable but stale.

**Steps:**

1. Update each schema in `packages/schemas/src/json/`:
   - `https://github.com/mcp-tool-shop-org/dogfood-labs/schemas/<name>.schema.json`
   - → `https://github.com/dogfood-lab/testing-os/packages/schemas/src/json/<name>.schema.json`
2. Bump the `@dogfood-lab/schemas` package version (minor — this is a schema contract change visible to consumers).
3. Run `npm run verify` — all 5 schemas tests should still pass since the test verifies presence + draft version, not URL.
4. Update the migration note in `packages/schemas/src/json/`'s consumer-visible `$id` documentation if any.

**Acceptance:** 8 schemas updated, tests pass, lockstep version bump committed.

**Estimated effort:** 15 min.

---

## Session F — External-consumer audit

**Completed 2026-04-25.** Workspace-wide grep + GitHub Pages traffic check. Findings:

- **Actionable cutovers — all closed:** 4 residual references in shipcheck (own dogfood dispatcher, 2 handbook docs, 2 live tests). Cut over via [shipcheck#3](https://github.com/mcp-tool-shop-org/shipcheck/pull/3) (squash `3288636`). 43 tests pass post-cutover.
- **Intentional legacy references (kept on purpose):**
  - `repo-knowledge/src/sync/dogfood.ts:242` — `tools/findings/cli.js` back-compat fallback for users running `--local /path/to/dogfood-labs` against a stale clone. Comment explicitly documents this. Remove in Session H per HANDOFF.
  - `dogfood-lab/testing-os/policies/repos/mcp-tool-shop-org/dogfood-labs.yaml` — policy file *for* the legacy repo itself; historical artifact.
  - `dogfood-lab/testing-os/swarms/manifest-schema.json:3` — `$id: dogfood-labs.local/...` is a local-namespace URL (not a GitHub reference), unchanged.
  - `dogfood-lab/testing-os/records/mcp-tool-shop-org/**` — historical records with legacy `repo:` fields baked in. Per CLAUDE.md "Working with the legacy": the historical record is the historical record.
  - `role-os/src/swarm/persist-bridge.mjs` comments referencing legacy — descriptive prose about prior architecture, not load-bearing path strings. No action.
- **Legacy Pages traffic (14 days):** 1 view, 35 unique cloners. Clones are likely Mike's own automation; the Pages site is effectively unused externally. Safe gate for Session H (delete) once the 30-day window passes.

**Goal.** Confirm no external thing (outside this workspace) is still hitting `mcp-tool-shop-org/dogfood-labs` URLs.

**Why.** This is the actual gate before delete. Everything inside `F:/AI/` is migrated; the unknown is everything *outside*.

**Steps:**

1. **Search the prototypes seed vault.** It has 104 passport.json files — some may reference dogfood-labs paths.
   ```bash
   gh api repos/mcp-tool-shop-org/prototypes/contents --jq '.[].name'
   git -C F:/AI/prototypes grep -l "dogfood-labs"
   ```
2. **Search the brand repo.** Logo path references etc.
   ```bash
   git -C F:/AI/brand grep -l "dogfood-labs" 2>/dev/null
   ```
3. **GitHub-wide search** (any repo Mike owns):
   ```bash
   gh search code "mcp-tool-shop-org/dogfood-labs" --owner mcp-tool-shop-org --owner mcp-tool-shop --limit 100
   ```
4. **GitHub Pages traffic check** for the old `mcp-tool-shop-org.github.io/dogfood-labs/`:
   ```bash
   gh api repos/mcp-tool-shop-org/dogfood-labs/traffic/views
   gh api repos/mcp-tool-shop-org/dogfood-labs/traffic/clones
   ```
   If there are non-zero views/clones from external sources after archive, decide whether to leave a longer grace period.
5. For each remaining reference: cut it over via PR (same pattern as Wave 6) or document it as "intentionally legacy" in this file.

**Acceptance:** zero unintentional references remain. A list of intentional historical references (records' `repo:` fields, old commit messages, archived issue threads) is documented here for clarity.

**Estimated effort:** 60–90 min depending on what surfaces.

---

## Session G — Final ship: v1.0.0 + GitHub release + (optional) npm publish

**Completed 2026-04-25 (npm publish deferred per HANDOFF guidance).** v1.0.0 cut, tag pushed, GitHub release published at [https://github.com/dogfood-lab/testing-os/releases/tag/v1.0.0](https://github.com/dogfood-lab/testing-os/releases/tag/v1.0.0). Trail:

- Shipcheck audit: 100% pass on hard gates A–D (20 checked / 17 SKIP-with-justification / 0 unchecked). [PR #13](https://github.com/dogfood-lab/testing-os/pull/13) (squash `9625ea3`) ships the SHIP_GATE.md, SCORECARD.md, README threat model, repo metadata, lockstep `0.2.0-pre` → `1.0.0` bump, and the [1.0.0] CHANGELOG entry enumerating Sessions A–F.
- Tag `v1.0.0` pushed to `dogfood-lab/testing-os`.
- GitHub release created via `gh release create v1.0.0` with the CHANGELOG section as body.
- npm publish: **deferred at v1.0.0; closed at v1.2.0 (2026-05-14).** Six of seven `@dogfood-lab/*` packages are now published on npm: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. The seventh (`@dogfood-lab/portfolio`) remains intentionally workspace-internal. Headline install: `npm install -g @dogfood-lab/dogfood-swarm`. (Historical Session G outcome preserved above; closure recorded here.)

**Goal.** Promote `0.1.0-pre` → `1.0.0` lockstep across all 7 packages. Tag a release. Optionally publish.

**Why.** First stable version after migration. Marks the point where consumers can pin to `^1.0.0` confidently.

**Steps:**

1. Run shipcheck on testing-os: `npx @mcptoolshop/shipcheck audit`. Resolve any HARD GATE failures (A–D).
2. Bump every `packages/*/package.json` version `0.1.0-pre` → `1.0.0`. Bump root version too.
3. Update `CHANGELOG.md` with a `[1.0.0] — 2026-XX-XX` section enumerating the migration.
4. Run `npm run verify`.
5. Tag and release:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   gh release create v1.0.0 --title "testing-os v1.0.0" --notes-file <(awk '/## \[1\.0\.0\]/,/## \[/' CHANGELOG.md | head -n -1)
   ```
6. **(Optional)** publish to npm. *Session G state at the time:* six of seven packages were `private: true`; `@dogfood-lab/schemas` was publish-ready (`publishConfig.access=public` + `files` whitelist) but unpublished. **Closed at v1.2.0 (2026-05-14):** six packages are now published — `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. The seventh (`@dogfood-lab/portfolio`) remains intentionally workspace-internal.

**Acceptance:** v1.0.0 tag exists, GitHub release published, CHANGELOG updated.

**Estimated effort:** 30 min (shipcheck pass + version bump + release).

---

## Session H — Delete dogfood-labs (final)

**Goal.** Safely delete the legacy repo. Reversible only via GitHub support.

**Why this is last.** Once deleted, all the URLs go to 404. Sessions A–G ensure nothing depends on those URLs anymore.

**Pre-flight checklist:**

- [x] Session A done — verified end-to-end flow works on the new repo
- [x] Session B done — handbook lives at `dogfood-lab.github.io/testing-os/`
- [x] Session C done — brand + badges + version stamping in place + logo wired ([PR #11](https://github.com/dogfood-lab/testing-os/pull/11))
- [x] Session D done — 7 translations published
- [x] Session E done — `$id` URLs flipped, schemas bumped
- [x] Session F done — zero unintentional external references (intentional ones documented in Session F header)
- [x] Session G done — v1.0.0 tagged and released; npm publish (originally deferred) closed at v1.2.0 (2026-05-14) when 6 of 7 packages shipped
- [ ] **Issues + PR history archived externally** for the legacy repo:
  ```bash
  gh issue list --repo mcp-tool-shop-org/dogfood-labs --state all --limit 1000 --json number,title,state,body,createdAt,labels,comments > legacy-issues.json
  gh pr list --repo mcp-tool-shop-org/dogfood-labs --state all --limit 1000 --json number,title,state,body,createdAt,mergedAt > legacy-prs.json
  # Commit both into testing-os/legacy/ for permanent record
  ```
- [ ] **Actions run history archived** — the run IDs and conclusions:
  ```bash
  gh run list --repo mcp-tool-shop-org/dogfood-labs --limit 1000 --json databaseId,headBranch,conclusion,createdAt,name > legacy-actions.json
  ```
- [ ] **GitHub Pages traffic check** confirms no recent (last 14 days) external traffic
- [x] **Wait 30+ days after archive.** Lets external consumers fail loudly. Don't rush. — **Grace window passed 2026-05-25** (30 days after 2026-04-25 archive). Awaiting Mike's go/no-go on the deferred-close items below before any deletion command runs (still pending as of 2026-07-02).
- [ ] **Mike has explicitly approved deletion** — not just acknowledged. The kind of "yes delete it" that matches the magnitude of "I am about to permanently remove 8000+ commits, hundreds of evidence records, and the audit trail of months of dogfood runs."

**Delete:**

```bash
gh repo delete mcp-tool-shop-org/dogfood-labs --yes
```

**After delete:**

- [ ] Verify all GitHub URLs that pointed at the legacy repo now 404
- [ ] Remove the back-compat fallback in `repo-knowledge/src/sync/dogfood.ts` (the `tools/findings/cli.js` candidate). Open a PR.
- [ ] Update this HANDOFF.md to mark Session H done with the deletion timestamp
- [ ] Update `memory/dogfood-lab-org.md` to reflect the legacy repo is gone

**If something breaks after delete:** GitHub support can sometimes restore deleted repos within a short window — file a ticket immediately. Don't try to recreate from local clone (loses issues, releases, Actions history). Local clones at `F:/AI/dogfood-labs/` are still around as a working-tree backup.

---

## Session I (post-delete, optional) — TS conversion of JS packages

**Goal.** Convert `verify`, `findings`, `ingest`, `report`, `portfolio`, `dogfood-swarm` from JavaScript to TypeScript.

**Why.** Type safety on a critical path tool. Catches regressions earlier. Schemas can be inferred. Easier for new contributors (and new Claudes) to read.

**Why later, not now.** It's a real refactor — risk-bearing, with visible behavior changes possible if not careful. Doing it after v1.0.0 means a clear before/after, with a v2.0.0 that consumers can opt into.

**Approach:**

- One package at a time, in dependency order: `report` → `portfolio` → `verify` → `findings` → `ingest` → `dogfood-swarm`.
- Each becomes its own PR.
- `allowJs: true` in tsconfig during the transition so consumers compile against the package even mid-migration.
- Tests stay on `node --test` initially; convert to vitest in a final cleanup pass once all packages are TS.

**No deadline.** This is a quality investment, not a migration requirement. Open as backlog issues per package.

---

## Things we didn't have time for tonight

For the record (so they don't get lost):

- **Path-traversal repo segments still exit 2 (accepted residual, 2026-07-15)** — the schema-invalid skip-persist fix routes ordinary bad input to a classified exit-1 rejection, but `repo: "../x"` slips past it: `..` MATCHES the submission schema's repo pattern (`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` — dots are in the charset), so the submission is schema-VALID, `_skipPersist` is not set, and the record reaches `writeRecord` → `isDuplicate` → `computeRecordPath`, where `isUnsafeSegment` throws a bare `Error` (no `.code`) → CLI outer catch → exit 2 "ingest failed", no rejection reasons. **It fails CLOSED — nothing is written and no traversal occurs — so this is a classification gap, not a security gap.** Verified live on 2026-07-15. Two candidate fixes, neither taken here (out of scope for the chosen direction, which was scoped to schema-INVALID submissions): (a) give `computeRecordPath`'s three guards a typed error (`RECORD_PATH_INVALID`) and teach run.js's outer catch to classify it submission-bad → exit 1; or (b) tighten the schema's repo pattern to exclude bare `..` segments, which makes it schema-invalid and folds it into the existing skip-persist path — but that is a **contract change** (`$id` is a contract field → lockstep bump) and would newly reject any historical record carrying such a repo. (a) is the cheaper and more honest one; the pattern is defense-in-depth that should keep mirroring the persist guard rather than diverge from it.
- **Feature audit complete (wave 11, 2026-07-02) — 24 candidates, decision table delivered to Mike; NO code written, execution awaits explicit approval.** Two process notes: (1) three feature agents used an `FB-` id prefix (from the coordinator prompt's example) but the agent-output schema requires `^F-[A-Za-z0-9-]+$`; the first collect pass landed them `invalid_output` and failed the wave. Lawful repair: corrected `FB-`→`F-` in the gitignored outputs + `swarm revalidate` (3 domains) → `collected`. **Lesson: the coordinator's own prompt examples are a schema-contract surface — a wrong example id becomes 3 invalid_output agents. Pre-flight the prompt's example against the live schema pattern, not just the enums.** (2) **The fixed-by-absence wrinkle recurred a SECOND time here** (first was Stage B wave 5): because the id-slip made the first collect pass partial-coverage, the full-coverage classification never fired, and `swarm revalidate` (which flips the wave `failed→collected`) does NOT re-run the merge classification — so the 10 Stage-D `approved` rows did NOT close fixed-by-absence and remain `unverified` (benign here: features aren't findings, and this is an audit-only session). **This is now a twice-observed recurrence; the advisor-level fix stands reinforced: make `swarm revalidate` re-run the full-coverage classification when its repair flips a wave to `collected`, so a single invalid agent output cannot permanently suppress fixed-by-absence for the whole wave.** The 10 Stage-D fixed-in-code rows will close at the feature-execute audit (if features are approved), the same self-healing path.
- **Stage-D ACCEPTED-RESIDUAL ledger (health pass close, wave 9/10, 2026-07-02) — feeds the Phase-10 shipcheck disclosure.** Stage D was fix-or-declare (no deferrals); 10 of 12 findings were fixed, 2 consciously declared accepted-residual:
  - **F-91ef5b8e (LOW) — README does not wear testing-os's own dogfood badge.** The product ships a served shields.io dogfood-status endpoint (`indexes/badges/_aggregate.json`), but that aggregate currently reads `stale` because testing-os is the evidence PLATFORM, not a self-submitting consumer. Wearing a `stale` badge on the flagship front door would misrepresent health. **Revisit if/when testing-os dogfoods itself** through the pipeline (then the badge becomes an honest live signal). Rationale over a cosmetic fix.
  - **F-c6083538 (LOW) — `swarm status` per-agent glyphs (`OK`/`..`/`RUN`) stay distinct from the `[PASS]/[WARN]/[FAIL]` gate sigils.** They encode agent LIFECYCLE, a genuinely different semantic from gate VERDICT; a shared vocabulary would conflate two meanings and churn a pinned display surface. Declared a deliberate design choice, not a gap.
- **Stage-D serial verify caught a second cross-file refactor regression (wave 10, 2026-07-02).** The swarm-cp F-c972badf fix correctly extracted the phase literals into a shared `lib/phases.js` (dispatch.js now imports them), but two pre-existing tests (`meta-amendA-readme-contract.test.js`, `wave10-docs-identity-drift.test.js`) regex-parsed `dispatch.js` source for `const AUDIT_PHASES = [...]` and broke when the literals moved. The agent verified its own pins + targeted siblings but — per serial-final-verify discipline — did not run the full suite, so the break surfaced at the coordinator's serial `npm run verify`. One coordinator fix-up repointed both at the new source of truth (`wave10-docs-identity-drift` now imports the exported constants directly, the cleaner path its own comment had invited). This is the SAME cross-file-structural-test seam Stage C hit (F-caeeacc3); the serial verify is the net that catches it. **Recurring lesson: a refactor that moves a symbol pinned by a source-text-parsing test in a *different* file needs a full-suite pass or an explicit sweep of source-parsing guards; the domain agent can't see them under the parallel-wave no-full-suite rule.**
- **Health-pass closing balance (informational).** After wave 10, 10 fixed-in-code findings sit at ledger-status `approved` (not `fixed`) because Stage D is the terminal health stage with no follow-on audit to close them by absence. The FEATURE pass's `feature-audit` will close them by absence exactly as wave 9 closed Stage C's 10 approved rows — the proven self-healing flow. No action needed; noted so the non-zero `approved` count is not misread as unfinished work.
- **Stage-C fixed-by-absence closed the 5 Stage-B deferrals before they could be approved (run `swarm-1783007856-9fdb`, wave 7, 2026-07-02)** — the wave-7 `health-audit-c` collect ran clean on the first pass (all 5 domains valid — the enum-category slip that suppressed the Stage-B classification did not recur), so full-coverage classification fired and closed **126** open priors as `fixed-by-absence` — as intended for the ~121 Stage-A/B rows, but it ALSO closed the 5 Stage-B `new` deferrals (F-2c6d825d, F-ad98b5ac, F-ff7d71b5, F-d31dfc55, F-f05363e2) that Stage C was told to approve-and-fix. Their `fixed` status was therefore momentarily *presumptive* — the mechanism cannot tell "deferred, not yet done" from "actually fixed." Resolution: Stage C shipped the 4 substantive ones + the F-2c6d825d audit-trail note anyway in wave 8, making the `fixed` claim true. **General wrinkle for Stage D and beyond:** any finding deferred (left `new`, un-approved) into a later stage will be closed `fixed-by-absence` by that stage's full-coverage audit if it isn't re-reported — so a deferred LOW is silently closed-unfixed unless the next stage re-surfaces or the current stage ships it. The 4 wave-7 LOWs deferred to Stage D (F-17bebd05, F-5a8ec1fd, F-7ec7e283, F-c00a4c2d) will close this way at Stage D's audit; if Stage D wants them, it must re-find them, not rely on the deferral carrying forward. Advisor-level fix option: a distinct `deferred` status that full-coverage classification excludes from `fixed`, so a conscious defer is not laundered into a `fixed`.
- **Stage-C serial verify caught a cross-file test regression from a legitimate workflow edit (wave 8, 2026-07-02)** — the ci-tooling F-f05363e2 fix correctly changed the ingest.yml badge-regen fallback from a single-line `|| echo "::warning::"` to a `|| { echo; echo >> $GITHUB_STEP_SUMMARY; }` block (still fully non-fatal), but that broke a *sibling* test in a different file (`scripts/stageC-ingest-rejected-exit.test.mjs:422`) whose `F-caeeacc3` non-fatal assertion hard-coded the single-line shape. The agent extended its own new test and — per serial-final-verify discipline — did not run the full suite, so the cross-file break surfaced only at the coordinator's serial `npm run verify`. One targeted coordinator fix-up loosened the assertion to accept both forms and *strengthened* it (now also asserts no `exit 1` in the fallback). Lesson: workflow-YAML edits whose shape is pinned by structural tests in a *different* domain file are a recurring cross-file seam; the serial verify is the safety net that catches them, exactly as designed.
- **Stage-B fixed-by-absence classification did NOT fire (run `swarm-1783007856-9fdb`, wave 5, 2026-07-02)** — the expected ~109 Stage-A rows were NOT closed as `fixed-by-absence`; all 113 priors remain `open`/`unverified`. Root cause is a real interaction seam: the `health-audit-b` collect's full-coverage classification (`collect.js:818-826`, `fullCoverage` iff every agent-bearing domain is `complete` at collect time) was suppressed because the docs audit agent landed `invalid_output` (non-enum `category` free-text) on the first collect pass → partial coverage → `classifyFindings` ran without `{full:true}` → `Fixed: 0`. The lawful `swarm revalidate` recovery repaired docs to `complete` and flipped the wave to `collected`, but revalidate does NOT re-run the merge classification, and `collect` refuses to re-run on an already-`collected` wave (`collect.js:250`, dispatched-only). So there is **no lawful path to re-trigger the classification** short of a fresh audit wave; forcing it via SQL would be exactly the hack the protocol forbids. This is benign for Stage B (the coordinator does not advance; the open priors do not block the amend commit) and is arguably the repo's own conservative discipline ("partial-coverage waves surface unverified counts... we do not invent fixed verdicts"). **Stage C should be aware:** its re-audit is the natural place these priors get reclassified. Possible hardening (defer to advisor): make `revalidate` re-run the full-coverage classification when its repair flips a wave `failed → collected`, so a single invalid agent output no longer permanently suppresses fixed-by-absence for the whole wave. Related to the deferred finding **F-2c6d825d** (classifyFindings `approved`→`fixed` under `scope.full`, CP4-SCOPE-WIRING) — same classification surface.

- ~~**Logo** — testing-os has none. Brand repo references the legacy `dogfood-labs/readme.png`. Wants its own session: Sprite Foundry visual-pipeline pass + Mike's directional input.~~ — Done 2026-04-25 ([PR #11](https://github.com/dogfood-lab/testing-os/pull/11)). Logo (beagle + terminal frame) supplied by Mike, wired into README + handbook + favicon. Live at [dogfood-lab.github.io/testing-os/logo.png](https://dogfood-lab.github.io/testing-os/logo.png).
- ~~**README badges** — none on the new repo. World-forge has them; we should mirror.~~ — Done 2026-04-25 (Session C). 4 badges live (CI, Pages, License, Node).
- ~~**Translation pass** — 7 README languages.~~ — Done 2026-04-25 (Session D, [PR #10](https://github.com/dogfood-lab/testing-os/pull/10)).
- ~~**Astro handbook + Pages deployment** — biggest gap. The old `mcp-tool-shop-org.github.io/dogfood-labs/` site is the public face.~~ — Done 2026-04-25 (Session B). The legacy URL still serves; it dies when `mcp-tool-shop-org/dogfood-labs` is deleted in Session H.
- ~~**Schema `$id` URLs** — still legacy.~~ — Done 2026-04-25 (Session E). All 8 point at `dogfood-lab/testing-os` canonical paths; packages bumped to `0.2.0-pre`.
- ~~**Live verification** — we have CI green but no actual end-to-end dogfood run through the new repo yet.~~ — Done 2026-04-25 (Session A).
- **`DOGFOOD_TOKEN` secret missing on consumer repos** — surfaced during Session A. Without it, every consumer's `dogfood.yml` skips the dispatch step with a `DOGFOOD_TOKEN not set — skipping dispatch` warning. Affects: ai-loadout, claude-guardian, glyphstudio, site-theme, plus any future consumer. Need a fine-grained PAT (or GitHub App) with `contents: write` on `dogfood-lab/testing-os`, added as `DOGFOOD_TOKEN` to each consumer's secrets. **User-side action** (token creation requires Mike's auth).
- **ai-loadout build is broken on `main`** — surfaced during Session A. `tsc` fails with TS2591 / TS2534 on `node:fs`, `node:path`, `process` etc.; `@types/node` not effective. Pre-existing on main since at least the 2026-04-25 cutover commit. Independent of testing-os migration but blocks ai-loadout's own dogfood until fixed.
- **`HANDOFF.md` Session A step 4 used the wrong subcommand** — it said `npx @mcptoolshop/shipcheck audit --gate F …`, but the actual subcommand is `npx @mcptoolshop/shipcheck dogfood …`. The `audit` subcommand is the SHIP_GATE.md tracker, not the dogfood-freshness check. Fixed.
- ~~**Pinned action SHAs running on Node 20** — GitHub deprecation warning fired during the first ingest.yml run. Forced to Node 24 by 2026-06-02; Node 20 removed by 2026-09-16. Bump the SHAs before then.~~ — Done 2026-05-31 (Wave A1 D4). Bumped `actions/checkout` to v6.0.2 (node24 runtime, SHA `de0fac2e4500dabe0009e67214ff5f5447ce83dd`) in `ci.yml`, `ingest.yml`, `pages.yml`, `release.yml`.
- ~~**External-reference audit** — beyond the 4 codebases the recon swarm found, we never checked the prototypes seed vault, the brand repo, or external consumers.~~ — Done 2026-04-25 (Session F). All actionable refs cut over via [shipcheck#3](https://github.com/mcp-tool-shop-org/shipcheck/pull/3); intentional legacy refs documented in the Session F header.
- ~~**`scripts/sync-version.mjs`** — world-forge has it, we don't. Without it, README version line drifts.~~ — Done 2026-04-25 (Session C). Wired as `prebuild`; `npm run sync-version:check` is the CI gate.
- ~~**`CONTRIBUTING.md`** — none.~~ — Done 2026-04-25 (Session C). Points at CLAUDE.md as the operating manual.
- **TS conversion** — JS packages, not type-safe yet.
- ~~**First v1.0.0 stable release** — still on `0.1.0-pre`.~~ — Done 2026-04-25 (Session G). [Release v1.0.0](https://github.com/dogfood-lab/testing-os/releases/tag/v1.0.0).
- ~~**npm publish** — six of seven packages still `private: true`; `@dogfood-lab/schemas` is publish-ready (`publishConfig.access=public` + `files` whitelist) but unpublished. May want some public. Mike's call; defer until a downstream consumer needs it via npm.~~ — Done 2026-05-14 (v1.2.0). Six of seven packages published as `@dogfood-lab/{schemas,verify,report,ingest,findings,dogfood-swarm}`. `@dogfood-lab/portfolio` remains intentionally workspace-internal.
- **The 4 dispatcher orphans** (polyglot-vscode, repo-crawler-mcp, tool-scan, vocal-synth-engine) — folded into the prototypes seed vault. Their passports may still reference dogfood-labs paths. Audit happens in Session F.
- ~~**`.github/workflows/pages.yml`** — testing-os has only `ci.yml`. Need a Pages workflow for the handbook.~~ — Done 2026-04-25 (Session B). testing-os now has 3 workflows (`ci.yml`, `ingest.yml`, `pages.yml`) — exceeds the soft cap of 2 in `.claude/rules/github-actions.md`, but each has a distinct purpose. Surfaced in [PR #3](https://github.com/dogfood-lab/testing-os/pull/3).
- **Site-tree npm audit vulnerabilities** — surfaced during Session B. `site/package-lock.json` (inherited from legacy) reports 8 vulnerabilities (5 moderate, 3 high) in Astro/Starlight transitive deps. Not blocking deployment, but worth a `npm audit fix` pass.
- **CODEOWNERS** — none. Single-owner repo for now, but worth establishing the pattern.
- **SECURITY.md threat model section** — basic policy is in place; full threat model could be expanded with the migration's specific surfaces.

---

## Feature pass — waves 12–13 (run `swarm-1783007856-9fdb`, 2026-07-02/03)

The approved P0 feature cut, executed as two feature-execute waves after the health pass closed. Both waves: dispatched → 5 agent outputs collected (0 ownership violations) → serial `npm run verify` green → `swarm verify` receipt → committed → pushed → CI green.

**Shipped:**
- **swarm-cp (wave 12, commit 9d6e404):** `swarm defer` / `swarm reject` terminal-disposition verbs (targeted `--ids` + mandatory `--reason`, reason-bearing `finding_events` row, mirroring cmdApprove); `deferred`/`rejected` are CLOSED for the gate so a conscious defer is no longer laundered into `fixed`-by-absence (closes the F-2c6d825d advisor wrinkle noted in Stage B/C above). collect's `buildSummary` byStatus rollup made dynamic (was dropping `unverified`/`rejected`). revalidate now re-runs the full-coverage by-absence classification when a repaired audit wave flips `failed→collected` (closes the Stage-B "revalidate does not re-run classification" gap noted above). Pins in `packages/dogfood-swarm/wave12-swarm-cp-pins.test.js`.
- **backend (wave 12, 9d6e404):** `dogfood-verify lint --scenario <file>` — structural `validatePayload('scenario')` gate + author-time checks (required_step_undeclared, duplicate_step_id) + advisory filename↔scenario_id footgun, mirroring the VERIFY-F3 policy-lint UX.
- **docs (wave 12, 9d6e404):** new Read Model Reference handbook page (served consumer read API). CLI reference + SHIP_GATE + 3 handbook count-refs reconciled 24→26 for the new verbs.
- **self-dogfooding (wave 13, f8f2f76):** `.github/workflows/self-dogfood.yml` (5th workflow), `dogfood/scenarios/self-verify-gate.yaml`, README dogfood badge, structural pins in `scripts/self-dogfood-workflow.test.mjs`.

**Corners cut / carried forward:**
- **self-dogfood ACTIVATED end-to-end 2026-07-03 (task_9a11fd60 CLOSED).** The two blockers resolved: (1) the submission handoff moved to the local CLI (`npm ci` + `npm run build` + `node packages/report/cli.js`, stamping `workflow_run.head_sha`); (2) the PAT requirement was a DESIGN ERROR, not a token problem — GitHub's recursion prevention has a documented exception for `workflow_dispatch`/`repository_dispatch`, so same-repo dispatch runs on the workflow's own `GITHUB_TOKEN` with `contents: write` (commit `c0d8ecc`; two rounds of fine-grained-PAT 401/403 retired). The first live dispatch then caught a REAL receiver bug: ingest.yml never built, but verify imports `@dogfood-lab/schemas`' `dist/` entry — `ERR_MODULE_NOT_FOUND` before persist, a class no CI vantage can see (`npm run verify` always builds first); fixed + structurally pinned in `83c23a0`. **Result: first self-record accepted (`records/dogfood-lab/testing-os/2026/07/03/`, verdict pass, provenance confirmed, required-steps enforced with zero warnings), badge `brightgreen|pass`, `dogfood-report --status` exits 0 on the platform itself.** The old testing-os `DOGFOOD_TOKEN` repo secret is now unused and can be deleted; CONSUMER repos still need their PATs (cross-repo dispatch, line 359 above still stands).
- **Consumer template `examples/dogfood.yml` npx bug — FIXED 2026-07-03 (task_171ad1f7).** A bare `npx @dogfood-lab/report` resolves a `report` bin that the PUBLISHED @dogfood-lab/report@1.8.0 does not expose (only `dogfood-report`/`dogfood-init`; the `report` alias is committed locally but was never republished), so consumers hit exit 127 at the Build-submission step. Resolved via **Option 2 (docs/template fix, no republish)**: the consumer template (`examples/dogfood.yml` + its byte-identical bundled twin `packages/report/templates/dogfood.yml`), the `examples/README.md` local-check block, and the handbook integration page now invoke the canonical bin explicitly via `npx --yes --package @dogfood-lab/report dogfood-report` — the collision-proof form that already works in `self-dogfood.yml`. The F-74883f98 test + `packages/report/README.md` bin-table were reconciled: the `report` alias stays declared as a latent convenience but nothing depends on it, and the template-form assertion now pins the explicit form (and forbids the bare form). README front-door line reworded `npx @dogfood-lab/report`→`dogfood-report`; the 7 translated READMEs still carry the old phrase and regenerate at the next release per the translations-before-publish rule. **Option 1 (republish so the `report` alias ships) was declined** — the bare form the package's own README warns is a collision footgun wasn't worth a lockstep 6-package release; a future release may still activate the alias as a bonus.
- **Wave-12 cross-domain adoption.** The backend scenario-lint golden pin required all committed scenarios to be schema-clean, which surfaced a dead undocumented `success_criteria.all_steps_pass` on `swarm-audit.yaml` (rejected by the schema). The fix (drop the field + tighten `validate-scenarios.test.mjs` to whole-document validation) was applied and adopted as coordinator-authored cross-domain work (`dogfood/**` is unowned; the test is tests-domain), re-attributed honestly in the tests-domain output. The backend agent's summary described this as deferred, but its code had actually applied it — reconciled at collect.
- **stageD-output-dir-tracks-db.test.js is flaky under parallel `npm test`.** It snapshots the repo `swarms/` dir around a subprocess and fails if a concurrent test process's WAL sidecars (`control-plane.db-{shm,wal}`) appear in the window. Passes in isolation; unrelated to any feature code. Surfaced twice during serial verify; each time a checkpoint + sidecar cleanup + re-run went green. Candidate hardening: the test should ignore `control-plane.db-*` sidecars (they are transient SQLite artifacts, already git-ignored).
- **Second parallel-run flake in the same family (2026-07-03):** `packages/ingest/wave28-unsafe-segment-discipline.test.js` raced a sibling test's in-package scratch tree — its walker enumerated `packages/ingest/__test_root_d1b001__/**` mid-cleanup and `readFileSync` hit ENOENT. Passes in isolation (8/8). Two candidate hardenings, both cheap: move the d1b001 test's scratch dir to `os.tmpdir()` (the F-072c3d77 fix already applied to the findings package), and/or make package-tree walkers skip `__test_*` dirs + tolerate ENOENT on read. Until then this is the known race to suspect when a source-sweep test fails only under the full parallel suite. **Update (same day, third firing):** the wave28 walker got both hardenings (skip `__test_*` + ENOENT tolerance, shipped in the v1.9.0 release commit); the d1b001 tmpdir move remains open for any future recurrence elsewhere.
- **js-yaml 4→5 migration required before Dependabot #50 can merge (2026-07-03).** The v5 major breaks two script gates on the PR (`scripts/check-validator-cache-singleton.test.mjs`, `scripts/lint-policies.test.mjs`, both ERR_TEST_FAILURE within seconds — a real API incompatibility, not a flake). js-yaml parses every policy/scenario surface in the platform, so this is a deliberate one-session migration: read the v5 changelog, migrate call sites/imports, run the full verify chain on Node 22+24, then merge the PR. The other five 2026-07-03 Dependabot PRs (#44/#51/#52/#49 Astro 7/#48 site-theme 2.1) merged clean — the two site majors validated live by the deployed accent-reconciliation + pa11y gates. Security alerts: 0 open.
- **Removed a dead fixture:** `packages/verify/fixtures/scenarios/invalid/not-yaml.yaml` (committed by the backend agent but referenced by no test — the parse-failure test writes its own temp file).
- **`CLAUDE.md` still says "Four workflows"** — now five with self-dogfood.yml. Ungated (no doc-drift/test enforces the count), left as a deliberate doc-staleness rather than edit the repo's own rules file mid-feature-pass; worth a one-line reconciliation in a docs follow-up.
- **README front-door lint advisory** flags a pre-existing line ("dogfood swarm (internal process)") as internal-status-report tone — pre-existing, not touched by the badge edit; a marketing-tone cleanup out of this pass's scope.

Ledger at close: `swarm findings` shows 0 open CRIT/HIGH. The 12 open MED/LOW rows (all `unverified`) are the health-pass residuals; feature-execute waves don't reclassify findings, so they settle at the next audit-type collect (the proven fixed-by-absence flow).

---

## Notes for Claude picking this up

Read [CLAUDE.md](CLAUDE.md) **first**. Then pick the lowest-numbered unchecked session above and finish it. Don't skip ahead. Don't bundle sessions unless they share genuine work — each session is sized to be a clean unit.

When a session is done:

1. Check the box (use `[x]` not `[X]`)
2. Add a one-line `**Completed YYYY-MM-DD**` note under the session header
3. Commit with subject `Session <X>: <one-line summary>`
4. Move on

If a session reveals something we missed, add it to "Things we didn't have time for tonight" at the bottom of this file. Better to capture and defer than skip silently.

**Eat first. Ship second.**
