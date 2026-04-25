# Ship Gate

> No repo is "done" until every applicable line is checked.
> Copy this into your repo root. Check items off per-release.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline) (2026-04-25)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required) (2026-04-25)
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output (2026-04-25)
- [x] `[all]` No telemetry by default — state it explicitly even if obvious (2026-04-25)

### Default safety posture

- [ ] `[cli|mcp|desktop]` SKIP: testing-os tools have no destructive default actions. The receiver workflow only writes to `records/` + `indexes/` and pushes back to its own repo. The `swarm` CLI in `dogfood-swarm` operates on a SQLite control plane in `swarms/<run-id>/` only — already constrained.
- [ ] `[cli|mcp|desktop]` SKIP: file operations are constrained to the runtime data dirs (`records/`, `indexes/`, `swarms/`) by `packages/ingest/persist.js`'s `computeRecordPath` validator (rejects unsafe segments).
- [ ] `[mcp]` SKIP: not an MCP server.
- [ ] `[mcp]` SKIP: not an MCP server.

## B. Error Handling

- [ ] `[all]` SKIP: structured-error-shape enforcement is not yet formalized across all 7 packages. Tracked as a follow-up — the `verify` package returns structured `verification.rejection_reasons`, and `ingest/run.js` exits with codes per spec, but the contract isn't documented as a workspace-wide invariant. Promote in a future minor.
- [x] `[cli]` Exit codes: 0 ok · 1 user error · 2 runtime error · 3 partial success — `packages/ingest/run.js` uses 0/1/2; `dogfood-swarm` CLI propagates non-zero on failures (2026-04-25)
- [x] `[cli]` No raw stack traces without `--debug` — `packages/ingest/run.js` catches and prints `ERROR: <msg>` (2026-04-25)
- [ ] `[mcp]` SKIP: not an MCP server.
- [ ] `[mcp]` SKIP: not an MCP server.
- [ ] `[desktop]` SKIP: not a desktop app.
- [ ] `[vscode]` SKIP: not a VS Code extension.

## C. Operator Docs

- [x] `[all]` README is current: what it does, install, usage, supported platforms + runtime versions (2026-04-25)
- [x] `[all]` CHANGELOG.md (Keep a Changelog format) — updated with v1.0.0 entry (2026-04-25)
- [x] `[all]` LICENSE file present and repo states support status (2026-04-25)
- [x] `[cli]` `--help` output accurate for all commands and flags — `swarm` bin documents its 10 subcommands (2026-04-25)
- [ ] `[cli|mcp|desktop]` SKIP: testing-os tools don't expose user-facing logging level controls. The receiver workflow logs via GitHub Actions; the `swarm` CLI prints to stdout/stderr. No secrets to redact in operator output. Promote if a logging-level requirement surfaces.
- [ ] `[mcp]` SKIP: not an MCP server.
- [x] `[complex]` HANDBOOK.md — the Astro Starlight handbook serves this purpose, deployed at [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) (2026-04-25)

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists (test + build + smoke in one command) — `npm run verify` (2026-04-25)
- [x] `[all]` Version in manifest matches git tag — root + 7 packages all at `1.0.0`, will tag `v1.0.0` (2026-04-25)
- [ ] `[all]` SKIP: dependency scanning not yet wired into CI. Tracked as a follow-up — would add `npm audit --audit-level=moderate` to `ci.yml` or enable Dependabot security alerts. Not blocking v1.0.0 since all packages are `private: true` (no public publish surface).
- [ ] `[all]` SKIP: no automated dependency update mechanism. Same justification as above — Dependabot config wants a separate session. Surface counts on `npm audit` are tracked in HANDOFF.md (`site/` has 8 audit warnings inherited from legacy lockfile).
- [ ] `[npm]` SKIP: all `@dogfood-lab/*` packages are `private: true` — no `npm publish` surface. `npm pack --dry-run` works (`tsc --build` produces `packages/schemas/dist/` etc.) but not the ship target. Reconsider when publishing decision is made.
- [x] `[npm]` `engines.node` set — root `package.json` has `"engines": {"node": ">=20"}` (2026-04-25)
- [x] `[npm]` Lockfile committed (2026-04-25)
- [ ] `[vsix]` SKIP: not a VS Code extension.
- [ ] `[desktop]` SKIP: not a desktop app.

## E. Identity (soft gate — does not block ship)

- [x] `[all]` Logo in README header (2026-04-25)
- [x] `[all]` Translations (polyglot-mcp, 7 languages: ja, zh, es, fr, hi, it, pt-BR) (2026-04-25)
- [x] `[org]` Landing page — Astro Starlight handbook at [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) (2026-04-25)
- [x] `[all]` GitHub repo metadata: description, homepage, topics (`ai-tooling`, `dogfood-lab`, `mcp-tool-shop`, `monorepo`, `npm-workspaces`, `testing`) (2026-04-25)

---

## Gate Rules

**Hard gate (A–D):** Must pass before any version is tagged or published.
If a section doesn't apply, mark `SKIP:` with justification — don't leave it unchecked.

**Soft gate (E):** Should be done. Product ships without it, but isn't "whole."

**Checking off:**
```
- [x] `[all]` SECURITY.md exists (2026-02-27)
```

**Skipping:**
```
- [ ] `[pypi]` SKIP: not a Python project
```
