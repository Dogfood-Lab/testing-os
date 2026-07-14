/**
 * case-file/lint.js — the neutrality lint for a jury case-file.
 *
 * The case-file (docs/case-file-contract.md) lets a planner-tier clerk PREPARE
 * an external family-different jury without SWAYING it: it supplies the
 * objective + falsifiable criteria + grounding evidence, and renders no verdict.
 * The schema (./schema.js) gates the SHAPE. This lint gates the NEUTRALITY
 * SEMANTICS the shape cannot express — the same split policy.schema.json and
 * docs/policy-lint.md draw between structural and data-independent checks.
 *
 * It runs four passes and BATCH-reports every finding (never stops at the
 * first — the policy-lint discipline), returning { ok, findings }:
 *
 *   1. case-file-schema      (error)   — ./schema.js structural gate. A malformed
 *                                        shape is reported, not thrown, so it sits
 *                                        alongside the semantic findings.
 *   2. case-file-verdict-leak (error)  — a lexical conclusion-word ("correct",
 *                                        "the bug is", "works as expected") in a
 *                                        criterion `check` or a `context` claim.
 *                                        That is the clerk grading instead of
 *                                        specifying — the exact contamination the
 *                                        case-file exists to prevent.
 *   3. case-file-reasoning-leak (error)— a producer reasoning trace (<thinking>,
 *                                        <reasoning>, reasoning.summary, …) leaked
 *                                        into the artifact content / claims. Re-
 *                                        opens prism's Lock-2 attack surface
 *                                        (Khalifa 2026: manipulated CoT inflates
 *                                        judge false-positives up to 90%). Stripped
 *                                        at the briefing seam, not trusted away.
 *   4. case-file-grounding   (error/warn)— the extraction floor. A context pack
 *                                        that is all `fable-inference` (the clerk
 *                                        authored the rubric from imagination) is
 *                                        an error; a thin extraction ratio is a
 *                                        warning.
 *
 * THE HONEST BOUNDARY (the VERIFY-F2 over-claim lesson, mirrored from
 * docs/policy-lint.md): this lint catches LEXICAL leak and STRUCTURAL grounding
 * only. It CANNOT catch semantic slant — a criterion that is lexically clean but
 * framed to lead the jury ("verify the guard was added" presupposes the guard is
 * the fix), nor whether an extracted claim is FAITHFUL to its cited source. Those
 * need the jury's cold read + the deterministic floor + a human. A clean lint
 * means "no lexical verdict-leak, no reasoning-leak, and a grounded pack" — not
 * "this case-file cannot possibly bias the jury." The contract doc states this in
 * its own coverage note so a green lint never reads as full neutrality proof.
 */

import { validateCaseFileSchema } from './schema.js';

/**
 * Minimum share of a non-empty context pack that must be EXTRACTED (any
 * provenance other than `fable-inference`). Below this, the pack leans too hard
 * on the clerk's synthesis and earns a grounding warning. A pack with zero
 * extraction is a hard error regardless of this ratio.
 */
export const MIN_EXTRACTION_RATIO = 0.5;

/**
 * Lexical conclusion-words that assert a VERDICT on the artifact. Deliberately
 * HIGH-PRECISION: only conclusion-shaped phrases, never bare words like "valid",
 * "pass", "fail", "works", "good", or "safe" that legitimately appear in a
 * falsifiable check ("returns a valid token", "the test suite passes", "rejects
 * invalid input"). A false-positive here would block a legitimate criterion, so
 * the list errs toward precision and the contract doc discloses the residual
 * (semantic slant this cannot see). Word-boundary, case-insensitive.
 *
 * Exported so the test suite pins each pattern and so a reviewer can audit the
 * exact vocabulary the gate enforces.
 */
export const VERDICT_LEAK_PATTERNS = [
  { id: 'correctness-adverb', label: '"correct(ly)" / "incorrect(ly)"', regex: /\b(?:in)?correct(?:ly)?\b/i },
  { id: 'defect-locator', label: '"the <bug|issue|problem|defect|flaw|root cause> is"', regex: /\b(?:the\s+)?(?:bug|issue|problem|defect|flaw|root\s+cause)\s+is\b/i },
  { id: 'broken', label: '"broken" / "buggy"', regex: /\b(?:broken|buggy)\b/i },
  { id: 'fixed', label: '"(is|was) fixed/resolved" / "fixes|resolves the"', regex: /\b(?:is|are|was|were)\s+(?:fixed|resolved)\b|\b(?:fixes|resolves)\s+the\b/i },
  { id: 'properly', label: '"properly"', regex: /\bproperly\b/i },
  { id: 'works-conclusion', label: '"works correctly/fine/as expected"', regex: /\bworks?\s+(?:correctly|fine|as\s+expected|as\s+intended)\b/i },
  { id: 'looks-conclusion', label: '"looks good/fine/correct/right"', regex: /\blooks?\s+(?:good|fine|correct|right)\b/i },
  { id: 'is-right-wrong', label: '"is right" / "is wrong"', regex: /\bis\s+(?:right|wrong)\b/i },
];

