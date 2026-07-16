/**
 * verify-window.js — shared line-bucket window computation for the verify-*
 * classifier family (v1 lib/verify-fixed.js and v2 lib/verify-classifier-v2.js).
 *
 * F-b9de9cb6 / F-d4e09870 (wave 22, one class, two call sites): both files
 * carried the BYTE-IDENTICAL asymmetric formula — `start: Math.max(1, bucket
 * - FINGERPRINT_BUCKET)` correctly reached a full bucket below the recorded
 * line's own bucket, but `end: bucket + FINGERPRINT_BUCKET` reached only the
 * FIRST LINE of the neighbouring bucket above, never through it. Both files'
 * own docblocks claimed the window was SYMMETRIC (citing ve-003, a prior fix
 * that closed the DOWNWARD-only gap) — a claim neither implementation
 * actually met upward. A finding recorded at line 42 (own bucket [40,49])
 * was scanned only up to line 50, when a genuinely symmetric window reaches
 * line 59 (the END of the neighbouring bucket [50,59]) — silently missing
 * any upward anchor drift of 9+ lines with no upper bound, the common case
 * when a later commit adds code ABOVE the flagged function (new import, new
 * helper, expanded docs) in the same file.
 *
 * Extracted here rather than hand-synchronized in both files — the state
 * that let the identical formula ship twice and go unnoticed for at least
 * one prior wave. v1 and v2 now share one implementation and this module's
 * test coverage protects both callers at once.
 *
 * @module lib/verify-window
 */

/**
 * Width of the line-bucket window (lines). A finding's own bucket is
 * `[FINGERPRINT_BUCKET*n, FINGERPRINT_BUCKET*n + FINGERPRINT_BUCKET - 1]`
 * (e.g. line 42 → bucket [40, 49]).
 */
export const FINGERPRINT_BUCKET = 10;

/**
 * Compute the scan window `[start, end]` inclusive around `recordedLine`.
 * If no line was recorded (0 / null / undefined), the caller should scan
 * the entire file — this returns `{ start: 1, end: totalLines }` for that
 * case, matching both callers' pre-existing whole-file fallback.
 *
 * The window is genuinely SYMMETRIC:
 *   - `start` reaches the START of the bucket below (`bucket -
 *     FINGERPRINT_BUCKET`, clamped to line 1) — already the window's
 *     inclusive lower bound, so no further widening is needed on this side.
 *   - `end` reaches the END of the bucket above (`bucket + 2 *
 *     FINGERPRINT_BUCKET - 1`), not merely its first line — the asymmetry
 *     F-b9de9cb6 / F-d4e09870 fixed.
 *
 * Example: recordedLine=42 → own bucket [40,49]. Window is [30, 59]: a full
 * bucket down to [30,39] and a full bucket up to [50,59].
 *
 * @param {number} recordedLine — 1-indexed line number, or a falsy value /
 *   any value <= 0 for "no line recorded".
 * @param {number} totalLines — the target file's line count (upper bound
 *   for the no-recorded-line whole-file scan).
 * @returns {{start: number, end: number}}
 */
export function bucketForLine(recordedLine, totalLines) {
  if (!recordedLine || recordedLine <= 0) {
    return { start: 1, end: totalLines };
  }
  const bucket = Math.floor(recordedLine / FINGERPRINT_BUCKET) * FINGERPRINT_BUCKET;
  return {
    start: Math.max(1, bucket - FINGERPRINT_BUCKET),
    end: bucket + 2 * FINGERPRINT_BUCKET - 1,
  };
}

/**
 * Search for `anchor` in `lines` between bucket bounds (1-indexed,
 * inclusive on both ends). Returns the matched line number or `null`.
 *
 * @param {string[]} lines — 0-indexed array of file lines (line N is
 *   `lines[N-1]`).
 * @param {RegExp} anchor
 * @param {number} bucketStart
 * @param {number} bucketEnd
 * @returns {number | null}
 */
export function findAnchorInBucket(lines, anchor, bucketStart, bucketEnd) {
  const end = Math.min(bucketEnd, lines.length);
  for (let lineNo = bucketStart; lineNo <= end; lineNo++) {
    const text = lines[lineNo - 1];
    if (typeof text === 'string' && anchor.test(text)) {
      return lineNo;
    }
  }
  return null;
}
