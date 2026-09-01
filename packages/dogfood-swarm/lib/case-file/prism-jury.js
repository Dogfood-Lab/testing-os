/**
 * case-file/prism-jury.js — the STRONGER jury tier: every seat is adjudicated by
 * prism-verify, which adds L3 (decorrelated multi-lens) and L4 (submodularity
 * collapse-refusal) WITHIN each seat.
 *
 * This is the second implementation of the `runJury` boundary ./adjudicate.js
 * injects, and it answers the gap ./ollama-jury.js documents in its own header: the
 * local tier gives diversity ACROSS seats but each seat renders one judgment, so
 * there are no decorrelated lenses WITHIN a seat. Here each seat's answer is
 * prism's four-lens verdict, aggregated by the same `normalizeAdjudication`.
 *
 * What this tier does and does NOT guarantee (per the case-file-contract boundary
 * discipline — state the seams, don't paper over them):
 *   - L1 family-different: YES — twice over. buildJurySpec refuses a producer-family
 *     seat upstream, and prism independently excludes the caller family
 *     (caller_family=anthropic) from its own verifier selection.
 *   - L2 reasoning-stripped: YES — the case-file lint guarantees the brief carries no
 *     producer reasoning trace, and prism strips again (receipts record
 *     reasoning_visibility_mode=stripped).
 *   - L3 multi-lens / L4 submodularity: YES, per criterion — four lenses
 *     (contract_completeness / cross_boundary / invariant / groundedness), and a
 *     collapsed panel is refused rather than averaged (prism's LENS_COLLAPSE).
 *   - Out-of-brief findings: NO. prism's response has no per-criterion channel and its
 *     Finding is free text ({file,line,category,evidence,severity}), so its findings
 *     are scoped to the criterion-intent that produced them. Classifying those as
 *     "out of brief" would be invention, and would double-count the same finding once
 *     per criterion. They are preserved verbatim in each verdict's `prism` detail for
 *     a human, and never fed to the aggregator. The local tier ASKS for out-of-brief
 *     explicitly and this tier cannot — a real trade, documented, not hidden.
 *
 * Cost + budget reality (measured on-rig, not estimated): prism's Budget caps
 * max_latency_ms at 30_000 by construction, and one warm mistral-small:24b call runs
 * ~27s for its four-lens fan-out. Seats therefore need to FIT that ceiling; a seat
 * that overruns returns BUDGET_EXCEEDED and abstains. This tier is slower and abstains
 * more than the local tier by design — it buys per-criterion L3/L4 with wall clock.
 *
 * The pure pieces (buildCriterionIntent, buildSeatEnv, buildPrismRequest,
 * mapVerdictToAnswer, parsePrismVerdict) are unit-tested; the live subprocess boundary
 * is exercised by the manual on-rig smoke (scripts/case-file-prism-smoke.mjs), never
 * by CI (CI has no prism and no Ollama).
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CriterionIntentOverflowError } from '../errors.js';

/**
 * The default prism jury roster. All NON-Claude, all free-local, distinct lineages.
 *
 * `prism_family` is the prism ModelFamily SLOT the seat occupies, which is NOT the
 * same thing as `family`: prism's OllamaProvider labels every local model `local`, so
 * all local seats share that slot and are told apart by the model id pinned into it.
 * `family` stays the swarm's own lineage label — it is what buildJurySpec's Lock-1
 * check and the panel's cross-seat diversity are expressed in.
 *
 * Roster selection is budget-driven: prism caps a call at 30s (see the header), so
 * seats are chosen to fit that ceiling rather than for raw size. Larger local models
 * (granite4.1:30b, gemma4:31b) overrun it and abstain, which is why the local tier's
 * roster is not copied wholesale.
 */
