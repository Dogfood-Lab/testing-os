/**
 * Regression tests for scripts/check-finding-regression-pins.mjs.
 *
 * Why this lives at the root scripts/ tree: same reason as sync-version.test.mjs
 * and check-doc-drift.test.mjs — the gate isn't owned by any workspace package
 * and we don't want to grow a pseudo-workspace just to host it. Run via
 * `npm run test:scripts`.
 *
 * Coverage:
 *   1. Clean tree — no orphans → ok=true, exit 0 path
 *   2. Drift tree — synthetic source F-id with no test pin → ok=false
 *   3. Allowlist — orphan covered by allowlist → ok=true, allowlistApplied non-empty
 *   4. Unused allowlist entry — surfaced in unusedAllowEntries (not a hard failure)
 *   5. --write-index flag — writes a JSON file at the requested path
 *   6. Allowlist loader — malformed JSON, missing "allow", non-string reason all error
 *   7. Live-tree assertion: the actual repo passes the gate (load-bearing test —
 *      this is the contract that says "the gate is wired and current")
 *
 * Cleanup: every makeFixture() registers `t.after(() => rmSync(dir, ...))`
 * mirroring the check-doc-drift pattern that closed F-651020-007.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  runRegressionPinGate,
  loadAllowlist,
  applyAllowlist,
  formatHuman,
  findStructuralPinHits,
  hasStructuralTestPin,
  computeStructuralOrphans,
  explainUnusedAllowEntry,
} from './check-finding-regression-pins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Allocate a temp fixture root, register cleanup, return helpers.
 */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-regression-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    writeAllowlist(obj) {
      const abs = join(dir, 'allowlist.json');
      writeFileSync(abs, JSON.stringify(obj, null, 2));
      return abs;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Positive cases — clean tree, allowlist coverage
// ─────────────────────────────────────────────────────────────────────────────

test('clean tree: every source pin has a matching test pin → ok=true', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-001 — defensive guard\n');
  fx.write('packages/foo/index.test.js', "describe('guard (F-100000-001)', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, true, `expected ok=true on clean tree; orphans=${JSON.stringify(result.orphans)}`);
  assert.equal(result.orphans.length, 0);
  assert.equal(result.json.summary.source_ids, 1);
  assert.equal(result.json.summary.test_ids, 1);
});

test('orphan covered by allowlist → ok=true, allowlistApplied includes the id', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-200000-001 — cross-ref to sibling fix elsewhere\n');
  // No test pin for F-200000-001.
  const allowlistPath = fx.writeAllowlist({
    allow: {
      'F-200000-001': { reason: 'cross-reference to sibling fix; pin lives in another file', file: 'packages/foo/index.js' },
    },
  });

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.allowlistApplied, ['F-200000-001']);
  assert.deepEqual(result.orphans, []);
});

test('unused allowlist entry surfaces as warning but does not fail the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-001\n');
  // F-ec9622fd: a bare leading comment with nothing following it no longer
  // earns structural credit (rule 1 now requires adjacency to a real call) —
  // use a genuine title+assert pin so this fixture stays clean under the
  // tightened rules; this test's actual subject is the unused-entry warning,
  // not the leading-comment rule.
  fx.write('packages/foo/index.test.js', "test('F-100000-001 stays fixed', () => { assert.ok(true); });\n");
  const allowlistPath = fx.writeAllowlist({
    allow: {
      'F-999999-999': { reason: 'never resolved' },
    },
  });

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath });

  assert.equal(result.ok, true, 'unused allowlist entries are advisory, not failure');
  assert.deepEqual(result.unusedAllowEntries, ['F-999999-999']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative cases — orphan source pin
// ─────────────────────────────────────────────────────────────────────────────

test('synthetic source F-id with no matching test pin → ok=false, orphans listed', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-300000-001 — fix that nobody tested\n');
  // Deliberately no test file pinning F-300000-001.

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false, 'orphan source pin should fail the gate');
  assert.deepEqual(result.orphans, ['F-300000-001']);
  assert.equal(result.allowlistApplied.length, 0);
});

test('orphan from one file does not mask a clean orphan elsewhere', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/x.js', '// F-400000-001 — orphan a\n');
  fx.write('packages/b/y.js', '// F-400000-002 — orphan b\n');
  fx.write('packages/c/z.js', '// F-400000-003 — has test\n');
  // F-ec9622fd: a bare leading comment with nothing following it no longer
  // earns structural credit — give F-400000-003 a genuine title+assert pin
  // so it stays the one CLEAN id this fixture is contrasting against the two
  // deliberate orphans.
  fx.write('packages/c/z.test.js', "test('F-400000-003 regression', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false);
  assert.deepEqual([...result.orphans].sort(), ['F-400000-001', 'F-400000-002']);
});

// ─────────────────────────────────────────────────────────────────────────────
// F-f0339e12 — structural test-pin filter (mutation-probe proof).
//
// PROVEN BY DIRECT MUTATION-PROBE AGAINST THE REAL PRODUCTION PARSER: before
// this fix, extractPinsFromText() (parse-regression-pins.js) ran a whole-
// file-text regex sweep with zero requirement that a test-file mention of an
// F-id have any structural relationship to a real check — a narrative
// cross-reference in a comment ("unlike F-deadbeef's approach...") cleared
// Class #14 for F-deadbeef exactly as if a dedicated regression test
// existed. This already happened for real: a wave-6 comment, narrating the
// history of a sibling id inside a DIFFERENT test's explanation two
// sections below (search this file for "wave 4) fixed the module
// docstring"), made that still-genuinely-uncovered sibling id look newly
// test-pinned, surfacing only as a misleadable "stale allowlist entry" WARN.
//
// NOTE for future editors: this block, and every test below it, deliberately
// avoids spelling that sibling id as a bare leading-comment token, inside a
// test()/it()/describe() title, or on a line containing "assert" — doing any
// of those would hand it fresh structural credit under THIS FILE's own
// fix, contaminating the "stays uncovered on the live tree" proof further
// down. Where a test needs the literal string, it is assigned to a named
// constant on its own undecorated, assert-free line and referenced by name
// afterward — see LIVE_NARRATIVE_ONLY_ID below.
//
// The tests below prove the fix both directions per the finding's own
// standard: the synthetic name-drop case must go RED (stay an orphan
// despite the textual mention) and a genuinely-pinned id must stay GREEN.
// ─────────────────────────────────────────────────────────────────────────────

test('F-f0339e12 unit: findStructuralPinHits recognizes a leading-comment pin (placement-only — F-ec9622fd deliberately did not extend the body-assert bar to this rule)', () => {
  const text =
    '// F-100000-014 — the actual fix reason\n' +
    "test('regression coverage', () => { assert.ok(true); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-014', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['leading-comment']);
});

