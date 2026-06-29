/**
 * post-anchor — submit an anchor manifest's Merkle root to the XRP Ledger as a
 * memo on an AccountSet transaction.
 *
 * Adapted from repomesh's post-anchor.mjs. This is the ONLY module in the anchor
 * subsystem that touches the network, and it LAZILY imports `xrpl` so the rest
 * of the subsystem (compute-root, verify-anchor, the truncation check, the memo
 * builder, and ALL tests) runs with xrpl NOT installed. xrpl is intentionally
 * NOT a declared dependency anywhere; only `postAnchor()` reaches for it, and it
 * throws a structured install hint when it is absent.
 *
 * ── Network (default TESTNET) ───────────────────────────────────────────────
 * Default endpoint is the XRPL testnet (wss://s.altnet.rippletest.net:51233).
 * Testnet ledgers are periodically RESET, which purges historical transactions —
 * fine for proving the mechanism, but for DURABLE, citable anchors migrate to
 * mainnet by passing `network: 'mainnet'` (or XRPL_WS_URL) and funding a real
 * wallet. Each AccountSet anchor costs the standard XRP tx fee.
 *
 * ── Authorization root ──────────────────────────────────────────────────────
 * Any funded wallet can post a memo; the trust comes from the verifier's
 * trusted-anchor-account allowlist (see verify-anchor.js). Posting requires the
 * XRPL_SEED env var (the funded wallet's family seed); post-anchor REFUSES to
 * submit without it. The on-chain memo self-describes its Merkle algo so the
 * standalone verifier recomputes the root with the same algorithm.
 *
 * Honest framing: a confirmed on-chain XRPL transaction is the EXTERNAL
 * head/count witness the chain writer cannot forge or remove. That is what
 * upgrades the chain from tamper-EVIDENT to tamper-PROOF below an anchored point.
 */

import { readFileSync } from 'node:fs';

import { readLastAnchor, computeAnchor } from './compute-root.js';

/** Default XRPL endpoints per network. */
export const DEFAULT_WS_URL = {
  testnet: 'wss://s.altnet.rippletest.net:51233',
  mainnet: 'wss://xrplcluster.com',
};

/** Ripple epoch offset from the Unix epoch (seconds): 2000-01-01T00:00:00Z. */
const RIPPLE_EPOCH_OFFSET_SECONDS = 946684800;

/** Memo type that self-identifies an anchor memo so a verifier can locate it. */
export const ANCHOR_MEMO_TYPE = 'testing-os-anchor-v1';

function stringToHex(s) {
  return Buffer.from(s, 'utf8').toString('hex').toUpperCase();
}

/**
 * Validate the XRPL_SEED SHAPE before opening a socket, so a typo'd/empty seed
 * gives a one-line actionable message instead of a raw crypto stack after the
 * connect. XRPL family seeds are base58 (no 0/O/I/l), begin with 's', and are
 * ~29-31 chars. This is a SHAPE pre-check, not a full base58-check — the xrpl
 * Wallet.fromSeed remains the authority. Pure / testable.
 *
 * @param {string} seed
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateSeedShape(seed) {
  if (typeof seed !== 'string' || seed.length === 0) {
    return { ok: false, reason: "XRPL_SEED is empty or unset — set the funded wallet's seed (generate with: xrpl wallet create)." };
  }
  if (seed[0] !== 's') {
    return { ok: false, reason: `XRPL_SEED does not look like an XRPL family seed — it must begin with 's' (got "${seed[0]}…"). Did you paste the classic ADDRESS (r…) instead of the SEED?` };
  }
  if (seed.length < 16 || seed.length > 40) {
    return { ok: false, reason: `XRPL_SEED has an unexpected length (${seed.length}); an XRPL seed is ~29-31 base58 chars. Check for truncation or extra whitespace.` };
  }
  if (/[0OIl]/.test(seed) || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(seed)) {
    return { ok: false, reason: 'XRPL_SEED contains characters outside the base58 alphabet (no 0, O, I, l) — it is not a valid seed.' };
  }
  return { ok: true };
}

/**
 * Convert an XRPL Ripple-epoch close-time (seconds since 2000-01-01) into an
 * ISO-8601 string. `submitAndWait` returns the validated tx, whose
 * `result.date` is the ledger close-time — the only trustworthy clock for an
 * anchor. Returns null (never throws) when the date is absent.
 *
 * @param {object} submitResult
 * @returns {string|null}
 */
