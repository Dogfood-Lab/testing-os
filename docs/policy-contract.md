# Policy Contract

Policies define the verification rules the central verifier enforces. They are the "law engine" of testing-os.

## Two Levels

### Global Policy

`policies/global-policy.yaml`

Defines:
- Default surface policy (freshness, execution mode, CI requirements, evidence requirements)
- Non-overridable global rules (schema validation, provenance, attestation, verdict consistency)
- Stale thresholds for CLI reporting

Global rules cannot be weakened by repo policies. They always apply.

### Repo Policy

`policies/repos/<org>/<repo>.yaml`

Defines per-surface requirements:
- Which scenarios are required
- Freshness windows
- Allowed execution modes
- CI gates (coverage, test pass)
- Evidence requirements

If a surface has no repo policy, global defaults apply.

## Policy Resolution

For a given record with `repo: org/foo` and `product_surface: desktop`:

1. Load `policies/global-policy.yaml`
2. Load `policies/repos/org/foo.yaml` (if exists)
3. For `desktop` surface: use repo surface policy if defined, else global defaults
4. Apply all global rules unconditionally
5. Apply surface-specific rules from the resolved policy

## Global Rules (Non-Overridable)

| Rule ID | What it checks | Severity |
|---------|---------------|----------|
| `schema-valid` | Submission passes JSON Schema | reject |
| `provenance-confirmed` | GitHub API confirms source run | reject |
| `scenario-minimum` | At least one scenario result | reject |
| `step-results-present` | Required steps have matching results | reject |
| `step-verdict-consistent` | Scenario pass requires all required steps pass | reject |
| `attested-if-human` | Human/mixed mode requires attested_by | reject |
| `blocked-needs-reason` | Blocked verdict requires blocking_reason | reject |
| `no-verdict-upgrade` | Verifier never upgrades proposed verdict | reject |

## Surface Policy Fields

### required_scenarios

Scenario IDs that must have a recent accepted record. "Recent" is defined by `freshness.max_age_days`.

### freshness

- `max_age_days` — after this, the surface is stale (fails Gate F in shipcheck)
- `warn_age_days` — after this, the surface gets a warning

### execution_mode_policy

- `allowed` — which modes are accepted
- Example: desktop surfaces often require `[human, mixed]` — bot-only is not sufficient for UI products

### ci_requirements

- `coverage_min` — minimum coverage %. Null means no gate.
- `tests_must_pass` — whether CI test checks must all pass

### evidence_requirements

- `required_kinds` — evidence types that must be present (screenshot, log, etc.)
- `min_evidence_count` — minimum total evidence items

## Integration with Shipcheck

Shipcheck Gate F reads `indexes/latest-by-repo.json` via GitHub API.

For a given repo + surface:
- If no record exists: Gate F fails
- If latest record is older than `max_age_days`: Gate F fails
- If latest record `overall_verdict.verified` is not `pass`: Gate F fails
- Otherwise: Gate F passes
