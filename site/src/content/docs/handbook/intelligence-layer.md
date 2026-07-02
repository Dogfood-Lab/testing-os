---
title: Intelligence Layer
description: How testing-os turns evidence into reusable portfolio memory
sidebar:
  order: 5
---

The intelligence layer turns dogfood evidence into reusable lessons, patterns, recommendations, and doctrine that future projects can inherit.

This page documents the **finding-review state machine** (`candidate → reviewed → accepted → invalidated`). It is one of the four distinct status vocabularies in testing-os. For the record-classification vocabulary (`accepted` / `rejected` / portfolio buckets) see [Architecture](../architecture/) and [Operating Guide](../operating-guide/). For the wave-finding classification (`new` / `recurring` / `fixed` / `unverified`) emitted by dogfood-swarm runs, see the [State Machines reference](../state-machines/). For the agent_run lifecycle (the fourth vocabulary — pending / dispatched / running / complete / failed / timed_out / invalid_output / ownership_violation / aborted_for_rewind), see the same reference. The four vocabularies share words but operate on different objects — read the glossary if you have not already.

## The Learning Loop

```text
record
  → finding
    → reviewed memory
      → pattern / doctrine
        → future guidance
```

Every step is evidence-bound, deterministic, and auditable. No LLM in the extraction or clustering loop.

## Four New Artifact Types

The intelligence layer adds four contracts to testing-os' original three (record, scenario, policy):

### Finding

An evidence-bound lesson extracted from one or more dogfood runs.

- Status lifecycle: `candidate → reviewed → accepted → (invalidated)`
- Must reference at least one source record and one evidence item
- Classification: issue_kind, root_cause_kind, remediation_kind, transfer_scope
- Stored as YAML in `findings/<org>/<repo>/`

### Pattern

A repeated lesson cluster backed by 2+ accepted findings.

- Formed by dimension-based clustering (issue_kind + root_cause_kind)
- False recurrence detection prevents duplicate-incident inflation
- Strength levels: emerging, strong, portfolio_stable

### Recommendation

Actionable guidance derived from accepted patterns.

- Kinds: starter_check, starter_scenario, policy_seed, evidence_expectation, verification_rule, review_prompt
- Each recommendation includes a specific action with type, target, and details
- Confidence tracks pattern strength

### Doctrine

Hardened portfolio rules earned from repeated patterns.

- Only promoted from strong or portfolio_stable patterns
- org_wide scope requires 2+ supporting patterns
- Statement reads as a directive, not a suggestion

## Derivation Engine

Eight deterministic rules extract candidate findings from verified dogfood records:

| Rule | Fires on | Issue |
|------|----------|-------|
| Surface misclassification | Invalid product_surface enum | surface_misclassification |
| Evidence policy mismatch | Evidence requirement rejection | evidence_overconstraint |
| Verdict downgrade | Proposed pass downgraded | schema_mismatch / policy_mismatch |
| Scenario step failure | Step-level failures | build_output_mismatch / entrypoint_truth |
| Blocked scenario | Blocked verdict with reason | verification_gap |
| Execution mode gap | Mixed/human missing attestation | execution_mode_mismatch |
| Schema rejection | Non-surface schema failures | schema_mismatch |
| Policy rejection | Non-evidence policy failures | policy_mismatch |

Every emitted finding includes the rule ID, rationale, and exact evidence references.

## Review Workflow

Findings move through a lawful state machine:

- **candidate** -- machine- or human-created, not yet reviewed
- **reviewed** -- looked at by a human, may need refinement
- **accepted** -- approved as trustworthy reusable learning
- **rejected** -- declined with explicit reason

Available actions: accept, reject, review, edit, merge, reopen, invalidate

All actions are logged in an append-only event log with actor, timestamp, from/to status, field diffs, and reasons.

### Merge

Two or more findings describing the same lesson can be merged into one canonical finding. The merge preserves all evidence, source record IDs, and lineage. Source findings are marked superseded.

### Invalidation

Accepted findings can be invalidated when source truth changes. Invalidated findings are excluded from advice queries but retained for historical reference.

## Promoting Artifacts (closing the loop)

