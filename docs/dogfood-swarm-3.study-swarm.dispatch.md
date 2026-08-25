# Study-swarm dispatch — testing-os dogfood-swarm 3

**Date:** 2026-08-25
**Advisor:** Grok 4.6 (this session)
**Trigger:** Director said `study-swarm` (unconditional) plus "latest software" and a human-facing state+trajectory artifact.
**Product:** a new dogfood-swarm of `dogfood-lab/testing-os`, focused on making `@dogfood-lab/dogfood-swarm` solid. Other packages get polish notes.

## Questions dispatched (5 parallel research agents)

1. How should a swarm-orchestrator dogfood itself so control-plane defects are visible and gates are proven red?
2. Isolation default, exclusive ownership, and a coordinator-owned / not-dispatched class.
3. Jury design when the executor is Grok (xAI), not Sonnet.
4. Current stable versions and upgrade risk for the Node/TS/vitest/sqlite/Actions stack.
5. What a human-facing NOW/NEXT artifact should contain (and refuse).

## Step 4 verification

- **Stage 1 (retrieval oracle):** load-bearing arXiv IDs fetched 2026-08-25 from arXiv abs pages. Node schedule fetched from nodejs.org. TypeScript 7.0 announcement fetched from Microsoft DevBlogs.
- **Stage 2:** `PRISM_DEV=1 node E:\AI\role-os\bin\roleos.mjs verify-citations` → verdict `escalate` (advisory, not blocking). **8/8 arXiv ids resolved.** 7 supported against title+abstract. **1 RETRIEVE FULL TEXT:** arXiv:2604.13536 (YoloFS) — the “opt-in / downgrade-on-failure sandbox” clause is **withdrawn from the architectural lock**; the abstract *does* support 290 filesystem-misuse reports and insufficient control, which still orients #67. 3 unparsed official URLs (Node releases, TypeScript 7 blog, plus a false-positive on the Stage-1 prose line) were retrieval-verified out of band. Receipt: `docs/dogfood-swarm-3.study-swarm.dispatch.citation-receipt.json` (`prism-01m0xkswcv283n7z100e6qjzk4`, `chain_sha256 bcf9fe24…`).

## Research grounding (existence-verified unless marked)

1. **Coding agents guess under underspecification — 55.8–67.8% of acted runs violate ≥1 boundary.** Ji et al. 2026 (arXiv:2607.02294). Blast-radius cues barely cut action propensity. **Implication:** `--isolate` is the wave default; exclusive globs are the floor, not a prompt request. Shared-worktree dispatch is unsound for this swarm.

2. **LLM judges recognize and prefer their own generations; recognition tracks preference.** Panickssery, Bowman & Feng 2024 (arXiv:2404.13076). **Implication:** Grok-authored work excludes **xAI** from the jury. `swarm verify` stays law.

3. **Self-bias is family-bias, not only exact-model bias.** Spiliopoulou et al. 2025 (arXiv:2508.06709) — GPT-4o and Claude 3.5 Sonnet boost same-family outputs after quality controls. **Implication:** exclude the executor's vendor family (xAI). Anthropic is optional diversity here, not a required ban.

4. **Manipulated CoT inflates judge false-positives by up to ~90% with actions held fixed.** Khalifa et al. 2026 (arXiv:2601.14691). **Implication:** case-files strip producer justification; jury sees objective + falsifiable criteria only.

5. **PoLL arithmetic mean has unbounded bias under LLM-typical contamination; geometric median (breakdown 1/2) dominates.** Acharya, Pan & Verkhovsky 2026 (arXiv:2606.30931, RoPoLL). **Implication:** aggregate jury ranks with **median**, never mean — already house law; keep it.

6. **A testbench that never fails is not evidence of a correct design.** Bhadra 2026 (arXiv:2608.12635, GateTruth). **Implication:** Stage A must include mutants that prove control-plane gates go red (false-`fixed`, unknown `finding_id` drop, coordinator-domain skip).

7. **Agent filesystem misuse is a control problem: 290 public reports; users and agents lack information about and control over filesystem effects.** Zhong et al. 2026 (arXiv:2604.13536, YoloFS). Abstract-supported. A narrower “sandboxes are opt-in / downgrade-on-failure” clause was **withdrawn** (prism L4: not addressed in title+abstract). **Implication:** issue #67 (`coordinator` class: exclusive AND skipped at dispatch) is the product P0 — put control in the map, not in the prompt.

8. **Contrastive “why P rather than Q” explanations improve independent decisions (N=628).** Buçinca et al. 2024/2025 (arXiv:2410.04253). **Implication:** the Director artifact is contrastive NOW vs a likely foil, compiled from the DB, not an authored plan.

9. **Node 24 is LTS (Krypton); Node 22 is LTS (Jod); Node 25 is EOL; Node 26 is Current.** Node.js Releases, measured 2026-08-25 (https://nodejs.org/en/about/previous-releases). **Implication:** keep CI 22+24; drop local Node 25; do not require 26.

10. **TypeScript 7.0 has no programmatic API until 7.1; Astro/Vue/MDX/Svelte embeds stay on 6.** Rosenwasser / TypeScript team 2026-07-08 (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). **Implication:** HOLD Dependabot #55. This repo's handbook is Astro.

11. **Vitest latest stable is 4.1.x; 5 is still RC.** vitest releases, agent-retrieved 2026-08-25. **Implication:** patch 4.1.9 → 4.1.11; wait on Vitest 5.

12. **js-yaml 5 is a known-breaking rewrite (CORE_SCHEMA, no `<<` merge, `load('')` throws).** nodeca/js-yaml migrate guide. **Implication:** HOLD Dependabot #50 until callers are audited.

## Architectural lock (each choice cites a finding)

- **New run, not resume of `swarm-1784091637-5127`.** That run is at `test` with 0 open. Seed from its roadmap (T4). (8)
- **`--isolate` on every wave.** (1, 7)
- **Inherit the 5127 domain map**, with Stage A product work to add a `coordinator` ownership class for #67. (7)
- **Jury excludes xAI; median aggregation; `swarm verify` is law.** (2, 3, 4, 5)
- **Prove-red mutants** for the known silent gates (#65 unknown-id drop, silence→fixed class, #67 inexpressible coordinator domain). (6)
- **Software:** Node 22+24; HOLD TS 7 and js-yaml 5 and Vitest 5; patch Vitest 4.1.x; consider better-sqlite3 13 after health. (9–12)

## Receipt

`docs/dogfood-swarm-3.study-swarm.dispatch.citation-receipt.json` — prism `prism-01m0xkswcv283n7z100e6qjzk4`, 8 resolved / 7 supported / 1 retrieve-full-text / 0 fabricated.
