# Scorecard

> Score a repo before remediation. Fill this out first, then use SHIP_GATE.md to fix.

**Repo:** `dogfood-lab/testing-os`
**Date:** 2026-06-02 (re-affirmed at v1.9.0 2026-07-03; re-affirmed at v1.8.0 2026-06-30; re-affirmed at v1.7.0 2026-06-30; re-affirmed at v1.6.0 2026-06-29; re-affirmed at v1.5.0 2026-06-21; re-affirmed at v1.4.0 2026-06-13; re-affirmed at v1.3.2 2026-06-02; first scored 2026-04-25 at v1.0.0; re-affirmed 2026-05-14 at v1.2.0; re-affirmed 2026-05-31 at v1.2.3; re-affirmed 2026-06-01 at v1.3.0; re-affirmed 2026-06-01 at v1.3.1)
**Type tags:** `[monorepo]` `[npm-workspaces]` `[cli]` `[mcp-adjacent]` — see [`CLAUDE.md`](CLAUDE.md) for the seven workspace packages.

## Pre-Remediation Assessment

Baseline at the pre-v1.0.0 migration handoff (sourced from [`HANDOFF.md`](HANDOFF.md) migration notes and the v1.0.0 SHIP_GATE pass log).

| Category | Score | Notes |
|----------|-------|-------|
| A. Security | 6/10 | SECURITY.md present but scope claim was dishonest re: npm publish; no Dependabot wire-up. |
| B. Error Handling | 5/10 | Per-package error shapes inconsistent across the seven `@dogfood-lab/*` packages; no formal structured-error contract. |
| C. Operator Docs | 6/10 | README + HANDOFF.md present and detailed but stale claims accumulated across v1.0.0 → v1.1.7; handbook landing page still on "Three Contracts" framing. |
| D. Shipping Hygiene | 5/10 | Lockstep versioning working but doc-drift detection not yet wired; SCORECARD itself was a committed template. |
| E. Identity (soft) | 4/10 | Identity items mostly met (LICENSE, CHANGELOG, scope), but the SHIP_GATE D-47 evidence line was still citing 1.0.0 six releases later. |
| **Overall** | **26/50** | |

## Key Gaps

1. **SECURITY.md scope dishonesty** — claimed packages were "published as `@dogfood-lab/*` on npm" when no `npm publish` had ever run. Security researchers reading it would either dismiss or distrust the policy.
2. **Per-package error shapes** — seven packages do not yet share a structured-error-shape contract. A consumer catching one error type cannot uniformly catch the others.
3. **Doc-drift across release ladder** — README, SHIP_GATE, HANDOFF, CLAUDE, CHANGELOG, and the handbook accumulated stale claims across v1.0.0 → v1.1.7 (test counts, line numbers, "all 7 private," landing-page Three Contracts).
4. **Dependabot not wired** — `npm audit` runs locally but no CI Dependabot config; tracked as a SHIP_GATE SKIP.
5. **SCORECARD committed as template** — the repo demonstrated the SHIP_GATE contract but the SCORECARD evidence half was an empty boilerplate, undercutting the shipcheck product-standard signal.

## Remediation Priority

| Priority | Item | Estimated effort |
|----------|------|-----------------|
| 1 | Reconcile SECURITY.md scope + the "all 7 private" claim across README/SHIP_GATE/HANDOFF/CHANGELOG | 1 swarm wave (landed) |
| 2 | Fill SCORECARD with honest deltas; soften drift traps in m5-validation, CHANGELOG line-number citations, handbook test breakdowns | 1 swarm wave (landed) |
| 3 | Wire Dependabot + structured-error-shape contract across the seven packages + formal SECURITY.md threat-model expansion | follow-up sessions; tracked under remaining 6-point gap |

## Post-Remediation

Sourced primarily from [`SHIP_GATE.md`](SHIP_GATE.md): at v1.9.0 (re-affirmed 2026-07-03), every applicable hard-gate A–D row carries either an `[x]` evidence stamp or a `SKIP:` with explicit justification — `shipcheck audit`, last run at the v1.9.0 release tree, exited 0 (21 checked / 16 SKIP-with-justification / 0 unchecked). Soft gate E is fully met. The "100% pass on hard gates A–D" headline phrasing reflects the audit-tool verdict, not a hand-curated estimate; the per-row evidence dates below are the auditable substrate.

| Category | Before | After |
|----------|--------|-------|
| A. Security | 6/10 | 9/10 |
| B. Error Handling | 5/10 | 8/10 |
| C. Operator Docs | 6/10 | 10/10 |
| D. Shipping Hygiene | 5/10 | 9/10 |
| E. Identity (soft) | 4/10 | 8/10 |
| **Overall** | 26/50 | **44/50** |

The remaining 6 points to a perfect 50 are explicitly tracked rather than papered over:

- **Security (1 point)** — formal SECURITY.md threat-model expansion (named CVE classes per package surface, not just submission/provenance shapes) — depends on the structured-error-shape contract landing first.
- **Error handling (2 points)** — a `@dogfood-lab/errors` shared contract across all 7 packages so callers catch one shape uniformly. Today each package shapes errors independently.
- **Shipping hygiene (1 point)** — Dependabot config in `.github/dependabot.yml` + `npm audit` in `ci.yml` matrix. Tracked as SHIP_GATE D-48/D-49 SKIPs.
- **Identity (2 points)** — repo metadata polish (GitHub topics, social preview image, About-text refinement); minor but unfinished.

Honest deltas: every SKIP that remains in SHIP_GATE.md (the MCP / desktop / VSCode items that don't apply, plus the real follow-ups above) is the reason individual category scores stay below 10. The repo is shippable at v1.9.0 by every applicable contract — six of seven `@dogfood-lab/*` packages are live on npm since v1.2.0; the gap is between "shippable" and "perfect."
