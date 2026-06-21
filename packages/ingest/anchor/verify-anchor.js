/**
 * verify-anchor — public verifiability for XRPL-anchored Merkle roots, and the
 * truncation detector the offline chain cannot provide.
 *
 * Ported from repomesh's verify-anchor.mjs. Two responsibilities:
 *
 *   1. verifyAnchorTx() — PURE on-chain anchor verification. Given a fetched XRPL
 *      tx + its decoded memo + the locally recomputed root/manifestHash/count,
 *      assert the anchor is real and authoritative:
 *        - tx.validated === true                 (finalized on-chain)
 *        - meta.TransactionResult === tesSUCCESS  (it actually succeeded)
 *        - tx.Account ∈ trustedAnchorAccounts     (the authorization root — any
 *          funded wallet can post a memo, so the account allowlist is the trust)
 *        - memo.r/h/c bind to the local root/manifestHash/leaf_count
 *      No network, no fs — the network fetch is the caller's job.
 *
 *   2. verifyChainAgainstAnchors() — the TRUNCATION detector. Given the local
 *      anchor manifests + the live chain, assert the chain is AT LEAST as long as
 *      the highest anchored (seq_range, leaf_count). A chain that is SHORTER than
 *      an anchored point is provably truncated — exactly the gap the offline
 *      tamper-evident chain could not catch, and the reason the anchor upgrades
 *      it from tamper-evident to tamper-PROOF below an anchored point.
 *
 * OFFLINE-HONEST: when no on-chain tx is available (the common offline case),
 * verifyAnchorState() reports `xrpl_verified: false` ("XRPL NOT verified")
 * rather than passing. An offline run can still prove the local truncation
 * check, but it must NEVER claim the on-chain witness was checked when it wasn't.
 *
 * This module NEVER imports xrpl. Fetching a tx for the on-chain leg is the
 * operator/CLI's job (and it lazily loads xrpl there).
 */

import { createHash } from 'node:crypto';

import { merkleRootForAlgo } from './merkle.js';
import { canonicalize } from '../lib/integrity.js';
import { readChainManifest } from '../lib/chain-manifest.js';
import { readAnchorManifests, MANIFEST_VERSION } from './compute-root.js';

function sha256hex(str) {
  return createHash('sha256').update(str, 'utf-8').digest('hex');
}

function hexToString(hex) {
  return Buffer.from(hex, 'hex').toString('utf8');
}

/**
 * Decode an anchor memo from an XRPL tx's Memos array. Returns the parsed memo
 * dataObj, or null when no anchor memo is present.
 *
 * @param {object} tx - The XRPL tx result (with a Memos array).
 * @param {string} memoType - The self-identifying MemoType to locate.
 * @returns {object|null}
 */
export function decodeAnchorMemo(tx, memoType = 'testing-os-anchor-v1') {
  const memos = tx?.Memos || [];
  const found = memos.find((m) => {
    try {
      return hexToString(m.Memo?.MemoType || '') === memoType;
    } catch {
      return false;
    }
  });
  if (!found) return null;
  try {
    return JSON.parse(hexToString(found.Memo.MemoData));
  } catch {
    return null;
  }
}

/**
 * PURE on-chain anchor verification. No network, no fs.
 *
 * @param {object} params
 * @param {object} params.tx - The fetched XRPL tx ({ validated, Account, meta }).
 * @param {object} params.memo - The decoded anchor memo ({ r, h, c, ... }).
 * @param {string} params.localRoot - Locally recomputed Merkle root.
 * @param {string} params.localManifestHash - Locally recomputed manifest hash.
 * @param {number} params.leafCount - Local leaf count.
 * @param {string[]} params.trustedAnchorAccounts - The account allowlist.
 * @returns {{ ok: boolean, reason: string, checks: object }}
 */
