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
 *      also contains a REAL, code-level `assert`/`expect(` call, e.g. an
 *      assertion message that names the id it proves
 *      (`assert.doesNotMatch(a, /F-NNNNNN-NNN/, 'domain leaked
 *      F-NNNNNN-NNN')`) or a bare regex-matcher argument with no redundant
 *      string (`assert.match(text, /F-NNNNNN-NNN/, 'mentions the
 *      finding')`). An id sharing a line with the check that exercises it
 *      is the thing being tested, not prose about it. (Deliberately
 *      illustrated with the non-matching F-NNNNNN-NNN placeholder, not a
 *      real tracked id — a real id here would make THIS docstring's own
 *      coverage depend on an unrelated file in another domain never
 *      refactoring it away.) F-c7927c58: excludes a same-line
 *      test()/it()/describe( call's own quoted TITLE span before matching.
 *      F-e003b1fb / F-234da564 (wave 16): checked against a unified
 *      lexer-driven masking pass, not raw or ad hoc partially-masked text —
 *      see isSameLineAssertArgumentPin's own docstring and the "F-e003b1fb
 *      / F-234da564 (wave 16)" section below the rule-1-4 heuristics.
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
 *   - CLOSED by F-234da564 (wave 16): a same-line trailing COMMENT that
 *     mentions an unrelated id on a line which also happens to contain a
 *     genuine (unrelated) assert/expect call used to still count under rule
 *     4 (this paragraph previously accepted it as "not zero, but far
 *     smaller than a proximity window"). The unified masking pass blanks
 *     comments in BOTH views rule 4 now consults, so an id living only in a
 *     trailing comment is invisible to the id-membership check regardless
 *     of what real call shares the line. A same-line trailing STRING or
 *     regex-literal argument mentioning an unrelated id, on a line with a
 *     genuine but unrelated assert/expect call, is NOT closed — that is the
 *     same "same-line, not argument-position-verified" tradeoff the module
 *     docstring's item 4 has always accepted, now deliberately extended to
 *     regex-literal arguments too (see F-9c41a2b7 in PROSE_MASK_KINDS).
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
 *   - SUPERSEDED BY F-e003b1fb / F-234da564 (wave 16) — HISTORICAL RECORD,
 *     mechanism no longer exists (kept for provenance, per this repo's own
 *     "don't normalize history for aesthetics" norm): rule 2's call-body
 *     scan (enclosingCallHasAssertBody) used to run its OWN per-call
 *     comment/string masking (STRUCTURAL_MASK_PATTERN) plus a hand-rolled,
 *     escape-aware (F-16275dfd), character-class-aware (F-f37bb9ae)
 *     bracket-depth loop over text that still included UNMASKED regex
 *     literals — closing two narrow mechanical bugs (an unbalanced count of
 *     backslash-escaped brackets inside one regex collapsing depth early;
 *     an unescaped bracket inside a regex character class, e.g. `/[(]/`,
 *     inflating or deflating depth) but leaving a THIRD, broader gap open:
 *     a regex literal's PATTERN TEXT — ordinary characters, not a bracket —
 *     spelling "assert" or "expect(" verbatim (e.g. `const re = /assert/;`)
 *     satisfied STRUCTURAL_ASSERT_LINE with zero real assertion anywhere,
 *     because nothing masked regex literals at all. Wave 16's unified
 *     masking pass (maskToCodeOnly) blanks entire regex literals —
 *     delimiters, flags, and pattern text alike — BEFORE the bracket-depth
 *     loop or the assert-pattern test ever run, which closes all three
 *     bugs at once and makes the old loop's escape/inClass handling
 *     redundant: with no regex-literal brackets or escapes left in the
 *     input, there is nothing left for that handling to misread. See
 *     enclosingCallHasAssertBody's current docstring for the replacement
 *     mechanism, and the "F-234da564 TREATMENT (wave 16 ...)" test for the
 *     mutation-probe proof this class is closed, not merely reduced.
 *   - CLOSED by F-c7927c58 (title masking) and, more completely, by
 *     F-e003b1fb / F-234da564 (wave 16's unified masking pass) — HISTORICAL
 *     RECORD: rule 4 (isSameLineAssertArgumentPin) used to test the RAW,
 *     unmasked line, deliberately, so an id living inside a real
 *     assertion-message string kept working — but unmasked also meant it
 *     could not tell a REAL assert/expect() call from the bare English word
 *     "assert" inside a comment, a console.log() string, or (until
 *     F-c7927c58) a test TITLE. F-c7927c58 closed the title case with a
 *     narrow, single-purpose title-span blank; F-234da564 (wave 16) proved
 *     the SAME root cause reached further — an ordinary comment, or a
 *     console.log() string, spelling "assert"/"expect(" with zero real
 *     assertion anywhere still granted credit, because nothing besides the
 *     title was ever masked. See isSameLineAssertArgumentPin's current
 *     docstring for the replacement two-view design (codeOnlyLine for "is
 *     there a real call," proseMaskedLine for "does the id appear outside
 *     prose") and the "F-234da564 TREATMENT" tests for the mutation-probe
 *     proof.
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
 *   - F-e003b1fb / F-234da564 (wave 16) — genuinely still open, disclosed
 *     rather than claimed closed: scanNonCodeSpans' regex-vs-division
 *     preceding-token heuristic is TOKEN-LOCAL, not grammatical (inherited
 *     from strip-comments.js's own docstring, not a new limitation this
 *     wave introduced) — a regex literal immediately after a CLOSER or
 *     VALUE token whose trailing word is not in REGEX_PRECEDER_KEYWORDS
 *     (e.g. `a.length /F-id/.test(x)`, where "length" precedes the `/`)
 *     reads as division and passes through unlexed, leaving that regex's
 *     pattern text — including any id or assert-shaped word it happens to
 *     spell — unmasked in codeOnlyLine. Confirmed NOT currently reproducible
 *     in this repo's own test-file corpus (grepped every test file for a
 *     `/` immediately following a `)`, `]`, or bare identifier/keyword tail
 *     with no operator between — zero matches) — the same evidentiary
 *     posture (proven mechanism, not a currently-red gate) F-f37bb9ae's own
 *     "regex spells assert" residual carried before this wave closed it.
 *   - F-234da564 (live-tree audit, wave 16) — closed IN EFFECT, not at the
 *     source: matchTestCallStart itself still matches test()/it()/describe(
 *     call syntax against the RAW line with no awareness of whether that
 *     match sits inside a comment or a string (e.g. commented-out example
 *     code, or a code-gen template string containing literal test syntax).
 *     This has no observable consequence today: enclosingCallHasAssertBody's
 *     guard (`codeOnlyLines[callLineIndex][openParenCol] !== '(' → deny`)
 *     denies credit for rule 2 whenever the "call" matchTestCallStart found
 *     turns out to have been inside a masked (comment/string/template/
 *     regex) span, and rule 4's title-blanking step is a no-op when it
 *     blanks an already-masked region. A future rule that consumes
 *     matchTestCallStart's output WITHOUT routing it through a masked-view
 *     guard first would reopen this — the guard lives at the one call site
 *     that currently needs it, not inside matchTestCallStart itself, so it
 *     is not automatically inherited by a new caller.
 *
 * These are line-based heuristics over the SAME already-classified test
 * files the parser walks — no new file walk, no parser edit. Deliberately
 * reads F_ID_PATTERN from parse-regression-pins.js (not a hand-rolled
 * copy) so the id-shape contract still lives in exactly one place.
 */

const STRUCTURAL_COMMENT_DECORATION = /^\s*(?:[/*#-]+\s*)+/;
// F-e003b1fb: only locates WHERE a test()/it()/describe() call's title
// argument OPENS (through the opening quote/backtick) — deliberately does
// NOT also try to capture where the title ends. The previous version of
// this pattern (STRUCTURAL_TEST_TITLE) captured the title text itself with
// a same-delimiter negative-lookahead (`(['"`])((?:(?!\1).)*?)\1`), which
// has no backslash-escape awareness: it stops at the first character equal
// to the opening quote, even when that character is itself escaped (an
// ordinary way to write a contraction inside a single-quoted title, e.g.
// "doesn't"/"isn't"). matchTestCallStart below now hands "where does this
// quoted span truly end" to scanNonCodeSpans — the same escape-aware,
// nested-template-aware lexer every credit heuristic in this file now
// shares — instead of a second, independently escape-blind regex.
const TEST_CALL_OPEN = /\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*['"`]/;
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

// ─────────────────────────────────────────────────────────────────────────
// F-e003b1fb / F-234da564 (wave 16) — the unified masking pass.
//
// ROOT CAUSE this section closes: every credit heuristic below used to
// operate on RAW or partially-masked text — the old STRUCTURAL_MASK_PATTERN
// handled comments/strings/templates but never regex literals; rule 4
// masked nothing on the line but a same-line title span; matchTestCallStart
// itself had no escape awareness. Five separate waves (w8/10/12/13/14) each
// closed one non-code POSITION a credit decision could be fooled by and
// missed another. scanNonCodeSpans below is ONE lexer — ported from (see
// "why ported, not imported" below) packages/dogfood-swarm/test-support/
// strip-comments.js's scanning discipline: comments, single/double-quoted
// strings, template literals (including nested ${...} expressions, where
// code rules apply again), and regex literals via the standard
// regex-vs-division preceding-token heuristic — that every heuristic
// needing to tell "real code" from "prose in a non-code position" now
// shares, instead of independent regex approximations of the same
// question.
//
// Two masked VIEWS are derived from the one scan, because the two things
// this file needs to know are genuinely different questions:
//   - maskToCodeOnly: blanks comments AND strings AND templates AND regex
//     literals, leaving ONLY real code tokens visible. Answers "does a
//     REAL, code-level assert/expect( call exist here" — the word "assert"
//     spelled inside a comment, a console.log() string, a test title, or a
//     regex literal's own pattern text must never satisfy this; only an
//     actual call token in code can.
//   - maskCommentsOnly: blanks ONLY comments; quoted strings, template-
//     literal text, AND regex-literal pattern text all stay visible
//     verbatim. This is rule 4's designed purpose — an id living inside a
//     REAL assertion argument must keep earning credit, and that argument
//     is legitimately EITHER a string (assert.doesNotMatch(a, /F-id/,
//     'domain leaked F-id')) OR a bare regex matcher with no redundant
//     string (assert.match(text, /F-id/, 'mentions the finding') — a live,
//     idiomatic shape in this repo's own test suite, confirmed by the
//     wave-16 live-tree run when an earlier draft of this fix masked regex
//     bodies here too and turned that real pin into a false orphan). Only
//     the specific span that is NEVER a legitimate rule-4 pin site —
//     comments — is blanked wholesale here; a recognized test call's own
//     title span is blanked separately, per call site, since a title's
//     delimiters make it indistinguishable from any other string to a
//     kind-only scan (see isSameLineAssertArgumentPin). Regex-literal
//     pattern text is masked ONLY in maskToCodeOnly (above), where the
//     question is "is this a real call," never in this view, where the
//     question is "does the id appear in a legitimate argument."
//
// Why PORTED, not IMPORTED: this wave's domain is .github/**, scripts/**,
// tsconfig*.json — packages/** (where strip-comments.js lives) belongs to a
// different domain, so editing it is out of scope this wave regardless of
// which design is abstractly cleaner (flagged as a follow-up in this wave's
// output notes). Independent of that constraint: strip-comments.js's stated
// job is DELETING non-code text for grep-style test-support matching — line
// NUMBERS survive (embedded newlines are preserved), but COLUMN offsets do
// not (a stripped span's interior collapses to nothing). Every credit
// heuristic in this file slices the ORIGINAL raw text using column numbers
// computed against the masked view (matchTestCallStart's titleStart/
// titleEnd/openParenCol, the bracket scan below) — masking here must be
// LENGTH- and COLUMN-preserving (blank to spaces, never delete), a
// different contract than strip-comments.js's own callers need. A
// production CI gate (wired into npm run verify / ci.yml / release.yml on
// every push) depending on a directory named test-support/ would also be a
// poor architectural signal even where mechanically possible.
// ─────────────────────────────────────────────────────────────────────────

// Tokens after which a `/` begins a regex literal rather than division —
// ported verbatim from strip-comments.js's REGEX_PRECEDERS/
// REGEX_PRECEDER_KEYWORDS/lastSignificantToken/regexFollows. DISCLOSED,
// INHERITED LIMITATION (documented in that file's own docstring, not new
// here): the heuristic is token-local, not grammatical — a regex literal
// immediately after a CLOSER or VALUE token (e.g. `a.length /re/.test(x)`,
// where the preceding word "length" is neither a keyword nor a punctuation
// preceder, so the `/` reads as division) passes through unlexed. Not
// currently reproducible in this repo's own test-file corpus (grepped every
// test file for a `/` immediately following a `)`, `]`, or bare identifier/
// keyword tail with no operator between — zero matches) — the same
// evidentiary posture (proven mechanism, not a currently-red gate) this
// file already holds itself to elsewhere; see WHAT STILL SLIPS THROUGH.
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-',
  '*', '%', '<', '>', '~', '^',
]);
const REGEX_PRECEDER_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete',
  'void', 'do', 'else', 'yield', 'await', 'throw',
]);

function lastSignificantToken(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  if (j < 0) return { char: '', word: '' };
  const char = out[j];
  let k = j;
  while (k >= 0 && /[A-Za-z_$]/.test(out[k])) k--;
  return { char, word: out.slice(k + 1, j + 1) };
}

function regexFollows(out) {
  const { char, word } = lastSignificantToken(out);
  if (char === '') return true; // start of input
  if (REGEX_PRECEDER_KEYWORDS.has(word)) return true;
  return REGEX_PRECEDERS.has(char);
}

/**
 * Classify every comment / string / template-literal / regex-literal span
 * in `source`. Returns span RECORDS (start/end/kind) instead of a
 * transformed string, so a caller can apply its own masking policy per kind
 * (maskToCodeOnly vs maskCommentsOnly below) without that choice
 * ever feeding back into the tokenizer's own regex-vs-division decision —
 * the internal `shape` buffer below always keeps strings/templates/regex
 * verbatim (mirroring strip-comments.js's own accumulator, which preserves
 * them byte-for-byte for exactly this reason: a masked-to-spaces string
 * would look like whitespace to the preceding-token lookback, wrongly
 * making a following `/` skip past a real value token as if it were
 * transparent, same as a comment — but a string IS a value for
 * regex-vs-division purposes, a comment is not).
 *
 * @param {string} source
 * @returns {{ start: number, end: number, kind: 'comment'|'string'|'template'|'regex' }[]}
 *   Half-open [start, end) ranges, in source order. Real code is everything
 *   NOT covered by a returned span.
 */
function scanNonCodeSpans(source) {
  const spans = [];
  let shape = '';
  let i = 0;
  const n = source.length;
  const frames = [];
  let braceDepth = 0;

  function consumeTemplateBody(from) {
    let j = from;
    while (j < n) {
      if (source[j] === '\\') { shape += source[j] + (source[j + 1] ?? ''); j += 2; continue; }
      if (source[j] === '`') { shape += source[j]; j++; return j; }
      if (source[j] === '$' && source[j + 1] === '{') {
        shape += '${';
        j += 2;
        frames.push({ braceDepth });
        braceDepth = 0;
        return j;
      }
      shape += source[j];
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    if (c === '/' && next === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      spans.push({ start, end: i, kind: 'comment' });
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') shape += '\n';
        i++;
      }
      i = Math.min(i + 2, n);
      spans.push({ start, end: i, kind: 'comment' });
      continue;
    }
    // Regex literal — lexed (not just pattern-matched) so bare quotes,
    // comment-lookalikes, or "assert"/"expect(" text inside a regex body
    // can never desync — or masquerade as — anything downstream.
    if (c === '/' && regexFollows(shape)) {
      const start = i;
      shape += c;
      i++;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') { shape += r + (source[i + 1] ?? ''); i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { shape += r; i++; break; }
        shape += r;
        i++;
      }
      while (i < n && /[a-z]/i.test(source[i])) { shape += source[i]; i++; } // flags
      spans.push({ start, end: i, kind: 'regex' });
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      shape += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { shape += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        shape += source[i];
        i++;
      }
      if (i < n) { shape += source[i]; i++; }
      spans.push({ start, end: i, kind: 'string' });
      continue;
    }
    if (c === '`') {
      const start = i;
      shape += c;
      i = consumeTemplateBody(i + 1);
      spans.push({ start, end: i, kind: 'template' });
      continue;
    }
    if (c === '{') { braceDepth++; shape += c; i++; continue; }
    if (c === '}') {
      if (braceDepth === 0 && frames.length > 0) {
        shape += c;
        braceDepth = frames.pop().braceDepth;
        const bodyStart = i;
        i = consumeTemplateBody(i + 1);
        // The `${...}` interior itself was already scanned by the normal
        // code path while braceDepth unwound back to this frame (any
        // string/comment/regex it contained already pushed its own span
        // above) — this span covers only the literal template TEXT that
        // resumes after the closing brace, so it is never double-counted
        // with the expression interior.
        spans.push({ start: bodyStart, end: i, kind: 'template' });
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      shape += c;
      i++;
      continue;
    }
    shape += c;
    i++;
  }
  return spans;
}

/**
 * Blank the given span kinds in `source` with spaces, one character for one
 * character — every embedded '\n' is left as '\n' so line COUNT stays
 * identical, and every remaining real-code character keeps its original
 * COLUMN, because every caller in this file slices/indexes the masked text
 * using positions computed elsewhere (matchTestCallStart's own regex match,
 * findStructuralPinHits's line bookkeeping).
 *
 * @param {string} source
 * @param {{start:number,end:number,kind:string}[]} spans
 * @param {Set<string>} kindsToMask
 * @returns {string} same length as `source`.
 */
function applyMask(source, spans, kindsToMask) {
  const out = source.split('');
  for (const { start, end, kind } of spans) {
    if (!kindsToMask.has(kind)) continue;
    for (let k = start; k < end; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  }
  return out.join('');
}

const CODE_ONLY_MASK_KINDS = new Set(['comment', 'string', 'template', 'regex']);
// F-9c41a2b7 (live-tree audit, wave 16): an EARLIER draft of this fix put
// 'regex' in this set too, on the theory that a regex literal's pattern
// text is "prose" the same way a comment is. That is wrong: this repo's own
// live corpus idiomatically writes `assert.match(text, /F-id/, 'mentions
// the finding')` — a bare regex matcher, no redundant string copy of the
// id — as a genuine rule-4 pin (packages/dogfood-swarm/wave8-4091637-5127-
// swarm-cp-pins.test.js). Masking regex bodies here turned that real,
// structurally-valid pin into a false orphan on this wave's own live-tree
// run — caught by the load-bearing "live testing-os tree passes the gate"
// test before it ever reached the confirming audit. A regex-literal
// argument to a real assert/expect( call is exactly as legitimate an id
// site as a string argument; only maskToCodeOnly (which asks a different
// question — "is this a real call," not "does the id appear in a
// legitimate argument") needs regex bodies blanked.
const PROSE_MASK_KINDS = new Set(['comment']);

// Both views are applied via applyMask(text, spans, KINDS) directly at their
// one real call site (findStructuralPinHits), against a SINGLE shared
// scanNonCodeSpans(text) result, rather than through two per-view wrapper
// functions that would each redundantly re-scan the same text. "codeOnly"
// and "commentsOnly" below name the two views in prose/docstrings; there is
// no maskToCodeOnly()/maskCommentsOnly() function to look for in the code.

/**
 * Blank a single [start, end) span (length-preserving, like applyMask) —
 * used to additionally hide a specific recognized test-call TITLE span from
 * the comments-only view, which otherwise leaves ALL strings (titles
 * included) visible by design.
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function blankSpan(text, start, end) {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
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
 * F-e003b1fb: the title's END is no longer captured by the same regex that
 * finds the call's start — TEST_CALL_OPEN only matches through the OPENING
 * quote/backtick; scanNonCodeSpans(line) is then consulted for the string/
 * template span that starts at that exact column, which is escape-aware and
 * nested-template-aware by construction (the same lexer every other credit
 * heuristic in this file now shares). A quote character always opens a
 * string/template span in scanNonCodeSpans (unlike '/', quotes have no
 * regex-vs-division-style ambiguity), so the lookup below is not a
 * best-effort fallback — it is expected to always succeed whenever
 * TEST_CALL_OPEN matched; the null branch exists only as a defensive,
 * intended-unreachable guard, never a silently-wrong title.
 *
 * @param {string} line
 * @returns {{ title: string, openParenCol: number, titleStart: number, titleEnd: number } | null}
 */
function matchTestCallStart(line) {
  const m = TEST_CALL_OPEN.exec(line);
  if (!m) return null;
  const openQuotePos = m.index + m[0].length - 1;
  const span = scanNonCodeSpans(line).find(
    (s) => s.start === openQuotePos && (s.kind === 'string' || s.kind === 'template'),
  );
  if (!span) return null;
  return {
    title: line.slice(span.start + 1, span.end - 1),
    openParenCol: m.index + m[0].indexOf('('),
    titleStart: span.start,
    titleEnd: span.end,
  };
}

/**
 * F-ec9622fd: whether the test/it/describe call opening at
 * codeOnlyLines[callLineIndex][openParenCol] has an assert/expect() call
 * anywhere in its OWN body — tracked by combined paren/brace depth from
 * that '(' back to zero (mutation-probe proof: pre-fix, the title rule
 * granted credit on TEXTUAL PLACEMENT alone — `test('F-NNNNNN-NNN: unrelated
 * smoke test', () => {})` with a genuinely EMPTY callback earned full
 * 'title' credit with zero requirement that the body relate to the id).
 * Mirrors rule 4's own same-line assert bar, widened from "this line" to
 * "this call's true (bracket-balanced) extent." Bounded by
 * STRUCTURAL_TITLE_BODY_LINE_LIMIT lines; failing to find the closing paren
 * within the bound is treated as "no body found" — fail closed, same as a
 * genuinely empty body, never a false grant. It does NOT verify the
 * assertion is semantically about the id — see WHAT STILL SLIPS THROUGH.
 *
 * F-e003b1fb / F-234da564 (wave 16): `codeOnlyLines` arrives PRE-MASKED
 * (maskToCodeOnly over the WHOLE file text, split on '\n' by
 * findStructuralPinHits) — this function no longer does its own per-call
 * comment/string masking, and no longer runs its own escape-aware,
 * character-class-aware bracket scan (both used to live in this loop; see
 * the module docstring's F-16275dfd/F-f37bb9ae history for why they existed
 * and WHAT STILL SLIPS THROUGH for why they are gone, not merely moved).
 * Once a regex literal is blanked ENTIRELY at the lexer level, there are no
 * regex-internal brackets or backslash escapes left in codeOnlyLines for a
 * bracket-depth loop to misread in the first place — the old inClass/escape
 * handling was working around exactly the characters this earlier masking
 * pass now removes before the loop ever runs. Masking the WHOLE candidate
 * body in one pass (findStructuralPinHits, not here, and not line-by-line)
 * also means a block comment, template literal, or regex literal spanning
 * more than one physical body line is masked correctly across its full
 * extent — a gap the old per-line maskCommentsAndStrings call could not see
 * (that regex required both delimiters of a block comment to appear within
 * the SAME line it was applied to).
 *
 * F-234da564 (live-tree audit, wave 16): matchTestCallStart itself still
 * matches against the RAW line, with no comment/string awareness of its
 * OWN — a test()/it()/describe( call written INSIDE a multi-line block
 * comment (e.g. commented-out example code narrating a fix) still produces
 * an `openParenCol` from matchTestCallStart, pointing at a column that
 * maskToCodeOnly has now correctly blanked to a space. Without the guard
 * immediately below, `depth` would never leave 0 while scanning the
 * comment's own (fully masked) lines, so the FIRST real closing bracket
 * encountered on ANY later, unrelated line — even a genuine, different
 * test's own closing `});` — would immediately satisfy `depth <= 0` and
 * hand this fake, comment-embedded call credit for that unrelated test's
 * real assert. Caught by this wave's own new multi-line-block-comment
 * mutation-probe test before it ever reached the confirming audit. The
 * fix is a fail-closed guard, not a second tokenizer: if the character
 * `matchTestCallStart` believed was the call's own opening '(' is not
 * actually '(' once real code is separated from non-code, the "call" was
 * never real code in the first place (it lives inside a comment or a
 * string) — there is no body to scan, so deny immediately, the same
 * "no body connection found" outcome STRUCTURAL_TITLE_BODY_LINE_LIMIT's
 * own bound already produces for the unrelated "ran off the end" case.
 * This closes the FALSE-GRANT direction (leaking into a later, unrelated
 * real call); a comment-embedded FAKE assert being found within the same
 * fake call's own (comment-interior) lines was already denied by the
 * masking above and needs no separate guard. matchTestCallStart matching
 * inside a comment/string in the first place is a narrower, lower-severity
 * residual that remains — see WHAT STILL SLIPS THROUGH.
 *
 * @param {string[]} codeOnlyLines - applyMask(fileText, spans, CODE_ONLY_MASK_KINDS).split('\n')
 * @param {number} callLineIndex
 * @param {number} openParenCol
 * @returns {boolean}
 */
function enclosingCallHasAssertBody(codeOnlyLines, callLineIndex, openParenCol) {
  // F-234da564: the call's own opening paren must survive masking as real
  // code — if it did not, matchTestCallStart found this "call" inside a
  // comment or string, and there is no real body here to scan (see the
  // docstring above).
  if (codeOnlyLines[callLineIndex][openParenCol] !== '(') return false;
  let depth = 0;
  const lastLine = Math.min(codeOnlyLines.length - 1, callLineIndex + STRUCTURAL_TITLE_BODY_LINE_LIMIT);
  for (let i = callLineIndex; i <= lastLine; i++) {
    const masked = i === callLineIndex ? codeOnlyLines[i].slice(openParenCol) : codeOnlyLines[i];
    let closedAt = -1;
    for (let c = 0; c < masked.length; c++) {
      const ch = masked[c];
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
 * @param {string[]} rawLines - for matchTestCallStart, which needs the
 *   ORIGINAL text to find the title's true boundary via scanNonCodeSpans.
 * @param {string[]} codeOnlyLines - applyMask(fileText, spans, CODE_ONLY_MASK_KINDS).split('\n'),
 *   parallel to rawLines (same length, same line boundaries).
 * @param {number} lineIndex
 * @param {string} id
 * @returns {boolean}
 */
function isTestTitlePin(rawLines, codeOnlyLines, lineIndex, id) {
  const call = matchTestCallStart(rawLines[lineIndex]);
  if (!call || !call.title.includes(id)) return false;
  return enclosingCallHasAssertBody(codeOnlyLines, lineIndex, call.openParenCol);
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
 * F-c7927c58: excludes a same-line test()/it()/describe( call's own quoted
 * TITLE span before rule 4 grants credit — a test/it/describe TITLE is
 * prose about the test, never a pin site of its own; rule 2 (isTestTitlePin)
 * is the sole authority for title-borne credit, and unlike rule 4, it
 * requires a real body-level assert.
 *
 * F-e003b1fb / F-234da564 (wave 16): rule 4 now asks two SEPARATE questions
 * against two separately-masked views (both precomputed once by
 * findStructuralPinHits), instead of one raw-text pattern test plus one
 * narrow title-span blank:
 *   1. Is there a REAL, code-level assert/expect( call anywhere on this
 *      line — checked against codeOnlyLine (comments/strings/templates/
 *      regex ALL blanked, so the word "assert" or literal "expect(" text
 *      can only satisfy this by being an actual call token in actual code,
 *      never prose inside a comment, a console.log() string, a test title,
 *      or a regex literal's own pattern text — codeOnlyLine already has the
 *      title blanked as an ordinary consequence of blanking every string,
 *      needing no separate title-masking step here).
 *   2. Does the id appear anywhere on this line OUTSIDE a comment or THIS
 *      line's own recognized test-call title — checked against
 *      proseMaskedLine (comments blanked ONLY; quoted strings, template-
 *      literal text, AND regex-literal pattern text all left VISIBLE) with
 *      the title span additionally blanked below, because proseMaskedLine
 *      otherwise leaves every string visible by design — including a
 *      title, which is a string like any other to a kind-only scan. A real
 *      assert argument legitimately carries the id as EITHER a string
 *      (`assert.doesNotMatch(a, /F-id/, 'domain leaked F-id')`) OR a bare
 *      regex matcher with no redundant string (`assert.match(text, /F-id/,
 *      'mentions the finding')` — a live idiom in this repo's own test
 *      suite; masking regex bodies in THIS view too, on an earlier draft of
 *      this fix, turned that real pin into a false orphan on the live-tree
 *      run — see PROSE_MASK_KINDS). codeOnlyLine's independent "is there a
 *      real call at all" gate (question 1) is what actually keeps this
 *      permissive view safe — see WHAT STILL SLIPS THROUGH.
 * Both must hold — the same "cheap, line-local, no dataflow analysis" bar
 * the rest of this file holds itself to, now applied uniformly via one
 * shared lexer instead of ad hoc per finding.
 *
 * @param {string} rawLine - for matchTestCallStart (title-span lookup only)
 * @param {string} codeOnlyLine - this line from applyMask(fileText, spans, CODE_ONLY_MASK_KINDS)
 * @param {string} proseMaskedLine - this line from applyMask(fileText, spans, PROSE_MASK_KINDS)
 * @param {string} id
 * @returns {boolean}
 */
function isSameLineAssertArgumentPin(rawLine, codeOnlyLine, proseMaskedLine, id) {
  const call = matchTestCallStart(rawLine);
  const proseChecked = call ? blankSpan(proseMaskedLine, call.titleStart, call.titleEnd) : proseMaskedLine;
  return STRUCTURAL_ASSERT_LINE.test(codeOnlyLine) && proseChecked.includes(id);
}

/**
 * Classify every textual occurrence of `id` in `text` (a file already known
 * to contain at least one match) as structural or not, one record per
 * occurrence, so tests and diagnostics can see WHY, not just a boolean.
 *
 * F-e003b1fb / F-234da564 (wave 16): the two masked views every heuristic
 * needs are computed ONCE here, over the WHOLE file text — not re-derived
 * per line, per rule, the way the pre-wave-16 code did. A single
 * scanNonCodeSpans pass is inherently multi-line-aware, so a block comment,
 * template literal, or regex literal that happens to span more than one
 * physical line is masked correctly across its full extent, not just on
 * whichever line happens to contain its opening delimiter (see
 * enclosingCallHasAssertBody's docstring for the gap this closes). Rules 1
 * (isLeadingCommentPin) and 3 (isSelfReferencingHeaderPin) still receive
 * the RAW line, unmasked — both are inherently ABOUT comment-shaped or
 * header-shaped text, so masking away the very comment markers or
 * cross-reference text they key off of would make them never fire at all;
 * see the module docstring for why they were never part of this root
 * cause.
 *
 * @param {string} text
 * @param {string} id
 * @param {string} fileBasename - basename(file), for the self-header rule.
 * @returns {{ line: number, kind: 'leading-comment'|'title'|'self-header'|'assert-line'|'none' }[]}
 */
export function findStructuralPinHits(text, id, fileBasename) {
  const lines = text.split('\n');
  const spans = scanNonCodeSpans(text);
  const codeOnlyLines = applyMask(text, spans, CODE_ONLY_MASK_KINDS).split('\n');
  const proseMaskedLines = applyMask(text, spans, PROSE_MASK_KINDS).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(id)) continue;
    if (isTestTitlePin(lines, codeOnlyLines, i, id)) hits.push({ line: i + 1, kind: 'title' });
    else if (isLeadingCommentPin(line, id)) hits.push({ line: i + 1, kind: 'leading-comment' });
    else if (isSelfReferencingHeaderPin(line, id, fileBasename, i)) hits.push({ line: i + 1, kind: 'self-header' });
    else if (isSameLineAssertArgumentPin(line, codeOnlyLines[i], proseMaskedLines[i], id)) hits.push({ line: i + 1, kind: 'assert-line' });
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
