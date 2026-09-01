/**
 * case-file/ollama-jury.js — a LOCAL, cross-family, zero-cost jury boundary.
 *
 * This is one implementation of the `runJury` boundary that ./adjudicate.js
 * injects: given the jury spec, it asks each seat — a local non-Claude Ollama
 * model — to judge the case-file's criteria and returns one verdict per juror.
 * `normalizeAdjudication` then fuses them.
 *
 * Why local models: the whole generation crew is Claude-family, so any
 * non-Claude seat is family-different from the artifact's producer (Lock 1,
 * enforced upstream in buildJurySpec). The rig serves several distinct lineages
 * (Mistral / Qwen / Hermes) at ~7-24B for free, so a family-diverse panel runs at
 * zero API cost.
 *
 * What this tier does and does NOT guarantee (stated honestly, per the
 * case-file-contract boundary discipline):
 *   - L1 family-different: YES — the default roster is all non-Claude, and
 *     buildJurySpec refuses a producer-family seat.
 *   - L2 reasoning-stripped: YES — the case-file lint already guarantees the
 *     brief carries no producer reasoning trace before it reaches here.
 *   - L3 multi-lens ≥3 / L4 submodularity: NO — each seat renders ONE judgment
 *     over the criteria, not prism's decorrelated multi-lens with a
 *     collapse-refusal. The panel gets diversity ACROSS seats, not decorrelated
 *     lenses WITHIN a seat. The stronger tier is prism-verify per seat (adds
 *     L3/L4); it plugs into the same runJury boundary and is the documented
 *     next adapter. This tier is "family-diverse panel", not "the full four-lock
 *     jury".
 *
 * The pure pieces (buildJurorPrompt, parseJurorResponse) are unit-tested; the
 * live HTTP boundary (makeOllamaJury) is exercised by the manual on-rig smoke
 * (scripts/case-file-adjudicate-smoke.mjs), never by the always-green CI suite
 * (CI has no Ollama).
 */

import { JUROR_ANSWERS } from './adjudicate.js';

/**
 * A free, LOCAL, family-diverse jury roster — every model verified present and
 * runnable on the rig (no `:cloud` seats, so zero API cost), all NON-Claude, five
 * distinct lineages. qwen2.5:7b is chosen over qwen3.x deliberately: a thinking
 * model spends a bounded budget on hidden reasoning and can return empty JSON
 * (the prism `qwen3:32b` trap), and the 7B is fast.
 *
 * Pass this as adjudicate(caseFile, { runJury, seats: LOCAL_JURY_SEATS }) — the
 * roster is a property of the jury SPEC (buildJurySpec), so it is chosen at the
 * adjudicate() call, not here. adjudicate's own DEFAULT_JURY_SEATS includes the
 * gpt-oss / glm `:cloud` seats (the strongest cross-family seats but not free);
 * this constant is the explicit free-local opt-in.
 *
 * F-efe53969: DEFAULT_JURY_SEATS's non-cloud seats must stay in lockstep with
 * this list (same families, same model pins — including this qwen2.5:7b
 * choice, since the "thinking model" trap this comment describes applies to
 * the paid --cloud tier too). ./adjudicate.js cannot import this constant
 * directly (this file already imports FROM adjudicate.js, so the reverse
 * edge would cycle) — keep the two rosters synchronized by hand;
 * case-file-jury-seats-parity.test.js pins the relationship.
 */
export const LOCAL_JURY_SEATS = [
  { family: 'mistral', model: 'mistral-small:24b' },
  { family: 'granite', model: 'granite4.1:30b' },
  { family: 'qwen', model: 'qwen2.5:7b' },
  { family: 'gemma', model: 'gemma4:31b' },
  // 2026-09-01: hermes3:8b (a llama-family finetune) was removed from the rig;
  // the fifth seat is re-pinned to llama3.1:8b so the panel keeps five families.
  { family: 'llama', model: 'llama3.1:8b' },
];

const DEFAULT_BASE_URL = 'http://localhost:11434';

/** Ollama num_predict cap per seat — also the guard's output reserve: the
 * context window must hold prompt + response, so the fit comparison is
 * estimated prompt tokens ≤ context − DEFAULT_NUM_PREDICT (or the caller's
 * numPredict override, which the reserve follows). */
export const DEFAULT_NUM_PREDICT = 512;

