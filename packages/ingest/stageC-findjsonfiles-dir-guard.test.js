/**
 * stageC-findjsonfiles-dir-guard.test.js
 *
 * Stage C (humanization) — d3-ingest-B005.
 *
 * findJsonFiles called readdirSync(dir, {withFileTypes:true}) with no
 * per-directory try/catch. If a subdirectory under records/ became unreadable
 * (EACCES, ENOTDIR, a Windows lock), the ENTIRE rebuildIndexes scan threw — an
 * asymmetry with the per-FILE tolerance of loadRecord just below it (whose
 * module header promises 'does NOT crash on a single bad file'). The safer
 * pattern already exists in-repo: walkSourceFiles in
 * packages/portfolio/lib/parse-regression-pins.js wraps its readdirSync in
 * try/catch.
 *
 * Fix: mirror that guard — wrap the readdirSync in a try/catch that
 *   logStage('warn', { kind: 'dir_unreadable', path }) and skips the unreadable
 * subtree, so one locked records subtree degrades to 'that subtree's records
 * are missing from this rebuild' rather than aborting the whole scan.
 *
 * The guard wraps the single readdirSync inside findJsonFiles, which serves
 * BOTH the top-level call and every recursive descent — so a unit test that
 * feeds findJsonFiles a path readdirSync rejects (a FILE → ENOTDIR, a genuine
 * IO error, cross-platform) proves the guard fires for any unreadable
 * directory target. A healthy tree must still be fully enumerated and emit no
 * dir_unreadable warn.
 *
 * Lens: the degradation emits a structured, greppable
 * `"kind":"dir_unreadable"` NDJSON warn naming the path — not a silent swallow,
 * not a whole-scan crash.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findJsonFiles } from './rebuild-indexes.js';

/**
 * Capture stderr (where logStage NDJSON is written) while running fn.
 * Mirrors the helper in d1b-005-006-rebuild-and-policy-warns.test.js.
 */
function captureStderr(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(chunk.toString());
    return true;
  };
  try {
    return { result: fn(), captured };
  } finally {
    process.stderr.write = orig;
  }
}

function parseStageEvents(captured) {
  const events = [];
  for (const chunk of captured) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.stage) events.push(parsed);
      } catch { /* skip non-JSON */ }
    }
  }
  return events;
}

describe('findJsonFiles unreadable-directory guard (d3-ingest-B005)', () => {
  it('POSITIVE: an unreadable directory target is skipped with a dir_unreadable warn, not a throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b005-'));
    try {
      // A FILE path handed to readdirSync throws ENOTDIR — the same IO-error
      // class (EACCES / lock / ENOTDIR) the guard must tolerate. Pre-fix this
      // propagated out of findJsonFiles and aborted the whole scan.
      const filePath = join(root, 'not-a-dir.json');
      writeFileSync(filePath, '{}', 'utf-8');

      let result;
      const { result: r, captured } = captureStderr(() => {
        // Must NOT throw — the guard turns the IO error into a skip.
        result = findJsonFiles(filePath);
        return result;
      });

      assert.ok(Array.isArray(r),
        'findJsonFiles must return an array even when the target is unreadable (no throw)');
      assert.equal(r.length, 0,
        'an unreadable directory target contributes no files');

      // The skip must be greppable: a structured dir_unreadable warn naming the path.
      const events = parseStageEvents(captured);
      const warn = events.find(e =>
        e.stage === 'warn' && e.kind === 'dir_unreadable'
      );
      assert.ok(warn,
        `expected a stage:warn event with kind=dir_unreadable; ` +
        `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind })))}`);
      assert.ok(typeof warn.path === 'string' && warn.path.length > 0,
        'dir_unreadable warn must carry the offending directory path');
      assert.ok(warn.path.includes('not-a-dir.json'),
        `dir_unreadable warn path must name the offending target; got ${warn.path}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a healthy nested tree is fully enumerated and emits no dir_unreadable warn', () => {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b005-ok-'));
    try {
      const nested = join(root, 'org', 'repo', '2026', '03', '19');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'run-1.json'), '{}', 'utf-8');
      writeFileSync(join(nested, 'run-2.json'), '{}', 'utf-8');
      // A .tmp file must be ignored by the existing filter (regression guard).
      writeFileSync(join(nested, 'run-3.json.tmp'), '{}', 'utf-8');
      // A non-json file must be ignored too.
      writeFileSync(join(root, 'README.md'), 'x', 'utf-8');

      const { result, captured } = captureStderr(() => findJsonFiles(root));

      const names = result.map(p => p.replace(/\\/g, '/'));
      assert.equal(result.length, 2,
        `healthy tree must enumerate exactly the 2 .json files; got ${JSON.stringify(names)}`);
      assert.ok(names.some(p => p.endsWith('run-1.json')));
      assert.ok(names.some(p => p.endsWith('run-2.json')));

      const events = parseStageEvents(captured);
      const warn = events.find(e => e.stage === 'warn' && e.kind === 'dir_unreadable');
      assert.ok(!warn,
        `healthy tree must emit no dir_unreadable warn; ` +
        `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind })))}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a non-existent directory returns [] (existing behavior preserved)', () => {
    const { result, captured } = captureStderr(() =>
      findJsonFiles(join(tmpdir(), 'stageC-b005-nope-' + Date.now()))
    );
    assert.deepEqual(result, [],
      'a non-existent dir must return [] via the existsSync short-circuit, not a warn');
    const events = parseStageEvents(captured);
    const warn = events.find(e => e.stage === 'warn' && e.kind === 'dir_unreadable');
    assert.ok(!warn,
      'a non-existent (not unreadable) dir must NOT emit a dir_unreadable warn');
  });
});