export const PRISM_JURY_SEATS = [
  { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
  { family: 'qwen', model: 'qwen2.5:7b', prism_family: 'local' },
  { family: 'llama', model: 'llama3.1:8b', prism_family: 'local' },
];

/**
 * The paid cloud seat (F-14 recipe): gpt-oss served over Ollama's OpenAI-compatible
 * endpoint, occupying prism's `openai` slot so it is a genuinely distinct prism family
 * from the local seats. Opt-in — `swarm adjudicate --jury=prism --cloud`.
 */
export const PRISM_CLOUD_SEATS = [
  ...PRISM_JURY_SEATS,
  { family: 'openai', model: 'gpt-oss:120b-cloud', prism_family: 'openai', base_url: 'http://localhost:11434' },
];

/** prism's Budget.max_latency_ms upper bound (pydantic `le=30000`). Not a preference. */
export const MAX_PRISM_LATENCY_MS = 30_000;

/**
 * prism's VerifyRequest.intent limit (pydantic `max_length=4000`).
 *
 * WHAT THIS BUDGET ACTUALLY BUYS — measured on the real wave-2 case-file
 * (swarms/swarm-1784091637-5127/wave-2/case-file.json), not derived:
 *
 *   head (objective + criterion + boilerplate)   ~1322 chars
 *   out_of_scope floor                            1093 chars
 *   ------------------------------------------------------
 *   mandatory before any evidence                 2415  (60% of the cap)
 *   left for evidence                             1585  (~5 claims @ 302 avg)
 *
 * So the working headroom is roughly FIVE evidence claims per criterion. That
 * is why claims are scoped per-criterion (`context[].criterion_ids`) rather
 * than every claim competing for one shared cap: budgeting does not raise this
 * ceiling, it stops wasting it. A criterion that genuinely needs 8 claims still
 * starves, and `brief_omitted` on the receipt is what says so — after the run,
 * not before.
 *
 * Anyone widening the objective, the criterion text, or the out-of-scope floor
 * is spending the EVIDENCE budget to do it, and the trade is silent: the intent
 * still assembles, it just carries fewer grounding claims. The numbers above
 * are the measurement, not an estimate — re-measure before assuming headroom.
 */
export const MAX_INTENT_CHARS = 4000;

/**
 * Ambient env keys that survive into every seat's process env, independent of that
 * seat's own recipe below — an ALLOWLIST (F-da670b34), not a denylist.
 *
 * The module docstring above already promises "nothing ambient survives" except a
 * seat's own recipe; the prior implementation enforced that with a fixed six-name
 * denylist plus one regex, which is permission-BY-EXCEPTION — everything not named
 * survives, so prism's env surface grows around the list for free. Verified against
 * prism-verify's own src/ (2026-07-15): PRISM_RHO_MAX overrides the L4 submodularity
 * cutoff (core/submodularity.py, default 0.25) and PRISM_OLLAMA_BASE_URL redirects
 * every local seat's host — neither was on the old list, and an ambient
 * PRISM_RHO_MAX=1.0 silently disables L4 collapse-refusal, the prism tier's entire
 * reason to exist, while this module and docs/case-file-contract.md both claim L4 is
 * enforced. Saltzer & Schroeder 1975: base access decisions on permission, not
 * exclusion.
 *
 * Two distinct hazards motivate the underlying threat model (unchanged by the
 * allowlist inversion, restated here because it is still what "genuinely needs"
 * means below):
 *   1. Route hijack. For caller_family=anthropic prism routes GOOGLE → OPENAI → LOCAL,
 *      picking the first family with a registered provider. A stray GOOGLE_API_KEY in
 *      the ambient env therefore registers Google, wins the route ahead of LOCAL, and
 *      the "mistral seat" silently becomes gemini-2.5-pro. The specialist endpoints
 *      (PRISM_LOCAL_VERIFIER_ENDPOINT / PRISM_SYCOPHANCY_ENDPOINT) hijack the same way
 *      because build_default_engine PREPENDS them as the primary verifier for every
 *      caller.
 *   2. Spend. That hijack is also a PAID call, which breaks the free-by-default
 *      guarantee without a single log line. Not hypothetical: OPENROUTER_API_KEY is
 *      set on the rig this was built on.
 *
 * The admission test is NOT "can this hijack a route or spend money?" — it is "can an
 * ambient value of this silently weaken what the jury GUARANTEES?" PRISM_RHO_MAX is the
 * reason: it hijacks nothing and spends nothing, it just quietly turns L4 off. Two
 * disjoint categories pass that test, nothing else:
 *   - subprocess plumbing a spawned python interpreter needs to start and run at all
 *     (interpreter/module resolution, temp dir, locale). None of these can select a
 *     model, a provider, or an endpoint, nor alter a verification threshold.
 *   - PRISM_SIGNING_KEY / PRISM_SIGNING_SECRET: prism's real receipt-signing key
 *     MATERIAL (receipts/signing.py's resolver, verified at :203-211). Read directly
 *     from THIS process's os.environ with no other source — buildSeatEnv sets nothing
 *     that could stand in for them, so omitting both fails every seat closed with a
 *     SigningSecretError -> shim abstain. Operator-level, identical for every seat, and
 *     orthogonal to routing.
 *
 * PRISM_DEV is deliberately NOT admitted, and must not be re-added as "the third part of
 * the signing identity" — it reads like one and is not one. It is not key material; it is
 * a POLICY TOGGLE that lowers the bar. signing.py:209 gates it on
 * `ed is None and mac is None`, so it fires ONLY when no real key is configured — exactly
 * the case that should fail loudly. Admitting it has precisely one reachable effect: an
 * operator with an ambient PRISM_DEV=1 and no signing key gets seats that sign with
 * `Ed25519Backend.dev()`, whose seed is a literal in prism's open source
 * (`_DEV_ED25519_SEED`, signing.py:35) and is therefore forgeable by anyone — and the
 * receipt still VERIFIES, so the jury's evidence looks legitimate while being worthless.
 * signing.py:34 states the resolver "refuses it in production"; docs/case-file-contract.md
 * makes "prism's signed Ed25519 receipt per call" the jury's evidence. We are production
 * for that purpose. Scrubbing it converts a silent downgrade into an honest abstain whose
 * error text names the fix (prism's own SigningSecretError tells the operator to run
 * `prism keygen` and set PRISM_SIGNING_KEY). An operator who genuinely wants dev mode
 * configures a real key; there is no ambient path to a forgeable one.
 *
 * Nothing PRISM_VERIFIER_MODEL_* or provider-key-shaped is on this list, and none
 * should ever be added: every seat's own routing pin is set unconditionally below,
 * from `seat.model` — never from ambient — so admitting it here would only be a
 * vector for a same-named pin meant for a DIFFERENT ModelFamily to leak between
 * seats, with no corresponding benefit. (prism's resolve_routing_map reads
 * `PRISM_VERIFIER_MODEL_{family.name}` for every member of its ModelFamily enum —
 * ANTHROPIC/OPENAI/GOOGLE/LOCAL/LOCAL_VERIFIER/LOCAL_SYCOPHANCY/OPENROUTER, verified
 * against core/types.py and core/routing.py:169 — not just the names anyone has
 * grepped for; excluding the whole PRISM_VERIFIER_MODEL_* shape from ambient
 * sidesteps needing to enumerate that list at all, and stays correct if prism adds an
 * eighth family tomorrow.)
 */
const AMBIENT_PASSTHROUGH_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP',
  // PYTHONIOENCODING is deliberately NOT here: buildSeatEnv SETS it below.
  // Passing it through was worse than useless — it let an ambient value
  // override the encoding the shim requires, while doing nothing at all in the
  // (actual) case where it was simply unset.
  'PYTHONPATH',
  'LANG', 'LC_ALL',
  'PRISM_SIGNING_KEY', 'PRISM_SIGNING_SECRET',
]);

