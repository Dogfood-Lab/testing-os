/**
 * pin-declarations.mjs — the Tier-1 declared-link matcher (dispatch C1-C3,
 * C7; see docs/pin-matcher-rewrite.dispatch.md).
 *
 * Wave 18 replaces check-finding-regression-pins.mjs's text-heuristic credit
 * rules (isLeadingCommentPin / isTestTitlePin / isSelfReferencingHeaderPin /
 * isSameLineAssertArgumentPin — now living in suggest-pins.mjs as a demoted
 * candidate generator, see that file) with this: a test earns Class #14
 * credit ONLY by carrying a schema'd `@pins <F-id>` tag in a comment that is
 * a REAL AST leading-comment of a real test()/it()/describe() call — read
 * from an actual parse, never inferred from text position.
 *
 *   ```js
 *   /** @pins F-e003b1fb *\/
 *   test('escaped-quote title does not defeat the title mask', () => { … });
 *   ```
 *
 * This collapses the false-grant class BY CONSTRUCTION (dispatch C1): a
 * template-literal continuation line, a regex-literal body, a test title, or
 * comment prose can no longer accidentally look like a pin, because credit
 * now requires a declared tag in a defined AST position, not an id that
 * happens to sit near a word. The seven historical leak shapes this domain
 * has found (bracket/char-class depth, test-title prose, escaped-quote
 * titles, comment prose, string prose, regex-literal bodies spelling
 * "assert", and F-6573391e's raw-line startsWith) are NOT individually
 * patched here — none of them are `@pins`-tag-shaped, so none of them can
 * produce a credit decision through this code path at all. See
 * pin-declarations.test.mjs's "historical leak corpus" suite for the proof,
 * and pin-declarations-corpus.mjs for the generalized-relation fixtures
 * (dispatch findings 26-28).
 *
 * SUBSTRATE (dispatch C2, findings 3/4/31/34/35): `@babel/parser` with the
 * `estree` plugin, already resolved in this repo's lockfile at 7.29.3 (a
 * transitive dependency of vite/vitest, confirmed present at that exact
 * version in node_modules and package-lock.json) — not the TypeScript
 * compiler's scanner
 * (finding 3, refuted by the scanner's own authors), not a hand-rolled
 * tokenizer (finding 4, refuted by js-tokens' own maintainer), and not the
 * TypeScript compiler API / typescript-eslint (finding 34 — internal-API
 * drift for type information this gate never needs). One parser, not two:
 * `@babel/parser` combined with the `typescript` plugin parses `.ts`/`.tsx`
 * to the same ESTree-shaped CallExpression/Literal/TemplateLiteral/Comment
 * nodes this file walks for `.js`/`.mjs`/`.cjs`/`.jsx` — verified empirically
 * against all 339 real *.test.{js,mjs,cjs,ts,tsx} files in this repo before
 * this design was committed to (zero parse failures). DEVIATION FROM THE
 * DISPATCH'S LITERAL WORDING, DISCLOSED: C2 names "espree/acorn natively...
 * the ESTree-compatible TS parser" as the illustrative substrate; neither is
 * in this repo's dependency tree (verified: grepped package-lock.json for
 * acorn/espree/typescript-estree — zero hits), while `@babel/parser` +
 * `@babel/types` both already are. A single already-resolved parser
 * satisfying every C2 requirement (ESTree-shaped, comment-attached, no type
 * information, not the compiler's internal API) is a strictly smaller
 * dependency footprint than adding a JS parser AND a separate TS parser, and
 * @babel/traverse was deliberately NOT added alongside it — this file's own
 * `forEachNode` (below) is a ~20-line generic tree walk sufficient for
 * "find which node owns this leading comment," and a full traversal-with-
 * scope-analysis library is unjustified weight for that narrow need (rule 10:
 * match existing patterns, don't invent — a hand-rolled walk here is smaller
 * surface than a new heavyweight dependency for a job this contained).
 *
 * CROSS-DOMAIN FOLLOW-UP, RESOLVED (F-a544c1c4, wave 20 — corrects a
 * same-commit self-contradiction): this module imports `@babel/parser`
 * directly. At commit 132dc18 (the commit that shipped this file) it is a
 * DIRECT, declared dependency — `"@babel/parser": "^7.29.3"` was added to
 * root `package.json`'s `devDependencies` in that same commit (see
 * `package.json`, and that commit's own message: "Declared @babel/parser in
 * root package.json (no wave-18 domain owned the file; the gate's parser
 * was real but undeclared, surviving only on vitest's transitive
 * resolution)."). Verified at HEAD: `package.json` still carries the direct
 * devDependency today, alongside `package-lock.json`. An earlier draft of
 * this paragraph, written in the SAME commit, described a different final
 * decision — that the package.json edit had been made, verified, then
 * REVERTED as an out-of-domain change for a later wave to land — which was
 * superseded before the commit closed and was never true of the shipped
 * state. No functional impact either way: `@babel/parser` resolves
 * correctly, and has been a direct (not merely transitively-available)
 * dependency since 132dc18.
 *
 * FAIL-CLOSED (C7, findings 32/33): `errorRecovery` is left at its default
 * `false` — an unparseable file throws inside scanFileForDeclaredPins and the
 * caller (scanRepoForDeclaredPins) surfaces it as a `parseErrors` entry,
 * never a silently-skipped file. "Skipped" and "clean" are indistinguishable
 * to a gate (finding 32) — check-finding-regression-pins.mjs treats any
 * non-empty parseErrors as a hard, blocking defect (ok=false), the same
 * severity as a real orphan.
 *
 * SCOPE, DISCLOSED (not silently assumed — C6): this module only scans files
 * `classifyFile()` (parse-regression-pins.js) buckets as "test" — a `@pins`
 * tag written in a source file is not evaluated by this module at all. Tag
 * attachment is LEADING-only: a tag that Babel attaches as a trailing or
 * inner comment (e.g. written AFTER the call it's meant to describe) is
 * reported as `not-attached`, not silently credited — this matches the one
 * convention the dispatch documents (tag immediately BEFORE the call) rather
 * than inventing a second accepted position. A qualifying call is
 * `test(...)`/`it(...)`/`describe(...)`, optionally with ONE member-access
 * modifier (`test.skip(...)`, `it.only(...)`) or ONE `.each(...)(...)` call
 * chain (`test.each(table)(...)`) — verified against the live corpus
 * (grepped for `.each(` in every *.test.* file: zero live uses today, so
 * this is "supported, not currently exercised," the same evidentiary posture
 * this domain has used before for a mechanism proven-but-not-live).
 *
 * F-32441f8c, DISCLOSED (documentation-accuracy, not a laundering path):
 * every illustrative example in this file (and in docs/pin-matcher-rewrite.
 * dispatch.md / HANDOFF.md) writes the tag as a `/** @pins F-id *\/` JSDoc
 * block comment, but the mechanism itself never distinguishes Babel's
 * CommentBlock from CommentLine — `ast.comments` carries both uniformly and
 * neither this function nor scanFileForDeclaredPins filters by comment kind.
 * A bare `// @pins F-id` leading-comment line is credited IDENTICALLY to the
 * block form, and always has been (verified: scanFileForDeclaredPins on a
 * `// @pins F-id\ntest(...)` fixture credits the pin with zero issues — see
 * pin-declarations.test.mjs's dedicated F-32441f8c coverage). This is now a
 * STATED decision, not an accidental side effect of iterating ast.comments
 * generically: a `//` tag still requires the exact same correct AST
 * leading-comment attachment to a real qualifying call as the block form, so
 * no laundering path opens by accepting it — permissiveness here is
 * deliberate, chosen over narrowing the accepted grammar to match only the
 * documented illustrative form.
 */

