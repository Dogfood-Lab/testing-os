/**
 * meta-amendA-verify-engine.test.js — Amend wave A, verify-engine domain.
 *
 * Regression tests for the CONFIRMED verify-engine findings fixed in this
 * amend wave. Each block names the finding id and asserts the *post-fix*
 * behaviour so a future regression points at the exact defect that returned.
 *
 * The verify engine decides whether a claimed fix is real. Every defect here
 * is a way the tool LIES about done-ness — a still-present bug reported as a
 * verified fix, or a no-op verification reported as a pass. The assertions
 * below pin the corrected verdicts.
 *
 *   ve-001 (CRITICAL) — a MISS on a PROSE-derived anchor (symbol-less
 *     finding) must classify `unverifiable`, NOT `verified`. Only a miss on
 *     a real code-identifier `symbol` may support `verified`. Fixed in both
 *     lib/verify-classifier-v2.js (v2) and lib/verify-fixed.js (legacy v1).
 *   ve-003 (MED) — the bucket search window must be symmetric. A still-
 *     present symbol that drifted into the adjacent LOWER bucket must still
 *     be found (→ regressed/claimed), not missed (→ verified). Fixed in both
 *     classifiers (bucketForLine in v2, the inline window in v1).
 *   F-b9de9cb6 / F-d4e09870 (wave 22, HIGH) — ve-003's own fix was ITSELF
 *     asymmetric: it closed the downward gap but the `end` bound still
 *     reached only the FIRST LINE of the neighbouring bucket ABOVE, not
 *     through it, despite both docblocks claiming full symmetry. A symbol
 *     drifted 9+ lines upward (the common case: new code added above the
 *     flagged function) silently escaped detection with no upper bound.
 *     Fixed by extracting the window math into lib/verify-window.js
 *     (shared by both engines) with a genuinely symmetric formula.
 *   ve-004 (MED) — a Node repo with no `test` script must NOT be a verified
 *     pass: `npm test --if-present` runs zero tests, so the node adapter
 *     surfaces a distinct `no_tests` verdict the caller treats as not-pass.
 *   ve-005 (LOW) — an empty / all-optional required step set must not be an
 *     automatic `pass`; runSteps() returns `skip`.
 *   ve-006 (LOW) — doc-only correction to the runStep() security docstring
 *     (no behaviour change; asserted indirectly via the still-passing
 *     literal-arg execution path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { classifyFindingV2, VERIFIED_VIA } from './lib/verify-classifier-v2.js';
import { classifyFixedFinding } from './lib/verify-fixed.js';
import { runSteps, runStep } from './lib/verify/runner.js';
import { nodeAdapter } from './lib/verify/adapters/node.js';

const REPO = join(tmpdir(), 'meta-amendA-verify-engine-repo');

/**
 * Fake-filesystem reader: `{ repo-relative path → lines[] }`. Resolved
 * through the same path.resolve() the classifiers use so keys match on
 * win32 + posix. Mirrors the helper in verify-fixed.test.js.
 */
function fakeReader(table, repoRoot) {
  const resolved = new Map();
  for (const [k, v] of Object.entries(table)) {
    resolved.set(resolve(repoRoot, k), v);
  }
  return (absPath) => (resolved.has(absPath) ? resolved.get(absPath) : null);
}

