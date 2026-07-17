/**
 * notes.js — T3 operator-notes validation (F-93d58082,
 * docs/trajectory-and-closure.dispatch.md).
 *
 * Operator notes are the ONLY human-authored section of the compiled
 * roadmap artifact. T3's bound: at most MAX_OPERATOR_NOTES, each shaped
 * `{ kind: theme|open-question|invariant, text, expires?, enforced_by? }`.
 * A `kind: 'invariant'` note MUST carry `enforced_by`, and this validator
 * MUST confirm the referenced path actually exists on disk — "a lesson
 * without a mechanical verifier is not persisted as a lesson" (Project Vend,
 * cited in the dispatch's own Q1).
 *
 * FAIL-CLOSED-AT-THE-RIGHT-TIME, mirroring db/migrate.js's
 * assertManifestShapesRecognized/assertManifestVersionInvariant (both run at
 * MODULE LOAD, not first use, and name the exact defect): this validator
 * runs at COMPILE TIME, not note-authoring time, because a gate/test file a
 * note references can be renamed or deleted AFTER the note was written —
 * validating only when the note is authored would miss that.
 *
 * SCOPE NARROWING, DISCLOSED (not a silent gap): T3's literal shape allows
 * `expires: <N runs | date>`. This module supports ONLY the ISO-date form
 * (`YYYY-MM-DD`) in this pass. The "N runs" form needs an origin-run anchor
 * the note shape itself does not carry (`{kind, text, expires,
 * enforced_by}` has no "authored at run X" field to count forward from) —
 * inventing one now would be new, unrequested machinery a future maintainer
 * would have to unwind if the real answer turns out different. A numeric
 * `expires` is therefore rejected with an explicit reason rather than
 * silently mis-evaluated. Naming this narrowing here, and again wherever
 * compile.js surfaces it, is the honest-partial-beats-overclaim discipline
 * this repo's own ethos (swarms/CLAUDE.md) asks for.
 *
 * WHERE NOTES COME FROM (also disclosed, also deferred): this module is a
 * pure function over an already-parsed `notes` array — it does not read a
 * file. T1 says the compiler works "from the control-plane DB and git
 * alone," and operator notes are explicitly the one HUMAN-authored section,
 * which implies a git-tracked file an operator hand-maintains (the same
 * shape as scripts/regression-pin-allowlist.json). This pass does not pin
 * that file's path or format — that is commands/roadmap.js's call
 * (swarm-cp-verbs' domain, the CLI verb wrapping compileRoadmap), which can
 * read whatever file it chooses and pass the parsed array in here.
 */

import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

/** Q1 (Reflexion, arXiv:2303.11366): bounded lesson buffers beat unbounded. */
export const MAX_OPERATOR_NOTES = 7;