/**
 * Retained ONLY for external-consumer backward compatibility (a sibling test
 * module imports it) — buildSeatEnv no longer consults this list. The real
 * enforcement is AMBIENT_PASSTHROUGH_KEYS above: a denylist can only ever name
 * the vars someone already thought of (that was the whole defect this module's
 * F-da670b34 fix closed), so this constant is not where a reader should look
 * to understand what survives into a seat's env. Do not add new entries here;
 * add genuinely-needed plumbing to AMBIENT_PASSTHROUGH_KEYS instead.
 */
export const SCRUBBED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'PRISM_LOCAL_VERIFIER_ENDPOINT',
  'PRISM_SYCOPHANCY_ENDPOINT',
];

/**
 * prism verdict → the swarm's per-criterion answer.
 *
 * `revise` maps to fail because the intent IS the single criterion: "fixable issues
 * against this criterion" means the criterion is not met. `escalate` is prism routing
 * to a human, which is an abstention, not a fail. Exported so the mapping is pinned by
 * a test and cannot drift silently (PIN_PER_STEP).
 */
export const PRISM_VERDICT_TO_ANSWER = Object.freeze({
  accept: 'pass',
  refuse: 'fail',
  revise: 'fail',
  escalate: 'insufficient_context',
});

/** Unknown/absent verdicts abstain — garbage never mints a pass. */
export function mapVerdictToAnswer(verdict) {
  return PRISM_VERDICT_TO_ANSWER[verdict] ?? 'insufficient_context';
}

