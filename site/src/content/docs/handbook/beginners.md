---
title: Beginner's Guide
description: Getting started with testing-os from scratch
sidebar:
  order: 99
---

This guide walks you through testing-os from zero -- what the system is, how it works, and how to add your first repo.

## What is testing-os?

testing-os is a centralized evidence system that proves each repo in the mcp-tool-shop-org was actually exercised as a real product. Rather than trusting that a tool was tested, testing-os collects structured JSON records from automated workflows, validates them against schemas and policies, and persists accepted evidence with a full audit trail.

The core question it answers: "Was this repo actually used the way a real user would use it, and can we prove it?"

Every repo starts at the strictest enforcement level (`required`), and weakening enforcement requires a documented reason and a review date.

## Key Terminology

| Term | Meaning |
|------|---------|
| **Record** | A JSON document proving a dogfood run happened. Source repos author submissions; the verifier produces persisted records. |
| **Scenario** | A YAML file in the source repo (`dogfood/scenarios/*.yaml`) defining what constitutes a real exercise -- steps, preconditions, success criteria. |
| **Policy** | A YAML file in testing-os (`policies/repos/<org>/<repo>.yaml`) defining enforcement rules: which scenarios are required, freshness thresholds, allowed execution modes. |
| **Surface** | The product type being exercised. The 8 defined surfaces are: `cli`, `desktop`, `web`, `api`, `mcp-server`, `npm-package`, `plugin`, `library`. |
| **Verdict** | The outcome of a dogfood run. Four levels from most to least severe: `fail`, `blocked`, `partial`, `pass`. |
| **Enforcement tier** | How strictly a repo is governed: `required` (default, blocks on violation), `warn-only` (warns but does not block), or `exempt` (skipped entirely). |
| **Provenance** | Proof that a claimed workflow run actually happened. In production, confirmed via the GitHub Actions API. |
| **Ingestion** | The pipeline that receives a submission, runs it through the verifier, persists the result, and rebuilds indexes. |

## Architecture Overview

testing-os follows a write-once, verify-centrally architecture:

1. **Source repos** define scenarios and run dogfood workflows in their own CI.
2. **Source workflows** build a structured submission JSON and dispatch it to testing-os via `repository_dispatch`.
3. **The ingestion pipeline** receives the submission and passes it to the verifier.
4. **The verifier** validates schema, checks provenance, evaluates policy, and computes the final verdict. It may confirm or downgrade the proposed verdict but never upgrades it.
5. **Accepted records** are written atomically to `records/<org>/<repo>/YYYY/MM/DD/`.
6. **Rejected records** land in `records/_rejected/` with machine-readable rejection reasons.
7. **Indexes** are rebuilt after every write: `latest-by-repo.json` (primary read model), `failing.json`, and `stale.json`.

Downstream consumers like shipcheck (Gate F) and repo-knowledge read the indexes -- they never write to testing-os.

## Installation and Setup

testing-os is an npm workspaces monorepo with seven packages under `@dogfood-lab/*`. A single root `npm ci` installs everything.

```bash
# Clone the repo
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os

# Install dependencies for every workspace
npm ci
```

To run the full test suite:

```bash
npm run verify
```

This builds the TypeScript schemas package and runs the workspace-wide test suite (vitest for `schemas`, `node --test` for the JS packages).

## Basic Usage

### Running a local ingestion (test mode)

You can test the ingestion pipeline locally using stub provenance (which skips GitHub API verification):

```bash
# Create a test submission (the report builder helps)
node packages/report/build-submission.js \
  --repo mcp-tool-shop-org/my-repo \
  --commit abc1234567890 \
  --workflow dogfood.yml \
  --provider-run-id 12345 \
  --run-url https://github.com/mcp-tool-shop-org/my-repo/actions/runs/12345 \
  --scenario-file my-scenario-results.json \
  --output submission.json

# Ingest the submission with stub provenance
node packages/ingest/run.js --file submission.json --provenance=stub
```

