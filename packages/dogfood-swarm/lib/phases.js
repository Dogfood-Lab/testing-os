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
 * DISCLOSED EXCEPTION (F-274e7ac5, updated F-ab4fbab0 wave 43): commands/
 * collect.js — which is ALSO a validation gate consulted for phase-shape
 * decisions (its `isAudit`/`isAmend` branching) — declares its OWN local
 * `const AUDIT_PHASES = [...]` / `const AMEND_PHASES = [...]` literals
 * rather than importing from this module. The two arrays match today
 * (byte-for-byte compared), so there is no live behavioral bug, but this
 * file's enumeration and collect.js's copy are two independently-typed
 * sources that CAN desync on a future edit to either — "provably cannot
 * drift" is true only of the dispatch.js import path, not of every
 * phase-consuming call site in the package, and is disclosed here rather
 * than left as an overclaim (this repo's own standing rule: unsoundness
 * must be disclosed, not merely absent from the file that would reveal it).
 * collect.js is owned by a different domain (swarm-cp-verbs) than this file
 * (swarm-cp-core), so the mechanical fix — importing AUDIT_PHASES/
 * AMEND_PHASES here and deleting collect.js's local literal — is that
 * domain's edit to make, not this file's.
 *
 * F-ab4fbab0 CORRECTION (wave 43): this paragraph previously named
 * collect.js as though it were the only such call site, but
 * commands/revalidate.js carried the IDENTICAL local
 * `AUDIT_PHASES`/`AMEND_PHASES` literal pair (also byte-for-byte matching,
 * also undisclosed) — a second instance of the same drift-risk this
 * paragraph exists to name, missed by the paragraph's own prior wording.
 * Per this wave's cross-domain coordination, swarm-cp-verbs' revalidate.js
 * is landing the import-from-lib/phases.js fix THIS SAME WAVE, leaving
 * collect.js as the one remaining disclosed exception once both lanes'
 * work merges — VERIFIED this wave (grep, this worktree, zero repo writes
 * beyond this comment): exactly three files in packages/dogfood-swarm
 * declare an `AUDIT_PHASES =` / `AMEND_PHASES =` literal array —
 * lib/phases.js (this file, canonical), commands/collect.js, and
 * commands/revalidate.js — no fourth site exists. AS OF THIS COMMIT, in
 * THIS worktree, commands/revalidate.js still carries its own local copy
 * (swarm-cp-core's worktree cannot observe swarm-cp-verbs' parallel,
 * isolated edit before merge) — this paragraph states the coordinated
 * POST-merge truth, not a claim about this commit's tree in isolation. If
 * revalidate.js's fix does not land as coordinated, collect.js is NOT the
 * only remaining exception, and this paragraph needs a further correction
 * at merge reconciliation.
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
