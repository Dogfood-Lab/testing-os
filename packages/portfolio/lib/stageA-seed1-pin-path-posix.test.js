/**
 * stageA-seed1-pin-path-posix — SEED-1 family member in the portfolio package
 * (d3-ingest-005, latent / non-default trigger).
 *
 * Invariant under test: the paths stored in parseRegressionPins()'s
 * source_pins/test_pins Maps — and therefore the keys/values toJSON() copies
 * verbatim into its JSON-serializable output — are forward-slash only.
 *
 * Why it matters: scripts/check-finding-regression-pins.mjs writes toJSON()'s
 * output to a COMMITTED index file when invoked with
 * `--write-index docs/regression-pin-index.json`. On Windows, walkSourceFiles
 * built each path via `join(dir, entry.name)` (OS-native), so a `--write-index`
 * regeneration on Windows would commit `packages\\ingest\\persist.js`-style
 * backslash paths — the same posix-leak class as the rest of SEED-1. A later
 * `swarm verify-fixed` delta-join (or any tooling) string-matching those
 * against forward-slash paths from a Linux run would silently mismatch.
 *
 * Pre-fix this goes RED on Windows: toJSON() output carries backslash paths.
 * The fix posixifies fullPath in walkSourceFiles before push, reusing the
 * exact transform classifyFile() already applies one function above
 * (parse-regression-pins.js:75). NEVER a win32-skip.
 *
 * Note on a SEPARATE (out-of-scope) concern the verifier flagged: the stored
 * paths are also ABSOLUTE (e.g. `E:/AI/testing-os/...`). Committing
 * machine-absolute paths is non-reproducible regardless of OS — but that is a
 * different defect from the separator leak this finding names, and changing
 * the path base would alter the parser's documented "absolute file paths"
 * contract. This test pins the separator invariant only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseRegressionPins,
  walkSourceFiles,
  toJSON,
} from './parse-regression-pins.js';

function makeFixture(layout) {
  const root = mkdtempSync(join(tmpdir(), 'seed1-pins-'));
  for (const [relPath, content] of Object.entries(layout)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('SEED-1 portfolio pin paths are forward-slash only (d3-ingest-005)', () => {
  it('walkSourceFiles returns forward-slash paths for nested files', () => {
    // Nested directories force a separator into the path — on win32 join()
    // yields backslashes pre-fix.
    const root = makeFixture({
      'packages/ingest/lib/deep.js': '// F-100000-001',
      'packages/portfolio/generate.test.js': '// F-100000-002',
    });
    try {
      const files = walkSourceFiles(root);
      assert.ok(files.length >= 2, 'expected the nested files to be walked');
      for (const f of files) {
        assert.ok(!f.includes('\\'),
          `walkSourceFiles must return forward-slash paths, got: ${f}`);
      }
      // Positive shape: the nested path is the expected posix sub-path.
      assert.ok(
        files.some(f => f.endsWith('packages/ingest/lib/deep.js')),
        `expected a posix nested path, got: ${JSON.stringify(files)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('toJSON keys and values contain no backslash', () => {
    const root = makeFixture({
      'packages/ingest/lib/unsafe-segment.js': '// F-721047-001 — source pin',
      'packages/ingest/lib/unsafe-segment.test.js':
        "describe('guard (F-721047-001)', () => {});",
      'packages/report/nested/dir/build.js': '// F-246817-006 — another source pin',
    });
    try {
      const json = toJSON(parseRegressionPins(root));

      // Non-vacuous: there must actually be pins to inspect.
      const sourceKeys = Object.keys(json.source_pins);
      const testKeys = Object.keys(json.test_pins);
      assert.ok(sourceKeys.length >= 1, 'expected at least one source pin');
      assert.ok(testKeys.length >= 1, 'expected at least one test pin');

      // The map KEYS are F-ids (never paths) — but the VALUES are arrays of
      // file paths. Every stored path must be forward-slash only.
      const allPaths = [
        ...Object.values(json.source_pins).flat(),
        ...Object.values(json.test_pins).flat(),
      ];
      assert.ok(allPaths.length >= 2, 'expected stored file paths to inspect');
      for (const p of allPaths) {
        assert.ok(!p.includes('\\'),
          `stored pin path must be forward-slash only, got: ${p}`);
      }

      // Belt-and-suspenders: the whole serialized blob is backslash-free.
      assert.ok(
        !JSON.stringify(json).includes('\\'),
        `toJSON serialized output must be forward-slash only, got: ${JSON.stringify(json)}`,
      );

      // Positive shape: a nested source path is the expected posix sub-path.
      assert.ok(
        allPaths.some(p => p.endsWith('packages/report/nested/dir/build.js')),
        `expected a posix nested stored path, got: ${JSON.stringify(allPaths)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