/**
 * The effective context window assumed for a seat when nothing observable pins
 * it. Observed in run swarm-1784601601-bd4a wave 5 (ai-rpg-engine): a 252KB
 * case-file (≈216K-char diff) was dispatched to all five seats, every seat
 * returned insufficient_context on all 14 criteria in seconds — the server
 * silently truncated the prompt to the EFFECTIVE window (the applied num_ctx),
 * which is NOT the trained `context_length` /api/show reports (32K–262K for
 * this roster) and is NOT queryable for an unloaded model (`OLLAMA_CONTEXT_LENGTH`
 * is server-side env). 32768 is the measured effective window on the pinned rig
 * (Ollama 0.30.10, /api/ps `context_length` for the loaded seats, no Modelfile
 * num_ctx anywhere in the roster). When this assumption is what bounded a seat,
 * its `context_source` says so ('…assumed-default') — the receipt never passes
 * an assumption off as a measurement. Override via makeOllamaJury's
 * `assumedNumCtx` if your server runs a different OLLAMA_CONTEXT_LENGTH.
 */
export const DEFAULT_ASSUMED_NUM_CTX = 32768;

/**
 * Trained context ceilings for the pinned rosters, measured 2026-07-21 via
 * /api/show `model_info["<arch>.context_length"]`. FALLBACK ONLY — used when
 * the live /api/show read fails. These are the models' trained maxima, NOT
 * effective windows: the effective window is min(trained, applied num_ctx),
 * so every fallback resolution is still capped by the assumed default above.
 * Maintained in lockstep with LOCAL_JURY_SEATS / DEFAULT_JURY_SEATS (add a
 * row when a seat is re-pinned). glm-4.6:cloud is deliberately absent — the
 * upstream model was retired 2026-06-16 and /api/show errors on it; an
 * unlisted model resolves to the assumed default alone (conservative).
 */
export const FALLBACK_SEAT_CONTEXTS = {
  'mistral-small:24b': 32768,
  'granite4.1:30b': 131072,
  'qwen2.5:7b': 32768,
  'gemma4:31b': 262144,
  'llama3.1:8b': 131072,
  'gpt-oss:120b-cloud': 131072,
};

/**
 * The token estimator label stamped on every measurement surface (error,
 * receipt). chars/4 is a HEURISTIC — diffs and code often tokenize denser
 * (~3–3.5 chars/token), so it can under-estimate; the guard exists to catch
 * order-of-magnitude overflow (the observed failure was ~15× over budget),
 * and the label tells every downstream reader exactly how the number was
 * made. No tokenizer dependency on purpose: this package ships none, and a
 * real tokenizer would be per-model anyway (five lineages, five vocabularies).
 */
export const PROMPT_TOKEN_ESTIMATOR = 'chars/4-heuristic';

/** @param {number} chars @returns {number} estimated tokens (see PROMPT_TOKEN_ESTIMATOR) */
export function estimateTokensFromChars(chars) {
  return Math.ceil(chars / 4);
}

/**
 * Measure the rendered per-seat prompt BEFORE dispatch. Pure. The system +
 * user strings are exactly what makeOllamaJury sends to /api/chat, so this is
 * the honest size of what a seat is asked to read (the JSON envelope and chat
 * template add a small model-specific overhead the estimator's label already
 * disclaims precision on).
 *
 * @param {{ system: string, user: string }} rendered — buildJurorPrompt output
 * @returns {{ chars: number, estimated_tokens: number, estimator: string }}
 */
export function measureRenderedPrompt({ system, user }) {
  const chars = String(system ?? '').length + String(user ?? '').length;
  return { chars, estimated_tokens: estimateTokensFromChars(chars), estimator: PROMPT_TOKEN_ESTIMATOR };
}

/** Fallback-path resolution for one model (also the floor when a custom
 * resolver omits a seat): trained ceiling from the table if known, always
 * capped by the assumed default — never more optimistic than the assumption. */