export const NOTE_KINDS = Object.freeze(['theme', 'open-question', 'invariant']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {Array<object>} notes — raw operator notes as authored
 * @param {object} opts
 * @param {string} opts.repoRoot — absolute path `enforced_by` is resolved
 *   against (repo-relative paths only — see the isAbsolute rejection below)
 * @param {Date} [opts.now] — injectable clock for deterministic expiry tests;
 *   defaults to `new Date()`
 * @returns {{
 *   accepted: object[],
 *   expired: object[],
 *   dropped_invalid_notes: Array<{ note: object, reason: string }>,
 * }} — all three arrays preserve INPUT order (operator-authored, already
 *   small; no re-sort imposed). `accepted` is what the compiled artifact
 *   carries forward; `expired` and `dropped_invalid_notes` are surfaced LOUD
 *   in the artifact, never silently omitted (T3's own EXPIRED precedent,
 *   extended by F-93d58082 to the enforced_by-missing case).
 * @throws {Error} when `notes.length > MAX_OPERATOR_NOTES` — a hard cap
 *   violation is an authoring error to fix before compiling, not something
 *   to silently truncate (which would drop an operator's note with no
 *   signal at all).
 */
export function validateOperatorNotes(notes, opts = {}) {
  const { repoRoot, now = new Date() } = opts;
  const input = Array.isArray(notes) ? notes : [];

  if (input.length > MAX_OPERATOR_NOTES) {
    throw new Error(
      `validateOperatorNotes: ${input.length} operator notes supplied, exceeds the max of ` +
      `${MAX_OPERATOR_NOTES} (Q1 Reflexion-cited bound, docs/trajectory-and-closure.dispatch.md T3). ` +
      `Trim the operator-notes source before compiling.`,
    );
  }

  const accepted = [];
  const expired = [];
  const dropped_invalid_notes = [];

  for (const note of input) {
    if (!note || typeof note !== 'object') {
      dropped_invalid_notes.push({ note, reason: 'note is not an object' });
      continue;
    }
    if (!NOTE_KINDS.includes(note.kind)) {
      dropped_invalid_notes.push({
        note,
        reason: `unrecognized kind ${JSON.stringify(note.kind)} — must be one of ${NOTE_KINDS.join(', ')}`,
      });
      continue;
    }
    if (typeof note.text !== 'string' || note.text.length === 0) {
      dropped_invalid_notes.push({ note, reason: 'missing or empty text' });
      continue;
    }

    if (note.kind === 'invariant') {
      if (!note.enforced_by || typeof note.enforced_by !== 'string') {
        dropped_invalid_notes.push({
          note,
          reason: "kind 'invariant' requires enforced_by (a repo-relative gate/test path) — "
            + 'a lesson without a mechanical verifier is not persisted as a lesson (Project Vend)',
        });
        continue;
      }
      if (isAbsolute(note.enforced_by)) {
        dropped_invalid_notes.push({
          note,
          reason: `enforced_by must be a repo-relative path, got an absolute path: ${note.enforced_by}`,
        });
        continue;
      }
      // F-96e2d1a5: repoRoot is documented as OPTIONAL at the compileRoadmap
      // level (this module's own header: "Omitted -> both degrade to their
      // own documented unavailable/zero-signal shape rather than throwing"),
      // but join(undefined, ...) throws a raw TypeError instead of that
      // documented shape — the exact sibling bug drain.js's
      // compileGrandfatheredManifestDrain already guards against (see that
      // module's F-874c0683 comment). Sweep result: attention.js's repoPath
      // use is already ternary-guarded and drain.js's OTHER function
      // (compileAuthoredDrainState) already checks its path input before
      // join(); this was the one unguarded instance in lib/roadmap/. A raw
      // crash here does not just drop THIS note — it propagates straight
      // through compileRoadmap and kills the ENTIRE artifact compile
      // (findings, recurrence, attention, drain_queue included), so this
      // guards the SAME class as drain.js's, at the point where an invariant
      // note's enforced_by can no longer be verified without a real path.
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
        dropped_invalid_notes.push({
          note,
          reason: 'enforced_by cannot be verified without repoRoot — repoRoot was omitted for this compile',
        });
        continue;
      }
      if (!existsSync(join(repoRoot, note.enforced_by))) {
        dropped_invalid_notes.push({
          note,
          reason: `enforced_by path does not exist on disk: ${note.enforced_by}`,
        });
        continue;
      }
    }

    if (note.expires != null) {
      if (typeof note.expires !== 'string' || !ISO_DATE_RE.test(note.expires)) {
        dropped_invalid_notes.push({
          note,
          reason: `expires must be an ISO date (YYYY-MM-DD) in this pass — got ${JSON.stringify(note.expires)} `
            + '(the "N runs" form T3 also allows is not yet implemented; see this module\'s header)',
        });
        continue;
      }
      const expiresAt = new Date(`${note.expires}T00:00:00Z`);
      if (expiresAt.getTime() <= now.getTime()) {
        expired.push(note);
        continue;
      }
    }

    accepted.push(note);
  }

  return { accepted, expired, dropped_invalid_notes };
}
