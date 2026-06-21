/**
 * Chain verifier — the offline tamper-evidence gate.
 *
 * `verifyChain(repoRoot)` reads the append-only ledger at
 * `indexes/integrity/chain.jsonl` and, FULLY OFFLINE (no network, no GitHub
 * API), proves the chain is internally consistent:
 *
 *   1. For each entry, load the record file at `entry.path` and recompute its
 *      digest with the SAME `submissionDigest` helper persist used. Assert it
 *      equals BOTH `entry.submission_digest` (the ledger's claim) AND
 *      `record.integrity.submission_digest` (the record's self-claim). All three
 *      must agree — a tamper that touches the record but not the ledger, or the
 *      ledger but not the record, breaks one of these equalities.
 *   2. Assert `entry.prev_digest` equals the PREVIOUS entry's
 *      `submission_digest` (GENESIS_DIGEST for seq 0) — the chain link.
 *   3. Assert `seq` is 0,1,2,… strictly monotonic from 0.
 *
 * On the FIRST break it stops and reports `{ seq, run_id, reason }`; the caller
 * (`--verify-chain` in run.js, or any consumer) exits non-zero. On success it
 * returns the record count and head digest.
 *
 * Honesty (threat model): this is tamper-EVIDENT, not tamper-PROOF. An actor
 * with the ingest write credential can rewrite a record, recompute its digest,
 * and rewrite the matching ledger line — that re-verifies clean. The verifier
 * catches any mutation to a record or ledger entry that is NOT consistently
 * reflected in BOTH (an out-of-band edit, disk corruption, a partial restore, a
 * push that touched a record but not the chain), and it catches middle-deletion,
 * reorder, and forged-insertion (they break the seq run or the prev-link).
 *
 * KNOWN LIMITATION — tail truncation. Removing the most-recent entries (and
 * their record files) leaves a SHORTER but internally-consistent chain, which
 * verifies OK: the offline verifier has no external record of the expected head
 * or leaf-count, so it can prove what remains is consistent but NOT that the
 * chain is COMPLETE. Detecting truncation requires an external anchor of the
 * head/count outside the writer's control — exactly what the optional XRPL
 * anchor provides (its on-chain Merkle root + leaf count make any truncation
 * BELOW an anchored point detectable). The offline chain alone is a completeness
 * floor for in-place tampering, not a defense against tail truncation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { submissionDigest, GENESIS_DIGEST } from './lib/integrity.js';
import { readChainManifest } from './lib/chain-manifest.js';

/**
 * @typedef {object} ChainBreak
 * @property {number} seq - The seq at which verification failed.
 * @property {string|null} run_id - The run_id of the failing entry, if known.
 * @property {string} reason - Operator-legible description of what failed.
 */

/**
 * @typedef {object} ChainVerifyResult
 * @property {boolean} ok - True when the whole chain verifies.
 * @property {number} count - Number of entries verified (0 for an empty chain).
 * @property {string} head_digest - submission_digest of the last entry, or
 *   GENESIS_DIGEST for an empty chain.
 * @property {ChainBreak|null} break - First break, or null when ok.
 */

/**
 * Verify the integrity chain at `<repoRoot>/indexes/integrity/chain.jsonl`.
 *
 * @param {string} repoRoot - Absolute path to the testing-os repo root.
 * @returns {ChainVerifyResult}
 */
export function verifyChain(repoRoot) {
  let entries;
  try {
    entries = readChainManifest(repoRoot);
  } catch (err) {
    // A corrupt (non-JSON) manifest line is itself a tamper signal.
    return {
      ok: false,
      count: 0,
      head_digest: GENESIS_DIGEST,
      break: { seq: -1, run_id: null, reason: err.message },
    };
  }

  if (entries.length === 0) {
    // An empty chain is trivially valid: genesis with no entries.
    return { ok: true, count: 0, head_digest: GENESIS_DIGEST, break: null };
  }

  let prevDigest = GENESIS_DIGEST;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const seq = entry.seq;
    const runId = entry.run_id ?? null;

    const fail = (reason) => ({
      ok: false,
      count: entries.length,
      head_digest: entries[entries.length - 1].submission_digest ?? GENESIS_DIGEST,
      break: { seq, run_id: runId, reason },
    });

    // (3) Monotonic seq: 0,1,2,…
    if (seq !== i) {
      return fail(`seq is not monotonic: expected ${i}, found ${seq}`);
    }

    // (2) Chain link: this entry's prev_digest must equal the previous entry's
    // submission_digest (GENESIS for the first entry).
    if (entry.prev_digest !== prevDigest) {
      return fail(
        `broken prev_digest link: expected ${prevDigest}, found ${entry.prev_digest}`
      );
    }

    // (1) Load the record and recompute its digest.
    const recordPath = join(repoRoot, entry.path);
    if (!existsSync(recordPath)) {
      return fail(`record file missing at ${entry.path} (could not read to recompute digest)`);
    }

    let record;
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    } catch (err) {
      return fail(`record file at ${entry.path} is not valid JSON: ${err.message}`);
    }

    const recomputed = submissionDigest(record);

    // The recomputed digest must equal the ledger's claim.
    if (recomputed !== entry.submission_digest) {
      return fail(
        `digest mismatch: recomputed ${recomputed} but manifest claims ${entry.submission_digest} ` +
        `— record at ${entry.path} was modified after persist`
      );
    }

    // …AND the record's own self-certified digest.
    const selfDigest = record.integrity?.submission_digest;
    if (selfDigest !== recomputed) {
      return fail(
        `record self-digest mismatch: record.integrity.submission_digest is ` +
        `${selfDigest ?? '(absent)'} but recomputed ${recomputed} — record at ${entry.path} ` +
        `was modified after persist`
      );
    }

    prevDigest = entry.submission_digest;
  }

  return {
    ok: true,
    count: entries.length,
    head_digest: entries[entries.length - 1].submission_digest,
    break: null,
  };
}

/**
 * Render a verifyChain result as operator-legible lines (no raw stack traces).
 * Returned as an array so callers can choose the sink (console.log/console.error).
 *
 * @param {ChainVerifyResult} result
 * @returns {string[]}
 */
export function formatChainResult(result) {
  if (result.ok) {
    return [
      `integrity chain OK: ${result.count} record(s) verified`,
      `head digest: ${result.head_digest}`,
    ];
  }
  const b = result.break;
  return [
    `integrity chain BROKEN at seq ${b.seq}${b.run_id ? ` (run_id: ${b.run_id})` : ''}`,
    `reason: ${b.reason}`,
  ];
}
