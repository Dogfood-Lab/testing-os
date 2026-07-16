#!/usr/bin/env node
/**
 * check-finding-regression-pins.mjs — always-on CI gate for Class #14
 * (claimed-fixed without verification).
 *
 * Consumes the parser at packages/portfolio/lib/parse-regression-pins.js to
 * scan the repo for finding-id pins, then asserts the asymmetric invariant
 * the gate cares about: every F-id pinned in source has at least one F-id
 * pin in a test file. Test-only pins are NOT a failure — a test that
 * documents a regression whose source reference has been refactored away
 * still earns its keep.
 *
 * F-893adcd1: the exact id shape and the scanned file extensions are NOT
 * re-described here — they live in parse-regression-pins.js's F_ID_PATTERN
 * JSDoc (three unioned formats: legacy F-NNNNNN-NNN, hash F-xxxxxxxx,
 * prefixed F-AAA-NNN) and its DEFAULT_SOURCE_EXTENSIONS (.js/.mjs/.cjs/
 * .ts/.tsx/.jsx plus .yml/.yaml, with a .github carve-out — see
 * DOT_DIR_SCAN_ALLOWLIST). This docstring previously hard-coded only the
 * legacy `F-NNNNNN-NNN` shape and went stale the moment F-3ec5b54f /
 * F-5eafee44 widened the pattern in that other file — pointing at the file
 * that actually DEFINES the contract, instead of re-stating it, means this
 * wrapper's docstring cannot drift from it again the next time it's widened.
 *
 * Companion to FT-BACKEND-002 (`swarm verify-fixed` runtime check). This
 * commit-time gate runs in CI on every push; the runtime check runs after
 * a swarm declares a fix is in.
 *
 * Allowlist:
 *   scripts/regression-pin-allowlist.json captures the legitimate prose-
 *   reference cases (an F-id mentioned in source as a cross-reference,
 *   not as a fix pin). The parser is intentionally permissive about
 *   prose vs pin (see parse-regression-pins.js JSDoc); the allowlist is
 *   how this gate disambiguates.
 *
 * Exit codes:
 *   0 — no orphan source pins (after allowlist filter)
 *   1 — at least one orphan source pin (Class #14 violation)
 *   2 — internal error (parser threw, allowlist malformed, etc.)
 *
 * Usage:
 *   node scripts/check-finding-regression-pins.mjs
 *   node scripts/check-finding-regression-pins.mjs --json
 *   node scripts/check-finding-regression-pins.mjs --write-index docs/regression-pin-index.json
 *   node scripts/check-finding-regression-pins.mjs --root <dir>     # alternate scan root (tests)
 *   node scripts/check-finding-regression-pins.mjs --allowlist <path>
 *
 * Programmatic API:
 *   import { runRegressionPinGate } from './check-finding-regression-pins.mjs';
 *   const result = await runRegressionPinGate({ repoRoot, allowlistPath, writeIndexPath });
 *   // result = { ok: boolean, json, orphans, allowlistApplied, indexWritten }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseRegressionPins,
  toJSON,
  F_ID_PATTERN,
} from '../packages/portfolio/lib/parse-regression-pins.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, '..');
const defaultAllowlistPath = resolve(here, 'regression-pin-allowlist.json');

/**
 * F-f0339e12: structural test-pin filter.
 *
 * PROBLEM (full mutation-probe writeup lives in the finding): the parser
 * this file consumes (parse-regression-pins.js) buckets a file into
 * source_pins/test_pins via a single whole-file-text regex sweep —
 * extractPinsFromText() has zero requirement that a mention of an F-id in a
 * file classifyFile() calls "test" have any structural relationship to a
 * real check. A narrative cross-reference in an UNRELATED test's comment
 * ("unlike F-deadbeef's approach...") cleared Class #14 for F-deadbeef
 * exactly as if a dedicated regression test existed. This already happened
 * for real: a wave-6 comment narrating F-893adcd1's history inside
 * F-c59bb518's test explanation made the still-genuinely-uncovered
 * F-893adcd1 pin (this file's own docstring, line ~13) look newly test-
 * pinned, surfacing only as a "stale allowlist entry" WARN that a reader
 * could reasonably (and wrongly) read as "safe to delete."
 *
 * FIX: a test-side textual mention only counts as a structural pin if it
 * carries one of four cheap, line-local signals — each an ALREADY-OBSERVED
 * convention in this repo's own test files, not an invented rule:
 *
 *   1. LEADING COMMENT — the id is the first token of a `//`/`*`/`#`/`-`
 *      comment or list-item line (after stripping that decoration), e.g.
 *      `// F-893adcd1 — the actual fix reason` or the JSDoc continuation
 *      `*   F-375053-005  schema.js STATUS.run enum…`. This is the exact
 *      "leading-comment line" form parse-regression-pins.test.js's own
 *      docstring documents as canonical. F-ec9622fd: this stays placement-
 *      only, unlike rule 2 below — see WHAT STILL SLIPS THROUGH for why.
 *      F-f37bb9ae: the decoration match must be a genuine comment opener
 *      ('//' or '/*'), never a bare regex-literal '/' delimiter — see WHAT
 *      STILL SLIPS THROUGH for the evasion this closes.
 *   2. TEST TITLE — the id sits inside the quoted title argument of a
 *      test()/it()/describe() call, e.g. `describe('guard (F-100000-001)',
 *      …)` or `test('F-W1-CI-006: main-entry guard …', …)`. The other
 *      canonical form from the same docstring. F-ec9622fd: placement in the
 *      title alone is not enough — the call's own body (from the title line
 *      through the line where the call closes, tracked by paren/brace
 *      depth over comment/string-masked text) must ALSO contain an
 *      `assert`/`expect(` call somewhere, mirroring rule 4's bar. This
 *      closes the titled-but-genuinely-empty-callback shape outright
 *      (mutation-probe: `test('F-NNNNNN-NNN: unrelated smoke test', () =>
 *      {})` with no assert anywhere in the body now earns no credit —
 *      deliberately the same non-matching F-NNNNNN-NNN placeholder rule 4
 *      uses below, not a real tracked id, for the same reason: a real id
 *      here would make this docstring's own coverage depend on the
 *      mutation-probe example never changing shape). It does NOT verify the
 *      assertion is semantically ABOUT the id — see WHAT STILL SLIPS
 *      THROUGH.
 *   3. SELF-REFERENCING FILE HEADER — the id is the first F-id mentioned on
 *      a line that ALSO names this file's own basename, within the file's
 *      first 20 lines, e.g. `verify-fixed.test.js — F-252713-002 (Phase 7
 *      wave 1, FT-BACKEND-002)`. A file citing its own name before an id in
 *      its opening docblock is CLAIMING "this file is the regression
 *      coverage for that id" — categorically different from a stray
 *      cross-reference deep inside an unrelated file. F-ec9622fd: that is
 *      the file's CLAIM, not a fact this rule verifies — see WHAT STILL
 *      SLIPS THROUGH for why it stays placement-only (sufficient on its
 *      own), same as rule 1.
 *   4. SAME-LINE ASSERT ARGUMENT — the id appears anywhere on a line that
 *      also contains `assert` or `expect(`, e.g. an assertion message that
 *      names the id it proves (`assert.doesNotMatch(a, /F-NNNNNN-NNN/,
 *      'domain leaked F-NNNNNN-NNN')`) or an id passed straight into an
 *      assert argument (`assert.deepEqual('F-NNNNNN-NNN'.match(…), […])`).
 *      An id sharing a line with the check that exercises it is the thing
 *      being tested, not prose about it. (Deliberately illustrated with
 *      the non-matching F-NNNNNN-NNN placeholder, not a real tracked id —
 *      a real id here would make THIS docstring's own coverage depend on
 *      an unrelated file in another domain never refactoring it away.)
 *      F-c7927c58: excludes a same-line test()/it()/describe( call's own
 *      quoted TITLE span before matching — see WHAT STILL SLIPS THROUGH.
 *
 * Each signal is deliberately LINE-LOCAL, never a multi-line proximity
 * window. A window-based "within N lines of an assert" heuristic was
 * prototyped and rejected: it let the real F-893adcd1 false positive back
 * in whenever an unrelated assert happened to fall within the window
 * (common in dense test files), which defeats the fix — the mutation-probe
 * case is exactly a comment that sits physically near real assert calls
 * without being structurally CONNECTED to any of them.
 *
 * WHAT STILL SLIPS THROUGH (documented, not silently over-fit — matching
 * this repo's own "cheapest honest structure, not perfect precision"
 * standard elsewhere, e.g. F_ID_PATTERN's own "known accepted false
 * positive" paragraph):
 *   - Multi-line arrange-then-assert: ids collected into an array/variable
 *     several lines before the assert that consumes it (e.g.
 *     `const ids = ['F-…', …]; …; assert.deepEqual(missing, [], …)`) are
 *     NOT recognized — tracing a variable to its consuming assert is
 *     dataflow analysis, not a cheap line-local check. The live instance
 *     that proved this (the 12-workflow-pins test in this gate's own test
 *     file) was unrolled into per-id asserts at the wave-8 disposition;
 *     the class remains for any future array-arranged ids.
 *   - Section-header banner comments where the target id is NOT the first
 *     F-id token on the line (e.g. `// widget handler (D-CI-001 /
 *     F-NNNNNN-NNN, wave N)` — a non-F-id label precedes it, so rule 1
 *     doesn't fire, and rule 3 requires the file's own basename, which a
 *     mid-file section banner has no reason to contain). The two live
 *     instances of this shape were reworded id-first at the wave-8
 *     disposition; the class remains for future banners.
 *   - A same-line trailing comment that mentions an unrelated id on a line
 *     which also happens to contain a genuine (unrelated) assert/expect
 *     call would still count under rule 4 — same-line is a far smaller
 *     surface than a proximity window, but it is not zero.
 *   - F-ec9622fd: rule 2's new body-assert requirement (above) does not
 *     verify the assertion is semantically ABOUT the id — a titled test
 *     whose body contains an unrelated assertion (e.g. a coincidental
 *     `assert.equal(1+1,2)` smoke-check) still earns 'title' credit. Same
 *     "cheap, not exhaustive" tradeoff rule 4 already accepts for its own
 *     same-line case; proving semantic relevance is dataflow/intent
 *     analysis, the same category of check the rejected proximity window
 *     (above) already ruled out as too expensive for a line-local
 *     heuristic. Rule 2 proves a real test BODY sits behind the pin, not
 *     that the body is ABOUT the pin.
 *   - F-ec9622fd: rule 2's call-body scan (enclosingCallHasAssertBody) masks
 *     comment and quoted/template-string content before counting brackets
 *     (STRUCTURAL_MASK_PATTERN) — so punctuation inside a title's own prose
 *     ("(edge case)") or a body string cannot miscount as a real bracket
 *     boundary — but does NOT mask regex literals. F-16275dfd: the depth
 *     loop is now escape-aware (a `\` consumes the next character without
 *     counting it as a bracket, mirroring check-doc-drift.mjs's
 *     countCommandMapEntries regex-skip: `if (src[i] === '\\') { i += 2;
 *     continue; }`), closing the proven trigger — an UNBALANCED count of
 *     BACKSLASH-ESCAPED brackets within one regex literal (e.g. the
 *     trailing-paren-stripping pattern `/a\)b\)c/`, two escaped closes and
 *     zero escaped opens) could collapse depth to zero mid-regex and close
 *     the scanned span on the wrong line, causing TOTAL loss of structural
 *     credit for a genuinely-covered id whenever its title and real assert
 *     sit on different lines — not merely an early-or-late close, as this
 *     paragraph previously framed it. (This paragraph's prior worked
 *     example, `/\(fixme\)/`, has a BALANCED escaped-bracket count and was
 *     never actually reproducible — equal escaped opens and closes cancel
 *     out regardless of escape-awareness.)
 *   - F-f37bb9ae: the previous version of THIS paragraph claimed an
 *     UNESCAPED literal bracket inside a character class (e.g. `/[(]/`)
 *     "still fails closed, same as before." THAT CLAIM WAS FALSE for the
 *     open-bracket sub-case — a docstring overclaiming a false-positive-
 *     safe residual that was actually a false-grant residual is a Class #14
 *     violation one level up, the same failure mode this whole gate exists
 *     to catch elsewhere. Proof: `test('F-id: unrelated smoke test', () =>
 *     { const re = /[(]/; doSomethingHarmless(); }); test('a different
 *     test', () => { assert.ok(true); });` — pre-fix, the class's unescaped
 *     '(' INFLATED depth instead of being ignored, so the scan never
 *     reached <=0 at the first call's true '});' and leaked into the
 *     second, unrelated test, crediting the first id with the second
 *     test's assert. An unescaped CLOSE bracket in a class (`/[)]/`) has
 *     the opposite, safe-direction bug — it DEFLATES depth, which only
 *     trips the closedAt branch early enough to matter once depth is down
 *     to its last level (needs two stray closes to cancel both the `test(`
 *     call's own paren and the block-bodied arrow's own '{', matching why
 *     F-16275dfd's own repro needed two escaped closes) — that sub-case
 *     really did fail closed as claimed, under-crediting a genuinely-
 *     covered id into a visible orphan. FIX: track an `inClass` boolean in
 *     the same escape-aware loop — true on an unmasked '[', false on ']' —
 *     and suppress the '(' / '{' / ')' / '}' depth adjustment entirely
 *     while inClass is true, mirroring check-doc-drift.mjs:1180-1185's own
 *     `if (src[i] === '[') inClass = true; else if (src[i] === ']')
 *     inClass = false;` disambiguation (the file this module's escape
 *     handling already cited as its model). This closes BOTH directions at
 *     once — the dangerous false-grant and the merely inconvenient
 *     under-credit — because both stemmed from the same missing
 *     distinction. Still not attempted, for the same "no heavyweight parser
 *     dependency" reason countCommandMapEntries's own docstring gives:
 *     recognizing when a regex literal's PATTERN TEXT — not a bracket, just
 *     ordinary characters — happens to spell "assert" or "expect(" verbatim
 *     (e.g. `const re = /assert/;`, or `/expect(x)/` as a real, unescaped
 *     capture group). STRUCTURAL_ASSERT_LINE.test() runs against the same
 *     regex-literal-inclusive text the depth scan uses, and a regex whose
 *     SOURCE spells those words (not its match target — the pattern's own
 *     characters) satisfies the assert/expect check with zero real
 *     assertion anywhere in the body. Distinguishing "text that names an
 *     assert-like word" from "text that is inside a regex literal" needs
 *     exactly the tokenizer this file keeps declining to add. Confirmed NOT
 *     currently live in the corpus (grepped every test file for a regex
 *     literal whose pattern body contains "assert" or "expect(" as literal,
 *     non-argument text — zero matches) — a proven mechanism, not a
 *     currently-red gate, same evidentiary posture F-f37bb9ae and
 *     F-16275dfd themselves were disposed under. Pinned by a mutation-probe
 *     test (search the test file for "regex PATTERN TEXT") so a future wave
 *     inherits a reproduction instead of rediscovering it from scratch.
 *   - F-c7927c58: rule 4 (isSameLineAssertArgumentPin) deliberately tests
 *     the RAW, unmasked line — masking would break its designed ability to
 *     find an id living inside a real assertion-message string (e.g.
 *     `assert.doesNotMatch(a, /F-id/, 'domain-a leaked F-id')`). But
 *     unmasked also meant it could not tell a REAL assert/expect() call
 *     from the bare English word "assert" or literal "expect(" text
 *     appearing anywhere on the line — including inside the id's own test
 *     TITLE (`test('F-id: should not assert when input is valid', () => {
 *     doSomethingWithNoAssertion(); });` or a title reading 'does not call
 *     expect() directly'), silently overriding rule 2's correct empty-body
 *     denial on the exact same line. FIX: maskTestTitleSpan blanks out
 *     (length-preserving) just the quoted title span of a test()/it()/
 *     describe( call opening on the line, if any, before rule 4 runs its
 *     pattern test AND its id-membership check — narrower than masking the
 *     whole line (a real assert/expect call elsewhere on the same physical
 *     line, before or after an empty-titled call, still earns credit
 *     correctly — see the mixed-line mutation-probe test) and narrower
 *     than masking every quoted string (which would blind rule 4 to its
 *     own reason for existing). The title is the one span that is
 *     structurally never a legitimate rule-4 pin site — rule 2 is its sole
 *     authority — so excluding exactly that span, and nothing else, closes
 *     the gap without trading away the canonical case.
 *   - F-f37bb9ae (audit sweep): auditing rules 1 and 3 for the same
 *     "unmasked text plus a regex literal" evasion class found one real
 *     instance, in rule 1. STRUCTURAL_COMMENT_DECORATION's `[/*#-]+`
 *     character class cannot distinguish a real comment opener ('//' or
 *     '/*') from a regex literal's own lone '/' delimiter, so a line that
 *     is really a regex-literal statement testing an id shape (e.g.
 *     `/F-NNNNNN-NNN/.test(candidate);` — an ordinary thing to write in a
 *     repo whose own job is id-pattern matching) was mistaken for a
 *     decorated comment line and credited on placement alone. FIX:
 *     isLeadingCommentPin now rejects a decoration match whose non-
 *     whitespace content is nothing but a lone '/' — real comment openers
 *     are always '//' or '/*' (two characters), so this only ever excludes
 *     the ambiguous case, never a genuine comment. Rule 3 (self-header) was
 *     audited for the same class and found NOT to share the mechanism: it
 *     never runs an assert/expect pattern test or a bracket-depth scan, and
 *     the only unmasked text it inspects is whether the file's own
 *     basename literally appears before the id — a regex literal would
 *     have to spell out the file's own name AND an F-id-shaped substring,
 *     in that order, inside the first 20 lines, to matter at all, which is
 *     not a plausible accidental shape (unlike rule 1's single-character
 *     delimiter collision or rule 4's common-English-word collision). No
 *     change made to rule 3 this wave; if that conclusion is ever
 *     overturned, it belongs here, not silently re-derived.
 *   - Rule 2's call-body scan is bounded (STRUCTURAL_TITLE_BODY_LINE_LIMIT
 *     lines) and fails CLOSED past that bound (treated as "no body found",
 *     never a false grant) — an unproven pin surfaces as a visible orphan a
 *     human must resolve, not a silent miscount.
 *   - F-ec9622fd: rules 1 (leading-comment) and 3 (self-header) are still
 *     placement-only in the broader sense — neither requires the file to
 *     contain any test structure related to (or even near) the id; a
 *     comment that is merely the leading token of a line, or a header that
 *     names the file's own basename before the id, earns credit purely
 *     from where the text sits (F-f37bb9ae's rule-1 fix above closes one
 *     narrow regex-delimiter ambiguity WITHIN this same placement-only
 *     design — it does not change the design itself). Both are
 *     mutation-probe-gameable this way (a leading-comment floating
 *     in a file with no test/describe block anywhere near it; a self-
 *     referencing header on an otherwise-unrelated file). Rule 2 closed its
 *     version of this gap by requiring a body-level assert (above); rules 1
 *     and 3 were deliberately NOT given the same treatment this wave,
 *     because tightening either provably orphans real live pins rather than
 *     just closing a theoretical one: an "immediately above a
 *     test()/it()/describe( call" requirement for rule 1 collides with this
 *     repo's own pervasive banner-comment convention (a `// ═══ / F-id —
 *     description / ═══` block separated from its describe() by a blank
 *     line, e.g. wave10-docs-identity-drift.test.js:203) — confirmed live,
 *     ~52 ids depend on rule 1 alone today — and downgrading rule 3 to
 *     "supplementary only" immediately orphans multiple live ids (including
 *     F-252713-002, this docstring's OWN rule-3 example two paragraphs up)
 *     whose ONLY structural signal across their whole test file is a
 *     dedicated file's self-header, with real describe/it/assert structure
 *     that never repeats the id inside a title, leading comment, or
 *     same-line assert. Both were measured empirically against the live
 *     tree before this call was made (see the wave-10 ci-tooling amend
 *     output). The gap stays open and documented here rather than silently
 *     traded for a proven regression across files this domain does not own.
 *
 * These are line-based heuristics over the SAME already-classified test
 * files the parser walks — no new file walk, no parser edit. Deliberately
 * reads F_ID_PATTERN from parse-regression-pins.js (not a hand-rolled
 * copy) so the id-shape contract still lives in exactly one place.
 */

