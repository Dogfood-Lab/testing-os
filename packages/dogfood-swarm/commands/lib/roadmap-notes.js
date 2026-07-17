/**
 * roadmap-notes.js — T3 operator-notes validation for the trajectory layer
 * (docs/trajectory-and-closure.dispatch.md, Feature 1).
 *
 * Deliberately SEAM-FREE: this module has zero dependency on swarm-cp-core's
 * lib/roadmap/compiler.js (which lands in ITS OWN worktree this same wave —
 * does not exist in this worktree yet). Every byte of logic here is pure
 * validation over a JSON array plus one filesystem existence check
 * (`enforced_by` must resolve to a real file) — a genuinely CLI-layer
 * concern (F-338c8c46's own recommendation: "enforcing T3's invariants AT
 * COMPILE TIME as fail-loud CLI errors, not silent clamping"), independent
 * of how core's compiler gathers the DB-derived factual sections. Splitting
 * it out of commands/roadmap.js (which DOES import the not-yet-real core
 * module, and is therefore red-in-isolation until merge) means this
 * substantial, novel piece of the T1 CLI surface is real, tested, and green
 * TODAY rather than hostage to the seam.
 *
 * Operator-notes seed shape (T3): a JSON array (or `{"notes": [...]}`) of
 * `{ kind: 'theme'|'open-question'|'invariant', text: string,
 * expires?: string, enforced_by?: string }`. At most 7 notes (T1's Q1
 * grounding: Reflexion's bounded lesson buffers, arXiv:2303.11366). A note
 * declaring `kind: 'invariant'` MUST carry `enforced_by`, and the referenced
 * gate/test path must resolve to a real file on disk — "a lesson without a
 * mechanical verifier is not persisted as a lesson" (Q1: Voyager,
 * arXiv:2305.16291; Project Vend, anthropic.com/research/project-vend-1).
 *
 * SCOPE DISCLOSURE (wave 39, honest partial not overclaim — swarms/CLAUDE.md
 * "honesty is a feature of the artifact"): T3 describes `expires` as either
 * an ISO date OR a relative "<N runs>" form. Only the ISO-date form is
 * implemented this wave. Resolving "<N runs>" needs a durable "which run
 * authored this note" anchor this wave does not build (no per-note
 * authored-at-run stamp is persisted anywhere) — faking a partial
 * implementation of it would be the exact "claim shrinking to the truth"
 * inversion this repo's own ethos warns against, so it is named here as a
 * disclosed gap, not silently dropped. A note using the "<N runs>" shorthand
 * today is treated as non-expiring (never silently misread as an ISO date —
 * `Date.parse` on a string like "3 runs" returns NaN, which this module's
 * own `splitExpiredNotes` explicitly treats as "cannot compute expiry, so
 * don't expire it").
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MAX_OPERATOR_NOTES = 7;
export const NOTE_KINDS = ['theme', 'open-question', 'invariant'];

/**
 * Plain-Error-with-.code factory, matching this package's established
 * convention (formatError/juryError/verifiedHowError in cli.js) rather than
 * a new class in lib/errors.js (out of this domain's scope this wave —
 * lib/** is swarm-cp-core's exclusive glob).
 */
export function roadmapError(code, message, hint, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.hint = hint;
  Object.assign(e, extra);
  return e;
}

/**
 * Reads + T3-validates the human-authored, git-tracked operator-notes seed.
 * Returns `{ notesPath, notes }` on success (notes: [] when the file does
 * not exist — a fresh repo compiling its FIRST roadmap has none, and that is
 * not an error). Throws a roadmapError for every invariant violation, named
 * per-violation so an operator sees exactly which note and why.
 *
 * @param {string} repoRoot — resolves a relative `enforced_by` path against
 *   this (the audited repo's local_path, per run.local_path)
 * @param {object} [opts]
 * @param {string} [opts.notesPath] — explicit override; defaults to
 *   `<repoRoot>/dogfood/roadmap-notes.json` (F-74ba2c79's own verified-
 *   against-fixture convention; corrected from an earlier
 *   `dogfood/roadmap/operator-notes.json` guess made before that gate test
 *   existed)
 * @param {(path: string) => boolean} [opts.existsSyncFn] — injection seam
 *   for tests; defaults to node:fs existsSync
 * @param {(path: string, encoding: string) => string} [opts.readFileSyncFn]
 * @returns {{ notesPath: string, notes: object[] }}
 */
