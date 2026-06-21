/**
 * compute-root — Merkle-root the integrity chain entries for the partition to be
 * anchored next, and write an append-only anchor manifest.
 *
 * Adapted from repomesh's compute-root.mjs to testing-os's chain.jsonl. The
 * source ledger here is `indexes/integrity/chain.jsonl` (one line per persisted
 * record: { seq, run_id, repo, status, path, submission_digest, prev_digest,
 * persisted_at }). The Merkle LEAVES are the entries' `submission_digest` values
 * for the partition being anchored — already 64-char hex, exactly the shape the
 * RFC-6962 tree wants.
 *
 * ── Cadence (default SINCE-LAST) ────────────────────────────────────────────
 * Each anchor covers exactly the chain entries appended SINCE the previous
 * anchor manifest (prev-linked), NOT per-entry. Run anchor-compute + anchor-post
 * once per release wave — the unit of attested work — not on a wall-clock timer:
 *   - too FREQUENT (per-entry) floods the XRP Ledger with one-leaf anchors and
 *     wastes tx fees;
 *   - too RARE leaves a long window of only-locally-trusted (truncatable) entries.
 * `--all` produces a single genesis snapshot over the whole chain instead.
 *
 * ── Truncation defense (the gap the offline chain cannot close) ──────────────
 * The manifest records `leaf_count`, `seq_range: [from, to]`, and `head_digest`
 * (the partition's last entry's submission_digest). Once that manifest's root is
 * posted on-chain (post-anchor.js) and confirmed, a later chain that is SHORTER
 * than the anchored (seq_range, leaf_count) is PROVABLY truncated:
 * verify-anchor's verifyChainAgainstAnchors() asserts the live chain reaches at
 * least the highest anchored `to` seq and carries at least the anchored count.
 *
 * This module is OFFLINE: it reads the chain and writes a manifest. It NEVER
 * imports xrpl. Posting to the ledger is post-anchor.js's job.
 */

import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { merkleRootForAlgo } from './merkle.js';
import { readChainManifest } from '../lib/chain-manifest.js';
import { canonicalize } from '../lib/integrity.js';
// Anchor manifests live in the shared backing store under indexes/integrity/, so
// they obey the same torn-write doctrine as records/ + chain.jsonl: write via
// temp+rename so a reader never sees a half-written manifest. Use the sibling
// ingest helper (not the findings copy — importing it would close the workspace
// dependency cycle, see CLAUDE.md).
import { atomicWriteFileSync } from '../lib/atomic-write.js';

/** Manifest format version — bump when the anchor manifest shape changes. */
export const MANIFEST_VERSION = 1;

/** Default Merkle algorithm for new anchors (second-preimage-safe RFC-6962). */
export const DEFAULT_ALGO = 'sha256-merkle-v2';

/** Soft cap: a since-last partition larger than this WARNS of a lapsed cadence. */
export const OVERSIZED_PARTITION_LEAVES = 5000;

/** Repo-root-relative directory holding the append-only anchor manifests. */
export const ANCHORS_DIR_REL = 'indexes/integrity/anchors';

/** Absolute path to the anchors directory for a given repo root. */
export function anchorsDir(repoRoot) {
  return join(repoRoot, 'indexes', 'integrity', 'anchors');
}

function sha256hex(str) {
  return createHash('sha256').update(str, 'utf-8').digest('hex');
}

/**
 * Read every anchor manifest in seq order. Anchor files are named
 * `anchor-<NNNN>.json` (zero-padded anchor_seq) so a lexical sort is a seq sort.
 * Returns [] when none exist.
 *
 * @param {string} repoRoot
 * @returns {Array<object>} Parsed anchor manifests, ascending by anchor_seq.
 */
export function readAnchorManifests(repoRoot) {
  const dir = anchorsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^anchor-\d+\.json$/.test(f))
    .sort();
  const manifests = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
  manifests.sort((a, b) => a.anchor_seq - b.anchor_seq);
  return manifests;
}