const STRUCTURAL_COMMENT_DECORATION = /^\s*(?:[/*#-]+\s*)+/;
const STRUCTURAL_TEST_TITLE = /\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*(['"`])((?:(?!\1).)*?)\1/;
const STRUCTURAL_ASSERT_LINE = /\bassert\b|\bexpect\s*\(/;
const STRUCTURAL_HEADER_LINE_LIMIT = 20;
// F-ec9622fd: safety bound on rule 2's call-body scan (below) — a real
// test/it/describe body is rarely more than a few dozen lines; this only
// exists so a pathological (or unbalanced-brace) file can't turn one title
// hit into an unbounded scan. Falling back to "body not found" at the bound
// is the same "no body connection found" outcome as a genuinely empty body,
// so hitting it just means the id gets no title credit — never a crash or a
// false grant.
const STRUCTURAL_TITLE_BODY_LINE_LIMIT = 400;
// F-ec9622fd: blanks out comment and quoted/template-string content
// (length-preserving, so column positions elsewhere on a line stay valid)
// before rule 2's call-body scan counts brackets — punctuation inside a
// title's own prose ("(edge case)") or a body string must never miscount as
// a real bracket boundary. Regex literals are deliberately NOT masked
// (distinguishing a regex-opening '/' from a division operator needs a real
// tokenizer) — see WHAT STILL SLIPS THROUGH in the module docstring above.
const STRUCTURAL_MASK_PATTERN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function maskCommentsAndStrings(s) {
  return s.replace(STRUCTURAL_MASK_PATTERN, (m) => ' '.repeat(m.length));
}

/**
 * F-f37bb9ae (audit sweep): a decoration match whose non-whitespace content
 * is nothing but a lone '/' is a regex literal's own delimiter, not a real
 * comment opener ('//' or '/*') — STRUCTURAL_COMMENT_DECORATION's `[/*#-]+`
 * character class cannot otherwise tell them apart, so a line that is
 * really a regex-literal statement (e.g. `/F-NNNNNN-NNN/.test(x);` — an
 * ordinary shape in a repo whose own job is id-pattern matching) would
 * otherwise be mistaken for a decorated comment line and credited on
 * placement alone. Real comment openers are always two characters ('//' or
 * '/*'), so this guard only ever excludes the ambiguous single-slash case,
 * never a genuine comment. Left unstripped, the ambiguous line correctly
 * fails the startsWith(id) check below (it starts with '/', not the id).
 *
 * @param {string} line
 * @param {string} id
 * @returns {boolean}
 */
function isLeadingCommentPin(line, id) {
  const m = STRUCTURAL_COMMENT_DECORATION.exec(line);
  if (m && m[0].replace(/\s/g, '') === '/') return false;
  return line.replace(STRUCTURAL_COMMENT_DECORATION, '').startsWith(id);
}

/**
 * F-ec9622fd: locate a test()/it()/describe( call starting on `line`,
 * returning its title text and the column of its OWN opening '(' — derived
 * from the regex match itself (m.index + the first '(' inside the match),
 * never a blind line-wide search, which would find an EARLIER, unrelated
 * '(' when some other call precedes the test/it/describe token on the same
 * line (e.g. `if (x) { test('F-id: …', …); }`) and close the "body" at that
 * unrelated paren instead.
 *
 * @param {string} line
 * @returns {{ title: string, openParenCol: number } | null}
 */
function matchTestCallStart(line) {
  const m = STRUCTURAL_TEST_TITLE.exec(line);
  if (!m) return null;
  // F-c7927c58: the overall match ends exactly at the title's closing quote
  // (the pattern's last token is `\1`, the backreference to the opening
  // quote), so the quoted span's column range derives from m[0].length and
  // m[2].length alone — no `d`-flag match-indices needed. Exposed so
  // maskTestTitleSpan below reuses this file's one parser of "where does
  // this call's title text live" instead of re-deriving it.
  const titleEnd = m.index + m[0].length;
  const titleStart = titleEnd - m[2].length - 2; // opening quote + title text + closing quote
  return { title: m[2], openParenCol: m.index + m[0].indexOf('('), titleStart, titleEnd };
}

/**
 * F-ec9622fd: whether the test/it/describe call opening at
 * lines[callLineIndex][openParenCol] has an assert/expect() call anywhere in
 * its OWN body — tracked by combined paren/brace depth from that '(' back to
 * zero, over text with comments and strings masked first (maskCommentsAndStrings)
 * so their content cannot corrupt the count (mutation-probe proof: pre-fix,
 * the title rule granted credit on TEXTUAL PLACEMENT alone — `test('F-NNNNNN-NNN:
 * unrelated smoke test', () => {})` with a genuinely EMPTY callback earned
 * full 'title' credit with zero requirement that the body relate to the id).
 * Mirrors rule 4's own same-line assert bar, widened from "this line" to
 * "this call's true (bracket-balanced) extent." Bounded by
 * STRUCTURAL_TITLE_BODY_LINE_LIMIT lines; failing to find the closing paren
 * within the bound is treated as "no body found" — fail closed, same as a
 * genuinely empty body, never a false grant. It does NOT verify the
 * assertion is semantically about the id — see WHAT STILL SLIPS THROUGH.
 *
 * @param {string[]} lines
 * @param {number} callLineIndex
 * @param {number} openParenCol
 * @returns {boolean}
 */
function enclosingCallHasAssertBody(lines, callLineIndex, openParenCol) {
  let depth = 0;
  // F-f37bb9ae: true while the scan is inside a regex character class
  // ([...]) — declared once and persisted across lines exactly like
  // `depth` above (never reset per line). A multi-line array/destructure/
  // computed-access can legitimately span lines and this stays safe either
  // way (their bracket contents are inherently balanced in valid JS —
  // suppressing a balanced pair changes no net depth); a regex literal
  // never spans lines in valid JS, so persistence costs nothing for the
  // actual risk case either.
  let inClass = false;
  const lastLine = Math.min(lines.length - 1, callLineIndex + STRUCTURAL_TITLE_BODY_LINE_LIMIT);
  for (let i = callLineIndex; i <= lastLine; i++) {
    const raw = i === callLineIndex ? lines[i].slice(openParenCol) : lines[i];
    const masked = maskCommentsAndStrings(raw);
    let closedAt = -1;
    for (let c = 0; c < masked.length; c++) {
      const ch = masked[c];
      // F-16275dfd: a backslash-escaped character is never a real bracket
      // boundary — mirrors check-doc-drift.mjs's countCommandMapEntries
      // regex-skip escape handling (`if (src[i] === '\\') { i += 2;
      // continue; }`). Comments/strings are already masked above, so the
      // only place a raw '\' can still reach this loop is inside an
      // unmasked regex literal (STRUCTURAL_MASK_PATTERN deliberately does
      // not mask those — see the module docstring); an escaped bracket
      // there (e.g. the trailing-paren-stripping pattern `/a\)b\)c/`) is a
      // literal character, not a group boundary, and must not perturb
      // depth. `c++` here plus the loop's own increment consumes both
      // characters of the escape pair, same "advance by 2" effect as the
      // sibling's `i += 2`.
      if (ch === '\\') { c++; continue; }
      // F-f37bb9ae: an UNESCAPED '[' opens a regex character class, where
      // '(' '{' ')' '}' are literal characters to match, never group or
      // quantifier boundaries (e.g. the docstring's own worked example
      // `/[(]/`). Mirrors check-doc-drift.mjs:1180-1185's `if (src[i] ===
      // '[') inClass = true; else if (src[i] === ']') inClass = false;` —
      // the same disambiguation this file's escape handling above already
      // cites as its model. Pre-fix, an unescaped OPEN bracket in a class
      // INFLATED depth (delaying closure past the call's true end and
      // leaking the scan into a later, unrelated call — a false grant)
      // while an unescaped CLOSE bracket DEFLATED it (closing early and
      // denying a genuinely-covered id — an under-credit); suppressing all
      // four bracket characters while inClass closes both directions at
      // once, not just the dangerous one.
      if (ch === '[') { inClass = true; continue; }
      if (ch === ']') { inClass = false; continue; }
      if (inClass) continue;
      if (ch === '(' || ch === '{') depth++;
      else if (ch === ')' || ch === '}') {
        depth--;
        if (depth <= 0) { closedAt = c; break; }
      }
    }
    const active = closedAt === -1 ? masked : masked.slice(0, closedAt + 1);
    if (STRUCTURAL_ASSERT_LINE.test(active)) return true;
    if (closedAt !== -1) return false;
  }
  return false;
}

/**
 * F-ec9622fd: a title match alone is textual placement, not proof the test
 * does anything — additionally require the enclosing call's own body to
 * contain an assert/expect call somewhere (enclosingCallHasAssertBody). This
 * closes the "titled but genuinely empty callback" shape from the
 * mutation-probe outright.
 *
 * @param {string[]} lines
 * @param {number} lineIndex
 * @param {string} id
 * @returns {boolean}
 */
function isTestTitlePin(lines, lineIndex, id) {
  const call = matchTestCallStart(lines[lineIndex]);
  if (!call || !call.title.includes(id)) return false;
  return enclosingCallHasAssertBody(lines, lineIndex, call.openParenCol);
}

function isSelfReferencingHeaderPin(line, id, fileBasename, lineIndex) {
  if (lineIndex >= STRUCTURAL_HEADER_LINE_LIMIT) return false;
  const idPos = line.indexOf(id);
  if (idPos === -1) return false;
  const basePos = line.indexOf(fileBasename);
  if (basePos === -1 || basePos >= idPos) return false;
  // The id at idPos must be the FIRST F-id match on the line — a different,
  // earlier id (the real F-893adcd1 shape: "F-c59bb518: F-893adcd1 …")
  // disqualifies it, same reasoning as the leading-comment rule.
  F_ID_PATTERN.lastIndex = 0;
  let m;
  while ((m = F_ID_PATTERN.exec(line))) {
    if (m.index < idPos) return false;
    if (m.index === idPos) break;
  }
  return true;
}

/**
 * F-c7927c58: blank out the quoted TITLE argument of a test()/it()/describe(
 * call opening on `line` (length-preserving, like maskCommentsAndStrings),
 * before rule 4's raw-line pattern test. Rule 4 deliberately does NOT mask
 * general string content — its whole purpose is finding an id living inside
 * a real assertion-message string (e.g. `assert.doesNotMatch(a, /F-id/,
 * 'domain-a leaked F-id')`) — but a test/it/describe TITLE is prose about
 * the test, never a pin site of its own; rule 2 (isTestTitlePin) is the
 * sole authority for title-borne credit, and unlike rule 4's bare text
 * match, it requires a real body-level assert. Without this, title prose
 * that spells 'assert' as an ordinary English word ('should not assert
 * when input is valid') or 'expect(' as if it were a call ('does not call
 * expect() directly') satisfies STRUCTURAL_ASSERT_LINE and silently
 * overrides rule 2's correct denial for a genuinely-empty callback body.
 * Only the quoted title span is masked, never the whole line — a real
 * assert/expect call elsewhere on the same physical line, before or after
 * an empty-titled call, still earns rule-4 credit correctly (see the
 * mixed-line mutation-probe test).
 *
 * @param {string} line
 * @returns {string}
 */
function maskTestTitleSpan(line) {
  const call = matchTestCallStart(line);
  if (!call) return line;
  return line.slice(0, call.titleStart) + ' '.repeat(call.titleEnd - call.titleStart) + line.slice(call.titleEnd);
}

/**
 * F-c7927c58: rule 4 runs against maskTestTitleSpan(line), not the raw
 * line — see that function's docstring for why. Both the assert/expect
 * pattern test and the id-membership check use the title-masked text, so
 * an id living ONLY inside a title (already correctly adjudicated by rule
 * 2) cannot piggyback on an unrelated real assert elsewhere on the same
 * physical line either — the same "cheap, line-local, no dataflow
 * analysis" bar the rest of this file holds itself to, applied to the one
 * span that is structurally never a legitimate rule-4 pin site.
 *
 * @param {string} line
 * @param {string} id
 * @returns {boolean}
 */
function isSameLineAssertArgumentPin(line, id) {
  const withoutTitle = maskTestTitleSpan(line);
  return STRUCTURAL_ASSERT_LINE.test(withoutTitle) && withoutTitle.includes(id);
}

/**
 * Classify every textual occurrence of `id` in `text` (a file already known
 * to contain at least one match) as structural or not, one record per
 * occurrence, so tests and diagnostics can see WHY, not just a boolean.
 *
 * @param {string} text
 * @param {string} id
 * @param {string} fileBasename - basename(file), for the self-header rule.
 * @returns {{ line: number, kind: 'leading-comment'|'title'|'self-header'|'assert-line'|'none' }[]}
 */
export function findStructuralPinHits(text, id, fileBasename) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(id)) continue;
    if (isTestTitlePin(lines, i, id)) hits.push({ line: i + 1, kind: 'title' });
    else if (isLeadingCommentPin(line, id)) hits.push({ line: i + 1, kind: 'leading-comment' });
    else if (isSelfReferencingHeaderPin(line, id, fileBasename, i)) hits.push({ line: i + 1, kind: 'self-header' });
    else if (isSameLineAssertArgumentPin(line, id)) hits.push({ line: i + 1, kind: 'assert-line' });
    else hits.push({ line: i + 1, kind: 'none' });
  }
  return hits;
}

