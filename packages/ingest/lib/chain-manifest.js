/**
 * Chain manifest — the append-only ledger backing the tamper-evident record
 * chain. One JSON line per persisted record (accepted AND rejected) at
 * `indexes/integrity/chain.jsonl`. The manifest IS the ordered chain: its last
 * line is the head, and `prev_digest`/`seq` thread every line back to genesis.
 *
 * This is the analog of an event-sourced `events.jsonl` ledger. Each line:
 *   { seq, run_id, repo, status, path, submission_digest, prev_digest, persisted_at }
 *
 * Atomicity / concurrency assumption (LOCKED CONTRACT step 4 + step "serialized
 * ingest"): ingest is serialized — `ingest.yml` runs with workflow-level
 * concurrency and `writeRecord` is synchronous. So a read-head-then-append cycle
 * is race-free in production. We therefore implement the append as a
 * read-current-file + rewrite-whole via temp+rename (`atomicWriteFileSync`):
 * the rewrite is atomic (a reader sees either the pre-append or post-append
 * file, never a torn half-line), which is the strongest non-tear guarantee
 * available without a real append-with-fsync primitive. A plain `appendFileSync`
 * would also be effectively atomic for a single sub-PIPE_BUF line, but the
 * rewrite keeps us inside the repo's established temp+rename doctrine and is
 * robust to a torn previous write.
 *
 * OUT OF SCOPE (documented, not built): truly-concurrent ingest (two writers
 * appending at once) would need a fork — file locking or a serializing queue —
 * because two read-head cycles could both observe the same head and assign the
 * same seq. The serialized-ingest assumption above is what makes this safe; a
 * concurrent-ingest fork is explicitly deferred.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { atomicWriteFileSync } from './atomic-write.js';
import { GENESIS_DIGEST } from './integrity.js';

/** Repo-root-relative path to the append-only chain ledger. */
export const CHAIN_MANIFEST_REL = 'indexes/integrity/chain.jsonl';

/** Absolute path to the chain manifest for a given repo root. */
export function chainManifestPath(repoRoot) {
  return join(repoRoot, 'indexes', 'integrity', 'chain.jsonl');
}

/**
 * Read every chain entry in order. Returns [] when the manifest does not exist
 * yet (an empty chain is a valid chain — genesis with zero entries).
 *
 * @param {string} repoRoot
 * @returns {Array<object>} Parsed entries, in file (chain) order.
 */
export function readChainManifest(repoRoot) {
  const path = chainManifestPath(repoRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      // A non-JSON line is itself tamper/corruption evidence. Surface it with
      // the line index rather than letting JSON.parse throw an opaque error.
      const e = new Error(`chain.jsonl line ${i + 1} is not valid JSON: ${err.message}`);
      e.code = 'CHAIN_MANIFEST_CORRUPT';
      e.line = i + 1;
      throw e;
    }
  });
}

/**
 * Read the head (last entry) of the chain, or a synthetic genesis head when the
 * chain is empty. The returned `{ submission_digest, seq }` is exactly what an
 * appender needs to compute the next entry's `prev_digest` and `seq`.
 *
 * @param {string} repoRoot
 * @returns {{ submission_digest: string, seq: number }} Genesis when empty:
 *   `{ submission_digest: GENESIS_DIGEST, seq: -1 }` so `seq + 1 === 0`.
 */
export function readChainHead(repoRoot) {
  const entries = readChainManifest(repoRoot);
  if (entries.length === 0) {
    return { submission_digest: GENESIS_DIGEST, seq: -1 };
  }
  const head = entries[entries.length - 1];
  return { submission_digest: head.submission_digest, seq: head.seq };
}

/**
 * Append one entry to the chain ledger atomically (read-current + rewrite-whole
 * via temp+rename). The trailing newline is normalized so the file is always a
 * clean newline-terminated JSONL.
 *
 * @param {string} repoRoot
 * @param {object} entry - A fully-formed chain line (caller computes seq/digests).
 */
export function appendChainEntry(repoRoot, entry) {
  const path = chainManifestPath(repoRoot);
  // The ledger lives under indexes/integrity/, which may not exist on the first
  // write into a fresh repo root (or a test sandbox). Create it idempotently.
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  // Normalize: strip any trailing whitespace/newlines, re-add exactly one \n
  // per line so a previously torn write cannot leave a double-blank line.
  const body = existing.replace(/\s+$/, '');
  const next = (body.length > 0 ? body + '\n' : '') + JSON.stringify(entry) + '\n';
  atomicWriteFileSync(path, next);
}