import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';

import { F_ID_PATTERN, walkSourceFiles, classifyFile } from '../packages/portfolio/lib/parse-regression-pins.js';

/**
 * Anchored, single-token form of F_ID_PATTERN — F_ID_PATTERN itself carries
 * the `g` flag and is designed for scanning free text (see its own JSDoc);
 * reusing a `g`-flagged pattern across repeated `.test()` calls is a classic
 * `lastIndex` statefulness footgun, so a fresh, unflagged, anchored copy is
 * built from the SAME `.source` (never a hand-rolled second id grammar) once
 * here and reused for every tag-token validation.
 */
const F_ID_PATTERN_ANCHORED = new RegExp(`^(?:${F_ID_PATTERN.source})$`);

/**
 * Matches a genuine `@pins` JSDoc tag: `@pins` must be the FIRST substantive
 * token on its line (after optional leading whitespace and an optional
 * single `*` JSDoc continuation marker) — never merely appearing mid-
 * sentence. Anchored (not a bare `\b` scan) so this module's OWN docstrings
 * can say the word "@pins" in prose (as this file's and others' inevitably
 * do, documenting the very convention) without being misread as a malformed
 * tag attempt — caught for real during this wave's own development: a
 * prose sentence reading "...cannot carry a per-iteration @pins tag — a
 * static comment..." produced nine bogus bad-shape issues under the
 * earlier, unanchored `/@pins\b(.*)$/` pattern before this fix. Real JSDoc
 * tags always open their line by convention (`@param`, `@returns`, …);
 * requiring the same shape here is not an invented restriction.
 */
