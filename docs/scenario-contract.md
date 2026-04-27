# Scenario Contract

Scenarios define what constitutes a real dogfood exercise. They live in source repos, not in testing-os.

## Location

```text
<source-repo>/
  dogfood/
    scenarios/
      export-roundtrip-16x16.yaml
      cli-help-roundtrip.yaml
```

## Ownership Split

| Concern | Owner | Location |
|---------|-------|----------|
| What steps to exercise | Source repo | `dogfood/scenarios/*.yaml` |
| Which scenarios are required | testing-os | `policies/repos/<org>/<repo>.yaml` |
| What a valid result looks like | testing-os | `packages/schemas/src/json/scenario.schema.json` |

Source repos define product truth. Central policy decides which truths are mandatory.

## Key Fields

### scenario_id

Stable, kebab-case, unique within the repo. This is the join key across scenarios, policies, and records. Once published and referenced by policy, changing the ID is a breaking change.

### execution_mode

- `bot` — fully automated, no human involvement
- `human` — manual exercise, human attestation required
- `mixed` — automation runs with human verification steps

The verifier uses this to enforce `attested_by` requirements.

### steps

Steps are **descriptive**, not executable. They say what to verify, not how to automate. This keeps scenarios stable across changes to test infrastructure.

Each step has:
- `id` — stable, kebab-case, referenced by `success_criteria.required_steps` and record `step_results`
- `action` — what the operator does
- `verifiable` — whether this step has a checkable outcome
- `expected` — what passing looks like (required if verifiable)

### success_criteria

- `required_steps[]` — step IDs that must pass for the scenario to pass
- `minimum_evidence[]` — evidence kinds the verifier requires

### automation

- If present: `script` path and `timeout_ms`
- If `null`: human-only scenario; submit workflow collects attestation instead of running a script

## Product Surface Templates

Default scenarios by surface to avoid every repo inventing from scratch:

| Surface | Template Scenario | What It Proves |
|---------|------------------|----------------|
| cli | `cli-core-roundtrip` | Install, --help, core command, verify exit 0 |
| npm-package | `import-primary-export` | Install from registry, import, call primary export |
| desktop | `launch-core-workflow` | Launch, perform core workflow, capture screenshot |
| mcp-server | `mcp-handshake` | Start, send initialize, verify capabilities |
| api | `health-and-primary` | Hit health + primary endpoint, verify response shape |
| library | `import-and-call` | Import, call primary function, verify output |
| plugin | `install-and-activate` | Install in host, activate, verify registration |

Repos can use templates as-is, extend them, or replace them entirely.