export function readOperatorNotes(repoRoot, opts = {}) {
  const notesPath = opts.notesPath || resolve(repoRoot, 'dogfood', 'roadmap-notes.json');
  const existsFn = opts.existsSyncFn || existsSync;

  if (!existsFn(notesPath)) return { notesPath, notes: [] };

  const readFn = opts.readFileSyncFn || ((p) => readFileSync(p, 'utf-8'));
  const raw = readFn(notesPath, 'utf-8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw roadmapError(
      'ROADMAP_NOTES_UNPARSEABLE',
      `roadmap: operator-notes seed at ${notesPath} is not valid JSON: ${e.message}`,
      'fix the JSON syntax, or remove the file to compile with zero notes',
      { notesPath }
    );
  }

  const notes = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.notes) ? parsed.notes : null);
  if (notes === null) {
    throw roadmapError(
      'ROADMAP_NOTES_SHAPE_INVALID',
      `roadmap: operator-notes seed at ${notesPath} must be a JSON array (or {"notes": [...]})`,
      'wrap the notes in a top-level array: [{ "kind": "theme", "text": "...", "expires": "2026-12-01" }]',
      { notesPath }
    );
  }

  // T3: at most 7 notes — a hard, fail-loud refusal naming the count, NOT
  // silent clamping/truncation to the first 7.
  if (notes.length > MAX_OPERATOR_NOTES) {
    throw roadmapError(
      'ROADMAP_TOO_MANY_NOTES',
      `roadmap: ${notes.length} operator notes in ${notesPath} exceeds the T3 cap of ${MAX_OPERATOR_NOTES}`,
      `trim the notes seed to ${MAX_OPERATOR_NOTES} or fewer — bounded lesson buffers beat unbounded (Reflexion, arXiv:2303.11366)`,
      { notesPath, count: notes.length }
    );
  }

  notes.forEach((note, i) => validateNote(note, i, notesPath, repoRoot, existsFn));

  return { notesPath, notes };
}

function validateNote(note, i, notesPath, repoRoot, existsFn) {
  if (!note || typeof note !== 'object' || typeof note.text !== 'string' || !note.text.trim()) {
    throw roadmapError(
      'ROADMAP_NOTE_INVALID',
      `roadmap: note[${i}] in ${notesPath} is missing a non-empty "text" field`,
      'every note needs at least { kind, text } — see this file\'s own doc comment for the full shape',
      { notesPath, index: i }
    );
  }
  if (!NOTE_KINDS.includes(note.kind)) {
    throw roadmapError(
      'ROADMAP_NOTE_INVALID_KIND',
      `roadmap: note[${i}] in ${notesPath} has kind '${note.kind}'; expected one of ${NOTE_KINDS.join('|')}`,
      `set "kind" to one of: ${NOTE_KINDS.join(', ')}`,
      { notesPath, index: i }
    );
  }
  // T3: a note claiming `invariant` MUST carry `enforced_by`, and compile
  // verifies the referenced gate/test exists — "a lesson without a
  // mechanical verifier is not persisted as a lesson".
  if (note.kind === 'invariant') {
    if (!note.enforced_by || typeof note.enforced_by !== 'string' || !note.enforced_by.trim()) {
      throw roadmapError(
        'ROADMAP_INVARIANT_NO_ENFORCER',
        `roadmap: note[${i}] in ${notesPath} claims kind='invariant' but has no "enforced_by" gate/test path`,
        'add "enforced_by": "<path to the gate/test file that enforces this>", or downgrade kind to theme/open-question',
        { notesPath, index: i }
      );
    }
    const enforcerPath = resolve(repoRoot, note.enforced_by);
    if (!existsFn(enforcerPath)) {
      throw roadmapError(
        'ROADMAP_ENFORCER_NOT_FOUND',
        `roadmap: note[${i}]'s enforced_by path does not resolve to a real file: ${note.enforced_by}`,
        'point enforced_by at a real, existing gate/test file (relative to the repo root), or downgrade kind to theme/open-question',
        { notesPath, index: i, enforcedBy: note.enforced_by }
      );
    }
  }
}

/**
 * T3: split notes into active vs expired, so compile can list expired notes
 * LOUDLY (never silently omitted). See this file's header for the disclosed
 * "<N runs>" scope gap — a note whose `expires` does not parse as an ISO
 * date (e.g. the "<N runs>" shorthand) is treated as non-expiring rather
 * than silently misread.
 *
 * @param {object[]} notes
 * @param {Date} [now] — injectable for deterministic tests
 * @returns {{ active: object[], expired: object[] }}
 */
export function splitExpiredNotes(notes, now = new Date()) {
  const active = [];
  const expired = [];
  for (const note of notes) {
    const parsed = typeof note.expires === 'string' ? Date.parse(note.expires) : NaN;
    if (!Number.isNaN(parsed) && now.getTime() >= parsed) {
      expired.push(note);
    } else {
      active.push(note);
    }
  }
  return { active, expired };
}