const PINS_TAG_LINE = /^\s*\*?\s*@pins\b(.*)$/;

const QUALIFYING_CALL_NAMES = new Set(['test', 'it', 'describe']);

const JS_PARSE_OPTS = {
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  attachComment: true,
  errorRecovery: false, // C7 / finding 33: fail closed, never best-effort recover.
  plugins: ['estree', 'jsx'],
};
const TS_PARSE_OPTS = { ...JS_PARSE_OPTS, plugins: ['estree', 'jsx', 'typescript'] };

function parseOptsFor(filePath) {
  return /\.tsx?$/.test(filePath) ? TS_PARSE_OPTS : JS_PARSE_OPTS;
}

/**
 * F-d36cd380: does `token` plausibly READ AS a botched attempt at one of
 * F_ID_PATTERN's three id grammars, as opposed to an ordinary word that
 * happens to start with a capital "F-"? The sole caller is the post-valid-id
 * branch inside {@link extractDeclaredIds} (below) — see that function's own
 * docstring for the F-d77ffe1a / F-a5f07b2b / F-d36cd380 history this
 * replaces.
 *
 * Normalizes THEN compares to grammar, rather than a literal prefix string
 * match: `^-*[fF]-?` strips a hyphen run glued directly to the token's front
 * (the tokenizer only splits on comma/whitespace, so "-F-2222222" arrives as
 * one token), case-folds the leading f/F, and tolerates a missing separator
 * hyphen right after it — so `f-2222222`, `F2222222`, and `-F-2222222` all
 * normalize to the SAME "2222222" body. What follows must then fall within
 * one character of an ACTUAL F_ID_PATTERN body (hex-dense ~8 chars,
 * digit-dense ~9 chars split by one optional hyphen, or an uppercase-alnum
 * run ending in a ~3-digit suffix) — not merely start with the right two
 * characters. The one-character tolerance is deliberately narrow (a single
 * fat-finger typo), not "contains some digits/hex," so a body that is merely
 * short (`16`) or merely alphabetic-but-not-hex (`strings`, `test`) fails
 * every branch and is correctly read as ordinary prose, not an id attempt.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeIdAttempt(token) {
  const m = /^-*[fF]-?(.+)$/.exec(token);
  if (!m) return false;
  const body = m[1];

  // HASH near-miss (F_ID_PATTERN branch 2: exactly 8 lowercase hex chars).
  // Case-insensitive: a hex-typo'd hash id is the same class of near-miss as
  // a case-typo'd prefix, not a different one.
  if (/^[0-9a-f]+$/i.test(body) && Math.abs(body.length - 8) <= 1) return true;

  // LEGACY near-miss (F_ID_PATTERN branch 1: 6 digits, hyphen, 3 digits).
  // Only the TOTAL digit count is compared against the required 9 — the
  // hyphen may be absent or shifted by a fat-finger without changing which
  // real id was intended.
  if (/^\d+-?\d+$/.test(body)) {
    const digitCount = body.replace('-', '').length;
    if (Math.abs(digitCount - 9) <= 1) return true;
  }

  // PREFIXED near-miss (F_ID_PATTERN branch 3: uppercase-alnum segment(s)
  // ending in a 3-digit suffix) — tolerate the suffix run being one digit
  // short or long.
  if (/^[A-Z][A-Z0-9-]*$/.test(body)) {
    const suffix = /-?(\d+)$/.exec(body);
    if (suffix && Math.abs(suffix[1].length - 3) <= 1) return true;
  }

  return false;
}

/**
 * Split one `@pins` comment's raw value into declared tokens, one entry per
 * token, each already shape-checked against F_ID_PATTERN_ANCHORED. A line
 * with `@pins` but nothing after it produces one `{ token: null }` entry
 * (the "empty tag" defect) rather than silently contributing zero pins.
 *
 * F-d77ffe1a: once at least one well-formed id has been accepted on the
 * line, the FIRST subsequent token that fails F_ID_PATTERN AND does not
 * itself look like an id attempt ends id-scanning — everything from that
 * token onward is treated as a free-text description, not further tokens
 * to validate. This is what lets the natural, JSDoc-conventional
 * `@pins F-id - explanation` style (the same `@tag value - description`
 * shape `@param name - description` already uses) credit the id without
 * also raising one bad-shape issue per whitespace-delimited word of prose.
 * Before any valid id has been found, every failing token is still reported
 * as bad-shape (unchanged from before this fix) — a genuinely malformed tag
 * (`@pins NOT-AN-ID`, nothing valid anywhere on the line) must still be a
 * defect, never silently swallowed as "just description text."
 *
 * F-a5f07b2b: F-d77ffe1a's original fix over-corrected — it treated EVERY
 * post-valid-id failing token as free text, including one that is itself
 * id-shaped-but-wrong (e.g. a hash-style id one hex digit short of a real
 * second pin declared elsewhere in the same fixture). That silently
 * dropped a realistic typo that, before F-d77ffe1a, correctly blocked the
 * gate as a bad-shape tagIssue. Every F_ID_PATTERN alternative shares the
 * literal "F-" prefix (see that pattern's own definition in
 * parse-regression-pins.js — legacy F-NNNNNN-NNN, hash F-xxxxxxxx, or
 * prefixed F-AAA-NNN all start "F-"), so a failing token that starts with
 * "F-" is still trying to be an id, not describing a fix in prose —
 * natural JSDoc prose is very unlikely to contain a bare "F-" + several
 * more characters by coincidence. Only a token that does NOT start with
 * "F-" is treated as the start of free text, preserving F-d77ffe1a's fix
 * for the case it actually targeted (`@pins F-id - explanation`) while
 * restoring the bad-shape signal for a mistyped second id.
 *
 * F-d36cd380: F-a5f07b2b's own fix was ITSELF instance-shaped, not
 * class-shaped — SUPERSEDES that paragraph's literal-prefix mechanism (the
 * paragraph above is kept as historical record, per this repo's "don't
 * normalize history for aesthetics" norm; it no longer describes the code
 * below). A literal, case-sensitive, no-separator-tolerant
 * `token.startsWith('F-')` check both UNDER-catches — three real near-miss
 * typos of the exact hash-id shape F-a5f07b2b was filed to restore coverage
 * for still silently vanished as free text: a lowercase-f case typo
 * (`f-2222222`), a missing internal hyphen (`F2222222`), and a hyphen glued
 * to the token's front instead of separated by whitespace (`-F-2222222`,
 * which arrives as ONE token because the tokenizer only splits on comma/
 * whitespace) — and OVER-catches: ordinary hyphenated prose that happens to
 * start with a capital "F-" (`F-strings`, `F-16`, `F-test`) was wrongly
 * flagged as a blocking bad-shape tagIssue instead of the free text
 * F-d77ffe1a's fix exists to permit. `looksLikeIdAttempt` (below) replaces
 * the literal prefix string-match with a normalize-then-compare-to-grammar
 * heuristic: fold prefix case and tolerate a glued/missing separator, THEN
 * require what remains to fall within one character of one of
 * F_ID_PATTERN's three actual id-body shapes (hex-dense ~8 chars,
 * digit-dense ~9 chars, or an uppercase-alnum run ending in a ~3-digit
 * suffix) — not merely start with two particular characters. That is what
 * lets the three demonstrated near-misses above (all the SAME botched hash
 * id, differing only in prefix spelling) report bad-shape, while
 * `F-strings` / `F-16` / `F-test` (none of them digit- or hex-dense at a
 * plausible id-body length) fall through to free text, unchanged from
 * F-d77ffe1a's original intent. See looksLikeIdAttempt's own docstring for
 * the exact tolerance windows, and this file's test suite for the four
 * demonstrated shapes verified directly.
 *
 * @param {string} commentValue - Babel Comment.value (delimiters stripped).
 * @returns {{ token: string | null, ok: boolean }[]}
 */
