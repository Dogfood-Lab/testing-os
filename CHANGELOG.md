# Changelog

All notable changes to `testing-os` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-25

First stable release. The migration from `mcp-tool-shop-org/dogfood-labs` is complete and the post-migration polish in [HANDOFF.md](HANDOFF.md) sessions A–G has shipped. Consumers can now pin to `^1.0.0` confidently.

### Added

- **`@dogfood-lab/schemas`** — TypeScript package with the 8 JSON schemas (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). 5 vitest tests.
- **`@dogfood-lab/verify`** — central submission validator (290 `node:test` tests across the JS packages).
- **`@dogfood-lab/findings`** — finding contract + derive/review/synthesis/advise pipelines.
- **`@dogfood-lab/ingest`** — pipeline glue: dispatch → verify → persist → indexes.
- **`@dogfood-lab/report`** — submission builder for source repos.
- **`@dogfood-lab/portfolio`** — cross-repo portfolio generator.
- **`@dogfood-lab/dogfood-swarm`** — 10-phase parallel-agent protocol + SQLite control plane + `swarm` CLI bin (173 tests).
- **`.github/workflows/ingest.yml`** — receives `repository_dispatch` of type `dogfood_submission` from consumers, runs the ingest pipeline, commits new records and indexes back to `main`. Concurrency-safe (per-repo group, no cancel-in-progress) with retry-on-conflict push loop.
- **`.github/workflows/pages.yml`** — builds and deploys the Astro Starlight handbook to [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Includes a verify-200 curl loop that fails the deploy on stale CDN.
- **`site/`** — Astro Starlight handbook with 7 pages (architecture, beginners, contracts, integration, intelligence layer, operating guide, and the index landing). Migrated from the legacy repo with full link rewrites for the new layout.
- **README.md badges + version-sync block** — CI, Pages, License, Node ≥ 20 badges; `<!-- version:start -->` block auto-stamped from `package.json` via `scripts/sync-version.mjs` (runs as `prebuild`).
- **`CONTRIBUTING.md`** — points at `CLAUDE.md` as the operating manual.
- **`SHIP_GATE.md`** + **`SCORECARD.md`** — `shipcheck`-driven product standards. Hard gates A–D pass at 100%.
- **README.md threat model paragraph** — what this code touches, what it doesn't, permissions required, telemetry posture.
- **Logo** at `assets/logo.png` and `site/public/logo.png` — wired into the README header and the handbook's Starlight chrome.
- **7 README translations** (ja, zh, es, fr, hi, it, pt-BR) via polyglot-mcp's `translate-all.mjs`. Language nav bar at the top of every variant.
- **GitHub repo metadata** — description, homepage, topics (`ai-tooling`, `dogfood-lab`, `mcp-tool-shop`, `monorepo`, `npm-workspaces`, `testing`).

### Changed

- All 8 JSON schemas (`packages/schemas/src/json/*.json`) now have `$id` URLs pointing at the canonical monorepo location: `https://github.com/dogfood-lab/testing-os/packages/schemas/src/json/<name>.schema.json`. Replaces the legacy `mcp-tool-shop-org/dogfood-labs/schemas/...` URLs.
- npm scope `@dogfood-labs/*` (legacy, plural) is retired; everything is `@dogfood-lab/*` (singular).
- HANDOFF.md tracks Sessions A–G as complete; Session H (legacy-repo deletion) is gated on Mike's explicit approval and a 30-day grace window per the doc.

### Deprecated

- The legacy repo `mcp-tool-shop-org/dogfood-labs` is **archived** (read-only). Its raw URLs continue to serve until Session H deletes the repo.
- `repo-knowledge`'s back-compat fallback for `tools/findings/cli.js` (legacy layout) remains intentional until Session H confirms no callers depend on it.

### Verified end-to-end (Session A)

- Consumer dogfood (`mcp-tool-shop-org/claude-guardian`) → manual dispatch (because consumer `DOGFOOD_TOKEN` secret is missing — tracked as a follow-up) → `ingest.yml` run [24922250743](https://github.com/dogfood-lab/testing-os/actions/runs/24922250743) → record [`records/mcp-tool-shop-org/claude-guardian/2026/04/25/run-claude-guardian-24922209099-1.json`](records/mcp-tool-shop-org/claude-guardian/2026/04/25/run-claude-guardian-24922209099-1.json) → `latest-by-repo.json` updated → `shipcheck dogfood` exits 0 → `repo-knowledge sync-dogfood` populates 91 facts.

### Known follow-ups

- `DOGFOOD_TOKEN` secret missing on every consumer repo — dispatch step skips with a warning. User-side action.
- ai-loadout `main` build is broken (`tsc` errors on missing `@types/node`); independent of this migration.
- All pinned action SHAs (`actions/checkout@34e1148`, `actions/setup-node@49933ea`, etc.) are Node 20 — GitHub deprecates Node 20 by 2026-09-16.
- `site/` `npm audit` reports 8 vulnerabilities (5 moderate, 3 high) inherited from the legacy lockfile; not blocking deployment.
- Workspace dep scanning + Dependabot config not yet wired into CI; tracked under SHIP_GATE.md hygiene SKIPs.
- All 7 packages are `private: true`. The `npm publish` decision is deferred per HANDOFF.md Session G.

## [Unreleased]

(Open for the next change set.)
