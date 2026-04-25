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
rk sync-dogfood --local F:/AI/dogfood-lab/testing-os

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
node packages/findings/cli.js advise --surface mcp-server
```

Returns starter checks, evidence expectations, likely failure classes, relevant doctrine, and supporting lineage.

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