export function extractDeclaredIds(commentValue) {
  const out = [];
  for (const rawLine of commentValue.split('\n')) {
    const m = PINS_TAG_LINE.exec(rawLine);
    if (!m) continue;
    const tokens = m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      out.push({ token: null, ok: false });
      continue;
    }
    let foundValid = false;
    for (const token of tokens) {
      const ok = F_ID_PATTERN_ANCHORED.test(token);
      if (ok) {
        out.push({ token, ok: true });
        foundValid = true;
        continue;
      }
      if (foundValid) {
        // F-d36cd380: a failing token that still LOOKS LIKE a botched id
        // attempt (see looksLikeIdAttempt's own docstring) reads as one, not
        // prose — report it and keep scanning. Anything else is the
        // free-text description F-d77ffe1a's fix exists to stop validating
        // against F_ID_PATTERN. (Supersedes F-a5f07b2b's literal
        // `token.startsWith('F-')` check — see extractDeclaredIds' own
        // docstring for why that check was itself instance-shaped.)
        if (looksLikeIdAttempt(token)) {
          out.push({ token, ok: false });
          continue;
        }
        break; // F-d77ffe1a: remainder of the line is a free-text description, not more id attempts.
      }
      out.push({ token, ok: false });
    }
  }
  return out;
}