function resolveFromFallback(model, assumedNumCtx) {
  const trained = FALLBACK_SEAT_CONTEXTS[model];
  return Number.isFinite(trained)
    ? { context_tokens: Math.min(trained, assumedNumCtx), source: 'fallback-table+assumed-default' }
    : { context_tokens: assumedNumCtx, source: 'assumed-default' };
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve each seat's EFFECTIVE context window against a live Ollama server.
 * Best-observable-truth first, honesty-labeled always (`source` on every
 * entry — a receipt reader can tell a measurement from an assumption):
 *
 *   1. /api/ps `context_length` — the actual runtime window of a currently
 *      LOADED instance. The only surface that reports the applied num_ctx
 *      directly; the wave-5 failure is invisible to /api/show alone.
 *   2. /api/show Modelfile `num_ctx` — authoritative when a model pins it
 *      (none of the pinned roster does today), capped by the trained ceiling.
 *   3. /api/show trained `context_length`, capped by the assumed default —
 *      the trained max is an upper bound, not the effective window.
 *   4. FALLBACK_SEAT_CONTEXTS (∧ assumed default) when /api/show fails, or
 *      the assumed default alone for an unknown model.
 *
 * Metadata reads only — /api/ps and /api/show never load model weights, so
 * resolution cannot disturb a busy server. Total per call: never throws; a
 * dead server degrades every seat to tier 4 with the source saying so.
 *
 * @param {Array<{family: string, model: string}>} seats
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.assumedNumCtx]
 * @param {number} [opts.timeoutMs] — per metadata call (default 10s)
 * @returns {Promise<Record<string, { context_tokens: number, source: string }>>} keyed by model
 */
