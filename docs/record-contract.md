# Record Contract

The dogfood record is the canonical output of the system. Everything terminates into it.

## Two Schemas, One Record

| Schema | Authored by | Contains verifier fields | Where it exists |
|--------|-------------|-------------------------|-----------------|
| `dogfood-record-submission.schema.json` | Source repo workflow | No | In-flight (repository_dispatch payload) |
| `dogfood-record.schema.json` | Central verifier | Yes | Persisted in `records/` or `records/_rejected/` |

The submission is what the source repo emits. The persisted record is what the verifier writes after evaluation. They share the same source-authored fields, but the persisted record adds:

- `policy_version` — which policy was applied
- `verification` — provenance, schema validity, policy validity, rejection reasons
- `overall_verdict` expanded from a single string to `{ proposed, verified, downgraded, downgrade_reasons }`

## Trust Boundary

Source repos author:
- `run_id`, `repo`, `ref`, `source`, `timing`
- `ci_checks[]` (machine-evaluated)
- `scenario_results[]` with `step_results[]` (dogfood evidence)
- `overall_verdict` (proposed, single string)
- `notes`

The verifier authors:
- `policy_version`
- `verification` block (status, provenance, schema/policy validity, rejection reasons)
- `overall_verdict.verified` (may confirm or downgrade, never upgrade)
- `overall_verdict.downgraded` and `downgrade_reasons`

A source submission that includes verifier-owned fields is rejected.

## Verdict Rules

- Source proposes an `overall_verdict` string
- Verifier evaluates against policy and sets `overall_verdict.verified`
- If verifier disagrees: `downgraded: true` with `downgrade_reasons[]`
- Verifier **never upgrades** a proposed verdict

## Storage Paths

- Accepted: `records/<org>/<repo>/YYYY/MM/DD/run-<ulid>.json`
- Rejected: `records/_rejected/<org>/<repo>/YYYY/MM/DD/run-<ulid>.json`

Rejected records use the same persisted schema with `verification.status: "rejected"`.

## Per-Step Results

Every `scenario_results[]` item must include `step_results[]` with at least one entry. Each step result references a `step_id` from the scenario definition and reports `status: pass | fail | blocked | skip | partial`.

The verifier enforces:
- Every `required_steps[]` in the scenario definition has a matching `step_results[]` entry
- A scenario cannot have `verdict: pass` if any required step has `status: fail` or `status: blocked`
- A scenario cannot have a non-pass verdict (`fail`, `blocked`, or `partial`) when every reported step actively has `status: pass` — a self-contradictory downgrade claim is rejected in both directions, not just the inflation direction. `skip` and `partial` *step* statuses are neutral evidence for this check (they neither justify nor contradict a non-pass verdict), so partial evidence under a `fail`/`blocked`/`partial` verdict is accepted. Before wave 22 (F-cc198701) `partial` scenario verdicts were exempt from this check entirely — an unchecked 2-of-4-rank verdict-inflation path.

Both checks require the scenario *definition* to be resolvable at verify time: they run for `github`-provenance submissions (the scenario file is fetched from the submitting repo at the attested commit) and whenever a scenarios map is supplied to `verify()` directly. For `gitlab` submissions scenario fetching is not yet implemented, so these two checks are skipped there — a documented gap, not a silent one.