const DEFAULT_CALLER_FAMILY = 'anthropic';
const DEFAULT_CALLER_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/**
 * Build ONE seat's process env: a scrubbed base plus that seat's recipe.
 *
 * @param {{family: string, model: string, prism_family?: string, base_url?: string}} seat
 * @param {Record<string,string|undefined>} [baseEnv]
 * @returns {Record<string,string>}
 */
export function buildSeatEnv(seat, baseEnv = {}) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    // Case-insensitive membership check (Windows env var casing is inconsistent
    // across shells — cmd/PowerShell-launched processes commonly hand Node
    // `Path`/`SystemRoot`, git-bash normalizes to `PATH`/`SYSTEMROOT`) but the
    // ORIGINAL key is preserved on write: Windows env lookups are case-insensitive
    // downstream (CreateProcess, Python's os.environ on nt), so preserving
    // whatever casing the OS handed us is safe and avoids inventing a second,
    // possibly-conflicting spelling of the same variable.
    if (!AMBIENT_PASSTHROUGH_KEYS.has(k.toUpperCase())) continue;
    env[k] = v;
  }

  // Force the shim's I/O encoding rather than inheriting the platform locale.
  // Defense in depth only — prism_seat.py reads sys.stdin.buffer (bytes) and
  // cannot be affected by this — but it also covers any other Python-side text
  // I/O that might later be added to the seat process.
  //
  // Worth naming, because it is the allowlist's own documented failure mode
  // arriving from an unexpected direction: PYTHONIOENCODING was ALREADY an
  // AMBIENT_PASSTHROUGH_KEYS entry, and that entry did exactly nothing. An
  // allowlist forwards a var that is set; this one was never set at all
  // (undefined on the rig), and "absent" is precisely the state a
  // pass-through cannot distinguish from "not needed". The seat env is a
  // RECIPE, not a filter — anything the seat genuinely requires has to be SET
  // here, the same way each seat's model pin is.
  env.PYTHONIOENCODING = 'utf-8';

  const prismFamily = (seat.prism_family || 'local').toLowerCase();
  env[`PRISM_VERIFIER_MODEL_${prismFamily.toUpperCase()}`] = seat.model;

  if (prismFamily === 'openai') {
    // The auth stub Ollama's OpenAI-compatible endpoint accepts; it is not a real key.
    env.OPENAI_API_KEY = 'ollama';
    env.PRISM_OPENAI_BASE_URL = seat.base_url || DEFAULT_OLLAMA_BASE_URL;
  } else if (seat.base_url) {
    env.PRISM_OLLAMA_BASE_URL = seat.base_url;
  }
  return env;
}

/**
 * Build the prism `intent` for ONE criterion — the heart of the per-(seat × criterion)
 * design. prism judges artifact-against-intent, so making the intent a single
 * criterion is what turns prism's one-verdict-per-artifact contract into a
 * per-criterion answer the panel aggregator can fuse.
 *
 * Assembly is priority-ordered against the 4000-char ceiling: the objective and the
 * criterion are mandatory, then evidence (the RAG-style grounding prism's Groundedness
 * lens weights), then out-of-scope. Anything that does not fit is REPORTED, not
 * silently dropped — a truncated brief that reads as complete is how a jury gets
 * quietly under-informed.
 *
 * @param {{id: string, check: string}} criterion
 * @param {object} payload — spec.payload from buildJurySpec
 * @returns {{ intent: string, omitted: { evidence: number, out_of_scope: number } }}
 */
