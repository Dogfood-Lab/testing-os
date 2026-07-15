/**
 * stageA-ds-verify-engine.test.js — Stage A amend, verify-engine (lib/verify**
 * + lib/verify-classifier-v2.js + lib/verify-fixed.js).
 *
 * Regression pins for three CONFIRMED verify-engine findings fixed this wave.
 * Each block names its finding id and asserts the post-fix behaviour so a
 * future regression points at the exact defect that returned. Every defect is
 * a way the tool LIES about done-ness or exposes a DoS surface.
 *
 *   ds-verify-001 (MED) — a `test` step that ran ZERO tests must NOT score a
 *     verified `pass`. extractTestCount returns 0 (not null) for cargo
 *     `0 passed` / node `# tests 0`, so `tests_ran` demanded only `!= null`
 *     and a no-op run passed. Now `tests_ran` requires a POSITIVE count and
 *     the pass→no_tests downgrade lives in the RUNNER so it fires uniformly
 *     for every adapter (node + rust below).
 *   ds-verify-002 (MED) — a finding with NO recorded line (line_number 0/null)
 *     scans the whole file; an anchor hit ANYWHERE means still-present
 *     (unfixed), NOT `regressed` (there is no recorded line to measure a move
 *     against). Fixed in both classifyByAnchor (v2) and classifyFixedFinding
 *     (v1).
 *   ds-verify-003 (LOW) — the classification file readers (defaultReadLines in
 *     v2, readLines in v1) read the finding's target file with no size cap; a
 *     huge committed blob in run.local_path is fully read + scanned (DoS). Now
 *     an over-cap target returns null (→ unverifiable/skip).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

import { runSteps } from './lib/verify/runner.js';
import { classifyFindingV2, VERIFIED_VIA } from './lib/verify-classifier-v2.js';
import { classifyFixedFinding } from './lib/verify-fixed.js';
import { MAX_AGENT_OUTPUT_BYTES } from './lib/bounded-json-read.js';

const REPO = join(tmpdir(), 'stageA-ds-verify-engine-repo');

/**
 * Fake-filesystem reader: `{ repo-relative path → lines[] }`. Resolved through
 * the same path.resolve() the classifiers use so keys match on win32 + posix.
 * Mirrors verify-classifier-v2.test.js.
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
// ds-verify-001 — a zero-test run is `no_tests`, not `pass`, for node + rust
// ═══════════════════════════════════════════════════════════════════════

describe('ds-verify-001 — a clean-compile / zero-test run yields no_tests, not pass', () => {
  // DO NOT "TIDY" THE NAME OF THE TEST BELOW. Its backticked `# tests 0` is
  // load-bearing, and not for this test — for extractTestCount's anchor.
  //
  // This title prints into the TAP stream as a plain line containing a
  // summary-shaped string, at roughly byte 258k of a full `npm test` run —
  // ~225k BEFORE the first real `# tests` summary. An unanchored
  // /# tests? (\d+)/ therefore matched THIS TEST'S NAME and reported the whole
  // repo as 0 tests, so the run that proves "zero tests must not pass" was
  // itself what made the floor report zero tests. The gate's own regression pin
  // became the adversarial input that broke the gate.
  //
  // Renaming it costs nothing here and silently retires the only in-repo
  // attacker the anchor has. Keep it hostile.
  it('node `# tests 0` → verdict no_tests (not pass)', () => {
    // extractTestCount reads "# tests 0" as 0 (not null); pre-fix tests_ran was
    // `0 != null` === true, so the run scored a clean pass despite running
    // nothing. The runner-level downgrade now fires.
    const result = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"console.log(\'# tests 0\')"'] },
    ]);
    assert.equal(result.test_count, 0, 'the parser must read the explicit zero');
    assert.notEqual(result.verdict, 'pass', 'a zero-test run must not be a verified pass');
    assert.equal(result.verdict, 'no_tests');
    assert.equal(result.no_tests, true);
    assert.equal(result.tests_ran, false);
    assert.match(result.reason, /zero tests/i);
  });

  it('rust/cargo `test result: ok. 0 passed` → verdict no_tests (not pass)', () => {
    // The finding named cargo explicitly: its downgrade lived in no adapter, so
    // a clean `cargo check` + `0 passed` scored a pass. The runner now downgrades
    // uniformly regardless of the adapter that produced the output shape.
    const result = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"console.log(\'test result: ok. 0 passed; 0 failed\')"'] },
    ]);
    assert.equal(result.test_count, 0);
    assert.equal(result.verdict, 'no_tests');
    assert.equal(result.no_tests, true);
    assert.equal(result.tests_ran, false);
  });

  it('a POSITIVE count still yields a clean pass (fix is scoped to zero/no-count)', () => {
    const result = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"console.log(\'# tests 3\')"'] },
    ]);
    assert.equal(result.test_count, 3);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.tests_ran, true);
    assert.equal(result.reason, undefined, 'a plain pass carries no reason');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ds-verify-002 — a no-line finding whose anchor still exists is still-present
// ═══════════════════════════════════════════════════════════════════════

describe('ds-verify-002 — a no-line finding with a surviving anchor is still-present, not regressed', () => {
  function fileWithAnchorAt(lineNo) {
    const file = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
    file[lineNo - 1] = 'function doThing() {}';
    return file;
  }

  it('classifyFindingV2 (v2): line_number 0 + anchor present → claimed-but-still-present', () => {
    const f = mkFinding({ symbol: 'doThing', line_number: 0 });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({ 'src/a.js': fileWithAnchorAt(5) }, REPO),
    });
    assert.equal(r.classification, 'claimed-but-still-present',
      'a no-line anchor hit is unfixed, not a move-distance regression');
    assert.notEqual(r.classification, 'regressed');
    assert.equal(r.verified_via, VERIFIED_VIA.ANCHOR);
  });

  it('classifyFindingV2 (v2): line_number null behaves the same as 0', () => {
    const f = mkFinding({ symbol: 'doThing', line_number: null });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({ 'src/a.js': fileWithAnchorAt(30) }, REPO),
    });
    assert.equal(r.classification, 'claimed-but-still-present');
  });

  it('classifyFixedFinding (v1): line_number 0 + anchor present → claimed-but-still-present', () => {
    const f = mkFinding({ symbol: 'doThing', line_number: 0 });
    const r = classifyFixedFinding(f, REPO, {
      readLines: fakeReader({ 'src/a.js': fileWithAnchorAt(5) }, REPO),
    });
    assert.equal(r.classification, 'claimed-but-still-present');
    assert.notEqual(r.classification, 'regressed');
  });

  it('a recorded-line finding whose anchor drifted within the bucket is STILL regressed (fix is scoped)', () => {
    // Recorded at line 41 (bucket [40,50]); anchor at line 48 — a real
    // move-distance regression must survive the no-line guard untouched.
    const f = mkFinding({ symbol: 'doThing', line_number: 41 });
    const r = classifyFindingV2(f, REPO, {
      readLines: fakeReader({ 'src/a.js': fileWithAnchorAt(48) }, REPO),
    });
    assert.equal(r.classification, 'regressed');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ds-verify-003 — the classification file readers cap the target-file read
// ═══════════════════════════════════════════════════════════════════════

describe('ds-verify-003 — an over-cap target file is skipped (null), not fully read', () => {
  it('an over-cap target classifies unverifiable in BOTH v1 and v2 (default readers)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-verify-003-'));
    try {
      // A committed blob larger than the read cap (a minified vendor bundle,
      // generated lockfile, data fixture) in the audited repo's checkout. No
      // newlines: one giant line the null-line scan would otherwise regex.
      const target = join(dir, 'vendor.min.js');
      writeFileSync(target, Buffer.alloc(MAX_AGENT_OUTPUT_BYTES + 4096, 0x61)); // 'a'

      // NO injected reader — exercise the real defaultReadLines / readLines that
      // now carry the statSync cap.
      const f = mkFinding({ symbol: 'doThing', file_path: 'vendor.min.js', line_number: 0 });

      const v2 = classifyFindingV2(f, dir);
      assert.equal(v2.classification, 'unverifiable',
        'over-cap target must be skipped, not read + scanned');
      assert.equal(v2.verified_via, VERIFIED_VIA.UNVERIFIABLE);
      assert.match(v2.evidence, /not present|deleted|moved|unreadable/);

      const v1 = classifyFixedFinding(f, dir);
      assert.equal(v1.classification, 'unverifiable');
      assert.match(v1.evidence, /not present|deleted|moved|unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a normal-sized target under the cap is still read and classified (happy path intact)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-verify-003-ok-'));
    try {
      const target = join(dir, 'src.js');
      writeFileSync(target, 'line 1\nfunction doThing() {}\nline 3\n');
      const f = mkFinding({ symbol: 'doThing', file_path: 'src.js', line_number: 0 });

      const v1 = classifyFixedFinding(f, dir);
      assert.equal(v1.classification, 'claimed-but-still-present',
        'a small file must still be read — the cap must not regress the happy path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
