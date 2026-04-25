---
title: Contracts
description: The seven contracts that define testing-os
sidebar:
  order: 2
---

testing-os is defined by seven contracts. The original three (record, scenario, policy) govern evidence capture. Four newer contracts (finding, pattern, recommendation, doctrine) power the [intelligence layer](../intelligence-layer/).

## Record Contract

Defines what a dogfood run looks like as a structured JSON document.

**Two variants:**
- **Submission schema** (`dogfood-record-submission.schema.json`) — what source repos author
- **Persisted schema** (`dogfood-record.schema.json`) — what the verifier writes after validation

Key submission fields:
- `schema_version` -- contract version (currently `1.0.0`)
- `run_id` -- unique sortable identifier for this run (ULID-like: timestamp prefix + random suffix)
- `repo` -- full `org/repo` slug
- `ref` -- git ref object (`commit_sha`, optional `branch` and `version`)
- `source` -- provenance object (`provider`, `workflow`, `provider_run_id`, `run_url`, `actor`)
- `timing` -- `started_at`, `finished_at`, `duration_ms`
- `scenario_results` -- array of scenario outcomes with steps, verdicts, and evidence
- `overall_verdict` -- proposed verdict as a string (`pass`, `fail`, `blocked`, or `partial`)
- `ci_checks` -- optional array of CI check objects (test results, lint, etc.)

The verifier enriches submissions with verifier-owned fields:
- `overall_verdict` becomes an object: `{ proposed, verified, downgraded, downgrade_reasons }`
- `verification` object: `{ status, verified_at, provenance_confirmed, schema_valid, policy_valid, rejection_reasons }`
- `policy_version` -- semver of the policy set applied during verification

## Scenario Contract

Defines what constitutes a real dogfood exercise in a source repo.

Location: `dogfood/scenarios/<scenario-id>.yaml` in the source repo.

Key fields:
- `scenario_id` -- unique identifier
- `scenario_name` -- human-readable name
- `scenario_version` -- semver for the scenario definition
- `product_surface` -- which surface this exercises (cli, desktop, web, api, mcp-server, npm-package, plugin, library)
- `execution_mode` -- `bot` (fully automated), `mixed` (human + bot), or `human`
- `preconditions` -- what must be true before the scenario runs
- `steps` -- ordered list of actions, each with `id`, `action`, `verifiable`, and `expected`
- `success_criteria` -- includes `required_steps` (list of step IDs that must pass) and `minimum_evidence` (kinds of evidence required)
- `tags` -- categorization labels (e.g., `self-dogfood`, `core-loop`)
- `automation` -- optional script path and timeout for automated execution

Scenarios must exercise the real product interface -- not a test harness or mock.

## Policy Contract

Defines what rules the verifier enforces for each repo.

Location: `policies/repos/<org>/<repo>.yaml` in testing-os.

Key fields:
- `repo` -- full `org/repo` slug
- `policy_version` -- semver for this policy
- `enforcement.mode` -- `required`, `warn-only`, or `exempt`
- `enforcement.reason` -- why non-required (mandatory for warn-only/exempt)
- `enforcement.review_after` -- when to re-evaluate (mandatory for warn-only/exempt)
- `surfaces.<surface>.required_scenarios` -- list of scenario IDs required for this surface
- `surfaces.<surface>.freshness.max_age_days` -- freshness violation threshold
- `surfaces.<surface>.freshness.warn_age_days` -- freshness warning threshold
- `surfaces.<surface>.execution_mode_policy.allowed` -- allowed execution modes
- `surfaces.<surface>.ci_requirements` -- `coverage_min`, `tests_must_pass`
- `surfaces.<surface>.evidence_requirements` -- `required_kinds`, `min_evidence_count`

Global policy at `policies/global-policy.yaml` sets org-wide defaults including stale thresholds (critical: 60d, warning: 30d, healthy: 14d) and 8 global validation rules that apply to every submission.

## Intelligence Layer Contracts

The following four contracts power the learning loop. See [Intelligence Layer](../intelligence-layer/) for full details.

### Finding Contract

An evidence-bound lesson extracted from dogfood runs (`dogfood-finding.schema.json`).

Key fields: `finding_id`, `status` (candidate/reviewed/accepted/rejected), `issue_kind`, `root_cause_kind`, `remediation_kind`, `transfer_scope`, `source_record_ids`, `evidence[]`, optional `review`, `lineage`, `invalidation`, `derived` metadata.

### Pattern Contract

A repeated lesson cluster backed by 2+ accepted findings (`dogfood-pattern.schema.json`).

Key fields: `pattern_id`, `pattern_kind`, `pattern_strength`, `source_finding_ids` (min 2), `support` (finding/repo/surface counts), `dimensions` (shared issue/root-cause/surface).

### Recommendation Contract

Actionable guidance derived from accepted patterns (`dogfood-recommendation.schema.json`).

Key fields: `recommendation_id`, `recommendation_kind`, `applies_to` (surfaces/modes), `based_on_pattern_ids`, `action` (type/target/details), `confidence`.

### Doctrine Contract

Hardened portfolio rules earned from strong patterns (`dogfood-doctrine.schema.json`).

Key fields: `doctrine_id`, `doctrine_kind`, `statement`, `rationale`, `based_on_pattern_ids`, `transfer_scope` (surface_archetype or broader), `strength`.
