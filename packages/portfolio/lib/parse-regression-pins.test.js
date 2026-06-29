/**
 * Tests for {@link parseRegressionPins} — the data layer behind the
 * always-on CI gate that enforces "every fixed F-id has a regression test."
 *
 * F-id pin convention (canonical for testing-os):
 *
 *   ```js
 *   // F-NNNNNN-NNN — short reason this comment is here
 *   describe('thing under test (F-NNNNNN-NNN)', () => { ... });
 *   ```
 *
 * Either form counts as a pin; the parser is line-based and id-shape-based,
 * not AST-based, on purpose — pins must remain greppable by humans and by
 * `scripts/check-finding-regression-pins.mjs` alike.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseRegressionPins,
  classifyFile,
  extractPinsFromText,
  walkSourceFiles,
  toJSON,
  F_ID_PATTERN,
} from './parse-regression-pins.js';

function makeFixture(layout) {
  const root = mkdtempSync(join(tmpdir(), 'regression-pins-'));
  for (const [relPath, content] of Object.entries(layout)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('F_ID_PATTERN', () => {
  it('matches the canonical six-three F-id shape', () => {
    const text = 'see F-721047-004 and F-246817-005 in build-submission.js';
    // Reset lastIndex so the global flag does not leak between calls.
    F_ID_PATTERN.lastIndex = 0;
    const matches = text.match(F_ID_PATTERN);
    assert.deepEqual(matches, ['F-721047-004', 'F-246817-005']);
  });

  it('does not match shorter or longer digit groups', () => {
    F_ID_PATTERN.lastIndex = 0;
    const text = 'F-123 F-12345-67 F-1234567-001 F-XXX-yyy F-005';
    const matches = text.match(F_ID_PATTERN);
    assert.equal(matches, null,
      `none of those should match the strict pattern, got ${JSON.stringify(matches)}`);
  });
});

describe('classifyFile', () => {
  it('classifies *.test.js paths as test', () => {
    assert.equal(classifyFile('/repo/packages/report/report.test.js'), 'test');
    assert.equal(classifyFile('/repo/packages/portfolio/generate.test.js'), 'test');
    assert.equal(classifyFile('/repo/packages/schemas/test/validate.test.ts'), 'test');
  });

  it('classifies *.spec.ts paths as test', () => {
    assert.equal(classifyFile('/repo/lib/foo.spec.ts'), 'test');
  });

  it('classifies anything in a /test/ or /tests/ dir as test', () => {
    assert.equal(classifyFile('/repo/packages/schemas/test/helpers.ts'), 'test');
    assert.equal(classifyFile('/repo/tests/integration/runner.js'), 'test');
    assert.equal(classifyFile('/repo/__tests__/snapshot.js'), 'test');
  });

  it('classifies plain source files as source', () => {
    assert.equal(classifyFile('/repo/packages/report/build-submission.js'), 'source');
    assert.equal(classifyFile('/repo/packages/portfolio/generate.js'), 'source');
    assert.equal(classifyFile('/repo/packages/schemas/src/validate.ts'), 'source');
  });

  it('uses POSIX-normalised match logic so Windows backslashes still classify', () => {
    assert.equal(classifyFile('C:\\repo\\packages\\report\\report.test.js'), 'test');
    assert.equal(classifyFile('C:\\repo\\packages\\schemas\\test\\helpers.ts'), 'test');
  });
});

describe('extractPinsFromText', () => {
  it('finds a single pin in a JSDoc header', () => {
    const text = '// F-721047-001 — defensive guard\nfunction foo() {}';
    const pins = extractPinsFromText(text);
    assert.deepEqual([...pins], ['F-721047-001']);
  });

  it('finds multiple distinct pins in one file', () => {
    const text = `
      // F-721047-001 — guard
      // F-246817-006 — schema mirror
      describe('x (F-882513-002)', () => {});
    `;
    const pins = extractPinsFromText(text);
    const sorted = [...pins].sort();
    assert.deepEqual(sorted, ['F-246817-006', 'F-721047-001', 'F-882513-002']);
  });

  it('deduplicates the same pin referenced multiple times in a file', () => {
    const text = `
      // F-721047-001 — guard
      describe('rejects null submission with structured shape (F-721047-001)', () => {});
      it('rejects undefined submission with structured shape (F-721047-001)', () => {});
    `;
    const pins = extractPinsFromText(text);
    assert.deepEqual([...pins], ['F-721047-001']);
  });

  it('returns an empty Set for files with no pins', () => {
    const pins = extractPinsFromText('// nothing pinned here\nexport const x = 1;');
    assert.equal(pins.size, 0);
  });

  it('does not match malformed F-id shapes (F-XXX-yyy, F-12-345)', () => {
    // F-XXX-yyy fails the digit class; F-12-345 fails the digit-count quantifier;
    // F-005 fails the dash-segment rule. None of these should be returned.
    const text = `
      Pre-fix wave-1 raised F-XXX-yyy and F-005 and the prose ref F-12-345.
      The real id is F-246817-006, which is the only thing this should match.
    `;
    const pins = extractPinsFromText(text);
    assert.deepEqual([...pins], ['F-246817-006']);
  });

  it('treats an F-id mentioned only in prose as a pin (parser is intentionally permissive)', () => {
    // This documents an intentional limitation: the parser cannot distinguish
    // "this comment IS a pin" from "this comment MENTIONS the id." Disambiguation
    // is the consuming gate's job (compare source vs test maps). Prose references
    // in source files are rare in practice and false-positive on the side of "we
    // believe this fix is regression-tested," which is the safer failure mode.
    const text = '// see also F-002109-016 for why this guard exists\n';
    const pins = extractPinsFromText(text);
    assert.deepEqual([...pins], ['F-002109-016']);
  });
});

describe('walkSourceFiles', () => {
  it('returns an empty list for a non-existent directory', () => {
    assert.deepEqual(walkSourceFiles('/this/path/does/not/exist'), []);
  });

  it('finds .js, .ts, .mjs files and skips others', () => {
    const root = makeFixture({
      'a.js': '// F-100000-001',
      'b.ts': '// F-100000-002',
      'c.mjs': '// F-100000-003',
      'd.txt': 'no F-id here please',
      'e.json': '{"F-100000-004": true}',
    });
    try {
      const files = walkSourceFiles(root);
      const names = files.map(f => f.split(/[\\/]/).pop()).sort();
      assert.deepEqual(names, ['a.js', 'b.ts', 'c.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips node_modules, dist, .git, and dot-prefixed dirs', () => {
    const root = makeFixture({
      'src/a.js': '// F-100000-001',
      'node_modules/pkg/b.js': '// F-200000-002',
      'dist/c.js': '// F-300000-003',
      '.git/d.js': '// F-400000-004',
      '.claude/skill.js': '// F-500000-005',
      'coverage/e.js': '// F-600000-006',
    });
    try {
      const files = walkSourceFiles(root);
      assert.equal(files.length, 1);
      assert.ok(files[0].endsWith('a.js'),
        `only src/a.js should survive the skip set, got ${files[0]}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('always skips dot-prefixed dirs, even ones absent from skipDirs (F-PORT-002)', () => {
    // Pins the real rule the dead `&& !skipDirs.has(...)` clause obscured:
    // there is no opt-in for dot-dirs. A custom skipDirs that does NOT list a
    // dot-dir does not bring it back into the walk — dot-dirs are unconditional.
    const root = makeFixture({
      'src/a.js': '// F-100000-001',
      '.custom/b.js': '// F-200000-002',
    });
    try {
      const files = walkSourceFiles(root, { skipDirs: new Set(['node_modules']) });
      const names = files.map(f => f.split(/[\\/]/).pop());
      assert.deepEqual(names, ['a.js'],
        '.custom is dot-prefixed so it is skipped regardless of skipDirs membership');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseRegressionPins — positive cases', () => {
  it('finds source pins and test pins, bucketing by file role', () => {
    const root = makeFixture({
      'packages/report/build-submission.js':
        '// F-721047-001 — defensive guard\nfunction foo() {}',
      'packages/report/report.test.js': `
        describe('rejects null submission with structured shape (F-721047-001)', () => {});
        // F-246817-006 — precheck schema mirror
      `,
      'packages/portfolio/generate.js':
        '// F-721047-004 — multi-org enumeration',
      'packages/portfolio/generate.test.js':
        "describe('loadPolicies multi-org enumeration (F-721047-004)', () => {});",
    });
    try {
      const result = parseRegressionPins(root);

      // Source side: build-submission.js + generate.js, two distinct ids.
      assert.equal(result.source_pins.size, 2);
      assert.ok(result.source_pins.has('F-721047-001'));
      assert.ok(result.source_pins.has('F-721047-004'));

      // Test side: report.test.js (two ids) + generate.test.js (one id).
      // F-246817-006 lives in test only — exactly the "test references a fix
      // whose source pin lives elsewhere or has been deleted" case the CI
      // gate cares about. Three distinct ids on the test side total.
      assert.equal(result.test_pins.size, 3);
      assert.ok(result.test_pins.has('F-721047-001'));
      assert.ok(result.test_pins.has('F-721047-004'));
      assert.ok(result.test_pins.has('F-246817-006'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the absolute path of every file that mentions an F-id', () => {
    const root = makeFixture({
      'a.js': '// F-100000-001',
      'b.test.js': '// F-100000-001',
      'c.test.js': '// F-100000-001',
    });
    try {
      const { source_pins, test_pins } = parseRegressionPins(root);

      assert.equal(source_pins.get('F-100000-001').length, 1);
      assert.ok(source_pins.get('F-100000-001')[0].endsWith('a.js'));

      const tests = test_pins.get('F-100000-001');
      assert.equal(tests.length, 2);
      assert.ok(tests.some(p => p.endsWith('b.test.js')));
      assert.ok(tests.some(p => p.endsWith('c.test.js')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseRegressionPins — negative cases', () => {
  it('returns empty maps for an empty directory', () => {
    const root = makeFixture({});
    try {
      const result = parseRegressionPins(root);
      assert.equal(result.source_pins.size, 0);
      assert.equal(result.test_pins.size, 0);
      assert.equal(result.files_scanned, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty maps for a directory with files but no pins', () => {
    const root = makeFixture({
      'a.js': 'export const noPinsHere = 1;',
      'b.test.js': "import { describe, it } from 'node:test';",
    });
    try {
      const result = parseRegressionPins(root);
      assert.equal(result.source_pins.size, 0);
      assert.equal(result.test_pins.size, 0);
      assert.equal(result.files_scanned, 2,
        'files_scanned counts every file the walker visited, not just files with pins');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty maps for a non-existent root', () => {
    const result = parseRegressionPins('/this/path/does/not/exist');
    assert.equal(result.source_pins.size, 0);
    assert.equal(result.test_pins.size, 0);
    assert.equal(result.files_scanned, 0);
  });

  it('returns empty maps when rootDir is a file, not a directory', () => {
    const root = makeFixture({ 'a.js': '// F-100000-001' });
    try {
      const result = parseRegressionPins(join(root, 'a.js'));
      assert.equal(result.source_pins.size, 0);
      assert.equal(result.test_pins.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseRegressionPins — edge cases', () => {
  it('ignores malformed F-ids (F-XXX-yyy, F-005, F-12-345)', () => {
    const root = makeFixture({
      'a.js': `
        // see F-XXX-yyy and F-005, plus F-12-345
        // the real one is F-246817-006
      `,
    });
    try {
      const { source_pins } = parseRegressionPins(root);
      assert.equal(source_pins.size, 1);
      assert.ok(source_pins.has('F-246817-006'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles multiple distinct pins per file', () => {
    const root = makeFixture({
      'multi.test.js': `
        // F-721047-001 — null guard
        describe('a (F-721047-001)', () => {});
        // F-246817-006 — schema mirror
        describe('b (F-246817-006)', () => {});
        // F-882513-002 — duration_ms
        describe('c (F-882513-002)', () => {});
      `,
    });
    try {
      const { test_pins } = parseRegressionPins(root);
      assert.equal(test_pins.size, 3);
      // Each id maps to exactly one file even though it appears multiple times within it.
      for (const [, files] of test_pins) {
        assert.equal(files.length, 1,
          'a single file referencing the same id N times should appear once in the bucket');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT misclassify an F-id that appears in source-side prose as a test pin', () => {
    // Symmetry check for the prose-as-pin limitation: the parser is permissive,
    // but it still respects the source/test classification of the file. A prose
    // mention in build-submission.js stays in source_pins; it does not leak
    // into test_pins.
    const root = makeFixture({
      'build-submission.js': `
        // Wave-8 F-246817-001 set the clean-rejection precedent — see
        // packages/report/report.test.js for the regression test.
      `,
    });
    try {
      const { source_pins, test_pins } = parseRegressionPins(root);
      assert.ok(source_pins.has('F-246817-001'));
      assert.equal(test_pins.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces sorted, deduplicated file arrays per id', () => {
    const root = makeFixture({
      'z.test.js': '// F-100000-001',
      'a.test.js': '// F-100000-001',
      'm.test.js': '// F-100000-001',
    });
    try {
      const { test_pins } = parseRegressionPins(root);
      const files = test_pins.get('F-100000-001');
      const basenames = files.map(f => f.split(/[\\/]/).pop());
      assert.deepEqual(basenames, [...basenames].sort(),
        `paths must be sorted for stable downstream output, got ${JSON.stringify(basenames)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('toJSON', () => {
  it('converts the Map result into a JSON-serializable shape', () => {
    const root = makeFixture({
      'src.js':       '// F-721047-001',
      'src.test.js':  '// F-721047-001',
    });
    try {
      const result = parseRegressionPins(root);
      const json = toJSON(result);

      // Round-trip through JSON must preserve every field.
      const roundTripped = JSON.parse(JSON.stringify(json));
      assert.deepEqual(roundTripped, json);

      assert.ok(json.source_pins['F-721047-001']);
      assert.ok(json.test_pins['F-721047-001']);
      assert.equal(json.summary.source_ids, 1);
      assert.equal(json.summary.test_ids, 1);
      assert.deepEqual(json.summary.orphan_source_ids, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists every source-only F-id in summary.orphan_source_ids', () => {
    const root = makeFixture({
      'src.js':      '// F-721047-001\n// F-246817-005',
      'src.test.js': '// F-721047-001',
    });
    try {
      const json = toJSON(parseRegressionPins(root));
      assert.deepEqual(json.summary.orphan_source_ids, ['F-246817-005'],
        'an F-id present in source but not test is exactly the CI-gate failure case');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT report test-only F-ids as orphans (only source-without-test fails the gate)', () => {
    // A test that pins an F-id whose source has been refactored away is not a
    // CI gate failure — the test still documents the regression. Orphan-source,
    // not orphan-test, is the asymmetric check.
    const root = makeFixture({
      'src.js':      '// F-721047-001',
      'src.test.js': '// F-721047-001\n// F-246817-005',
    });
    try {
      const json = toJSON(parseRegressionPins(root));
      assert.deepEqual(json.summary.orphan_source_ids, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Self-validation against the live testing-os tree (smoke test) ──────────
//
// This walks the real repo and asserts a handful of well-known pins are
// discovered. It is intentionally tolerant: any new pin added in future waves
// must NOT break this test. The point is to catch regressions where the
// parser accidentally stops finding a known historical id (e.g. someone
// renames `// F-NNNNNN-NNN —` to `# F-NNNNNN-NNN —` in a sweep).

describe('parseRegressionPins — live repo smoke test', () => {
  it('finds the well-known F-ids in packages/{report,portfolio,schemas}', () => {
    // Walk the repo's packages/ from this test file's dir up two levels.
    const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    const packagesDir = join(here, '..', '..');
    const result = parseRegressionPins(packagesDir);

    // These three ids are pinned in this PR's sweep and should always be visible.
    // If a future fix removes them, the surrounding context will tell the reader
    // to update this list — the assertion is the breadcrumb.
    const expectedAnywhere = ['F-721047-001', 'F-246817-006', 'F-882513-002'];
    for (const id of expectedAnywhere) {
      const inSource = result.source_pins.has(id);
      const inTest = result.test_pins.has(id);
      assert.ok(inSource || inTest,
        `expected ${id} to appear in source or test pins of the live tree`);
    }
  });
});
