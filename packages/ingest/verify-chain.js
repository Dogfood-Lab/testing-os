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
import { join, relative, sep } from 'node:path';

import { submissionDigest, GENESIS_DIGEST } from './lib/integrity.js';
import { readChainManifest } from './lib/chain-manifest.js';
import { findJsonFiles } from './rebuild-indexes.js';

/**
 * @typedef {object} ChainBreak
 * @property {number} seq - The seq at which verification failed.
 * @property {string|null} run_id - The run_id of the failing entry, if known.
 * @property {string} reason - Operator-legible description of what failed.
 */

/**
 * @typedef {object} ChainOrphan
 * @property {string|null} run_id - The orphan record's run_id (from its
 *   integrity block or its body), if known.
 * @property {number|null} seq - The orphan record's self-claimed integrity.seq.
 * @property {string} path - Repo-relative, forward-slashed path to the orphan file.
 * @property {string} reason - Operator-legible description of why it is an orphan.
 */

/**
 * @typedef {object} ChainVerifyResult
 * @property {boolean} ok - True when the whole chain verifies (and, when
 *   collectOrphans is set, no orphan records exist).
 * @property {number} count - Number of entries verified (0 for an empty chain).
 * @property {string} head_digest - submission_digest of the last entry, or
 *   GENESIS_DIGEST for an empty chain.
 * @property {ChainBreak|null} break - First break, or null when ok.
 * @property {ChainBreak[]} [breaks] - All independent breaks (only present when
 *   `collectAllBreaks` is set). The first element equals `break`.
 * @property {ChainOrphan[]} [orphans] - Records on disk but absent from the
 *   ledger (only present when `collectOrphans` is set).
 */

/**
 * Verify the integrity chain at `<repoRoot>/indexes/integrity/chain.jsonl`.
 *
 * @param {string} repoRoot - Absolute path to the testing-os repo root.
 * @param {object} [opts]
 * @param {boolean} [opts.collectAllBreaks=false] - INGEST-PROACT-004: continue
 *   past the FIRST break and return a `breaks[]` array of every
 *   per-record-independent break (digest-mismatch, missing-file). The default
 *   (false) stops at the first break — the fail-fast CI gate semantics. A
 *   structural break (non-monotonic seq, broken prev-link) still stops the
 *   walk even under this flag, because everything after it is unverifiable
 *   relative to a now-untrustworthy chain order.
 * @param {boolean} [opts.collectOrphans=false] - INGEST-PROACT-001: after the
 *   chain walk, reconcile the on-disk records against the ledger and return an
 *   `orphans[]` array of any record file whose seq/run_id is absent from the
 *   ledger (a torn write between record-write and ledger-append). An orphan
 *   makes the result `ok: false` — the audit DETECTS the orphan instead of
 *   silently passing while a real record lives outside the tamper-evident chain.
 * @returns {ChainVerifyResult}
 */
