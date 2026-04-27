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
5. Inspect the `unknown_freshness` array — entries here have unparseable `record.timing.finished_at` timestamps (`computeFreshnessDays` returned `null`, route added by F-246817-005). Without this step the entries silently bypass the freshness review forever. For each entry, identify the source repo from `repo`, fix the submission emitter to produce a well-formed ISO 8601 timestamp, and re-dispatch.

This page documents the **record classification + portfolio bucket** state machine. For the finding-review state machine (`candidate → reviewed → accepted`), see [Intelligence Layer](../intelligence-layer/). For the wave-classification state machine (`new`/`recurring`/`fixed`/`unverified`), see the [State Machines reference](../state-machines/).

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

1. Create a policy YAML in `policies/repos/<org>/<repo>.yaml` (where `<org>` is `dogfood-lab` or `mcp-tool-shop-org`) with `enforcement.mode: required`
2. Identify the correct surface type from the 8 defined surfaces: cli, desktop, web, api, mcp-server, npm-package, plugin, library
3. Define required scenarios and freshness thresholds in the policy under `surfaces.<surface>`
4. In the source repo, create `dogfood/scenarios/<scenario-id>.yaml` following the scenario contract
5. Create a dogfood workflow in the source repo (`.github/workflows/dogfood.yml`) that builds a submission and dispatches to testing-os
6. The source workflow should use the submission builder (`packages/report/build-submission.js`) to produce a canonical submission
7. **Add the `DOGFOOD_TOKEN` secret to the consumer repo** — required for the dispatch step. Mint a fine-grained PAT (or GitHub App token) with `contents: write` scoped to `dogfood-lab/testing-os`, then add it under the consumer repo's **Settings → Secrets and variables → Actions** as `DOGFOOD_TOKEN`. Without this, the workflow runs green but skips dispatch with a `DOGFOOD_TOKEN not set` warning and no record reaches testing-os. See [GitHub docs on fine-grained PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).
8. Run the workflow, verify ingestion produces an accepted record, confirm the repo appears in `indexes/latest-by-repo.json`
9. Run `npx @mcptoolshop/shipcheck dogfood --repo <org>/<repo> --surface <surface>` on the source repo to confirm Gate F passes (the `dogfood` subcommand is the freshness/Gate F check; `audit` is the SHIP_GATE.md tracker for hard gates A–D)

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

The handbook itself is served via GitHub Pages, which is also CDN-backed — handbook edits typically take a few minutes to propagate after `pages.yml` deploys.

## Corrupted Record Recovery

`packages/ingest/rebuild-indexes.js` returns `{ accepted, rejected, corrupted, skipped }`. The `corrupted[]` array carries `{ path, error }` for any record whose JSON could not be parsed. The rebuild does not fail on corruption — it skips the record, logs `[rebuild-indexes] corrupted record skipped: <path> — <error>` to stderr, and continues. The skipped record is excluded from `latest-by-repo.json`, so the index is silently incomplete until repaired.

Recovery procedure:

1. Identify corrupted records — either from the `corrupted[]` return array or by grepping the rebuild stderr for `corrupted record skipped`.
2. For each `corrupted[].path`:
   - **Repair** the JSON if the cause is obvious (truncation, encoding bleed) and re-run `node packages/ingest/rebuild-indexes.js`.
   - **Or**, if the record cannot be salvaged: read the `run_id` from the path, re-dispatch the source workflow to produce a clean record, then delete the corrupted file and rebuild.
3. Verify the record now appears in `indexes/latest-by-repo.json`.

The same `rebuild-indexes` call also returns `skipped[]` for records that loaded but lacked a `run_id` — same recovery shape (re-dispatch with a complete submission), different root cause.

## Error Codes

For the structured error codes that surface from ingest and dogfood-swarm CLIs (`RECORD_SCHEMA_INVALID`, `DUPLICATE_RUN_ID`, `ISOLATION_FAILED`, `COLLECT_UPSERT_FAILED`, `STATE_MACHINE_*`), see the [Error Code Reference](../error-codes/).

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
