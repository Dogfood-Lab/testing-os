# Enforcement Tiers

Gate F reads enforcement policy from `policies/repos/<org>/<repo>.yaml`.

## Modes

| Mode | Gate F behavior | Exit code on failure |
|------|----------------|---------------------|
| `required` | Full evaluation — fail blocks release | 1 |
| `warn-only` | Full evaluation — warn but don't block | 0 |
| `exempt` | Skip evaluation entirely | 0 |

Default when policy file is missing: **required**.

## Policy YAML shape

```yaml
enforcement:
  mode: required | warn-only | exempt
  reason: "why this mode was chosen"       # required if not 'required'
  review_after: "2026-06-01"               # required if 'exempt'
```

## Onboarding a new repo

1. Create `policies/repos/<org>/<repo>.yaml` with at minimum:
   ```yaml
   repo: org/repo
   policy_version: "1.0.0"

   enforcement:
     mode: required

   surfaces:
     <surface>:
       required_scenarios:
         - <scenario-name>
       freshness:
         max_age_days: 30
         warn_age_days: 14
       execution_mode_policy:
         allowed: [bot]
       ci_requirements:
         coverage_min: null
         tests_must_pass: true
       evidence_requirements:
         required_kinds: [log]
         min_evidence_count: 1
   ```

2. Create the dogfood workflow in the source repo (`.github/workflows/dogfood.yml`) that dispatches to testing-os (`dogfood-lab/testing-os`) on success.

3. **Add the `DOGFOOD_TOKEN` secret to the consumer repo.** Mint a fine-grained PAT (or GitHub App token) with **`contents: write`** scoped to `dogfood-lab/testing-os`, then configure it under the consumer's **Settings → Secrets and variables → Actions** as `DOGFOOD_TOKEN`. Without it, the consumer's `dogfood.yml` runs green but the dispatch step skips with a `DOGFOOD_TOKEN not set` warning and the workflow appears successful while no record reaches testing-os — the most common silent-failure mode for new repos. See [GitHub docs on fine-grained PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).

4. Run the workflow once to seed the first record.

5. Verify: `npx @mcptoolshop/shipcheck dogfood --repo org/repo --surface <surface>`

## When to use warn-only

- Repo is newly onboarded and scenario may need tuning
- Repo is in active refactor that breaks the dogfood scenario temporarily
- Always set `reason` explaining the circumstance

## When to use exempt

- Repo is archived or deprecated
- Repo has no user-facing surface (pure library consumed only internally)
- Always set `reason` and `review_after` (max 90 days out)

## Promotion path

```text
exempt → warn-only → required
```

New repos start at `required` unless there's a documented reason not to. Downgrades require a reason in the policy file.

## Operator note: read-after-write timing

Gate F fetches the dogfood index via `raw.githubusercontent.com`, which has a CDN cache of 3–5 minutes. After a fresh dogfood run is ingested:

- The git index is updated immediately
- Gate F may read stale data for up to 5 minutes
- This resolves without intervention

This is expected CDN behavior, not a product defect. See `docs/rollout-doctrine.md` for details.
