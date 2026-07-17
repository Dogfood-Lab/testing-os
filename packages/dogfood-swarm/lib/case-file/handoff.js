/**
 * case-file/handoff.js — the fail-closed transform from a clerk's case-file to
 * the neutral request an external family-different jury (e.g. prism-verify with
 * Ollama-Cloud cross-family seats) consumes.
 *
 * This is the seam where "Fable prepares" meets "the jury judges". It enforces
 * two guarantees before a single file reaches the jury:
 *
 *   1. NEUTRALITY IS GATED, NOT TRUSTED. The transform runs ./lint.js and
 *      REFUSES (throws CaseFileNeutralityError) on any error-severity finding —
 *      a verdict-leak, a reasoning-leak, or an ungrounded pack. The clerk's
 *      good intentions are never the guarantee; the lint is. (Warnings do not
 *      block, mirroring the policy-lint exit contract.)
 *
 *   2. THE JURY IS PREPARED, NOT COLD-DROPPED. The request carries the objective,
 *      the falsifiable criteria, the RAG-style evidence pack, AND an abstention
 *      rubric that makes `insufficient_context` a first-class answer — the fix
 *      for under-abstention (an under-calibrated verifier hallucinating a verdict
 *      on under-specified input instead of abstaining).
 *
 * The jury-facing shapes are deliberate:
 *   - rubric criteria expose { id, check } only — the jury judges the CHECK; a
 *     criterion's provenance is a grounding concern (the lint's), not a judging
 *     input, and withholding it avoids biasing the verdict.
 *   - evidence keeps { claim, source, ref } — provenance IS a judging input here:
 *     the jury should weight a from-code claim above a fable-inference one, the
 *     way prism feeds the retrieved source to its Groundedness lens.
 *
 * Scope note: this module builds the neutral request and asserts the
 * guarantees. Actually dispatching it to prism (wiring the Ollama-Cloud
 * cross-family seats via the F-14 config registry) is the `swarm adjudicate`
 * verb — the next slice. This transform is the contract that verb will consume.
 */

import { lintCaseFile } from './lint.js';

/**
 * The abstention rubric handed to every juror alongside the case-file. Names
 * `insufficient_context` as a correct, non-penalized per-criterion answer (the
 * under-abstention fix), keeps the jury's judgment on the artifact-vs-criteria,
 * and licenses out-of-brief findings so an incomplete case-file does not make
 * the clerk's blind spots the jury's (the rubric is a floor, not a ceiling).
 */
export const ABSTENTION_RUBRIC =
  'You are one of several independent, different-family verifiers. Judge ONLY the ' +
  'artifact_under_test against the acceptance_criteria, using the evidence pack. ' +
  'For each criterion return exactly one of: pass, fail, or insufficient_context. ' +
  '`insufficient_context` is a correct, non-penalized answer — return it whenever ' +
  'the case-file does not give you enough to judge that criterion; do NOT guess a ' +
  'verdict. The criteria are a floor, not a ceiling: if you notice a defect outside ' +
  'them, report it and mark it out-of-brief. Nothing here has pre-judged the ' +
  'artifact — do not assume it is correct or incorrect.';

/**
 * Thrown when the handoff refuses a case-file that failed the neutrality lint.
 * Fail-closed: a case-file that could bias the jury never reaches it.
 *
 * Kept local to the case-file module for this slice. When the `swarm adjudicate`
 * / `swarm brief` CLI verb lands, this graduates to packages/dogfood-swarm/
 * lib/errors.js (the central structured-error home) and earns an entry in the
 * error-codes handbook page — at which point the check-doc-drift error-code
 * cross-ref gate begins asserting that entry. Until a CLI surface renders it,
 * the local class keeps this slice self-contained (the policy-lint diagnostic
 * labels took the same "not a central error code yet" path).
 *
 * @property {'CASE_FILE_NEUTRALITY_VIOLATION'} code
 * @property {import('./lint.js').CaseFileLintFinding[]} findings — the error-severity findings that caused the refusal
 * @property {string} hint
 */
