# Dispatch — Option C: rebuild the regression-pin gate on declared links + execution proof

**Repo:** `dogfood-lab/testing-os` · **Target:** `scripts/check-finding-regression-pins.mjs` (the Class #14 gate in `npm run verify`, `ci.yml`, `release.yml`)
**Run:** `swarm-1784091637-5127` · **Branch:** `swarm/health-amend-a-1784091637` @ `860ed73`
**Status:** design dispatch — research-grounded per the study-swarm protocol. Citations gated at Step 4 before any architectural connection.

## Why this exists

The gate enforces a "Class #14 invariant": every finding id (`F-xxxxxxxx`) marked fixed in source must have at least one test that pins it. It decides this by **regex heuristics over raw source text** — "is the id near an assert", "is the id in a test title", "is the id in a leading comment". It has produced a **false grant** on **seven consecutive adversarial audits** (w5→w17): prose in a non-code position (comment, string, template literal, test title, regex-literal body) is read as code and credits an id nothing covers. A false grant is the dangerous direction — the gate reports "OK, invariant holds" while it does not, and it gates every push and every `npm publish`.

Six prior fixes were patches. Wave 16 was a genuine rewrite (lex-then-credit) and **still leaked** — one credit rule was left reading raw text. The rule this repo has carried since wave 14 — *"if it leaks a 7th time, the approach was wrong, not the patch"* — has fired.

This dispatch does not propose a better heuristic. The research says the heuristic class is the defect.

---

## Research grounding (the dispatch's empirical floor)

Five parallel research lanes, retrieval-mandatory. 37 findings returned; the load-bearing ones follow. Each architectural choice below traces to these numbers.

### Step 4 verification record (external, family-different, reasoning-stripped)

`roleos verify-citations` (role-os v2.10.0) → `prism verify --type citations --provider ollama` (prism v1.6.0; groundedness lens `mistral-small:24b` — ModelFamily `local`, reasoning-stripped, family-different from the `anthropic` synthesizer by construction) + the deterministic arXiv/Crossref existence oracle. 19 parsed citations checked in 36.0s. Ed25519 receipt key `ed25519-c9a7791cd92ade91`.

| Stage | Result |
|---|---|
| **Existence (retrieval oracle)** | **19/19 RESOLVED — 0 FABRICATED, 0 MISATTRIBUTED.** Every DOI/arXiv id resolves to a real paper with the stated identifier. |
| **Groundedness (different-family lens)** | 4 supported · 15 `not_addressed` → **1 withdrawn** (finding 29, below), 14 oracle-limited. |
| **Unparsed** | 7 items carry official-doc URLs (ESLint, TS-Compiler-Notes, js-tokens, Codecov, JUnit/Spock, rustc-dev-guide, kernel.org, oxc, and PDF-hosted papers) with no arXiv/DOI id — the documented arXiv/Crossref-tuned-oracle behavior for a docs-heavy dispatch, **not** a fabrication signal. Verified out-of-band by the research lanes' own retrieval. |

**Honest boundary on the 14 oracle-limited items:** 12 report *"resolved, but no abstract was available to ground the claim"* — ACM DOIs do not expose abstracts to the oracle, so the lens had nothing to check against. This is a limitation of the retrieval path, not evidence for or against the claims. Their **existence and attribution are verified**; their groundedness is **unverified-by-this-oracle** and rests on the research lanes' retrieval. Stated rather than papered over, per finding 20.

**The gate caught a real defect in this dispatch's own synthesis** — finding 29 overreached its source and was withdrawn. That is the verifier working as designed on our own output.

### A. Why inference cannot be the mechanism

1. **IR-based traceability recovery — the direct academic analogue of our regex gate — never achieves high precision and high recall simultaneously, and its own authors frame it as a candidate-link generator requiring human vetting, never an autonomous gate.** De Lucia et al. (*ADAMS re-trace: Traceability Link Recovery via Latent Semantic Indexing*) reports 76.2% recall / 94.1% precision under favorable conditions; Hayes, Dekhtyar & Sundaram 2007 (*Advancing Candidate Link Generation for Requirements Tracing*, Innovations in Systems and Software Engineering, DOI 10.1007/s11334-007-0024-1) reports ~85% recall / 69% precision on one NASA subset and 70% / 99% on another. **Implication:** our gate is unattended inference of exactly this kind. The literature's own position is that this class of link must be human-vetted. An autonomous text-inference gate is unsupported by the field that invented the technique.

2. **No retrieved evidence exists that any real system enforces "this fix has a regression test" by text-proximity inference; every mechanism found is structural or requires human sign-off.** Q2 lane honest gap, checked against Linux (kernel.org, *Submitting Patches*, https://docs.kernel.org/process/submitting-patches.html), Defects4J, Codecov, and Bazel/TAP. **Implication:** we are not behind the state of the art — we are outside it. This is the single most load-bearing finding in the swarm.

3. **TypeScript's own compiler documentation states the scanner has no memory of prior tokens and requires the parser to rewind and re-run it with different context to resolve ambiguous spans.** Microsoft, *TypeScript-Compiler-Notes*, `codebase/src/compiler/scanner.md` (https://github.com/microsoft/TypeScript-Compiler-Notes/blob/main/codebase/src/compiler/scanner.md). **Implication:** "upgrade the regex to a token scanner" is refuted by the scanner's authors. Classifying a span as comment/string/template/code is the exact ambiguity a scanner alone cannot resolve — this would have been leak #8.

4. **A production JS tokenizer documents that it cannot always distinguish a regex literal from division, or JSX from comparison, because doing so is "nearly impossible... without implementing a full parser."** Simon Lydell, *js-tokens*, README "Known errors" (https://github.com/lydell/js-tokens#readme). **Implication:** the regex-vs-division residual wave 16 shipped as a disclosed limitation is not an oversight — it is the documented, structural ceiling of token-level classification. Only a real parse resolves it.

### B. What a trustworthy fix↔test link actually is

5. **The field's gold-standard bug/fix/test benchmark accepts a link only on a dynamic execution signal — the test must deterministically FAIL on the pre-fix commit and PASS on the post-fix commit — plus mandatory human review.** Just, Jalali & Ernst 2014 (*Defects4J: A Database of Existing Faults to Enable Controlled Testing Studies for Java Programs*, ISSTA 2014, https://homes.cs.washington.edu/~rjust/publ/defects4j_issta_2014.pdf). **Implication:** this is the definition of a regression pin. Red-without-the-fix / green-with-it is the only trustworthy evidence. Our gate must approximate this, not prose adjacency.

6. **Google computes which tests cover a change by reverse-dependency traversal of the Bazel build graph — structural, never inferred from prose.** Memon et al. 2017 (*Taming Google-Scale Continuous Testing*, ICSE-SEIP 2017, https://research.google.com/pubs/archive/45861.pdf). **Implication:** at the largest scale, the answer to "which test covers this?" is computed from structure, not language.

7. **Codecov's patch-coverage gate blocks a PR when diff lines are not executed by any test, determined by runtime coverage instrumentation rather than identifier matching.** Codecov documentation (https://docs.codecov.com/docs/commit-status). **Implication:** where industry mechanizes "this change is tested," the signal is execution.

8. **Explicit machine-readable issue→test annotation is a first-class, adopted framework feature, not a novel invention.** JUnit Pioneer `@Issue` (https://junit-pioneer.org/docs/issue/) exposes a structured tracker id consumable by an `IssueProcessor`; Spock `@Issue` (https://spockframework.org/spock/javadoc/1.0/spock/lang/Issue.html) does the same. **Implication:** a declared tag binding a test to a finding id has direct precedent; we are not inventing a mechanism.

9. **Rust's compiler team instructs contributors to link the issue in a test comment and explicitly states that no tooling enforces it.** rustc-dev-guide (https://rustc-dev-guide.rust-lang.org/tests/best-practices.html). **Implication:** the decisive caution against the naive fix. An annotation without a schema and a CI check is documentation, not a machine link — it decays exactly like inference. Declaring is necessary but not sufficient; it must be enforced.

### C. Why a perfect parser is only half the gate

10. **"Pseudo-tested methods" are a named, measured phenomenon: deleting a covered method's entire body leaves the suite green for a median of roughly 10% of covered methods.** Vera-Pérez, Danglot, Monperrus & Baudry 2019 (*A Comprehensive Study of Pseudo-tested Methods*, Empirical Software Engineering 24:1195–1225, DOI 10.1007/s10664-018-9653-2), replicating Niedermayr, Röhm & Wagner 2016, across 28K+ methods in 19 projects. **Implication:** this is our vacuous-pin defect exactly — a real assertion that stays green when the pinned logic is deleted. It is an industry base rate, not local sloppiness, and **no parser can detect it**.

11. **Code coverage — and by extension mere assertion presence — correlates only weakly with real suite effectiveness once suite size is controlled for.** Inozemtseva & Holmes 2014 (*Coverage Is Not Strongly Correlated With Test Suite Effectiveness*, ICSE 2014, DOI 10.1145/2568225.2568271). **Implication:** "an assert appears near the id" is the precise proxy this paper discredits. It cannot be the gate's ground truth.

12. **Mutation score statistically significantly predicts real-fault detection, independent of code coverage.** Just, Jalali, Inozemtseva, Ernst, Holmes & Fraser 2014 (*Are Mutants a Valid Substitute for Real Faults in Software Testing?*, FSE 2014, DOI 10.1145/2635868.2635929), over 357 real faults in 5 projects. **Implication:** the primary positive evidence that "test T kills a mutant of fix F" is a defensible proxy for "T would catch F's return."

13. **Diff-scoped mutation testing — mutating only the changed lines rather than the whole codebase — is proven practical at extreme industrial scale with measured developer-perceived value.** Petrović & Ivanković 2018 (*State of Mutation Testing at Google*, ICSE-SEIP 2018, DOI 10.1145/3183519.3183521); Petrović, Ivanković, Fraser & Just 2021 (IEEE TSE, DOI 10.1109/TSE.2021.3107634): 24,000+ developers, 1,000+ projects, 3–19 mutants per changelist, productivity ratings rising 82%→89%. **Implication:** our exact target shape — mutate only the lines of fix F, per finding — is what Google runs in code review. This is the strongest practicality evidence for requiring it.

14. **HONEST COMPLICATION — suite-level mutation-score correlation with real-fault detection weakens substantially once test-suite size is controlled for.** Papadakis, Shin, Yoo & Bae 2018 (*Are Mutation Scores Correlated with Real Fault Detection?*, ICSE 2018, DOI 10.1145/3180155.3180183). **Implication:** we must not claim "mutation-proven" beyond the narrow claim we actually make. Our check is single-test/single-mutant and targeted, which sidesteps the suite-size confound — but the marketing must stay inside that boundary.

15. **HONEST CEILING — over half of 15,000+ mutants survived Meta's full unit+integration+system suite, and of 26 developers shown a live mutant only about half said they would act on it.** Beller, Wong, Bader, Scott, Machalica, Chandra & Meijer 2021 (*What It Would Take to Use Mutation Testing in Industry — A Study at Facebook*, ICSE-SEIP 2021, arXiv:2010.13464). **Implication:** a surviving mutant is not self-evidently actionable; the gate's output must show a legible mutant diff, not just a verdict.

16. **Incremental/diff-scoped mutation tooling already ships for this repo's stack.** StrykerJS `--incremental` (https://stryker-mutator.io/docs/stryker-js/incremental/) diffs against a stored baseline, documented at 30min→<2min on typical PRs; PIT's `historyInputFile`/`scmMutationCoverage` (https://pitest.org/quickstart/incremental_analysis/) is the JVM equivalent. **Implication:** the execution layer is a tooling integration, not a research project.

17. **Mutation testing rests on 45+ year-old foundations and a mature tool ecosystem, not an experimental bet.** DeMillo, Lipton & Sayward 1978 (*Hints on Test Data Selection: Help for the Practicing Programmer*, Computer 11(4):34–41); Jia & Harman 2011 (*An Analysis and Survey of the Development of Mutation Testing*, IEEE TSE 37(5):649–678, DOI 10.1109/TSE.2010.62). **Implication:** adopting mutation as the oracle applies established theory.

### D. Gate policy — what may block, and what must be disclosed

18. **Google holds review-time analyzers to under 10% effective false positives (≈5% system-wide), and requires any check permitted to break a build to reach effectively zero false positives — a check too unreliable to block is withheld from output entirely rather than shown as an ignorable warning.** Sadowski, Aftandilian, Eagle, Miller-Cushon & Jaspan 2018 (*Lessons from Building Static Analysis Tools at Google*, CACM 61(4), https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/). **Implication:** the *blocking* subset of our gate must be the provably-exact part. A rule that can produce a false orphan (our `F-b00fb0d0`) does not qualify to block until fixed.

19. **False negatives, not false positives, are what a mature analyzer team optimizes against for severe bug classes; and deployment timing, not accuracy, drove a 0%→70% fix-rate swing at constant ~20% FP.** Distefano, Fähndrich, Logozzo & O'Hearn 2019 (*Scaling Static Analyses at Facebook*, CACM 62(8), DOI 10.1145/3338112). **Implication:** for a soundness gate, the false grant IS the severe class. A missed real violation outranks a noisy true one.

20. **Real analyses are "soundy" — a sound core plus specific under-approximated features assumed away by convention — and the manifesto's central complaint is that this handling is routinely left undisclosed, letting readers wrongly conclude the analysis is sound.** Livshits, Sridharan, Smaragdakis et al. 2015 (*In Defense of Soundiness: A Manifesto*, CACM 58(2), DOI 10.1145/2644805, https://yanniss.github.io/Soundiness-CACM.pdf). **Implication:** unsoundness is permitted; **undisclosed** unsoundness is the defect. Our "WHAT STILL SLIPS THROUGH" docstring was the right instinct executed dishonestly — it was incomplete, which made the gate's self-description a lie. Every gap must be enumerated, in the gate's own output.

21. **Suppression lists rot at a measured rate: 50.8% of 7,357 suppressions across 46 projects matched zero live warnings, counts only ever grow, and dead suppressions "woke up" to silently hide newly-introduced unrelated findings.** Hu, Wang, Rubin & Pradel 2025 (*An Empirical Study of Suppressed Static Analysis Warnings*, Proc. ACM Softw. Eng. 2(FSE), DOI 10.1145/3715729). **Implication:** our 15-entry allowlist needs per-entry provenance and periodic re-validation; append-only growth is a known failure mode with a ~1-in-2 base rate.

22. **Developers and customers repeatedly and wrongly insisted a correct tool-reported bug was a false positive, only for it to be confirmed real later.** Bessey, Block, Chelf et al. 2010 (*A Few Billion Lines of Code Later: Using Static Analysis to Find Bugs in the Real World*, CACM 53(2), DOI 10.1145/1646353.1646374). **Implication:** pushback is not evidence of gate error. Any override path needs an evidence trail, never a trust-the-human bypass.

### E. How we will know it does not leak an eighth time

23. **Differential testing — running independent implementations on identical input and diffing — is the founding technique for exposing bugs where no formal oracle exists.** McKeeman 1998 (*Differential Testing for Software*, Digital Technical Journal 10(1):100–107, https://www.cs.tufts.edu/comp/150FP/archive/bill-mckeeman/DifferentailTesting.pdf). **Implication:** build a second, independently-coded reference matcher; disagreement on any corpus case is the bug signal, with no hand-authored oracle.

24. **Randomized program generation against a crash/miscompilation oracle found 325+ previously-unknown bugs across every production C compiler tested, including silent wrong-code with no crash.** Yang, Chen, Eide & Regehr 2011 (*Finding and Understanding Bugs in C Compilers*, PLDI 2011, DOI 10.1145/1993498.1993532). **Implication:** seven consecutive human-found leaks is evidence the manual audit is the weaker oracle. A generator over the pin-syntax space will find evasions no auditor imagined.

25. **Test variants derived from real executed programs found 147 confirmed unique GCC/LLVM bugs in 11 months — real-derived variants trigger bugs synthetic generation misses.** Le, Afshari & Su 2014 (*Compiler Validation via Equivalence Modulo Inputs*, PLDI 2014, DOI 10.1145/2594291.2594334). **Implication:** seed the adversarial corpus from the seven real historical evasions, not synthetic cases alone.

26. **Metamorphic testing — asserting invariance relations — is the standard oracle substitute exactly when no full specification of correct output exists.** Chen, Cheung & Yiu 1998 (*Metamorphic Testing: A New Approach for Generating Next Test Cases*, HKUST-CS98-01); Barr, Harman, McMinn, Shahbaz & Yoo 2015 (*The Oracle Problem in Software Testing: A Survey*, IEEE TSE 41(5):507–525, DOI 10.1109/TSE.2014.2372785). **Implication:** we have no full spec of "should credit," so relations are our oracle: *inserting a comment anywhere must never change a credit decision*; *consistently renaming an id must never change the verdict*.

27. **Applying exactly those relations (renaming, dead/unreachable-code insertion, semantics-preserving rewrites) to five production static analyzers found 64 confirmed rule bugs, 53 undetected by any prior baseline — including SpotBugs correctly detecting a bug in a seed program and then missing the identical bug once an unreachable switch statement was inserted.** Nnorom et al. 2025 (*StaAgent: An Agentic Framework for Testing Static Analyzers*, arXiv:2507.15892). **Implication:** dead code alone flipping an analyzer's verdict is our exact evasion class, independently confirmed in production tools. Adopt these operators as our permanent metamorphic suite.

28. **Metamorphic testing driven by an analyzer's own historical confirmed-bug reports found 14 new false negatives/positives in PMD, SpotBugs and SonarQube, 11 confirmed by maintainers.** Cui, Xie, Su, Zhang & Tan 2024 (arXiv:2408.13855). **Implication:** each of our seven historical leaks becomes a **generalized relation**, not a fixed regression test. The history is a generator, not a checklist.

29. **~~Curated corpora decay once public — tools converge on shortcut-learning via filename/pattern artifacts, and even the best fuzzer finds only ~1/3 of ground-truth bugs.~~ WITHDRAWN AT STEP 4 — CANNOT_CONFIRM.** Attributed to Hazimeh, Herrera & Payer 2020 (*Magma: A Ground-Truth Fuzzing Benchmark*, arXiv:2009.01120) + NIST Juliet. The external verifier flagged the claim as not addressed in the title+abstract; a direct retrieval of the arXiv abstract confirms **neither** the shortcut-learning claim **nor** the ~1/3 figure appears there. The paper exists and the id resolves (0 fabricated) — but the synthesized finding overreached its source. **Per the protocol's CANNOT_CONFIRM rule this finding is REMOVED from the architectural connection below and surfaced contrastively to the Director.** Reinstate only if the claim is confirmed against the paper body.
    **Contrastive frame:** *you may have expected an evidence-backed "benchmarks decay, so the corpus must never freeze" argument here; I removed it because the retrieval oracle could not confirm it. C9's append-only-corpus choice does NOT depend on it — it stands on findings 24 and 28 alone. Override with the Magma full text if you want the decay argument restored.*

30. **Mutating the analyzed corpus exposes analyzer blind spots invisible to fixed benchmarks; mutating the analyzer's own source is the separate established technique for proving its test suite would catch a regression in itself.** Groce et al. 2021 (*Evaluating and Improving Static Analysis Tools Via Differential Mutation Analysis*, QRS 2021, DOI 10.1109/QRS54544.2021.00032); Jia & Harman 2011 (IEEE TSE 37(5):649–678, DOI 10.1109/TSE.2010.62). **Implication:** do both — mutate the fixture corpus for coverage, and mutation-test the matcher's own source to prove its tests go red.

### F. Substrate and failure policy

31. **Production JS linters parse to a real AST and lint the tree rather than pattern-matching raw source — this is the baseline architecture.** ESLint 2014 (*Introducing Espree, an Esprima Alternative*, https://eslint.org/blog/2014/12/espree-esprima/). **Implication:** AST, not text, not tokens.

32. **ESLint surfaces an unparseable file inside normal output as `fatal: true, ruleId: null` — never silently skipped — with a distinct hard-fail available via `--exit-on-fatal-error`.** ESLint Node.js API and CLI references (https://eslint.org/docs/latest/integrate/nodejs-api, https://eslint.org/docs/latest/use/command-line-interface). **Implication:** the precedent for our parse-failure policy. "Silently skipped" and "clean" are indistinguishable to a gate — a file we cannot parse must be a loud defect.

33. **`@babel/parser`'s `errorRecovery` is opt-in, yields a typed `errors[]` array, and still throws on unrecoverable errors — recoverable parsing is a bounded editor feature, not a silent best-effort default.** Babel documentation (https://babeljs.io/docs/babel-parser). **Implication:** supports fail-closed; do not treat "did not parse" as "parsed clean."

34. **typescript-eslint maintains a narrow rolling supported-TypeScript window (currently `>=4.8.4 <6.1.0`) and will not accept issues against unsupported compiler versions, because TS ships roughly quarterly and internal APIs drift.** typescript-eslint, *Dependency Versions* (https://typescript-eslint.io/users/dependency-versions/). **Implication:** coupling the gate to the TypeScript compiler's internal API buys drift cost. Our gate needs **no type information** — so prefer a stable ESTree-shaped parser.

35. **Full-AST parsing is cheap in absolute terms — a large real-world TypeScript file parses in 26.4ms (oxc) / 91.0ms (swc) / 139.3ms (Biome), single-threaded.** oxc-project, *bench-javascript-parser-written-in-rust* (https://github.com/oxc-project/bench-javascript-parser-written-in-rust). **Implication:** at 553 files once per `npm run verify`, parse cost is not a credible objection to dropping the heuristics.

---

## The architectural lock

Every choice traces to a finding number. Choices without a number are not made here.

### C1 — Declare the link; do not infer it. *(Findings 1, 2, 8, 9)*

A test declares which finding it pins via a **schema'd, machine-readable annotation** — not prose proximity. Concretely, a JSDoc-style tag immediately preceding the test:

```js
/** @pins F-e003b1fb */
test('escaped-quote title does not defeat the title mask', () => { … });
```

The gate reads the tag **from the AST** (C2), never from text. Finding 2 is decisive: nobody enforces this by inference, and the analogue technique's own authors (1) call it human-vetting-only. Findings 8/9 give the annotation direct precedent (`@Issue` in JUnit Pioneer / Spock).

**This collapses the entire false-grant class by construction.** A comment, a string, a template continuation, a test title, or a regex body can no longer *accidentally* look like a pin, because a pin is now a declared tag in a defined position — not an id that happens to sit near a word.

### C2 — Read the declaration from a real AST on a stable ESTree-shaped parser. *(Findings 3, 4, 31, 34, 35)*

Findings 3 and 4 refute the scanner/token approach *from the authors of the scanner and of a production tokenizer*. Finding 34 refutes coupling to the TypeScript compiler API (drift cost, and we need no type info). Finding 35 removes the perf objection. Therefore: an ESTree-shaped AST parser with JSDoc/comment attachment, covering `.js/.mjs/.cjs/.jsx` natively and `.ts/.tsx` via the ESTree-compatible TS parser.

The parser's job is now trivial and exact: *find tag T attached to test node N*. It is no longer asked to infer intent from position — the question that was never answerable.

### C3 — Enforce the declaration; an unenforced annotation is documentation. *(Finding 9)*

Rust proves the naive version fails: an issue link in a comment that no tooling checks is not a machine link. So the tag is **schema-validated** (well-formed id, resolvable against the findings corpus, attached to an actual test node) and **CI-enforced**. A malformed or dangling tag is a defect, not a shrug.

### C4 — Prove the claim by execution; the tag is a claim, not evidence. *(Findings 5, 10, 11, 12, 13)*

C1–C3 make the *link* trustworthy. They do nothing about whether the test is **vacuous** — finding 10 says a median ~10% of covered methods survive whole-body deletion, and finding 11 says assertion presence is the discredited proxy. Finding 5 gives the gold-standard definition: **the test must fail without the fix and pass with it.**

Operationalized per finding 13 (Google's diff-scoped mutation, 24k developers): for finding `F`, mutate **only the lines of F's fix** and require that at least one test declaring `@pins F` **fails**. That is Defects4J's red-without-the-fix signal, computed mechanically.

### C5 — Two tiers: exact-and-blocking vs. proving-and-advisory. *(Findings 14, 15, 18, 19)*

Finding 18 sets the bar: only a provably-exact check may block. Finding 19 says the false grant is the severe class for us. Findings 14/15 bound the honesty of the mutation claim.

- **Tier 1 (blocking):** the declared-link check (C1–C3). It is exact — a tag either parses, validates and attaches, or it does not. Zero inference, so zero false grants *and* zero false orphans. This blocks `verify`/CI/`release`.
- **Tier 2 (advisory→escalating):** the mutation proof (C4). It carries the honest limits of findings 14/15 and real runtime cost. It reports, with a legible mutant diff (15), and escalates rather than silently blocking.

This is the deterministic-floor + proving-ceiling shape, and it is why the gate stops lying *immediately* (Tier 1) without waiting on Tier 2's runtime.

### C6 — Disclose every gap, in the gate's own output. *(Finding 20)*

Soundiness is permitted; undisclosed unsoundness is the defect — and it is precisely our seven-leak failure mode. The gate enumerates its own under-approximations in its output, not only in a docstring that drifted. Anything Tier 2 could not prove is reported as *unproven*, never as *pinned*.

### C7 — Fail closed on anything unparseable or undetermined. *(Findings 32, 33, 19)*

A file that will not parse is a **loud defect** (`fatal`), never a silent skip — "skipped" and "clean" are indistinguishable to a gate (32). Unrecoverable parse errors throw (33). Undetermined ≠ credited (19).

### C8 — Allowlist entries carry provenance and expire. *(Findings 21, 22)*

Each of the 15 entries gains a reason, an owner and a revalidation date; the gate reports entries matching zero live findings (21's ~1-in-2 dead-weight base rate). Overrides require an evidence trail, never a trust-the-human bypass (22).

### C9 — Prove the gate cannot leak, mechanically. *(Findings 23, 24, 25, 26, 27, 28, 29, 30)*

This is the part that makes the rewrite worth doing rather than being leak #8 with better vocabulary:

- **Metamorphic relations as permanent CI assertions** (26, 27): *inserting a comment / dead code anywhere must never change a credit decision*; *consistent id renaming must never change a verdict*. StaAgent (27) found this exact class in SpotBugs.
- **The seven historical leaks become generalized relations, not seven fixed tests** (28). The history is a generator.
- **A generator over the pin-syntax space** (24, 25), seeded from the real historical evasions rather than synthetic-only.
- **A second, independently-coded reference matcher, diffed in CI** (23) — disagreement is the bug signal.
- **Mutation-test the matcher's own source** (30) — prove its tests go red.
- **The corpus is append-only and never frozen** (24, 28 — *not* 29, which was withdrawn at Step 4) — a generator plus historical-leak-derived relations beat any fixed checklist, so every future audit's evasion joins the corpus permanently.

---

## Scope decision (Director, 2026-07-16)

**Wave 18 = Tier 1 + the full C9 assurance rig.** Tier 2 (C4's mutation proof) is designed above and lands in wave 19 — it is a StrykerJS integration with real runtime cost, and bundling it would delay the false-grant fix that is actually bleeding. Wave 19 also serves as the confirming audit for wave 18.

Rationale for not deferring C9 alongside it: findings 24/27/28 say seven human-found leaks means manual review is the weaker oracle. Shipping the rewrite *without* the rig that proves it would rest this attempt on the same basis as the previous six — "we were careful."

### The migration strategy — the old heuristic becomes what the literature says it always was *(Findings 1, 5)*

Every existing test pin must acquire a declared `@pins` tag, across every domain's test files. This is not a big-bang hand edit:

- **The old regex matcher is repurposed as a candidate-link generator** — which is precisely the role finding 1 says this technique is valid for ("a candidate-link generator requiring human vetting, never an autonomous gate"). Its *true* positives are largely correct; its defect is false positives. So it proposes `@pins` tags; it no longer grants anything.
- **Each domain's agent vets and lands the tags for its own files** — the human-review half of finding 5's Defects4J standard. Cross-domain by construction, so the migration distributes across the wave's domains rather than concentrating in ci-tooling.
- **The new gate credits only declared, vetted tags.** The heuristic's verdict is discarded entirely; it survives only as a migration aid and is deleted afterward.

This retires the heuristic *into the role it was always valid for*, rather than trusting it one last time.

## What we are explicitly NOT doing, and why

- **Not a better regex / a smarter heuristic.** Findings 1, 2 — the class is the defect.
- **Not the TypeScript scanner** (my own first instinct, refuted). Findings 3, 4 — the scanner's authors and a tokenizer maintainer both document that this cannot work.
- **Not the TypeScript compiler API.** Finding 34 — drift cost for type information we do not need.
- **Not "syntactic assert presence, but from an AST."** Findings 10, 11 — that is the discredited proxy, merely parsed more accurately. It would close false grants and leave vacuous pins wide open.
- **Not whole-suite mutation scoring.** Finding 14 — the suite-size confound; our claim stays narrow and targeted.

## Disclosed residuals (per finding 20 — these are stated, not hidden)

1. **Tier 2 is advisory at first.** Until the mutation layer is proven on this corpus, a *vacuous but correctly declared* pin passes Tier 1. This is a real gap, disclosed, and it is strictly smaller than today's (today, a comment forges a pin).
2. **Annotation burden.** Every existing pinned finding needs a declared tag; the migration is mechanical but large. Findings 9/21 warn that an unmaintained tag rots — C3's enforcement is the mitigation.
3. **Mutation cost and actionability ceiling.** Findings 15/16 — surviving mutants are not self-evidently actionable; incremental tooling exists but the runtime is real.
4. **The corpus can still be outrun.** Finding 29 — no corpus proves non-leakage. C9's generator + relations are mitigations, not proofs.

## Compensators

| Action | Irreversible? | Compensator | Post-rollback state | Owner |
|---|---|---|---|---|
| Commit this dispatch to the repo | Mostly reversible | `revert_dispatch_commit` — `git revert <sha>` | Doc removed; if propagated into a downstream design, requalify dependents | coordinator |
| Rewrite the gate + migrate every pin to declared tags | Reversible pre-merge | `git revert` the wave commit; branch is not merged to `main` | Gate returns to the `860ed73` lex-then-credit state (which still leaks — see finding 2) | coordinator |
| Dispatch N research subagents (Step 2, already spent) | Yes — tokens have no undo | `none` — bounded, owner-accepted cost (5 agents, 600-word cap) | Tokens spent | coordinator |
