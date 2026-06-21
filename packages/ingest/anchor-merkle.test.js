/**
 * Merkle (RFC-6962 v2) tests — ported from repomesh's merkle-v2.test.mjs.
 *
 * Probes:
 *   1. merkleRootHexV2 matches an INDEPENDENT RFC-6962 reference (1..6 leaves).
 *   2. domain separation: a single-leaf root is sha256(0x00||leaf), NOT the raw
 *      leaf — and a naive concat impl's 2-leaf result is NOT the v2 root.
 *   3. second-preimage safety (CVE-2012-2459): a 3-leaf tree and its
 *      dup-last(4) variant produce DIFFERENT v2 roots (v1 collides; v2 must not).
 *   4. v1 is preserved byte-identically (historical roots still verify).
 *   5. the default algo is v2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  merkleRootHex,
  merkleRootHexV2,
  merkleRootForAlgo,
  merkleManifest,
} from './anchor/merkle.js';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}
const hex = (b) => b.toString('hex');
const leafHex = (n) => crypto.createHash('sha256').update(`leaf-${n}`).digest('hex');

// Independent RFC-6962 reference implementation (NOT the module under test).
function refV2(leavesHex) {
  let level = leavesHex.map((h) => sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(h, 'hex')])));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([Buffer.from([0x01]), level[i], level[i + 1]])));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return hex(level[0]);
}

describe('merkleRootHexV2 (RFC-6962)', () => {
  it('matches an independent RFC-6962 reference for 1..6 leaves', () => {
    for (let n = 1; n <= 6; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafHex(i));
      assert.equal(merkleRootHexV2(leaves), refV2(leaves), `v2 root mismatch for n=${n}`);
    }
  });

  it('is deterministic — same leaves give the same root', () => {
    const leaves = [leafHex(0), leafHex(1), leafHex(2), leafHex(3)];
    assert.equal(merkleRootHexV2(leaves), merkleRootHexV2(leaves));
  });

  it('single-leaf v2 root is sha256(0x00||leaf), NOT the raw leaf (domain separation)', () => {
    const leaf = leafHex(0);
    const expected = hex(sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(leaf, 'hex')])));
    assert.equal(merkleRootHexV2([leaf]), expected);
    assert.notEqual(merkleRootHexV2([leaf]), leaf, 'v2 single-leaf root must not equal the raw leaf');
  });

  it('a 2-leaf v2 root is NOT the naive concat sha256(l0||l1) (node domain prefix)', () => {
    // A naive (CVE-prone) impl would compute sha256(l0||l1) with no domain byte.
    // v2 must differ: it computes sha256(0x01 || sha256(0x00||l0) || sha256(0x00||l1)).
    const l0 = leafHex(0), l1 = leafHex(1);
    const naive = hex(sha256(Buffer.concat([Buffer.from(l0, 'hex'), Buffer.from(l1, 'hex')])));
    assert.notEqual(merkleRootHexV2([l0, l1]), naive,
      'v2 must NOT equal the naive concat root a second-preimage-unsafe impl produces');
  });

  it('resists CVE-2012-2459: N leaves vs the dup-last(N+1) tree give different v2 roots', () => {
    // v1 of [a,b,c] computes the same as a tree where c is duplicated to fill an
    // even level. Under v2, presenting [a,b,c,c] must NOT collide with [a,b,c].
    const a = leafHex(0), b = leafHex(1), c = leafHex(2);
    assert.notEqual(merkleRootHexV2([a, b, c]), merkleRootHexV2([a, b, c, c]),
      'v2 must not collide a tree with its dup-last variant');
  });

  it('rejects a non-hex or short leaf', () => {
    assert.throws(() => merkleRootHexV2(['not-hex']), /Invalid leaf/);
    assert.throws(() => merkleRootHexV2([]), /at least 1 leaf/);
  });
});

describe('merkleRootHex (v1, historical)', () => {
  it('v1 of two leaves is the naive concat sha256(l0||l1) with NO domain byte', () => {
    const l0 = leafHex(0), l1 = leafHex(1);
    const expectedV1 = hex(sha256(Buffer.concat([Buffer.from(l0, 'hex'), Buffer.from(l1, 'hex')])));
    assert.equal(merkleRootHex([l0, l1]), expectedV1);
  });

  it('v2 differs from v1 for an odd leaf count (dup-last vs carry-up + domain sep)', () => {
    const leaves = [leafHex(0), leafHex(1), leafHex(2)];
    assert.notEqual(merkleRootHexV2(leaves), merkleRootHex(leaves));
  });
});

describe('merkleRootForAlgo + merkleManifest', () => {
  it('defaults to v2', () => {
    const leaves = [leafHex(0), leafHex(1), leafHex(2)];
    assert.equal(merkleRootForAlgo(leaves), merkleRootHexV2(leaves));
    assert.equal(merkleManifest(leaves).algo, 'sha256-merkle-v2');
    assert.equal(merkleManifest(leaves).root, merkleRootHexV2(leaves));
    assert.equal(merkleManifest(leaves).leafCount, 3);
  });

  it('can reproduce a v1 partition on request', () => {
    const leaves = [leafHex(0), leafHex(1), leafHex(2)];
    assert.equal(merkleRootForAlgo(leaves, 'sha256-merkle-v1'), merkleRootHex(leaves));
    assert.equal(merkleManifest(leaves, 'sha256-merkle-v1').root, merkleRootHex(leaves));
  });

  it('throws on an unknown algo', () => {
    assert.throws(() => merkleRootForAlgo([leafHex(0)], 'sha512-merkle'), /Unknown merkle algo/);
  });
});
