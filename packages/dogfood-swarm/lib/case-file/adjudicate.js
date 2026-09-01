/**
 * case-file/adjudicate.js — dispatch a neutral case-file to the family-different
 * jury and fuse the panel's answers into an evidence-not-law verdict.
 *
 * This is the layer above ./handoff.js. handoff.toJuryRequest() builds the
 * neutral request (fail-closed on a biasing case-file); this module:
 *
 *   1. buildJurySpec()        — maps the request to the cross-family invocation
 *                               spec (prism-verify over Ollama-Cloud seats via
 *                               the F-14 config registry), and ENFORCES Lock 1:
 *                               the producer family (Anthropic/Claude) is never a
 *                               juror. Your whole crew is Claude-family, so the
 *                               only real family-different verification of Claude
 *                               work is a non-Claude jury (Panickssery NeurIPS
 *                               2024, arXiv:2404.13076).
 *   2. aggregateCriterion()   — combines N jurors' per-criterion answers with the
 *                               abstention-aware rule: a criterion the panel could
 *                               not reach quorum on is `insufficient_context` (a
 *                               brief gap to fill), NOT a fail — the whole point of
 *                               the abstention design.
 *   3. normalizeAdjudication()— fuses per-criterion results into an overall
 *                               verdict that is explicitly ADVISORY: the jury is
 *                               strong evidence, but only the deterministic floor
 *                               (`swarm verify` — the real tests) is law. Even a
 *                               unanimous corroborate does not advance a wave
 *                               alone.
 *
 * The actual jury call (shelling `prism verify` with the per-seat env recipe, or
 * an in-process panel) is an INJECTED boundary — `adjudicate(caseFile, { runJury })`
 * — the same adapter seam lib/verify uses so the load-bearing logic
 * (spec-building + aggregation + the evidence-not-law framing) is fully testable
 * without a live prism + Ollama. The live `runJury` adapter and its wiring into a
 * `swarm adjudicate` CLI verb (with the compensators table for the irreversible
 * receipt persistence) is the next slice; this module is the contract it consumes.
 *
 * Panel aggregation heritage: Verga et al. 2024 (PoLL — a panel of smaller judges
 * beats a single large one, arXiv:2404.18796); prism's Lock-1/Lock-4 independence
 * + submodularity locks (docs mirror prism-verify/design/01).
 */

import { toJuryRequest } from './handoff.js';

/**
 * The default cross-family jury roster. All NON-Claude by construction — the
 * only seats that can independently verify Claude-produced work. Cloud seats
 * (gpt-oss / glm) route through Ollama's OpenAI-compatible endpoint per the F-14
 * recipe; local seats are distinct lineages the rig serves at ~24-32B. Override
 * via opts.seats.
 *
 * F-efe53969: this roster's non-cloud seats MUST stay in lockstep with
 * ./ollama-jury.js's LOCAL_JURY_SEATS — same families, same model pins. That
 * file's own header states the intended relationship: "DEFAULT_JURY_SEATS
 * includes the gpt-oss / glm `:cloud` seats ... LOCAL_JURY_SEATS is the
 * explicit free-local opt-in", i.e. DEFAULT = LOCAL + the two cloud seats
 * below. A prior revision let this roster drift (missing the hermes seat,
 * qwen re-pinned to qwen3.6) with no comment explaining either change — an
 * unintentional divergence confirmed via commit history (LOCAL_JURY_SEATS's
 * qwen2.5:7b-over-qwen3.x "thinking model can return empty JSON" rationale
 * was written AFTER this roster and never backported). Cannot import
 * LOCAL_JURY_SEATS directly here (ollama-jury.js imports FROM this module —
 * see its header — so importing back would cycle); keep the two lists
 * synchronized by hand and let case-file-jury-seats-parity.test.js catch a
 * future re-drift.
 */