/**
 * @param {string} text
 * @param {string} id
 * @param {string} fileBasename
 * @returns {boolean} true iff at least one occurrence of `id` in `text` carries
 *   a structural signal (see findStructuralPinHits).
 */
export function hasStructuralTestPin(text, id, fileBasename) {
  return findStructuralPinHits(text, id, fileBasename).some((h) => h.kind !== 'none');
}

/**
 * Re-derive the orphan list using STRUCTURAL test-pin evidence instead of
 * the parser's whole-file-text test_pins membership. Reads each test file
 * named in `json.test_pins` at most once, regardless of how many ids map
 * to it. Source-side extraction (`json.source_pins`) is never touched —
 * only which test-side mentions count as counter-evidence changes.
 *
 * @param {ReturnType<typeof toJSON>} json
 * @param {{ readFile?: (path: string) => string }} [opts] - injection point for tests.
 * @returns {{
 *   orphanSourceIds: string[],
 *   structuralTestIds: Set<string>,
 *   narrativeOnlyIds: string[],
 * }} `narrativeOnlyIds` — ids with a raw test_pins entry but NO structural
 *   signal anywhere: the exact "textually mentioned, not really pinned"
 *   set this fix exists to stop trusting.
 */
export function computeStructuralOrphans(json, { readFile = (p) => readFileSync(p, 'utf-8') } = {}) {
  const fileTextCache = new Map();
  const readCached = (file) => {
    if (fileTextCache.has(file)) return fileTextCache.get(file);
    let text = null;
    try {
      text = readFile(file);
    } catch {
      text = null;
    }
    fileTextCache.set(file, text);
    return text;
  };

  const structuralTestIds = new Set();
  const narrativeOnlyIds = [];
  for (const [id, files] of Object.entries(json.test_pins)) {
    let structural = false;
    for (const file of files) {
      const text = readCached(file);
      if (text === null) continue;
      if (hasStructuralTestPin(text, id, basename(file))) {
        structural = true;
        break;
      }
    }
    if (structural) structuralTestIds.add(id);
    else narrativeOnlyIds.push(id);
  }
  narrativeOnlyIds.sort();

  const orphanSourceIds = Object.keys(json.source_pins)
    .filter((id) => !structuralTestIds.has(id))
    .sort();

  return { orphanSourceIds, structuralTestIds, narrativeOnlyIds };
}

