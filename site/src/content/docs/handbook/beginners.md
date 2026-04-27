---
title: Beginner's Guide
description: Getting started with testing-os from scratch
sidebar:
  order: 0.5
---

This guide walks you through testing-os from zero -- what the system is, how it works, and how to add your first repo.

## What is testing-os?

testing-os is a centralized evidence system that proves each repo under the [Dogfood Lab](https://github.com/dogfood-lab) and [mcp-tool-shop-org](https://github.com/mcp-tool-shop-org) GitHub orgs was actually exercised as a real product. Rather than trusting that a tool was tested, testing-os collects structured JSON records from automated workflows, validates them against schemas and policies, and persists accepted evidence with a full audit trail.

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

testing-os has **two distinct status vocabularies** that operate at different layers — they look adjacent but they are not the same state machine. See the [State Machines reference](../state-machines/) for the full picture.

- **Record classification (ingest layer):** every persisted record carries `verification.status` of `accepted` or `rejected`. Portfolio buckets layer on top of that: `stale`, `unknown_freshness`, `missing`. Index rebuild has its own per-record outcome buckets: `accepted`, `rejected`, `corrupted`, `skipped`.
- **Finding review (intelligence layer):** every finding moves through `candidate → reviewed → accepted → (invalidated)`. This governs human review of derived lessons, not record persistence.
- **Wave classification (swarm layer):** the dogfood-swarm classifier compares each wave's findings against the prior wave and emits `new`, `recurring`, `fixed`, `unverified`. `unverified` means the prior finding's path was outside the current wave's scope — the agent did not look, so we cannot claim it was fixed. Distinct from finding-review `accepted`.

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

A healthy run looks like this — green checkmarks across every workspace package and a clean exit:

<figure>
  <img
    src="/testing-os/screenshots/verify-output.svg"
    alt="Terminal output of a healthy npm run verify in the testing-os repo. The sequence runs sync-version:check (clean, README block matches package.json), check-doc-drift (5 of 5 checks passed), test:scripts (24 sync-version tests, 14 check-doc-drift tests — all pass), tsc --build (composite refs, no errors), and the workspace test fan-out across schemas (vitest, passed), verify (node --test, passed), ingest (passed), findings (passed), report (passed), portfolio (passed), and dogfood-swarm (passed). Each package shows a green check and the test runner used. No red, no warnings."
    style="width: 100%; height: auto;"
  />
  <figcaption>Healthy `npm run verify` output. If a package shows red instead of a green check, fix the failure before proceeding — the verify gate is the canonical pre-commit check.</figcaption>
</figure>

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

4. **Add the `DOGFOOD_TOKEN` secret to the consumer repo** (required — without it, dispatch silently skips).
   - Mint a fine-grained PAT (or GitHub App token) with **`contents: write`** scoped to `dogfood-lab/testing-os` (this is what the receiver workflow needs to commit records and indexes back to `main`).
   - Add it under the consumer repo's **Settings → Secrets and variables → Actions** as `DOGFOOD_TOKEN`.
   - GitHub docs: [Creating a fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).
   - **Failure mode if missing:** the consumer's `dogfood.yml` runs successfully (green CI), but the dispatch step is skipped with a `DOGFOOD_TOKEN not set` warning, no submission reaches testing-os, and no record ever appears in `indexes/latest-by-repo.json`. This is the most common silent-failure new contributors hit — see Troubleshooting below.

5. **Run the workflow** and verify the record appears in [`indexes/latest-by-repo.json`](https://github.com/dogfood-lab/testing-os/blob/main/indexes/latest-by-repo.json) (allow 3-5 min for `raw.githubusercontent.com` CDN cache to refresh — the handbook itself is served via GitHub Pages, also CDN-backed, so handbook edits can take a few minutes to surface after deploy. See [Operating Guide → CDN Cache Timing](../operating-guide/#cdn-cache-timing)).

### Investigating a failure

When a submission is rejected:

> Rejected records are committed back to the testing-os repo (not your local machine) by `ingest.yml`. Browse them on GitHub at [`records/_rejected/`](https://github.com/dogfood-lab/testing-os/tree/main/records/_rejected/), or `git clone https://github.com/dogfood-lab/testing-os && ls records/_rejected/` to inspect locally.

1. Check `records/_rejected/` for the rejected record -- the `verification.rejection_reasons` array lists every reason.
2. Common causes: schema validation failure, provenance not confirmed, policy violation, step verdict inconsistency. For a structured error code (e.g. `RECORD_SCHEMA_INVALID`, `DUPLICATE_RUN_ID`), see the [Error Code Reference](../error-codes/).
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
| Consumer workflow is green, but no record appears in `indexes/latest-by-repo.json` | `DOGFOOD_TOKEN` secret is missing on the consumer repo — the dispatch step skipped with a `DOGFOOD_TOKEN not set` warning | Add `DOGFOOD_TOKEN` (fine-grained PAT with `contents: write` on `dogfood-lab/testing-os`) under the consumer's **Settings → Secrets and variables → Actions** |
| Portfolio shows `Unknown freshness: <n>` and entries in `unknown_freshness[]` | `record.timing.finished_at` was unparseable — `computeFreshnessDays` returned `null` and the entry was routed out of the `stale` bucket | Inspect each `unknown_freshness[].raw_finished_at`, fix the source repo to emit a well-formed ISO 8601 timestamp, re-dispatch. Don't ignore — these silently bypassed the freshness review |
| `[rebuild-indexes] corrupted record skipped: <path>` in CI logs | A persisted record file failed JSON.parse; the rebuild kept going and the record is excluded from indexes | Check the `corrupted[]` array returned by `rebuild-indexes` (or the stderr line) for `{ path, error }`, open the file, fix or remove, then re-run `node packages/ingest/rebuild-indexes.js` |
| CLI prints `ERROR [<CODE>]: …` with a `Next:` hint | A typed error surfaced from ingest or dogfood-swarm | Look the code up in the [Error Code Reference](../error-codes/) and follow the hint |
