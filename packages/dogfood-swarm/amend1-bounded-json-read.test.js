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

  it('does NOT hang or OOM on a >limit file (the bug shape)', () => {
    // The bug shape this fix prevents: JSON.parse on a multi-GB file would
    // block the event loop. The size gate catches it before parse begins.
    // We use a relatively large limit-buster (10 MB file with a 1 MB cap)
    // to keep the test fast but still exercise the bypass-parse path.
    const p = join(tmp, 'avoids-hang.json');
    writeFileSync(p, 'x'.repeat(10 * 1024 * 1024), 'utf-8');

    const start = Date.now();
    let err = null;
    try {
      readBoundedJson(p, { maxBytes: 1024 * 1024 });
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - start;
    assert.ok(err);
    assert.equal(err.kind, 'SIZE_LIMIT');
    // Sanity: rejecting on stat must take <1s even on a slow CI box. The
    // bug-shape rejection (via JSON.parse blocking) would take much longer
    // or hit the test timeout.
    assert.ok(ms < 1000,
      `bounded-json must reject via stat-gate fast (took ${ms}ms — did JSON.parse block?)`);
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
