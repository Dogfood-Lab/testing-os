/**
 * Integrity helper unit tests — the trust-critical core.
 *
 * Proves the three guarantees the whole tamper-evident chain rests on:
 *   1. canonicalize is INSERTION-ORDER-INDEPENDENT (two objects with the same
 *      key/value content but different key insertion order serialize byte-for-byte
 *      identically). If this were false, the same record could produce two
 *      different digests and the chain would false-positive on tamper.
 *   2. submissionDigest is STABLE and IGNORES the `integrity` block — you cannot
 *      hash the digest into itself, so the digest must be computed over the record
 *      WITHOUT its integrity field. Adding/removing/mutating `integrity` must not
 *      change the digest.
 *   3. GENESIS_DIGEST is 64 hex zeros — the sentinel prev_digest for seq 0.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, submissionDigest, GENESIS_DIGEST } from './lib/integrity.js';

describe('integrity: canonicalize', () => {
  it('is insertion-order-independent (same content, different key order → identical string)', () => {
    const a = { b: 1, a: 2, c: { z: 9, y: 8 } };
    const b = { c: { y: 8, z: 9 }, a: 2, b: 1 };
    assert.equal(canonicalize(a), canonicalize(b));
  });

  it('sorts keys ascending at every depth', () => {
    const obj = { b: 1, a: { d: 4, c: 3 } };
    assert.equal(canonicalize(obj), '{"a":{"c":3,"d":4},"b":1}');
  });

  it('preserves array order (arrays are positional, not sorted)', () => {
    assert.equal(canonicalize({ xs: [3, 1, 2] }), '{"xs":[3,1,2]}');
    // Two arrays with the same elements in different order are NOT equal.
    assert.notEqual(canonicalize({ xs: [1, 2] }), canonicalize({ xs: [2, 1] }));
  });

  it('emits no insignificant whitespace', () => {
    const s = canonicalize({ a: 1, b: [1, 2] });
    assert.ok(!/\s/.test(s), `expected no whitespace, got: ${s}`);
  });

  it('sorts keys of objects nested inside arrays', () => {
    const out = canonicalize({ items: [{ b: 1, a: 2 }] });
    assert.equal(out, '{"items":[{"a":2,"b":1}]}');
  });
});

describe('integrity: submissionDigest', () => {
  it('returns a 64-char lowercase hex string', () => {
    const d = submissionDigest({ run_id: 'r', repo: 'o/r' });
    assert.match(d, /^[0-9a-f]{64}$/);
  });

  it('is stable across insertion order (digest depends on content, not key order)', () => {
    const a = { run_id: 'r1', repo: 'o/r', timing: { finished_at: 't' } };
    const b = { timing: { finished_at: 't' }, repo: 'o/r', run_id: 'r1' };
    assert.equal(submissionDigest(a), submissionDigest(b));
  });

  it('IGNORES the integrity block — adding/changing integrity does not change the digest', () => {
    const base = { run_id: 'r1', repo: 'o/r' };
    const withIntegrity = {
      ...base,
      integrity: { submission_digest: 'f'.repeat(64), prev_digest: GENESIS_DIGEST, seq: 0 },
    };
    assert.equal(submissionDigest(base), submissionDigest(withIntegrity));

    const withDifferentIntegrity = {
      ...base,
      integrity: { submission_digest: '0'.repeat(64), prev_digest: 'a'.repeat(64), seq: 99 },
    };
    assert.equal(submissionDigest(withIntegrity), submissionDigest(withDifferentIntegrity));
  });

  it('does NOT mutate the input record (integrity stripping is on a clone)', () => {
    const rec = { run_id: 'r', integrity: { seq: 0 } };
    submissionDigest(rec);
    assert.deepEqual(rec.integrity, { seq: 0 }, 'input record must be untouched');
  });

  it('changes when any non-integrity field changes (tamper sensitivity)', () => {
    const a = { run_id: 'r1', repo: 'o/r', notes: 'clean' };
    const b = { run_id: 'r1', repo: 'o/r', notes: 'tampered' };
    assert.notEqual(submissionDigest(a), submissionDigest(b));
  });
});

describe('integrity: GENESIS_DIGEST', () => {
  it('is 64 zeros', () => {
    assert.equal(GENESIS_DIGEST, '0'.repeat(64));
    assert.match(GENESIS_DIGEST, /^[0-9a-f]{64}$/);
  });
});
