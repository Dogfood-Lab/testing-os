/**
 * Atomic file write — temp+rename so torn writes never silently drop a file
 * from listings. `rename` is atomic on POSIX and Windows: a concurrent reader
 * sees either the old contents or the new contents — never a half-written file.
 *
 * Mirrors the pattern in `packages/ingest/persist.js` and
 * `packages/ingest/rebuild-indexes.js`. Originally extracted from
 * `packages/findings/review/event-log.js` (wave 9). Used by the artifact
 * writers in `derive/`, `synthesis/`, and `review/` to close the sibling-fix
 * gap from F-721047-010 — every loader in this pipeline has a try/empty-catch,
 * so torn YAML disappears from listings without surfacing an error.
 *
 * Concurrency caveat: this protects against partial-file corruption only.
 * Two simultaneous writers can still race read-then-write at the caller level.
 * Callers needing read-modify-write atomicity must serialize externally.
 */

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Atomically write `content` to `path`.
 *
 * @param {string} path - Final destination path.
 * @param {string} content - File contents.
 * @param {BufferEncoding} [encoding='utf-8'] - Write encoding.
 * @returns {string} - The path that was written.
 */
export function atomicWriteFileSync(path, content, encoding = 'utf-8') {
  const tmpSuffix = randomBytes(4).toString('hex');
  const tmpPath = `${path}.${tmpSuffix}.tmp`;
  try {
    // Indirect via `fs.*` (not destructured imports) so test mocks of
    // `fs.writeFileSync` reach this code path. Behavior is identical.
    fs.writeFileSync(tmpPath, content, encoding);
    fs.renameSync(tmpPath, path);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
  return path;
}