test('F-ec9622fd: this repo\'s banner-comment convention (banner block, BLANK line, then describe()) still earns leading-comment credit (rule 1 is placement-only, so this was never at risk)', () => {
  // Confirmed live shape (wave10-docs-identity-drift.test.js:203): a banner
  // block followed by a blank line, THEN the call. This is exactly the
  // pattern an "immediately above the call" tightening of rule 1 was
  // evaluated against and rejected for (see the module docstring's WHAT
  // STILL SLIPS THROUGH) — ~52 live ids depend on rule-1 placement credit
  // that tightening would have broken. Pinned here so a future attempt at
  // that tightening has an immediate regression signal.
  const text = [
    '// ═══════════════════════════════════════════',
    '// F-100000-010 — banner-style section header',
    '// ═══════════════════════════════════════════',
    '',
    "describe('some suite', () => { assert.ok(true); });",
  ].join('\n');
  const hits = findStructuralPinHits(text, 'F-100000-010', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['leading-comment']);
});

test('F-f0339e12 unit: findStructuralPinHits recognizes a test()/it()/describe() title pin with a body-level assert (F-ec9622fd\'s bar)', () => {
  const hits = findStructuralPinHits("describe('guard (F-100000-001)', () => { assert.ok(true); });\n", 'F-100000-001', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title']);
});

test('F-ec9622fd mutation-probe (RED direction): a title match sitting above a genuinely EMPTY callback body earns no credit', () => {
  // Pre-fix this earned full 'title' credit on placement alone — the exact
  // gap the finding proved: `test('F-100000-005: unrelated smoke test', () =>
  // {})` with zero assertions anywhere in its own body still cleared Class
  // #14. The id is textually present in the title; nothing in the call ever
  // exercises anything.
  const hits = findStructuralPinHits("describe('guard (F-100000-001)', () => {});\n", 'F-100000-001', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'a title with zero assert/expect anywhere in its own call body must not earn structural credit',
  );
});

test('F-ec9622fd: a title match whose assert lives several lines into a multi-line callback body still earns credit (not same-line-only)', () => {
  const text = [
    "test('F-100000-007: multi-line body', () => {",
    '  const x = compute();',
    '  const y = transform(x);',
    '  assert.equal(y, 42);',
    '});',
  ].join('\n');
  const hits = findStructuralPinHits(text, 'F-100000-007', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title'], 'the body-assert check scans the whole call body, not just the title line');
});

test('F-ec9622fd: a title match on a describe() whose assert lives inside a nested it() still earns credit', () => {
  const text = [
    "describe('F-100000-008: outer suite', () => {",
    "  it('does the thing', () => {",
    '    assert.ok(doThing());',
    '  });',
    '});',
  ].join('\n');
  const hits = findStructuralPinHits(text, 'F-100000-008', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title'], 'an assert nested inside a child it() is still within the describe() call\'s own body span');
});

// ─────────────────────────────────────────────────────────────────────────────
// F-16275dfd — enclosingCallHasAssertBody escape-awareness (mutation-probe,
// A/B controlled). Pre-fix, the depth loop treated every raw '(' '{' ')' '}'
// character as a real bracket with zero backslash-escape awareness, so a
// regex literal between a test's title and its real assert — an ordinary
// shape for a test that validates literal bracket/paren stripping — could
// corrupt the count. Equal escaped opens and closes cancel out even without
// escape-awareness (the CONTROL below), so the trigger is specifically an
// UNBALANCED escaped-bracket count within one regex literal (the TREATMENT
// below): pre-fix, two escaped close-parens with zero escaped opens collapsed
// depth to zero mid-regex, closed the scanned span on the "const re = …"
// line, and returned false without ever reaching the real assert two lines
// later — a TRUE ORPHAN for a genuinely-covered id. Only the regex's escaped-
// bracket balance differs between CONTROL and TREATMENT.
// ─────────────────────────────────────────────────────────────────────────────

test('F-16275dfd CONTROL: a title match whose body contains a regex with a BALANCED escaped-bracket count still earns credit', () => {
  const text = [
    "test('F-100000-018: validates trailing-paren stripping', () => {",
    '  const re = /a\\(b\\)c/;',
    '  const result = stripTrailing(input);',
    '  assert.equal(result, expected);',
    '});',
  ].join('\n');
  const hits = findStructuralPinHits(text, 'F-100000-018', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title'], 'a balanced escaped-bracket count nets to the same depth with or without escape-awareness');
});

test('F-16275dfd TREATMENT (was RED, now GREEN): a title match whose body contains a regex with an UNBALANCED escaped-bracket count still earns credit', () => {
  const text = [
    "test('F-100000-019: validates trailing-paren stripping', () => {",
    '  const re = /a\\)b\\)c/;',
    '  const result = stripTrailing(input);',
    '  assert.equal(result, expected);',
    '});',
  ].join('\n');
  const hits = findStructuralPinHits(text, 'F-100000-019', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['title'],
    'pre-F-16275dfd this collapsed depth to zero mid-regex (two escaped closes, zero escaped opens) and returned false ' +
      'before ever reaching the real assert two lines later — a true orphan for a genuinely-covered id',
  );
});

test('F-16275dfd mutation-probe (RED direction): an unbalanced-bracket regex in the body does not manufacture credit for a genuinely uncovered id', () => {
  // The escape-skip must only remove a FALSE orphan, never introduce a FALSE
  // grant — a title with the same unbalanced-escape regex but NO real assert
  // anywhere in its body must still earn no credit.
  const text = [
    "test('F-100000-020: unrelated smoke test', () => {",
    '  const re = /a\\)b\\)c/;',
    '  doSomethingWithNoAssertion();',
    '});',
  ].join('\n');
  const hits = findStructuralPinHits(text, 'F-100000-020', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'an unbalanced-bracket regex in the body must not manufacture false assert-body credit for a genuinely uncovered id',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-f37bb9ae — enclosingCallHasAssertBody character-class awareness
// (mutation-probe, both directions, plus a systematic audit-sweep fix and one
// disclosed-but-not-fixed residual, all proven by direct construction against
// the real production function per the finding's own methodology).
//
// PRE-FIX MECHANISM: the depth loop treated every raw '(' '{' ')' '}'
// character as a real bracket, with zero character-class ('[...]')
// awareness — so an UNESCAPED bracket char sitting inside a regex character
// class (where it is a literal to match, never a group/quantifier boundary)
// miscounted depth. An unescaped OPEN bracket in a class INFLATED depth,
// delaying closure past the call's true end and leaking the scan into a
// LATER, unrelated call — a FALSE GRANT (the dangerous direction). An
// unescaped CLOSE bracket DEFLATED depth, closing early and denying a
// genuinely-covered id — an under-credit (the safe-but-still-wrong
// direction). Both are closed by the same `inClass` fix.
// ─────────────────────────────────────────────────────────────────────────────

test('F-f37bb9ae TREATMENT (was a false grant, now correctly denied): an unescaped OPEN bracket inside a regex character class must not inflate depth and leak the scan into a later, unrelated test', () => {
  // Verbatim shape from the finding's own reproduction: the first id's own
  // body has zero real assertions; pre-fix, the class's '(' inflated depth
  // so the scan never reached <=0 at this call's true '});' and leaked into
  // the second, unrelated test, crediting the first id with the second
  // test's assert.
  const text =
    "test('F-100000-021: unrelated smoke test', () => {\n" +
    '  const re = /[(]/;\n' +
    '  doSomethingHarmless();\n' +
    '});\n' +
    "test('a different test', () => {\n" +
    '  assert.ok(true);\n' +
    '});\n';
  const hits = findStructuralPinHits(text, 'F-100000-021', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'an unescaped open bracket in a character class must not manufacture false assert-body credit by leaking the scan into a later, unrelated call',
  );
});

test('F-f37bb9ae A/B control: the identical shape with an ESCAPED open paren (not a character class) stays correctly denied, isolating the trigger to the character class specifically', () => {
  const text =
    "test('F-100000-022: unrelated smoke test', () => {\n" +
    '  const re = /\\(/;\n' +
    '  doSomethingHarmless();\n' +
    '});\n' +
    "test('a different test', () => {\n" +
    '  assert.ok(true);\n' +
    '});\n';
  const hits = findStructuralPinHits(text, 'F-100000-022', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['none'], 'an escaped paren was already correctly denied pre-fix (F-16275dfd) — this stays denied, confirming the character class is what F-f37bb9ae\'s fix targets, not escaping');
});

test('F-f37bb9ae counter-proof (GREEN direction, open bracket): a genuinely-covered id whose body legitimately contains an open-bracket character class AND a real assert in its OWN call still earns credit', () => {
  const text =
    "test('F-100000-023: strips a literal open paren', () => {\n" +
    '  const re = /[(]/;\n' +
    '  const result = strip(input);\n' +
    '  assert.equal(result, expected);\n' +
    '});\n';
  const hits = findStructuralPinHits(text, 'F-100000-023', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title'], 'the fix must suppress the character class\'s effect on depth, not deny credit outright — a real assert in the same call body must still be found');
});

test('F-f37bb9ae counter-proof (GREEN direction, close bracket — this sub-case was a TRUE ORPHAN pre-fix, not merely a coincidentally-correct denial): a genuinely-covered id whose body contains a character class with two literal close-bracket characters now earns credit', () => {
  // A standard `test('id', () => { ... })` body starts the scan at depth=2
  // (the call's own '(' plus the block-bodied arrow's own '{'), so ONE
  // stray close-bracket-in-class only brings depth to 1, not 0 — matching
  // why F-16275dfd's own repro needed TWO escaped closes to trigger. This
  // class holds two literal close characters to cancel both baseline
  // levels, reproducing the actual pre-fix premature-closure bug (not the
  // weaker single-close shape, which never actually triggered the bug).
  const text =
    "test('F-100000-024: validates trailing-paren stripping', () => {\n" +
    '  const re = /[)}]/;\n' +
    '  const result = stripTrailing(input);\n' +
    '  assert.equal(result, expected);\n' +
    '});\n';
  const hits = findStructuralPinHits(text, 'F-100000-024', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['title'],
    'pre-fix this collapsed depth to zero mid-class (two literal closes cancelling the test-call paren and the block-brace) and returned false before ever reaching the real assert one line later — a true orphan for a genuinely-covered id, not a coincidentally-correct denial',
  );
});

test('F-234da564 TREATMENT (wave 16 — was a DISCLOSED, NOT FIXED gap under F-f37bb9ae, now CLOSED): a regex literal whose PATTERN TEXT (not a bracket) literally spells "assert" or "expect(" no longer manufactures false assert-body credit', () => {
  // Pre-wave-16 this was a documented open gap: the inClass fix only
  // changed how BRACKET CHARACTERS affect depth; STRUCTURAL_ASSERT_LINE.test()
  // still ran against the same regex-literal-inclusive text regardless, so a
  // regex whose SOURCE spells "assert" (not its match target) satisfied the
  // check with zero real assertion anywhere. Closed by the unified masking
  // pass (maskToCodeOnly blanks entire regex literals — delimiters, flags,
  // and pattern text alike — before enclosingCallHasAssertBody's bracket
  // scan or its STRUCTURAL_ASSERT_LINE check ever run): see the module
  // docstring's "F-e003b1fb / F-234da564 (wave 16)" section.
  const text =
    "test('F-100000-059: unrelated smoke test', () => {\n" +
    '  const re = /assert/;\n' +
    '  doSomethingHarmless();\n' +
    '});\n';
  const hits = findStructuralPinHits(text, 'F-100000-059', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'a regex literal\'s pattern TEXT spelling the word "assert" must not grant credit — masking the entire regex literal in the code-only view closes this class',
  );
});

test('F-234da564 counter-proof (GREEN direction): the identical shape but with a REAL assert call elsewhere in the body still earns credit — masking the regex body denies the FAKE call, not the call body as a whole', () => {
  const text =
    "test('F-100000-060: validates the assert-shaped regex is inert', () => {\n" +
    '  const re = /assert/;\n' +
    '  assert.ok(re.test("assert"));\n' +
    '});\n';
  const hits = findStructuralPinHits(text, 'F-100000-060', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['title'],
    'a genuine assert.ok(...) call elsewhere in the same body must still earn credit — only the regex-literal-as-fake-call vector is closed',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-f37bb9ae (audit sweep) — rule 1 (isLeadingCommentPin) hardened against
// the same "unmasked text plus a regex literal" evasion class: a line that
// is really a regex-literal statement (testing an id shape — an ordinary
// thing to write in a repo whose own job is id-pattern matching) starts
// with a lone '/', which STRUCTURAL_COMMENT_DECORATION's `[/*#-]+` class
// cannot distinguish from a real '//' or '/*' comment opener.
// ─────────────────────────────────────────────────────────────────────────────

test('F-f37bb9ae (audit sweep) TREATMENT: a regex-literal statement testing an id shape must not earn leading-comment credit on placement alone', () => {
  const hits = findStructuralPinHits('/F-100000-029/.test(candidate);\n', 'F-100000-029', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'a lone leading slash is a regex-literal delimiter, not a comment opener — it must not be stripped as decoration',
  );
});

test('F-f37bb9ae (audit sweep) GREEN controls: every real comment-decoration convention this repo uses stays unaffected by the lone-slash guard', () => {
  const cases = [
    ['// line comment', '// F-100000-030 — the actual fix reason\n', 'F-100000-030'],
    ['/* block comment opener', '/* F-100000-031 block header\n', 'F-100000-031'],
    ['* JSDoc continuation', '*   F-100000-032  schema.js STATUS.run enum\n', 'F-100000-032'],
    ['# shell-style comment', '# F-100000-033 — orphaned prefixed-format pin\n', 'F-100000-033'],
    ['- markdown list marker', '- F-100000-034 — desc\n', 'F-100000-034'],
  ];
  for (const [label, text, id] of cases) {
    const hits = findStructuralPinHits(text, id, 'irrelevant.test.js');
    assert.deepEqual(hits.map((h) => h.kind), ['leading-comment'], `${label} must still earn leading-comment credit`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F-c7927c58 — isSameLineAssertArgumentPin (rule 4) title-span masking
// (mutation-probe, both directions, plus a precision proof that the fix
// excludes only the title span and not the whole line).
//
// PRE-FIX MECHANISM: rule 4 deliberately tests the RAW, unmasked line (by
// design, to find ids living inside real assertion-message strings) — but
// that also meant it could not distinguish a REAL assert/expect( CALL from
// the bare English word "assert" or literal "expect(" text sitting inside a
// test/it/describe TITLE, silently overriding rule 2's correct empty-body
// denial on the exact same line.
// ─────────────────────────────────────────────────────────────────────────────

test('F-c7927c58 TREATMENT: a test title containing the ordinary English word "assert" must not override rule 2\'s correct denial for a genuinely empty callback body', () => {
  const text = "test('F-100000-025: should not assert when input is valid', () => { doSomethingWithNoAssertion(); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-025', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'title prose containing the bare word "assert" must not satisfy rule 4 — the callback body has zero real assertions',
  );
});

test('F-c7927c58 TREATMENT: a test title containing literal "expect()" as prose must not override rule 2\'s correct denial for a genuinely empty callback body', () => {
  const text = "test('F-100000-026: does not call expect() directly', () => { doSomethingWithNoAssertion(); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-026', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'title prose containing literal "expect()" text must not satisfy rule 4 — the callback body has zero real assertions',
  );
});

test('F-c7927c58 negative control: ordinary title wording with the same empty body was already correctly denied and stays denied', () => {
  const text = "test('F-100000-027: handles the edge case correctly', () => { doSomethingWithNoAssertion(); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-027', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['none'], 'isolates the trigger to assert/expect-shaped prose specifically, not to titled-empty-bodies in general (already covered by F-ec9622fd)');
});

test('F-c7927c58 precision proof: maskTestTitleSpan excludes only the quoted title span, not the whole line — a real, unrelated assert naming the id later on the same physical line still earns credit', () => {
  const text = "test('F-100000-028', () => {}); assert.ok(true, 'F-100000-028 checked');\n";
  const hits = findStructuralPinHits(text, 'F-100000-028', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['assert-line'],
    'the empty test() call correctly earns no title credit, but the genuine assert.ok(...) call later on the same line, naming the id in its own message, must still earn rule-4 credit — proves the fix is surgical, not a blanket same-line denial',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-e003b1fb / F-234da564 (wave 16) — the unified masking pass. Both are
// PROVEN-BY-DIRECT-CONSTRUCTION HIGH findings that closed the pin-matcher's
// false-grant class at its root (see the module docstring's "F-e003b1fb /
// F-234da564 (wave 16)" section) after five prior waves (w8/10/12/13/14) of
// per-rule ad hoc masking each closed one non-code position and missed
// another. Every test below mutation-proves one evasion class BOTH
// directions: the evasion now DENIES credit, and a genuinely-covered id
// (or the canonical legitimate use case the fix must not break) still gets
// it. F-f37bb9ae's own "regex spells assert" disclosure is proven closed
// just above this block, not repeated here.
// ─────────────────────────────────────────────────────────────────────────────

test('F-e003b1fb TREATMENT: an escaped quote inside a single-quoted test title truncates the pre-wave-16 escape-blind regex, exposing the title\'s "assert" prose and the id to rule 4 — now correctly denied end-to-end', async (t) => {
  // Verbatim repro from the finding: an apostrophe inside a contraction
  // ("it's") is a routine way to write a single-quoted title, exactly the
  // prose style this domain's OWN F-c7927c58 fix used for its own examples
  // ("should not assert when input is valid", "does not call expect()
  // directly"). Pre-fix, matchTestCallStart's STRUCTURAL_TEST_TITLE regex
  // captured only up to the ESCAPED quote, so maskTestTitleSpan blanked the
  // truncated span and left the real remainder of the title — including
  // "does not assert anything" — exposed to rule 4's raw pattern test.
  const fx = makeFixture(t);
  fx.write('src/widget.js', '// F-deadb33f - fixed a totally fake bug for this fixture\n');
  fx.write(
    'test/widget.test.js',
    "test('it\\'s got F-deadb33f inside, and does not assert anything', () => { widget(); });\n",
  );

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'an escaped quote inside a test title must not truncate title detection and leak "assert" prose (plus the id) to rule 4 for a body with zero real assertions',
  );
  assert.deepEqual(result.orphans, ['F-deadb33f']);
});

test('F-e003b1fb unit: findStructuralPinHits denies both title AND assert-line credit for the escaped-quote-title shape, isolating the mechanism from the fixture/CLI plumbing above', () => {
  const text = "test('it\\'s got F-100000-061 inside, and does not assert anything', () => { widget(); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-061', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'rule 2 must deny (empty body) and rule 4 must not override that denial via the un-truncated title\'s "assert" prose',
  );
});

test('F-e003b1fb counter-proof (GREEN direction): an escaped quote inside a title that ALSO has a real assert in its body still earns title credit — the fix corrects the title boundary, it does not blanket-deny escaped titles', () => {
  const text = "test('it\\'s got F-100000-062 covered for real', () => { assert.ok(doTheThing()); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-062', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['title'],
    'a correctly-detected escaped-quote title whose call body has a genuine assert must still earn credit',
  );
});

test('F-e003b1fb: the same escape-truncation shape is closed for all three title delimiters (\', ", `), matching STRUCTURAL_TEST_TITLE\'s original delimiter-generic capture group', () => {
  const cases = [
    ['single-quoted', "test('it\\'s F-100000-063 and does not assert', () => { doNothing(); });\n"],
    ['double-quoted', 'test("she said \\"F-100000-064 doesn\'t assert\\" to me", () => { doNothing(); });\n'],
    ['template-literal', 'test(`it\\`s F-100000-065 and does not assert`, () => { doNothing(); });\n'],
  ];
  for (const [label, text] of cases) {
    const id = text.match(/F-100000-0\d\d/)[0];
    const hits = findStructuralPinHits(text, id, 'irrelevant.test.js');
    assert.deepEqual(hits.map((h) => h.kind), ['none'], `${label} escaped-delimiter title must not leak credit for a genuinely empty body`);
  }
});

test('F-234da564 TREATMENT: an ordinary comment mentioning both an id and the bare word "assert", nowhere near a test/describe block, must not grant assert-line credit', () => {
  const text =
    'function unrelatedHelperOne() { return 1; }\n' +
    '// Note: F-100000-066 does not assert anything here, the check happens in the helper below.\n' +
    'function unrelatedHelperTwo() { return 2; }\n';
  const hits = findStructuralPinHits(text, 'F-100000-066', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'a plain comment mentioning "assert" as English prose must not manufacture a Class #14 pin with zero real assertion anywhere in the file',
  );
});

test('F-234da564 TREATMENT: the same shape triggered by literal "expect(" text in a comment, instead of "assert", is denied identically', () => {
  // The id is deliberately NOT the leading token (unlike rule 1's own
  // canonical shape) — "See:" precedes it — so this exercises rule 4 in
  // isolation instead of rule 1 legitimately granting leading-comment
  // credit first.
  const text = '// See: F-100000-067 does not call expect() directly, handled in the helper below.\n';
  const hits = findStructuralPinHits(text, 'F-100000-067', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['none'], 'literal "expect(" text inside a comment must not satisfy the assert/expect check either');
});

test('F-234da564 TREATMENT: a plain console.log() string literal mentioning an id and "assert", with no real assertion on the line, must not grant credit (rule 4 previously never masked strings either)', () => {
  const text = "console.log('F-100000-068 does not assert anything here, the check happens elsewhere');\n";
  const hits = findStructuralPinHits(text, 'F-100000-068', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['none'],
    'the word "assert" spelled inside a console.log() string argument is not a real assert/expect( call and must not satisfy rule 4',
  );
});

test('F-234da564 counter-proof (GREEN direction): the canonical rule-4 pin — an id inside a real assertion-message STRING on a line with a genuine assert call — still earns credit', () => {
  const hits = findStructuralPinHits("assert.doesNotMatch(a, /F-unrelated/, 'domain-a leaked F-100000-069');\n", 'F-100000-069', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['assert-line'], 'an id living inside a real assertion-message string must keep earning rule-4 credit');
});

test('F-234da564 / F-9c41a2b7 counter-proof (GREEN direction, live-corpus shape): an id living ONLY inside a regex-literal argument to a real assert call — no redundant string copy — still earns credit', () => {
  // This is the shape an earlier draft of this wave's fix broke (see
  // PROSE_MASK_KINDS in the production file): packages/dogfood-swarm/
  // wave8-4091637-5127-swarm-cp-pins.test.js pins F-9c41a2b7 exactly this
  // way (assert.match(text, /F-9c41a2b7/, 'message with no id in it')).
  // Regex-literal pattern text must stay visible for id-membership even
  // though it is blanked for the separate "is this a real call" check.
  const text = "assert.match(preceding, /F-100000-070/, 'must cross-reference the finding');\n";
  const hits = findStructuralPinHits(text, 'F-100000-070', 'irrelevant.test.js');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['assert-line'],
    'a bare regex-literal matcher argument to a real assert call is exactly as legitimate an id site as a string argument',
  );
});

test('F-e003b1fb / F-234da564: a template-literal (backtick) title with assert-shaped prose and a genuinely empty body is denied, exactly like the single/double-quoted cases', () => {
  const text = 'test(`F-100000-071: does not assert anything`, () => { doNothing(); });\n';
  const hits = findStructuralPinHits(text, 'F-100000-071', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['none'], 'template-literal titles get the same title-masking treatment as quoted-string titles');
});

test('F-e003b1fb / F-234da564 counter-proof (GREEN direction): a template-literal title containing the id, whose call body has a real assert, still earns title credit — including a nested ${...} interpolation in the title', () => {
  const text = 'test(`F-100000-072: computed ${1 + 1} case`, () => { assert.ok(true); });\n';
  const hits = findStructuralPinHits(text, 'F-100000-072', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title'], 'a template-literal title with a nested ${} expression must still be recognized as a real title, not corrupt the scan');
});

test('F-e003b1fb / F-234da564: multiple regex literals on one line (including one containing an escaped slash) do not desync the scanner or corrupt detection of a real assert call later on the same line', () => {
  const text = "test('F-100000-073: two regexes', () => { const a = /x\\/y/, b = /z/; assert.ok(a.test('x/y') && b.test('z')); });\n";
  const hits = findStructuralPinHits(text, 'F-100000-073', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['title'], 'lexing back-to-back regex literals (one with an internal escaped slash) must not corrupt detection of the real assert.ok(...) call that follows');
});

test('F-234da564 (new gap closed beyond the two named findings): a multi-line block comment containing what LOOKS like a titled test with its own assert, entirely inside the comment, must not grant credit on an interior line', async (t) => {
  // The pre-wave-16 per-line maskCommentsAndStrings regex required BOTH
  // block-comment delimiters to appear within the SAME line it was applied
  // to — an interior line of a multi-line block comment (no delimiter on
  // that line) was treated as ordinary, unmasked code. scanNonCodeSpans is
  // inherently multi-line-aware (ported from strip-comments.js, which
  // already tracks block comments across line boundaries), and
  // findStructuralPinHits now runs it once over the whole file text before
  // splitting into lines, so this is closed for every rule that consumes
  // the masked views, not just the two named findings.
  const fx = makeFixture(t);
  fx.write('src/gizmo.js', '// F-9ab3d0e2 - fixed a totally fake bug for this fixture\n');
  fx.write(
    'test/gizmo.test.js',
    '/**\n' +
    " * test('F-9ab3d0e2: unrelated smoke test', () => {\n" +
    ' *   assert.ok(true);\n' +
    ' * });\n' +
    ' */\n' +
    "test('a real, unrelated test', () => { assert.ok(1); });\n",
  );

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'a fake test+assert shape living entirely inside a multi-line block comment must not clear Class #14 for the id it merely narrates in prose',
  );
  assert.deepEqual(result.orphans, ['F-9ab3d0e2']);
});

test('F-f0339e12 unit: findStructuralPinHits recognizes a same-line assert argument pin', () => {
  const hits = findStructuralPinHits("assert.doesNotMatch(a, /F-B-001/, 'domain-a leaked F-B-001');\n", 'F-B-001', 'irrelevant.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['assert-line']);
});

test('F-f0339e12 unit: findStructuralPinHits recognizes a self-referencing file-header pin', () => {
  const text = '/**\n * verify-fixed.test.js — F-252713-002 (Phase 7 wave 1)\n */\n';
  const hits = findStructuralPinHits(text, 'F-252713-002', 'verify-fixed.test.js');
  assert.deepEqual(hits.map((h) => h.kind), ['self-header']);
});

test('F-ec9622fd: a self-header hit with the REST of the file entirely unrelated still earns credit alone (rule 3 is placement-only, sufficient on its own — see module docstring WHAT STILL SLIPS THROUGH)', () => {
  // Finding's exact case (c) — pinned here, not to prove the gap is closed
  // (it deliberately is not, this wave), but so a future attempt to
  // downgrade rule 3 to "supplementary only" has an immediate regression
  // signal: downgrading it would orphan real live ids whose ONLY structural
  // signal across their whole test file is a dedicated self-header (e.g.
  // above: F-252713-002; also F-39aca64f, F-BACKEND-003 — each a whole file
  // genuinely dedicated to one id with real describe/it/assert structure
  // that never repeats the id in a title/leading-comment/assert-line).
  // F-1555de3f: this comment used to lead its F-252713-002 mention with the
  // bare id, mechanically self-granting a redundant leading-comment pin for
  // the very id it was describing as self-header-only ("above:" now comes
  // first) — wording only, no logic change.
  const text =
    '/**\n * weird.test.js — F-100000-012 (declares coverage in its own header)\n */\n' +
    "test('something entirely unrelated', () => { doSomethingWithNoAssertion(); });\n";
  assert.equal(hasStructuralTestPin(text, 'F-100000-012', 'weird.test.js'), true);
});

test('F-f0339e12 unit: a bare narrative mention (not leading, no title, no self-header, no same-line assert) is NOT structural', () => {
  const text = "// unlike F-deadbeef's approach, this test does something else entirely\n";
  assert.equal(hasStructuralTestPin(text, 'F-deadbeef', 'unrelated.test.js'), false);
});

test('F-f0339e12 unit: a SECOND id named mid-sentence after a leading id does not inherit the leading id\'s structural credit (the real live-tree shape)', () => {
  // Reproduces the exact live wave-6 comment shape verbatim (see this file's
  // own history) without spelling either id on a title/leading-comment/
  // assert-line anywhere in THIS file — both ids are isolated into named
  // constants on their own undecorated, assert-free lines so this unit test
  // cannot itself hand out the structural credit it's proving is absent.
  const leadingId = 'F-c59bb518';
  const namedAfterwardId = 'F-893adcd1';
  const text = `// ${leadingId}: ${namedAfterwardId} (wave 4) fixed the module docstring to stop\ntest('regression coverage', () => { assert.ok(true); });\n`;
  assert.equal(hasStructuralTestPin(text, leadingId, 'check-finding-regression-pins.test.mjs'), true, 'the LEADING id on the line is a real pin');
  assert.equal(hasStructuralTestPin(text, namedAfterwardId, 'check-finding-regression-pins.test.mjs'), false, 'the id named afterward, mid-sentence, is a narrative cross-reference, not a pin');
});

test('F-f0339e12 mutation-probe (RED direction): a source fix pin whose only test-side mention is a narrative name-drop in an UNRELATED test stays an orphan', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-deadbeef — fixed a totally fake bug for this fixture\n');
  fx.write(
    'packages/foo/other.test.js',
    "test('something unrelated', () => {\n" +
    "  // unlike F-deadbeef's approach, this test asserts a different invariant\n" +
    '  assert.equal(1, 1);\n' +
    '});\n',
  );

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'a narrative name-drop with no structural signal must NOT clear Class #14 for the id it merely mentions',
  );
  assert.deepEqual(result.orphans, ['F-deadbeef']);
});

test('F-f0339e12 counter-proof (GREEN direction): a source fix pin with a GENUINE test-title pin is not an orphan', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-deadbeef — fixed a totally fake bug for this fixture\n');
  fx.write('packages/foo/index.test.js', "test('regression: F-deadbeef stays fixed', () => { assert.equal(1, 1); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, true, 'a genuine title pin must still clear Class #14');
  assert.deepEqual(result.orphans, []);
});

test('F-f0339e12: computeStructuralOrphans — pure function over an injected readFile, no disk access', () => {
  const json = {
    source_pins: { 'F-100000-001': ['/x/a.js'], 'F-200000-002': ['/x/b.js'] },
    test_pins: { 'F-100000-001': ['/x/a.test.js'], 'F-200000-002': ['/x/b.test.js'] },
    files_scanned: 4,
    summary: { source_ids: 2, test_ids: 2, orphan_source_ids: [] },
  };
  const files = {
    '/x/a.test.js': "test('F-100000-001 stays fixed', () => { assert.equal(1, 1); });\n",
    '/x/b.test.js': "// unlike F-100000-001's approach, F-200000-002 does something else\n",
  };
  const out = computeStructuralOrphans(json, { readFile: (p) => files[p] });
  assert.deepEqual(out.orphanSourceIds, ['F-200000-002'], 'the title pin clears F-100000-001; the narrative mention does not clear F-200000-002');
  assert.deepEqual(out.narrativeOnlyIds, ['F-200000-002']);
});

test('F-f0339e12: explainUnusedAllowEntry distinguishes "now structurally covered" from "no longer a source pin"', () => {
  const json = { source_pins: { 'F-covered': ['/x/a.js'] }, test_pins: {}, files_scanned: 1, summary: {} };
  assert.match(
    explainUnusedAllowEntry('F-covered', json, new Set(['F-covered'])),
    /genuine structural test pin/,
  );
  assert.match(
    explainUnusedAllowEntry('F-gone', json, new Set()),
    /no longer appears as a source pin/,
  );
});

test('F-f0339e12: the live tree — a genuine orphan whose only test-side mention is a wave-6 narrative name-drop stays suppressed by its allowlist entry, never surfaces as "unused"', async () => {
  // The id under test is isolated into a named constant on its own
  // undecorated, assert-free, non-title line — see the section-header
  // comment above for why: spelling it directly in this test's title or on
  // an assert-line would hand it fresh structural credit and defeat the
  // very thing being proven.
  const LIVE_NARRATIVE_ONLY_ID = 'F-893adcd1';

  const result = await runRegressionPinGate({ repoRoot });
  const stillUnused = result.unusedAllowEntries.includes(LIVE_NARRATIVE_ONLY_ID);
  const stillApplied = result.allowlistApplied.includes(LIVE_NARRATIVE_ONLY_ID);
  assert.equal(
    stillUnused,
    false,
    `${LIVE_NARRATIVE_ONLY_ID} is a genuine orphan with only a narrative test-side mention (search this file for "wave 4) fixed the module docstring") — it must stay suppressed via the allowlist (applied), never surface as "unused"/"safe to delete"`,
  );
  assert.equal(
    stillApplied,
    true,
    `${LIVE_NARRATIVE_ONLY_ID} should be actively applying its allowlist entry, not silently uncovered`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-3ec5b54f / F-5eafee44 META — non-vacuity across ID format and file
// extension. CROSS-DOMAIN: F_ID_PATTERN and DEFAULT_SOURCE_EXTENSIONS are
// defined in packages/portfolio/lib/parse-regression-pins.js, which this
// gate CONSUMES (see the import at the top of check-finding-regression-pins.mjs)
// but does not define. That file matches packages/portfolio/**, owned
// exclusively by the backend domain per the frozen wave-2 domain map — out
// of scope for this domain (.github/**, scripts/**, tsconfig*.json).
//
// The three tests immediately below assert the CORRECT, desired gate
// behavior for every finding-id shape this repo actually mints (hash
// F-xxxxxxxx, prefixed F-AAA-NNN, and workflow-YAML source pins) — matching
// the standard this file's own legacy-format tests already hold the gate
// to. THEY ARE EXPECTED TO FAIL (RED) until packages/portfolio/lib/
// parse-regression-pins.js is fixed. That is not a bug in the tests; it is
// the honest, non-vacuous signal F-3ec5b54f exists to surface, in the style
// scripts/check-doc-drift.test.mjs already uses for its own META tests
// ("error-codes META: removing any enforced code from the handbook MUST
// trigger drift"). Confirmed empirically against the live tree via a
// read-only diagnostic (reusing the real walkSourceFiles/classifyFile
// exports with the finding's proposed widened pattern substituted in — no
// repo file was edited to measure this): of 133 source-side F-id pins that
// exist under the widened pattern (40 legacy already visible today + 77
// hash-style + 16 prefixed, both currently invisible), 13 are true orphans
// — 3 legacy already known and allowlisted in scripts/regression-pin-allowlist.json,
// plus 10 newly-discovered (3 hash-style, 7 prefixed) that would need a
// regression-test pin or an allowlist entry once the pattern lands. See the
// ci-tooling wave-2 output for the full accounting and the exact 10 ids.
//
// DO NOT mark these `todo`, weaken the assertions, or delete them to reach
// a green — that is exactly the "narrow the pattern to get a green"
// anti-pattern the finding's fix explicitly forbids. Once the backend-domain
// fix lands, these three tests go green with no further edit needed here.
// ─────────────────────────────────────────────────────────────────────────────

test('F-3ec5b54f META: a HASH-style source pin (F-xxxxxxxx) with no test pin must fail the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-42e57a77 — defer the red run past the commit step\n');
  // Deliberately no test pin for F-42e57a77.

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'CROSS-DOMAIN BLOCKED (F-3ec5b54f): F_ID_PATTERN in packages/portfolio/lib/parse-regression-pins.js ' +
      '(backend domain, out of scope for scripts/**) does not match hash-style ids, so this pin is currently ' +
      `INVISIBLE to the gate (got source_ids=${result.json.summary.source_ids}, expected 1) and result.ok is wrongly true. ` +
      'This assertion documents the desired behavior and will pass once the pattern is widened per F-3ec5b54f\'s fix — do not soften it to get a green.',
  );
});

test('F-3ec5b54f META: a PREFIXED-style source pin (F-AAA-NNN) with no test pin must fail the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-W1-CI-999 — orphaned prefixed-format pin for this test\n');

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'CROSS-DOMAIN BLOCKED (F-3ec5b54f): the prefixed format (F-AAA-NNN, e.g. F-W1-CI-008 / F-CI-001) is also ' +
      `invisible to the unwidened F_ID_PATTERN (got source_ids=${result.json.summary.source_ids}, expected 1). Same cross-domain blocker as the hash-style test above.`,
  );
});

test('F-5eafee44 META: a workflow YAML source pin with no test pin must fail the gate (extension not scanned today)', async (t) => {
  const fx = makeFixture(t);
  fx.write('.github/workflows/example.yml', '# F-999999-002 — a fix pinned in a workflow file, no test coverage\n');

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'CROSS-DOMAIN BLOCKED (F-5eafee44): DEFAULT_SOURCE_EXTENSIONS in packages/portfolio/lib/parse-regression-pins.js ' +
      `(backend domain) does not include .yml/.yaml, so this file is never scanned (got files_scanned=${result.json.files_scanned}, expected 1) ` +
      'and result.ok is wrongly true. Land together with F-3ec5b54f\'s regex widening — the next test guards the ' +
      'specific live claim that 12 real F-ids already rely on this extension being scanned.',
  );
});

test('F-5eafee44: the 12 workflow-pinned F-ids named in the finding are still present in .github/workflows/*.yml (guards the claim, not the gate)', () => {
  // Independently verifies the finding's own factual claim about today's
  // live tree over the real repo — not the (out-of-domain) parser and not a
  // fixture — so the claim can't silently go stale if a future edit drops
  // one of these pins. Genuinely load-bearing pins per F-5eafee44: the
  // deferred-fault evidence-preservation ordering in ingest.yml, the release
  // concurrency-group normalization, and the pa11y permission isolation.
  //
  // One assert per id, each id literal on its own assert line, instead of
  // the previous ids[]-array + filter + single deepEqual: the arrange-then-
  // assert shape parked every one of these ids in the F-f0339e12 structural
  // filter's blind spot (an id in an array literal lines away from the
  // assert that consumes it earns no structural credit), which left two of
  // them reading as orphans despite this exact test covering them. Unrolled
  // per the wave-8 coordinator disposition — same coverage, one failure
  // message per missing id, structurally credited.
  const workflowsDir = resolve(repoRoot, '.github/workflows');
  const text = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => readFileSync(resolve(workflowsDir, f), 'utf-8'))
    .join('\n');

  assert.ok(text.includes('F-362d4131'), 'F-362d4131 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-42e57a77'), 'F-42e57a77 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-50558cb2'), 'F-50558cb2 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-60f0c4f5'), 'F-60f0c4f5 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-68818085'), 'F-68818085 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-a52776d5'), 'F-a52776d5 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-bc123f41'), 'F-bc123f41 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-caeeacc3'), 'F-caeeacc3 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-d31dfc55'), 'F-d31dfc55 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-e4a24655'), 'F-e4a24655 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-ef512e21'), 'F-ef512e21 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
  assert.ok(text.includes('F-f05363e2'), 'F-f05363e2 must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)');
});