// Node properties that are never semantically-meaningful children for this
// walk's purposes — skipped so forEachNode doesn't waste cycles descending
// into position bookkeeping, and so a `comments` back-reference (were one
// ever added upstream) can't turn the walk into a cycle.
const WALK_SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra',
  'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens',
]);

/**
 * Generic recursive walk over every AST node reachable from `root`, calling
 * `visit(node)` once per node. Deliberately property-introspective rather
 * than a per-type children table (contrast the old file's hand-maintained
 * STATEMENT_LIST_KEYS-style approach) — a raw `@babel/parser` output has no
 * parent back-references (those are a `@babel/traverse` NodePath concept,
 * never added at parse time), so a plain object tree walk is cycle-safe and
 * cannot under-cover a node shape this module's authors didn't anticipate
 * (e.g. an IIFE, a `const x = describe(...)` assignment, a `.forEach(fn)`
 * parametrized-test helper) — every one of those is just "a node with more
 * nodes inside it" to this walk, with no per-shape special-casing needed.
 *
 * @param {object} root
 * @param {(node: object) => void} visit
 */
export function forEachNode(root, visit) {
  const seen = new Set();
  (function walk(value) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (typeof value.type === 'string') visit(value);
    for (const key of Object.keys(value)) {
      if (WALK_SKIP_KEYS.has(key)) continue;
      walk(value[key]);
    }
  })(root);
}

/**
 * Resolve a CallExpression's callee down to the base `test`/`it`/`describe`
 * identifier name, or null if the shape doesn't lead to one. Handles three
 * shapes: a bare call (`test(...)`), one member-access modifier
 * (`test.skip(...)`), and one `.each(...)(...)` call chain
 * (`test.each(table)(...)`) — see module docstring for why `.each` is
 * supported-but-unverified-live.
 *
 * @param {object} callee
 * @returns {string | null}
 */
function calleeBaseName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    return callee.object.name;
  }
  if (callee.type === 'CallExpression') return calleeBaseName(callee.callee);
  return null;
}

function looksLikeTitleArg(node) {
  if (!node) return false;
  if (node.type === 'TemplateLiteral') return true;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'StringLiteral') return true; // defensive: non-estree Babel node shape
  return false;
}

/**
 * @param {object} node
 * @returns {boolean} true iff `node` is a CallExpression shaped like
 *   test(title, fn) / it(title, fn) / describe(title, fn), a single-modifier
 *   variant, or an `.each` chain, with a string/template title as its first
 *   argument.
 */
