/**
 * Tests for suggest-pins.mjs — the demoted candidate-link generator.
 *
 * Scope: this suite verifies (a) the ported legacy-heuristic functions still
 * behave as they did pre-demotion (a transcription smoke test, not a
 * re-litigation of their full wave-6..16 history — that coverage lives in
 * git history at 860ed73 for the retired module), and (b) the NEW
 * suggestion-generation contract: declared ids are never suggested, legacy
 * hits become suggestions, and ids with neither land in stillUnmigrated
 * rather than disappearing silently.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { hasLegacyStructuralHit, findLegacyStructuralHits, suggestPinsForRepo } from './suggest-pins.mjs';

function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'suggest-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
  };
}

describe('legacy heuristics (ported, transcription smoke test)', () => {
  test('hasLegacyStructuralHit: leading-comment shape is recognized', () => {
    const text = '// F-100000-001 — the actual fix reason\ntest("t", () => { assert.ok(true); });\n';
    assert.equal(hasLegacyStructuralHit(text, 'F-100000-001', 'x.test.js'), true);
  });

  test('hasLegacyStructuralHit: test-title shape (with a real assert body) is recognized', () => {
    const text = "describe('guard (F-100000-002)', () => { assert.ok(true); });\n";
    assert.equal(hasLegacyStructuralHit(text, 'F-100000-002', 'x.test.js'), true);
  });

  test('hasLegacyStructuralHit: title-only with an EMPTY body is NOT recognized (F-ec9622fd bar preserved)', () => {
    const text = "test('F-100000-003: unrelated smoke test', () => {});\n";
    assert.equal(hasLegacyStructuralHit(text, 'F-100000-003', 'x.test.js'), false);
  });

  test('hasLegacyStructuralHit: bare narrative mention with no structural signal is NOT recognized', () => {
    const text = 'function unrelated() { return 1; } // mentions F-100000-004 in passing, mid-sentence\n';
    assert.equal(hasLegacyStructuralHit(text, 'F-100000-004', 'x.test.js'), false);
  });

  test('hasLegacyStructuralHit: self-referencing file header is recognized within the first 20 lines', () => {
    const text = 'verify-fixed.test.js — F-100000-005 (regression coverage)\n' + 'x'.repeat(5) + '\n';
    assert.equal(hasLegacyStructuralHit(text, 'F-100000-005', 'verify-fixed.test.js'), true);
  });

  test('findLegacyStructuralHits reports the kind, not just a boolean', () => {
    const text = '// F-100000-006 — leading comment\n';
    const hits = findLegacyStructuralHits(text, 'F-100000-006', 'x.test.js');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, 'leading-comment');
  });

  // The three tests below give real, individually-declared coverage to
  // historical findings that are now cited only as prose provenance inside
  // pin-declarations-corpus.mjs's `origin` strings (F-16275dfd, F-f37bb9ae,
  // F-234da564) — citing an id in a data-file docstring is not the same as
  // testing the behavior it fixed, and this wave's live-tree gate correctly
  // orphaned all three the moment the RETIRED test file's own dedicated
  // CONTROL/TREATMENT tests for them were replaced by the new generic
  // corpus loop. The code these findings fixed is not gone — it was ported
  // verbatim into this file's hasLegacyStructuralHit/findLegacyStructuralHits
  // (see module docstring) — so it genuinely can, and should, be verified
  // here rather than bypassed via an allowlist entry.

  /** @pins F-16275dfd */
  test('F-16275dfd: a title match whose body contains a regex with an unbalanced escaped-bracket count still earns credit (escape-aware bracket-depth tracking survives the port)', () => {
    const text = "test('F-160000-001: escaped-bracket case', () => {\n  const re = /\\(unbalanced/;\n  assert.ok(re.test('(unbalanced'));\n});\n";
    assert.equal(hasLegacyStructuralHit(text, 'F-160000-001', 'x.test.js'), true, 'an escaped bracket inside a regex body must not desync the body-assert scan and deny real credit');
  });

  /** @pins F-f37bb9ae */
  test('F-f37bb9ae: a bare regex-literal statement testing an id shape does not earn leading-comment credit on placement alone (lone-slash guard survives the port)', () => {
    const text = '/F-370000-001/.test(candidate);\n';
    assert.equal(hasLegacyStructuralHit(text, 'F-370000-001', 'x.test.js'), false, "a regex literal's lone '/' delimiter must never be mistaken for a real comment opener");
  });

  /** @pins F-f37bb9ae */
  test('F-f37bb9ae: an unescaped open bracket inside a regex character class does not inflate depth and leak the scan into a later, unrelated test (survives the port)', () => {
    const text =
      "test('F-370000-002: char class case', () => {\n" +
      "  const re = /[(]/;\n" +
      '  assert.ok(re.test(String.fromCharCode(40)));\n' +
      '});\n' +
      "test('unrelated later test', () => { assert.ok(true); });\n";
    assert.equal(hasLegacyStructuralHit(text, 'F-370000-002', 'x.test.js'), true, 'a character-class bracket must not desync depth tracking and must still resolve within the SAME call\'s own body');
  });

  /** @pins F-234da564 */
  test('F-234da564: an ordinary comment mentioning both an id and the bare word "assert", nowhere near a test/describe block, does not grant assert-line credit (unified masking survives the port)', () => {
    const text = '// this comment mentions F-234000-001 and the word assert but proves nothing\nfunction unrelated() {}\n';
    assert.equal(hasLegacyStructuralHit(text, 'F-234000-001', 'x.test.js'), false, 'comment prose must stay masked from the same-line-assert-argument rule');
  });
});