/**
 * Explain why a currently-unused allowlist entry no longer matches an
 * orphan — F-f0339e12's fix to the WARN wording. Before this fix, "unused"
 * could mean the dangerous case (a narrative-only mention got miscounted as
 * a real test pin, silently clearing the orphan without any real
 * coverage); computeStructuralOrphans makes that case structurally
 * unreachable here — a narrative-only id stays an orphan, so an
 * allowlisted one stays in `applied`, never `unused` (see the module
 * docstring above). Only two legitimate cases remain, and this function
 * distinguishes them so the WARN can no longer be misread as a uniform
 * "safe to delete" regardless of which reason applies.
 *
 * @param {string} id
 * @param {ReturnType<typeof toJSON>} json
 * @param {Set<string>} structuralTestIds
 * @returns {string}
 */
export function explainUnusedAllowEntry(id, json, structuralTestIds) {
  if (!(id in json.source_pins)) {
    return 'no longer appears as a source pin at all — safe to delete';
  }
  if (structuralTestIds.has(id)) {
    return 'now has a genuine structural test pin — safe to delete';
  }
  return 'reason undetermined (should be unreachable post-F-f0339e12 — investigate before deleting)';
}

/**
 * Load the allowlist JSON at `path`. Returns an object whose `allow` key is a
 * map from F-id to a reason record. Throws on malformed JSON or missing
 * `allow` field — better to fail loud than silently let an orphan through.
 *
 * @param {string} path
 * @returns {{ allow: Record<string, { reason: string, file?: string }> }}
 */
