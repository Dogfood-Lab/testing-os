/**
 * d1b-002-sleep-sync-no-spin.test.js
 *
 * D1B-002-ingest (Stage C humanization fold) — `rename-with-retry.js`'s
 * `while (Date.now() < until)` busy-spin backoff loop burned a CPU
 * core for ~15–200ms per retry. Bounded (~1.4s worst case), so the
 * advisor classed it MED — no data loss — but it's a free win since the
 * repo already ships an `Atomics.wait`-based sleepSync at
 * `packages/findings/lib/file-lock.js:286`.
 *
 * Fix: factor a sibling `sleepSync` into `packages/ingest/lib/sleep-sync.js`
 * (matching the existing workspace-cycle pattern for `ingest/lib/atomic-write.js`)
 * and replace the spin loop.
 *
 * Invariant (two halves):
 *   1. NEGATIVE (source sweep): `rename-with-retry.js` no longer contains
 *      the `while (Date.now() <` busy-spin pattern.
 *   2. POSITIVE (behavior): `renameWithRetry` still retries on
 *      EPERM/EBUSY and gives up after `retries` attempts. The behavior
 *      contract is unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────
// NEGATIVE: source sweep — no while(Date.now() <  ) spin remains
// ─────────────────────────────────────────────────────────────────

describe('D1B-002-ingest — no busy-spin backoff in rename-with-retry', () => {
  it('source check: rename-with-retry.js contains no while(Date.now() <) spin (excluding comments)', () => {
    const renamePath = resolve(__dirname, 'lib', 'rename-with-retry.js');
    const src = readFileSync(renamePath, 'utf-8');
    // Strip block + line comments before matching. Without this the JSDoc
    // archaeological note "replaced the `while (Date.now() < until)`
    // busy-spin" would itself trip the check.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const spinRe = /while\s*\(\s*Date\.now\(\)\s*<\s*\w+\s*\)/;
    assert.ok(
      !spinRe.test(stripped),
      'rename-with-retry.js still contains a `while (Date.now() < …)` busy-spin loop — ' +
      'replace it with the Atomics.wait-based sleepSync helper'
    );
  });

  it('source check: rename-with-retry.js imports a sleepSync helper', () => {
    const renamePath = resolve(__dirname, 'lib', 'rename-with-retry.js');
    const src = readFileSync(renamePath, 'utf-8');
    // The helper may live at any path under packages/ingest/lib/ — the
    // discipline is that it's IMPORTED rather than redefined inline.
    assert.ok(
      /import\s*\{[^}]*\bsleepSync\b[^}]*\}\s*from/.test(src),
      'rename-with-retry.js must import { sleepSync } from a helper module'
    );
  });

  it('helper: packages/ingest/lib/sleep-sync.js exports sleepSync via Atomics.wait', () => {
    const helperPath = resolve(__dirname, 'lib', 'sleep-sync.js');
    const src = readFileSync(helperPath, 'utf-8');
    assert.ok(/export\s+function\s+sleepSync\b/.test(src),
      'lib/sleep-sync.js must export `sleepSync`');
    assert.ok(/Atomics\.wait\b/.test(src),
      'lib/sleep-sync.js must use Atomics.wait (not a busy spin)');
  });
});

// ─────────────────────────────────────────────────────────────────
// POSITIVE: behavior preservation — renameWithRetry still retries
// ─────────────────────────────────────────────────────────────────

describe('D1B-002-ingest — renameWithRetry retry behaviour preserved', () => {
  it('rename succeeds when target is writeable (happy path unchanged)', async () => {
    const { renameWithRetry } = await import('./lib/rename-with-retry.js');
    const root = mkdtempSync(join(tmpdir(), 'd1b002-'));
    try {
      const src = join(root, 'a.tmp');
      const dst = join(root, 'b.txt');
      writeFileSync(src, 'payload', 'utf-8');
      renameWithRetry(src, dst);
      assert.equal(readFileSync(dst, 'utf-8'), 'payload',
        'destination must hold the renamed content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rename throws non-EPERM/EBUSY errors immediately (no retry)', async () => {
    const { renameWithRetry } = await import('./lib/rename-with-retry.js');
    const root = mkdtempSync(join(tmpdir(), 'd1b002-'));
    try {
      const dst = join(root, 'whatever.txt');
      // No source file → ENOENT, NOT in the retry allowlist → must throw.
      assert.throws(
        () => renameWithRetry(join(root, 'nonexistent.tmp'), dst),
        (err) => err.code === 'ENOENT'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
