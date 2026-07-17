/**
 * fingerprint-normalize-path-slashes.test.js — F-c63da27b: normalizePath (the
 * path component of computeFingerprint's cross-wave dedup key) collapses
 * case, backslash-vs-forward-slash, and a leading './' — but NOT a trailing
 * slash or a doubled internal slash. Two spellings of the identical
 * (category, rule_id, symbol, line) finding therefore fingerprint
 * differently, which would silently fail cross-wave dedup: the same real
 * defect could double-count as both a stale row under one fingerprint and a
 * fresh 'new' row under the other — the exact B-BACK-002 class of bug
 * fingerprint.js's own header names as the reason description was excluded
 * from the fingerprint in the first place.
 *
 * Proven directly against computeFingerprint (the public API — normalizePath
 * itself is not exported), against the exact spellings and fingerprint
 * values the finding measured: 'packages/dogfood-swarm/lib/foo.js',
 * 'packages/dogfood-swarm/Lib/Foo.JS', './packages/dogfood-swarm/lib/foo.js',
 * and 'packages\dogfood-swarm\lib\foo.js' all already collapsed to the same
 * fingerprint (a0190167e6d2878549e983f9...) — those four are regression
 * guards here, not new coverage. The trailing-slash and doubled-slash
 * spellings did NOT collapse pre-fix (d77249b0... and b8b1569a...
 * respectively) — those two are the new coverage this finding requires.
 *
 * options.sourceText is intentionally omitted from every call below: with it
 * present, LOCATION becomes a context-hash of surrounding source content
 * (fp-p-005), which is orthogonal to path normalization and would conflate
 * two different mechanisms. Omitting it isolates normalizePath's behavior
 * exactly the way the finding's own proof did.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFingerprint } from './fingerprint.js';

const BASE = {
  category: 'bug',
  rule_id: 'R1',
  symbol: 'doThing',
  line: 42,
};

describe('computeFingerprint — normalizePath spelling equivalence (F-c63da27b)', () => {
  const canonical = computeFingerprint({ ...BASE, file: 'packages/dogfood-swarm/lib/foo.js' });

  it('case difference already collapsed (regression guard)', () => {
    assert.equal(computeFingerprint({ ...BASE, file: 'packages/dogfood-swarm/Lib/Foo.JS' }), canonical);
  });

  it('leading ./ already collapsed (regression guard)', () => {
    assert.equal(computeFingerprint({ ...BASE, file: './packages/dogfood-swarm/lib/foo.js' }), canonical);
  });

  it('backslash separators already collapsed (regression guard)', () => {
    assert.equal(computeFingerprint({ ...BASE, file: 'packages\\dogfood-swarm\\lib\\foo.js' }), canonical);
  });

  it('a TRAILING slash now collapses to the same fingerprint', () => {
    assert.equal(computeFingerprint({ ...BASE, file: 'packages/dogfood-swarm/lib/foo.js/' }), canonical);
  });

  it('a DOUBLED internal slash now collapses to the same fingerprint', () => {
    assert.equal(computeFingerprint({ ...BASE, file: 'packages//dogfood-swarm/lib/foo.js' }), canonical);
  });

  it('trailing + doubled + case combined still collapse to the same fingerprint', () => {
    assert.equal(computeFingerprint({ ...BASE, file: 'Packages//Dogfood-Swarm/Lib/Foo.JS/' }), canonical);
  });

  it('a leading doubled slash (a natural consequence of collapsing repeated slashes generically) also collapses', () => {
    assert.equal(computeFingerprint({ ...BASE, file: './/packages/dogfood-swarm/lib/foo.js' }), canonical);
  });

  it('DIFFERENT (category, rule_id, symbol, line) still fingerprint differently — normalization is not over-collapsing', () => {
    const different = computeFingerprint({ ...BASE, line: 99, file: 'packages/dogfood-swarm/lib/foo.js' });
    assert.notEqual(different, canonical);
  });
});