export const DEFAULT_JURY_SEATS = [
  { family: 'openai', model: 'gpt-oss:120b-cloud', base_url: 'http://localhost:11434' },
  { family: 'zhipu', model: 'glm-4.6:cloud', base_url: 'http://localhost:11434' },
  { family: 'mistral', model: 'mistral-small:24b' },
  { family: 'granite', model: 'granite4.1:30b' },
  { family: 'qwen', model: 'qwen2.5:7b' },
  { family: 'gemma', model: 'gemma4:31b' },
  { family: 'llama', model: 'llama3.1:8b' },
];

/**
 * The producer family that must never sit on the jury (Lock 1). Matched
 * case-insensitively against both the family label and a `claude` alias, so a
 * Claude seat under any naming is refused.
 */
export const EXCLUDED_FAMILY = 'anthropic';

/** Per-criterion answers a juror may return. */
export const JUROR_ANSWERS = ['pass', 'fail', 'insufficient_context'];

/** Fraction of the panel that must DECIDE (pass|fail) a criterion for a verdict;
 * below this the criterion is `insufficient_context` (a brief gap). */
export const DEFAULT_MIN_DECIDING_RATIO = 0.5;

function isExcludedFamily(family) {
  const f = String(family || '').toLowerCase();
  return f.includes(EXCLUDED_FAMILY) || f.includes('claude');
}

/**
 * Build the cross-family jury invocation spec from a neutral jury request.
 * Deterministic and pure. Enforces Lock 1 by refusing any producer-family seat.
 *
 * @param {object} juryRequest — output of handoff.toJuryRequest()
 * @param {object} [opts]
 * @param {Array<{family: string, model: string, base_url?: string}>} [opts.seats]
 * @returns {object} the invocation spec (seats, F-14 env recipe, payload, attestations)
 * @throws {Error} if a seat is the excluded producer family (Lock 1 violation)
 */
export function buildJurySpec(juryRequest, opts = {}) {
  const seats = opts.seats || DEFAULT_JURY_SEATS;

  const offending = seats.filter(s => isExcludedFamily(s.family));
  if (offending.length > 0) {
    throw new Error(
      `Lock-1 violation: the producer family (${EXCLUDED_FAMILY}/claude) cannot sit on the jury. ` +
      `Offending seat(s): ${offending.map(s => `${s.family}:${s.model}`).join(', ')}. ` +
      'Your generation crew is Claude-family; only a non-Claude jury independently verifies its work.',
    );
  }

  // F-14 config registry recipe: PRISM_VERIFIER_MODEL_<FAMILY> selects each seat's
  // model; PRISM_<PROVIDER>_BASE_URL points the provider at Ollama's OpenAI-compat
  // endpoint. OPENAI_API_KEY=ollama is the auth stub the recipe uses when an
  // OpenAI-family cloud seat routes through Ollama.
  const env = {};
  for (const seat of seats) {
    const F = seat.family.toUpperCase();
    env[`PRISM_VERIFIER_MODEL_${F}`] = seat.model;
    if (seat.base_url) env[`PRISM_${F}_BASE_URL`] = seat.base_url;
  }
  if (seats.some(s => s.family.toLowerCase() === 'openai')) {
    env.OPENAI_API_KEY = 'ollama';
  }

  return {
    seats: seats.map(s => ({ family: s.family, model: s.model })),
    excluded_family: EXCLUDED_FAMILY,
    env,
    payload: {
      artifact: juryRequest.artifact,
      rubric: juryRequest.rubric,
      evidence: juryRequest.evidence,
      instruction: juryRequest.abstention,
    },
    reasoning_stripped: true,
    attestations: {
      verdict_free_brief: juryRequest.neutrality?.verdict_free === true,
      gated_by: juryRequest.neutrality?.gated_by || 'case-file-lint',
    },
  };
}

