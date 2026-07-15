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
  { family: 'hermes', model: 'hermes3:8b' },
];

const DEFAULT_BASE_URL = 'http://localhost:11434';

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
 * The seat roster is NOT an option here — it is read from `spec.seats` (set by
 * buildJurySpec at the adjudicate() call), so there is one source of truth for
 * who sits on the jury. Choose the roster via adjudicate(cf, { seats }).
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs] — per-seat request timeout (default 180s; a cold 24B load is slow)
 * @param {number} [opts.numPredict] — Ollama num_predict cap
 * @param {(msg: string) => void} [opts.log] — optional progress logger
 * @returns {(spec: object) => Promise<Array<{seat: string, model: string, criteria: object, out_of_brief: string[], error?: string}>>}
 */
export function makeOllamaJury(opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const numPredict = opts.numPredict ?? 512;
  const log = opts.log || (() => {});

  return async function runJury(spec) {
    const { system, user, criterionIds } = buildJurorPrompt(spec.payload);

    const verdicts = [];
    // Seats run sequentially: local Ollama serves one model at a time and swaps
    // weights per model, so concurrency would just thrash VRAM.
    for (const seat of spec.seats) {
      const started = Date.now();
      log(`juror ${seat.family} (${seat.model}) — judging…`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: seat.model,
            stream: false,
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
        verdicts.push({ seat: seat.family, model: seat.model, criteria, out_of_brief });
        log(`juror ${seat.family} — done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (e) {
        // A dead seat abstains on everything — it does not crash or bias the panel.
        const criteria = {};
        for (const id of criterionIds) criteria[id] = 'insufficient_context';
        verdicts.push({ seat: seat.family, model: seat.model, criteria, out_of_brief: [], error: String(e.message || e) });
        log(`juror ${seat.family} — ERROR (${e.message || e}); abstaining on all criteria`);
      } finally {
        clearTimeout(timer);
      }
    }
    return verdicts;
  };
}