export function loadAllowlist(path) {
  if (!existsSync(path)) return { allow: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`regression-pin-allowlist at ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed.allow === undefined) {
    throw new Error(
      `regression-pin-allowlist at ${path} missing required "allow" field. Shape: { "allow": { "F-NNNNNN-NNN": { "reason": "...", "file": "..." } } }`,
    );
  }
  if (parsed.allow === null || typeof parsed.allow !== 'object' || Array.isArray(parsed.allow)) {
    throw new Error(
      `regression-pin-allowlist at ${path} "allow" must be an object map (got ${Array.isArray(parsed.allow) ? 'array' : typeof parsed.allow}).`,
    );
  }
  for (const [id, entry] of Object.entries(parsed.allow)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`regression-pin-allowlist entry for ${id} must be an object with at least { reason }.`);
    }
    if (!entry.reason || typeof entry.reason !== 'string') {
      throw new Error(`regression-pin-allowlist entry for ${id} missing "reason" string.`);
    }
  }
  return parsed;
}

/**
 * Apply the allowlist to a parsed JSON result, returning the filtered
 * orphan list and the set of allowlist entries that were actually used
 * (so we can warn about stale entries that match no orphan).
 *
 * @param {ReturnType<typeof toJSON>} json
 * @param {{ allow: Record<string, unknown> }} allowlist
 * @returns {{ orphansAfterAllowlist: string[], applied: string[], unusedAllowEntries: string[] }}
 */
export function applyAllowlist(json, allowlist) {
  const allowed = new Set(Object.keys(allowlist.allow));
  const orphansAfter = [];
  const applied = [];
  for (const id of json.summary.orphan_source_ids) {
    if (allowed.has(id)) {
      applied.push(id);
    } else {
      orphansAfter.push(id);
    }
  }
  const unused = [...allowed].filter((id) => !applied.includes(id));
  return { orphansAfterAllowlist: orphansAfter, applied, unusedAllowEntries: unused };
}

/**
 * Run the gate.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]      - directory to scan (default: repo root inferred from this script)
 * @param {string} [opts.allowlistPath] - path to allowlist JSON
 * @param {string} [opts.writeIndexPath]- if set, write the JSON index here
 * @returns {Promise<{
 *   ok: boolean,
 *   json: ReturnType<typeof toJSON>,
 *   orphans: string[],
 *   allowlistApplied: string[],
 *   unusedAllowEntries: string[],
 *   unusedAllowEntryReasons: Record<string, string>,
 *   narrativeOnlyIds: string[],
 *   indexWritten: string | null
 * }>}
 */
export async function runRegressionPinGate({ repoRoot = defaultRepoRoot, allowlistPath = defaultAllowlistPath, writeIndexPath = null } = {}) {
  const result = parseRegressionPins(repoRoot);
  const json = toJSON(result);
  // F-f0339e12: orphan status is decided by STRUCTURAL test-pin coverage,
  // not the parser's raw whole-file-text test_pins membership — see the
  // module docstring above computeStructuralOrphans. json.source_pins/
  // test_pins/summary.{source_ids,test_ids} stay exactly as the parser
  // emitted them; only the orphan_source_ids fed to applyAllowlist changes.
  const { orphanSourceIds, structuralTestIds, narrativeOnlyIds } = computeStructuralOrphans(json);
  const allowlist = loadAllowlist(allowlistPath);
  const { orphansAfterAllowlist, applied, unusedAllowEntries } = applyAllowlist(
    { ...json, summary: { ...json.summary, orphan_source_ids: orphanSourceIds } },
    allowlist,
  );
  const unusedAllowEntryReasons = Object.fromEntries(
    unusedAllowEntries.map((id) => [id, explainUnusedAllowEntry(id, json, structuralTestIds)]),
  );

  let indexWritten = null;
  if (writeIndexPath) {
    const absPath = resolve(repoRoot, writeIndexPath);
    mkdirSync(dirname(absPath), { recursive: true });
    // The persisted index gets the corrected (structural) orphan_source_ids
    // too, plus the structural summary fields — a future consumer (e.g. the
    // FT-BACKEND-002 swarm verify-fixed delta join this docstring names)
    // should never read the pre-fix, textually-fooled orphan list back off
    // disk. source_pins/test_pins stay the parser's raw maps, unmodified.
    const indexPayload = {
      ...json,
      summary: {
        ...json.summary,
        orphan_source_ids: orphanSourceIds,
        structural_test_ids: structuralTestIds.size,
        narrative_only_ids: narrativeOnlyIds,
      },
    };
    writeFileSync(absPath, `${JSON.stringify(indexPayload, null, 2)}\n`, 'utf-8');
    indexWritten = absPath;
  }

  return {
    ok: orphansAfterAllowlist.length === 0,
    json,
    orphans: orphansAfterAllowlist,
    allowlistApplied: applied,
    unusedAllowEntries,
    unusedAllowEntryReasons,
    narrativeOnlyIds,
    indexWritten,
  };
}

/**
 * Pretty-print a gate result for terminal consumption.
 */
export function formatHuman(result, repoRoot) {
  const lines = [];
  const { json, orphans, allowlistApplied, unusedAllowEntries, unusedAllowEntryReasons = {}, indexWritten } = result;
  lines.push(`[check-finding-regression-pins] scanned ${json.files_scanned} files`);
  lines.push(`  source pins: ${json.summary.source_ids} F-id(s)`);
  lines.push(`  test pins:   ${json.summary.test_ids} F-id(s)`);
  if (allowlistApplied.length > 0) {
    lines.push(`  allowlist applied: ${allowlistApplied.length} F-id(s) (${allowlistApplied.join(', ')})`);
  }
  if (unusedAllowEntries.length > 0) {
    // F-f0339e12: explain WHY each entry went stale — "now has a genuine
    // structural test pin" (safe to delete, real coverage landed) reads very
    // differently from "no longer a source pin" (safe to delete, the fix
    // moved/vanished). Neither can be misread as "a stray comment merely
    // mentioned it" anymore — computeStructuralOrphans makes that specific
    // misread structurally unreachable (see runRegressionPinGate).
    lines.push('  WARN — stale allowlist entries (no longer match any orphan):');
    for (const id of unusedAllowEntries) {
      lines.push(`    ${id} — ${unusedAllowEntryReasons[id] ?? 'reason unavailable'}`);
    }
  }
  if (orphans.length === 0) {
    lines.push(`  OK — every source-pinned F-id has at least one test pin (Class #14 invariant holds).`);
  } else {
    lines.push(`  FAIL — ${orphans.length} orphan source pin(s) without matching test pin:`);
    for (const id of orphans) {
      const files = json.source_pins[id] ?? [];
      lines.push(`    ${id}`);
      for (const f of files) {
        lines.push(`      in ${relative(repoRoot, f) || f}`);
      }
    }
    lines.push('');
    lines.push('  How to fix: add a regression test that pins the F-id (e.g. // F-NNNNNN-NNN — what this guards),');
    lines.push('  OR — if the source mention is a cross-reference rather than a fix pin — add an entry to');
    lines.push('  scripts/regression-pin-allowlist.json with a justification.');
  }
  if (indexWritten) {
    lines.push(`  Wrote index to ${relative(repoRoot, indexWritten) || indexWritten}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { json: false, writeIndexPath: null, root: null, allowlistPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--write-index') {
      out.writeIndexPath = argv[++i] ?? null;
      if (!out.writeIndexPath) throw new Error('--write-index requires a path argument');
    } else if (a === '--root') {
      out.root = argv[++i] ?? null;
      if (!out.root) throw new Error('--root requires a path argument');
    } else if (a === '--allowlist') {
      out.allowlistPath = argv[++i] ?? null;
      if (!out.allowlistPath) throw new Error('--allowlist requires a path argument');
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-finding-regression-pins.mjs [options]

Always-on CI gate for Class #14 (claimed-fixed without verification). Asserts
every F-id pinned in a source file has at least one matching pin in a test
file — see parse-regression-pins.js's F_ID_PATTERN for the exact id-shape
contract (three unioned formats: legacy F-NNNNNN-NNN, hash F-xxxxxxxx,
prefixed F-AAA-NNN).

Options:
  --json                    machine-readable JSON output (parser result + gate)
  --write-index <path>      after parsing, write the JSON index to <path>
                            (recommended canonical location: docs/regression-pin-index.json)
  --root <dir>              scan a directory other than the repo root (tests use this)
  --allowlist <path>        use a different allowlist file
  -h, --help                this message

Exit codes: 0 (clean) | 1 (orphan source pins) | 2 (internal error)
`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const repoRoot = args.root ? resolve(args.root) : defaultRepoRoot;
  const allowlistPath = args.allowlistPath ? resolve(args.allowlistPath) : defaultAllowlistPath;

  let result;
  try {
    result = await runRegressionPinGate({
      repoRoot,
      allowlistPath,
      writeIndexPath: args.writeIndexPath,
    });
  } catch (err) {
    process.stderr.write(`[check-finding-regression-pins] internal error: ${err.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      orphans: result.orphans,
      allowlist_applied: result.allowlistApplied,
      unused_allow_entries: result.unusedAllowEntries,
      unused_allow_entry_reasons: result.unusedAllowEntryReasons,
      narrative_only_ids: result.narrativeOnlyIds,
      index_written: result.indexWritten,
      parser: result.json,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result, repoRoot)}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

// F-W1-CI-006: ESM main detection — only run main() when invoked as a script,
// not when imported by tests. Previous heuristic used a hand-built
// `file://${process.argv[1]}` plus an `endsWith` fallback; both fail on
// Windows because process.argv[1] uses backslashes while import.meta.url is
// always POSIX/URL form. `pathToFileURL(process.argv[1]).href` is the
// canonical Node cross-platform pattern (matches apply-finding-migration.mjs
// W31-BACK-001 fix).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main();
}