export function isQualifyingTestCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const name = calleeBaseName(node.callee);
  if (!name || !QUALIFYING_CALL_NAMES.has(name)) return false;
  if (node.arguments.length < 1) return false;
  return looksLikeTitleArg(node.arguments[0]);
}

function extractTitle(call) {
  const first = call.arguments[0];
  if (first.type === 'TemplateLiteral') {
    return first.quasis.map((q) => q.value.raw).join('${…}');
  }
  return typeof first.value === 'string' ? first.value : null;
}

/**
 * Given the AST node a leading comment attaches to, find the qualifying
 * test call it declares a pin for, if any. Covers three shapes:
 *   - a direct `ExpressionStatement` (the documented convention, `test(...)`
 *     as its own statement);
 *   - a `const x = test(...)` VariableDeclaration binding;
 *   - F-d9cdcff2: a bare CallExpression host — the shape Babel attaches a
 *     leading comment to when the tagged call is itself an ARRAY ELEMENT,
 *     e.g. a data-driven test table:
 *       `const cases = [ /** @pins F-id *\/ test('t', fn), ];`
 *     The comment attaches to the `test('t', fn)` CallExpression node
 *     directly (there is no enclosing statement or declarator inside an
 *     array literal), so without this branch the tag reported a false
 *     `wrong-node` orphan even though the call genuinely executes.
 * A generic walk (forEachNode) has no reason to privilege any one of the
 * three over the others, since all reach the SAME underlying question:
 * "does this host resolve to a qualifying call?"
 *
 * DELIBERATELY NOT covering an IIFE wrapper
 * (`/** @pins F-id *\/ (function () { test('t', fn); })();`) or an
 * arrow-function variable indirection
 * (`/** @pins F-id *\/ const wrapper = () => test('t', fn); wrapper();`):
 * in both, the comment attaches to a REAL node this function inspects (the
 * IIFE's own ExpressionStatement; the VariableDeclaration whose declarator
 * init is an ArrowFunctionExpression, not a CallExpression) but that node
 * does not itself resolve to a qualifying call — correctly reported as
 * `wrong-node`, per F-d9cdcff2's own fix note that these two are out of
 * scope (least realistic of the three surveyed shapes; no live use in this
 * repo's corpus either way).
 *
 * @param {object | null} hostNode
 * @returns {object | null}
 */
function qualifyingCallFromHost(hostNode) {
  if (!hostNode) return null;
  if (hostNode.type === 'ExpressionStatement' && isQualifyingTestCall(hostNode.expression)) {
    return hostNode.expression;
  }
  if (hostNode.type === 'VariableDeclaration') {
    for (const decl of hostNode.declarations ?? []) {
      if (decl.init && isQualifyingTestCall(decl.init)) return decl.init;
    }
  }
  if (isQualifyingTestCall(hostNode)) return hostNode;
  return null;
}

/**
 * Index every node's leadingComments by comment start offset, once per file,
 * so per-comment lookup below is O(1) instead of re-walking the tree per
 * comment. `!index.has` keeps the FIRST (outermost-visited) owner if a
 * comment object were ever attached to more than one node — not observed in
 * practice, but a defined tie-break beats an unspecified one.
 *
 * @param {object} programAst
 * @returns {Map<number, object>}
 */
function buildLeadingCommentIndex(programAst) {
  const index = new Map();
  forEachNode(programAst, (node) => {
    if (!Array.isArray(node.leadingComments)) return;
    for (const c of node.leadingComments) {
      if (!index.has(c.start)) index.set(c.start, node);
    }
  });
  return index;
}

/**
 * Scan one file's text for declared `@pins` tags, from a real parse.
 *
 * @param {string} filePath - used only to pick JS vs TS parse plugins and to
 *   stamp `file` on returned records; not read unless `textOverride` is
 *   omitted.
 * @param {string} [textOverride] - injection point for tests / callers that
 *   already have the text in memory.
 * @returns {{
 *   file: string,
 *   parseError: { message: string, line: number|null, column: number|null } | null,
 *   pins: { id: string, file: string, line: number|null, title: string|null }[],
 *   issues: { file: string, line: number|null, kind: 'empty-tag'|'bad-shape'|'wrong-node'|'not-attached', token: string|null, detail: string }[],
 * }}
 */