/**
 * Producer reasoning-trace markers. Mirrors prism's Lock-2 strip registry: the
 * artifact crossing the family boundary must carry no chain-of-thought. If any
 * marker survives into the case-file, the briefing has smuggled the producer's
 * justification past the strip, which is the demonstrated judge-contamination
 * surface. Case-insensitive; matches the opening marker (an opener is enough to
 * prove a leak — we do not need a well-formed close).
 */
export const REASONING_LEAK_PATTERNS = [
  { id: 'thinking-tag', label: '<thinking> block', regex: /<\s*thinking\b/i },
  { id: 'reasoning-tag', label: '<reasoning> block', regex: /<\s*reasoning\b/i },
  { id: 'scratchpad-tag', label: '<scratchpad>/<scratch> block', regex: /<\s*scratch(?:pad)?\b/i },
  { id: 'think-tag', label: '<think> block (DeepSeek-R1)', regex: /<\s*think\s*>/i },
  { id: 'reasoning-field', label: 'reasoning.summary / reasoning.content field', regex: /\breasoning\.(?:summary|content)\b/i },
];

/**
 * @typedef {Object} CaseFileLintFinding
 * @property {string} code      - 'case-file-schema' | 'case-file-verdict-leak' | 'case-file-reasoning-leak' | 'case-file-grounding'
 * @property {'error'|'warning'} severity
 * @property {string} field     - JSON-pointer-ish location ('/acceptance_criteria/0/check')
 * @property {string} message   - human-readable, actionable
 * @property {string} [ruleId]  - the offending sub-pattern id where applicable
 * @property {string} [hint]    - next-step suggestion
 */

/**
 * Scan a string against a pattern set. Returns the matched pattern descriptors.
 * @param {unknown} text
 * @param {Array<{id: string, label: string, regex: RegExp}>} patterns
 * @returns {Array<{id: string, label: string}>}
 */
function scanPatterns(text, patterns) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const p of patterns) {
    if (p.regex.test(text)) hits.push({ id: p.id, label: p.label });
  }
  return hits;
}

/**
 * Lint a parsed case-file for neutrality. Defensive by construction: every pass
 * guards its own field access so the lint still runs (and reports) when the
 * schema pass has already flagged a malformed shape — batch reporting depends on
 * no pass throwing on bad input.
 *
 * @param {unknown} caseFile — parsed JSON case-file
 * @returns {{ ok: boolean, findings: CaseFileLintFinding[] }} ok is true when no
 *   ERROR-severity finding was produced (warnings do not block, mirroring the
 *   policy-lint exit contract).
 */