export function buildCriterionIntent(criterion, payload) {
  const { rubric, evidence } = payload;
  const omitted = { evidence: 0, out_of_scope: 0 };

  const head = [
    `OBJECTIVE: ${rubric.objective}`,
    '',
    `ACCEPTANCE CRITERION UNDER TEST (${criterion.id}): ${criterion.check}`,
    '',
    'The artifact must satisfy the single criterion above. Any other criterion is out of scope for this check.',
  ].join('\n');

  // The out-of-scope block is MANDATORY, not optional (sm-oos-001). It is the
  // list of things the jury must NOT flag — the contract calls it "a floor on
  // scrutiny, not a ceiling" — so it is the one field that PREVENTS false
  // failures, and it is ~6 short lines against an evidence pack that is the
  // real bulk.
  //
  // It used to be assembled LAST and was therefore the FIRST thing the cap
  // sacrificed: measured against the real wave-2 case-file (15 evidence claims
  // / 6 out-of-scope / 10 criteria) every single criterion delivered 9/15
  // evidence and 0/6 out-of-scope — the floor was dropped 10 times out of 10.
  // The panel then flagged out-of-brief concerns as criterion failures: given
  // the whole brief the local tier never once failed the work (pass 2 / fail 0),
  // given the same brief minus the floor the prism tier failed it 2–3 times.
  // That was our assembly order, not the models.
  const outOfScope = Array.isArray(rubric.out_of_scope) ? rubric.out_of_scope : [];
  const outOfScopeLine = outOfScope.length > 0
    ? `\nOUT OF SCOPE (do not flag): ${outOfScope.join('; ')}`
    : null;
  const mandatory = outOfScopeLine ? [head, outOfScopeLine] : [head];

  // Measure the MANDATORY section before spending the budget on optional ones
  // (F-ca495e53) — fits() below only ever measured head plus optional parts, so
  // the mandatory cost was one the budget was spent against but never checked.
  // An over-cap mandatory section must fail loud here, not return truncated as
  // `omitted: {0,0}` (which reads as complete) and let prism's own 4000-char
  // pydantic ceiling reject it uniformly on every seat. The guard covers the
  // FLOOR too, now that the floor is mandatory.
  const mandatoryLength = mandatory.join('\n').length;
  if (mandatoryLength > MAX_INTENT_CHARS) {
    throw new CriterionIntentOverflowError(
      `rubric.objective + criterion '${criterion.id}' + out_of_scope exceed prism's ${MAX_INTENT_CHARS}-char ` +
      `intent cap by ${mandatoryLength - MAX_INTENT_CHARS} chars — shorten the objective, split the criterion, ` +
      `or trim the out-of-scope list`,
      { criterionId: criterion.id, headLength: mandatoryLength, maxChars: MAX_INTENT_CHARS },
    );
  }

  // Evidence fills only what the mandatory floor leaves. The floor's cost is in
  // every fit check, so evidence can never crowd it out — but the floor is
  // still EMITTED last, preserving the documented head → evidence →
  // out_of_scope order a reader (and the jury) expects.
  const fits = (parts) =>
    [head, ...parts, ...(outOfScopeLine ? [outOfScopeLine] : [])].join('\n').length <= MAX_INTENT_CHARS;
  const body = [];

  // Per-criterion evidence budgeting (sm-oos-003). The clerk's context[] is
  // GLOBAL, so all 15 claims used to be assembled into all 10 criteria and the
  // cap then discarded two thirds of them indiscriminately — receipt
  // adjudications/wave-2-85bf3172.json records `brief_omitted:
  // {"evidence":10,"out_of_scope":0}` on EVERY criterion: the floor restored
  // and still 10 of 15 claims starved, all 10 criteria contested. Most of those
  // claims were never relevant to the criterion that dropped them
  // (`AC-yaml-merge-inert` does not need the seat-env allowlist's evidence), so
  // sending each criterion only what it grounds removes the starvation without
  // touching the cap.
  //
  // A claim with NO criterion_ids is GLOBAL — it grounds every criterion. That
  // is the backward-compatible default: every existing case-file (and
  // fixtures/case-files/valid/well-formed-auth-fix.json) keeps its exact
  // current behavior. The guard is `!Array.isArray(...)` rather than a
  // truthiness check so a null/undefined/malformed value degrades to global
  // rather than silently grounding nothing.
  //
  // `omitted.evidence` counts ONLY claims that were RELEVANT to this criterion
  // and still did not fit. A claim filtered out as irrelevant was never owed
  // here, and counting it would make brief_omitted over-report — turning the
  // receipt back into noise in the opposite direction.
  const evidenceList = (Array.isArray(evidence) ? evidence : [])
    .filter(e => !Array.isArray(e.criterion_ids) || e.criterion_ids.includes(criterion.id));
  if (evidenceList.length > 0) {
    const section = ['', 'EVIDENCE (grounding facts; weight by source):'];
    if (fits([...body, ...section])) {
      body.push(...section);
      for (const e of evidenceList) {
        const line = `- [${e.source}] ${e.claim}${e.ref ? ` (${e.ref})` : ''}`;
        if (fits([...body, line])) body.push(line);
        else omitted.evidence += 1;
      }
    } else {
      omitted.evidence = evidenceList.length;
    }
  }

  const parts = [head, ...body];
  if (outOfScopeLine) parts.push(outOfScopeLine);
  return { intent: parts.join('\n'), omitted };
}

