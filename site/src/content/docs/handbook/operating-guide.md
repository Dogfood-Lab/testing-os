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

## Filesystem Requirements

testing-os assumes POSIX `link(2)` semantics for atomic publication in the file-lock CAS (`packages/findings/lib/file-lock.js`, shipped in v1.1.5). All major dev/CI filesystems support this:

| Filesystem | Hardlinks | Status |
|---|---|---|
| APFS (macOS) | yes | supported |
| HFS+ (legacy macOS) | yes | supported |
| ext4 (Linux) | yes | supported (CI baseline) |
| NTFS (Windows) | yes | supported |
| **exFAT** | **no** | **NOT supported** — `linkSync` throws `ENOTSUP` |
| FAT32 | no | not supported |

The failure mode on exFAT is loud: callers see `ENOTSUP: operation not supported on socket, link ...` from `findings/lib/file-lock.js:atomicCreateLock`. Production code paths that write to a review log on exFAT will throw at the user rather than silently degrade.

**Common operator gotcha:** cross-platform external SSDs (e.g., Samsung T7/T9, SanDisk Extreme) are typically formatted exFAT for Windows + macOS interop. Clone testing-os to local APFS/HFS+/ext4 instead. The Session G validation matrix at [`docs/m5-validation-2026-04-29.md`](https://github.com/dogfood-lab/testing-os/blob/main/docs/m5-validation-2026-04-29.md) walks through the full APFS-vs-exFAT comparison.

## Running Ingestion Locally

The ingestion CLI (`packages/ingest/run.js`) requires an explicit `--provenance` flag:

```bash
# Production (in CI) -- verifies source runs via GitHub API
node packages/ingest/run.js --file submission.json --provenance=github

# Local development / testing -- uses a stub that always confirms
node packages/ingest/run.js --file submission.json --provenance=stub
```

The `--provenance=stub` flag is blocked in CI environments (`CI=true` or `GITHUB_ACTIONS=true`) as a safety measure. In CI without an explicit flag, the ingestion pipeline defaults to GitHub provenance and requires `GITHUB_TOKEN`.

For the full per-verb reference of every `swarm` command (init / domains / dispatch / collect / verify / advance / status / revalidate / rewind / redrive / history and the other 12 verbs), see the [swarm CLI reference](../cli-reference/). The reference is organised by verb in the order an operator typically reaches them — start with the verbs documented in this Operating Guide, then consult the reference for one-line synopses of the rest.

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

## Recovering from a locked control-plane DB

The swarm control plane is a single SQLite file at `swarms/control-plane.db`. Every file-backed connection opens in **WAL** journal mode with a **5-second `busy_timeout`** (`BUSY_TIMEOUT_MS` in `packages/dogfood-swarm/db/connection.js`). That combination is the design for parallel `swarm` invocations:

- Multiple readers (`swarm status`, `swarm runs`) + one writer: safe under WAL, no waiting.
- Two concurrent **writers** (e.g. `swarm collect` while another process runs `swarm advance`): each writer briefly waits up to 5s for the other to release its transaction, then proceeds. Swarm transactions are small (most under 50ms), so writer-vs-writer contention normally self-resolves well inside the window and you never see an error.

**When a lock does surface**, it appears as a `SQLITE_BUSY` / "database is locked" error (and, from `swarm collect`, as the `COLLECT_UPSERT_FAILED` code — see the [Error Code Reference](../error-codes/)). This means a writer held the DB for longer than 5s. The cause is almost always **another process still holding a write transaction**, not file corruption — so the fix is to release that process, **not** to touch the DB file.

Recovery procedure:

1. **Find the stuck process.** List running `swarm` processes and look for one that is hung mid-command (a crashed agent that never released its transaction, an orphaned `swarm collect`/`swarm advance`, or an editor/`sqlite3` shell you left open on the file):
   - macOS/Linux: `ps aux | grep -i swarm` (and `lsof swarms/control-plane.db` to see every process holding the file open).
   - Windows (PowerShell): `Get-Process | Where-Object { $_.Path -like '*node*' }`, or use Resource Monitor's "Associated Handles" search for `control-plane.db`.
2. **Stop it.** Terminate the stuck process so it releases its lock (`kill <pid>` / `Stop-Process -Id <pid>`). A clean `swarm` process will release on its own once its transaction commits; only kill one that is genuinely hung.
3. **Re-run the command that hit the lock.** With the holder gone, the retry acquires the write lock immediately. `swarm collect` in particular is idempotent at the upsert level (per `COLLECT_UPSERT_FAILED`), so re-running it after clearing the lock is safe.

**Do NOT** delete `swarms/control-plane.db`, run `PRAGMA`-level surgery, or hand-edit the WAL/SHM sidecar files to "unstick" a lock — the lock is held by a live process, and removing the file discards committed swarm state. If a lock persists after every `swarm` process is confirmed dead, the WAL sidecar (`control-plane.db-wal`) may simply need a clean checkpoint, which the next normal `openDb` performs automatically; re-running any `swarm` verb is the recovery, not file deletion. If contention is chronic (you regularly wait >5s), raise `BUSY_TIMEOUT_MS` rather than serialising externally.

## Error Codes

For the structured error codes that surface from ingest and dogfood-swarm CLIs (`RECORD_SCHEMA_INVALID`, `DUPLICATE_RUN_ID`, `ISOLATION_FAILED`, `COLLECT_UPSERT_FAILED`, `CONTROL_PLANE_SCHEMA_TOO_NEW`, `STATE_MACHINE_*`), see the [Error Code Reference](../error-codes/).

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
