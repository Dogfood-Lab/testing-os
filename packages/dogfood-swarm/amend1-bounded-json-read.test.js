/**
 * amend1-bounded-json-read.test.js
 *
 * Wave A1 D3 — H5 invariant test.
 *
 * The helper `lib/bounded-json-read.js` MUST:
 *   1. Reject files exceeding `maxBytes` with a structured BoundedJsonError
 *      (kind: SIZE_LIMIT). No hang. No OOM.
 *   2. Successfully parse legitimate files under the limit.
 *   3. Surface a structured error (kind: PARSE_FAILED) when the file
 *      contents are not JSON.
 *   4. Surface kind: READ_FAILED for a missing file.
 *
 * Also pins the family invariant: `commands/collect.js`,
 * `commands/revalidate.js`, `persist-results.js`, `lib/findings-digest.js`,
 * and `lib/verify/adapters/node.js` are all migrated to the helper. The
 * mechanical guard at `amend1-bounded-json-discipline.test.js` enforces
 * this at source-scan level; this file pins the runtime invariants.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readBoundedJson,
  BoundedJsonError,
  MAX_AGENT_OUTPUT_BYTES,
  BOUNDED_JSON_CALL_SITES,
} from './lib/bounded-json-read.js';

let tmp;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bounded-json-'));
});

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

describe('readBoundedJson — H5', () => {
  it('parses a small valid JSON file', () => {
    const p = join(tmp, 'ok.json');
    writeFileSync(p, JSON.stringify({ a: 1, b: [2, 3] }), 'utf-8');
    const parsed = readBoundedJson(p);
    assert.deepEqual(parsed, { a: 1, b: [2, 3] });
  });

  it('rejects a file exceeding the byte limit with kind SIZE_LIMIT', () => {
    const p = join(tmp, 'too-big.json');
    // Write 200 KB of dummy content; use a 100 KB maxBytes to trip the gate.
    const big = 'x'.repeat(200 * 1024);
    writeFileSync(p, JSON.stringify({ big }), 'utf-8');

    let err = null;
    try {
      readBoundedJson(p, { maxBytes: 100 * 1024 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must throw');
    assert.ok(err instanceof BoundedJsonError, 'must be BoundedJsonError');
    assert.equal(err.kind, 'SIZE_LIMIT');
    assert.equal(err.path, p);
    assert.ok(typeof err.size === 'number');
    assert.ok(err.size > 100 * 1024);
    assert.equal(err.maxBytes, 100 * 1024);
    // The error message must mention the file path and limit so an operator
    // can act on it without grepping for the structured fields.
    assert.match(err.message, /size limit/i);
    assert.match(err.message, /MB/);
  });

  it('does NOT hang or OOM on a >limit file (the bug shape) — structural proof, not a timing proof', () => {
    // The bug shape this fix prevents: JSON.parse on a multi-GB file would
    // block the event loop. This test used to prove the fast stat-gate path
    // was taken by timing the rejection (`ms < 1000`) — real, but a
    // wall-clock assertion is a flake surface on a loaded/throttled CI
    // runner (F-c2e91eea): a queued stat() syscall could push elapsed time
    // past the budget without the fix actually regressing, producing a
    // false failure indistinguishable from a real one.
    //
    // The exact property under test — "the slow parse-then-fail path never
    // ran" — is provable directly and exactly instead of approximately:
    // lib/bounded-json-read.js's readBoundedJson() calls readBoundedBuffer()
    // FIRST, which throws BoundedJsonError(SIZE_LIMIT) before `JSON.parse`
    // is ever reached (the size gate is a statSync fast-path reject — see
    // that file's readBoundedBuffer). Spying on JSON.parse and asserting it
    // was never invoked proves the fast path was taken with certainty, not
    // a >1000ms margin of confidence — no wall clock involved, so nothing
    // here can flake under CI load.
    const p = join(tmp, 'avoids-hang.json');
    writeFileSync(p, 'x'.repeat(10 * 1024 * 1024), 'utf-8');

    const originalParse = JSON.parse;
    let parseCalls = 0;
    JSON.parse = (...args) => {
      parseCalls += 1;
      return originalParse(...args);
    };

    let err = null;
    try {
      readBoundedJson(p, { maxBytes: 1024 * 1024 });
    } catch (e) {
      err = e;
    } finally {
      JSON.parse = originalParse;
    }

    assert.ok(err);
    assert.equal(err.kind, 'SIZE_LIMIT');
    assert.equal(parseCalls, 0,
      'JSON.parse must never be invoked when the stat-gate rejects — a nonzero count here means '
        + 'the fast path was bypassed and the slow parse-then-fail path ran instead (the exact bug '
        + 'shape this file exists to prevent)');
  });

  it('surfaces kind PARSE_FAILED on malformed JSON under the size limit', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{ this is not, valid: JSON', 'utf-8');

    let err = null;
    try {
      readBoundedJson(p);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.ok(err instanceof BoundedJsonError);
    assert.equal(err.kind, 'PARSE_FAILED');
    assert.equal(err.path, p);
    assert.ok(err.cause instanceof SyntaxError);
  });

  it('surfaces kind READ_FAILED on missing file', () => {
    const p = join(tmp, 'does-not-exist.json');
    let err = null;
    try {
      readBoundedJson(p);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.kind, 'READ_FAILED');
    assert.equal(err.path, p);
  });

  it('uses MAX_AGENT_OUTPUT_BYTES (50 MB) as the default maxBytes', () => {
    // Sanity that the export hasn't drifted from the collect.js constant.
    assert.equal(MAX_AGENT_OUTPUT_BYTES, 50 * 1024 * 1024);
  });

  it('registry lists every migrated call site', () => {
    const files = BOUNDED_JSON_CALL_SITES.map(c => c.file).sort();
    assert.deepEqual(files, [
      'commands/collect.js',
      'commands/revalidate.js',
      'lib/findings-digest.js',
      'lib/verify/adapters/node.js',
      'persist-results.js',
    ]);
  });
});