function mkFinding(overrides = {}) {
  return {
    finding_id: 'F-001',
    fingerprint: 'fp-F-001',
    severity: 'HIGH',
    category: 'bug',
    file_path: 'src/a.js',
    line_number: 42,
    symbol: 'doThing',
    description: 'doThing leaks memory',
    recommendation: 'free the buffer',
    last_seen_wave: 3,
    fixed_wave_id: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ve-001 — prose-anchor MISS must be `unverifiable`, never `verified`
// ═══════════════════════════════════════════════════════════════════════

describe('ve-001 — symbol-less finding, prose-anchor miss → unverifiable (v2)', () => {
  it('classifies unverifiable (NOT verified) when the prose token is absent', () => {
    // Symbol-less finding. The description lead token "Missing" is prose —
    // it is not expected to appear in source. The bucket does NOT contain
    // it. Pre-fix this resolved to `verified` (fix landed); post-fix it must
    // be `unverifiable` (cannot prove the fix landed).
    const f = mkFinding({
      symbol: '',
      file_path: 'src/a.js',
      description: 'Missing null check in handler',
      line_number: 5,
    });
    const file = Array.from({ length: 20 }, (_, i) => `const x${i} = compute();`);
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'unverifiable');
    assert.notEqual(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.UNVERIFIABLE);
    assert.match(r.evidence, /prose|cannot prove/i);
  });

  it('still resolves `verified` on a real code-identifier symbol miss', () => {
    // The asymmetry fix must NOT break the legitimate case: a real symbol
    // that is genuinely gone from the bucket is a verified fix.
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// clean line ${i + 1}`);
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'verified');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('a prose-anchor HIT still classifies claimed-but-still-present (confirm-only path intact)', () => {
    // A HIT on a prose token is still meaningful: the token IS in the code,
    // so the bug is demonstrably still there. Only the MISS side changed.
    const f = mkFinding({
      symbol: '',
      file_path: 'src/a.js',
      description: 'memoryLeak in buffer logic',
      line_number: 5,
    });
    const file = ['', 'noise', 'noise', 'noise', 'function memoryLeak() {}', 'noise'];
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'claimed-but-still-present');
  });
});

describe('ve-001 — symbol-less finding, prose-anchor miss → unverifiable (legacy v1)', () => {
  it('classifies unverifiable (NOT verified) so --legacy-v1 keeps the hole closed', () => {
    const f = mkFinding({
      symbol: '',
      file_path: 'src/a.js',
      description: 'Missing null check in handler',
      line_number: 5,
    });
    const file = Array.from({ length: 20 }, (_, i) => `const x${i} = compute();`);
    const r = classifyFixedFinding(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'unverifiable');
    assert.notEqual(r.classification, 'verified');
    assert.match(r.evidence, /prose|cannot prove/i);
  });

  it('still resolves `verified` on a real code-identifier symbol miss', () => {
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// clean line ${i + 1}`);
    const r = classifyFixedFinding(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.equal(r.classification, 'verified');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-003 — symmetric bucket window: downward drift must be caught
// ═══════════════════════════════════════════════════════════════════════

describe('ve-003 — downward-drift symbol is still found (legacy v1)', () => {
  it('classifies regressed (NOT verified) when the symbol drifted to the lower bucket', () => {
    // Recorded line 42 → bucket [40,50]. The bug is still present but the
    // surrounding code shifted so the symbol now sits at line 38, which is
    // in the adjacent LOWER bucket [30,40). Pre-fix the window was [40,50]
    // (upward-only overlap) and missed line 38 → `verified`. Post-fix the
    // window reaches a full bucket down and finds it → not verified.
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[37] = 'function doThing() { /* still here, drifted down */ }'; // line 38
    const r = classifyFixedFinding(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.notEqual(r.classification, 'verified');
    assert.equal(r.classification, 'regressed');
    assert.match(r.evidence, /reappeared/);
  });
});

describe('ve-003 — downward-drift symbol is still found (v2)', () => {
  it('classifies regressed (NOT verified) when the symbol drifted to the lower bucket', () => {
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[37] = 'function doThing() { /* still here, drifted down */ }'; // line 38
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.notEqual(r.classification, 'verified');
    assert.equal(r.classification, 'regressed');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F-b9de9cb6 / F-d4e09870 — symmetric bucket window: UPWARD drift must be
// caught too. ve-003 (above) proved the window reaches a full bucket DOWN;
// it never proved the window reaches a full bucket UP, and it didn't —
// bucketForLine's `end` (v2) / the inlined `bucketEnd` (v1) both computed
// `bucket + FINGERPRINT_BUCKET`, which is only the FIRST LINE of the
// neighbouring bucket above, not through it. A finding recorded at line 42
// (own bucket [40,49]) was scanned only to line 50; a genuinely symmetric
// window reaches line 59. Reproduction mirrors the finding's own live proof:
// symbol drifted 13 lines upward (42 → 55), inside the neighbouring bucket
// [50,59] the docblocks always claimed was covered. Both engines share the
// identical formula (now the identical shared helper, lib/verify-window.js),
// so both are pinned here.
// ═══════════════════════════════════════════════════════════════════════

describe('F-b9de9cb6 — upward-drift symbol is still found (v2)', () => {
  /** @pins F-b9de9cb6 */
  it('classifies regressed (NOT verified) when the symbol drifted into the UPWARD neighbour bucket', () => {
    // Recorded line 42 → own bucket [40,49]. The bug is still present but
    // drifted UP to line 55 — inside the neighbouring bucket [50,59]. Pre-fix
    // the window was [30,50] (reached only the first line of the bucket
    // above) and missed line 55 entirely → misclassified `verified`. Post-fix
    // the window reaches [30,59], finds it, and reports NOT verified.
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`);
    file[54] = 'function doThing() { /* still here, drifted up 13 lines */ }'; // line 55
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.notEqual(r.classification, 'verified');
    assert.equal(r.classification, 'regressed');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('boundary: a symbol at line 59 (the far end of the neighbour bucket) is still found', () => {
    // line 59 is the LAST line of the neighbouring bucket [50,59] — the exact
    // upper edge the fix must reach. One line further (60) is a DIFFERENT
    // bucket pair and legitimately out of this window's scope.
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`);
    file[58] = 'function doThing() { /* at the far upward edge */ }'; // line 59
    const r = classifyFindingV2(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.notEqual(r.classification, 'verified');
  });
});

describe('F-d4e09870 — upward-drift symbol is still found (legacy v1)', () => {
  /** @pins F-d4e09870 */
  it('classifies regressed (NOT verified) when the symbol drifted into the UPWARD neighbour bucket', () => {
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`);
    file[54] = 'function doThing() { /* still here, drifted up 13 lines */ }'; // line 55
    const r = classifyFixedFinding(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.notEqual(r.classification, 'verified');
    assert.equal(r.classification, 'regressed');
    assert.match(r.evidence, /reappeared/);
  });

  it('boundary: a symbol at line 59 (the far end of the neighbour bucket) is still found', () => {
    const f = mkFinding({ symbol: 'doThing', file_path: 'src/a.js', line_number: 42 });
    const file = Array.from({ length: 70 }, (_, i) => `// line ${i + 1}`);
    file[58] = 'function doThing() { /* at the far upward edge */ }'; // line 59
    const r = classifyFixedFinding(f, REPO, { readLines: fakeReader({ 'src/a.js': file }, REPO) });
    assert.notEqual(r.classification, 'verified');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-004 — Node repo with no `test` script is not a verified pass
// ═══════════════════════════════════════════════════════════════════════

describe('ve-004 — node adapter refuses to report a no-test repo as a verified pass', () => {
  let root;

  function makeFixture(scripts) {
    const dir = mkdtempSync(join(tmpdir(), 've004-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'no-test-repo', version: '0.0.0', scripts }, null, 2),
      'utf-8'
    );
    return dir;
  }

  it('a fixture with NO test script yields a non-pass verdict (no_tests), not pass', () => {
    // A real repo with no `test` script. `npm test --if-present` exits 0 and
    // runs nothing. Pre-fix the runner reported verdict `pass` (zero tests
    // ran, indistinguishable from a real pass). Post-fix the node adapter
    // surfaces `no_tests` so the wave gate (which advances only on `pass`)
    // treats it as not-verified.
    root = makeFixture({ build: 'tsc -b' }); // lint/build present, NO test
    try {
      const result = nodeAdapter.run(root);
      assert.notEqual(result.verdict, 'pass');
      assert.equal(result.verdict, 'no_tests');
      assert.equal(result.no_tests, true);
      assert.equal(result.tests_ran, false);
      assert.match(result.reason, /no .?test.? script|zero tests/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-005 — empty / all-optional required step set is not an automatic pass
// ═══════════════════════════════════════════════════════════════════════

describe('ve-005 — runSteps does not report `pass` for an empty/all-skipped step set', () => {
  it('empty step list → verdict skip (not pass)', () => {
    const result = runSteps('.', []);
    assert.notEqual(result.verdict, 'pass');
    assert.equal(result.verdict, 'skip');
  });

  it('all-optional step set → verdict skip even when the optional steps passed', () => {
    // Every step optional → requiredResults is []. `[].every` is vacuously
    // true, which pre-fix yielded `pass`. Post-fix this is `skip`: nothing
    // required ran, so it cannot be reported as a passing verification.
    const steps = [
      { name: 'lint', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
    ];
    const result = runSteps('.', steps);
    assert.notEqual(result.verdict, 'pass');
    assert.equal(result.verdict, 'skip');
  });

  it('a required step that passes still yields `pass` (fix is scoped to the empty case)', () => {
    const steps = [
      { name: 'test', cmd: 'node', args: ['-e', '"console.log(\'# tests 1\')"'] },
    ];
    const result = runSteps('.', steps);
    assert.equal(result.verdict, 'pass');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-006 — runStep security docstring correction (behaviour unchanged)
// ═══════════════════════════════════════════════════════════════════════

describe('ve-006 — runStep literal-arg execution path still behaves correctly', () => {
  // The fix is doc-only: it corrects the docstring's overstatement about
  // shell:true safety. There is no behaviour change, so we simply pin that
  // the hardcoded-literal-arg execution path (the safe path the corrected
  // docstring describes) continues to run and report exit codes correctly.
  it('runs a literal-arg command and reports a passing exit code', () => {
    const r = runStep('.', { name: 'ok', cmd: 'node', args: ['-e', '"process.exit(0)"'] });
    assert.equal(r.passed, true);
    assert.equal(r.exit_code, 0);
  });

  it('reports a failing exit code for a literal-arg command', () => {
    const r = runStep('.', { name: 'bad', cmd: 'node', args: ['-e', '"process.exit(3)"'] });
    assert.equal(r.passed, false);
    assert.equal(r.exit_code, 3);
  });
});
