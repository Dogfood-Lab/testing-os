---
title: Architecture
description: How testing-os ingests, verifies, and persists dogfood evidence
sidebar:
  order: 1
---

## Data Flow

```
Source repo workflow
  → Builds structured submission (JSON)
  → Emits via repository_dispatch to testing-os

testing-os ingestion pipeline
  → Schema validation (AJV against JSON Schema)
  → Provenance check (GitHub API — verify run actually happened)
  → Policy evaluation (enforcement tier, required scenarios, freshness)
  → Verdict computation (source proposes, verifier confirms or downgrades)

  → Accepted: records/<org>/<repo>/YYYY/MM/DD/<run-id>.json
  → Rejected: records/_rejected/<org>/<repo>/YYYY/MM/DD/<run-id>.json

  → Index rebuild: indexes/latest-by-repo.json, failing.json, stale.json
```

## Key Design Decisions

### Central Ingestion

Source repos never write records directly. They emit structured payloads via `repository_dispatch`, and only the testing-os bot writes to the records directory. This prevents source repos from fabricating evidence.

### Verdict Ownership

The source repo proposes a verdict (`overall_verdict` in the submission). The verifier can confirm or downgrade — never upgrade. A source claiming "pass" that fails schema or policy validation becomes "fail."

### Sharded Persistence

Records are stored at `records/<org>/<repo>/YYYY/MM/DD/<run-id>.json`. This provides natural time-sharding, easy browsing, and clean git history without merge conflicts.

### Generated Indexes

`latest-by-repo.json` is rebuilt from accepted records after every ingestion. Consumers read indexes, not the raw record tree. This keeps reads fast without scanning git history.

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Verifier | `packages/verify/` | Schema, provenance, policy, verdict validation |
| Ingestion | `packages/ingest/` | Pipeline orchestration, atomic persistence, index rebuild |
| Submission builder | `packages/report/` | Canonical submission assembly for source repos |
| Portfolio | `packages/portfolio/` | Org-level summary generation |

### Verifier Pipeline (7 steps)

The verifier (`packages/verify/index.js`) processes each submission through seven stages in order:

1. **Schema validation** -- validates the submission against `dogfood-record-submission.schema.json` using AJV.
2. **Verifier-owned field guard** -- rejects submissions that include fields only the verifier may set (`policy_version`, `verification`, or `overall_verdict` as an object).
3. **Provenance check** -- confirms the source workflow run actually exists via the GitHub Actions API (or a stub adapter in tests).
4. **Step results validation** -- checks that each scenario's required steps have matching results and that verdicts are internally consistent.
5. **Policy evaluation** -- evaluates enforcement tier, required scenarios, freshness, and execution-mode constraints from the repo or global policy.
6. **Verdict computation** -- computes the final verdict. The source proposes a verdict string; the verifier may confirm or downgrade, never upgrade. Verdict severity from highest to lowest: fail, blocked, partial, pass.
7. **Record assembly** -- builds the persisted record with verifier-owned fields (`verification.status`, `verification.verified_at`, `overall_verdict.verified`, `overall_verdict.downgraded`).

### Generated Indexes

The index generator (`packages/ingest/rebuild-indexes.js`) produces three files after every ingestion:

| Index | Content |
|-------|---------|
| `indexes/latest-by-repo.json` | Latest accepted record per repo and surface -- the primary read model for consumers |
| `indexes/failing.json` | Records where the verified verdict is not `pass` |
| `indexes/stale.json` | Repo/surface pairs with no accepted record within the staleness threshold (default 30 days) |

### Atomic Persistence

Records are written atomically: the persist layer writes to a temporary file, then renames it to the final path. Duplicate detection by `run_id` prevents double-writes. Accepted records go to `records/<org>/<repo>/YYYY/MM/DD/`, rejected records to `records/_rejected/<org>/<repo>/YYYY/MM/DD/`.

## Enforcement Tiers

| Mode | Behavior | Default |
|------|----------|---------|
| `required` | Blocks on violation | Yes -- all repos start here |
| `warn-only` | Warns but doesn't block | Must have documented reason + review date |
| `exempt` | Skips evaluation entirely | Must have documented reason + review date |

Missing policy defaults to `required` -- the safe default.
