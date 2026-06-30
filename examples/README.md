# Onboard your repo in 5 minutes

This folder is a copy-pasteable starter kit for dogfooding a repo into
[testing-os](https://github.com/dogfood-lab/testing-os). Everything here is a
template — copy it into your repo and fill in the blanks.

| File | What it is |
|------|------------|
| [`dogfood.yml`](dogfood.yml) | The GitHub Actions workflow that packages a run and dispatches it. Copy to `.github/workflows/dogfood.yml` in **your** repo. |
| [`scenario-results.example.json`](scenario-results.example.json) | The shape your test output must take — an array of `scenario_result` objects. |
| [`policy.example.yaml`](policy.example.yaml) | A starter repo policy — per-surface requirements plus declarative [custom rules](https://dogfood-lab.github.io/testing-os/handbook/policy-dsl/) (VERIFY-F1). Open a PR to add yours at `policies/repos/<org>/<repo>.yaml`. |

## The five minutes

1. **Mint the token.** Create a fine-grained PAT with **`contents: write` on `dogfood-lab/testing-os`**, then add it to your repo as the secret **`DOGFOOD_TOKEN`** (Settings → Secrets and variables → Actions). *This is the step everyone forgets — the workflow's preflight fails loud if it's missing, instead of going green with nothing recorded.*

2. **Copy the workflow.** Drop [`dogfood.yml`](dogfood.yml) into `.github/workflows/`. Change `workflows: ["CI"]` to the name of your test workflow (or fold its steps into your existing test job).

3. **Emit scenario results.** Make your test run produce a `scenario-results.json` matching [the example](scenario-results.example.json). Each entry names a `product_surface` (cli, web, api, mcp-server, …), an `execution_mode` (bot/human/mixed), a `verdict`, and its `step_results`.

4. **Check it locally first (optional).** Build a submission and dry-run it against the contract before you ever dispatch:
   ```bash
   npx @dogfood-lab/report --scenario-file scenario-results.json --verdict pass --output submission.json
   npx @dogfood-lab/verify --file submission.json --explain
   ```
   `--explain` tells you whether it would be accepted and, if not, classifies each rejection as *your* problem (submission-bad) or *ours* (operational).

5. **Push.** The next time your test workflow completes, `dogfood.yml` builds the submission, dispatches it, and testing-os verifies the provenance (it confirms your run actually happened) and records the evidence. Watch it land in the [ingest workflow](https://github.com/dogfood-lab/testing-os/actions/workflows/ingest.yml), then see your repo in [`latest-by-repo.json`](https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/latest-by-repo.json).

## What testing-os does with it

It confirms the GitHub Actions run you claim is real (via the GitHub API), binds the submission to your repo and commit, checks it against your policy, and commits the record. Your repo then appears in the read-side indexes and gets a status badge. The full contract — submission schema, policy reference, error codes — is in the [handbook](https://dogfood-lab.github.io/testing-os/handbook/).

**On GitLab?** testing-os also supports GitLab CI provenance — set `provider: gitlab` in the submission's source block and supply a GitLab token. See the [integration guide](https://dogfood-lab.github.io/testing-os/handbook/integration/).