/**
 * Aggregate one criterion's answers across the panel.
 *
 * @param {string[]} answers — each juror's answer for this criterion ('pass'|'fail'|'insufficient_context')
 * @param {object} [opts]
 * @param {number} [opts.minDecidingRatio]
 * @returns {{ verdict: 'pass'|'fail'|'contested'|'insufficient_context', counts: {pass: number, fail: number, insufficient_context: number}, deciding: number, total: number }}
 */
export function aggregateCriterion(answers, opts = {}) {
  const minDecidingRatio = opts.minDecidingRatio ?? DEFAULT_MIN_DECIDING_RATIO;
  const total = answers.length;
  const counts = {
    pass: answers.filter(a => a === 'pass').length,
    fail: answers.filter(a => a === 'fail').length,
    insufficient_context: answers.filter(a => a === 'insufficient_context').length,
  };
  const deciding = counts.pass + counts.fail;
  const quorum = Math.ceil(total * minDecidingRatio);

  // Not enough jurors had the context to decide → a brief gap, not a fail.
  if (total === 0 || deciding < quorum) {
    return { verdict: 'insufficient_context', counts, deciding, total };
  }
  // Among the deciding jurors: unanimity → that verdict; disagreement → contested.
  if (counts.fail === 0) return { verdict: 'pass', counts, deciding, total };
  if (counts.pass === 0) return { verdict: 'fail', counts, deciding, total };
  return { verdict: 'contested', counts, deciding, total };
}

// Overall precedence: a concrete decided failure is the strongest signal, then a
// split, then a coverage gap, then a clean corroboration.
const OVERALL_PRECEDENCE = ['refute', 'contested', 'insufficient_context', 'corroborate'];
const CRITERION_TO_OVERALL = {
  fail: 'refute',
  contested: 'contested',
  insufficient_context: 'insufficient_context',
  pass: 'corroborate',
};

/**
 * Fuse per-juror verdicts into an ADVISORY adjudication. The jury is strong
 * evidence; only the deterministic floor is law — so even a clean corroborate
 * never advances a wave on its own (`advances_wave_alone: false`).
 *
 * @param {Array<{seat?: string, criteria: Record<string,string>, out_of_brief?: string[]}>} jurorVerdicts
 * @param {object} juryRequest — the request the panel judged (source of the criterion ids)
 * @param {object} [opts]
 * @param {number} [opts.minDecidingRatio]
 * @returns {object} the adjudication result
 */