export function extractCloseTime(submitResult) {
  const date = submitResult?.result?.date;
  if (typeof date !== 'number' || !Number.isFinite(date)) return null;
  const d = new Date((date + RIPPLE_EPOCH_OFFSET_SECONDS) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract the validating ledger index from a submitAndWait result. Returns null
 * (never throws) when absent.
 *
 * @param {object} submitResult
 * @returns {number|null}
 */
export function extractLedgerIndex(submitResult) {
  const li = submitResult?.result?.ledger_index;
  return typeof li === 'number' && Number.isFinite(li) ? li : null;
}

/**
 * Build the XRPL memo object binding an anchor to the chain. Pure — returns the
 * `{ Memo: { MemoType, MemoFormat, MemoData } }` envelope (hex-encoded fields).
 *
 * The memo self-describes the Merkle algo so the standalone verifier recomputes
 * the root with the SAME algorithm that produced it. MemoType is a stable
 * self-identifying tag (ANCHOR_MEMO_TYPE) so a verifier can locate the memo.
 *
 * @param {object} params
 * @param {number} params.anchorSeq
 * @param {string} params.network - 'testnet' | 'mainnet'
 * @param {string} params.rootHex - The Merkle root.
 * @param {string} params.manifestHash - sha256 of the canonical manifest base.
 * @param {number} params.count - leaf_count.
 * @param {string|null} [params.prev] - prev_anchor_root, or null/"0" for genesis.
 * @param {[number,number]|null} [params.range] - seq_range [from, to].
 * @param {string} [params.algo] - Merkle algo (omitted from memo when undefined).
 * @returns {{ Memo: { MemoType: string, MemoFormat: string, MemoData: string } }}
 */
export function buildAnchorMemo({ anchorSeq, network, rootHex, manifestHash, count, prev, range, algo }) {
  const dataObj = {
    v: 1,
    s: anchorSeq,
    n: network,
    r: rootHex,
    h: manifestHash,
    c: count,
    pv: prev && prev !== null ? prev : '0',
    rg: range ? `${range[0]}..${range[1]}` : '0',
  };
  // Self-describe the algorithm so v2 anchors verify as v2 (and any legacy v1
  // memo without an algo field falls back to v1 in the verifier).
  if (algo) dataObj.algo = algo;
  const memoData = JSON.stringify(dataObj);
  if (Buffer.byteLength(memoData, 'utf8') > 700) {
    throw new Error(`MemoData too large: ${Buffer.byteLength(memoData)} bytes (XRPL memo cap is ~1KB; keep anchors small)`);
  }
  return {
    Memo: {
      MemoType: stringToHex(ANCHOR_MEMO_TYPE),
      MemoFormat: stringToHex('application/json'),
      MemoData: stringToHex(memoData),
    },
  };
}

/**
 * Structured error for the missing optional dependency. Thrown by postAnchor()
 * (the only network path) when `import('xrpl')` fails — so the floor + verify +
 * all tests run without xrpl, and only an actual post demands it.
 */
export class XrplDependencyError extends Error {
  constructor() {
    super('XRPL anchoring requires the optional xrpl package — run: npm install xrpl');
    this.name = 'XrplDependencyError';
    this.code = 'XRPL_NOT_INSTALLED';
    this.hint = 'npm install xrpl';
  }
}

/**
 * Lazily import the optional `xrpl` package. Isolated so it can be stubbed in
 * tests and so the structured install hint is produced in exactly one place.
 *
 * @returns {Promise<object>} The xrpl module.
 * @throws {XrplDependencyError} when xrpl is not installed.
 */
export async function loadXrpl() {
  try {
    return await import('xrpl');
  } catch {
    throw new XrplDependencyError();
  }
}

/**
 * Compute (if needed) and post the next anchor to the XRP Ledger.
 *
 * Steps:
 *   1. Compute the anchor manifest if one is not already pending — uses the same
 *      append-only compute-root path. (Operators usually run anchor-compute
 *      first; this re-runs it idempotently so a post is never against a stale or
 *      missing manifest.)
 *   2. Validate XRPL_SEED shape — REFUSE to post without it (structured error).
 *   3. Lazily import xrpl, connect, submitAndWait an AccountSet carrying the
 *      anchor memo.
 *   4. On tesSUCCESS, record the on-chain close-time + ledger index back into the
 *      anchor manifest (via the provided manifest-update callback) and return the
 *      receipt.
 *
 * The actual xrpl client + wallet are injected via `deps` so tests can drive the
 * whole post path WITHOUT xrpl installed and WITHOUT a network. In production
 * `deps` is omitted and the real xrpl is lazily loaded.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {'testnet'|'mainnet'} [opts.network='testnet']
 * @param {string} [opts.wsUrl] - Override endpoint (else DEFAULT_WS_URL[network]).
 * @param {string} [opts.seed] - Override XRPL_SEED (else process.env.XRPL_SEED).
 * @param {'since-last'|'all'} [opts.mode='since-last']
 * @param {object} [opts.deps] - Test injection: { xrpl, recordPost }.
 * @returns {Promise<object>} A receipt: { ok, anchor_seq, root, tx_hash, ... }.
 */
export async function postAnchor(repoRoot, opts = {}) {
  const network = opts.network || 'testnet';
  const wsUrl = opts.wsUrl || DEFAULT_WS_URL[network] || DEFAULT_WS_URL.testnet;
  const seed = opts.seed !== undefined ? opts.seed : process.env.XRPL_SEED;
  const mode = opts.mode || 'since-last';

  // (2) Refuse without a valid-shaped seed — BEFORE any network work.
  const seedCheck = validateSeedShape(seed);
  if (!seedCheck.ok) {
    const e = new Error(seedCheck.reason);
    e.code = 'XRPL_SEED_INVALID';
    throw e;
  }

  // (1) Ensure there is a manifest to post. Re-running compute is idempotent
  //     (append-only). If nothing new is pending, post the LAST anchor manifest
  //     so a re-post after a transient network failure still binds the same root.
  //
  //     Thread the LAST anchor's algo into the recompute. compute defaults to the
  //     v2 algo, so a chain previously anchored with the v1 (historical-
  //     reproduction) algo would otherwise be recomputed as v2 — re-posting that
  //     anchor would either bind a divergent v2 root or collide append-only with
  //     the stored v1 manifest. Reproducing the SAME algo keeps a re-post
  //     idempotent and binds the root the operator actually anchored.
  const lastAnchor = readLastAnchor(repoRoot);
  const computed = computeAnchor(repoRoot, {
    mode,
    network,
    ...(lastAnchor?.algo ? { algo: lastAnchor.algo } : {}),
  });
  let manifest;
  if (computed.empty) {
    manifest = lastAnchor;
    if (!manifest) {
      const e = new Error(`nothing to anchor: ${computed.reason}`);
      e.code = 'ANCHOR_NOTHING_TO_POST';
      throw e;
    }
  } else {
    manifest = computed.manifest;
  }

  const memo = buildAnchorMemo({
    anchorSeq: manifest.anchor_seq,
    network,
    rootHex: manifest.root,
    manifestHash: manifest.manifest_hash,
    count: manifest.leaf_count,
    prev: manifest.prev_anchor_root,
    range: manifest.seq_range,
    algo: manifest.algo,
  });

  // (3) Lazily load xrpl (or use the injected stub) and submit.
  const xrpl = opts.deps?.xrpl || (await loadXrpl());
  const client = new xrpl.Client(wsUrl);
  await client.connect();
  let receipt;
  try {
    const wallet = xrpl.Wallet.fromSeed(seed);
    const tx = {
      TransactionType: 'AccountSet',
      Account: wallet.address,
      Memos: [memo],
    };
    const result = await client.submitAndWait(tx, { wallet });
    const txHash = result?.result?.hash || result?.result?.tx_json?.hash || null;
    const engineResult = result?.result?.meta?.TransactionResult || result?.result?.engine_result;
    const closeTimeIso = extractCloseTime(result);
    const ledgerIndex = extractLedgerIndex(result);

    receipt = {
      ok: engineResult === 'tesSUCCESS',
      network,
      anchor_seq: manifest.anchor_seq,
      root: manifest.root,
      manifest_hash: manifest.manifest_hash,
      leaf_count: manifest.leaf_count,
      seq_range: manifest.seq_range,
      head_digest: manifest.head_digest,
      tx_hash: txHash,
      wallet_address: wallet.address,
      ledger_index: ledgerIndex,
      close_time_iso: closeTimeIso,
      engine_result: engineResult,
    };
  } finally {
    await client.disconnect();
  }

  // (4) Record the on-chain facts back into the anchor manifest. Injected in
  //     tests; in production it patches the manifest file in place.
  if (receipt.ok && typeof opts.deps?.recordPost === 'function') {
    opts.deps.recordPost(manifest.anchor_seq, {
      tx_hash: receipt.tx_hash,
      ledger_index: receipt.ledger_index,
      close_time_iso: receipt.close_time_iso,
      wallet_address: receipt.wallet_address,
      network,
    });
  }

  return receipt;
}