Synthesis writes patterns, recommendations, and doctrine with `status: candidate`. The advice surface (`queryPatterns` / `queryRecommendations` / `queryDoctrine`) returns only **accepted** artifacts — so until a candidate is reviewed and accepted, nothing the intelligence layer derives reaches a future project. The **artifact review verbs** are what close that loop.

```bash
# Promote a derived pattern into the advise surface — accept = the loop closes
node packages/findings/cli.js patterns accept <pattern_id> --actor <name> --reason "..."

# Same for recommendations and doctrine
node packages/findings/cli.js recommendations accept <recommendation_id> --actor <name>
node packages/findings/cli.js doctrine accept <doctrine_id> --actor <name>

# Reject (reason required) or, for patterns, invalidate an accepted one
node packages/findings/cli.js patterns reject <pattern_id> --actor <name> --reason "not a real recurrence"
node packages/findings/cli.js patterns invalidate <pattern_id> --actor <name> --reason "source changed"

# What is awaiting review?
node packages/findings/cli.js patterns queue
```

The artifact review law **reuses the finding status law** (`review/transitions.js`). It is intentionally narrower than the finding lifecycle because the artifact schemas are narrower:

- **pattern** status ∈ candidate / accepted / rejected / **invalidated**
- **recommendation** and **doctrine** status ∈ candidate / accepted / rejected

Because no artifact schema permits the intermediate `reviewed` status, the `review` and `reopen` verbs (which target `reviewed`) are **refused** for artifacts rather than writing a schema-invalid file. `invalidate` is supported for **patterns only** — recommendations and doctrine have no `invalidated` status, so use `reject` to retire them. Every accepted/rejected/invalidated decision is written through the synthesis writers, which re-validate the artifact against its JSON Schema, and is logged in the same append-only event log (carrying `artifact_id` + `artifact_kind`).

### Re-derivation never clobbers a decision

Re-running `<type> derive --write` produces the same deterministic ids. A freshly-derived `candidate` that collides with an artifact you already promoted (accepted / rejected / invalidated) is **preserved, not overwritten** — the operator's decision is load-bearing. Collisions are reported as `Preserved (operator-promoted, not overwritten)`. This mirrors the findings dedupe (`derive/dedupe.js`) and lives in `synthesis/dedupe-artifacts.js`.

## Applying Recommendations Back

An **accepted** recommendation whose action is a structured `add_scenario` / `add_check` can be applied directly into a named repo policy:

```bash
# Preview (default) — renders the change, writes nothing
node packages/findings/cli.js recommendations apply <recommendation_id> --policy <org/repo>

# Apply the structured intent + record provenance
node packages/findings/cli.js recommendations apply <recommendation_id> --write --policy <org/repo> --actor <name>
```

This is **honest partial automation**:

- Only an **accepted** recommendation is applicable; others refuse with a structured `{ code, message, hint }` error.
- `--write` applies only the structured `target` id — adding it to the policy's `surfaces.<surface>.required_scenarios` — and records `recommendation_id` + `details` as provenance.
- The free-text `action.details` is **never** injected as policy logic.
- Free-text-only action types (`set_policy`, `set_evidence`, `set_verification`, `add_review_step`) and ambiguous targets (no named policy, or a recommendation spanning multiple surfaces) **refuse** `--write` with a hint to apply manually. Never a fake auto-apply.

## Advice Surface

The adoption layer answers future-project questions directly:

```bash
# What should a new MCP server repo inherit?
node packages/findings/cli.js advise --surface mcp-server

# What about a desktop app with mixed-mode dogfood?
node packages/findings/cli.js advise --surface desktop --execution-mode mixed

# Export all accepted learning for repo-knowledge
node packages/findings/cli.js sync-export --json
```

Advice bundles include:
- Starter checks and scenarios
- Evidence expectations
- Likely failure classes (top 3)
- Relevant doctrine
- Supporting pattern and finding IDs

Results are ranked (stronger and more specific first) and capped (max 5 recommendations, 5 doctrine, 3 failure classes).

## Trends & status badges

The advice surface answers "what should a new repo inherit?" — trends answer "is the portfolio getting healthier, and what keeps coming back?" by exploiting the **full dated history** the evidence store retains (`records/<org>/<repo>/YYYY/MM/DD/run-*.json`), not just the latest record per surface.

