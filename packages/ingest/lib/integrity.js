/**
 * Integrity chain v1 — the trust-critical core of the tamper-EVIDENT record chain.
 *
 * This module is the ONLY place a record digest is computed. Both the persist
 * layer (which stamps `record.integrity` and appends a manifest line) and the
 * chain verifier (`verify-chain.js`, which recomputes the digest to detect
 * tampering) import `canonicalize` + `submissionDigest` from here, so the two
 * sides agree BY CONSTRUCTION — there is no second implementation that could
 * drift and silently make the verifier disagree with what persist wrote.
 *
 * Honesty note (threat model): this is tamper-EVIDENT, not tamper-PROOF. An
 * actor holding the ingest write credential can rewrite a record AND recompute
 * its digest AND rewrite the manifest line, producing a chain that re-verifies
 * clean. What the chain buys is detection of any in-place mutation not
 * consistently reflected in both the record and the ledger — disk corruption,
 * an out-of-band edit, a partial restore, a malicious push that touched a record
 * file but not the ledger — plus middle-deletion / reorder / insertion. It does
 * NOT detect tail TRUNCATION (a shorter chain still verifies); only an external
 * head/count anchor outside the writer's control (the optional XRPL anchor) can.
 * The coordinator owns the full threat-model writeup; this module just builds
 * the mechanism honestly.
 */

import { createHash } from 'node:crypto';

/**
 * GENESIS_DIGEST — the sentinel `prev_digest` for the first chain entry (seq 0).
 * 64 hex zeros: a value no real sha256 hex digest will ever collide with in
 * practice, and visually obvious in a manifest as "this is the head of chain".
 */
export const GENESIS_DIGEST = '0'.repeat(64);

/**
 * Deterministic JSON serialization.
 *
 * Canonicalization rule (EXACT — this is a contract, document any change):
 *   - Objects: keys are emitted in ASCENDING (default JS string `<`) order,
 *     recursively at every depth, including objects nested inside arrays.
 *   - Arrays: element ORDER is preserved (arrays are positional data; reordering
 *     them is a real content change, so they are NOT sorted).
 *   - No insignificant whitespace — equivalent to `JSON.stringify(value)` over a
 *     deeply key-sorted clone (the two-arg `JSON.stringify(value, replacer)`
 *     form already drops all whitespace; the replacer below only reorders keys).
 *   - Primitives (string/number/boolean/null) serialize exactly as
 *     `JSON.stringify` would. `undefined` object properties are dropped, matching
 *     `JSON.stringify` — records are plain JSON so this never bites in practice.
 *
 * Implementation note: a `JSON.stringify` replacer is called with each value
 * AFTER `JSON.stringify` has already enumerated its keys, so we cannot reorder
 * via the replacer alone. Instead we build a deep, key-sorted clone first, then
 * stringify it with no spacing argument. This is the canonical "sort-then-
 * stringify" approach and is stable across V8 versions because we never rely on
 * native key-enumeration order for the output.
 *
 * @param {*} value - Any JSON-serializable value.
 * @returns {string} Deterministic JSON string.
 */
export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

/**
 * Deep clone with object keys sorted ascending at every depth. Arrays keep
 * order (only their element objects are key-sorted). Primitives pass through.
 *
 * F-755d0f3f: the accumulator MUST be null-prototype. On a plain `{}` the
 * assignment below would hit the inherited `Object.prototype.__proto__` setter
 * for an own `__proto__` key and retarget the accumulator's prototype instead of
 * creating an own key — dropping that field, and everything under it, from the
 * canonical string and therefore from the record digest. `JSON.parse` creates a
 * real own `__proto__` data property (CreateDataProperty, not Set), so any
 * record file on disk can carry one, and verify-chain.js reaches this via a bare
 * `JSON.parse` with no schema gate. That made two materially different records
 * hash identically and let a tampered record re-verify clean.
 *
 * `JSON.stringify` serializes a null-prototype object identically to a plain
 * one, so this is byte-for-byte compatible with every already-persisted record
 * and the committed chain is unaffected.
 */
function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the canonical sha256 digest of a record, EXCLUDING its `integrity`
 * block.
 *
 * The digest is computed over the record WITHOUT `integrity` because the digest
 * is itself stored inside `integrity.submission_digest` — you cannot hash the
 * digest into itself. Stripping `integrity` also makes the digest stable: a
 * record's digest is identical before and after persist stamps its integrity
 * block, which is exactly what lets the verifier recompute it later and compare.
 *
 * The strip is on a SHALLOW CLONE — the caller's record object is never mutated.
 *
 * @param {object} record - The record (may or may not already carry `integrity`).
 * @returns {string} Lowercase 64-char hex sha256 of `canonicalize(record-without-integrity)`.
 */
export function submissionDigest(record) {
  const { integrity: _omit, ...withoutIntegrity } = record;
  return createHash('sha256').update(canonicalize(withoutIntegrity), 'utf-8').digest('hex');
}