// ─────────────────────────────────────────────────────────────────────────────
// --write-index flag
// ─────────────────────────────────────────────────────────────────────────────

test('--write-index path: writes JSON to the requested path with parser shape', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-500000-001\n');
  fx.write('packages/foo/index.test.js', "test('F-500000-001 stays fixed', () => { assert.ok(true); });\n");
  const indexPath = 'docs/regression-pin-index.json';

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    writeIndexPath: indexPath,
  });

  assert.equal(result.ok, true);
  assert.ok(result.indexWritten, 'indexWritten should be set when --write-index is used');
  assert.ok(existsSync(result.indexWritten), `index file should exist at ${result.indexWritten}`);

  const contents = JSON.parse(readFileSync(result.indexWritten, 'utf-8'));
  assert.ok(contents.source_pins['F-500000-001']);
  assert.ok(contents.test_pins['F-500000-001']);
  assert.equal(contents.summary.source_ids, 1);
  assert.equal(contents.summary.test_ids, 1);
  assert.deepEqual(contents.summary.orphan_source_ids, []);
});

test('without --write-index: no index file is written and indexWritten is null', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-600000-001\n');
  fx.write('packages/foo/index.test.js', "test('F-600000-001 stays fixed', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.indexWritten, null, '--write-index is opt-in; default must NOT write a file');
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAllowlist / applyAllowlist — defensive contract
// ─────────────────────────────────────────────────────────────────────────────

test('loadAllowlist: missing file returns empty allow', () => {
  const empty = loadAllowlist(join(tmpdir(), `does-not-exist-${Date.now()}.json`));
  assert.deepEqual(empty, { allow: {} });
});

test('loadAllowlist: malformed JSON throws a helpful error', (t) => {
  const fx = makeFixture(t);
  fx.write('bad.json', '{ not valid json');
  assert.throws(
    () => loadAllowlist(join(fx.dir, 'bad.json')),
    /not valid JSON/,
  );
});

test('loadAllowlist: missing "allow" field throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-allow.json', JSON.stringify({ description: 'I forgot the allow key' }));
  assert.throws(
    () => loadAllowlist(join(fx.dir, 'no-allow.json')),
    /missing required "allow" field/,
  );
});