export function verifyAnchorTx({ tx, memo, localRoot, localManifestHash, leafCount, trustedAnchorAccounts }) {
  const checks = {};
  const trusted = new Set(trustedAnchorAccounts || []);

  // The tx must be validated (final) on the ledger.
  checks.validated = tx?.validated === true;
  if (!checks.validated) {
    return { ok: false, reason: 'tx.validated is not true (anchor not finalized on-chain)', checks };
  }

  // The tx must have actually succeeded.
  const txResult = tx?.meta?.TransactionResult;
  checks.tesSUCCESS = txResult === 'tesSUCCESS';
  if (!checks.tesSUCCESS) {
    return { ok: false, reason: `meta.TransactionResult is "${txResult}" (expected tesSUCCESS)`, checks };
  }

  // The signing wallet must be a trusted anchor account — any funded wallet can
  // post a memo, so the account allowlist is the authorization root.
  checks.account = trusted.has(tx?.Account);
  if (!checks.account) {
    return {
      ok: false,
      reason: `tx.Account "${tx?.Account}" is not in trustedAnchorAccounts — any funded wallet can post a memo; the account allowlist is the authorization root.`,
      checks,
    };
  }

  // The on-chain memo must bind to the local root / manifestHash / count.
  checks.root = memo?.r === localRoot;
  if (!checks.root) {
    return { ok: false, reason: `Merkle root mismatch: memo.r=${memo?.r} local=${localRoot}`, checks };
  }
  checks.manifestHash = memo?.h === localManifestHash;
  if (!checks.manifestHash) {
    return { ok: false, reason: `manifestHash mismatch: memo.h=${memo?.h} local=${localManifestHash}`, checks };
  }
  checks.count = Number(memo?.c) === Number(leafCount);
  if (!checks.count) {
    return { ok: false, reason: `leaf count mismatch: memo.c=${memo?.c} local=${leafCount}`, checks };
  }

  return { ok: true, reason: 'all anchor checks passed', checks };
}

/**
 * Recompute the local root + manifest hash for an anchor manifest from the
 * CURRENT chain, so a verifier can compare them against the on-chain memo
 * WITHOUT trusting the manifest's own stored root.
 *
 * Re-derives the leaves from the live chain over the manifest's `seq_range`, then
 * recomputes the Merkle root with the manifest's declared algo and the canonical
 * manifest hash. Returns `{ ok: false, reason }` if the live chain can no longer
 * cover the anchored range (which is itself a truncation/tamper signal).
 *
 * @param {string} repoRoot
 * @param {object} manifest - An anchor manifest.
 * @returns {{ ok: boolean, reason?: string, localRoot?: string, localManifestHash?: string, leafCount?: number }}
 */
export function recomputeLocalForAnchor(repoRoot, manifest) {
  const entries = readChainManifest(repoRoot);
  const [from, to] = manifest.seq_range || [];
  if (typeof from !== 'number' || typeof to !== 'number') {
    return { ok: false, reason: 'anchor manifest has no usable seq_range' };
  }
  const partition = entries.filter((e) => e.seq >= from && e.seq <= to);
  // If the live chain cannot cover the anchored range, it has been truncated or
  // mutated below the anchor — surface it here, not as a silent wrong root.
  if (partition.length < manifest.leaf_count) {
    return {
      ok: false,
      reason:
        `local chain covers only ${partition.length} of the anchored ${manifest.leaf_count} entries ` +
        `in seq_range [${from}, ${to}] — the chain is shorter than the anchored point (truncation).`,
    };
  }
  const leaves = partition.map((e) => e.submission_digest);
  const algo = manifest.algo || 'sha256-merkle-v1';
  const localRoot = merkleRootForAlgo(leaves, algo);
  const headDigest = partition[partition.length - 1].submission_digest;
  const base = {
    anchor_seq: manifest.anchor_seq,
    manifest_version: manifest.manifest_version ?? MANIFEST_VERSION,
    algo,
    root: localRoot,
    leaf_count: leaves.length,
    seq_range: [from, to],
    head_digest: headDigest,
    prev_anchor_root: manifest.prev_anchor_root ?? null,
    network: manifest.network,
  };
  return {
    ok: true,
    localRoot,
    localManifestHash: sha256hex(canonicalize(base)),
    leafCount: leaves.length,
  };
}

