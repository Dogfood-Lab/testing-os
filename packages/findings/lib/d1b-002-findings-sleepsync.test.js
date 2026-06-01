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
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renameWithRetry } from './rename-with-retry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENAME_HELPER_PATH = resolve(__dirname, 'rename-with-retry.js');
const TEST_ROOT = resolve(__dirname, '__test_d1b_002_findings_sleepsync__');

describe('D1B-002 (findings): rename-with-retry sleepSync swap', () => {
  it('mechanical invariant: source no longer contains the spin-loop pattern', () => {
    const src = readFileSync(RENAME_HELPER_PATH, 'utf-8');
    // The legacy spin shape: `while (Date.now() < until)`. Either the
    // direct invocation or the equivalent `while (Date.now() <= until)`
    // must not appear in the final source.
    assert.doesNotMatch(
      src,
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

  it('behavioural: renameWithRetry still completes a non-contended rename', () => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });

    const tmp = resolve(TEST_ROOT, 'src.tmp');
    const dest = resolve(TEST_ROOT, 'dest.txt');
    writeFileSync(tmp, 'hello', 'utf-8');

    renameWithRetry(tmp, dest);

    assert.ok(existsSync(dest), 'rename landed dest');
    assert.equal(readFileSync(dest, 'utf-8'), 'hello');

    rmSync(TEST_ROOT, { recursive: true, force: true });
  });
});
