/**
 * pin-declarations-reference.mjs — the independently-coded second matcher
 * (dispatch C9, finding 23: McKeeman, differential testing).
 *
 * "Differential testing... running independent implementations on identical
 * input and diffing... is the founding technique for exposing bugs where no
 * formal oracle exists." We have no formal oracle for "does this file
 * declare a valid pin" — Class #14 has burned this domain on hand-authored
 * heuristic oracles seven straight times. So instead of trusting
 * pin-declarations.mjs's AST-based verdict alone, a SECOND implementation
 * computes the same answer through a structurally different mechanism, and
 * pin-declarations-differential.test.mjs asserts they agree on every corpus
 * fixture and on the live repo tree. Disagreement is the bug signal — no
 * hand-authored oracle needed to know WHICH one is wrong, only that they
 * differ.
 *
 * WHAT IS SHARED, DISCLOSED (not silently duplicated nor silently reused
 * wholesale): the `@pins <id-list>` TAG GRAMMAR (extractDeclaredIds,
 * F_ID_PATTERN) is imported from pin-declarations.mjs verbatim. Forking that
 * grammar into a second copy would not buy independence where it matters —
 * a bug in "what characters make a well-formed F-id" is not the failure
 * mode either matcher exists to catch (that already has its own test
 * coverage in parse-regression-pins.test.js) — and it would risk the two
 * matchers silently drifting on what the TAG MEANS, which would make every
 * future disagreement noise instead of signal. What IS independently coded
 * — the actual defect surface for all seven historical leaks — is comment/
 * string/template classification and tag-to-call ATTACHMENT: this file uses
 * a hand-rolled single-pass character scanner and a regex-adjacency
 * attachment check; pin-declarations.mjs uses `@babel/parser` and a real
 * AST leading-comment index. Two different algorithms, two different bug
 * surfaces, same question.
 *
 * DISCLOSED, DELIBERATE WEAKER SPOTS (this is the SECONDARY, cross-checking
 * matcher — it does not need to be as complete as the primary, only
 * differently-shaped enough to catch what the primary might miss):
 *   - Regex-vs-division disambiguation reuses the same token-local
 *     preceding-character heuristic the old module's scanNonCodeSpans used
 *     (REGEX_PRECEDERS) — inherited limitation, not new here.
 *   - Attachment is REGEX-ADJACENCY (skip whitespace/blank lines after the
 *     comment, then match `/^(test|it|describe)(\.\w+)?\s*\(\s*['"`]/` or
 *     the `.each(...)(` chain) rather than true AST parent/child structure.
 *     A comment separated from its call by another, unrelated COMMENT (not
 *     just whitespace) is treated as `not-attached` by this matcher even in
 *     cases the primary's real parse might still resolve — a stricter, not
 *     laxer, divergence, and an intentional one: this matcher would rather
 *     under-credit than risk a second false-grant mechanism of its own.
 *   - No true nested-template `${...}` re-entry into code rules — a
 *     template literal is scanned as one opaque span from backtick to
 *     backtick, tracking only escaped backticks. This is DELIBERATE, not an
 *     oversight: the previous seven leaks all involved template/string/regex
 *     bodies being MISTAKEN for code or comments; a scanner that treats
 *     template interiors as fully opaque cannot make that class of mistake
 *     by construction, at the cost of not resolving a `@pins` tag that
 *     somehow lived inside a `${...}` interpolation's own comments (not a
 *     supported tag position in either matcher).
 *
 * These divergences are why pin-declarations-differential.test.mjs's corpus
 * cases are chosen to stay inside both matchers' agreed-supported shapes
 * (tag immediately before a call, on its own file, not inside an
 * interpolation) — a disagreement inside a KNOWINGLY-divergent edge is not a
 * bug signal, it is exactly the documented gap above. A disagreement
 * OUTSIDE those documented edges is the bug signal this file exists to
 * catch.
 */

import { readFileSync } from 'node:fs';
import { extractDeclaredIds } from './pin-declarations.mjs';

// Ported verbatim from the retired module's own regex-vs-division heuristic
// (see check-finding-regression-pins.mjs git history at 860ed73) — this is
// shared PRECEDENT, not shared CODE: no import, freshly transcribed, so a
// bug introduced into the primary's copy (there is no such copy anymore —
// the primary uses a real parser) cannot silently propagate here.
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-',
  '*', '%', '<', '>', '~', '^',
]);
const REGEX_PRECEDER_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete',
  'void', 'do', 'else', 'yield', 'await', 'throw',
]);

function regexFollowsHere(codeSoFar) {
  let j = codeSoFar.length - 1;
  while (j >= 0 && /\s/.test(codeSoFar[j])) j--;
  if (j < 0) return true;
  const char = codeSoFar[j];
  let k = j;
  while (k >= 0 && /[A-Za-z_$]/.test(codeSoFar[k])) k--;
  const word = codeSoFar.slice(k + 1, j + 1);
  if (REGEX_PRECEDER_KEYWORDS.has(word)) return true;
  return REGEX_PRECEDERS.has(char);
}

