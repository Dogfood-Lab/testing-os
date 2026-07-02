# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `testing-os` or any of its packages, **do not open a public issue.** Instead, report it privately:

- **Email:** mikeyfrilot@gmail.com (subject: "testing-os security")
- **GitHub Security Advisories:** [Open a draft advisory](https://github.com/dogfood-lab/testing-os/security/advisories/new)

We aim to triage within 5 business days and ship a fix within 14 days for HIGH/CRITICAL issues.

## Scope

In scope:
- Source code in `packages/*` in this repository. Six of seven `@dogfood-lab/*` packages are **published on npm** since v1.2.0 (2026-05-14): `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. The seventh, `@dogfood-lab/portfolio`, remains intentionally workspace-internal (`private: true`). Headline install: `npm install -g @dogfood-lab/dogfood-swarm`. Consumption is via published npm packages, via JSON evidence indexes at `indexes/` served over `raw.githubusercontent.com`, and via workspace symlinks for local development.
- The swarm control-plane SQLite schema and write paths
- Schema validators in `@dogfood-lab/schemas` (consumed as source via workspace symlinks)
- The HTTP read API exposed via `indexes/` and `policies/` (when consumers fetch them via `raw.githubusercontent.com`)

### Vulnerabilities affecting the JSON evidence schema

The realistic external attack surface — what we explicitly want researchers to report:

- **Forged submissions** that pass schema validation but assert false provenance (e.g. claiming a workflow run that did not happen)
- **Provenance forgery** in the dispatcher tier — anything that lets a non-trusted repo inject a `repository_dispatch` payload accepted by `packages/ingest`
- **Path traversal in `persist.js`** — any way for a crafted record ID or relative path to escape the runtime data dirs and write outside `records/` / `indexes/` / `reports/`
- **Indexes poisoning** — any way to cause `indexes/latest-by-repo.json` or sibling indexes to publish a state that contradicts the underlying `records/` files (these indexes are downstream-trusted)

Out of scope:
- Issues in third-party dependencies (report upstream; we'll pin/patch when notified)
- Findings stored as evidence (those are intentionally public; the *system* is what we secure)
- Old `@dogfood-labs/*` packages (deprecated — superseded by `@dogfood-lab/*`; the legacy source lives in the archived [mcp-tool-shop-org/dogfood-labs](https://github.com/mcp-tool-shop-org/dogfood-labs) repo)

## Threat Model

`testing-os` is a **shared evidence store and protocol runner**. The threats we care about:

| Threat | Mitigation |
|--------|------------|
| Forged evidence submissions | Schema validation + signed dispatches via `gh api` (token-gated by repo permissions) |
| Tampered findings | Git history is the audit log; all writes go through PRs or repository_dispatch |
| Privilege escalation in CI | Workflows are paths-gated and run on `ubuntu-latest`; no self-hosted runners |
| Credential leakage | No secrets in code; all tokens are GitHub-managed |
| Denial via evidence flood | Rate-limited at the dispatcher tier (GitHub API quotas apply) |

## Disclosure

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). After a fix ships and consumers have had time to upgrade, we publish a GitHub Security Advisory with details.
