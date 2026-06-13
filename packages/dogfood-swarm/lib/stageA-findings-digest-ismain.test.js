/**
 * stageA-findings-digest-ismain.test.js
 *
 * d4-swarm-core-003 (Stage A amend wave):
 *
 * findings-digest.js detected direct CLI execution with a string-concatenated
 * file:// compare:
 *   import.meta.url === `file://${entry.replace(/\\/g,'/')}`
 * On Windows import.meta.url is `file:///E:/...` (THREE slashes + drive letter)
 * while `file://${entry}` yields `file://E:/...` (TWO slashes), so the primary
 * equality disjunct is ALWAYS false on win32. The CLI only ran because of a
 * brittle `entry?.endsWith('findings-digest.js')` fallback that also misfires
 * for any argv[1] path ending in that basename from another directory.
 *
 * The fix adopts the portable fileURLToPath/resolve form the sibling
 * persist-results.js:202 already uses, exposed here as the pure helper
 * `isMainEntry(metaUrl, argv1)` so the platform-correctness invariant is
 * directly testable without spawning a subprocess.
 *
 * Both halves of the invariant:
 *   1. A Windows file:///DRIVE:/... URL matches its own argv[1] path (the case
 *      the old string-concat compare broke).
 *   2. A non-matching argv[1] (different file) does NOT report main — proving
 *      the helper is a real equality, not the imprecise endsWith fallback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { isMainEntry } from './findings-digest.js';

describe('findings-digest isMainEntry — d4-swarm-core-003 platform-correct main detection', () => {
  it('reports main when argv[1] resolves to the same file as import.meta.url (this file)', () => {
    // The canonical positive case: the module URL and the argv path point at the
    // SAME file. On win32 this is the file:///E:/... vs E:\... case the old
    // string-concat compare silently failed.
    const metaUrl = import.meta.url;
    const argv1 = resolve(import.meta.dirname, 'findings-digest.js');
    // Build a URL whose path is this argv1, to mirror what `node findings-digest.js`
    // produces: import.meta.url === pathToFileURL(argv1).href.
    const selfUrl = pathToFileURL(argv1).href;
    assert.equal(isMainEntry(selfUrl, argv1), true,
      'a file launched directly must be detected as main on every platform');
    // metaUrl is THIS test file — argv1 is findings-digest.js — must NOT match.
    assert.equal(isMainEntry(metaUrl, argv1), false,
      'a different module URL must not report the digest as main');
  });

  it('does NOT report main for an argv[1] that merely shares the basename from another dir', () => {
    // Regression guard for the old endsWith('findings-digest.js') fallback: a
    // path in a DIFFERENT directory that ends in the same basename must not be
    // mistaken for the entry module.
    const argv1 = resolve(import.meta.dirname, 'findings-digest.js');
    const selfUrl = pathToFileURL(argv1).href;
    const otherDirArgv = resolve(import.meta.dirname, 'some', 'other', 'findings-digest.js');
    assert.equal(isMainEntry(selfUrl, otherDirArgv), false,
      'a same-basename path from another directory must not report main');
  });

  it('returns false (not a throw) when argv[1] is undefined', () => {
    // `node --eval` importing the module leaves argv[1] undefined — must not
    // throw at module-load time.
    assert.equal(isMainEntry(import.meta.url, undefined), false);
  });
});
