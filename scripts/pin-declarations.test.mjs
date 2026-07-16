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
  writeFileSync(join(dir, 'pkg', 'not-a-test.js'), `/** @pins F-33333333 */\ntest('should be ignored, not a test-classified file', () => {});\n`);

  const result = scanRepoForDeclaredPins(dir);
  assert.deepEqual([...result.byId.keys()].sort(), ['F-11111111', 'F-22222222']);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0].file.endsWith('broken.test.js'), true);
  assert.equal(result.byId.has('F-33333333'), false, 'non-test-classified files are out of scope, per module docstring');
});