The `--provenance=stub` flag is only allowed outside CI. In GitHub Actions, provenance defaults to real GitHub API verification.

### Generating the portfolio report

```bash
node packages/portfolio/generate.js
# Output: reports/dogfood-portfolio.json
```

This reads the latest index and all repo policies to produce a summary of coverage, freshness, stale repos, and repos with policies but no records.

### Checking indexes

The three generated indexes in `indexes/` are the primary read interface:

- `latest-by-repo.json` -- latest accepted record per repo and surface
- `failing.json` -- records where the verified verdict is not `pass`
- `stale.json` -- repo/surface pairs exceeding the staleness threshold

## Common Workflows

### Adding a new repo to dogfood governance

1. **Create a policy file** at `policies/repos/mcp-tool-shop-org/<repo>.yaml`:

```yaml
repo: mcp-tool-shop-org/<repo>
policy_version: "1.0.0"

enforcement:
  mode: required

surfaces:
  cli:  # or desktop, web, api, mcp-server, npm-package, plugin, library
    required_scenarios:
      - my-scenario-id
    freshness:
      max_age_days: 14
      warn_age_days: 7
    execution_mode_policy:
      allowed: [bot]
    ci_requirements:
      coverage_min: null
      tests_must_pass: true
    evidence_requirements:
      required_kinds: [log]
      min_evidence_count: 1
```

2. **Create a scenario file** in the source repo at `dogfood/scenarios/my-scenario-id.yaml` defining the steps that constitute a real exercise of the product.

3. **Create a dogfood workflow** in the source repo at `.github/workflows/dogfood.yml` that:
   - Builds and runs the scenario
   - Uses the submission builder to produce a canonical submission
   - Dispatches the submission to testing-os via `repository_dispatch`

4. **Run the workflow** and verify the record appears in `indexes/latest-by-repo.json`.

### Investigating a failure

When a submission is rejected:

1. Check `records/_rejected/` for the rejected record -- the `verification.rejection_reasons` array lists every reason.
2. Common causes: schema validation failure, provenance not confirmed, policy violation, step verdict inconsistency.
3. Fix the issue in the source repo's scenario or workflow, not in testing-os governance.
4. Re-run the dogfood workflow.

### Weekly freshness review

1. Run `node packages/portfolio/generate.js`
2. Open `reports/dogfood-portfolio.json` and check the `stale` array
3. Repos with `freshness_days > 14` need attention; repos over 30 days are in violation
4. Re-run the source repo's dogfood workflow or document the blocking reason

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Submission rejected with `schema:` errors | Submission JSON does not match `dogfood-record-submission.schema.json` | Run `precheckSubmission()` from the report builder to catch issues before dispatch |
| Submission rejected with `provenance:` errors | The claimed workflow run could not be confirmed via GitHub API | Ensure `GITHUB_TOKEN` has `actions:read` scope; verify the `source.provider_run_id` and `source.run_url` match a real run |
| Submission rejected with `submission-contains-verifier-field` | The submission includes fields that only the verifier may set (`policy_version`, `verification`, or `overall_verdict` as an object) | Remove verifier-owned fields from the submission; use the submission builder to avoid this |
| Verdict downgraded from `pass` to `fail` | A required step failed, policy validation failed, or provenance was not confirmed | Check `overall_verdict.downgrade_reasons` in the persisted record for specifics |
| Gate F fails in shipcheck | The repo has no accepted record, the verdict is not `pass`, or the record is stale | Re-run the dogfood workflow; check that the CDN cache has refreshed (3-5 minutes after ingestion) |
| `--provenance=stub` rejected in CI | Stub provenance is blocked when `CI=true` or `GITHUB_ACTIONS=true` | Use `--provenance=github` in CI with a valid `GITHUB_TOKEN` |
| Portfolio shows repo in `missing` array | The repo has a policy file but no accepted record in the index | Run the dogfood workflow for that repo at least once |
| Tests fail in `npm run verify` | Workspace dependencies may be missing | Run `npm ci` at the repo root once — npm workspaces installs every package in a single pass |