export function verifyChain(repoRoot, opts = {}) {
  const collectAllBreaks = opts.collectAllBreaks === true;
  const collectOrphans = opts.collectOrphans === true;

  let entries;
  try {
    entries = readChainManifest(repoRoot);
  } catch (err) {
    // A corrupt (non-JSON) manifest line is itself a tamper signal. We cannot
    // trust the ledger at all here, so orphan reconciliation is not meaningful.
    const brk = { seq: -1, run_id: null, reason: err.message };
    return {
      ok: false,
      count: 0,
      head_digest: GENESIS_DIGEST,
      break: brk,
      ...(collectAllBreaks ? { breaks: [brk] } : {}),
      ...(collectOrphans ? { orphans: [] } : {}),
    };
  }

  const headDigest = entries.length === 0
    ? GENESIS_DIGEST
    : (entries[entries.length - 1].submission_digest ?? GENESIS_DIGEST);

  const breaks = [];
  let prevDigest = GENESIS_DIGEST;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const seq = entry.seq;
    const runId = entry.run_id ?? null;
    const record = (reason) => breaks.push({ seq, run_id: runId, reason });

    // (3) Monotonic seq and (2) chain-link are STRUCTURAL: a break here means
    // the chain order itself is untrustworthy, so everything downstream is
    // unverifiable relative to it. Record the break and stop — even under
    // collectAllBreaks — rather than emitting a cascade of meaningless
    // downstream prev-link errors.
    if (seq !== i) {
      record(`seq is not monotonic: expected ${i}, found ${seq}`);
      break;
    }
    if (entry.prev_digest !== prevDigest) {
      record(`broken prev_digest link: expected ${prevDigest}, found ${entry.prev_digest}`);
      break;
    }

    // (1) Per-record-INDEPENDENT checks: missing-file and digest-mismatch.
    // Each is judged on this record alone, so under collectAllBreaks we record
    // the break and CONTINUE to surface the full corruption scope. Under the
    // default we record the first and stop.
    const recordPath = join(repoRoot, entry.path);
    if (!existsSync(recordPath)) {
      record(`record file missing at ${entry.path} (could not read to recompute digest)`);
      if (!collectAllBreaks) break;
      prevDigest = entry.submission_digest;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(recordPath, 'utf-8'));
    } catch (err) {
      record(`record file at ${entry.path} is not valid JSON: ${err.message}`);
      if (!collectAllBreaks) break;
      prevDigest = entry.submission_digest;
      continue;
    }

    const recomputed = submissionDigest(parsed);
    if (recomputed !== entry.submission_digest) {
      record(
        `digest mismatch: recomputed ${recomputed} but manifest claims ${entry.submission_digest} ` +
        `— record at ${entry.path} was modified after persist`
      );
      if (!collectAllBreaks) break;
      prevDigest = entry.submission_digest;
      continue;
    }

    const selfDigest = parsed.integrity?.submission_digest;
    if (selfDigest !== recomputed) {
      record(
        `record self-digest mismatch: record.integrity.submission_digest is ` +
        `${selfDigest ?? '(absent)'} but recomputed ${recomputed} — record at ${entry.path} ` +
        `was modified after persist`
      );
      if (!collectAllBreaks) break;
      prevDigest = entry.submission_digest;
      continue;
    }

    prevDigest = entry.submission_digest;
  }

  const orphans = collectOrphans ? collectOrphanRecords(repoRoot, entries) : null;

  const ok = breaks.length === 0 && (orphans === null || orphans.length === 0);
  return {
    ok,
    count: entries.length,
    head_digest: headDigest,
    break: breaks.length > 0 ? breaks[0] : null,
    ...(collectAllBreaks ? { breaks } : {}),
    ...(collectOrphans ? { orphans } : {}),
  };
}

/**
 * INGEST-PROACT-001 — reconcile on-disk records against the ledger.
 *
 * Walks every `*.json` under `records/` (accepted AND `_rejected/`) and flags
 * any record file whose repo-relative PATH is absent from the ledger. Such a
 * file is an ORPHAN: persist wrote the record but the ledger append did not
 * happen (a crash in the torn window between the two steps), so the record
 * exists OUTSIDE the tamper-evident chain and the plain chain-walk is blind to
 * it. The chain-manifest's own ledger lines are NOT under `records/`, so they
 * are never mistaken for orphans.
 *
 * F-d4bcf5d0 (wave 10, HIGH): this used to ALSO fall back to a run_id-only
 * match — "a record is accounted for if EITHER its path OR its run_id is
 * ledgered anywhere". That fallback was unsound: a single run_id can
 * legitimately own TWO on-disk records at TWO different paths (the
 * accepted-after-a-prior-rejection resubmission flow persist.js's
 * isRetryableRejection carve-out exists for — see
 * F-0f9e4077/F-4036ae25/F-f8952a50), each needing its OWN ledger line. Once
 * ANY entry for a run_id was ledgered, the fallback treated EVERY later
 * record sharing that run_id as accounted for — including one at a
 * genuinely un-ledgered path, exactly the torn-write shape this
 * reconciliation pass exists to catch (proven live: a ledgered `_rejected`
 * record followed by an accepted record for the SAME run_id whose OWN
 * ledger line was then lost — the plain run_id match hid the orphan).
 * Path identity is both the necessary AND the sufficient check: every ledger
 * line carries an exact `path` field (lib/chain-manifest.js's documented
 * line shape, always populated by persist.js's appendChainEntry call), and
 * this function's own `relPath` computation (`relative(repoRoot,
 * absPath).split(sep).join('/')`) is the identical normalization persist.js
 * uses to produce that field. Dropping the run_id fallback removes the
 * unsound generalization without weakening real coverage — see
 * ingest-proact-001-004-verify-chain-reconcile-allbreaks.test.js's
 * 'shared run_id, different paths' regression test.
 *
 * @param {string} repoRoot
 * @param {Array<object>} entries - The ledger entries (already read).
 * @returns {ChainOrphan[]}
 */