export function normalizeAdjudication(jurorVerdicts, juryRequest, opts = {}) {
  const criteria = juryRequest.rubric.acceptance_criteria;

  const criteriaResults = criteria.map(c => {
    // A juror that omitted a criterion is treated as having abstained on it —
    // silence is not a pass. Only whitelisted answers count; anything else is
    // normalized to insufficient_context so a malformed juror can't mint a pass.
    const answers = jurorVerdicts.map(jv => {
      const a = jv.criteria ? jv.criteria[c.id] : undefined;
      return JUROR_ANSWERS.includes(a) ? a : 'insufficient_context';
    });
    const agg = aggregateCriterion(answers, opts);
    // Brief completeness, onto the RECEIPT (sm-oos-002). A tier that trims the
    // brief to fit a cap (prism's 4000-char intent ceiling) reports what it
    // dropped per criterion; that record used to live only in the operator's
    // terminal and was discarded here, so the signed receipt attested a verdict
    // while omitting the single fact most likely to undermine it. The contract's
    // honest-boundary claim — "anything that does not fit is REPORTED, not
    // silently dropped" — is only true if REPORTED means the durable artifact.
    //
    // Absent (rather than zeroed) for a tier with no cap, so "no record" means
    // "this tier delivered the whole brief" and `{0,0}` means "it trims, and
    // dropped nothing here". Aggregated by WORST across seats: the intent is
    // seat-independent today (buildCriterionIntent is a pure function of
    // criterion + payload), but a receipt must not under-report if a future
    // per-seat budget ever breaks that.
    const omissions = jurorVerdicts
      .map(jv => (jv.prism?.criteria || []).find(d => d.criterion === c.id)?.omitted)
      .filter(o => o && typeof o === 'object');

    // F-993df146: WHY a criterion landed on insufficient_context matters as
    // much as THAT it did. Both jury tiers already capture a rich, typed
    // reason at the SOURCE — ollama-jury.js's makeOllamaJury sets a
    // whole-juror `error` string when a seat dies (ECONNREFUSED, an
    // unpulled-model 404, ...), forcing every criterion for that seat to
    // insufficient_context; prism-jury.js's makePrismJury sets a
    // PER-CRITERION `error` inside `prism.criteria[]`
    // (VERIFIER_UNAVAILABLE / BUDGET_EXCEEDED / LENS_COLLAPSE / an
    // unparseable response) — four mechanically distinct failure classes
    // that call for four different operator responses. This function used
    // to read neither shape, so "insufficient_context because the case is
    // genuinely hard" and "insufficient_context because N of M seats never
    // actually ran" were indistinguishable in the receipt
    // (commands/adjudicate.js serializes this return value verbatim, and it
    // is the ONLY artifact holding per-criterion detail — db/schema.js's
    // adjudications row is a summary with no criteria column by design).
    // Threaded the same way `brief_omitted` already is: per-criterion,
    // sparse (absent, not an empty array, when nobody errored on this
    // criterion) — a whole-juror error is attributed to every criterion that
    // juror was asked to judge, since the seat abstained on all of them.
    const errors = jurorVerdicts
      .map(jv => {
        if (jv.error) return { seat: jv.seat, error: jv.error };
        const detail = (jv.prism?.criteria || []).find(d => d.criterion === c.id);
        return detail?.error ? { seat: jv.seat, error: detail.error } : null;
      })
      .filter(Boolean);

    const result = { id: c.id, ...agg };
    if (omissions.length > 0) {
      result.brief_omitted = {
        evidence: Math.max(...omissions.map(o => Number(o.evidence) || 0)),
        out_of_scope: Math.max(...omissions.map(o => Number(o.out_of_scope) || 0)),
      };
    }
    if (errors.length > 0) {
      result.errors = errors;
    }
    return result;
  });

  // Overall = the highest-precedence criterion outcome present.
  let overall = 'corroborate';
  let bestRank = OVERALL_PRECEDENCE.indexOf('corroborate');
  for (const cr of criteriaResults) {
    const mapped = CRITERION_TO_OVERALL[cr.verdict];
    const rank = OVERALL_PRECEDENCE.indexOf(mapped);
    if (rank < bestRank) {
      bestRank = rank;
      overall = mapped;
    }
  }

  // Out-of-brief findings: the rubric is a floor, not a ceiling. Aggregate by
  // normalized text and count how many jurors independently raised each.
  const outOfBriefCounts = new Map();
  for (const jv of jurorVerdicts) {
    for (const finding of jv.out_of_brief || []) {
      const key = String(finding).trim().toLowerCase();
      if (!key) continue;
      const existing = outOfBriefCounts.get(key);
      if (existing) existing.jurors += 1;
      else outOfBriefCounts.set(key, { finding: String(finding).trim(), jurors: 1 });
    }
  }

  // F-993df146: panel-level health flag, coarser than the per-criterion
  // `errors` above but readable WITHOUT walking every criterion — a fully or
  // partially offline jury (every criterion for that seat forced to
  // insufficient_context) is visible at a glance in the artifact this repo
  // already treats as the trust anchor for its own verification claims.
  // Always present (unlike the sparse per-criterion `errors`/`brief_omitted`
  // fields) so a caller can check `seats_errored.length` without an
  // undefined guard; empty means every seat that sat on the panel actually ran.
  const seatsErrored = jurorVerdicts
    .filter(jv => Boolean(jv.error))
    .map(jv => ({ seat: jv.seat, error: jv.error }));

  // Brief size, onto the RECEIPT — observed in run swarm-1784601601-bd4a
  // wave 5 (ai-rpg-engine): a 252KB case-file overflowed every local seat's
  // effective context, the server silently truncated, and the panel abstained
  // on all 14 criteria with zero receipt evidence the brief never fit. The
  // local tier (ollama-jury.js) now measures the rendered prompt against each
  // seat's resolved context BEFORE dispatch and stamps `brief_fit` on every
  // verdict; this fuses it panel-level so a post-hoc read distinguishes "the
  // seats read the whole brief" from "unknown". Same conventions as
  // brief_omitted: ABSENT (not zeroed) when no verdict carries the record
  // (prism tier, pre-guard receipts, injected test juries), and the panel
  // numbers take the WORST across seats (max chars/tokens) so a future
  // per-seat prompt cannot under-report.
  const briefFits = jurorVerdicts.filter(jv => jv.brief_fit && typeof jv.brief_fit === 'object');
  const briefSize = briefFits.length > 0
    ? {
        chars: Math.max(...briefFits.map(jv => Number(jv.brief_fit.chars) || 0)),
        estimated_tokens: Math.max(...briefFits.map(jv => Number(jv.brief_fit.estimated_tokens) || 0)),
        estimator: briefFits[0].brief_fit.estimator,
        output_reserve_tokens: Math.max(...briefFits.map(jv => Number(jv.brief_fit.output_reserve_tokens) || 0)),
        all_fit: briefFits.every(jv => jv.brief_fit.fits === true),
        seats: briefFits.map(jv => ({
          seat: jv.seat,
          model: jv.model,
          context_tokens: jv.brief_fit.context_tokens,
          context_source: jv.brief_fit.context_source,
          fits: jv.brief_fit.fits,
        })),
      }
    : undefined;

  return {
    overall,
    authority: 'advisory',       // the jury is EVIDENCE, not law
    law: 'deterministic-floor',  // only `swarm verify` (real tests) gates the wave
    advances_wave_alone: false,  // even corroborate needs the floor to pass too
    criteria: criteriaResults,
    out_of_brief: [...outOfBriefCounts.values()].sort((a, b) => b.jurors - a.jurors),
    panel_size: jurorVerdicts.length,
    seats: jurorVerdicts.map(jv => jv.seat).filter(Boolean),
    seats_errored: seatsErrored,
    ...(briefSize ? { brief_size: briefSize } : {}),
    excluded_family: EXCLUDED_FAMILY,
  };
}