/**
 * Build the JSON request for one (seat × criterion) prism call.
 *
 * The caller family is the PRODUCER's family (Claude), which is what prism excludes
 * from its own verifier selection — this tier's second, independent L1 enforcement.
 *
 * @returns {{ request: object, omitted: object }}
 */
export function buildPrismRequest(criterion, payload, opts = {}) {
  const { intent, omitted } = buildCriterionIntent(criterion, payload);
  const artifact = payload.artifact || {};
  return {
    request: {
      artifact_type: opts.artifactType || 'code',
      // A criterion cannot be judged against nothing; an empty artifact must reach
      // prism as an explicit absence rather than a validation error that reads as a
      // verifier fault.
      content: artifact.content || '(no inline content provided)',
      intent,
      caller_family: opts.callerFamily || DEFAULT_CALLER_FAMILY,
      caller_model: opts.callerModel || DEFAULT_CALLER_MODEL,
      max_latency_ms: Math.min(opts.maxLatencyMs ?? MAX_PRISM_LATENCY_MS, MAX_PRISM_LATENCY_MS),
    },
    omitted,
  };
}

/**
 * Parse one prism response (the shape `prism verify` prints) into a per-criterion
 * answer plus the L3/L4 signals worth keeping on the receipt.
 *
 * Robust to stray output around the JSON for the same reason the local tier's parser
 * is: this is where an external process's bytes become swarm data, and it must never
 * mint a `pass` from garbage or silence.
 *
 * @param {string} text — raw stdout
 * @returns {{ answer: string, verdict: string|null, confidence: number|null, rho_max: number|null, lenses: number, findings: Array<object>, error: string|null }}
 */