export async function resolveSeatContextsViaOllama(seats, opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl || fetch;
  const assumedNumCtx = opts.assumedNumCtx ?? DEFAULT_ASSUMED_NUM_CTX;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let loaded = new Map();
  try {
    const ps = await fetchJson(fetchImpl, `${baseUrl}/api/ps`, { method: 'GET' }, timeoutMs);
    for (const m of ps?.models || []) {
      if (Number.isFinite(m?.context_length)) loaded.set(m.model || m.name, m.context_length);
    }
  } catch {
    // /api/ps is an accuracy upgrade, not a requirement — fall through to /api/show.
  }

  const resolved = {};
  for (const seat of seats) {
    if (loaded.has(seat.model)) {
      resolved[seat.model] = { context_tokens: loaded.get(seat.model), source: 'api-ps-loaded' };
      continue;
    }
    try {
      const show = await fetchJson(fetchImpl, `${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: seat.model }),
      }, timeoutMs);
      if (show?.error) throw new Error(String(show.error));
      const info = show?.model_info || {};
      const trainedKey = Object.keys(info).find(k => k.endsWith('.context_length'));
      const trained = trainedKey && Number.isFinite(info[trainedKey]) ? info[trainedKey] : undefined;
      const numCtxLine = String(show?.parameters || '').match(/^num_ctx\s+(\d+)/m);
      const pinned = numCtxLine ? Number(numCtxLine[1]) : undefined;
      if (Number.isFinite(pinned)) {
        resolved[seat.model] = {
          context_tokens: Math.min(pinned, trained ?? pinned),
          source: 'api-show-num-ctx',
        };
      } else if (Number.isFinite(trained)) {
        resolved[seat.model] = {
          context_tokens: Math.min(trained, assumedNumCtx),
          source: 'api-show+assumed-default',
        };
      } else {
        resolved[seat.model] = resolveFromFallback(seat.model, assumedNumCtx);
      }
    } catch {
      resolved[seat.model] = resolveFromFallback(seat.model, assumedNumCtx);
    }
  }
  return resolved;
}

/**
 * Compare the measured brief against each seat's resolved context. Pure.
 * Budget per seat = context − outputReserveTokens (the num_predict the
 * dispatch will request — the window must hold prompt AND response).
 *
 * @param {{ chars: number, estimated_tokens: number, estimator: string }} measurement
 * @param {Array<{family: string, model: string}>} seats
 * @param {Record<string, { context_tokens: number, source: string }>} contexts — keyed by model
 * @param {{ outputReserveTokens: number, assumedNumCtx?: number }} opts
 * @returns {Array<{ seat: string, model: string, context_tokens: number, context_source: string, budget_tokens: number, fits: boolean, overflow_tokens: number }>}
 */
export function assessSeatFit(measurement, seats, contexts, opts) {
  const { outputReserveTokens } = opts;
  const assumedNumCtx = opts.assumedNumCtx ?? DEFAULT_ASSUMED_NUM_CTX;
  return seats.map(seat => {
    // A resolver that omitted a seat degrades to the fallback floor rather
    // than skipping the seat — an unmeasured seat must never dispatch unchecked.
    const ctx = contexts[seat.model] || resolveFromFallback(seat.model, assumedNumCtx);
    const budget = ctx.context_tokens - outputReserveTokens;
    const overflow = Math.max(0, measurement.estimated_tokens - budget);
    return {
      seat: seat.family,
      model: seat.model,
      context_tokens: ctx.context_tokens,
      context_source: ctx.source,
      budget_tokens: budget,
      fits: overflow === 0,
      overflow_tokens: overflow,
    };
  });
}

/**
 * Thrown when the rendered brief exceeds any seat's context budget — BEFORE
 * any jury call. Fail-closed like CaseFileNeutralityError (handoff.js): a
 * brief the seats cannot read is never dispatched, because a silently
 * truncated prompt makes every seat judge a document it never saw and abstain
 * with zero operator signal (observed in run swarm-1784601601-bd4a wave 5,
 * ai-rpg-engine: 252KB case-file → insufficient_context on all 14 criteria
 * from all 5 seats, vs clean 4/0/1 verdicts on a 42K-char wave-1 brief).
 * A partial panel is refused too — dispatching only the seats that fit is the
 * roster-shrink failure the case-file contract already documents for prism.
 *
 * Module-local, not lib/errors.js, on the CaseFileNeutralityError precedent:
 * the adjudicate verb owns its error surface and renders this directly.
 *
 * @property {'JURY_BRIEF_OVERFLOW'} code
 * @property {{ chars: number, estimated_tokens: number, estimator: string }} measurement
 * @property {number} output_reserve_tokens
 * @property {Array<object>} seat_fit — the full per-seat fit map (assessSeatFit shape)
 * @property {string} hint
 */
export class JuryBriefOverflowError extends Error {
  constructor(measurement, seatFit, outputReserveTokens) {
    const overflowing = seatFit.filter(s => !s.fits);
    super(
      `jury brief overflow — rendered brief is ${measurement.chars} chars ` +
      `(≈${measurement.estimated_tokens} tokens, ${measurement.estimator}); ` +
      `${overflowing.length} of ${seatFit.length} seat(s) cannot read it: ` +
      overflowing.map(s => `${s.model} (ctx ${s.context_tokens} − reserve ${outputReserveTokens} = budget ${s.budget_tokens})`).join(', ') +
      '. Not dispatched.',
    );
    this.name = 'JuryBriefOverflowError';
    this.code = 'JURY_BRIEF_OVERFLOW';
    this.measurement = measurement;
    this.output_reserve_tokens = outputReserveTokens;
    this.seat_fit = seatFit;
    this.hint =
      'The seats would judge a silently-truncated prompt and abstain (or worse, guess). ' +
      'Split the case-file into slices the panel can read whole, or trim the artifact ' +
      'to the hunks the criteria actually judge. The guard refuses the whole panel even ' +
      'when some seats fit — a silently-shrunk panel is the roster-shrink failure the ' +
      'case-file contract documents. To dispatch anyway, re-run with --allow-oversize: ' +
      'the overflow is then stamped on the receipt (brief_size.all_fit: false) and the ' +
      'verdicts come from truncated reads.';
  }
}

/**
 * Build the juror prompt from the neutral jury spec's payload. Returns a system
 * + user message pair. The abstention rubric IS the payload.instruction — it
 * names insufficient_context as a first-class per-criterion answer, which is what
 * makes an under-calibrated local model abstain instead of hallucinating.
 *
 * @param {object} payload — spec.payload from buildJurySpec ({ artifact, rubric, evidence, instruction })
 * @returns {{ system: string, user: string, criterionIds: string[] }}
 */
export function buildJurorPrompt(payload) {
  const { artifact, rubric, evidence, instruction } = payload;
  const criterionIds = rubric.acceptance_criteria.map(c => c.id);

  const system =
    'You are an independent code-verification juror. ' +
    instruction +
    ' Respond with STRICT JSON only, no prose, in exactly this shape: ' +
    '{"criteria": {"<criterion-id>": "pass" | "fail" | "insufficient_context"}, "out_of_brief": ["<defect not covered by a criterion>"]}. ' +
    'Include every criterion id. Use "insufficient_context" for any criterion the brief does not let you judge.';

  const lines = [];
  lines.push(`OBJECTIVE: ${rubric.objective}`);
  lines.push('');
  lines.push(`ARTIFACT UNDER TEST (${artifact.kind}, ${artifact.ref}):`);
  lines.push(artifact.content ? artifact.content : '(no inline content — judge from the evidence and criteria)');
  lines.push('');
  lines.push('ACCEPTANCE CRITERIA (judge each; return its id):');
  for (const c of rubric.acceptance_criteria) lines.push(`- ${c.id}: ${c.check}`);
  lines.push('');
  if (Array.isArray(evidence) && evidence.length > 0) {
    lines.push('EVIDENCE (facts you may rely on; weight by source):');
    for (const e of evidence) lines.push(`- [${e.source}] ${e.claim}${e.ref ? ` (${e.ref})` : ''}`);
    lines.push('');
  }
  if (Array.isArray(rubric.out_of_scope) && rubric.out_of_scope.length > 0) {
    lines.push(`OUT OF SCOPE (do not flag): ${rubric.out_of_scope.join('; ')}`);
    lines.push('');
  }
  lines.push('Return the JSON verdict now.');

  return { system, user: lines.join('\n'), criterionIds };
}

/**
 * Parse a juror model's response into a per-criterion verdict map + out-of-brief
 * list. Robust to code fences and stray prose around the JSON. Any criterion the
 * model omitted or answered with a non-whitelisted value is normalized to
 * insufficient_context — silence or garbage never mints a pass.
 *
 * @param {string} text — the model's raw response
 * @param {string[]} criterionIds — the ids that must be present
 * @returns {{ criteria: Record<string,string>, out_of_brief: string[] }}
 */
export function parseJurorResponse(text, criterionIds) {
  const criteria = {};
  const outOfBrief = [];

  let parsed = null;
  if (typeof text === 'string') {
    // Prefer a fenced or bare JSON object; fall back to the first {...} span.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1] : text;
    const span = candidate.match(/\{[\s\S]*\}/);
    if (span) {
      try { parsed = JSON.parse(span[0]); } catch { parsed = null; }
    }
  }

  const answered = parsed && typeof parsed.criteria === 'object' && parsed.criteria ? parsed.criteria : {};
  for (const id of criterionIds) {
    const a = answered[id];
    criteria[id] = JUROR_ANSWERS.includes(a) ? a : 'insufficient_context';
  }
  if (parsed && Array.isArray(parsed.out_of_brief)) {
    for (const f of parsed.out_of_brief) {
      if (typeof f === 'string' && f.trim()) outOfBrief.push(f.trim());
    }
  }
  return { criteria, out_of_brief: outOfBrief };
}

/**
 * Build a live `runJury(spec)` boundary backed by local Ollama models. Each seat
 * is one model call to `${baseUrl}/api/chat` with `format: json` and temperature
 * 0. A seat that errors or times out ABSTAINS on every criterion (returns
 * insufficient_context) rather than crashing the panel — a dead juror is a
 * coverage gap, not a fail, consistent with the abstention model.
 *
 * BRIEF-SIZE GUARD (observed in run swarm-1784601601-bd4a wave 5, ai-rpg-engine):
 * before ANY seat is called, the rendered prompt is measured against every
 * seat's resolved context budget (context − numPredict reserve); overflow
 * throws JuryBriefOverflowError — fail-closed, whole-panel. Every verdict a
 * fitting run returns carries `brief_fit` (per-seat measurement + limit +
 * source), which normalizeAdjudication fuses onto the receipt as `brief_size`
 * so a post-hoc read can tell "the seats read the whole brief" from "unknown".
 *
 * The seat roster is NOT an option here — it is read from `spec.seats` (set by
 * buildJurySpec at the adjudicate() call), so there is one source of truth for
 * who sits on the jury. Choose the roster via adjudicate(cf, { seats }).
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs] — per-seat request timeout (default 180s; a cold 24B load is slow)
 * @param {number} [opts.numPredict] — Ollama num_predict cap (also the guard's output reserve)
 * @param {(msg: string) => void} [opts.log] — optional progress logger
 * @param {typeof fetch} [opts.fetchImpl] — injectable transport (tests; default global fetch)
 * @param {typeof resolveSeatContextsViaOllama} [opts.resolveSeatContexts] — injectable seat-context resolver (tests; default live /api/ps + /api/show + fallback table)
 * @param {number} [opts.assumedNumCtx] — see DEFAULT_ASSUMED_NUM_CTX
 * @param {boolean} [opts.allowOversize] — the `--allow-oversize` escape hatch: converts the overflow refusal into a logged, receipt-recorded warning (brief_size.all_fit: false); the seats then judge truncated reads, knowingly
 * @returns {(spec: object) => Promise<Array<{seat: string, model: string, criteria: object, out_of_brief: string[], brief_fit?: object, error?: string}>>}
 */
export function makeOllamaJury(opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const numPredict = opts.numPredict ?? DEFAULT_NUM_PREDICT;
  const log = opts.log || (() => {});
  const fetchImpl = opts.fetchImpl || fetch;
  const resolveSeatContexts = opts.resolveSeatContexts || resolveSeatContextsViaOllama;
  const assumedNumCtx = opts.assumedNumCtx ?? DEFAULT_ASSUMED_NUM_CTX;
  const allowOversize = opts.allowOversize === true;

  return async function runJury(spec) {
    const { system, user, criterionIds } = buildJurorPrompt(spec.payload);

    // The guard, before any seat call: a brief no seat can read whole is
    // refused for the whole panel (a partial dispatch would silently shrink
    // the roster — the prism roster-shrink failure class).
    const measurement = measureRenderedPrompt({ system, user });
    const contexts = await resolveSeatContexts(spec.seats, { baseUrl, fetchImpl, assumedNumCtx });
    const seatFit = assessSeatFit(measurement, spec.seats, contexts, {
      outputReserveTokens: numPredict,
      assumedNumCtx,
    });
    if (seatFit.some(s => !s.fits)) {
      if (!allowOversize) throw new JuryBriefOverflowError(measurement, seatFit, numPredict);
      // --allow-oversize: the refusal becomes a warning the operator SEES and
      // the receipt RECORDS (brief_fit.fits:false → brief_size.all_fit:false).
      // Never silent — silence is the wave-5 failure this guard exists to end.
      for (const s of seatFit.filter(f => !f.fits)) {
        log(`OVERSIZE (--allow-oversize): dispatching ~${measurement.estimated_tokens}-token brief to ${s.model} (budget ${s.budget_tokens}, over by ${s.overflow_tokens}) — its verdict will come from a truncated read`);
      }
    }
    // Per-verdict brief_fit: measurement + this seat's limit, no seat/model
    // duplication (the verdict row already names both). Attached on the error
    // path too — a dead seat's receipt entry still proves what it COULD read.
    const briefFitBySeat = new Map(seatFit.map(s => [s.model, s]));
    const briefFitFor = seat => {
      const f = briefFitBySeat.get(seat.model);
      return {
        chars: measurement.chars,
        estimated_tokens: measurement.estimated_tokens,
        estimator: measurement.estimator,
        output_reserve_tokens: numPredict,
        context_tokens: f.context_tokens,
        context_source: f.context_source,
        fits: f.fits,
      };
    };

    const verdicts = [];
    // Seats run sequentially: local Ollama serves one model at a time and swaps
    // weights per model, so concurrency would just thrash VRAM.
    for (const seat of spec.seats) {
      const started = Date.now();
      log(`juror ${seat.family} (${seat.model}) — judging…`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: seat.model,
            stream: false,
            // Director rule (2026-09-01): no jury model stays seated on VRAM after
            // its answer. Ollama honours keep_alive per request; 0 unloads the
            // weights as soon as the response is produced. The panel is
            // seat-major, so this costs one load per seat, which it already paid.
            keep_alive: 0,
            format: 'json',
            options: { temperature: 0, num_predict: numPredict },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const content = body?.message?.content ?? '';
        const { criteria, out_of_brief } = parseJurorResponse(content, criterionIds);
        verdicts.push({ seat: seat.family, model: seat.model, criteria, out_of_brief, brief_fit: briefFitFor(seat) });
        log(`juror ${seat.family} — done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (e) {
        // A dead seat abstains on everything — it does not crash or bias the panel.
        const criteria = {};
        for (const id of criterionIds) criteria[id] = 'insufficient_context';
        verdicts.push({ seat: seat.family, model: seat.model, criteria, out_of_brief: [], brief_fit: briefFitFor(seat), error: String(e.message || e) });
        log(`juror ${seat.family} — ERROR (${e.message || e}); abstaining on all criteria`);
      } finally {
        clearTimeout(timer);
      }
    }
    return verdicts;
  };
}
