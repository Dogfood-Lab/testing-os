<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
</p>

<div align="center">

# testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Operating system for testing in the AI era**

*Protocols, evidence stores, and learning loops for AI-assisted software.*

<!-- version:start -->
**v1.9.0** — current release. See [CHANGELOG.md](CHANGELOG.md) for what shipped.
<!-- version:end -->

📖 **[Read the handbook →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## What This Is

`testing-os` records, verifies, and learns from your repo's real test evidence in an AI-native workflow. Point it at a repo, and every test run becomes a provenance-confirmed record you can trust — not a self-reported pass.

What you get:

- **Provenance-confirmed records.** Every submission is bound to a real CI run — keyless, via the provider's own identity — before it's accepted. The result is a tamper-evident, append-only evidence store, not an honor-system green check.
- **A policy contract you control.** Declare what counts as "verified" in YAML — a bounded, no-eval predicate DSL (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) — and enforce it across your repos. Lint a policy before you ship it with `dogfood-verify lint`.
- **A parallel-agent swarm protocol.** Run multi-agent audits against a codebase, then turn raw findings into reusable patterns and doctrine.
- **A live status surface.** Per-repo records, indexes, and a status badge, all served from one evidence store.

It's the flagship monorepo of the [Dogfood Lab](https://github.com/dogfood-lab) org — seven `@dogfood-lab/*` packages behind one `swarm` CLI.

## Quick Start

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Want your own repo's test evidence recorded here? The **[`examples/` starter kit](examples/)** gets you dispatching in five minutes (`dogfood-report` builds the submission; `dogfood-init` scaffolds the workflow). The operator's guide, CLI reference, schema reference, and integration recipes live in the **[handbook](https://dogfood-lab.github.io/testing-os/handbook/)**. Per-version detail is in [CHANGELOG.md](CHANGELOG.md).

## Threat Model

testing-os processes dogfood submissions dispatched via `repository_dispatch` from trusted GitHub repos under `mcp-tool-shop-org/*` and `dogfood-lab/*`. The verifier requires CI provenance — claimed run IDs are confirmed via the provider's API, and submissions with malformed shapes, missing references, or invalid policy claims are rejected.

**Provenance is the attestation.** For a `github` submission the verifier confirms the claimed GitHub Actions run actually exists (GitHub API) and binds the submission's `repo` and `commit_sha` to that confirmed run — a live, keyless check rooted in GitHub's own OIDC identity, so a record cannot attest to a run or commit that did not happen. **GitLab CI** is supported opt-in (`source.provider: gitlab`); a GitLab submission is the one case the verifier calls a non-GitHub host (`gitlab.com/api`), and only for `gitlab` submissions.

**Record integrity is tamper-EVIDENT, not tamper-proof.** Every persisted record carries an `integrity` block (`submission_digest` + `prev_digest`) forming an append-only hash chain that `node packages/ingest/run.js --verify-chain` validates fully offline — detecting out-of-band tampering, disk corruption, and partial restores. It does **not** defend against the ingest credential itself, which can rewrite both a record and the chain; closing that needs an anchor outside the writer's control. An **optional, off-by-default XRPL anchor** (`node packages/ingest/run.js --anchor-*`) witnesses the chain head to the public XRP Ledger, making any truncation or rewrite below an anchored point detectable — the second disclosed non-GitHub call, and only when an operator enables it.

**What testing-os touches:** the submission JSON in each `repository_dispatch` payload; `policies/`, `fixtures/`, `records/`, and `indexes/` in this repo; outbound calls to `api.github.com` for provenance verification; and — for `github` submissions only — a read-only fetch of the submitting repo's `dogfood/scenarios/<scenario_id>.yaml` at the attested commit (the scenario definition that powers required-steps enforcement; size-capped and schema-validated before use, absent files simply leave that check unenforced with a visible warning).

**What testing-os does NOT touch:** consumer source code beyond the declared `dogfood/scenarios/` definition files, secrets in consumer repos beyond the dispatch envelope, or anything outside this repo's working tree.

**Network surface.** By default the only egress is `api.github.com` (read-only: provenance confirmation + the scenario-definition fetch above). The two exceptions are both opt-in and disclosed above: a GitLab-provider submission (`gitlab.com/api`), and an operator-enabled XRPL anchor run. **No telemetry, no analytics — this codebase never phones home; absent those two opt-in paths it exposes no network surface beyond GitHub.** The receiver workflow runs with `contents: write` scoped to this repo only.

## Packages

| Package | Source | Purpose |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | The 8 JSON schemas (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Central submission validator. Submissions pass through here before they're persisted. |
| `@dogfood-lab/findings` | JS | Finding contract + derive/review/synthesis/advise pipelines. |
| `@dogfood-lab/ingest` | JS | Pipeline glue: dispatch → verify → persist → index. |
| `@dogfood-lab/report` | JS | Submission builder for source repos. |
| `@dogfood-lab/portfolio` | JS | Cross-repo portfolio generator. |
| `@dogfood-lab/dogfood-swarm` | JS | The 10-phase parallel-agent protocol + SQLite control plane + `swarm` bin. |

Sibling testing tools that **stay independent** but integrate via published APIs: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Layout

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json, trends.json, badges/ (shields.io endpoints)
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml
```

## Local Development

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Requires Node ≥ 22. CI matrix runs Node 22 + 24 on `ubuntu-latest`; locally validated on Node 25.

**Supported filesystems:** APFS, HFS+, ext4 (CI baseline), NTFS — anything that implements POSIX `link(2)`. **Not supported:** exFAT, FAT32. The file-lock CAS in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requires hardlink semantics for atomic publication; on exFAT, `linkSync` throws `ENOTSUP` (loud, not silent). Common gotcha: cross-platform external SSDs are often formatted exFAT — clone the repo to local APFS/HFS+ instead. See [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) for the full Session G validation matrix.

## Versioning

All `@dogfood-lab/*` packages bump together — one number across the monorepo. Six packages publish to npm under `@dogfood-lab` at v1.9.0 in lockstep (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); the seventh, `@dogfood-lab/portfolio`, stays internal. The version line near the top of this README is auto-stamped from `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) on every `npm run build`.

## License

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Handbook](https://dogfood-lab.github.io/testing-os/handbook/)** · **[All Repositories](https://github.com/orgs/dogfood-lab/repositories)** · **[Profile](https://github.com/dogfood-lab)**

*Eat first. Ship second.*

</div>
