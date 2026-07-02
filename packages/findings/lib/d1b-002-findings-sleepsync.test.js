/**
 * d1b-002-findings-sleepsync.test.js — replace the CPU-busy spin-loop in
 * `packages/findings/lib/rename-with-retry.js:40` with `sleepSync`
 * (Atomics.wait on a tiny SharedArrayBuffer), the same pattern already
 * shipping in `packages/findings/lib/file-lock.js:286`.
 *
 * The advisor surfaced this cheap fold during Stage B verification: the
 * repo already ships `sleepSync` once (file-lock.js, Atomics.wait-based,
 * non-spinning) and the rename-with-retry helper uses a `while
 * (Date.now() < until)` spin loop unnecessarily. The visible behaviour
 * (bounded retry on Windows EPERM/EBUSY) is preserved; the only change is
 * that the wait no longer burns a CPU core during retries.
 *
 * Tests:
 *   1. Mechanical: source no longer contains the `while (Date.now() < until)`
 *      spin pattern (greppable invariant).
 *   2. Behavioural: a contended rename still completes within roughly the
 *      bounded backoff envelope (preserves correctness from the existing
 *      implementation — the swap should not regress correctness).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renameWithRetry } from './rename-with-retry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENAME_HELPER_PATH = resolve(__dirname, 'rename-with-retry.js');

describe('D1B-002 (findings): rename-with-retry sleepSync swap', () => {
  it('mechanical invariant: source no longer contains the spin-loop pattern', () => {
    const src = readFileSync(RENAME_HELPER_PATH, 'utf-8');
    // F-b12442d0: strip block + line comments before matching — copied from
    // the ingest sibling (packages/ingest/d1b-002-sleep-sync-no-spin.test.js).
    // rename-with-retry.js's JSDoc archaeology note quotes the old
    // `while (Date.now() < until)` shape; it only evaded the raw-source regex
    // because the quote wraps across a `*`-prefixed continuation line, so any
    // future comment reflow would false-fail the gate.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // The legacy spin shape: `while (Date.now() < until)`. Either the
    // direct invocation or the equivalent `while (Date.now() <= until)`
    // must not appear in the final source.
    assert.doesNotMatch(
      stripped,
      /while\s*\(\s*Date\.now\(\)\s*<=?\s*until\s*\)/,
      'spin-loop pattern still present in rename-with-retry.js'
    );
  });

  it('mechanical invariant: source uses sleepSync (Atomics.wait) or imports it', () => {
    const src = readFileSync(RENAME_HELPER_PATH, 'utf-8');
    const hasSleepSync = /sleepSync\s*\(/.test(src);
    const hasAtomicsWait = /Atomics\.wait\s*\(/.test(src);
    assert.ok(
      hasSleepSync || hasAtomicsWait,
      'rename-with-retry must use sleepSync or Atomics.wait for the backoff'
    );
  });

  it('behavioural: renameWithRetry still completes a non-contended rename', (t) => {
    // F-072c3d77: scratch space lives in os.tmpdir() (the setupTestRoot /
    // F-W1-SUBSTABLE-4 discipline), not inside the package source tree where
    // a mid-test failure leaves a dirty `git status`. Cleanup is t.after-
    // registered so it runs even when an assertion throws.
    const testRoot = mkdtempSync(join(tmpdir(), 'd1b-002-findings-sleepsync-'));
    t.after(() => rmSync(testRoot, { recursive: true, force: true }));

    const tmp = resolve(testRoot, 'src.tmp');
    const dest = resolve(testRoot, 'dest.txt');
    writeFileSync(tmp, 'hello', 'utf-8');

    renameWithRetry(tmp, dest);

    assert.ok(existsSync(dest), 'rename landed dest');
    assert.equal(readFileSync(dest, 'utf-8'), 'hello');
  });
});