test('loadAllowlist: entry without reason throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-reason.json', JSON.stringify({ allow: { 'F-100000-001': {} } }));
  assert.throws(
    () => loadAllowlist(join(fx.dir, 'no-reason.json')),
    /missing "reason"/,
  );
});

test('applyAllowlist: pure function over a parsed json shape', () => {
  const json = {
    source_pins: { 'F-100000-001': ['/x/a.js'], 'F-200000-002': ['/x/b.js'] },
    test_pins: {},
    files_scanned: 2,
    summary: {
      source_ids: 2,
      test_ids: 0,
      orphan_source_ids: ['F-100000-001', 'F-200000-002'],
    },
  };
  const allowlist = { allow: { 'F-100000-001': { reason: 'ok' } } };
  const out = applyAllowlist(json, allowlist);
  assert.deepEqual(out.orphansAfterAllowlist, ['F-200000-002']);
  assert.deepEqual(out.applied, ['F-100000-001']);
  assert.deepEqual(out.unusedAllowEntries, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatHuman — sanity-check the user-facing output
// ─────────────────────────────────────────────────────────────────────────────

test('formatHuman: includes orphan list when there are orphans', () => {
  const result = {
    ok: false,
    json: {
      source_pins: { 'F-700000-001': ['/repo/packages/foo/index.js'] },
      test_pins: {},
      files_scanned: 1,
      summary: { source_ids: 1, test_ids: 0, orphan_source_ids: ['F-700000-001'] },
    },
    orphans: ['F-700000-001'],
    allowlistApplied: [],
    unusedAllowEntries: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /FAIL/);
  assert.match(text, /F-700000-001/);
  assert.match(text, /How to fix/);
});

test('formatHuman: marks the live tree as OK when there are no orphans', () => {
  const result = {
    ok: true,
    json: { source_pins: {}, test_pins: {}, files_scanned: 0, summary: { source_ids: 0, test_ids: 0, orphan_source_ids: [] } },
    orphans: [],
    allowlistApplied: [],
    unusedAllowEntries: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /OK/);
  assert.match(text, /Class #14 invariant holds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Live-tree assertion — the load-bearing test
//
// F-f0339e12 (2026-07-15): when the structural test-pin filter landed, this
// test went deliberately red for one wave — the filter surfaced 8 ids whose
// only test-side evidence was a narrative mention. All 8 were disposed the
// same day by coordinator direction (3 allowlisted with documented adjacent-
// coverage reasons, 2 section banners reworded id-first, 2 covered by the
// unrolled per-id asserts in the F-5eafee44 test above, 1 given a dedicated
// structural test in stageC-check-ingest-stale-index-warn.test.mjs), and
// this assertion returned to its normal green contract. Full per-id detail:
// the ci-tooling wave-8 amend output and scripts/regression-pin-allowlist.json.
// ─────────────────────────────────────────────────────────────────────────────

test('live testing-os tree passes the regression-pin gate', async () => {
  const result = await runRegressionPinGate({ repoRoot });
  if (!result.ok) {
    const detail = result.orphans
      .map((id) => {
        const files = result.json.source_pins[id] ?? [];
        return `  ${id}\n    ${files.join('\n    ')}`;
      })
      .join('\n');
    assert.fail(
      `regression-pin gate FAIL on live tree: ${result.orphans.length} orphan(s):\n${detail}\n\nFix: add a test pin (preferred) OR add an allowlist entry in scripts/regression-pin-allowlist.json with a reason.`,
    );
  }
  assert.equal(result.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// F-W1-CI-006 — ESM main-entry guard: only run main() when invoked as a
// script, not when imported by tests. Previous heuristic used a hand-built
// `file://${process.argv[1]}` plus an `endsWith` fallback; both fail on
// Windows because process.argv[1] uses backslashes while import.meta.url is
// always POSIX/URL form. `pathToFileURL(process.argv[1]).href` is the
// canonical Node cross-platform pattern (matches apply-finding-migration.mjs's
// W31-BACK-001 fix).
// ─────────────────────────────────────────────────────────────────────────────

test('F-W1-CI-006: main-entry guard uses pathToFileURL(process.argv[1]).href === import.meta.url, not a file://+endsWith fallback', () => {
  const src = readFileSync(resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs'), 'utf8');
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped
    .split(/\r?\n/)
    .find((l) => /^\s*const isMain\s*=/.test(l));
  assert.ok(guardLine, 'expected a `const isMain = ...` line in check-finding-regression-pins.mjs — pin is stale');
  assert.match(
    guardLine,
    /process\.argv\[1\]\s*&&/,
    'main-entry guard must short-circuit on `process.argv[1] &&`',
  );
  assert.match(
    guardLine,
    /pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url/,
    'main-entry guard must compare pathToFileURL(process.argv[1]).href against import.meta.url, not a hand-built file:// string or an endsWith fallback (F-W1-CI-006)',
  );
  assert.doesNotMatch(
    guardLine,
    /endsWith|`file:\/\/\$\{/,
    'main-entry guard must not revert to the file://${process.argv[1]} + endsWith fallback — process.argv[1] uses backslashes on Windows while import.meta.url is always POSIX/URL form (F-W1-CI-006)',
  );
});

test('F-W1-CI-006: --help invokes the main-entry block (proves isMain fires on a real script invocation), prints Usage, exits 0', () => {
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `--help must exit 0 (proves the main-entry block ran).\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage:/, '--help must print the Usage block, proving isMain fired');
});

// ─────────────────────────────────────────────────────────────────────────────
// F-c59bb518: F-893adcd1 (wave 4) fixed the module docstring to stop
// re-describing the id-shape contract and point at parse-regression-pins.js's
// F_ID_PATTERN instead — but printHelp() is a second, independently-live
// surface that still claimed (verbatim) the gate only recognizes the legacy
// 'F-NNNNNN-NNN' shape. Same narrower-than-reality claim F-893adcd1 was filed
// to eliminate, one surface over — verified live via `--help` below, the
// same subprocess pattern the F-W1-CI-006 test above already uses.
// ─────────────────────────────────────────────────────────────────────────────

test('F-c59bb518: --help describes the F_ID_PATTERN contract (legacy + hash-style), not just the legacy F-NNNNNN-NNN shape', () => {
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `--help must exit 0.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`);
  assert.match(result.stdout, /F-NNNNNN-NNN/, '--help must still mention the legacy id shape');
  assert.match(
    result.stdout,
    /F-xxxxxxxx/,
    '--help must also mention the hash-style id shape — F-3ec5b54f widened F_ID_PATTERN to include it, but ' +
      '--help previously described only the legacy shape as if it were the whole contract',
  );
  assert.match(
    result.stdout,
    /F_ID_PATTERN/,
    '--help should point at F_ID_PATTERN by name (like the module docstring already does) so the two ' +
      'descriptions cannot independently go stale again the next time the pattern is widened',
  );
});