export function parsePrismVerdict(text) {
  const empty = {
    answer: 'insufficient_context',
    verdict: null,
    confidence: null,
    rho_max: null,
    lenses: 0,
    findings: [],
    error: null,
  };

  let parsed = null;
  if (typeof text === 'string') {
    const span = text.match(/\{[\s\S]*\}/);
    if (span) {
      try { parsed = JSON.parse(span[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ...empty, error: 'unparseable prism response' };
  }

  // A prism refusal (BUDGET_EXCEEDED, LENS_COLLAPSE, VERIFIER_UNAVAILABLE, …) is a
  // seat that did not judge. That abstains — including LENS_COLLAPSE, which is L4
  // firing: a collapsed panel has no independent signal to report.
  if (parsed.error) {
    const reason = parsed.error.reason || 'unknown';
    const detail = parsed.error.detail ? `: ${parsed.error.detail}` : '';
    return { ...empty, error: `${reason}${detail}` };
  }

  const lensResults = Array.isArray(parsed.lens_results) ? parsed.lens_results : [];
  const rhoValues = Object.values(parsed.pairwise_rho || {}).filter(v => typeof v === 'number');
  const findings = lensResults.flatMap(lr => (Array.isArray(lr.findings) ? lr.findings : []));

  return {
    answer: mapVerdictToAnswer(parsed.verdict),
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict : null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    rho_max: rhoValues.length ? Math.max(...rhoValues) : null,
    lenses: lensResults.length,
    findings,
    error: null,
  };
}

/** Resolve the shim that ships beside this module. */
function defaultShimPath() {
  return fileURLToPath(new URL('./prism_seat.py', import.meta.url));
}

/** Spawn one seat's prism call, feeding the request on stdin. */
function defaultRunSeat({ python, shim, timeoutMs }) {
  return (env, request) => new Promise((resolve) => {
    const child = execFile(
      python,
      [shim],
      // prism receipts make responses large; the default 1MB maxBuffer would truncate
      // a valid verdict into a parse failure that reads as a model fault.
      { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve(JSON.stringify({
            error: { reason: 'VERIFIER_UNAVAILABLE', detail: String(stderr || err.message || err).trim().slice(0, 500) },
          }));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * Build a live `runJury(spec)` boundary backed by prism-verify, one call per
 * (seat × criterion).
 *
 * Seats run SEAT-MAJOR — every criterion for one seat before moving to the next.
 * Ollama serves one model at a time and swaps weights per model, so seat-major pays
 * one weight-load per seat instead of one per call: the same swap cost as a per-seat
 * design, with only the extra inference on top.
 *
 * The seat roster is NOT an option here — it is read from `spec.seats` (set by
 * buildJurySpec at the adjudicate() call), so there is one source of truth for who
 * sits on the jury. Choose the roster via adjudicate(cf, { seats }).
 *
 * @param {object} [opts]
 * @param {string} [opts.python] — interpreter (PRISM_PYTHON overrides; a full path avoids the Windows PATHEXT trap)
 * @param {string} [opts.shim] — path to prism_seat.py
 * @param {number} [opts.maxLatencyMs] — prism's own budget, clamped to MAX_PRISM_LATENCY_MS
 * @param {number} [opts.timeoutMs] — process-level guard; must exceed prism's budget so prism reports BUDGET_EXCEEDED itself
 * @param {(env: object, request: object) => Promise<string>} [opts.runSeat] — injected for tests
 * @param {(msg: string) => void} [opts.log]
 * @returns {(spec: object) => Promise<Array<object>>}
 */
export function makePrismJury(opts = {}) {
  const python = opts.python || process.env.PRISM_PYTHON || 'python';
  const shim = opts.shim || defaultShimPath();
  const maxLatencyMs = Math.min(opts.maxLatencyMs ?? MAX_PRISM_LATENCY_MS, MAX_PRISM_LATENCY_MS);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const log = opts.log || (() => {});
  const runSeat = opts.runSeat || defaultRunSeat({ python, shim, timeoutMs });

  return async function runJury(spec) {
    const { rubric } = spec.payload;
    const criteria = rubric.acceptance_criteria;
    const verdicts = [];

    for (const seat of spec.seats) {
      const env = buildSeatEnv(seat, process.env);
      const answers = {};
      const detail = [];

      for (const criterion of criteria) {
        const started = Date.now();
        log(`juror ${seat.family} (${seat.model}) — ${criterion.id}…`);
        const { request, omitted } = buildPrismRequest(criterion, spec.payload, {
          callerFamily: opts.callerFamily,
          callerModel: opts.callerModel,
          maxLatencyMs,
        });
        if (omitted.evidence || omitted.out_of_scope) {
          log(`  ! ${criterion.id}: brief trimmed to prism's ${MAX_INTENT_CHARS}-char intent cap — ${omitted.evidence} evidence claim(s), ${omitted.out_of_scope} out-of-scope entr(y/ies) omitted`);
        }

        const raw = await runSeat(env, request);
        const parsed = parsePrismVerdict(raw);
        answers[criterion.id] = parsed.answer;
        detail.push({ criterion: criterion.id, ...parsed, omitted });

        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (parsed.error) log(`  · ${criterion.id} — ABSTAIN (${parsed.error}) in ${secs}s`);
        else log(`  · ${criterion.id} — ${parsed.verdict} → ${parsed.answer} (rho_max ${parsed.rho_max ?? 'n/a'}, ${parsed.lenses} lenses) in ${secs}s`);
      }

      verdicts.push({
        seat: seat.family,
        model: seat.model,
        criteria: answers,
        // See the header: prism's findings are criterion-scoped, so promoting them to
        // panel-level out-of-brief signal would be invention. They stay in `prism`.
        out_of_brief: [],
        prism: { tier: 'prism-per-seat', prism_family: seat.prism_family || 'local', criteria: detail },
      });
    }
    return verdicts;
  };
}
