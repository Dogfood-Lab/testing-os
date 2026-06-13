/**
 * stageA-rewind-path-case.test.js
 *
 * Stage A amend — d5-swarm-cli-006 (MEDIUM, was LOW; verifier SEVERITY_UNDERRATED).
 *
 * rewind.js normalizePathForMatch() unconditionally lowercased the path
 * (`.toLowerCase()`) when scoping the rewind DB-abort to the run(s) owning
 * the cwd. The justification (Windows case-insensitive filesystems) is valid
 * on win32, but on Linux (the CI environment) paths are case-sensitive: two
 * runs whose local_path differ ONLY by case (e.g. /work/MyRepo vs
 * /work/myrepo — genuinely distinct dirs on a case-sensitive FS) folded to
 * the SAME key, so a rewind of one would match BOTH and lawfully-abort the
 * other's in-flight waves/agent_runs (status → aborted_for_rewind, which is
 * TERMINAL). That is a narrow reintroduction of the exact cli-001 concern
 * normalizePathForMatch exists to fix (NOT aborting OTHER runs' rows).
 *
 * The fix gates the case-fold on platform: fold ONLY on win32 (case-
 * insensitive FS); preserve case on POSIX (case-sensitive FS). The comparator
 * now takes an explicit `platform` argument (default process.platform) so this
 * test pins BOTH branches deterministically regardless of the host OS — using
 * non-existent paths so the function takes the resolvePath fallback (no
 * realpath case-folding for paths that exist on a case-insensitive host).
 *
 * Test invariants:
 *   1. On POSIX, two paths differing only by case produce DIFFERENT keys
 *      (case preserved) — so a rewind of /work/MyRepo would NOT match
 *      /work/myrepo's run. This is the bug the unconditional lowercase had.
 *   2. On win32, the same two paths produce the SAME key (case folded) —
 *      preserving the legitimate Windows case-insensitive matching.
 *   3. Trailing-separator normalization still applies on both platforms.
 *   4. An exact-case match still matches on both platforms (no over-rejection).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePathForMatch } from './commands/rewind.js';

describe('d5-swarm-cli-006 — normalizePathForMatch is platform-aware (no blind lowercase)', () => {
  // Use paths that do NOT exist on disk so the function falls back to
  // resolvePath() (realpathSync throws → catch → resolvePath). This isolates
  // the case-fold decision from any host-FS realpath behavior.
  const upper = '/work/d5-cli-006-NoSuchDir-MyRepo';
  const lower = '/work/d5-cli-006-nosuchdir-myrepo';

  it('POSIX: paths differing only by case are DISTINCT (case preserved)', () => {
    const a = normalizePathForMatch(upper, 'linux');
    const b = normalizePathForMatch(lower, 'linux');
    assert.notEqual(a, b,
      'd5-cli-006 regression: blind lowercase folded two case-distinct POSIX paths into one key — a rewind of one would abort the other run');
  });

  it('win32: paths differing only by case are the SAME (case folded)', () => {
    const a = normalizePathForMatch(upper, 'win32');
    const b = normalizePathForMatch(lower, 'win32');
    assert.equal(a, b,
      'win32 must keep case-insensitive matching (its FS is case-insensitive)');
  });

  it('POSIX: an exact-case match still matches (guard does not over-reject)', () => {
    assert.equal(
      normalizePathForMatch('/work/Exact/Case', 'linux'),
      normalizePathForMatch('/work/Exact/Case', 'linux'),
    );
  });

  it('trailing separators are stripped on BOTH platforms before comparison', () => {
    assert.equal(
      normalizePathForMatch('/work/repo/', 'linux'),
      normalizePathForMatch('/work/repo', 'linux'),
    );
    assert.equal(
      normalizePathForMatch('/work/Repo/', 'win32'),
      normalizePathForMatch('/work/repo', 'win32'),
      'win32 still folds case AND strips trailing sep',
    );
  });

  it('empty / non-string input returns the empty key on both platforms', () => {
    assert.equal(normalizePathForMatch('', 'linux'), '');
    assert.equal(normalizePathForMatch(null, 'win32'), '');
  });
});
