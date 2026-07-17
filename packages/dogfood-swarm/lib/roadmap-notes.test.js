/**
 * roadmap-notes.test.js — F-93d58082 (T3): validateOperatorNotes' four
 * independently-testable refusal/expiry properties, pinned before the
 * compiler that consumes it exists — "a verification that cannot fail is
 * not a verification" (swarms/CLAUDE.md).
 *
 * Lives flat in lib/ (not lib/roadmap/*.test.js) — package.json's test
 * script ("*.test.js" "lib/*.test.js") does not reach two levels deep, the
 * same test-discovery constraint lib/migrate-current-version-unused.test.js
 * documents for db/migrate.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateOperatorNotes, MAX_OPERATOR_NOTES, NOTE_KINDS } from './roadmap/notes.js';

function withRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'roadmap-notes-'));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** @pins F-93d58082 */
describe('validateOperatorNotes — the 7-note cap (F-93d58082, boundary-value pair)', () => {
  it('accepts EXACTLY 7 notes', () => {
    withRepoRoot((repoRoot) => {
      const notes = Array.from({ length: MAX_OPERATOR_NOTES }, (_, i) => ({ kind: 'theme', text: `note ${i}` }));
      const result = validateOperatorNotes(notes, { repoRoot });
      assert.equal(result.accepted.length, 7);
    });
  });

  it('refuses EXACTLY 8 notes (throws, does not silently truncate to 7)', () => {
    withRepoRoot((repoRoot) => {
      const notes = Array.from({ length: MAX_OPERATOR_NOTES + 1 }, (_, i) => ({ kind: 'theme', text: `note ${i}` }));
      assert.throws(
        () => validateOperatorNotes(notes, { repoRoot }),
        /exceeds the max of 7/,
      );
    });
  });
});

describe('validateOperatorNotes — invariant notes require a real enforced_by (F-93d58082)', () => {
  it('an invariant note with no enforced_by at all is dropped and listed, not silently kept', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes(
        [{ kind: 'invariant', text: 'the regression pin gate must stay AST-based' }],
        { repoRoot },
      );
      assert.equal(result.accepted.length, 0);
      assert.equal(result.dropped_invalid_notes.length, 1);
      assert.match(result.dropped_invalid_notes[0].reason, /requires enforced_by/);
    });
  });

  /** @pins F-96e2d1a5 */
  it('degrades to a dropped-note reason (never throws) when repoRoot is omitted and an invariant note is present — the unfixed sibling of drain.js\'s repoRoot guard (F-874c0683), mirroring roadmap-drain.test.js\'s own repoRoot-omitted fixture', () => {
    assert.doesNotThrow(() => {
      const result = validateOperatorNotes(
        [{ kind: 'invariant', text: 'x', enforced_by: 'scripts/some-gate.mjs' }],
        {},
      );
      assert.equal(result.accepted.length, 0);
      assert.equal(result.dropped_invalid_notes.length, 1);
      assert.match(result.dropped_invalid_notes[0].reason, /cannot be verified without repoRoot/);
    });
  });

  it('an invariant note whose enforced_by names a REAL file is accepted', () => {
    withRepoRoot((repoRoot) => {
      writeFileSync(join(repoRoot, 'real-test.test.js'), '// a real file\n');
      const result = validateOperatorNotes(
        [{ kind: 'invariant', text: 'covered', enforced_by: 'real-test.test.js' }],
        { repoRoot },
      );
      assert.equal(result.accepted.length, 1);
      assert.equal(result.dropped_invalid_notes.length, 0);
    });
  });

  it('an invariant note whose enforced_by names a DELETED/nonexistent path is dropped and listed', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes(
        [{ kind: 'invariant', text: 'covered once, not anymore', enforced_by: 'deleted-test.test.js' }],
        { repoRoot },
      );
      assert.equal(result.accepted.length, 0);
      assert.equal(result.dropped_invalid_notes.length, 1);
      assert.match(result.dropped_invalid_notes[0].reason, /does not exist on disk/);
    });
  });

  it('rejects an absolute enforced_by path even if it happens to exist', () => {
    withRepoRoot((repoRoot) => {
      const absPath = join(repoRoot, 'abs-test.test.js');
      writeFileSync(absPath, '// exists\n');
      const result = validateOperatorNotes(
        [{ kind: 'invariant', text: 'covered', enforced_by: absPath }],
        { repoRoot },
      );
      assert.equal(result.accepted.length, 0);
      assert.match(result.dropped_invalid_notes[0].reason, /must be a repo-relative path/);
    });
  });

  it('theme and open-question notes do NOT require enforced_by', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes(
        [
          { kind: 'theme', text: 'a theme note' },
          { kind: 'open-question', text: 'an open question' },
        ],
        { repoRoot },
      );
      assert.equal(result.accepted.length, 2);
    });
  });
});

