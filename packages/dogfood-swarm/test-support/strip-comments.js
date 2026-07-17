/**
 * Shared test-support comment stripper — the single replacement for the five
 * near-identical per-file `stripComments` / `stripCommentsForGrep` copies that
 * used to live in amend2-d3b-002-dispatch-tx.test.js, amend2-l3-003-collect-tx.test.js,
 * rewind.test.js, redrive.test.js, and wave2-4091637-5127-swarm-cp-pins.test.js.
 *
 * Why a scanner and not the old regex pair: the copies stripped block comments
 * FIRST, over raw text, so a `//` line comment whose PROSE contained the
 * two-character block-open sequence (a glob like `lib/**` does) opened a
 * phantom block comment that greedily ate real code up to the next unrelated
 * block-close anywhere in the file — a live wave-8 failure (an innocent
 * cli.js comment referencing `packages/dogfood-swarm/lib/**` silently deleted
 * the tail of cmdFindings from the scanned text). Reordering the two regexes
 * merely mirrors the bug: stripping `//` first truncates a one-line block
 * comment containing a URL at the `//` inside the URL, deleting its own
 * closer and reopening the greedy eat in the other direction. Live instances
 * of both hazard classes — and of string literals carrying comment-lookalike
 * sequences — exist in the corpora these tests scan; the pin suite's
 * real-corpora smoke exercises them directly rather than trusting a count
 * written here (a wave-9 audit proved an earlier "measured N instances"
 * claim in this header unreproducible — counts rot, pins don't).
 *
 * States tracked: code, 'single-quoted', "double-quoted", `template`
 * (including nested ${ ... } expressions, where code rules — and comments —
 * apply again), // line comments, block comments, and REGEX LITERALS.
 * Regex lexing exists because a regex body may legally contain bare quotes
 * (an odd count desynced an earlier revision's string tracker into a
 * persistent fake-string mode that left real comments unstripped — proven
 * live by a wave-9 audit against redrive.test.js's own import-rewriting
 * helper) or bare comment-lookalikes (a character class like [/*]). The
 * regex-vs-division decision uses the standard preceding-token heuristic:
 * a `/` after an operator, opener, statement keyword, or start-of-input
 * begins a regex; after a value (identifier, literal, closer) it is
 * division and passes through.
 *
 * String, template, and regex contents are preserved byte-for-byte. Line
 * comments are removed to end-of-line; block comments are replaced by their
 * internal newlines, so LINE NUMBERS ARE PRESERVED for every consumer that
 * maps a match back to a position.
 *
 * SCOPE, STATED PLAINLY — what this scanner still cannot do:
 *   - The regex-vs-division heuristic is token-local, not grammatical. The
 *     known residual: a regex literal immediately after a CLOSER or value
 *     (e.g. `(cond) ? x : /re/`. after `:` is fine, but `(a) /re/.test(s)`
 *     is read as division) would pass through unlexed — harmless unless that
 *     regex also contains a comment-lookalike, the compound shape the pin
 *     suite documents as the residual boundary. ASI edge cases share this
 *     limit.
 *   - It strips comments; it does not otherwise normalize (no whitespace
 *     collapsing, no string joining).
 */

// Tokens after which a `/` begins a regex literal rather than division.
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

export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // `${` inside a template pushes an expression frame; `}` at that frame's
  // zero depth resumes the template body. Object-literal braces inside the
  // expression are depth-counted per frame.
  const frames = [];
  let braceDepth = 0;

  // Resumes verbatim template-body consumption after a backtick or a closed
  // `${ ... }` expression. Returns the new index. (Single shared helper —
  // an earlier revision hand-duplicated this loop twice; wave-9 F-002.)
  function consumeTemplateBody(from) {
    let j = from;
    while (j < n) {
      if (source[j] === '\\') { out += source[j] + (source[j + 1] ?? ''); j += 2; continue; }
      if (source[j] === '`') { out += source[j]; j++; return j; }
      if (source[j] === '$' && source[j + 1] === '{') {
        out += '${';
        j += 2;
        frames.push({ braceDepth });
        braceDepth = 0;
        return j; // main loop takes over inside the expression
      }
      out += source[j];
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2; // past the closing star-slash (or off the end when unterminated)
      continue;
    }
    // regex literal — lexed so bare quotes / comment-lookalikes inside a
    // regex body cannot desync the scanner (wave-9 F-001)
    if (c === '/' && regexFollows(out)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') { out += r + (source[i + 1] ?? ''); i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { out += r; i++; break; }
        out += r;
        i++;
      }
      while (i < n && /[a-z]/i.test(source[i])) { out += source[i]; i++; } // flags
      continue;
    }
    if (c === "'" || c === '"') {
      out += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        out += source[i];
        i++;
      }
      if (i < n) { out += source[i]; i++; }
      continue;
    }
    if (c === '`') {
      out += c;
      i = consumeTemplateBody(i + 1);
      continue;
    }
    if (c === '{') { braceDepth++; out += c; i++; continue; }
    if (c === '}') {
      if (braceDepth === 0 && frames.length > 0) {
        out += c;
        braceDepth = frames.pop().braceDepth;
        i = consumeTemplateBody(i + 1);
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