function collectOrphanRecords(repoRoot, entries) {
  const ledgerPaths = new Set();
  for (const e of entries) {
    if (e.path) ledgerPaths.add(e.path);
  }

  const orphans = [];
  const recordsDir = join(repoRoot, 'records');
  for (const absPath of findJsonFiles(recordsDir)) {
    const relPath = relative(repoRoot, absPath).split(sep).join('/');
    if (ledgerPaths.has(relPath)) continue;

    let record;
    try {
      record = JSON.parse(readFileSync(absPath, 'utf-8'));
    } catch {
      // A record file we cannot even parse, that is also absent from the ledger,
      // is still an orphan — report it with what little identity we have.
      orphans.push({
        run_id: null,
        seq: null,
        path: relPath,
        reason: `record file present on disk but absent from the ledger, and not valid JSON`,
      });
      continue;
    }

    orphans.push({
      run_id: record.run_id ?? null,
      seq: record.integrity?.seq ?? null,
      path: relPath,
      reason:
        `record present on disk but absent from the ledger — a torn persist ` +
        `(record written, ledger append missed). Re-run ingest for this record ` +
        `or rebuild the chain to admit it into the tamper-evident ledger.`,
    });
  }

  return orphans;
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
    const lines = [
      `integrity chain OK: ${result.count} record(s) verified`,
      `head digest: ${result.head_digest}`,
    ];
    if (Array.isArray(result.orphans)) {
      lines.push(`reconciliation: 0 orphan record(s) on disk`);
    }
    return lines;
  }

  const lines = [];

  // INGEST-PROACT-004: when collectAllBreaks populated breaks[], list every
  // independent break so the operator sees the full corruption scope in one
  // pass. Otherwise report the single first break (the CI-gate default).
  const allBreaks = Array.isArray(result.breaks) ? result.breaks : (result.break ? [result.break] : []);
  if (allBreaks.length > 1) {
    lines.push(`integrity chain BROKEN: ${allBreaks.length} break(s) found`);
    for (const b of allBreaks) {
      lines.push(`  - seq ${b.seq}${b.run_id ? ` (run_id: ${b.run_id})` : ''}: ${b.reason}`);
    }
  } else if (allBreaks.length === 1) {
    const b = allBreaks[0];
    lines.push(`integrity chain BROKEN at seq ${b.seq}${b.run_id ? ` (run_id: ${b.run_id})` : ''}`);
    lines.push(`reason: ${b.reason}`);
  }

  // INGEST-PROACT-001: an orphan makes the result not-ok even with zero chain
  // breaks — name each orphan file + run_id and the recovery action.
  if (Array.isArray(result.orphans) && result.orphans.length > 0) {
    lines.push(`reconciliation: ${result.orphans.length} orphan record(s) on disk but absent from the ledger`);
    for (const o of result.orphans) {
      lines.push(`  - ${o.path}${o.run_id ? ` (run_id: ${o.run_id})` : ''}: ${o.reason}`);
    }
  }

  return lines;
}