export function scanFileForDeclaredPins(filePath, textOverride) {
  // F-d1e38dd0: the read itself can throw (file deleted between
  // walkSourceFiles' listing and this read, a permissions error, or any
  // other I/O fault — plausible under concurrent CI filesystem activity).
  // Caught HERE, in its own branch, and reported as the same parseErrors-
  // shaped record a parse failure produces, so one unreadable file degrades
  // gracefully into a per-file blocking defect (C7) rather than an
  // uncaught throw that takes the whole gate down (no results for ANY
  // file, not just the offending one). `??` (not `!==`) matches the
  // original nullish-coalescing semantics exactly: an explicit `null`
  // override still falls through to a real read, same as before this fix.
  let text = textOverride;
  if (text === undefined || text === null) {
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      return {
        file: filePath,
        parseError: { message: `failed to read file: ${err.message}`, line: null, column: null },
        pins: [],
        issues: [],
      };
    }
  }
  let ast;
  try {
    ast = parse(text, parseOptsFor(filePath));
  } catch (err) {
    return {
      file: filePath,
      parseError: {
        message: err.message,
        line: err.loc?.line ?? null,
        column: err.loc?.column ?? null,
      },
      pins: [],
      issues: [],
    };
  }

  const leadingIndex = buildLeadingCommentIndex(ast.program);
  const pins = [];
  const issues = [];

  for (const comment of ast.comments ?? []) {
    const tagTokens = extractDeclaredIds(comment.value);
    if (tagTokens.length === 0) continue; // this comment carries no @pins tag at all

    const hostNode = leadingIndex.get(comment.start) ?? null;
    const call = qualifyingCallFromHost(hostNode);
    const title = call ? extractTitle(call) : null;
    const line = comment.loc?.start?.line ?? null;

    for (const { token, ok } of tagTokens) {
      if (token === null) {
        issues.push({ file: filePath, line, kind: 'empty-tag', token: null, detail: '@pins tag has no id token after it' });
        continue;
      }
      if (!ok) {
        issues.push({ file: filePath, line, kind: 'bad-shape', token, detail: `"${token}" is not a well-formed F-id (see F_ID_PATTERN)` });
        continue;
      }
      if (!call) {
        issues.push({
          file: filePath,
          line,
          kind: hostNode ? 'wrong-node' : 'not-attached',
          token,
          detail: hostNode
            ? `@pins ${token} is attached to a ${hostNode.type}, not a test()/it()/describe() call`
            : `@pins ${token} is not a leading comment of any statement (check it sits immediately before the test call, not after)`,
        });
        continue;
      }
      pins.push({ id: token, file: filePath, line, title });
    }
  }

  return { file: filePath, parseError: null, pins, issues };
}

/**
 * @param {string} rootDir
 * @returns {string[]} absolute paths of every file classifyFile() buckets as
 *   "test" under rootDir — see module docstring's SCOPE paragraph for why
 *   only test files are scanned.
 */
export function defaultWalkTestFiles(rootDir) {
  return walkSourceFiles(rootDir).filter((f) => classifyFile(f) === 'test');
}

/**
 * Repo-wide declared-pin scan: the Tier-1 gate's actual evidence source.
 *
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {(rootDir: string) => string[]} [opts.walkFiles]
 * @returns {{
 *   byId: Map<string, { id: string, file: string, line: number|null, title: string|null }[]>,
 *   issues: object[],
 *   parseErrors: { file: string, message: string, line: number|null, column: number|null }[],
 *   filesScanned: number,
 * }}
 */
export function scanRepoForDeclaredPins(rootDir, { walkFiles = defaultWalkTestFiles } = {}) {
  const files = walkFiles(rootDir);
  const byId = new Map();
  const issues = [];
  const parseErrors = [];

  for (const file of files) {
    const result = scanFileForDeclaredPins(file);
    if (result.parseError) {
      parseErrors.push({ file, ...result.parseError });
      continue; // C7: this file's pins are UNDETERMINED, never counted as either credited or clean.
    }
    issues.push(...result.issues);
    for (const pin of result.pins) {
      const arr = byId.get(pin.id);
      if (arr) arr.push(pin);
      else byId.set(pin.id, [pin]);
    }
  }

  return { byId, issues, parseErrors, filesScanned: files.length };
}
