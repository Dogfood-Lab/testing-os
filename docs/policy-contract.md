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

> As of v1.7.0, **`attested-if-human` is enforced declaratively** — it is the first built-in migrated to the
> VERIFY-F1 engine (a `when` predicate in `global-policy.yaml`), proven byte-identical to its old hardcoded form
> by a differential-equivalence release gate. The other seven rules remain code-enforced. See
> [`policy-dsl.md`](policy-dsl.md).

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
- `min_evidence_count` — minimum evidence items **per scenario** (enforced against each `scenario_result` independently, not summed across scenarios)
- `forbidden_tags` — scenario tags that REJECT a `scenario_result` on this surface (e.g. `wip`, `flaky`, `skip-ci`). Enforced per scenario_result.
- `required_tags` — scenario tags that EVERY `scenario_result` on this surface must carry (a tagless scenario fails). Enforced per scenario_result.

### custom_rules (declarative — VERIFY-F1)

Beyond the fixed fields above, a surface may carry `custom_rules[]` — declarative,
**no-eval** predicates an operator authors directly in YAML (field-selector + operator + value, composed with
`all`/`any`/`not`/`implies`), with no code change. They cover actor allowlists, field-value constraints, and
forbidden scenario/tag combinations. `custom_rules` are additive-only (they can `reject`/`warn`/`info`, never
grant an exception), so a repo policy can never weaken a global gate. Full reference — operators, the safety
model, the `not(any(...))` absence idiom, and the diagnostics taxonomy — is in
[`policy-dsl.md`](policy-dsl.md) and the [handbook policy-DSL page](https://dogfood-lab.github.io/testing-os/handbook/policy-dsl/).

## Integration with Shipcheck

Shipcheck Gate F reads `indexes/latest-by-repo.json` via `raw.githubusercontent.com` (the GitHub CDN). The CDN cache window is 3–5 minutes; that is exactly what creates the read-after-write timing seam documented in [`docs/rollout-doctrine.md`](rollout-doctrine.md) — an ingest that just landed on `main` is not immediately visible to Gate F until the CDN edge picks up the new commit. The same framing appears in `site/src/content/docs/handbook/integration.md`, `site/src/content/docs/handbook/operating-guide.md`, `docs/operating-cadence.md`, and `docs/enforcement-tiers.md`; this doc was previously the outlier saying "GitHub API."

For a given repo + surface:
- If no record exists: Gate F fails
- If latest record is older than `max_age_days`: Gate F fails
- If latest record `overall_verdict.verified` is not `pass`: Gate F fails
- Otherwise: Gate F passes