/**
 * Adjudicate a case-file end to end: fail-closed neutrality gate → build the
 * cross-family jury spec → run the jury (INJECTED boundary) → fuse into an
 * advisory verdict.
 *
 * @param {unknown} caseFile — parsed JSON case-file
 * @param {object} deps
 * @param {(spec: object) => Promise<Array<object>> | Array<object>} deps.runJury —
 *   the jury boundary: given the invocation spec, returns one verdict per juror.
 *   Live implementation shells `prism verify` per seat; tests inject a mock.
 * @param {Array<{family: string, model: string, base_url?: string}>} [deps.seats]
 * @param {number} [deps.minDecidingRatio]
 * @returns {Promise<object>} the adjudication result
 * @throws {import('./handoff.js').CaseFileNeutralityError} if the case-file fails the neutrality gate
 */
export async function adjudicate(caseFile, deps) {
  if (!deps || typeof deps.runJury !== 'function') {
    throw new Error('adjudicate requires a runJury boundary: adjudicate(caseFile, { runJury }).');
  }
  const juryRequest = toJuryRequest(caseFile); // fail-closed on a biasing case-file
  const spec = buildJurySpec(juryRequest, { seats: deps.seats });
  const jurorVerdicts = await deps.runJury(spec);
  return normalizeAdjudication(jurorVerdicts, juryRequest, {
    minDecidingRatio: deps.minDecidingRatio,
  });
}
