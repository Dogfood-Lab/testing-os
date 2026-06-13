/**
 * stageC-b002-discover-leaf-guard.test.js — B002 leaf-IO guard for
 * discoverFindings (reader.js).
 *
 * AT HEAD: discoverFindings walks findings/<org>/<repo>/*.yaml. The two OUTER
 * levels go through `listDirs`, whose statSync is wrapped in try/catch so one
 * unreadable directory is skipped. The INNERMOST leaf read was a bare
 * `for (const file of readdirSync(repoDir))` — if a single repo directory is
 * unreadable (EACCES on a locked dir, ENOTDIR, a transient FS error) the whole
 * discovery throws an unstructured Node stack out of discoverFindings, hence
 * out of loadFindings, hence out of EVERY consumer (validate / list /
 * derivePatterns / advise / review queue). One bad directory sinks discovery
 * for every other repo.
 *
 * AFTER FIX: the leaf read goes through `listLeafFiles`, which mirrors the
 * package standard (load-records.js walkRecordsWithSkips, lib/safe-yaml-load.js
 * walkDir): a readdir error SKIPS that directory (returns []) and emits a
 * structured stderr line naming the offending path + the recovery action,
 * rather than throwing a raw stack. A healthy directory still lists its
 * entries; a healthy tree is still fully discovered.
 *
 * Why the guard is exercised at the `listLeafFiles` seam: `listDirs` (outer
 * walk) and the leaf read couple statSync + readdirSync, so the
 * listDirs-accepts-but-leaf-throws state cannot be staged through the full
 * walk on every platform (chmod is a no-op on Windows; junction/symlink
 * failures break statSync too, so listDirs would skip them first). The leaf
 * seam is fed a REAL, portable error: readdir on a non-directory throws
 * ENOTDIR on every platform.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { discoverFindings, listLeafFiles } from './reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_stageC_b002_leaf_guard__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* drop */ }
  }
}

function writeFinding(rootDir, org, repo, fileName) {
  const dir = resolve(rootDir, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fileName), 'schema_version: "1.0.0"\nfinding_id: x\n', 'utf-8');
}

describe('Stage C / B002: discoverFindings leaf-IO guard', () => {
  before(setup);
  after(teardown);

  // Capture stderr so we can assert the structured operator line fires AND
  // keep the test output clean.
  let stderrLines;
  let origStderrWrite;
  beforeEach(() => {
    stderrLines = [];
    origStderrWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return true;
    };
  });
  afterEach(() => {
    process.stderr.write = origStderrWrite;
  });

  it('GUARD FIRES: readdir on an unreadable (non-directory) leaf path is skipped, not thrown, and names the path on stderr', () => {
    // A real, portable readdir failure: readdir on a FILE throws ENOTDIR on
    // every platform. This is exactly the error class the bare leaf read would
    // have propagated as an unstructured stack.
    const filePath = resolve(TEST_ROOT, 'a-file-not-a-dir.yaml');
    writeFileSync(filePath, 'not a directory', 'utf-8');

    let result;
    assert.doesNotThrow(() => {
      result = listLeafFiles(filePath);
    }, 'guard must not throw a raw stack on an unreadable leaf');

    assert.deepEqual(result, [], 'unreadable leaf is skipped (returns [])');

    const joined = stderrLines.join('');
    assert.match(joined, /skipping unreadable findings directory/i, 'structured operator message present');
    assert.ok(joined.includes(filePath), 'message names the offending path so the operator can fix it');
    assert.match(joined, /re-run|other repos were still discovered/i, 'message states the recovery / continuation');
  });

  it('HEALTHY INPUT STILL PASSES: a readable leaf directory lists its entries', () => {
    const goodDir = resolve(TEST_ROOT, 'good-leaf');
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(resolve(goodDir, 'one.yaml'), 'a: 1', 'utf-8');
    writeFileSync(resolve(goodDir, 'two.yaml'), 'b: 2', 'utf-8');

    const entries = listLeafFiles(goodDir).sort();
    assert.deepEqual(entries, ['one.yaml', 'two.yaml'], 'healthy leaf lists its entries');
    assert.equal(stderrLines.join(''), '', 'no skip line for a healthy directory');
  });

  it('END-TO-END: a healthy findings tree is still fully discovered', () => {
    const root = resolve(TEST_ROOT, 'healthy-tree');
    writeFinding(root, 'org-a', 'repo-1', 'a.yaml');
    writeFinding(root, 'org-a', 'repo-2', 'b.yaml');
    writeFinding(root, 'org-b', 'repo-3', 'c.yaml');

    const paths = discoverFindings(root);
    assert.equal(paths.length, 3, 'all three findings discovered across the healthy tree');
    assert.ok(paths.every(p => p.endsWith('.yaml')), 'only yaml files returned');
    assert.equal(stderrLines.join(''), '', 'no skip line emitted for a fully-healthy tree');
  });
});
