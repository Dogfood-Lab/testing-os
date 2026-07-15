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
  { family: 'hermes', model: 'hermes3:8b', prism_family: 'local' },
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

/** prism's VerifyRequest.intent limit (pydantic `max_length=4000`). */
export const MAX_INTENT_CHARS = 4000;

/**
 * Env keys that would silently hijack a seat. Two distinct hazards, one fix:
 *
 *   1. Route hijack. For caller_family=anthropic prism routes GOOGLE → OPENAI → LOCAL,
 *      picking the first family with a registered provider. A stray GOOGLE_API_KEY in
 *      the ambient env therefore registers Google, wins the route ahead of LOCAL, and
 *      the "mistral seat" silently becomes gemini-2.5-pro.
 *   2. Spend. That hijack is also a PAID call, which breaks the free-by-default
 *      guarantee without a single log line.
 *
 * The specialist endpoints are here because build_default_engine PREPENDS them as the
 * primary verifier for every caller, which hijacks the seat the same way.
 *
 * This is not hypothetical: OPENROUTER_API_KEY is set on the rig this was built on.
 * Every seat's env is therefore built from a scrubbed base plus exactly that seat's
 * recipe — nothing ambient survives.
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
    if (/^PRISM_VERIFIER_MODEL_/.test(k)) continue; // a stale pin must not survive into another seat
    if (SCRUBBED_ENV_KEYS.includes(k)) continue;
    env[k] = v;
  }

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

  const fits = (parts) => [head, ...parts].join('\n').length <= MAX_INTENT_CHARS;
  const body = [];

  const evidenceList = Array.isArray(evidence) ? evidence : [];
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

  const outOfScope = Array.isArray(rubric.out_of_scope) ? rubric.out_of_scope : [];
  if (outOfScope.length > 0) {
    const line = `\nOUT OF SCOPE (do not flag): ${outOfScope.join('; ')}`;
    if (fits([...body, line])) body.push(line);
    else omitted.out_of_scope = outOfScope.length;
  }

  return { intent: [head, ...body].join('\n'), omitted };
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