/**
 * THE TRUNCATION DETECTOR — the gap the offline tamper-evident chain cannot
 * close, and the reason the XRPL anchor upgrades the chain to tamper-PROOF below
 * an anchored point.
 *
 * Given the local anchor manifests and the live chain, assert the chain reaches
 * at least the HIGHEST anchored `seq_range[1]` and carries at least the anchored
 * cumulative leaf count up to that seq. A chain that is SHORTER than an anchored
 * (seq_range, count) is provably truncated — fail LOUD.
 *
 * Each anchor's range is also re-derived against the live chain (via
 * recomputeLocalForAnchor): if the live chain can no longer reproduce an
 * anchored root, that is reported too (a mutation/deletion below the anchor).
 *
 * @param {string} repoRoot - Absolute path to the testing-os repo root.
 * @returns {{ ok: boolean, reason: string, anchored_through_seq: number|null,
 *   anchored_count: number, chain_head_seq: number|null, chain_count: number,
 *   anchor_count: number, failures: Array<object> }}
 */
export function verifyChainAgainstAnchors(repoRoot) {
  const anchors = readAnchorManifests(repoRoot);
  const entries = readChainManifest(repoRoot);
  const chainCount = entries.length;
  const chainHeadSeq = chainCount === 0 ? null : entries[entries.length - 1].seq;

  if (anchors.length === 0) {
    // No anchors yet — there is no external head/count to enforce. Honest: this
    // is not a PASS of "the chain is complete", it is "nothing is anchored".
    return {
      ok: true,
      reason: 'no anchors present — nothing to enforce (chain is only tamper-evident, not anchored)',
      anchored_through_seq: null,
      anchored_count: 0,
      chain_head_seq: chainHeadSeq,
      chain_count: chainCount,
      anchor_count: 0,
      failures: [],
    };
  }

  // The highest seq any anchor has committed to on-chain.
  const anchoredThroughSeq = Math.max(...anchors.map((a) => a.seq_range?.[1] ?? -1));
  // The cumulative entries that must exist at or below that seq: the highest
  // anchored `to` + 1 (seqs are 0-based and contiguous), which equals the count
  // of entries the anchors collectively certify must still be present.
  const anchoredCount = anchoredThroughSeq + 1;

  const failures = [];

  // (1) Tail-truncation: the live chain head must reach the highest anchored seq.
  if (chainHeadSeq === null || chainHeadSeq < anchoredThroughSeq) {
    failures.push({
      kind: 'truncation',
      reason:
        `chain head seq is ${chainHeadSeq === null ? '(empty chain)' : chainHeadSeq} but anchors certify ` +
        `entries through seq ${anchoredThroughSeq} — the chain is shorter than the anchored point (TRUNCATION).`,
    });
  }
  // (2) Count floor: the chain must carry at least the anchored cumulative count.
  if (chainCount < anchoredCount) {
    failures.push({
      kind: 'count-shortfall',
      reason:
        `chain has ${chainCount} entries but anchors certify at least ${anchoredCount} ` +
        `(through seq ${anchoredThroughSeq}) — entries are missing (TRUNCATION).`,
    });
  }

  // (3) Each anchored range must still be reproducible from the live chain. A
  //     mutation/deletion BELOW an anchor that left the head intact would slip
  //     past (1) and (2) but fail here when the recomputed root no longer matches.
  for (const anchor of anchors) {
    const local = recomputeLocalForAnchor(repoRoot, anchor);
    if (!local.ok) {
      failures.push({ kind: 'range-unreproducible', anchor_seq: anchor.anchor_seq, reason: local.reason });
      continue;
    }
    if (local.localRoot !== anchor.root) {
      failures.push({
        kind: 'root-drift',
        anchor_seq: anchor.anchor_seq,
        reason:
          `anchor ${anchor.anchor_seq} root no longer reproduces from the live chain: ` +
          `recomputed ${local.localRoot} vs anchored ${anchor.root} — entries in seq_range ` +
          `[${anchor.seq_range?.[0]}, ${anchor.seq_range?.[1]}] were mutated or reordered.`,
      });
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    reason: ok
      ? `chain reaches anchored seq ${anchoredThroughSeq} (${chainCount} entries ≥ ${anchoredCount} anchored)`
      : failures.map((f) => f.reason).join(' | '),
    anchored_through_seq: anchoredThroughSeq,
    anchored_count: anchoredCount,
    chain_head_seq: chainHeadSeq,
    chain_count: chainCount,
    anchor_count: anchors.length,
    failures,
  };
}

/**
 * Offline-honest combined verification used by the CLI's --anchor-verify.
 *
 * ALWAYS runs the local truncation check (verifyChainAgainstAnchors). When a
 * fetched tx is supplied, ALSO runs verifyAnchorTx for the matching anchor and
 * reports `xrpl_verified: true/false`. When no tx is supplied (offline), reports
 * `xrpl_verified: false` with an honest "XRPL NOT verified" note — it never
 * claims the on-chain witness was checked when it wasn't.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {object} [opts.tx] - A fetched XRPL tx (with Memos), or undefined offline.
 * @param {string[]} [opts.trustedAnchorAccounts] - The account allowlist.
 * @param {string} [opts.memoType='testing-os-anchor-v1']
 * @returns {{ ok: boolean, truncation: object, xrpl_verified: boolean, xrpl: object|null, note: string }}
 */
export function verifyAnchorState(repoRoot, opts = {}) {
  const truncation = verifyChainAgainstAnchors(repoRoot);

  let xrplVerified = false;
  let xrpl = null;
  let note;

  if (opts.tx) {
    const memo = decodeAnchorMemo(opts.tx, opts.memoType || 'testing-os-anchor-v1');
    if (!memo) {
      xrpl = { ok: false, reason: 'no anchor memo found in the supplied tx', checks: {} };
      note = 'XRPL NOT verified — the supplied tx carries no anchor memo.';
    } else {
      const anchors = readAnchorManifests(repoRoot);
      const target = anchors.find((a) => a.root === memo.r) || anchors.find((a) => a.anchor_seq === memo.s);
      if (!target) {
        xrpl = { ok: false, reason: `no local anchor manifest matches the on-chain memo (root ${memo.r})`, checks: {} };
        note = 'XRPL NOT verified — no local anchor manifest matches the on-chain memo.';
      } else {
        const local = recomputeLocalForAnchor(repoRoot, target);
        if (!local.ok) {
          xrpl = { ok: false, reason: local.reason, checks: {} };
          note = `XRPL NOT verified — ${local.reason}`;
        } else {
          xrpl = verifyAnchorTx({
            tx: opts.tx,
            memo,
            localRoot: local.localRoot,
            localManifestHash: local.localManifestHash,
            leafCount: local.leafCount,
            trustedAnchorAccounts: opts.trustedAnchorAccounts || [],
          });
          xrplVerified = xrpl.ok;
          note = xrpl.ok
            ? 'XRPL verified — the on-chain anchor binds to the local chain.'
            : `XRPL NOT verified — ${xrpl.reason}`;
        }
      }
    }
  } else {
    note = 'XRPL NOT verified (offline) — no tx supplied. The local truncation check ran; ' +
      'fetch the anchor tx to confirm the on-chain head/count witness.';
  }

  return {
    // Overall ok requires the local truncation check to pass. The on-chain leg,
    // when present, must also pass; when absent it does NOT flip ok to true on
    // its own (offline cannot upgrade tamper-evident to tamper-proof).
    ok: truncation.ok && (opts.tx ? xrplVerified : true),
    truncation,
    xrpl_verified: xrplVerified,
    xrpl,
    note,
  };
}
