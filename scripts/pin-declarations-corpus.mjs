/**
 * pin-declarations-corpus.mjs — the append-only adversarial fixture corpus
 * (dispatch C9, findings 24/25/28).
 *
 * "Metamorphic testing driven by an analyzer's own historical confirmed-bug
 * reports found 14 new false negatives/positives... each of our seven
 * historical leaks becomes a GENERALIZED RELATION, not a fixed regression
 * test. The history is a generator." (finding 28) "Test variants derived
 * from real executed programs... real-derived variants trigger bugs
 * synthetic generation misses... seed the adversarial corpus from the seven
 * real historical evasions, not synthetic cases alone." (finding 25)
 *
 * Every entry below is a REAL evasion this domain actually found against the
 * retired text-heuristic gate (scripts/check-finding-regression-pins.mjs at
 * 860ed73, before this wave) — not an invented worst-case. Each pairs:
 *   - `evasionCode`: the historical leak shape, unmodified in spirit (id
 *     present in prose/comment/string/regex/template text, NO `@pins` tag)
 *     — under the new mechanism this MUST credit nothing, by construction
 *     (dispatch C1: a comment/string/template/regex body is not a tag
 *     position, so there is no code path left that could grant it).
 *   - `declaredCode`: the same underlying test scenario, expressed with a
 *     real `@pins` tag — MUST credit `targetId`, proving the fix isn't
 *     "credit nothing ever" but specifically "credit only real declared
 *     links."
 *
 * APPEND-ONLY DISCIPLINE (finding 24/28 — load-bearing, not a suggestion):
 * every future audit's evasion joins this array permanently. Do not remove
 * or rewrite an existing entry to "clean up" — this repo's own "don't
 * normalize history for aesthetics" norm (CLAUDE.md) applies here exactly.
 * pin-declarations.test.mjs and pin-declarations-differential.test.mjs both
 * iterate this array generically, so appending a new entry automatically
 * extends the metamorphic suite AND the differential cross-check with zero
 * additional wiring — that automatic extension is what makes "append-only"
 * a structural property of the corpus rather than a comment someone can
 * forget to honor.
 *
 * Every `evasionCode`/`declaredCode` pair uses a DISTINCT synthetic id
 * (F-1000xx-0yy) so corpus entries can never collide with each other or with
 * a real repo id, and reads clearly as "test data," matching this repo's own
 * convention of never planting a real tracked id inside an illustrative
 * fixture (see the retired module's rule-2/rule-4 docstrings for the same
 * discipline).
 */

export const PIN_DECLARATION_CORPUS = [
  {
    name: 'bracket-and-char-class-depth',
    origin: 'F-16275dfd / F-f37bb9ae — unbalanced/character-class brackets inside a regex literal used to desync the old bracket-depth body scan',
    targetId: 'F-100000-072',
    evasionCode: `
test('F-100000-072: regex char class case', () => {
  const re = /[(]/;
  assert.ok(re.test('('));
});
`,
    declaredCode: `
/** @pins F-100000-072 */
test('regex char class case', () => {
  const re = /[(]/;
  assert.ok(re.test('('));
});
`,
  },
  {
    name: 'title-prose-empty-body',
    origin: 'F-ec9622fd — a title match sitting above a genuinely empty callback earned full credit on textual placement alone',
    targetId: 'F-100000-073',
    evasionCode: `
test('F-100000-073: unrelated smoke test', () => {});
`,
    declaredCode: `
/** @pins F-100000-073 */
test('unrelated smoke test, now with real coverage', () => {
  assert.ok(true);
});
`,
  },
  {
    name: 'escaped-quote-title',
    origin: "F-e003b1fb — an escaped quote inside a single-quoted title truncated the pre-wave-16 escape-blind regex, exposing the title's assert-shaped prose",
    targetId: 'F-100000-074',
    evasionCode: `
test('doesn\\'t get fooled: F-100000-074 case, assert this', () => {});
`,
    declaredCode: `
/** @pins F-100000-074 */
test('doesn\\'t get fooled by an escaped quote', () => {
  assert.ok(true);
});
`,
  },
  {
    name: 'comment-prose',
    origin: 'F-234da564 — an ordinary comment mentioning both an id and the bare word "assert", nowhere near a test/describe block, granted assert-line credit',
    targetId: 'F-100000-075',
    evasionCode: `
// this comment mentions F-100000-075 and the word assert but proves nothing
function unrelated() {}
`,
    declaredCode: `
/** @pins F-100000-075 */
test('has real coverage instead of a narrating comment', () => {
  assert.ok(true);
});
`,
  },
  {
    name: 'string-prose',
    origin: 'F-234da564 — a plain console.log() string literal mentioning an id and "assert", with no real assertion on the line, granted credit',
    targetId: 'F-100000-076',
    evasionCode: `
function noise() {
  console.log('F-100000-076 assert nothing here');
}
`,
    declaredCode: `
/** @pins F-100000-076 */
test('has real coverage instead of a log line', () => {
  assert.ok(true);
});
`,
  },
  {
    name: 'regex-literal-spelling-assert',
    origin: 'F-9c41a2b7 / F-f37bb9ae — a regex literal\'s PATTERN TEXT (not a bracket) literally spelling "assert" satisfied the old assert-line check with zero real assertion',
    targetId: 'F-100000-077',
    evasionCode: `
function checkPattern() {
  const re = /F-100000-077 assert/;
  return re;
}
`,
    declaredCode: `
/** @pins F-100000-077 */
test('has a real assertion, not a pattern that spells the word', () => {
  assert.ok(true);
});
`,
  },
  {
    name: 'template-literal-unindented-continuation',
    origin: 'F-6573391e (wave 18) — an unindented continuation line of a multi-line template-literal constant satisfied isLeadingCommentPin\'s bare startsWith(id) fallback with zero comment syntax',
    targetId: 'F-100000-078',
    evasionCode: `
const CHANGELOG = \`Recent fixes:
F-100000-078 nothing here actually tests the fix, this is just changelog prose
Other unrelated entries continue below.\`;
`,
    declaredCode: `
/** @pins F-100000-078 */
test('has real coverage instead of a changelog blob', () => {
  assert.ok(true);
});
`,
  },
  {
    name: 'id-after-template-interpolation-in-title',
    origin: 'F-b00fb0d0 (wave 18) — matchTestCallStart\'s per-line rescan truncated a template-literal title at the first ${...}, silently dropping an id positioned after the interpolation from title credit (and, on a later assert line, from any credit at all)',
    targetId: 'F-100000-079',
    evasionCode: `
test(\`dynamic \${label}: F-100000-079 check\`, () => {
  const result = compute(label);
  assert.equal(result, expected);
});
`,
    declaredCode: `
/** @pins F-100000-079 */
test(\`dynamic \${label} check\`, () => {
  const result = compute(label);
  assert.equal(result, expected);
});
`,
  },
];