/**
 * Single-pass character scanner, independently written from
 * pin-declarations.mjs's forEachNode/buildLeadingCommentIndex — classifies
 * comment spans and returns them with enough position info to (a) extract
 * `@pins` tags and (b) look at what immediately follows.
 *
 * @param {string} source
 * @returns {{ start: number, end: number, value: string, kind: 'line'|'block' }[]}
 */
function scanComments(source) {
  const comments = [];
  let i = 0;
  let codeSoFar = '';
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : '';
    if (c === '/' && next === '/') {
      const start = i;
      i += 2;
      const valueStart = i;
      while (i < n && source[i] !== '\n') i++;
      comments.push({ start, end: i, value: source.slice(valueStart, i), kind: 'line' });
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      const valueStart = i;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      const valueEnd = i;
      i = Math.min(i + 2, n);
      comments.push({ start, end: i, value: source.slice(valueStart, valueEnd), kind: 'block' });
      continue;
    }
    if (c === '/' && regexFollowsHere(codeSoFar)) {
      // Regex literal — consume without treating its body as comment/code.
      codeSoFar += c;
      i++;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') { codeSoFar += r + (source[i + 1] ?? ''); i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { codeSoFar += r; i++; break; }
        codeSoFar += r;
        i++;
      }
      while (i < n && /[a-z]/i.test(source[i])) { codeSoFar += source[i]; i++; }
      continue;
    }
    if (c === "'" || c === '"') {
      codeSoFar += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { codeSoFar += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        codeSoFar += source[i];
        i++;
      }
      if (i < n) { codeSoFar += source[i]; i++; }
      continue;
    }
    if (c === '`') {
      // Opaque template span (see module docstring: deliberate, not an
      // oversight) — tracks only escaped backticks, never re-enters code
      // rules for ${...}.
      codeSoFar += c;
      i++;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { codeSoFar += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        codeSoFar += source[i];
        i++;
      }
      if (i < n) { codeSoFar += source[i]; i++; }
      continue;
    }
    codeSoFar += c;
    i++;
  }
  return comments;
}

const CALL_ADJACENCY = /^(?:test|it|describe)(?:\.\w+)?\s*\(\s*(?:['"`])/;
const CALL_EACH_ADJACENCY = /^(?:test|it|describe)\.each\s*\([^)]*\)\s*\(\s*(?:['"`])/s;

/**
 * @param {string} source
 * @param {number} fromIndex - position immediately after a comment's close
 *   marker, or line end.
 * @returns {boolean} true iff, skipping only whitespace, the next text is a
 *   qualifying test-call open — see module docstring for why this is
 *   stricter than the primary's true-AST attachment.
 */
function isAdjacentToQualifyingCall(source, fromIndex) {
  let i = fromIndex;
  while (i < source.length && /\s/.test(source[i])) i++;
  const rest = source.slice(i);
  return CALL_ADJACENCY.test(rest) || CALL_EACH_ADJACENCY.test(rest);
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Reference-implementation equivalent of pin-declarations.mjs's
 * scanFileForDeclaredPins — same INPUT/OUTPUT contract (so the differential
 * test can diff them directly), independently computed.
 *
 * @param {string} filePath
 * @param {string} [textOverride]
 * @returns {{ file: string, parseError: null, pins: {id:string,file:string,line:number|null,title:null}[], issues: object[] }}
 */
export function scanFileForDeclaredPinsReference(filePath, textOverride) {
  const text = textOverride ?? readFileSync(filePath, 'utf-8');
  const pins = [];
  const issues = [];

  for (const comment of scanComments(text)) {
    const tagTokens = extractDeclaredIds(comment.value);
    if (tagTokens.length === 0) continue;

    const attached = isAdjacentToQualifyingCall(text, comment.end);
    const line = lineOf(text, comment.start);

    for (const { token, ok } of tagTokens) {
      if (token === null) {
        issues.push({ file: filePath, line, kind: 'empty-tag', token: null, detail: '@pins tag has no id token after it' });
        continue;
      }
      if (!ok) {
        issues.push({ file: filePath, line, kind: 'bad-shape', token, detail: `"${token}" is not a well-formed F-id` });
        continue;
      }
      if (!attached) {
        issues.push({ file: filePath, line, kind: 'not-attached', token, detail: `@pins ${token} is not immediately adjacent to a qualifying test call` });
        continue;
      }
      // Title text is not extracted by this simpler matcher — the
      // differential test compares `id`/`file`/`line` sets, not titles.
      pins.push({ id: token, file: filePath, line, title: null });
    }
  }

  return { file: filePath, parseError: null, pins, issues };
}
