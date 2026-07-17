/**
 * normalize-path.test.js — F-d656acc4 / F-swarmcpcore-008: direct pin on the
 * shared leaf helper extracted from lib/fingerprint.js's private
 * normalizePath and commands/collect.js's private normalizeFilePathForGlobMatch
 * (confirmed byte-identical transforms before this extraction).
 *
 * This module now has (or will soon have, once swarm-cp-verbs adopts it in
 * commands/collect.js) two importers under two different local aliases —
 * neither of their existing test suites (fingerprint-normalize-path-slashes
 * .test.js here, collect.js's own sibling in swarm-cp-verbs) exercises the
 * shared module directly by its OWN export name. This file is that direct
 * pin, independent of either caller, covering every transform F-c63da27b's
 * original fix documented plus the empty/falsy short-circuit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFilePathForGlobMatch } from './normalize-path.js';

/** @pins F-d656acc4 */
describe('normalizeFilePathForGlobMatch — shared path normalization (F-d656acc4)', () => {
  it('converts backslashes to forward slashes', () => {
    assert.equal(normalizeFilePathForGlobMatch('packages\\dogfood-swarm\\lib\\foo.js'), 'packages/dogfood-swarm/lib/foo.js');
  });

  it('collapses repeated internal slashes', () => {
    assert.equal(normalizeFilePathForGlobMatch('packages//dogfood-swarm/lib/foo.js'), 'packages/dogfood-swarm/lib/foo.js');
  });

  it('strips a leading "./"', () => {
    assert.equal(normalizeFilePathForGlobMatch('./lib/foo.js'), 'lib/foo.js');
  });

  it('collapses a leading ".//" to a clean path (no stray leading slash)', () => {
    // F-c63da27b: repeated-slash collapse MUST run before the leading-'./'
    // strip, or './/lib/foo.js' would strip to '/lib/foo.js' — a stray
    // leading slash the single-pass leading-dot strip alone cannot remove.
    assert.equal(normalizeFilePathForGlobMatch('.//lib/foo.js'), 'lib/foo.js');
  });

  it('strips a trailing slash', () => {
    assert.equal(normalizeFilePathForGlobMatch('lib/foo.js/'), 'lib/foo.js');
  });

  it('lowercases the result', () => {
    assert.equal(normalizeFilePathForGlobMatch('Lib/Foo.JS'), 'lib/foo.js');
  });

  it('applies every transform together on one adversarial path', () => {
    assert.equal(
      normalizeFilePathForGlobMatch('.\\\\Packages//DogfoodSwarm\\Lib\\Foo.JS/'),
      'packages/dogfoodswarm/lib/foo.js',
    );
  });

  it('returns "" for falsy input (undefined, null, empty string) without throwing', () => {
    assert.equal(normalizeFilePathForGlobMatch(undefined), '');
    assert.equal(normalizeFilePathForGlobMatch(null), '');
    assert.equal(normalizeFilePathForGlobMatch(''), '');
  });
});
