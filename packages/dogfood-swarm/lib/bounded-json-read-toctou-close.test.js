/**
 * bounded-json-read-toctou-close.test.js — F-a89f89f7 (Wave 18):
 *
 * The fp-004 comment in lib/bounded-json-read.js (directly above the old
 * `buf = readFileSync(filePath);` line) claimed the statSync-to-readFileSync
 * TOCTOU window was CLOSED: "Close the window by enforcing the limit on the
 * bytes ACTUALLY read... The size we check is now the size we read." That
 * was false. Node's `fs.readFileSync(path)` takes no length argument — it
 * always reads to EOF in one synchronous call, allocating a buffer sized to
 * the file's ACTUAL size at read time. Checking `buf.length > maxBytes`
 * AFTER that unbounded read completes only changes what gets DETECTED, not
 * what gets READ — a file that passes the statSync gate and then grows past
 * maxBytes before the read runs (a producer actively writing — the
 * "logging loop" scenario this module's own header names as its reason to
 * exist) still forces the full unbounded read + allocation this module is
 * supposed to prevent.
 *
 * THE FIX. The read itself is now bounded: readBoundedFromFd reads in fixed
 * READ_CHUNK_BYTES chunks via fs.readSync on a raw fd and stops the LOOP —
 * not just a post-hoc length check — as soon as cumulative bytes read
 * crosses maxBytes. Worst-case over-read is one chunk past the cap, not the
 * file's full (possibly multi-GB) size.
 *
 * Two sibling call sites — lib/verify/adapters/python.js and rust.js's
 * `readBoundedManifest` — independently reproduced a WORSE version of the
 * identical gap (statSync-then-readFileSync with no post-read recheck at
 * all) instead of routing through this module. This wave fixes the CLASS:
 * both now call the shared readBoundedText export instead of maintaining a
 * private copy (see the discipline test below).
 *
 * A genuine TOCTOU race (file grows between this module's OWN internal
 * statSync and its OWN internal read) can't be won deterministically from a
 * black-box test without mocking node:fs (which does not work for ESM
 * named imports of core modules on this Node version — `mock.method` throws
 * "Cannot redefine property" — and which this repo's CLAUDE.md rule 6
 * discourages regardless: "Tests run against real fixtures, not mocks").
 * Instead, the race is reproduced DETERMINISTICALLY by controlling the
 * interleaving explicitly: open the fd while the file is small (mirroring
 * the moment right after this module's internal statSync saw a small size),
 * grow the file on disk via a separate write, THEN read from the
 * already-open fd — the same real filesystem behavior a true race would
 * exhibit, without depending on OS scheduling luck.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns `packages/dogfood-swarm/lib/**` only — the
 * existing sibling suites (amend1-bounded-json-read.test.js,
 * amend1-bounded-json-discipline.test.js, stageC-adapter-manifest-
 * unreadable-signal.test.js) live at package root and were left untouched;
 * this file adds new coverage rather than editing them.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, closeSync, readFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readBoundedJson,
  readBoundedText,
  readBoundedBuffer,
  readBoundedFromFd,
  BoundedJsonError,
} from './bounded-json-read.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let TEST_ROOT;
beforeEach(() => { TEST_ROOT = mkdtempSync(join(tmpdir(), 'bounded-toctou-')); });
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

describe('readBoundedFromFd — the READ is bounded, not just the post-hoc check (F-a89f89f7)', () => {
  it('stops within one chunk of the cap when the file grows past it after the fd was opened', () => {
    const p = join(TEST_ROOT, 'growing.json');
    writeFileSync(p, 'x'.repeat(100)); // well under any cap at open time

    // Open the fd while the file is still small — mirrors readBoundedBuffer's
    // own openSync happening right after a statSync that saw 100 bytes.
    const fd = openSync(p, 'r');
    try {
      // Grow the file WAY past the cap via a separate handle, deterministically
      // — the exact "producer actively writing" scenario fp-004 names,
      // reproduced without depending on real-world OS scheduling to win a race.
      appendFileSync(p, 'y'.repeat(20 * 1024 * 1024)); // +20 MB, all after fd opened

      const maxBytes = 1024; // 1 KB cap
      const start = Date.now();
      const buf = readBoundedFromFd(fd, maxBytes);
      const ms = Date.now() - start;

      // The bug shape: an unbounded readFileSync-style read would return the
      // file's full CURRENT size here (~20 MB) and allocate accordingly. The
      // fix: the loop bails within one READ_CHUNK_BYTES of the cap.
      assert.ok(buf.length > maxBytes, 'still over cap — caller must reject it');
      assert.ok(buf.length < 2 * 1024 * 1024,
        `read must stop within one chunk of the cap, not consume the full grown file (got ${buf.length} bytes)`);
      assert.ok(ms < 500, `bounded read must not block on the full grown file (took ${ms}ms)`);
    } finally {
      closeSync(fd);
    }
  });

  it('reads to EOF normally (byte-identical) when the file never exceeds maxBytes', () => {
    const p = join(TEST_ROOT, 'small.json');
    const content = JSON.stringify({ a: 1, nested: { b: [1, 2, 3] } });
    writeFileSync(p, content, 'utf-8');

    const fd = openSync(p, 'r');
    try {
      const buf = readBoundedFromFd(fd, 1024 * 1024);
      assert.equal(buf.toString('utf-8'), content);
    } finally {
      closeSync(fd);
    }
  });

  it('handles an empty file (zero reads, zero-length buffer)', () => {
    const p = join(TEST_ROOT, 'empty.json');
    writeFileSync(p, '');
    const fd = openSync(p, 'r');
    try {
      const buf = readBoundedFromFd(fd, 1024);
      assert.equal(buf.length, 0);
    } finally {
      closeSync(fd);
    }
  });
});

describe('readBoundedBuffer / readBoundedText — new shared primitives (F-a89f89f7 class fix)', () => {
  it('readBoundedText returns raw text, no JSON.parse attempted', () => {
    const p = join(TEST_ROOT, 'manifest.toml');
    writeFileSync(p, '[tool.ruff]\nline-length = 100\n');
    const text = readBoundedText(p);
    assert.equal(text, '[tool.ruff]\nline-length = 100\n');
  });

  it('readBoundedText rejects an oversized file the same way readBoundedJson does (kind SIZE_LIMIT)', () => {
    const p = join(TEST_ROOT, 'big.toml');
    writeFileSync(p, 'x'.repeat(2000));
    let err = null;
    try {
      readBoundedText(p, { maxBytes: 100 });
    } catch (e) { err = e; }
    assert.ok(err instanceof BoundedJsonError);
    assert.equal(err.kind, 'SIZE_LIMIT');
  });

  it('readBoundedBuffer is the shared core both readBoundedJson and readBoundedText call — a small file round-trips through all three consistently', () => {
    const p = join(TEST_ROOT, 'shared.json');
    writeFileSync(p, JSON.stringify({ ok: true }));

    const buf = readBoundedBuffer(p);
    const text = readBoundedText(p);
    const parsed = readBoundedJson(p);

    assert.equal(buf.toString('utf-8'), text);
    assert.deepEqual(JSON.parse(text), parsed);
  });

  it('BoundedJsonError surfaces the underlying fs error code on `.code` (not just `.name`) — an EISDIR read failure names itself', () => {
    // A directory at the manifest path makes statSync succeed but the
    // subsequent read throw EISDIR — the same present-but-unreadable shape
    // stageC-adapter-manifest-unreadable-signal.test.js (package root, out
    // of domain) already exercises through the adapters. This pins the
    // underlying `.code` passthrough on BoundedJsonError itself, which is
    // what lets python.js/rust.js keep reporting a real fs error code
    // (EISDIR/ENOENT/...) instead of regressing to the generic wrapper name
    // now that they route through this shared module.
    const dirPath = join(TEST_ROOT, 'a-directory.json');
    mkdirSync(dirPath);

    let err = null;
    try {
      readBoundedBuffer(dirPath);
    } catch (e) { err = e; }
    assert.ok(err instanceof BoundedJsonError);
    assert.equal(err.kind, 'READ_FAILED');
    assert.ok(err.code, 'the wrapper must surface a real fs error code, not just .name');
    assert.notEqual(err.code, 'BoundedJsonError');
  });
});

describe('python.js / rust.js route their manifest read through the shared primitive — class fix, not instance patch (F-a89f89f7)', () => {
  it('neither adapter keeps its own private statSync+readFileSync bounded-read copy', () => {
    const pythonSrc = readFileSync(join(__dirname, 'verify/adapters/python.js'), 'utf-8');
    const rustSrc = readFileSync(join(__dirname, 'verify/adapters/rust.js'), 'utf-8');

    for (const [name, src] of [['python.js', pythonSrc], ['rust.js', rustSrc]]) {
      assert.match(src, /readBoundedText/,
        `${name} must route its manifest read through the shared readBoundedText helper`);
      assert.doesNotMatch(src, /readFileSync\s*\(\s*filePath\s*,\s*['"]utf-8['"]\s*\)/,
        `${name} must not keep its own private readFileSync(filePath, 'utf-8') bounded-read copy — ` +
        'that was the duplicated, worse-than-the-original gap this finding calls out (no post-read recheck at all)');
    }
  });
});