test('suggestPinsForRepo: declared tag suppresses a suggestion entirely', async (t) => {
  const fx = makeFixture(t);
  fx.write('src/a.js', '// F-200000-001 — a fix\n');
  fx.write('src/a.test.js', "/** @pins F-200000-001 */\ntest('a', () => { assert.ok(true); });\n");

  const result = suggestPinsForRepo(fx.dir);
  assert.deepEqual(result.coveredByDeclaredTag, ['F-200000-001']);
  assert.equal(result.suggestions.some((s) => s.id === 'F-200000-001'), false);
});

test('suggestPinsForRepo: a legacy hit with no declared tag produces a suggestion carrying an insertable tag line', async (t) => {
  const fx = makeFixture(t);
  fx.write('src/b.js', '// F-200000-002 — a fix\n');
  fx.write('src/b.test.js', "describe('guard (F-200000-002)', () => { assert.ok(true); });\n");

  const result = suggestPinsForRepo(fx.dir);
  assert.equal(result.coveredByDeclaredTag.length, 0);
  const suggestion = result.suggestions.find((s) => s.id === 'F-200000-002');
  assert.ok(suggestion, 'expected a suggestion for F-200000-002');
  assert.equal(suggestion.insertAboveLine, '/** @pins F-200000-002 */');
  assert.equal(result.stillUnmigrated.includes('F-200000-002'), false);
});

test('suggestPinsForRepo: an id with neither a declared tag nor a legacy hit lands in stillUnmigrated, not silently dropped', async (t) => {
  const fx = makeFixture(t);
  fx.write('src/c.js', '// F-200000-003 — a fix with genuinely no test-side signal\n');
  fx.write('src/c.test.js', "test('unrelated', () => { assert.ok(true); });\n");

  const result = suggestPinsForRepo(fx.dir);
  assert.deepEqual(result.stillUnmigrated, ['F-200000-003']);
  assert.equal(result.suggestions.some((s) => s.id === 'F-200000-003'), false);
});

test('CLI: --help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, ['scripts/suggest-pins.mjs', '--help'], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: node scripts\/suggest-pins\.mjs/);
});

test('CLI: --json against a fixture root prints valid JSON with the expected shape', async (t) => {
  const fx = makeFixture(t);
  fx.write('src/d.js', '// F-200000-004 — a fix\n');
  fx.write('src/d.test.js', "describe('guard (F-200000-004)', () => { assert.ok(true); });\n");

  const res = spawnSync(process.execPath, ['scripts/suggest-pins.mjs', '--json', '--root', fx.dir], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed.suggestions));
  assert.ok(parsed.suggestions.some((s) => s.id === 'F-200000-004'));
});