describe('validateOperatorNotes — expiry (F-93d58082, both halves in one test per this repo\'s own gate-red-pair convention)', () => {
  it('a note past its expires date is dropped from accepted AND listed in expired, with identifying detail', () => {
    withRepoRoot((repoRoot) => {
      const now = new Date('2026-07-17T00:00:00Z');
      const note = { kind: 'theme', text: 'stale reminder', expires: '2026-01-01' };
      const result = validateOperatorNotes([note], { repoRoot, now });
      assert.equal(result.accepted.length, 0, 'an expired note must NOT survive into accepted');
      assert.equal(result.expired.length, 1, 'an expired note must be reported, not silently dropped');
      assert.equal(result.expired[0].text, 'stale reminder', 'the expired listing must carry enough detail to audit what was dropped');
    });
  });

  it('a note with a FUTURE expires date is accepted', () => {
    withRepoRoot((repoRoot) => {
      const now = new Date('2026-07-17T00:00:00Z');
      const result = validateOperatorNotes(
        [{ kind: 'theme', text: 'still relevant', expires: '2027-01-01' }],
        { repoRoot, now },
      );
      assert.equal(result.accepted.length, 1);
      assert.equal(result.expired.length, 0);
    });
  });

  it('a note with NO expires field never expires', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes([{ kind: 'theme', text: 'evergreen' }], { repoRoot });
      assert.equal(result.accepted.length, 1);
    });
  });

  it('a numeric "N runs" expires form is rejected as not-yet-implemented, not silently mis-evaluated', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes(
        [{ kind: 'theme', text: 'N-runs form', expires: 5 }],
        { repoRoot },
      );
      assert.equal(result.accepted.length, 0);
      assert.equal(result.dropped_invalid_notes.length, 1);
      assert.match(result.dropped_invalid_notes[0].reason, /not yet implemented/);
    });
  });
});

describe('validateOperatorNotes — malformed shapes', () => {
  it('rejects a note with an unrecognized kind', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes([{ kind: 'not-a-real-kind', text: 'x' }], { repoRoot });
      assert.equal(result.accepted.length, 0);
      assert.match(result.dropped_invalid_notes[0].reason, /unrecognized kind/);
    });
  });

  it('rejects a note with missing/empty text', () => {
    withRepoRoot((repoRoot) => {
      const result = validateOperatorNotes([{ kind: 'theme', text: '' }], { repoRoot });
      assert.equal(result.accepted.length, 0);
      assert.match(result.dropped_invalid_notes[0].reason, /missing or empty text/);
    });
  });

  it('an empty/absent notes array is accepted trivially', () => {
    withRepoRoot((repoRoot) => {
      assert.deepEqual(validateOperatorNotes([], { repoRoot }), { accepted: [], expired: [], dropped_invalid_notes: [] });
      assert.deepEqual(validateOperatorNotes(undefined, { repoRoot }), { accepted: [], expired: [], dropped_invalid_notes: [] });
    });
  });

  it('NOTE_KINDS exports exactly the three kinds T3 specifies', () => {
    assert.deepEqual(NOTE_KINDS, ['theme', 'open-question', 'invariant']);
  });
});
