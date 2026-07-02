---
title: Integration
description: How other systems consume dogfood status from testing-os
sidebar:
  order: 4
---

testing-os is the sole write authority for dogfood evidence. Other systems consume this data as read models.

## Consumers

| System | How it reads | What it does |
|--------|-------------|--------------|
| **shipcheck** | GitHub raw URL (CDN) | Gate F enforcement — blocks or warns based on dogfood status |
| **repo-knowledge** | `rk sync-dogfood` (local or URL) | Mirrors facts into SQLite for portfolio queries |
| **repo-knowledge** | `sync-export --json` | Ingests accepted findings, patterns, recommendations, doctrine |
| **role-os** | Advice bundles | Consumes inherited guidance for bootstrap/review contexts |
| **org audit** | Portfolio JSON | Includes dogfood status in audit posture |

## Onboarding your repo

The fastest path is the [`examples/` starter kit](https://github.com/dogfood-lab/testing-os/tree/main/examples): copy `dogfood.yml` into your repo, add a `DOGFOOD_TOKEN` secret (a fine-grained PAT with `contents: write` on `dogfood-lab/testing-os`), and push. The workflow's preflight fails loud if the token is missing — the one setup step everyone forgets. The CLIs that back it:

- **`npx @dogfood-lab/report`** (`dogfood-report`) — builds the submission envelope from your scenario results and the standard `GITHUB_*` env vars.
- **`dogfood-init`** — scaffolds the workflow + scenario template into your repo and prints the token setup. **`dogfood-init --check`** runs an onboarding preflight doctor (token / scenario file / repo slug / workflow trigger / upstream policy) so you find the gaps before the first real dispatch instead of after.
- **`npx @dogfood-lab/verify --file <submission> --explain`** — dry-runs a submission against the contract before you dispatch, classifying any rejection as *submission-bad* (your fix) vs *operational* (ours).
- **`dogfood-report --status --repo <org/repo>`** — closes the loop *after* dispatch. Because ingest runs asynchronously in the receiver repo, your workflow goes green the instant the dispatch returns — even if the submission is later rejected. This command reads the public served index (no auth) and tells you whether your latest run was recorded, accepted (or rejected, with the reason), and fresh; it exits non-zero on rejected/absent so a CI step fails loud instead of green-on-silent-non-record. The scaffolded `dogfood.yml` runs it best-effort after dispatch.

### Provenance providers

Provenance confirms your CI run actually happened and binds your `repo` + `commit_sha` to it — a record cannot attest to a run that did not occur.

- **GitHub Actions** (default) — `source.provider: github`, confirmed via the GitHub API.
- **GitLab CI** (opt-in) — `source.provider: gitlab`, confirmed via the GitLab API with a GitLab token (`GITLAB_TOKEN` / `CI_JOB_TOKEN`). This is the only case the verifier calls a non-GitHub host.

### Record integrity

Every persisted record carries an `integrity` hash chain (`submission_digest` + `prev_digest`). `node packages/ingest/run.js --verify-chain` (run in a testing-os checkout) validates it fully offline; an optional, off-by-default XRPL anchor (`node packages/ingest/run.js --anchor-compute|--anchor-post|--anchor-verify`) witnesses the chain head externally so truncation or rewrite below an anchored point is detectable. The integrity model — tamper-evident by default, tamper-proof only with the anchor — is documented in the [README threat model](https://github.com/dogfood-lab/testing-os#threat-model).

## shipcheck Gate F

shipcheck reads `indexes/latest-by-repo.json` from the GitHub raw CDN and evaluates:
- Is the repo in the index?
- Is the surface verified pass?
- Is the freshness within threshold?

Combined with the enforcement tier from the policy YAML:
- `required` — fail on violation
- `warn-only` — warn but exit 0
- `exempt` — skip evaluation, exit 0

## repo-knowledge Read Model

The `sync-dogfood` command reads the index and policy files, then upserts structured facts into the `repo_facts` table:

| Fact Key | Example Value |
|----------|--------------|
| `surface:cli:verified` | pass |
| `surface:cli:enforcement` | required |
| `surface:cli:freshness_days` | 2 |
| `surface:cli:run_id` | shipcheck-1-1 |
| `surface:cli:finished_at` | 2026-03-20T... |
| `status` | pass (worst-case rollup) |
| `surfaces` | cli |

Usage:
```bash
# From local checkout
rk sync-dogfood --local ./testing-os

# From GitHub (default)
rk sync-dogfood
```

## Portfolio JSON

The portfolio generator reads the index and all policy files, producing a summary at `reports/dogfood-portfolio.json`:

```bash
node packages/portfolio/generate.js
```

Output includes coverage counts, per-repo entries with freshness, stale repos, and repos with policies but no index entry.

## Intelligence Layer Consumption

The [intelligence layer](../intelligence-layer/) adds a second consumption path beyond raw dogfood status.

### Advice Bundles

Future projects query for inherited guidance:

```bash
node packages/findings/cli.js advise --surface mcp-server          # human-readable
node packages/findings/cli.js advise --surface mcp-server --json    # machine-readable
```

Returns starter checks, evidence expectations, likely failure classes, relevant doctrine, and supporting lineage. `--json` emits the advice bundle as pure JSON to stdout (no formatting, pipeable) for programmatic consumers like shipcheck and repo-knowledge.

### Sync Export

All accepted learning artifacts can be exported as structured JSON for repo-knowledge:

```bash
node packages/findings/cli.js sync-export --json
```

The export includes accepted findings, patterns, recommendations, and doctrine with full provenance IDs preserved.

### role-os Consumption

role-os can pull advice bundles into bootstrap and review contexts. role-os is a downstream consumer only --- it does not write back to testing-os or own any learning artifacts.

## Key Invariant

**testing-os writes truth, consumers mirror truth.** No consumer should edit, reinterpret, or "fix" dogfood data. If the data is wrong, fix it in testing-os. This applies to both raw dogfood status and intelligence layer artifacts.