**Portfolio trend surface (per repo + product surface).** `node packages/portfolio/generate.js` computes, for each repo + surface, an ordered verdict history, the current-vs-previous verdict, **regressed** (pass→fail) / **recovered** (fail→pass) flags, and a windowed pass-rate (default 30 days). It is merged into `reports/dogfood-portfolio.json` under a `trends` key and also emitted to `indexes/trends.json`. (`indexes/trends.json` + the badge files below are **committed served artifacts** — `ingest.yml` regenerates and commits them after each accepted submission, so the raw-URL endpoints stay fresh. Do not hand-edit; regenerate with `node packages/portfolio/generate.js`.)

**Per-repo status badge.** The same run emits a [shields.io endpoint](https://shields.io/endpoint) JSON per repo + surface to `indexes/badges/<org>--<repo>--<surface>.json` — `{ schemaVersion: 1, label: "dogfood", message: "pass" | "fail" | "stale", color }` — so a governed repo can show its dogfood verdict the way it shows CI status. A `fail` always reports `fail` (staleness never masks a real failure). Opt out per-run with `--no-trends` / `--no-badges`.

**Cross-run analytics (`swarm trends`).** Every other `swarm` verb is single-run; `swarm trends` is the cross-run lens over the control-plane corpus (content-addressed finding fingerprints, per-run rollups):

```bash
swarm trends --query recurring                       # findings whose fingerprint recurred across >1 run
swarm trends --query history --repo my-repo          # per-run history, newest first
swarm trends --query recurrence --window-days 30 --format=json
```

`swarm status` and `swarm runs` also accept `--format=json` for machine consumers.

## CLI Reference

### Finding management
- `list` -- list all findings with filters
- `show <id>` -- show finding detail
- `validate` -- validate all findings against schema
- `derive --all --dry-run` -- derive candidates from records
- `explain <id>` -- show derivation provenance

### Review
- `accept <id> --actor <name> --reason "..."` -- promote to accepted
- `reject <id> --actor <name> --reason "..."` -- reject with reason
- `edit <id> --actor <name> --set field=value` -- edit fields
- `merge <id1> <id2> --into <canonical> --actor <name> --reason "..."` -- merge findings
- `invalidate <id> --actor <name> --reason "..."` -- invalidate accepted finding
- `reopen <id> --actor <name>` -- reopen rejected/accepted finding
- `history <id>` -- show review audit trail
- `queue` -- show pending review work

### Synthesis
- `patterns derive [--write]` -- derive patterns from accepted findings
- `recommendations derive [--write]` -- derive from accepted patterns
- `doctrine derive [--write]` -- derive from strong patterns

### Artifact review (close the loop)
- `patterns accept <id> --actor <name> [--reason "..."]` -- promote a candidate pattern into the advise surface
- `patterns reject <id> --actor <name> --reason "..."` -- reject a pattern (reason required)
- `patterns invalidate <id> --actor <name> --reason "..."` -- invalidate an accepted pattern (patterns only)
- `patterns queue` -- patterns awaiting review
- `recommendations accept|reject <id> --actor <name>` -- review a recommendation
- `recommendations apply <id> [--dry-run | --write] [--policy <org/repo>] [--actor <name>]` -- apply an accepted recommendation into a policy
- `recommendations queue`
- `doctrine accept|reject <id> --actor <name>` -- review a doctrine
- `doctrine queue`

### Adoption
- `advise --surface <surface> [--execution-mode <mode>]` -- get advice bundle
- `sync-export [--json]` -- export for repo-knowledge

## Integration

| System | Role |
|--------|------|
| testing-os | Source of truth -- owns all learning artifacts |
| repo-knowledge | Consumer -- syncs accepted artifacts via `sync-export` |
| role-os | Consumer -- pulls advice into bootstrap/review contexts |
| shipcheck | Enforcement -- uses dogfood status, not intelligence layer directly |

## Test Coverage

246 finding tests at v1.1.7 (covering contract spine, derivation, review, synthesis, and adoption modules). The precise per-module breakdown drifts with each release and is intentionally not kept in lockstep with this slow-moving handbook page. See [`docs/m5-validation-2026-04-29.md`](https://github.com/dogfood-lab/testing-os/blob/main/docs/m5-validation-2026-04-29.md) for the authoritative current matrix.
