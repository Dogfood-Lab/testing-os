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
 *     boundary — but does NOT mask regex literals. A regex containing an
 *     unescaped bracket character (e.g. `assert.match(x, /\(fixme\)/)`) can
 *     still corrupt the depth count. Same class of gap as
 *     check-doc-drift.mjs's countCommandMapEntries pre-F-6cfe4d01 fix;
 *     unlike that resolver (a silent wrong COUNT), the failure direction
 *     here is closing the scanned span too early or too late, which either
 *     under-credits (fails closed, surfaces as a visible, actionable orphan
 *     — safe) or, less likely, over-scans into unrelated code. Distinguishing
 *     a regex-opening `/` from a division operator needs a real tokenizer;
 *     not attempted here for the same "no heavyweight parser dependency"
 *     reason countCommandMapEntries's own docstring gives.
 *   - Rule 2's call-body scan is bounded (STRUCTURAL_TITLE_BODY_LINE_LIMIT
 *     lines) and fails CLOSED past that bound (treated as "no body found",
 *     never a false grant) — an unproven pin surfaces as a visible orphan a
 *     human must resolve, not a silent miscount.
 *   - F-ec9622fd: rules 1 (leading-comment) and 3 (self-header) are still
 *     placement-only — neither requires the file to contain any test
 *     structure related to (or even near) the id; a comment that is merely
 *     the leading token of a line, or a header that names the file's own
 *     basename before the id, earns credit purely from where the text sits.
 *     Both are mutation-probe-gameable this way (a leading-comment floating
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

function isLeadingCommentPin(line, id) {
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
  return { title: m[2], openParenCol: m.index + m[0].indexOf('(') };
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
  const lastLine = Math.min(lines.length - 1, callLineIndex + STRUCTURAL_TITLE_BODY_LINE_LIMIT);
  for (let i = callLineIndex; i <= lastLine; i++) {
    const raw = i === callLineIndex ? lines[i].slice(openParenCol) : lines[i];
    const masked = maskCommentsAndStrings(raw);
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

function isSameLineAssertArgumentPin(line, id) {
  return STRUCTURAL_ASSERT_LINE.test(line) && line.includes(id);
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
