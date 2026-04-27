# Dogfood Swarm Protocol v2.0

## Overview

The Dogfood Swarm Protocol orchestrates parallel Claude Code agents through a 10-phase play (Stage A Bug + Stage B Proactive + Stage C Humanization + Stage D Visual Polish, then Feature Pass phases 5-8, Final test phase 9, and Full Treatment phase 10) that first establishes a clean bill of health, then builds features to production readiness, and finally polishes for ship. A human coordinator reads this document and executes it step by step. All artifacts live under `swarms/<org>--<repo>/` (relative to repo root).

## Prerequisites

- Target repo exists under `mcp-tool-shop-org` or `dogfood-lab` (or `mcp-tool-shop` for marketing repos)
- Local clone of the target repo on disk; `origin` points to the correct remote
- Git working tree clean on the target repo (no uncommitted changes)
- Save point tag created before first wave for easy revert

---

<!-- drift-checked by scripts/check-doc-drift.mjs — see Class #11 (multi-occurrence fix completeness). Update all Stage D / 10-Phase mentions together; per-instance fixes are anti-pattern. -->

## The 10-Phase Play

The protocol has two repeating passes plus a final test phase and full treatment:

- **Health Pass** (Phases 1-4) — Audit and fix bugs, security, code quality, type safety, test coverage, doc accuracy across **four pre-feature stages** (A bug/security, B proactive health, C humanization, D visual polish). Repeat until clean bill of health.
- **Feature Pass** (Phases 5-8) — Audit and build missing capabilities, feature gaps, UX improvements. Repeat until production-ready.
- **Final** (Phase 9) — Comprehensive test validation.
- **Full Treatment** (Phase 10) — Shipcheck, branding, landing page, handbook, translations, repo-knowledge DB. The repo is not "done" until it's whole.

---

## Health Pass (Phases 1-4) — Four stages to clean bill of health

The Health Pass has four distinct stages. Each stage uses the same Audit → Review → Amend → Repeat cycle (Phases 1-4), but with a different lens:

- **Stage A: Bug/Security Fix** — Find and fix defects. Repeat until 0 CRITICAL + 0 HIGH.
- **Stage B: Proactive Health** — Fresh audit with proactive lens (defensive coding, observability, graceful degradation, future-proofing). Review findings.
- **Stage C: Humanization** — Amend the proactive findings with emphasis on USER EXPERIENCE: error messages that help, reconnection feedback, responsive layouts, loading states, state persistence, accessibility. This is the bridge between "not broken" and "actually good to use."
- **Stage D: Visual Polish** — Final pre-feature pass focused on the visual surface: typography/spacing/layout, iconography & assets, color/theming/dark-mode, animated demonstrations, command palette presentation, status bar integration, first-run welcome, settings UI grouping, marketplace/landing-page visuals.

**Key insight:** Proactive health, humanization, and visual polish findings are NOT afterthoughts — they represent the gap between "code that works" and "code that respects the user." The Stage C and Stage D amend waves treat these findings with the same rigor as bug fixes because polish IS quality.

---

### Phase 1: HEALTH AUDIT

Launch 5 parallel agents, one per domain, to audit all components.

1. Create a save point tag before the first wave:
   ```bash
   cd F:/AI/<repo>
   git tag swarm-save-$(date +%s)
   ```

