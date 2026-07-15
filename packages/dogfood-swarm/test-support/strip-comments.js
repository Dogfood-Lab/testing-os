/**
 * Shared test-support comment stripper — the single replacement for the five
 * near-identical per-file `stripComments` / `stripCommentsForGrep` copies that
 * used to live in amend2-d3b-002-dispatch-tx.test.js, amend2-l3-003-collect-tx.test.js,
 * rewind.test.js, redrive.test.js, and wave2-4091637-5127-swarm-cp-pins.test.js.
 *
 * Why a scanner and not the old regex pair: the copies stripped `/* ... star-slash`
 * blocks FIRST, over raw text, so a `//` line comment whose PROSE contained
 * the two-character sequence `/*` (a glob like `lib/**` does) opened a
 * phantom block comment that greedily ate real code up to the next unrelated
 * `star-slash` in the file — a live wave-8 failure (an innocent cli.js comment
 * referencing `packages/dogfood-swarm/lib/**` silently deleted the tail of
 * cmdFindings from the scanned text). Reordering the two regexes merely
 * mirrors the bug: stripping `//` first truncates a single-line
 * `/* see https://example.com star-slash` at the `//` inside the URL, deleting its
 * own closer and reopening the greedy eat in the other direction. Both
 * hazard classes exist in this repo's scanned sources today (measured
 * 2026-07-15: 2 block comments containing `//`, 9 one-line string literals
 * containing `/*` or `star-slash`), so the only honest fix is a single pass that
 * knows what state it is in.
 *
 * States tracked: code, 'single-quoted', "double-quoted", `template`
 * (including nested ${ ... } expressions, where code rules — and comments —
 * apply again), // line comments, and block comments. String and template
 * contents are preserved byte-for-byte (a glob or URL inside a string is
 * data, not a comment). Line comments are removed to end-of-line; block
 * comments are replaced by their internal newlines, so LINE NUMBERS ARE
 * PRESERVED for every consumer that maps a match back to a position.
 *
 * SCOPE, STATED PLAINLY — what this scanner still cannot do:
 *   - Regex literals are NOT lexed (the regex-vs-division ambiguity needs a
 *     parser). A regex literal whose body contains `//` or `/*` would be
 *     misread as a comment opener. Measured against the corpora these tests
 *     scan (cli.js, commands/*.js, and the self-scanning test files):
 *     zero such literals exist today; the pin test documents the boundary
 *     with an explicit expected-limitation case so a future violation is a
 *     conscious decision, not a silent surprise.
 *   - It strips comments; it does not otherwise normalize (no whitespace
 *     collapsing, no string joining).
 */

export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // Stack entries: 'tpl' for an open template literal. `${` inside a template
  // pushes back into code with the template's frame below; `}` while a 'tpl'
  // frame is below returns to it. A plain object-literal `}` inside the
  // expression is handled by depth-counting braces per expression frame.
  const frames = [];
  let braceDepth = 0;

  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    // line comment: drop to EOL, keep the newline
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // block comment: drop, emit internal newlines to preserve line numbers
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2; // past the closing */ (or off the end on an unterminated block)
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
      i++;
      // template body: verbatim until ` or ${
      tpl: while (i < n) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        if (source[i] === '`') { out += source[i]; i++; break; }
        if (source[i] === '$' && source[i + 1] === '{') {
          out += '${';
          i += 2;
          frames.push({ braceDepth });
          braceDepth = 0;
          // fall back to the main loop: code rules apply inside ${ ... };
          // the closing } is recognized below via the frames stack.
          break tpl;
        }
        out += source[i];
        i++;
      }
      continue;
    }
    if (c === '{') { braceDepth++; out += c; i++; continue; }
    if (c === '}') {
      if (braceDepth === 0 && frames.length > 0) {
        // closing a ${ ... } — resume the template body verbatim
        out += c;
        i++;
        braceDepth = frames.pop().braceDepth;
        while (i < n) {
          if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
          if (source[i] === '`') { out += source[i]; i++; break; }
          if (source[i] === '$' && source[i + 1] === '{') {
            out += '${';
            i += 2;
            frames.push({ braceDepth });
            braceDepth = 0;
            break;
          }
          out += source[i];
          i++;
        }
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
