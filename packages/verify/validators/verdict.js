/**
 * Verdict computation
 *
 * Core rule: verifier may confirm or downgrade the proposed verdict, never upgrade.
 *
 * Verdict severity (highest to lowest): fail > blocked > partial > pass
 */

// F-937733ee: family sibling of F-2965699b/F-7ce07baa. Object.create(null)
// removes the prototype chain entirely — `VERDICT_RANK['constructor']` is
// `undefined`, not `Object.prototype.constructor` — so the `== null` guards
// below fire correctly for every Object.prototype key, not just for a
// literal typo. Currently unreachable in production (index.js:326 only ever
// passes schema-enum-valid verdicts into `scenarioResults`), but sealing it
// here keeps a future caller that skips the schema gate from silently
// reopening the class.
const VERDICT_RANK = Object.assign(Object.create(null), { fail: 0, blocked: 1, partial: 2, pass: 3 });

/**
 * Compute the verified verdict.
 *
 * @param {string|null} proposed - Source-proposed verdict
 * @param {object} context
 * @param {boolean} context.schemaValid
 * @param {boolean} context.policyValid
 * @param {boolean} context.provenanceConfirmed
 * @param {object[]} context.scenarioResults - scenario_results from submission
 * @param {string[]} context.reasons - accumulated rejection reasons
 * @returns {{ verified: string, downgraded: boolean, downgrade_reasons: string[] }}
 */
export function computeVerdict(proposed, context) {
  const { schemaValid, policyValid, provenanceConfirmed, scenarioResults, reasons } = context;
  const downgrade_reasons = [];

  // If fundamentals fail, verdict is "fail" regardless
  if (!schemaValid || !provenanceConfirmed) {
    const verified = 'fail';
    if (proposed && proposed !== 'fail') {
      downgrade_reasons.push('schema or provenance validation failed');
    }
    return {
      verified,
      downgraded: proposed != null && VERDICT_RANK[verified] < VERDICT_RANK[proposed],
      downgrade_reasons
    };
  }

  // Compute the worst scenario verdict
  let worstScenarioRank = VERDICT_RANK.pass;
  for (const sr of scenarioResults || []) {
    let rank = VERDICT_RANK[sr.verdict];
    if (rank == null) {
      rank = VERDICT_RANK.fail;
      downgrade_reasons.push('verdict: unrecognized scenario verdict "' + sr.verdict + '", treating as fail');
    }
    if (rank < worstScenarioRank) {
      worstScenarioRank = rank;
    }
  }

  // Determine the floor verdict from evidence
  let floorVerdict = Object.entries(VERDICT_RANK)
    .find(([, rank]) => rank === worstScenarioRank)?.[0] || 'pass';

  // Policy failure forces at least "fail"
  if (!policyValid) {
    floorVerdict = 'fail';
    downgrade_reasons.push('policy validation failed');
  }

  // The verified verdict is the worse of proposed and floor
  // (we never upgrade, so if proposed is worse than floor, keep proposed)
  if (proposed && VERDICT_RANK[proposed] == null) {
    downgrade_reasons.push('verdict: unrecognized proposed verdict "' + proposed + '", treating as fail');
  }
  if (!proposed) {
    downgrade_reasons.push('verdict: no proposed verdict provided, defaulting to fail');
  }
  const proposedRank = proposed ? (VERDICT_RANK[proposed] ?? VERDICT_RANK.fail) : VERDICT_RANK.fail;
  const floorRank = VERDICT_RANK[floorVerdict];

  let verified;
  if (floorRank < proposedRank) {
    // Floor is worse (lower rank = more severe) — downgrade
    verified = floorVerdict;
    if (proposed && proposed !== floorVerdict) {
      downgrade_reasons.push(
        `scenario/policy evidence requires "${floorVerdict}" but source proposed "${proposed}"`
      );
    }
  } else {
    // Proposed is same or worse — keep proposed (never upgrade)
    verified = proposed || 'fail';
  }

  return {
    verified,
    downgraded: proposed != null && VERDICT_RANK[verified] < VERDICT_RANK[proposed],
    downgrade_reasons
  };
}
