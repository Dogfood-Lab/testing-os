/**
 * Merkle tree over chain entry digests — the leaf computation the XRPL anchor
 * commits to on-chain.
 *
 * Ported from @mcptoolshop/repomesh's anchor/xrpl/scripts/merkle.mjs (the
 * proven, tested design). The RFC-6962 (Certificate Transparency) v2 algorithm
 * is the default: it is second-preimage-safe (closes CVE-2012-2459) via domain
 * separation —
 *   leaf hash      = sha256(0x00 || leafBytes)
 *   internal node  = sha256(0x01 || left || right)
 *   lone odd node  = CARRIED UP UNCHANGED (no duplicate-last)
 *
 * Pure module: no I/O, no deps beyond node:crypto. The leaves are the chain
 * entries' `submission_digest` values (64-char hex sha256) for the partition
 * being anchored — see compute-root.js.
 */

import { createHash } from 'node:crypto';

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

// Domain-separation prefixes for the RFC-6962 (Certificate Transparency) tree.
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function validateLeaves(leavesHex) {
  if (!Array.isArray(leavesHex) || leavesHex.length === 0) {
    throw new Error('merkle: need at least 1 leaf');
  }
  return leavesHex.map((h, i) => {
    if (typeof h !== 'string' || !/^[0-9a-fA-F]{64}$/.test(h)) {
      throw new Error(`Invalid leaf[${i}] (expected 64 hex chars): ${h}`);
    }
    return Buffer.from(h, 'hex');
  });
}

/**
 * v1 — historical algorithm. NO domain separation; the lone odd node is
 * DUPLICATED (the CVE-2012-2459 dup-last shape). Ported byte-identical so that
 * any partition anchored under v1 in a prior system still verifies. New
 * partitions should use v2. Do NOT change this function.
 *
 * @param {string[]} leavesHex - 64-char hex leaves (one per chain entry digest).
 * @returns {string} Root as lowercase hex.
 */
export function merkleRootHex(leavesHex) {
  let level = validateLeaves(leavesHex);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = (i + 1 < level.length) ? level[i + 1] : level[i];
      next.push(sha256(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

/**
 * v2 — RFC-6962 (Certificate Transparency). Domain separation closes the
 * leaf/node ambiguity AND the dup-last second-preimage (CVE-2012-2459):
 *   leaf hash     = sha256(0x00 || leafBytes)
 *   internal node = sha256(0x01 || left || right)
 *   lone odd node = carried up unchanged
 *
 * @param {string[]} leavesHex - 64-char hex leaves.
 * @returns {string} Root as lowercase hex.
 */
export function merkleRootHexV2(leavesHex) {
  const raw = validateLeaves(leavesHex);
  // First hash every leaf with the leaf-domain prefix.
  let level = raw.map((b) => sha256(Buffer.concat([LEAF_PREFIX, b])));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([NODE_PREFIX, level[i], level[i + 1]])));
      } else {
        next.push(level[i]); // carry the lone odd node up unchanged
      }
    }
    level = next;
  }
  return level[0].toString('hex');
}

/**
 * Compute a root for the requested algo. Defaults to RFC-6962 v2 — the
 * second-preimage-safe variant is what new anchors commit to. Pass
 * `sha256-merkle-v1` only to reproduce a historical v1 partition.
 *
 * @param {string[]} leavesHex
 * @param {string} [algo='sha256-merkle-v2']
 * @returns {string}
 */
export function merkleRootForAlgo(leavesHex, algo = 'sha256-merkle-v2') {
  if (algo === 'sha256-merkle-v2') return merkleRootHexV2(leavesHex);
  if (algo === 'sha256-merkle-v1') return merkleRootHex(leavesHex);
  throw new Error(`Unknown merkle algo: ${algo}`);
}

/**
 * Build a self-describing manifest fragment: the algo, leaf encoding, count,
 * and root. The leaf encoding label documents that leaves are the chain
 * entries' submission_digest hex values.
 *
 * @param {string[]} leavesHex
 * @param {string} [algo='sha256-merkle-v2']
 * @returns {{ algo: string, leafEncoding: string, leafCount: number, root: string }}
 */
export function merkleManifest(leavesHex, algo = 'sha256-merkle-v2') {
  const root = merkleRootForAlgo(leavesHex, algo);
  return {
    algo,
    leafEncoding: 'submissionDigest:hex(32)',
    leafCount: leavesHex.length,
    root,
  };
}