export class CaseFileNeutralityError extends Error {
  /**
   * @param {import('./lint.js').CaseFileLintFinding[]} findings
   */
  constructor(findings) {
    const errors = findings.filter(f => f.severity === 'error');
    const summary = errors.map(f => `${f.field} ${f.code}`).join('; ');
    super(`case-file failed the neutrality gate — not handed to the jury: ${summary}`);
    this.name = 'CaseFileNeutralityError';
    this.code = 'CASE_FILE_NEUTRALITY_VIOLATION';
    this.findings = errors;
    this.hint =
      'The clerk’s case-file leaked a verdict, leaked a producer reasoning trace, ' +
      'or is ungrounded. Fix the reported fields and re-lint before adjudication. ' +
      'The gate is fail-closed by design: a briefing that could bias the jury never reaches it.';
  }
}

/**
 * Assert a case-file passes the neutrality lint, or throw. The gate a future
 * `swarm brief --gate` / `swarm adjudicate` would call before dispatch.
 *
 * @param {unknown} caseFile
 * @returns {import('./lint.js').CaseFileLintFinding[]} the (warning-only) findings on success
 * @throws {CaseFileNeutralityError} when any error-severity finding is present
 */
export function assertCaseFileClean(caseFile) {
  const { ok, findings } = lintCaseFile(caseFile);
  if (!ok) throw new CaseFileNeutralityError(findings);
  return findings;
}

/**
 * Transform a clerk's case-file into the neutral request an external
 * family-different jury consumes. Fail-closed: throws CaseFileNeutralityError if
 * the case-file does not pass the neutrality lint, so a biasing briefing never
 * reaches the jury.
 *
 * @param {unknown} caseFile — parsed JSON case-file
 * @returns {{
 *   artifact: { kind: string, ref: string, content?: string },
 *   rubric: { objective: string, acceptance_criteria: Array<{id: string, check: string}>, out_of_scope: string[] },
 *   evidence: Array<{claim: string, source: string, ref?: string, criterion_ids?: string[]}>,
 *   abstention: string,
 *   neutrality: { verdict_free: true, reasoning_stripped: true, gated_by: string, warnings: number }
 * }}
 * @throws {CaseFileNeutralityError}
 */
export function toJuryRequest(caseFile) {
  const warnings = assertCaseFileClean(caseFile); // fail-closed on any error finding

  const cf = /** @type {any} */ (caseFile);
  const aut = cf.artifact_under_test;

  return {
    artifact: {
      kind: aut.kind,
      ref: aut.ref,
      ...(typeof aut.content === 'string' ? { content: aut.content } : {}),
    },
    rubric: {
      objective: cf.objective,
      acceptance_criteria: cf.acceptance_criteria.map(c => ({ id: c.id, check: c.check })),
      out_of_scope: Array.isArray(cf.out_of_scope) ? cf.out_of_scope.slice() : [],
    },
    // `criterion_ids` is a ROUTING field, not a judging input: it tells the
    // prism tier's assembler which criteria a claim grounds so a capped brief
    // sends each criterion its OWN relevant evidence instead of all of it. It
    // is never rendered — both tiers build their evidence line by explicit
    // field access (`- [${source}] ${claim} (${ref})`), so no juror can see it.
    // Contrast `claim`/`source`/`ref`, which ARE judging inputs (provenance is
    // what the groundedness lens weights). Absent => the claim is global.
    evidence: (Array.isArray(cf.context) ? cf.context : []).map(c => ({
      claim: c.claim,
      source: c.source,
      ...(typeof c.ref === 'string' ? { ref: c.ref } : {}),
      ...(Array.isArray(c.criterion_ids) ? { criterion_ids: c.criterion_ids.slice() } : {}),
    })),
    abstention: ABSTENTION_RUBRIC,
    neutrality: {
      verdict_free: true,
      reasoning_stripped: true,
      gated_by: 'case-file-lint',
      warnings: warnings.length,
    },
  };
}