export function lintCaseFile(caseFile) {
  const findings = [];

  // ── Pass 1: structural gate ────────────────────────────────────────────────
  const schemaResult = validateCaseFileSchema(caseFile);
  if (!schemaResult.valid) {
    for (const err of schemaResult.errors) {
      findings.push({
        code: 'case-file-schema',
        severity: 'error',
        field: err.path,
        message: `case-file shape invalid: ${err.path} ${err.message}`,
        hint: 'Fix the case-file against packages/schemas/src/json/case-file.schema.json. The clerk emits { objective, artifact_under_test, acceptance_criteria } at minimum, and no verdict field.',
      });
    }
  }

  const cf = caseFile && typeof caseFile === 'object' ? caseFile : {};

  // ── Pass 2: verdict-leak scan (criteria + context claims) ──────────────────
  const criteria = Array.isArray(cf.acceptance_criteria) ? cf.acceptance_criteria : [];
  criteria.forEach((c, i) => {
    const check = c && typeof c === 'object' ? c.check : undefined;
    for (const hit of scanPatterns(check, VERDICT_LEAK_PATTERNS)) {
      findings.push({
        code: 'case-file-verdict-leak',
        severity: 'error',
        field: `/acceptance_criteria/${i}/check`,
        ruleId: hit.id,
        message: `acceptance criterion asserts a verdict (${hit.label}) instead of a falsifiable check — the clerk is grading, not specifying`,
        hint: 'Rewrite as an observable check the jury can evaluate ("returns 401 on an expired token"), not a conclusion about the artifact ("correctly returns 401").',
      });
    }
  });

  const context = Array.isArray(cf.context) ? cf.context : [];
  context.forEach((c, i) => {
    const claim = c && typeof c === 'object' ? c.claim : undefined;
    for (const hit of scanPatterns(claim, VERDICT_LEAK_PATTERNS)) {
      findings.push({
        code: 'case-file-verdict-leak',
        severity: 'error',
        field: `/context/${i}/claim`,
        ruleId: hit.id,
        message: `context claim asserts a verdict (${hit.label}) instead of a neutral fact — the clerk is leading the jury`,
        hint: 'State the fact without the conclusion ("the guard was added at auth.js:42"), not a judgment of it ("the guard correctly handles expiry").',
      });
    }
  });

  // ── Pass 3: reasoning-leak scan (artifact content + claims + notes) ────────
  const aut = cf.artifact_under_test && typeof cf.artifact_under_test === 'object'
    ? cf.artifact_under_test
    : {};
  const reasoningTargets = [
    { field: '/artifact_under_test/content', text: aut.content },
    { field: '/notes', text: cf.notes },
    ...context.map((c, i) => ({
      field: `/context/${i}/claim`,
      text: c && typeof c === 'object' ? c.claim : undefined,
    })),
  ];
  for (const target of reasoningTargets) {
    for (const hit of scanPatterns(target.text, REASONING_LEAK_PATTERNS)) {
      findings.push({
        code: 'case-file-reasoning-leak',
        severity: 'error',
        field: target.field,
        ruleId: hit.id,
        message: `producer reasoning trace leaked into the case-file (${hit.label}) — this re-opens the Lock-2 judge-contamination surface`,
        hint: 'Strip the producer chain-of-thought before it enters the briefing. The jury judges the artifact and the criteria, never the producer’s justification for them.',
      });
    }
  }

  // ── Pass 4: grounding / extraction floor ───────────────────────────────────
  // Only meaningful once the context items have the shape the schema requires;
  // if the shape is broken the schema pass already flagged it, so guard here.
  const wellFormedContext = context.filter(
    c => c && typeof c === 'object' && typeof c.source === 'string',
  );
  const total = wellFormedContext.length;
  const extracted = wellFormedContext.filter(c => c.source !== 'fable-inference').length;

  if (total > 0 && extracted === 0) {
    findings.push({
      code: 'case-file-grounding',
      severity: 'error',
      field: '/context',
      message: `every context claim is fable-inference (${total}/${total}) — the clerk authored the entire grounding pack from imagination`,
      hint: 'Extract grounding from checkable sources (from-spec / from-ticket / from-tests / from-code) and cite each with a ref. The jury judges against evidence, not the clerk’s recall.',
    });
  } else if (total > 0 && extracted / total < MIN_EXTRACTION_RATIO) {
    findings.push({
      code: 'case-file-grounding',
      severity: 'warning',
      field: '/context',
      message: `context pack is thinly grounded — ${extracted}/${total} claims extracted, below the ${MIN_EXTRACTION_RATIO} floor`,
      hint: 'Prefer extracted claims (from-spec / from-tests / from-code) over fable-inference so the jury judges against checkable evidence. This is advisory; a low ratio is sometimes legitimate.',
    });
  } else if (total === 0) {
    // No context pack at all. Legitimate ONLY when the criteria are themselves
    // grounded (extracted from tests/spec). A rubric with neither context nor a
    // single sourced criterion is fully unsourced — the jury would judge against
    // the clerk's unsupported word. Advisory, because a self-evidently checkable
    // criterion ("returns 401 on expiry") can stand without a citation.
    const anySourcedCriterion = criteria.some(
      c => c && typeof c === 'object' && typeof c.source === 'string' && c.source !== 'fable-inference',
    );
    if (criteria.length > 0 && !anySourcedCriterion) {
      findings.push({
        code: 'case-file-grounding',
        severity: 'warning',
        field: '/context',
        message: 'no extracted grounding at all — empty context pack and no sourced acceptance criterion',
        hint: 'Add context evidence, or tag the criteria with the source they were extracted from (from-tests is strongest), so the jury judges against something checkable rather than the clerk’s unsupported rubric.',
      });
    }
  }

  const ok = !findings.some(f => f.severity === 'error');
  return { ok, findings };
}
