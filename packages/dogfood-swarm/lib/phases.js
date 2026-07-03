/**
 * phases.js — The single ordered source of truth for the ten swarm phases.
 *
 * Before this module, three operator-facing surfaces (the cmdDispatch bad-args
 * usage, the top-level --help Phases block, and the DISPATCH_INVALID_PHASE
 * hint) each carried a hand-maintained phase literal, and two of them printed
 * the ten phases in a DIFFERENT order — so which sequence an operator read
 * depended on which command printed it. dispatch.js's own AUDIT_PHASES /
 * AMEND_PHASES validation arrays were a fourth private copy. This module owns
 * the ordered enumeration; every render site and the validation gate consume
 * it, so the enumeration and order provably cannot drift.
 *
 * Order: all AUDIT phases first, then all AMEND phases — the grouping the
 * help block, README, and error-render hint already agreed on. (This is NOT
 * the progression order in advance.js's PHASE_MAP, which interleaves
 * audit→amend→audit; that map keys the state machine, this array keys the
 * operator-facing enumeration.)
 */

export const AUDIT_PHASES = [
  'health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit',
];

export const AMEND_PHASES = [
  'health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute',
];

export const ALL_PHASES = [...AUDIT_PHASES, ...AMEND_PHASES];

/** The comma-joined flat enumeration for single-line surfaces (usage, hint). */
export function renderPhaseList() {
  return ALL_PHASES.join(', ');
}

/**
 * The two-column audit|amend block for the --help Phases section. Each row
 * pairs the i-th audit phase with the i-th amend phase, left-column width
 * derived from the longest audit phase so the amend column stays aligned.
 *
 * @param {string} [indent] — leading whitespace per row.
 * @returns {string} — newline-joined rows (no trailing newline).
 */
export function renderPhaseColumns(indent = '  ') {
  const colWidth = Math.max(...AUDIT_PHASES.map(p => p.length));
  return AUDIT_PHASES
    .map((audit, i) => `${indent}${audit.padEnd(colWidth)}   ${AMEND_PHASES[i]}`)
    .join('\n');
}
