# Dogfood Operating Cadence

How dogfood governance runs day-to-day. Covers review cycles, escalation, and policy lifecycle.

## Weekly: Freshness Review

1. Run the portfolio generator: `node packages/portfolio/generate.js`
2. Inspect `reports/dogfood-portfolio.json` — check the `stale` array
3. Any repo with `freshness_days > 14` gets a warning flag
4. Any repo with `freshness_days > 30` is a violation — re-run the dogfood scenario or document why it's blocked
5. Inspect the `unknown_freshness` array — entries here have unparseable `record.timing.finished_at` (`computeFreshnessDays` returned `null`, route added by F-246817-005). They silently bypass the `stale` check; for each, fix the source repo's submission emitter to produce a well-formed ISO 8601 timestamp and re-dispatch.

**Owner:** whoever runs the review (currently manual)

## Monthly: Policy Calibration

1. Review all `warn-only` and `exempt` repos for promotion to `required`
2. Check `review_after` dates in policy YAMLs — any past-due repos must be evaluated
3. Promotion criteria: repo has passed dogfood at least twice on `required`-equivalent scenarios
4. If a repo can't promote, document why and set a new `review_after` date

**Default destination:** `required`. Every repo should get there eventually.

## On Failure

1. Investigate root cause — is it the scenario, the repo, or the infrastructure?
2. Fix the scenario or repo, not the governance system
3. Update doctrine only if the failure reveals a genuinely new seam (see `docs/rollout-doctrine.md`)
4. Never weaken enforcement to make a failure go away

## New Repos

1. Create a policy YAML in `policies/repos/<org>/<repo-name>.yaml` — `<org>` is `dogfood-lab` or `mcp-tool-shop-org` (testing-os accepts dispatched submissions from both)
2. Default enforcement: `required` — use `warn-only` only with a documented `reason` and `review_after` date
3. Create a dogfood workflow in the repo (`.github/workflows/dogfood.yml`)
4. Identify the correct surface type from the 8 defined surfaces
5. Write a scenario that exercises the real product interface (see "entrypoint truth" in rollout doctrine)
6. **Add the `DOGFOOD_TOKEN` secret to the consumer repo** — fine-grained PAT (or GitHub App token) with `contents: write` scoped to `dogfood-lab/testing-os`, configured under the consumer's **Settings → Secrets and variables → Actions** as `DOGFOOD_TOKEN`. Without it, the consumer's `dogfood.yml` runs green but the dispatch step skips with a `DOGFOOD_TOKEN not set` warning and no record ever reaches testing-os. See [GitHub docs on fine-grained PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).
7. Run the workflow, verify ingestion, confirm Gate F passes via `npx @mcptoolshop/shipcheck dogfood --repo <org>/<repo> --surface <surface>`

## Doctrine Updates

- Only from real failures, never speculative
- Each new rule must cite the incident that motivated it
- Keep the list short — if it grows past ~15 rules, consolidate

## CDN Cache Timing

`raw.githubusercontent.com` caches for 3-5 minutes. After a fresh ingestion:
- Gate F reads from the CDN and may see stale data for up to 5 minutes
- This is operational, not a product defect
- If a verification run shows "fail" immediately after ingestion, wait 3-5 minutes and retry
- See `docs/enforcement-tiers.md` operator note for details

## Consumers

| Consumer | How it reads | Frequency |
|----------|-------------|-----------|
| shipcheck Gate F | GitHub raw URL (CDN) | On demand (per repo check) |
| repo-knowledge | `rk sync-dogfood` (local or URL) | On demand / periodic |
| Portfolio generator | Local file read | On demand |

All consumers are read-only. testing-os is the sole write authority.