2. Launch 5 agents with these domain assignments:

   | Domain | Scope | Typical Files |
   |--------|-------|---------------|
   | Backend | Core server logic | server.py, main modules |
   | Bridge | Secondary services | ws_bridge.py, API bridges |
   | Tests | Test suite | tests/*.py, conftest.py |
   | CI/Docs | Infrastructure + docs | .github/workflows/, *.md, config |
   | Frontend | UI layer | *.html, *.css, *.js |

   For larger repos, expand up to 10 agents by splitting domains.

3. Each agent audits its domain. The audit lens depends on the current stage:

   **Stage A (Bug/Security Fix):**
   - Bugs and logic errors
   - Security vulnerabilities
   - Code quality issues
   - Type safety violations
   - Test coverage gaps
   - Documentation accuracy

   **Stage B (Proactive Health):**
   - Defensive coding gaps (missing guards, unchecked returns)
   - Observability (logging, metrics, health checks)
   - Graceful degradation (offline behavior, partial failure handling)
   - Future-proofing (extensibility, migration paths)

   **Stage C (Humanization):**
   - Error messages: do they help the user fix the problem?
   - Reconnection/retry feedback: does the user know what's happening?
   - Responsive layouts: does the UI work at all breakpoints?
   - Loading states: is there feedback during async operations?
   - State persistence: does the app remember user context across sessions?
   - Accessibility: keyboard navigation, screen reader support, contrast

   **Stage D (Visual Polish):**
   - Typography, spacing, and layout consistency across surfaces
   - Iconography and asset quality (logos, screenshots, social cards, favicons)
   - Color, theming, and dark-mode parity
   - Animated demonstrations / GIFs / motion
   - Command palette and status bar presentation (for editor-integrated tools)
   - First-run welcome and onboarding visuals
   - Settings UI grouping and labeling
   - Marketplace listing visuals and landing-page polish

4. Agent output format:
   ```json
   {
     "domain": "backend",
     "stage": "A|B|C|D",
     "findings": [
       {
         "id": "F-001",
         "severity": "CRITICAL|HIGH|MEDIUM|LOW",
         "category": "bug|security|quality|types|tests|docs|defensive|observability|degradation|ux|accessibility",
         "file": "path/to/file.py",
         "line": 42,
         "description": "What is wrong",
         "recommendation": "How to fix it"
       }
     ],
     "summary": "Brief domain health assessment"
   }
   ```

### Phase 2: REVIEW

Coordinator presents consolidated findings to the user.

1. Merge all agent outputs into a single findings list.
2. Sort by severity: CRITICAL > HIGH > MEDIUM > LOW.
3. Present to user with counts per severity level.
4. User approves, modifies, or rejects findings before any code is written.
5. Record approved findings in `manifest.json`.

### Phase 3: AMEND

Launch 5 parallel agents with exclusive file ownership to fix all approved findings.

1. Map approved findings back to domain agents. Each agent only edits files within its domain.
2. HARD RULE: No agent edits a file outside its assignment. Validate with:
   ```bash
   cd F:/AI/<repo>
   git diff --name-only | sort > /tmp/changed-files.txt
   ```
   Cross-reference every changed file against domain assignments.

3. After all agents complete, verify build passes:
   ```bash
   # Node/TypeScript
   npm run lint && tsc --noEmit && npm test

   # Rust
   cargo check && cargo test

   # Python
   ruff check . && pytest
   ```

4. If build fails, dispatch targeted fix agents for the failing domain only.

### Phase 4: REPEAT

Return to Phase 1 for a fresh audit against the remediated codebase.

- Each cycle is a clean audit — agents do not carry forward prior findings.
- **Checkpoint with user every 3 iterations** to confirm direction.
- **Stage A:** Continue until audit returns 0 CRITICAL + 0 HIGH. Then advance to Stage B.
- **Stage B:** Run one proactive audit cycle. Review findings. Then advance to Stage C.
- **Stage C:** Amend the proactive findings through the humanization lens. When complete, proceed to Stage D.
- **Stage D:** Run one visual-polish audit cycle, then a visual-amend wave. When complete = **clean bill of health**. Proceed to Feature Pass.

---

## Feature Pass (Phases 5-8) — Repeat until production-ready

### Phase 5: FEATURE-FOCUSED AUDIT

Agents audit for capabilities, not defects.

1. Launch 5 agents (same domain split) to evaluate:
   - Missing capabilities and feature gaps
   - Production readiness (error handling, logging, graceful degradation)
   - UX improvements (CLI ergonomics, API surface, user-facing messages)
   - Performance opportunities
   - Integration completeness

2. Agent output format:
   ```json
   {
     "domain": "backend",
     "features": [
       {
         "id": "FT-001",
         "priority": "CRITICAL|HIGH|MEDIUM|LOW",
         "category": "missing-feature|ux|performance|integration",
         "description": "What is needed",
         "scope": ["file1.py", "file2.py"],
         "effort": "small|medium|large",
         "recommendation": "How to implement"
       }
     ],
     "summary": "Domain feature assessment"
   }
   ```

### Phase 6: REVIEW

Coordinator presents feature findings to user BEFORE any code is written.

1. Merge all feature findings, sorted by priority.
2. Present to user with effort estimates.
3. User approves which features to build in this wave.
4. **No code is written until user approves the feature list.**

### Phase 7: EXECUTION

Agents build/improve approved features with exclusive file ownership.

1. Map approved features to domain agents.
2. HARD RULE: No agent edits a file outside its assignment.
3. Launch up to 5 agents in parallel.
4. After all agents complete, verify build passes (lint + typecheck + tests).
5. If new tests are needed for new features, the Tests domain agent writes them.

### Phase 8: REPEAT

Return to Phase 5 for a fresh feature audit.

- **Checkpoint with user every 3 iterations.**
- Continue until the codebase is production-ready (no CRITICAL or HIGH feature gaps remain).

---

## Final (Phase 9)

### Phase 9: TEST

Final comprehensive test pass validating everything works together.

1. Run the full test suite:
   ```bash
   # Node/TypeScript
   npm run lint && tsc --noEmit && npm test

   # Rust
   cargo check && cargo test

   # Python
   ruff check . && pytest
   ```

2. Run integration/E2E tests if they exist.
3. Verify no regressions from any wave.
4. Record final test count and pass rate in manifest.
5. If any failures, dispatch targeted fix agents and re-run.
6. Proceed to Phase 10 (Full Treatment).

---

## Full Treatment (Phase 10)

The swarm is not complete until the repo receives the Full Treatment. This phase ensures the repo is not just working but *whole* — branded, documented, searchable, and catalogued.

### Prerequisites

- Phase 9 tests must be green.
- Read `memory/full-treatment.md` AND `memory/handbook-playbook.md` from the canonical memory path before starting.
- Shipcheck must pass: `npx @mcptoolshop/shipcheck audit` — if it fails, fix before proceeding.

### Execution

Follow the 7 phases from `full-treatment.md` in order:

1. **Phase 0 — Shipcheck gate**: `npx @mcptoolshop/shipcheck init` + audit. Version bump (v0.x → v1.0.0, or patch bump).
2. **Phase 1 — README + translations**: Logo, badges, footer. Hand user the translation command (user runs locally, NEVER Claude).
3. **Phase 2 — Landing page**: `npx @mcptoolshop/site-theme init`, scaffold site-config, verify base path.
4. **Phase 3 — Handbook**: `npx @mcptoolshop/site-theme handbook --accent <color>`, expand README into 3-7 real doc pages, build + verify.
5. **Phase 4 — Repo metadata + coverage**: GitHub description/homepage/topics, coverage badge if applicable.
6. **Phase 5 — Repo Knowledge DB**: `node dist/cli.js scan`, add thesis/architecture/relationships.
7. **Phase 6 — Commit + deploy**: Stage explicitly (never `git add .`), push, verify landing page + handbook render.

### Completion

After Phase 7 (post-deploy verification) passes:
- Mark manifest `status: "complete"`.
- Record final metrics: test count, findings fixed, features shipped, treatment phases completed.

### Do NOT

- Skip any treatment phase — they are sequential and interdependent.
- Run translations from Claude — user runs locally via Ollama (zero cost).
- Skip the repo-knowledge DB entry — it's part of the swarm now.
- Mark the swarm complete before the landing page + handbook are live.

---

## Key Principles

1. **Exclusive File Ownership** — No agent edits a file outside its assignment. Violations trigger revert.
2. **Wave Size** — Max 5 agents per wave (one per domain). Expand to max 10 for large repos by splitting domains.
3. **Severity Triage** — All findings are triaged CRITICAL/HIGH/MEDIUM/LOW. Remediation follows severity order.
4. **Build After Every Wave** — Build must pass after every amend/execution wave (lint + typecheck + tests).
5. **Save Point** — Tag before first wave for easy revert.
6. **Four-Stage Pre-Feature** — Stage A fixes bugs/security, Stage B applies proactive hardening, Stage C humanizes behavior/text, Stage D polishes visuals. All four complete before features.
7. **Health Before Features** — Feature execution only begins after clean bill of health.
8. **User Reviews First** — User reviews feature audit BEFORE execution begins. No code without approval.
9. **Manifest Checkpoint** — `manifest.json` is the single source of swarm state for resumability.
10. **Evidence Persisted** — Evidence persisted to repo-knowledge DB after each wave.

---

## Domain Agent Assignments

| Domain | Scope | Typical Files |
|--------|-------|---------------|
| Backend | Core server logic | server.py, main modules, core packages |
| Bridge | Secondary services, APIs | ws_bridge.py, API bridges, middleware |
| Tests | Test suite, fixtures | tests/*.py, conftest.py, test helpers |
| CI/Docs | Infrastructure + documentation | .github/workflows/, *.md, config files |
| Frontend | UI layer | *.html, *.css, *.js, templates |

Adjust domains to match the repo's architecture. The key constraint is that every file belongs to exactly one domain, and no two agents share files.

---

## Manifest Schema

```json
{
  "swarm_id": "swarm-<unix-timestamp>-<4-random-hex>",
  "repo": "<org>/<repo>",
  "local_path": "F:\\AI\\<repo>",
  "commit_sha": "<HEAD commit>",
  "branch": "main",
  "started_at": "<ISO 8601>",
  "status": "health-audit-a|health-audit-b|health-audit-c|health-audit-d|review|amend|feature-audit|feature-review|execution|test|treatment|complete",
  "save_point_tag": "swarm-save-<timestamp>",
  "health_waves_completed": 0,
  "feature_waves_completed": 0,
  "findings_total": 0,
  "findings_fixed": 0,
  "tests_start": 0,
  "tests_end": 0,
  "completed_at": null
}
```

---

## Resuming an Interrupted Swarm

1. Read `manifest.json` from the swarm directory.
2. Check `status` to find the current phase.
3. Read all completed outputs from disk.
4. Identify which agents in the current phase completed vs. which are missing.
5. Re-dispatch only the missing work. Do not re-run completed agents.
6. Continue from the interrupted phase forward.

---

## Proven Results

| Repo | Waves | Start Tests | End Tests | Findings Fixed |
|------|-------|-------------|-----------|----------------|
| claude-collaborate | Stage A (2) + B (1) + C (1) | 35 | 71 | 106 |
| stillpoint | Stage A (3) + B (1) + C (2) + Feature (3) | 26 | 136 | 70 health + ~50 features |

---

## Coordinator Checklist (Quick Reference)

```
HEALTH PASS — STAGE A (Bug/Security Fix)
 1. [ ] Create save point tag
 2. [ ] Launch 5 health audit agents (bug/security lens)
 3. [ ] Collect findings, sort by severity
 4. [ ] Present findings to user for approval
 5. [ ] Launch 5 amend agents with exclusive file ownership
 6. [ ] Verify build passes (lint + typecheck + tests)
 7. [ ] Repeat until 0 CRITICAL + 0 HIGH
 8. [ ] Checkpoint with user every 3 iterations

HEALTH PASS — STAGE B (Proactive Health)
 9. [ ] Launch 5 audit agents (proactive lens: defensive coding, observability, degradation, future-proofing)
10. [ ] Present proactive findings to user for approval

HEALTH PASS — STAGE C (Humanization)
11. [ ] Launch 5 amend agents to fix proactive findings with UX emphasis
12. [ ] Focus: error messages, reconnection feedback, loading states, state persistence, accessibility
13. [ ] Verify build passes
14. [ ] Stage C complete — proceed to Stage D

HEALTH PASS — STAGE D (Visual Polish)
15. [ ] Launch 5 visual-polish audit agents (typography/spacing, iconography, color/theming, motion, command palette, status bar, first-run, settings UI, marketplace visuals)
16. [ ] Present visual findings to user for approval
17. [ ] Launch 5 stage-d-amend agents with exclusive file ownership
18. [ ] Verify build passes
19. [ ] Clean bill of health confirmed — proceed to Feature Pass

FEATURE PASS
20. [ ] Launch 5 feature audit agents
21. [ ] Present feature findings to user for approval
22. [ ] Launch 5 execution agents for approved features
23. [ ] Verify build passes
24. [ ] Repeat until production-ready
25. [ ] Checkpoint with user every 3 iterations

FINAL
26. [ ] Run comprehensive test pass
27. [ ] Record final test count and pass rate

FULL TREATMENT (Phase 10)
28. [ ] Read full-treatment.md + handbook-playbook.md
29. [ ] Shipcheck: npx @mcptoolshop/shipcheck audit (must exit 0)
30. [ ] Version bump (v0.x → v1.0.0, or patch bump)
31. [ ] Logo to brand repo, README finalized
32. [ ] Hand user translation command (user runs locally)
33. [ ] Scaffold landing page (site-theme init)
34. [ ] Scaffold + write handbook (3-7 pages from README)
35. [ ] Build + verify site: npm run build in site/
36. [ ] GitHub metadata: description, homepage, topics
37. [ ] Repo-knowledge DB: scan, thesis, architecture, relationships
38. [ ] Commit + deploy (explicit staging, never git add .)
39. [ ] Post-deploy verify: landing page, handbook, pagefind, CI green
40. [ ] Mark manifest status: "complete"
```
