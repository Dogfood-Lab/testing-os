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
- `enforcement.review_after` -- when to re-evaluate (mandatory for `exempt` only — see [`policy.schema.json`](https://github.com/dogfood-lab/testing-os/blob/main/packages/schemas/src/json/policy.schema.json) and [`docs/enforcement-tiers.md`](https://github.com/dogfood-lab/testing-os/blob/main/docs/enforcement-tiers.md))
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

## Schema versioning & compatibility matrix

testing-os has **two independent `schema_version` axes**, and it pays to keep them straight. One governs the SQLite control plane (how the swarm coordinates itself); the other governs the JSON record/intelligence contracts above (what crosses the wire between repos and the verifier). They version separately, fail differently, and have different migration stories.

| Axis | Where it lives | Versioned by | Too-new failure | Migration today |
|------|----------------|--------------|-----------------|-----------------|
| **Control-plane schema** | `kv.schema_version` in `control-plane.db` | `SCHEMA_VERSION` in `packages/dogfood-swarm/db/schema.js` (integer) | `CONTROL_PLANE_SCHEMA_TOO_NEW` — `openDb` refuses fail-closed | Ordered, ledger-recorded runner (additive only so far) |
| **JSON contract schema** | `schema_version` field on each record / finding / pattern / … | semver in each `*.schema.json` (currently `1.0.0`) | `CONTRACT_SCHEMA_TOO_NEW` / `CONTRACT_SCHEMA_TOO_OLD` — verify refuses an incompatible **major** | Deferred — no non-additive bump exists yet |

### Control-plane schema version + migration ledger

The swarm control plane is a SQLite DB (`swarms/control-plane.db`). Its shape is versioned by the integer `SCHEMA_VERSION` in `packages/dogfood-swarm/db/schema.js`, stored in the DB's `kv` table under `schema_version`.

Migrations are **ordered and recorded**. `db/schema.js` exports a `MIGRATIONS_MANIFEST` — an array of `{ id, target_version, sql }` entries, one per historical schema change, in ascending `target_version` order. On `openDb`, `db/migrate.js#migrateDb` reconciles the DB against the manifest:

- **Fresh DB:** every manifest migration runs in order (each inside its own transaction) and is recorded in the `migrations_ledger` table (`migration_id` PK, `target_version`, `applied_at`, `status`).
- **Existing DB that predates the ledger:** each migration whose column/index/table **already exists** (detected via `PRAGMA table_info` / `sqlite_master`) is **retroactively seeded** into the ledger as `applied` **without re-running** — so opening a current DB is a no-op, never a duplicate-column error.
- **Partially upgraded DB:** missing migrations are applied; already-present ones are bootstrapped. Either way the ledger ends complete and `kv.schema_version` is bumped to `SCHEMA_VERSION`.

A `--check`-style dry run (`migrateDb(db, version, { check: true })`) reports the plan — which migrations *would* be applied vs bootstrapped — while mutating nothing.

If the on-disk DB reports a `schema_version` **higher** than the running build's `SCHEMA_VERSION`, `openDb` refuses fail-closed with [`CONTROL_PLANE_SCHEMA_TOO_NEW`](../error-codes/#control_plane_schema_too_new) — the remedy is to upgrade the tool, never to hand-edit the DB.

### JSON-contract schema version

The record and intelligence contracts each carry a semver `schema_version` (currently `1.0.0`). The verifier compares a submission's contract `schema_version` against the band of versions the build supports. A submission whose **major** is newer than the build understands is refused (`CONTRACT_SCHEMA_TOO_NEW`); one whose major is older than the supported floor is refused (`CONTRACT_SCHEMA_TOO_OLD`). Minor/patch bumps that are purely additive stay compatible. This is the JSON-contract analogue of the control plane's `CONTROL_PLANE_SCHEMA_TOO_NEW` refusal — same fail-closed-on-incompatible-major discipline, different axis.

### Data migration is deferred (on purpose)

There is **no** general record/-evidence + JSON-contract **data** migration runner today, and that is deliberate: every schema change so far has been **additive** (new optional fields, new columns, new indexes), so a missing field reads as absent and an old reader keeps working. A data-migration runner only earns its keep when a real **non-additive** bump lands — a renamed field, a tightened type, a required field with no default — and none exists yet. Building one before then would be speculative machinery with no fixture to prove it against.

When that bump arrives, two shipped pieces are the framework to generalize from:

- **`scripts/apply-finding-migration.mjs`** — the proven JSON/record-side pattern: manifest-schema validation, transaction-wrapped, `--check` dry-run, atomic, idempotent (it overwrites the same fields with the same values, so a second run is a no-op).
- **`packages/dogfood-swarm/db/migrate.js`** — this control-plane runner: ordered manifest, ledger-recorded, retroactive-bootstrap-aware.

Generalizing means lifting their shared shape (ordered manifest + ledger + dry-run + atomic per-unit transaction) over the record/evidence tree, gated by the JSON-contract `schema_version`. Until a non-additive bump forces it, this section is the contract: additive-only, version-refused at the incompatible major, data migration framework-ready but unbuilt.
