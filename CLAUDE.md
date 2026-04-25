# CLAUDE.md — testing-os repo etiquette

> **Mission frame.** This repo is the testing operating system for an AI-augmented studio. Everything written here — code, commit messages, docs, tests — is also training data for the model that will write the next generation of testing tools. **There is no sense in training on bad data.** Quality over quickness. Clean over clever.

## What this repo is

`testing-os` is the flagship monorepo of the [Dogfood Lab](https://github.com/dogfood-lab) GitHub org — successor to the now-archived `mcp-tool-shop-org/dogfood-labs`. It bundles the protocols, schemas, and operating system for testing AI-assisted software at scale.

Seven workspace packages, all `@dogfood-lab/*`:

| Package | Purpose | Source style |
|---------|---------|---------------|
| `schemas` | 8 JSON schemas (record/finding/pattern/recommendation/doctrine/policy/scenario/submission) | TypeScript |
| `verify` | Central submission validator | JS |
| `findings` | Finding contract + derive/review/synthesis/advise pipelines | JS |
| `ingest` | Pipeline glue: dispatch → verify → persist → indexes | JS |
| `report` | Submission builder | JS |
| `portfolio` | Cross-repo portfolio generator | JS |
| `dogfood-swarm` | 10-phase parallel-agent protocol + SQLite control plane + `swarm` bin | JS |

JS packages use `node --test`. The TS schemas package uses `vitest`. Root `npm test` fans out via `npm test --workspaces --if-present`.

## Hard rules — these have been violated and they cost real time

### 1. Quality over quickness — always
Every line you write may end up in a training set. Sloppy code teaches sloppy code. Half-finished features teach half-finished features. **Don't add a stub and move on.** Either finish the slice or don't start it. If you're under time pressure, ship less, not worse.

### 2. Never narrate what the code does — explain why when non-obvious
Bad: `// loop over the items`. Good: `// retry from index 0 because earlier items may have been mutated by the previous batch`. Most code needs no comment at all — well-named identifiers do the job. Comments rot; code self-documents.

### 3. Don't write to `dist/`, `*.tsbuildinfo`, `node_modules/`, or `swarms/control-plane.db`
All ignored. If a tool produces them, that's fine — they're regenerated. Never commit them.

### 4. Cross-package imports go through the workspace, not relative paths
- ✅ `import { verify } from '@dogfood-lab/verify'`
- ✅ `import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js'`
- ❌ `import { verify } from '../verify/index.js'`

The `exports` field in each `package.json` controls what's reachable. Add a subpath export when a sibling package needs an internal file.

### 5. Schema JSON files live in `packages/schemas/src/json/` — read via `createRequire`
```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const schemaPath = require.resolve('@dogfood-lab/schemas/json/dogfood-finding.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
```

Never duplicate schemas at the repo root. There is one source of truth: the `schemas` package.

### 6. Tests run against real fixtures, not mocks
Mocked validators that pass while production fails are worthless. The runtime data dirs (`policies/`, `fixtures/`, `records/`, `indexes/`) exist precisely so tests exercise the real code paths.

### 7. Don't roll the build forward when packages are still empty
[scripts/build.mjs](scripts/build.mjs) is wave-tolerant: it skips `tsc --build` when `packages/` has no real package, and runs it for real once one exists. Keep that pattern when adding new TS packages — the gate is "does `packages/<name>/package.json` exist".

### 8. Ignore the `claude-preview` hook
This repo is a Node monorepo (CLIs + a SQLite-backed control plane), **not** a web app. The hook will demand `preview_start` after every edit — ignore it. Verification here is `npm test`, `npm run build`, `npm pack`, never a browser.

### 9. Never push directly to main on consumer repos
Even if you have admin and the change is one line, **open a PR**. The cutover precedent (Wave 6 of the migration) hard-coded this lesson: bulk direct push to 8 shared repos was correctly blocked. Branch + PR + Mike's review is the floor.

### 10. Match existing patterns before inventing
This repo mirrors `world-forge` deliberately (npm workspaces, `tsc --build` composite refs, lockstep versioning, single path-driven CI). When in doubt, look at how `world-forge` does it. Don't add Turbo, changesets, or a different test runner without explicit need.

## Conventions

### npm scope and naming
- Scope: `@dogfood-lab/*` (singular, no `s` — that suffix is the legacy `@dogfood-labs/*` which is retired)
- Package names mirror the directory: `packages/findings/` → `@dogfood-lab/findings`. Exception: `dogfood-swarm` (the directory name disambiguates from generic "swarm")

### Versioning
**Lockstep.** All packages bump together. Currently **`1.0.0`** ([release v1.0.0 cut 2026-04-25](https://github.com/dogfood-lab/testing-os/releases/tag/v1.0.0)). The README's `<!-- version:start -->` block is auto-stamped by `scripts/sync-version.mjs` (runs as `prebuild`). Use `npm run sync-version:check` as a CI gate when you bump.

### TypeScript
`tsconfig.base.json` is the only place to set compiler options. Per-package `tsconfig.json` extends it and adds `outDir`/`rootDir`/`include`. `composite: true` everywhere. Never set `baseUrl` (deprecated; bit repo-knowledge in CI).

### CI + workflows
Three workflows, each with a distinct purpose — exceeds the org-wide soft cap of 2 from `.claude/rules/github-actions.md`, but each is genuinely needed and bundling would be worse:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | `push` / `pull_request` on `packages/**`, `package*.json`, `tsconfig*.json`, `.github/workflows/**` | Build + test on Node 20 + 22 |
| `ingest.yml` | `repository_dispatch` (`dogfood_submission`) + `workflow_dispatch` | Receives consumer dogfood submissions, runs `packages/ingest/run.js --provenance=github`, commits new records + indexes back to `main`. Concurrency-safe per-repo. |
| `pages.yml` | `push` to `main` on `site/**` or `.github/workflows/pages.yml` | Builds the Astro Starlight handbook, deploys to `dogfood-lab.github.io/testing-os/`, curls the URL with retry to verify deploy. |

All action SHAs pinned (no floating `@v4`). The $130 GitHub Actions incident memory (`memory/github-actions-incident.md`) is why.

Adding a fourth workflow needs explicit justification.

### Commit messages
Subject line = imperative, ≤72 chars. Body explains *why* the change is being made — what changed is in the diff. Co-author trailer included. Wave-style commit messages (used during the migration) are good for orientation but not required forever.

### Test fixtures
Tests that need policy/schema/record fixtures read them from the runtime data dirs (`policies/`, `fixtures/`, `records/`). The `setupTestRoot()` pattern in `packages/ingest/ingest.test.js` is the model — copy known-good data into a temp dir, exercise the code, assert.

When a new test needs a new fixture, add it under `fixtures/<category>/<scenario>.yaml` (or `.json`). Fixture filenames should describe what they exercise: `valid/well-formed-mcp-server-record.yaml`, `invalid/missing-source-record-ids.yaml`.

### Schemas
JSON Schema 2020-12. Title and description on every schema and every property. `additionalProperties: false` unless an open-ended bag is genuinely intended. The 8 current schemas in `packages/schemas/src/json/` are the canonical examples.

`$id` URLs point at the canonical monorepo path: `https://github.com/dogfood-lab/testing-os/packages/schemas/src/json/<name>.schema.json`. If you ever change a schema in a way that consumers should treat as a contract change, bump the workspace lockstep version — `$id` is a contract field.

### Ship gate
`SHIP_GATE.md` at the repo root tracks what shipcheck audits. Hard gates A–D (Security, Errors, Operator Docs, Hygiene) currently pass at 100% (20 checked / 17 SKIP-with-justification / 0 unchecked). Soft gate E (Identity) is fully met. Re-run `node F:/AI/shipcheck/bin/shipcheck.mjs audit` before any release; if a previously-checked item fails, fix the underlying gap before bumping the version.

### Runtime data dirs at the repo root
`policies/`, `fixtures/`, `records/`, `indexes/`, `reports/`, `swarms/`, `dogfood/`, `docs/`. These are the **shared backing store** that consumers (e.g. `repo-knowledge`, `shipcheck`) read from via `raw.githubusercontent.com/dogfood-lab/testing-os/main/...` URLs. The paths inside those dirs are part of the public API. **Don't reorganize them without thinking about every consumer first.**

## Verification

The full local check:
```bash
npm install
npm run build      # tsc --build (composite refs)
npm test           # workspace fan-out: vitest for schemas, node --test for the rest
npm run verify     # build + test (the canonical pre-commit check)
```

Per-package isolation:
```bash
npm test --workspace @dogfood-lab/findings
```

CI runs the same `verify` flow on Node 20 + 22.

## Working with the legacy

The legacy repo (`mcp-tool-shop-org/dogfood-labs`) is **archived but not deleted**. The 30-day grace window before Session H delete started 2026-04-25. Several historical references remain on purpose:

- Old records have `repo: "mcp-tool-shop-org/dogfood-labs"` and old paths in their provenance — these are historical truth, not bugs
- `dogfood-lab/testing-os/policies/repos/mcp-tool-shop-org/dogfood-labs.yaml` — the policy file *for* the legacy repo itself; archived artifact
- `swarms/manifest-schema.json` `$id` is `dogfood-labs.local/...` — a local-namespace URL, not a GitHub reference
- `repo-knowledge`'s `loadIntelligenceExport` has a back-compat fallback that tries `tools/findings/cli.js` (legacy layout) after `packages/findings/cli.js` (new layout) — keep that fallback until Session H verifies no callers depend on it

Schema `$id` URLs **were updated** in Session E and now point at the canonical monorepo path. Do not roll those back.

When in doubt about a legacy reference: **don't normalize it for aesthetics**. The historical record is the historical record.

## Mission, finally

This repo is named `testing-os` because that's its function: the operating system *for* testing. Its own quality bar must be exemplary. If `testing-os` ships sloppy tests, no one will trust its judgment about anyone else's tests. The way out of that trap is a daily discipline:

> **Read the failing test before reading the production code. Write the failing test before writing the fix. Run `npm run verify` before pushing. When you cut a corner, write down the corner you cut in [HANDOFF.md](HANDOFF.md) so it doesn't disappear.**

Eat first. Ship second.