/**
 * Return the highest-seq anchor manifest, or null when none exist.
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
export function readLastAnchor(repoRoot) {
  const manifests = readAnchorManifests(repoRoot);
  return manifests.length === 0 ? null : manifests[manifests.length - 1];
}

/**
 * Select the chain entries this anchor will cover.
 *
 * since-last: entries whose `seq` is strictly greater than the highest seq the
 *   previous anchor covered (`prevAnchor.seq_range[1]`). Genesis (no prev) covers
 *   the whole chain.
 * all: the whole chain (genesis snapshot), regardless of prior anchors.
 *
 * Pure: takes the already-read entries + prev anchor; no I/O. Exposed for tests.
 *
 * @param {Array<object>} entries - All chain entries (chain order).
 * @param {object|null} prevAnchor - The previous anchor manifest, or null.
 * @param {{ mode?: 'since-last'|'all' }} [opts]
 * @returns {Array<object>} The partition entries.
 */
export function selectPartition(entries, prevAnchor, opts = {}) {
  const mode = opts.mode === 'all' ? 'all' : 'since-last';
  if (mode === 'all' || !prevAnchor) return entries;
  const coveredThrough = prevAnchor.seq_range?.[1];
  if (typeof coveredThrough !== 'number') return entries;
  return entries.filter((e) => e.seq > coveredThrough);
}

/**
 * Build the anchor manifest object for a partition. Pure — no I/O, no network.
 * The `root` + `manifest_hash` are computed here; the network/close-time fields
 * are filled by post-anchor.js after a successful on-chain submission.
 *
 * @param {object} params
 * @param {number} params.anchorSeq - 0,1,2,… ordinal of this anchor.
 * @param {Array<object>} params.partition - The chain entries this anchor covers.
 * @param {object|null} params.prevAnchor - The previous anchor manifest, or null.
 * @param {string} [params.algo] - Merkle algo (default v2).
 * @param {string} [params.network] - 'testnet' | 'mainnet' (default testnet).
 * @param {string} [params.computedAt] - ISO timestamp (default now).
 * @returns {object} The anchor manifest (without on-chain post fields).
 */
export function buildAnchorManifest({
  anchorSeq,
  partition,
  prevAnchor,
  algo = DEFAULT_ALGO,
  network = 'testnet',
  computedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(partition) || partition.length === 0) {
    throw new Error('buildAnchorManifest: partition is empty — nothing to anchor');
  }
  const leaves = partition.map((e) => e.submission_digest);
  for (const [i, leaf] of leaves.entries()) {
    if (typeof leaf !== 'string' || !/^[0-9a-fA-F]{64}$/.test(leaf)) {
      throw new Error(`buildAnchorManifest: chain entry[${i}] has a malformed submission_digest: ${leaf}`);
    }
  }
  const root = merkleRootForAlgo(leaves, algo);
  const seqFrom = partition[0].seq;
  const seqTo = partition[partition.length - 1].seq;
  const headDigest = partition[partition.length - 1].submission_digest;

  // The manifest base is canonicalized + hashed so the on-chain memo can bind to
  // it. Field order is irrelevant (canonicalize sorts keys); the hash is stable.
  const base = {
    anchor_seq: anchorSeq,
    manifest_version: MANIFEST_VERSION,
    algo,
    root,
    leaf_count: leaves.length,
    seq_range: [seqFrom, seqTo],
    head_digest: headDigest,
    prev_anchor_root: prevAnchor ? prevAnchor.root : null,
    network,
  };
  const manifestHash = sha256hex(canonicalize(base));
  return { ...base, manifest_hash: manifestHash, computed_at: computedAt };
}

/**
 * The append-only file path for an anchor of a given seq.
 *
 * @param {string} repoRoot
 * @param {number} anchorSeq
 * @returns {string}
 */
export function anchorManifestPath(repoRoot, anchorSeq) {
  const padded = String(anchorSeq).padStart(4, '0');
  return join(anchorsDir(repoRoot), `anchor-${padded}.json`);
}

/**
 * Compute the next anchor for a repo root and write its append-only manifest.
 *
 * Reads the chain, selects the partition (since-last by default), builds the
 * manifest (Merkle root + leaf_count + seq_range + head_digest, prev-linked to
 * the prior anchor's root), and writes it to
 * `indexes/integrity/anchors/anchor-<NNNN>.json`.
 *
 * Append-only: write-if-missing, fail-if-exists-with-different-content. An empty
 * partition (nothing new since the last anchor) returns `{ empty: true }` and
 * writes nothing.
 *
 * OFFLINE — never imports xrpl, never touches the network.
 *
 * @param {string} repoRoot - Absolute path to the testing-os repo root.
 * @param {object} [opts]
 * @param {'since-last'|'all'} [opts.mode='since-last']
 * @param {string} [opts.algo='sha256-merkle-v2']
 * @param {string} [opts.network='testnet']
 * @returns {{ empty: boolean, manifest?: object, path?: string, written?: boolean, leaf_count?: number }}
 */
