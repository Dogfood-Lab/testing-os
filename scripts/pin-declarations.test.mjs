/**
 * Tests for pin-declarations.mjs — the Tier-1 declared-link matcher.
 *
 * Coverage:
 *   1. Unit: extractDeclaredIds, isQualifyingTestCall, forEachNode shapes
 *   2. Historical-leak corpus (dispatch C9, findings 24/25/28): every entry
 *      in pin-declarations-corpus.mjs's evasionCode credits nothing, its
 *      declaredCode credits targetId — run generically over the array so
 *      appending a corpus entry extends this suite with zero new wiring.
 *   3. Metamorphic relations (dispatch C9, findings 26/27), permanent CI
 *      assertions: comment/dead-code insertion invariance, id-rename
 *      invariance — run generically over the corpus's declaredCode fixtures.
 *   4. A generator over the pin-syntax space (finding 24) — a combinatorial
 *      sweep of {comment style} x {position} x {adjacency}, asserting the
 *      single boolean invariant "credited iff declared AND attached."
 *   5. C7 fail-closed: unparseable file surfaces as parseError, never a
 *      silent skip.
 *   6. C3 schema validation: empty tag / bad shape / wrong node / not
 *      attached are each their own defect kind, never silently dropped.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  scanFileForDeclaredPins,
  scanRepoForDeclaredPins,
  extractDeclaredIds,
  isQualifyingTestCall,
  forEachNode,
} from './pin-declarations.mjs';
import { PIN_DECLARATION_CORPUS } from './pin-declarations-corpus.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Unit: extractDeclaredIds
// ─────────────────────────────────────────────────────────────────────────

describe('extractDeclaredIds', () => {
  test('single id, block-comment JSDoc shape', () => {
    const out = extractDeclaredIds('* @pins F-e003b1fb ');
    assert.deepEqual(out, [{ token: 'F-e003b1fb', ok: true }]);
  });

  test('single id, line-comment shape', () => {
    const out = extractDeclaredIds(' @pins F-e003b1fb');
    assert.deepEqual(out, [{ token: 'F-e003b1fb', ok: true }]);
  });

  test('multi-id comma list on one @pins line', () => {
    const out = extractDeclaredIds('* @pins F-aaaaaaaa, F-bbbbbbbb');
    assert.deepEqual(out, [
      { token: 'F-aaaaaaaa', ok: true },
      { token: 'F-bbbbbbbb', ok: true },
    ]);
  });

  test('multi-line JSDoc with @pins among other tags', () => {
    const out = extractDeclaredIds('*\n * @pins F-11112222\n * @param x - unrelated\n ');
    assert.deepEqual(out, [{ token: 'F-11112222', ok: true }]);
  });

  test('empty tag (nothing after @pins) is flagged, not silently dropped', () => {
    const out = extractDeclaredIds('* @pins ');
    assert.deepEqual(out, [{ token: null, ok: false }]);
  });

  test('bad-shape token is flagged, not silently dropped', () => {
    const out = extractDeclaredIds('* @pins NOT-AN-ID');
    assert.deepEqual(out, [{ token: 'NOT-AN-ID', ok: false }]);
  });

  test('unrelated JSDoc tag (@param) never matches — word-boundary precision', () => {
    const out = extractDeclaredIds('* @pinsomething F-e003b1fb');
    assert.deepEqual(out, []);
  });

  test('comment with no @pins tag at all yields empty array', () => {
    assert.deepEqual(extractDeclaredIds('just a normal comment about F-e003b1fb'), []);
  });

  test('a docstring PROSE sentence mentioning "@pins" mid-sentence is never treated as a tag attempt (caught live during this wave\'s own development — see PINS_TAG_LINE\'s docstring)', () => {
    const out = extractDeclaredIds(' this module cannot carry a per-iteration @pins tag — a static comment placed above a loop attaches to the loop itself');
    assert.deepEqual(out, [], 'a mid-sentence mention must yield zero tokens, not nine bogus bad-shape tokens');
  });

  test('@pins IS recognized when it opens the line even with a leading JSDoc "*" and surrounding indentation', () => {
    assert.deepEqual(extractDeclaredIds('   * @pins F-e003b1fb'), [{ token: 'F-e003b1fb', ok: true }]);
  });

  test('legacy id shapes (F-NNNNNN-NNN, F-AAA-NNN) validate through the SAME F_ID_PATTERN import', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-100000-001'), [{ token: 'F-100000-001', ok: true }]);
    assert.deepEqual(extractDeclaredIds('* @pins F-CI-SELF-DOGFOOD-001'), [{ token: 'F-CI-SELF-DOGFOOD-001', ok: true }]);
  });

  // F-d77ffe1a: a natural, JSDoc-conventional trailing description (the same
  // `@tag value - description` shape `@param name - description` uses) must
  // credit the id without also raising one bad-shape issue per word of prose.
  test('F-d77ffe1a: a trailing free-text description after a valid id does not raise a bad-shape issue per word', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-c1000003 - fixes the escaped quote bug'), [{ token: 'F-c1000003', ok: true }]);
  });

  test('F-d77ffe1a: a trailing free-text description after a MULTI-id comma list still credits every id and no prose token', () => {
    assert.deepEqual(
      extractDeclaredIds('* @pins F-aaaaaaaa, F-bbbbbbbb - covers two findings at once'),
      [{ token: 'F-aaaaaaaa', ok: true }, { token: 'F-bbbbbbbb', ok: true }],
    );
  });

  test('F-d77ffe1a: a genuinely malformed lone token is STILL flagged bad-shape (no valid id precedes it, so this is not "just description")', () => {
    assert.deepEqual(extractDeclaredIds('* @pins totally-not-an-id'), [{ token: 'totally-not-an-id', ok: false }]);
  });

  test('F-d77ffe1a: when NO valid id is EVER found on the line, every non-matching token is still flagged (unchanged outside the "free text after a valid id" scope this fix targets)', () => {
    // Contrast with the trailing-description case above: here nothing on the
    // line ever satisfies F_ID_PATTERN, so `foundValid` never becomes true —
    // this is a genuinely malformed tag, not natural prose after a real id,
    // and must stay loud (C3: a malformed tag is a defect, not a shrug).
    assert.deepEqual(extractDeclaredIds('* @pins totally-not-an-id and some'), [
      { token: 'totally-not-an-id', ok: false },
      { token: 'and', ok: false },
      { token: 'some', ok: false },
    ]);
  });

  /** @pins F-d77ffe1a */
  test('F-d77ffe1a end-to-end: a @pins tag with a trailing natural-language description produces zero issues and credits the id', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', "/** @pins F-c1000003 - fixes the escaped quote bug */\ntest('t', () => { assert.ok(true); });\n");
    assert.equal(issues.length, 0);
    assert.deepEqual(pins.map((p) => p.id), ['F-c1000003']);
  });

  // F-a5f07b2b: F-d77ffe1a's fix over-corrected — it silently dropped EVERY
  // post-valid-id failing token, including one that is itself id-shaped-but-
  // wrong (a realistic typo), not just genuine free-text prose. A failing
  // token that still starts with "F-" must be reported bad-shape and must
  // not end the scan; only a token that does NOT start with "F-" is prose.
  test('F-a5f07b2b: a second token that is id-shaped-but-wrong (one hex digit short) after a valid first id is flagged bad-shape, not silently dropped', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 F-2222222'), [
      { token: 'F-11111111', ok: true },
      { token: 'F-2222222', ok: false },
    ]);
  });

  test('F-a5f07b2b: F-d77ffe1a\'s original case is NOT regressed — genuine prose (does not start with "F-") after a valid id is still silently dropped', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 - fixes the bug'), [{ token: 'F-11111111', ok: true }]);
  });

  test('F-a5f07b2b: a bad-shape id-attempt followed by genuine prose reports the bad-shape token, then stops scanning at the prose', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 F-2222222 - fixes the bug'), [
      { token: 'F-11111111', ok: true },
      { token: 'F-2222222', ok: false },
    ]);
  });

  /** @pins F-a5f07b2b */
  test('F-a5f07b2b end-to-end: a mistyped second id after a valid first id surfaces as a real bad-shape tagIssue, not a silent drop', () => {
    const { pins, issues } = scanFileForDeclaredPins(
      'x.test.js',
      "/** @pins F-11111111 F-2222222 */\ntest('t', () => { assert.ok(true); });\n",
    );
    assert.deepEqual(pins.map((p) => p.id), ['F-11111111'], 'the well-formed first id is still credited');
    assert.equal(issues.length, 1, 'the mistyped second id must surface as exactly one issue, not zero');
    assert.equal(issues[0].kind, 'bad-shape');
    assert.equal(issues[0].token, 'F-2222222');
  });

  // F-d36cd380: F-a5f07b2b's own fix was itself instance-shaped — a literal
  // `token.startsWith('F-')` both UNDER-catches (three real near-miss typos of
  // the exact hash-id shape above, differing only in prefix spelling, all
  // still silently vanished as prose) and OVER-catches (ordinary hyphenated
  // prose starting with capital "F-" was wrongly flagged bad-shape). All six
  // cases below are the shapes demonstrated directly against this function.
  test('F-d36cd380: a lowercase-f case typo of a second id is flagged bad-shape, not silently dropped', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 f-2222222'), [
      { token: 'F-11111111', ok: true },
      { token: 'f-2222222', ok: false },
    ]);
  });

  test('F-d36cd380: a missing-internal-hyphen second id (F2222222) is flagged bad-shape, not silently dropped', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 F2222222'), [
      { token: 'F-11111111', ok: true },
      { token: 'F2222222', ok: false },
    ]);
  });

  test('F-d36cd380: a hyphen glued to the front of a second id (-F-2222222, one token because the tokenizer only splits on comma/whitespace) is flagged bad-shape, not silently dropped', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 -F-2222222'), [
      { token: 'F-11111111', ok: true },
      { token: '-F-2222222', ok: false },
    ]);
  });

  test('F-d36cd380: ordinary hyphenated prose starting with capital "F-" (F-strings) is NOT flagged bad-shape — it ends the scan as free text, per F-d77ffe1a', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 F-strings are unrelated to this pattern'), [
      { token: 'F-11111111', ok: true },
    ]);
  });

  test('F-d36cd380: "F-16" (e.g. a fighter-jet reference in a rationale) is NOT flagged bad-shape', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 F-16 is unrelated to this pattern'), [
      { token: 'F-11111111', ok: true },
    ]);
  });

  test('F-d36cd380: "F-test" (a plausible testing-vocabulary compound) is NOT flagged bad-shape', () => {
    assert.deepEqual(extractDeclaredIds('* @pins F-11111111 F-test is unrelated to this pattern'), [
      { token: 'F-11111111', ok: true },
    ]);
  });

  /** @pins F-d36cd380 */
  test('F-d36cd380 end-to-end: a case-typo second id surfaces as a real bad-shape tagIssue, while ordinary F-prefixed prose after a valid id raises none', () => {
    const typo = scanFileForDeclaredPins(
      'x.test.js',
      "/** @pins F-11111111 f-2222222 */\ntest('t', () => { assert.ok(true); });\n",
    );
    assert.deepEqual(typo.pins.map((p) => p.id), ['F-11111111'], 'the well-formed first id is still credited');
    assert.equal(typo.issues.length, 1, 'the case-typo second id must surface as exactly one issue, not zero');
    assert.equal(typo.issues[0].kind, 'bad-shape');
    assert.equal(typo.issues[0].token, 'f-2222222');

    const prose = scanFileForDeclaredPins(
      'x.test.js',
      "/** @pins F-11111111 F-strings are unrelated to this pattern */\ntest('t', () => { assert.ok(true); });\n",
    );
    assert.deepEqual(prose.pins.map((p) => p.id), ['F-11111111']);
    assert.equal(prose.issues.length, 0, 'ordinary F-prefixed prose after a valid id must raise zero issues, not one per prose word');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Unit: isQualifyingTestCall / forEachNode
// ─────────────────────────────────────────────────────────────────────────

describe('isQualifyingTestCall', () => {
  function firstCallIn(code) {
    let found = null;
    const { pins } = scanFileForDeclaredPins('probe.test.js', `/** @pins F-00000000 */\n${code}`);
    return pins;
  }

  test('bare test()/it()/describe() calls all qualify', () => {
    for (const name of ['test', 'it', 'describe']) {
      const pins = firstCallIn(`${name}('title', () => {});`);
      assert.equal(pins.length, 1, `${name}(...) should qualify`);
    }
  });

  test('single-level modifier (test.skip, it.only) qualifies', () => {
    assert.equal(firstCallIn(`test.skip('title', () => {});`).length, 1);
    assert.equal(firstCallIn(`it.only('title', () => {});`).length, 1);
  });

  test('.each(...)(...) chain qualifies (supported, not yet live in this repo\'s corpus)', () => {
    assert.equal(firstCallIn(`test.each([[1],[2]])('title %s', (n) => {});`).length, 1);
  });

  test('unrelated namespaced call (mocha.test) does not qualify', () => {
    assert.equal(firstCallIn(`mocha.test('title', () => {});`).length, 0);
  });

  test('a call with no title argument does not qualify', () => {
    assert.equal(firstCallIn(`test(() => {});`).length, 0);
  });

  test('a call whose first argument is a number does not qualify', () => {
    assert.equal(firstCallIn(`test(123, () => {});`).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F-d9cdcff2: qualifyingCallFromHost host-shape coverage — the array-table
// case is now credited; IIFE-wrapping and arrow indirection stay
// deliberately out of scope (see qualifyingCallFromHost's own docstring).
// ─────────────────────────────────────────────────────────────────────────

describe('F-d9cdcff2: qualifyingCallFromHost host shapes', () => {
  /** @pins F-d9cdcff2 */
  test('an array-table entry (tag immediately above a test() call as an array element) is credited, not a false wrong-node orphan', () => {
    const code = `
const cases = [
  /** @pins F-100000-090 */
  test('array-table case', () => { assert.ok(true); }),
];
`;
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', code);
    assert.deepEqual(pins.map((p) => p.id), ['F-100000-090']);
    assert.equal(issues.length, 0, `expected zero issues; got ${JSON.stringify(issues)}`);
  });

  test('F-d9cdcff2 negative control: an IIFE wrapper stays wrong-node (deliberately out of scope)', () => {
    const code = "/** @pins F-100000-094 */\n(function () { test('t', () => {}); })();\n";
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', code);
    assert.equal(pins.length, 0);
    assert.equal(issues[0]?.kind, 'wrong-node');
  });

  test('F-d9cdcff2 negative control: an arrow-function variable indirection stays wrong-node (deliberately out of scope)', () => {
    const code = "/** @pins F-100000-095 */\nconst wrapper = () => test('t', () => {});\nwrapper();\n";
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', code);
    assert.equal(pins.length, 0);
    assert.equal(issues[0]?.kind, 'wrong-node');
  });
});

describe('forEachNode', () => {
  test('visits every node type reachable from a small tree, no crash on cyclic-looking shared refs', () => {
    const shared = { type: 'Identifier', name: 'x' };
    const root = { type: 'Program', body: [shared, { type: 'ExpressionStatement', expression: shared }] };
    const seenTypes = [];
    forEachNode(root, (n) => seenTypes.push(n.type));
    assert.ok(seenTypes.includes('Program'));
    assert.ok(seenTypes.includes('ExpressionStatement'));
    // shared node visited once despite two references, per the seen-set guard.
    assert.equal(seenTypes.filter((t) => t === 'Identifier').length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C7: fail closed on unparseable input
// ─────────────────────────────────────────────────────────────────────────

test('C7: an unparseable file surfaces as parseError, never a silent skip', () => {
  const result = scanFileForDeclaredPins('broken.test.js', 'function( { [ ] } (');
  assert.equal(result.pins.length, 0);
  assert.equal(result.issues.length, 0);
  assert.ok(result.parseError, 'expected a parseError to be populated');
  assert.ok(result.parseError.message.length > 0);
});

/**
 * F-d1e38dd0: the readFileSync call sat OUTSIDE scanFileForDeclaredPins' own
 * try/catch — an unreadable file (deleted between listing and read, a
 * permissions fault, any I/O error) propagated as an UNCAUGHT throw that took
 * the whole gate down (no results for ANY file), rather than degrading into
 * one structured parseErrors entry the same way a parse failure already did.
 * Reproduced with no textOverride and a path that genuinely does not exist —
 * the real read path readFileSync(filePath, 'utf-8') is exercised for real
 * (every other test in this file passes textOverride, which bypasses the
 * read entirely and could never have caught this).
 */
/** @pins F-d1e38dd0 */
test('F-d1e38dd0: a file that cannot be read (no textOverride, nonexistent path) surfaces as parseError, never an uncaught throw', () => {
  const missingPath = resolve(tmpdir(), `pin-declarations-does-not-exist-${Date.now()}.test.js`);
  assert.doesNotThrow(() => scanFileForDeclaredPins(missingPath), 'a read failure must degrade to a structured parseError, never propagate uncaught');
  const result = scanFileForDeclaredPins(missingPath);
  assert.equal(result.pins.length, 0);
  assert.equal(result.issues.length, 0);
  assert.ok(result.parseError, 'expected a parseError to be populated for an unreadable file');
  assert.match(result.parseError.message, /failed to read file/i);
  assert.equal(result.parseError.line, null);
  assert.equal(result.parseError.column, null);
});

test('F-d1e38dd0: an explicit null textOverride still falls through to a real read (nullish-coalescing semantics preserved)', () => {
  // Points textOverride at `null` explicitly rather than omitting it — the
  // original `textOverride ?? readFileSync(...)` treated null as nullish
  // (same as undefined), and the rewrite must preserve that exact behavior,
  // not silently start treating `null` as "the text is the literal value
  // null" (which would then crash `parse(null, ...)` differently).
  const missingPath = resolve(tmpdir(), `pin-declarations-null-override-${Date.now()}.test.js`);
  const result = scanFileForDeclaredPins(missingPath, null);
  assert.ok(result.parseError);
  assert.match(result.parseError.message, /failed to read file/i);
});

test('F-d1e38dd0: an empty-string textOverride is respected (not treated as nullish, matches original ?? semantics)', () => {
  const result = scanFileForDeclaredPins('empty.test.js', '');
  assert.equal(result.parseError, null, 'an empty string is a valid (if uninteresting) override — it must parse as an empty program, not fall through to a real file read');
  assert.deepEqual(result.pins, []);
});

// ─────────────────────────────────────────────────────────────────────────
// C3: schema validation — every defect kind is distinct and never silent
// ─────────────────────────────────────────────────────────────────────────

describe('C3 schema validation', () => {
  test('wrong-node: tag attached to a non-test statement is a defect, not credited and not silently dropped', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', `/** @pins F-99998888 */\nconst helper = 1;\n`);
    assert.equal(pins.length, 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'wrong-node');
  });

  test('not-attached: dangling tag at end of file is a defect', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', `test('a', () => {});\n/** @pins F-aaaaaaaa */\n`);
    assert.equal(pins.length, 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'not-attached');
  });

  test('bad-shape: malformed id token is a defect', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', `/** @pins NOT-AN-ID */\ntest('a', () => {});\n`);
    assert.equal(pins.length, 0);
    assert.equal(issues[0].kind, 'bad-shape');
  });

  test('empty-tag: @pins with nothing after it is a defect', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', `/** @pins */\ntest('a', () => {});\n`);
    assert.equal(pins.length, 0);
    assert.equal(issues[0].kind, 'empty-tag');
  });

  test('a well-formed, correctly-attached tag produces zero issues', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', `/** @pins F-e003b1fb */\ntest('a', () => { assert.ok(true); });\n`);
    assert.equal(issues.length, 0);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].id, 'F-e003b1fb');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Realistic structural shapes: nested describe, blank-line gaps, multi-id
// ─────────────────────────────────────────────────────────────────────────

describe('realistic structural shapes', () => {
  test('a tag nested two describe() levels deep is still found', () => {
    const code = `
describe('outer', () => {
  describe('inner', () => {
    /** @pins F-deadbeef */
    test('deeply nested', () => {});
  });
});
`;
    const { pins } = scanFileForDeclaredPins('x.test.js', code);
    assert.deepEqual(pins.map((p) => p.id), ['F-deadbeef']);
  });

  test('a tag separated from its test by a blank line still attaches (Babel leading-comment default)', () => {
    const code = `
/** @pins F-55556666 */

test('gap case', () => { assert.ok(true); });
`;
    const { pins } = scanFileForDeclaredPins('x.test.js', code);
    assert.deepEqual(pins.map((p) => p.id), ['F-55556666']);
  });

  test('a tag separated from a PRECEDING statement by a blank line correctly forward-attaches to the FOLLOWING test, not the setup code', () => {
    const code = `
describe('suite', () => {
  const setup = 1;

  /** @pins F-abc12345 */
  it('nested case', () => { assert.equal(setup, 1); });
});
`;
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', code);
    assert.deepEqual(pins.map((p) => p.id), ['F-abc12345']);
    assert.equal(issues.length, 0);
  });

  test('multiple ids on one @pins line all credit the same test', () => {
    const code = `/** @pins F-aaaaaaaa, F-bbbbbbbb */\ntest('covers two findings', () => {});\n`;
    const { pins } = scanFileForDeclaredPins('x.test.js', code);
    assert.deepEqual(pins.map((p) => p.id).sort(), ['F-aaaaaaaa', 'F-bbbbbbbb']);
  });

  test('TypeScript syntax (interfaces, type annotations) parses and still finds the tag', () => {
    const code = `
interface Foo { bar: string; }

/** @pins F-11112222 */
test('typed case', (): void => {
  const x: number = 1;
  assert.equal(x, 1);
});
`;
    const { pins, parseError } = scanFileForDeclaredPins('x.test.ts', code);
    assert.equal(parseError, null);
    assert.deepEqual(pins.map((p) => p.id), ['F-11112222']);
  });

  /**
   * F-32441f8c: every documented/exemplified `@pins` convention in this file
   * uses the `/** @pins F-id *\/` JSDoc block-comment form, but the mechanism
   * (this function's uniform iteration over `ast.comments`) never
   * distinguishes Babel's CommentBlock from CommentLine — see this module's
   * SCOPE paragraph for the disclosed decision this test makes permanent: a
   * bare `//` leading-comment line is credited IDENTICALLY to the block
   * form, on purpose, not as an accidental side effect of a generic walk.
   */
  /** @pins F-32441f8c */
  test('F-32441f8c: a bare "//" leading-comment line credits a pin identically to the documented "/** */" block form', () => {
    const blockForm = scanFileForDeclaredPins('x.test.js', "/** @pins F-32441f8c */\ntest('block form', () => { assert.ok(true); });\n");
    const lineForm = scanFileForDeclaredPins('x.test.js', "// @pins F-32441f8c\ntest('line form', () => { assert.ok(true); });\n");

    assert.deepEqual(blockForm.pins.map((p) => p.id), ['F-32441f8c']);
    assert.equal(blockForm.issues.length, 0);
    assert.deepEqual(lineForm.pins.map((p) => p.id), ['F-32441f8c'], 'a bare // tag must credit the pin exactly like the block form, per the SCOPE paragraph\'s disclosed decision');
    assert.equal(lineForm.issues.length, 0);
  });

  test('F-32441f8c: the "//" line form still requires real attachment — a trailing (not leading) "//" comment is not-attached, same as the block form', () => {
    const { pins, issues } = scanFileForDeclaredPins('x.test.js', "test('a', () => {});\n// @pins F-99990000\n");
    assert.equal(pins.length, 0, 'a // tag has no special-cased laundering path — it still requires correct AST leading-comment attachment');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'not-attached');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Historical-leak corpus (dispatch C9, findings 24/25/28) — generalized
// relations, not point tests. Iterates PIN_DECLARATION_CORPUS generically:
// appending a new entry to that array extends this suite automatically.
// ─────────────────────────────────────────────────────────────────────────

describe('historical-leak corpus: evasion shapes credit nothing, declared equivalents credit the id', () => {
  for (const entry of PIN_DECLARATION_CORPUS) {
    test(`${entry.name} (${entry.origin.split(' — ')[0]}): evasion shape credits nothing`, () => {
      const { pins } = scanFileForDeclaredPins(`${entry.name}-evasion.test.js`, entry.evasionCode);
      const credited = pins.some((p) => p.id === entry.targetId);
      assert.equal(credited, false, `evasion shape for ${entry.targetId} (${entry.origin}) must NOT be credited under the declared-link mechanism`);
    });

    test(`${entry.name} (${entry.origin.split(' — ')[0]}): declared equivalent credits ${entry.targetId}`, () => {
      const { pins, issues } = scanFileForDeclaredPins(`${entry.name}-declared.test.js`, entry.declaredCode);
      const credited = pins.some((p) => p.id === entry.targetId);
      assert.equal(credited, true, `declared equivalent for ${entry.targetId} must be credited; issues=${JSON.stringify(issues)}`);
    });
  }

  test('corpus is non-trivial (guards against an accidentally-emptied array)', () => {
    assert.ok(PIN_DECLARATION_CORPUS.length >= 7, 'expected at least the 7 historically-named leak shapes');
  });

  test('every corpus entry has a distinct targetId (no accidental collision across entries)', () => {
    const ids = PIN_DECLARATION_CORPUS.map((e) => e.targetId);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Dedicated, individually-declared regression pins for this wave's two
// assigned findings (F-6573391e, F-b00fb0d0). The generic corpus loop above
// already proves both shapes are closed, but a `for` loop cannot carry a
// per-iteration @pins tag — a static comment placed above a ForStatement
// attaches (per pin-declarations.mjs's own AST-attachment rule) to the loop
// statement itself, not to each dynamically-generated test() call inside
// it. These two tests exist so each finding has real, self-citing coverage
// rather than only a row in a shared table — dogfooding this wave's own
// rule that a declared tag must sit immediately above the call it pins.
// ─────────────────────────────────────────────────────────────────────────

/** @pins F-6573391e */
test('F-6573391e: an unindented template-literal continuation line is never mistaken for a leading comment under the declared-tag mechanism', () => {
  const entry = PIN_DECLARATION_CORPUS.find((e) => e.name === 'template-literal-unindented-continuation');
  assert.ok(entry, "expected the corpus to carry this finding's fixture");
  const evasion = scanFileForDeclaredPins('x.test.js', entry.evasionCode);
  assert.equal(evasion.pins.some((p) => p.id === entry.targetId), false, 'the raw-line-startsWith evasion must credit nothing — there is no @pins tag in it, and a template literal is never scanned for comment-shaped text');
  const declaredEquivalent = scanFileForDeclaredPins('x.test.js', entry.declaredCode);
  assert.equal(declaredEquivalent.pins.some((p) => p.id === entry.targetId), true, 'a real @pins tag for the same scenario must be credited');
});

/** @pins F-b00fb0d0 */
test('F-b00fb0d0: an id positioned after a template-literal interpolation in a test title is never silently dropped under the declared-tag mechanism', () => {
  const entry = PIN_DECLARATION_CORPUS.find((e) => e.name === 'id-after-template-interpolation-in-title');
  assert.ok(entry, "expected the corpus to carry this finding's fixture");
  const evasion = scanFileForDeclaredPins('x.test.js', entry.evasionCode);
  assert.equal(evasion.pins.some((p) => p.id === entry.targetId), false, 'the id-in-title-after-interpolation evasion must credit nothing — the declared-tag mechanism never inspects title text for ids at all, so a title-boundary bug cannot resurface here');
  const declaredEquivalent = scanFileForDeclaredPins('x.test.js', entry.declaredCode);
  assert.equal(declaredEquivalent.pins.some((p) => p.id === entry.targetId), true, 'a real @pins tag for the same scenario must be credited');
});

// ─────────────────────────────────────────────────────────────────────────
// Metamorphic relations (dispatch C9, findings 26/27) — permanent CI
// assertions, run generically over every corpus declaredCode fixture.
// ─────────────────────────────────────────────────────────────────────────

describe('metamorphic relation: inserting an unrelated comment or dead code elsewhere must never change a credit decision', () => {
  const mutators = [
    { label: 'prepend unrelated line comment', apply: (code) => `// unrelated note, mentions assert and F-999999-999\n${code}` },
    { label: 'append unrelated block comment', apply: (code) => `${code}\n/* trailing unrelated note about F-888888-888 */\n` },
    { label: 'insert unreachable dead code before the tagged test', apply: (code) => `if (false) { console.log('F-777777-777 assert dead branch'); }\n${code}` },
    { label: 'insert extra blank lines throughout', apply: (code) => code.split('\n').join('\n\n') },
  ];

  for (const entry of PIN_DECLARATION_CORPUS) {
    for (const mutator of mutators) {
      test(`${entry.name} + [${mutator.label}] does not change whether ${entry.targetId} is credited`, () => {
        const baseline = scanFileForDeclaredPins(`${entry.name}.test.js`, entry.declaredCode);
        const baselineCredited = baseline.pins.some((p) => p.id === entry.targetId);
        assert.equal(baselineCredited, true, 'sanity: baseline fixture must credit before mutating it');

        const mutated = scanFileForDeclaredPins(`${entry.name}.test.js`, mutator.apply(entry.declaredCode));
        const mutatedCredited = mutated.pins.some((p) => p.id === entry.targetId);
        assert.equal(mutatedCredited, true, `[${mutator.label}] flipped the credit decision for ${entry.targetId} — metamorphic relation violated`);
      });
    }
  }
});

describe('metamorphic relation: consistently renaming an id must not change the credit VERDICT', () => {
  for (const entry of PIN_DECLARATION_CORPUS) {
    test(`${entry.name}: renaming ${entry.targetId} -> F-000000-999 everywhere preserves credited=true under the new name`, () => {
      const renamed = entry.declaredCode.split(entry.targetId).join('F-000000-999');
      const { pins } = scanFileForDeclaredPins(`${entry.name}-renamed.test.js`, renamed);
      assert.equal(pins.some((p) => p.id === 'F-000000-999'), true);
      // and the OLD id must no longer appear at all post-rename (sanity the
      // rename was total, not partial).
      assert.equal(pins.some((p) => p.id === entry.targetId), false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Generator over the pin-syntax space (finding 24) — combinatorial sweep,
// asserting the single boolean invariant: credited iff a well-formed tag is
// the LEADING comment of a qualifying call.
// ─────────────────────────────────────────────────────────────────────────

describe('generator: pin-syntax space sweep', () => {
  const commentStyles = [
    { label: 'block JSDoc', wrap: (tag) => `/** ${tag} */` },
    { label: 'line comment', wrap: (tag) => `// ${tag}` },
    { label: 'multi-line JSDoc', wrap: (tag) => `/**\n * ${tag}\n */` },
  ];
  const positions = [
    { label: 'leading, adjacent', expectCredit: true, place: (comment) => `${comment}\ntest('t', () => {});` },
    { label: 'leading, blank-line gap', expectCredit: true, place: (comment) => `${comment}\n\ntest('t', () => {});` },
    { label: 'trailing (after the call)', expectCredit: false, place: (comment) => `test('t', () => {});\n${comment}` },
    { label: 'floating (no call anywhere in file)', expectCredit: false, place: (comment) => `${comment}\nconst x = 1;` },
    { label: 'inside the callback body (innerComment, not leading of the call statement)', expectCredit: false, place: (comment) => `test('t', () => {\n${comment}\n  assert.ok(true);\n});` },
  ];

  let caseIndex = 0;
  for (const style of commentStyles) {
    for (const position of positions) {
      caseIndex += 1;
      const id = `F-1000${String(caseIndex).padStart(2, '0')}-001`;
      test(`[${style.label}] x [${position.label}]: credited === ${position.expectCredit}`, () => {
        const code = position.place(style.wrap(`@pins ${id}`));
        const { pins } = scanFileForDeclaredPins('gen.test.js', code);
        const credited = pins.some((p) => p.id === id);
        assert.equal(credited, position.expectCredit, `code:\n${code}`);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Repo-level scan (fixture dir, not the live tree — see
// pin-declarations-differential.test.mjs for the live-tree assertion)
// ─────────────────────────────────────────────────────────────────────────

test('scanRepoForDeclaredPins: aggregates pins across files and buckets a broken file into parseErrors', async (t) => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'pin-decl-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'a.test.js'), `/** @pins F-11111111 */\ntest('a', () => {});\n`);
  writeFileSync(join(dir, 'pkg', 'b.test.js'), `/** @pins F-22222222 */\ntest('b', () => {});\n`);
  writeFileSync(join(dir, 'pkg', 'broken.test.js'), 'function( { [ ] } (');
  // Fixture name is load-bearing: `not-a-test.js` ends in `-test.js`, which node --test
  // genuinely discovers — so classifyFile (widened in wave 20 per F-a27680f9 to match node's
  // real discovery forms) correctly buckets it as a test. The old name encoded an assumption
  // node itself does not share, and asserted the opposite of what it tested.
  writeFileSync(join(dir, 'pkg', 'plain-source.js'), `/** @pins F-33333333 */\ntest('should be ignored, not a test-classified file', () => {});\n`);

  const result = scanRepoForDeclaredPins(dir);
  assert.deepEqual([...result.byId.keys()].sort(), ['F-11111111', 'F-22222222']);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0].file.endsWith('broken.test.js'), true);
  assert.equal(result.byId.has('F-33333333'), false, 'non-test-classified files are out of scope, per module docstring');
});
