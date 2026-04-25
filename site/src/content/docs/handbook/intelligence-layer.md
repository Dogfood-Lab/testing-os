---
title: Intelligence Layer
description: How testing-os turns evidence into reusable portfolio memory
sidebar:
  order: 5
---

The intelligence layer turns dogfood evidence into reusable lessons, patterns, recommendations, and doctrine that future projects can inherit.

## The Learning Loop

```
record → finding → reviewed memory → pattern/doctrine → future guidance
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

221 finding tests across 5 modules:

| Module | Tests |
|--------|-------|
| Contract spine (Phase 1) | 55 |
| Derivation engine (Phase 2) | 49 |
| Review workflow (Phase 3) | 53 |
| Synthesis layer (Phase 4) | 30 |
| Adoption surface (Phase 5) | 34 |
