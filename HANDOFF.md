# HANDOFF.md — testing-os migration completion

> **Purpose.** This is the session-based roadmap that takes us from the current state (testing-os live + dogfood-labs archived) to the final state (testing-os production-grade + dogfood-labs **safely deleted**). Each session below is a discrete unit of work — pick one up cold, finish it, check it off.
>
> **Current state (2026-04-25, end of session 1):**
>
> - ✅ Waves 1–7 of the migration shipped. testing-os has 7 packages, 468 tests, CI green on Node 20+22.
> - ✅ All known consumers cut over via PRs and merged: ai-loadout, claude-guardian, glyphstudio, site-theme, role-os, shipcheck, repo-knowledge.
> - ✅ Legacy `mcp-tool-shop-org/dogfood-labs` archived (read-only) with migration banner.
>
> **What stops us from deleting dogfood-labs today:**
>
> - The Astro Starlight handbook + GitHub Pages deployment never moved over — old URL still serves
> - Schema `$id` URLs still resolve to the legacy path
> - testing-os has no logo, no README badges, no translations, no Pages site
> - We haven't actually verified a single live dogfood run lands in testing-os end-to-end
> - Unknown external consumers may still be hitting `raw.githubusercontent.com/mcp-tool-shop-org/dogfood-labs/main/...`
> - Issues, PR history, Actions runs, and Pages site of the old repo aren't archived externally
>
> Each session below closes one of those gaps. Session H is the green light to delete.

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
6. **(Optional)** publish to npm. Currently all packages are `private: true` — flip that on the ones we want public, then `npm publish --workspaces --access public`.

**Acceptance:** v1.0.0 tag exists, GitHub release published, CHANGELOG updated.

**Estimated effort:** 30 min (shipcheck pass + version bump + release).

---

## Session H — Delete dogfood-labs (final)

**Goal.** Safely delete the legacy repo. Reversible only via GitHub support.

**Why this is last.** Once deleted, all the URLs go to 404. Sessions A–G ensure nothing depends on those URLs anymore.

**Pre-flight checklist:**

- [x] Session A done — verified end-to-end flow works on the new repo
- [x] Session B done — handbook lives at `dogfood-lab.github.io/testing-os/`
- [ ] Session C done — brand + badges + version stamping in place
- [ ] Session D done — 7 translations published
- [ ] Session E done — `$id` URLs flipped, schemas bumped
- [ ] Session F done — zero unintentional external references
- [ ] Session G done — v1.0.0 tagged and released
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
- [ ] **Wait 30+ days after archive.** Lets external consumers fail loudly. Don't rush.
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

- **Logo** — testing-os has none. Brand repo references the legacy `dogfood-labs/readme.png`.
- **README badges** — none on the new repo. World-forge has them; we should mirror.
- **Translation pass** — 7 README languages.
- ~~**Astro handbook + Pages deployment** — biggest gap. The old `mcp-tool-shop-org.github.io/dogfood-labs/` site is the public face.~~ — Done 2026-04-25 (Session B). The legacy URL still serves; it dies when `mcp-tool-shop-org/dogfood-labs` is deleted in Session H.
- **Schema `$id` URLs** — still legacy.
- ~~**Live verification** — we have CI green but no actual end-to-end dogfood run through the new repo yet.~~ — Done 2026-04-25 (Session A).
- **`DOGFOOD_TOKEN` secret missing on consumer repos** — surfaced during Session A. Without it, every consumer's `dogfood.yml` skips the dispatch step with a `DOGFOOD_TOKEN not set — skipping dispatch` warning. Affects: ai-loadout, claude-guardian, glyphstudio, site-theme, plus any future consumer. Need a fine-grained PAT (or GitHub App) with `contents: write` on `dogfood-lab/testing-os`, added as `DOGFOOD_TOKEN` to each consumer's secrets. **User-side action** (token creation requires Mike's auth).
- **ai-loadout build is broken on `main`** — surfaced during Session A. `tsc` fails with TS2591 / TS2534 on `node:fs`, `node:path`, `process` etc.; `@types/node` not effective. Pre-existing on main since at least the 2026-04-25 cutover commit. Independent of testing-os migration but blocks ai-loadout's own dogfood until fixed.
- **`HANDOFF.md` Session A step 4 used the wrong subcommand** — it said `npx @mcptoolshop/shipcheck audit --gate F …`, but the actual subcommand is `npx @mcptoolshop/shipcheck dogfood …`. The `audit` subcommand is the SHIP_GATE.md tracker, not the dogfood-freshness check. Fixed.
- **Pinned action SHAs in `ingest.yml` and `ci.yml` are Node 20** — GitHub deprecation warning fired during the first ingest.yml run. Forced to Node 24 by 2026-06-02; Node 20 removed by 2026-09-16. Bump the SHAs before then.
- **External-reference audit** — beyond the 4 codebases the recon swarm found, we never checked the prototypes seed vault, the brand repo, or external consumers.
- **`scripts/sync-version.mjs`** — world-forge has it, we don't. Without it, README version line drifts.
- **`CONTRIBUTING.md`** — none.
- **TS conversion** — JS packages, not type-safe yet.
- **First v1.0.0 stable release** — still on `0.1.0-pre`.
- **npm publish** — all packages still `private: true`. May want some public.
- **The 4 dispatcher orphans** (polyglot-vscode, repo-crawler-mcp, tool-scan, vocal-synth-engine) — folded into the prototypes seed vault. Their passports may still reference dogfood-labs paths. Audit happens in Session F.
- ~~**`.github/workflows/pages.yml`** — testing-os has only `ci.yml`. Need a Pages workflow for the handbook.~~ — Done 2026-04-25 (Session B). testing-os now has 3 workflows (`ci.yml`, `ingest.yml`, `pages.yml`) — exceeds the soft cap of 2 in `.claude/rules/github-actions.md`, but each has a distinct purpose. Surfaced in [PR #3](https://github.com/dogfood-lab/testing-os/pull/3).
- **Site-tree npm audit vulnerabilities** — surfaced during Session B. `site/package-lock.json` (inherited from legacy) reports 8 vulnerabilities (5 moderate, 3 high) in Astro/Starlight transitive deps. Not blocking deployment, but worth a `npm audit fix` pass.
- **CODEOWNERS** — none. Single-owner repo for now, but worth establishing the pattern.
- **SECURITY.md threat model section** — basic policy is in place; full threat model could be expanded with the migration's specific surfaces.

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
