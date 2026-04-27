/**
 * Atomic file write — temp+rename so torn writes never silently drop a file
 * from listings. `rename` is atomic on POSIX and Windows: a concurrent reader
 * sees either the old contents or the new contents — never a half-written file.
 *
 * Sibling of `packages/findings/lib/atomic-write.js`. The two files have the
 * same contract; the duplication exists because npm workspaces do not allow
 * `ingest → findings` imports (findings already depends on ingest, and adding
 * the reverse edge would create a workspace dependency cycle). Class #6
 * helper-adoption-sweep treats them as a single canonical pattern even though
 * the source lives in two places — the canonical contract is "one writeFileSync
 * to a temp suffix, then renameSync; no caller assembles the temp+rename
 * pattern inline anywhere else under packages/ingest/."
 *
 * Used by `rebuild-indexes.js` for the per-file leg of its multi-file commit
 * group (W3-PIPE-002). The commit group itself is a thin layer on top of
 * this helper — see `commitGroupRename` in rebuild-indexes for that.
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
    // `fs.writeFileSync` reach this code path. Mirrors findings/lib/atomic-write.js.
    fs.writeFileSync(tmpPath, content, encoding);
    fs.renameSync(tmpPath, path);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
  return path;
}

/**
 * Stage `content` to a temp file alongside `path`. Returns the temp path so
 * a later commit-group operation can rename it. Does NOT remove the temp
 * if the caller throws — caller owns cleanup via `discardStaged`.
 *
 * Why exposed: `rebuild-indexes.js` needs a two-phase-commit shape — write
 * all 3 temps, THEN rename them all in sequence. The non-staging
 * `atomicWriteFileSync` couples write+rename, which is exactly what we
 * cannot do for multi-file atomicity.
 *
 * @param {string} path - Final destination path (NOT created here).
 * @param {string} content
 * @param {BufferEncoding} [encoding='utf-8']
 * @returns {string} The temp path holding the staged content.
 */
export function stageWriteFileSync(path, content, encoding = 'utf-8') {
  const tmpSuffix = randomBytes(4).toString('hex');
  const tmpPath = `${path}.${tmpSuffix}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    return tmpPath;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
}

/**
 * Promote one staged temp path to its final name. Wraps `renameSync` so
 * call sites don't have to know the rename is the only step. Throws on
 * failure; partial-failure handling is the caller's responsibility (see
 * `rebuild-indexes.js`'s `commitGroupRename` for the multi-file case).
 *
 * @param {string} tmpPath
 * @param {string} finalPath
 */
export function promoteStaged(tmpPath, finalPath) {
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Best-effort cleanup of staged temp files. Safe to call on a path that
 * doesn't exist.
 *
 * @param {string} tmpPath
 */
export function discardStaged(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch { /* may not exist */ }
}