export function computeAnchor(repoRoot, opts = {}) {
  const mode = opts.mode === 'all' ? 'all' : 'since-last';
  const algo = opts.algo || DEFAULT_ALGO;
  if (algo !== 'sha256-merkle-v1' && algo !== 'sha256-merkle-v2') {
    const e = new Error(`Unknown anchor algo "${algo}" (expected sha256-merkle-v1 or sha256-merkle-v2)`);
    e.code = 'ANCHOR_BAD_ALGO';
    throw e;
  }
  const network = opts.network || 'testnet';

  const entries = readChainManifest(repoRoot);
  if (entries.length === 0) {
    return { empty: true, reason: 'chain is empty — nothing to anchor' };
  }

  const existingAnchors = readAnchorManifests(repoRoot);
  const prevAnchor = existingAnchors.length === 0 ? null : existingAnchors[existingAnchors.length - 1];
  const anchorSeq = existingAnchors.length;

  const partition = selectPartition(entries, prevAnchor, { mode });
  if (partition.length === 0) {
    return { empty: true, reason: 'no chain entries since the last anchor — nothing new to anchor' };
  }

  const warnings = [];
  if (mode === 'since-last' && partition.length > OVERSIZED_PARTITION_LEAVES) {
    warnings.push(
      `since-last partition has ${partition.length} leaves (> ${OVERSIZED_PARTITION_LEAVES}); ` +
      'the anchoring cadence has likely lapsed — anchor now, then anchor once per release wave.'
    );
  }

  const manifest = buildAnchorManifest({ anchorSeq, partition, prevAnchor, algo, network });

  const path = anchorManifestPath(repoRoot, anchorSeq);
  mkdirSync(anchorsDir(repoRoot), { recursive: true });
  const json = JSON.stringify(manifest, null, 2) + '\n';

  let written = false;
  if (existsSync(path)) {
    // Append-only: an existing anchor at this seq must be byte-identical (modulo
    // the volatile computed_at field, which we do not let block a re-run).
    const existing = JSON.parse(readFileSync(path, 'utf-8'));
    const stableEqual =
      existing.root === manifest.root &&
      existing.manifest_hash === manifest.manifest_hash &&
      existing.leaf_count === manifest.leaf_count;
    if (!stableEqual) {
      const e = new Error(
        `anchor manifest conflict at ${path}: an anchor for seq ${anchorSeq} already exists ` +
        'with a different root/hash. Anchor manifests are append-only.'
      );
      e.code = 'ANCHOR_MANIFEST_CONFLICT';
      throw e;
    }
  } else {
    atomicWriteFileSync(path, json);
    written = true;
  }

  return { empty: false, manifest, path, written, leaf_count: manifest.leaf_count, warnings };
}

/**
 * Record the on-chain facts back into an anchor manifest file after a successful
 * post. This is the production `recordPost` callback post-anchor.js invokes.
 *
 * Patches an `on_chain` block into the manifest at the given seq WITHOUT touching
 * the root / leaf_count / seq_range / head_digest (those are the contract the
 * memo committed to — they must never change after posting). Writing the on-chain
 * receipt is the one mutation an anchor manifest accepts: it ADDS the proof of
 * where the root landed, it does not alter what was committed.
 *
 * @param {string} repoRoot
 * @param {number} anchorSeq
 * @param {object} facts - { tx_hash, ledger_index, close_time_iso, wallet_address, network }
 */
export function recordAnchorPost(repoRoot, anchorSeq, facts) {
  const path = anchorManifestPath(repoRoot, anchorSeq);
  if (!existsSync(path)) {
    const e = new Error(`cannot record post: no anchor manifest at ${path} (run anchor-compute first)`);
    e.code = 'ANCHOR_MANIFEST_MISSING';
    throw e;
  }
  const manifest = JSON.parse(readFileSync(path, 'utf-8'));
  manifest.on_chain = {
    tx_hash: facts.tx_hash ?? null,
    ledger_index: facts.ledger_index ?? null,
    close_time_iso: facts.close_time_iso ?? null,
    wallet_address: facts.wallet_address ?? null,
    network: facts.network ?? manifest.network,
    posted_at: new Date().toISOString(),
  };
  atomicWriteFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
