/**
 * phases.js — The single ordered source of truth for the ten swarm phases.
 *
 * Before this module, three operator-facing surfaces (the cmdDispatch bad-args
 * usage, the top-level --help Phases block, and the DISPATCH_INVALID_PHASE
 * hint) each carried a hand-maintained phase literal, and two of them printed
 * the ten phases in a DIFFERENT order — so which sequence an operator read
 * depended on which command printed it. dispatch.js's own AUDIT_PHASES /
 * AMEND_PHASES validation arrays were a fourth private copy. This module owns
 * the ordered enumeration; dispatch.js imports it directly (see its own
 * `import { AUDIT_PHASES, AMEND_PHASES, ... } from '../lib/phases.js'`), so
 * that render site and the validation gate it drives provably cannot drift.
 *
 * RESOLVED (F-274e7ac5 → F-ab4fbab0 → wave-43 merge): this module is now
 * the SOLE declaration of the phase enumeration. The history, kept because
 * two audits paid for it: commands/collect.js and commands/revalidate.js
 * each carried a private byte-identical `AUDIT_PHASES`/`AMEND_PHASES`
 * literal pair — collect.js's was the disclosed exception (F-274e7ac5),
 * revalidate.js's was the undisclosed sibling the wave-42 confirming audit
 * caught (F-ab4fbab0). At the wave-43 merge the verbs lane deleted BOTH
 * local copies and imported this module (a class fix, going further than
 * the disclosed-exception compromise this paragraph once documented), and
 * lib/phases.test.js's parity gate now enforces the either-imports-or-
 * byte-identical invariant on both files so a future re-introduction of a
 * private copy is caught, not re-disclosed. Sweep result at merge: exactly
 * ONE file in packages/dogfood-swarm declares these literal arrays — this
 * one. "Provably cannot drift" is now true of every phase-consuming call
 * site in the package, not only the dispatch.js import path.
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

/** Run statuses that `swarm advance` can promote into. Not dispatchable. */
export const RUN_STATUSES = ['test', 'treatment', 'complete'];

export function isDispatchablePhase(phase) {
  return ALL_PHASES.includes(phase);
}

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
