---
title: Operating Guide
description: Day-to-day operations for testing-os governance
sidebar:
  order: 3
---

## Weekly: Freshness Review

1. Run the portfolio generator: `node packages/portfolio/generate.js`
2. Check `reports/dogfood-portfolio.json` — inspect the `stale` array
3. Repos with `freshness_days > 14` get a warning flag
4. Repos with `freshness_days > 30` are in violation — re-run the scenario or document the block

## Monthly: Policy Calibration

1. Review all `warn-only` and `exempt` repos for promotion to `required`
2. Check `review_after` dates — past-due repos must be evaluated
3. Promotion criteria: repo has passed dogfood at least twice on required-equivalent scenarios
4. If a repo can't promote, document why and set a new `review_after` date

## On Failure

1. Investigate root cause — is it the scenario, the repo, or the infrastructure?
2. Fix the scenario or repo, not the governance system
3. Update rollout doctrine only if the failure reveals a genuinely new seam
4. Never weaken enforcement to make a failure go away

## New Repo Onboarding

1. Create a policy YAML in `policies/repos/mcp-tool-shop-org/<repo>.yaml` with `enforcement.mode: required`
2. Identify the correct surface type from the 8 defined surfaces: cli, desktop, web, api, mcp-server, npm-package, plugin, library
3. Define required scenarios and freshness thresholds in the policy under `surfaces.<surface>`
4. In the source repo, create `dogfood/scenarios/<scenario-id>.yaml` following the scenario contract
5. Create a dogfood workflow in the source repo (`.github/workflows/dogfood.yml`) that builds a submission and dispatches to testing-os
6. The source workflow should use the submission builder (`packages/report/build-submission.js`) to produce a canonical submission
7. Run the workflow, verify ingestion produces an accepted record, confirm the repo appears in `indexes/latest-by-repo.json`
8. Run `npx @mcptoolshop/shipcheck audit` on the source repo to confirm Gate F passes

## Running Ingestion Locally

The ingestion CLI (`packages/ingest/run.js`) requires an explicit `--provenance` flag:

```bash
# Production (in CI) -- verifies source runs via GitHub API
node packages/ingest/run.js --file submission.json --provenance=github

# Local development / testing -- uses a stub that always confirms
node packages/ingest/run.js --file submission.json --provenance=stub
```

The `--provenance=stub` flag is blocked in CI environments (`CI=true` or `GITHUB_ACTIONS=true`) as a safety measure. In CI without an explicit flag, the ingestion pipeline defaults to GitHub provenance and requires `GITHUB_TOKEN`.

## CDN Cache Timing

`raw.githubusercontent.com` caches for 3-5 minutes. After a fresh ingestion, Gate F may read stale data. This is operational, not a product defect. Wait 3-5 minutes and retry.

## Rollout Doctrine

10 rules learned from real failures during expansion:

1. **Surface truth** — the scenario must match the real product surface
2. **Build output truth** — verify the actual build artifact, not just source
3. **Protocol truth** — use the real protocol the product exposes
4. **Runtime truth** — exercise in the real runtime environment
5. **Process truth** — test the actual process lifecycle
6. **Dispatch truth** — verify the dispatch mechanism works end-to-end
7. **Concurrency truth** — handle concurrent ingestion gracefully
8. **Verdict truth** — source proposes, verifier confirms or downgrades
9. **Evidence truth** — evidence must be machine-verifiable
10. **Entrypoint truth** — use the real CLI interface, not assumed flags
