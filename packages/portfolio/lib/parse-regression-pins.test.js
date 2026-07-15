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

  // F-3ec5b54f: the gate this pattern feeds cannot see a finding id it
  // cannot match. This repo mints THREE id shapes — legacy, hash, and
  // prefixed (see F_ID_PATTERN's own JSDoc for the full account) — and
  // the pre-fix pattern matched only the first. These are the widening's
  // load-bearing positive cases.
  describe('F-3ec5b54f: hash-style ids (F-xxxxxxxx, 8 lowercase hex)', () => {
    it('matches a standalone hash id', () => {
      F_ID_PATTERN.lastIndex = 0;
      assert.deepEqual('fixed in F-42e57a77 today'.match(F_ID_PATTERN), ['F-42e57a77']);
    });

    it('matches multiple distinct hash ids in one string', () => {
      F_ID_PATTERN.lastIndex = 0;
      const text = 'F-2965699b and F-7ce07baa and F-a37d36f5 all landed together';
      assert.deepEqual(text.match(F_ID_PATTERN), ['F-2965699b', 'F-7ce07baa', 'F-a37d36f5']);
    });

    it('does NOT truncate a 9-hex-char run into a false 8-char match', () => {
      F_ID_PATTERN.lastIndex = 0;
      assert.equal('F-42e57a77b'.match(F_ID_PATTERN), null,
        'a 9th hex char means this is not a valid 8-char hash id — must not partially match');
    });

    it('does NOT match a bare 6-digit numeric run (that is a legacy id\'s first segment, not a hash id)', () => {
      F_ID_PATTERN.lastIndex = 0;
      // '000000' is only 6 chars — 2 short of the 8 the hash branch requires —
      // and legacy's own branch requires the '-NNN' tail to complete a match.
      assert.equal('F-000000'.match(F_ID_PATTERN), null);
    });
  });

  describe('F-3ec5b54f: prefixed ids (F-AAA[-AAA...]-NNN)', () => {
    it('matches a single-segment prefix', () => {
      F_ID_PATTERN.lastIndex = 0;
      assert.deepEqual('F-CI-001'.match(F_ID_PATTERN), ['F-CI-001']);
    });

    it('matches an alphanumeric segment (letters + digits, e.g. W1)', () => {
      F_ID_PATTERN.lastIndex = 0;
      assert.deepEqual('F-WAVE29-001'.match(F_ID_PATTERN), ['F-WAVE29-001']);
    });

    it('matches a multi-segment prefix (F-CI-SELF-DOGFOOD-001)', () => {
      F_ID_PATTERN.lastIndex = 0;
      assert.deepEqual('F-CI-SELF-DOGFOOD-001'.match(F_ID_PATTERN), ['F-CI-SELF-DOGFOOD-001']);
    });

    it('does NOT truncate a 4-digit suffix into a false 3-digit match', () => {
      F_ID_PATTERN.lastIndex = 0;
      assert.equal('F-CI-0011'.match(F_ID_PATTERN), null,
        'a 4th trailing digit means the real suffix is not 3 digits — must not partially match');
    });

    it('does NOT match a lowercase continuation after an uppercase prefix (F-XXX-yyy stays excluded)', () => {
      F_ID_PATTERN.lastIndex = 0;
      // Regression guard: confirms the widened pattern did not accidentally
      // relax the EXISTING F-XXX-yyy exclusion above while adding prefixed
      // support — 'XXX' alone satisfies the uppercase-prefix shape, but the
      // lowercase 'yyy' tail cannot complete either the prefix-continuation
      // or the digit-suffix branch.
      assert.equal('F-XXX-yyy'.match(F_ID_PATTERN), null);
    });
  });

  it('F-5eafee44: extension widening does not change WHAT counts as a pin — only which files are scanned', () => {
    // The pattern itself is extension-agnostic; walkSourceFiles' extension
    // filter is the actual F-5eafee44 fix (covered in the walkSourceFiles
    // describe block below). This test just pins that expectation in one
    // place so a reader of F_ID_PATTERN's tests sees the split explicitly.
    F_ID_PATTERN.lastIndex = 0;
    assert.deepEqual('# F-CI-SELF-DOGFOOD-001 — pinned in YAML'.match(F_ID_PATTERN), ['F-CI-SELF-DOGFOOD-001']);
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

  it('F-5eafee44: finds .yml and .yaml files alongside the JS/TS extensions', () => {
    const root = makeFixture({
      'src/a.js': '// F-100000-001',
      '.github/workflows/example.yml': '# F-CI-SELF-DOGFOOD-001',
      'policies/global-policy.yaml': '# F-200000-002',
      'd.txt': 'no F-id here please',
    });
    try {
      // Deletion/emptiness proof: this is the exact fixture shape ci-tooling's
      // F-5eafee44 META test in scripts/check-finding-regression-pins.test.mjs
      // uses. Revert DEFAULT_SOURCE_EXTENSIONS to drop .yml/.yaml and both
      // YAML files vanish from the walk — files.length would drop to 1.
      const files = walkSourceFiles(root);
      const names = files.map(f => f.split(/[\\/]/).pop()).sort();
      assert.deepEqual(names, ['a.js', 'example.yml', 'global-policy.yaml']);
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
