/**
 * wave28-unsafe-segment-discipline.test.js — sweep + behavior regression.
 *
 *   F-916867-005 (W2-PIPE-EXTRA) — Class #9 sibling-pattern propagation gap.
 *     Three callsites used the path-segment safety regex; only one (persist.js)
 *     defined it inline, the other two duplicated the literal regex
 *     (load-context.js, findings/derive/load-records.js — the latter was
 *     missing the guard entirely). Productized form: the regex now lives in
 *     packages/ingest/lib/unsafe-segment.js as the sole definition, and every
 *     callsite imports it. This test pins:
 *       1. No file outside the helper (re-)defines `unsafeSegment`.
 *       2. The helper exports both UNSAFE_SEGMENT and isUnsafeSegment.
 *       3. Behavior: rejects `..` and path separators; accepts single dots.
 *
 *   Sweep automation = the regression test; mirrors wave22-log-stage-discipline
 *   for the logStage helper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UNSAFE_SEGMENT, isUnsafeSegment } from './lib/unsafe-segment.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(__dirname, '..');
const SHARED_HELPER = resolve(PACKAGES_DIR, 'ingest', 'lib', 'unsafe-segment.js');

function listJsFiles(root) {
  const out = [];
  const skip = new Set([
    'node_modules', 'dist', 'build', 'coverage',
    '.git', '.cache',
  ]);
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      // Any __test_* dir is a sibling test's transient scratch tree; a hard-
      // coded name list raced __test_root_d1b001__ mid-cleanup under the
      // parallel runner (ENOENT at readFileSync — HANDOFF 2026-07-03).
      if (skip.has(name) || name.startsWith('__test_')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && (name.endsWith('.js') || name.endsWith('.mjs'))) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// F-916867-005 — sweep invariant: only the shared helper defines
// `unsafeSegment` (or its productized UNSAFE_SEGMENT / isUnsafeSegment).
// ─────────────────────────────────────────────────────────────────

describe('F-916867-005 — only the shared helper defines unsafeSegment', () => {
  it('no file under packages/** redefines the unsafeSegment regex inline', () => {
    // Match an inline (re-)definition of the regex by a `const|let|var` named
    // `unsafeSegment`, OR a literal `/\.\.|[/\\]/` body anywhere outside the
    // helper. Both shapes were present pre-extraction.
    const NAMED_DEFINITION = /(?:^|\s)(?:function|const|let|var)\s+unsafeSegment\b/m;
    const LITERAL_BODY = /\/\\\.\\\.\|\[\/\\\\\]\//; // /\.\.|[/\\]/ in source

    const offenders = [];
    for (const file of listJsFiles(PACKAGES_DIR)) {
      if (file === SHARED_HELPER) continue;
      // Skip our own discipline test (it must mention the regex literal in
      // the description above to explain the helper's contract).
      if (file === fileURLToPath(import.meta.url)) continue;

      // Tolerate a file deleted between enumeration and read — sibling tests
      // write-then-remove transient modules under the package tree; a vanished
      // file cannot be an offender.
      let src;
      try {
        src = readFileSync(file, 'utf-8');
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
      if (NAMED_DEFINITION.test(src) || LITERAL_BODY.test(src)) {
        offenders.push(file.replace(PACKAGES_DIR + sep, ''));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Found inline unsafeSegment (re-)definitions outside the shared helper:\n  ${offenders.join('\n  ')}\n` +
      'Use `import { isUnsafeSegment } from "./lib/unsafe-segment.js"` (in-package) or ' +
      '`import { isUnsafeSegment } from "@dogfood-lab/ingest/lib/unsafe-segment.js"` (cross-package).',
    );
  });

  it('the shared helper exports UNSAFE_SEGMENT and isUnsafeSegment', () => {
    const src = readFileSync(SHARED_HELPER, 'utf-8');
    assert.match(src, /export\s+const\s+UNSAFE_SEGMENT\b/,
      'shared helper must export `UNSAFE_SEGMENT`');
    assert.match(src, /export\s+function\s+isUnsafeSegment\b/,
      'shared helper must export `isUnsafeSegment`');
  });

  it('all three known callsites import from the shared helper', () => {
    const callsites = [
      resolve(PACKAGES_DIR, 'ingest', 'persist.js'),
      resolve(PACKAGES_DIR, 'ingest', 'load-context.js'),
      resolve(PACKAGES_DIR, 'findings', 'derive', 'load-records.js'),
    ];
    for (const file of callsites) {
      const src = readFileSync(file, 'utf-8');
      assert.match(
        src,
        /from\s+['"](?:@dogfood-lab\/ingest\/lib\/unsafe-segment\.js|\.\/lib\/unsafe-segment\.js)['"]/,
        `${file} must import from the shared unsafe-segment helper`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Behavior — positive + negative cases for the regex.
// ─────────────────────────────────────────────────────────────────

describe('F-916867-005 — isUnsafeSegment behavior', () => {
  it('rejects `..` traversal substrings', () => {
    assert.equal(isUnsafeSegment('..'), true);
    assert.equal(isUnsafeSegment('foo..bar'), true);
    assert.equal(isUnsafeSegment('..test'), true);
    assert.equal(isUnsafeSegment('test..'), true);
  });

  it('rejects forward and back slashes', () => {
    assert.equal(isUnsafeSegment('foo/bar'), true);
    assert.equal(isUnsafeSegment('foo\\bar'), true);
    assert.equal(isUnsafeSegment('/leading'), true);
    assert.equal(isUnsafeSegment('trailing/'), true);
  });

  it('accepts single dots in legitimate org/repo names', () => {
    // GitHub permits these; the submission schema's repo pattern matches.
    assert.equal(isUnsafeSegment('next.js'), false);
    assert.equal(isUnsafeSegment('mcp-tool-shop.github.io'), false);
    assert.equal(isUnsafeSegment('repo.io'), false);
    assert.equal(isUnsafeSegment('example.com'), false);
  });

  it('accepts ordinary alphanumeric segments', () => {
    assert.equal(isUnsafeSegment('mcp-tool-shop'), false);
    assert.equal(isUnsafeSegment('dogfood_labs'), false);
    assert.equal(isUnsafeSegment('repo123'), false);
    assert.equal(isUnsafeSegment(''), false);
  });

  it('UNSAFE_SEGMENT regex matches the same shapes as isUnsafeSegment', () => {
    const samples = ['..', 'foo/bar', 'foo\\bar', 'foo..bar'];
    for (const s of samples) {
      assert.equal(UNSAFE_SEGMENT.test(s), isUnsafeSegment(s),
        `divergence on ${JSON.stringify(s)}`);
    }
  });
});
