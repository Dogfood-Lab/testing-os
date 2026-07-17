/**
 * Pins for test-support/strip-comments.js — the shared scanner that replaced
 * five per-file regex-pair comment strippers (Director-directed consolidation,
 * 2026-07-15, after a live wave-8 failure: a cli.js line comment referencing a
 * glob poisoned wave2-4091637-5127-swarm-cp-pins.test.js's extraction and
 * silently deleted the tail of the function under test).
 *
 * The historical algorithm is embedded below as a contrast fixture so the
 * red-capability of each pin is demonstrated in-suite: where the pins assert
 * the scanner survives, the fixture is asserted to FAIL the same input. That
 * documents WHY the scanner exists, byte-for-byte, against the shape that bit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stripComments } from './test-support/strip-comments.js';

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

// The pre-consolidation algorithm, verbatim shape (block-first regex over raw
// text, then per-line indexOf slicing) — kept ONLY as a contrast fixture.
function legacyStripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

// Fixture built from parts so this file's own source never contains the raw
// hazard sequences at column positions a scanner of THIS file could trip on.
const GLOB_COMMENT_FIXTURE = [
  'function alpha() {',
  '  ' + '/' + '/ resolves against packages' + '/dogfood-swarm/lib/' + '** at dispatch time',
  '  survivor();',
  '}',
  '/' + '* trailing block comment *' + '/',
  'function omega() {}',
].join('\n');

test('the live wave-8 shape: glob prose in a line comment cannot eat real code', () => {
  const out = stripComments(GLOB_COMMENT_FIXTURE);
  assert.ok(out.includes('survivor();'), 'real code after the glob comment must survive');
  assert.ok(out.includes('function omega'), 'code after the later block comment must survive');
  assert.ok(!out.includes('dispatch time'), 'the comment prose itself is stripped');
});

test('contrast: the legacy algorithm demonstrably ate the code (why this module exists)', () => {
  const out = legacyStripComments(GLOB_COMMENT_FIXTURE);
  assert.ok(!out.includes('survivor();'),
    'the legacy block-first regex treats the glob prose as an unclosed /' + '* and consumes to the next *' + '/ — if this ever PASSES, the fixture no longer reproduces the historical bug and both tests need re-derivation');
});

test('mirror hazard: single-line block comment containing a URL', () => {
  const src = '/' + '* see https:/' + '/example.com *' + '/ keepMe();';
  const out = stripComments(src);
  assert.ok(out.includes('keepMe();'), 'code after the single-line block comment survives');
  assert.ok(!out.includes('example.com'), 'comment content is stripped');
});

test('multi-line block comment with an internal URL is removed with line count preserved', () => {
  const src = ['before();', '/' + '*', ' * https:/' + '/x.test/path', ' *' + '/', 'after();'].join('\n');
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count preserved');
  assert.ok(out.includes('before();') && out.includes('after();'));
  assert.ok(!out.includes('x.test'));
});

// Wave-9 audit carryover (no formal wave-10 finding_id — flagged in the
// coordinator's own dispatch as a residual to check after 6a63dda, not in
// the frozen wave-10 domain map's findings list). Every fixture above this
// point uses LF-only line joins; the module header promises "LINE NUMBERS
// ARE PRESERVED" without qualifying which line-ending style, and this repo
// runs on Windows where CRLF sources are a live possibility. Mutation-
// probed: a scratch mutant that also fires the internal newline-append on
// '\r' (a plausible "helpful CRLF fix") doubles the counted newlines for
// CRLF input and flips this pin red, while leaving the LF-only pin above
// untouched — confirming this is a distinct, previously-uncovered axis.
test('CRLF line endings: line count is preserved through a block comment, not just LF', () => {
  const src = 'before();\r\n/' + '*\r\n * note\r\n *' + '/\r\nafter();';
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count preserved across CRLF input');
  assert.ok(out.includes('before();') && out.includes('after();'));
  assert.ok(!out.includes('note'));
});

// Wave-9 audit carryover (same status as the CRLF pin above). The block-
// comment loop's closing advance (`i += 2`) runs unconditionally whether or
// not `*/` was actually found, per the header's own "(or off the end when
// unterminated)" note — but nothing pinned that claim. Verified directly: an
// unterminated block comment at EOF does not throw, does not hang, and
// preserves every internal newline up to EOF. (Not mutation-probed: the one
// plausible regression here — dropping the loop's `i < n` bound — produces
// an infinite loop rather than a wrong value, which this file's assertion-
// based pins cannot safely demonstrate without risking the test run hanging.
// This pin's value is coverage of the EOF-termination path itself, not a
// wrong-output catch.)
test('unterminated block comment running to EOF does not throw and preserves line count', () => {
  const src = ['before();', '/' + '* never closed', 'still open, no closer'].join('\n');
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count preserved even though the comment never closes');
  assert.ok(out.includes('before();'), 'code before the unterminated comment survives');
  assert.ok(!out.includes('still open'), 'the unterminated comment body itself is not emitted');
});

test('string and template contents are preserved byte-for-byte', () => {
  const src = [
    "const g = 'lib/*" + "*';",
    'const h = "a /' + '* b *' + '/ c";',
    'const u = `https:/' + '/inside.template/${name}/tail`;',
    'const mixed = `pre ${ compute("/x/" + "/y") } post`;',
  ].join('\n');
  const out = stripComments(src);
  assert.ok(out.includes("'lib/*" + "*'"), 'glob string survives');
  assert.ok(out.includes('a /' + '* b *' + '/ c'), 'block-lookalike inside a string survives');
  assert.ok(out.includes('https:/' + '/inside.template'), 'URL inside template survives');
  assert.ok(out.includes('post`'), 'template tail after ${} survives');
});

// Wave-9 audit carryover (no formal wave-10 finding_id; see the CRLF pin
// above for the same status note). The string handler's escape branch reads
// `source[i + 1] ?? ''` specifically so a lone trailing backslash as the
// LAST character of an unterminated string does not read past the end of
// the source into `undefined`. Mutation-probed: a scratch mutant that drops
// the `?? ''` fallback concatenates the literal word "undefined" into the
// output for this exact shape and flips this pin red; the same mutant
// leaves every other fixture in this file untouched, confirming the `?? ''`
// guard is load-bearing specifically for this EOF shape.
test('a lone trailing backslash at EOF inside an unterminated string does not leak "undefined"', () => {
  const src = "const s = 'abc\\";
  const out = stripComments(src);
  assert.ok(!out.includes('undefined'), 'reading past the source end must not surface the literal word "undefined"');
  assert.equal(out, src, 'an unterminated string with no comment content passes through unchanged');
});

test('comments inside ${ } template expressions are stripped, template body untouched', () => {
  const src = 'const t = `head ${ value /' + '/ trailing note\n } tail`;';
  const out = stripComments(src);
  assert.ok(!out.includes('trailing note'), 'comment inside the expression is stripped');
  assert.ok(out.includes('head ') && out.includes(' tail`'), 'template body preserved');
});

// Wave-9 audit carryover (same status note as above). consumeTemplateBody is
// called again by the main loop whenever it meets a backtick — including a
// backtick that opens a SECOND template literal nested inside the first
// one's ${ } expression. The shared `frames` array is a real stack (push on
// entering an expression, pop on leaving it), so nesting should compose
// automatically; nothing pinned that claim. Mutation-probed: a scratch
// mutant that degrades the stack to a single overwritten slot (frames[0] = x
// instead of frames.push(x); frames[0].braceDepth instead of frames.pop())
// leaves this fixture's own template bodies untouched (both pushes happen
// to capture braceDepth 0 here) but loses the OUTER frame's true depth, so
// the trailing comment after the whole expression closes is never reached
// by the normal main loop and survives unstripped — flips this pin red.
test('a template literal nested inside another template\'s ${ } expression does not corrupt the outer frame', () => {
  const src = 'const o = { t: `outer ${ `inner ${x}` } end` }; /' + '* strip me *' + '/ keep();';
  const out = stripComments(src);
  assert.ok(!out.includes('strip me'), 'a comment after the doubly-nested template must still be stripped — the outer expression frame must survive the inner template closing');
  assert.ok(out.includes('keep();'), 'code after the comment survives');
  assert.ok(out.includes('`outer ${ `inner ${x}` } end`'), 'both template bodies preserved verbatim');
});

// Wave-9 audit carryover (same status note as above). braceDepth counts `{`
// / `}` inside a ${ } expression so a nested object literal's own braces
// cannot be misread as the expression's closer; nothing pinned that claim
// either. Mutation-probed: a scratch mutant that stops incrementing
// braceDepth on `{` (so the FIRST `}` at depth 0 inside the object literal
// looks like the expression's own close) causes the frame to pop one brace
// early — the rest of the object literal and the comment right after it get
// swallowed as literal template-body text instead of parsed as code, so the
// comment survives unstripped. Flips this pin red; the real scanner strips
// it.
test('an object literal (nested braces) inside a ${ } expression does not close the expression early', () => {
  const src = 'const t = `head ${ ({a: {b: 2}}) /' + '* strip me *' + '/ } tail`; keep();';
  const out = stripComments(src);
  assert.ok(!out.includes('strip me'), 'a comment after the nested object literal, still inside the expression, must be stripped');
  assert.ok(out.includes('keep();'), 'code after the template survives');
  assert.ok(out.includes('({a: {b: 2}})'), 'the object literal itself is preserved verbatim');
});

test('BOUNDARY CLOSED (wave 9): a bare /' + '* inside a regex character class survives — regexes are lexed', () => {
  // This pin originally asserted the opposite as a documented limitation.
  // Wave-9's audit proved the un-lexed-regex gap was live (an odd count of
  // quotes inside redrive.test.js's own import-rewriting regex desynced the
  // string tracker), so regex lexing was added and this pin flipped per its
  // own instructions — the conscious change the old assertion demanded.
  const src = 'const re = /[/*]/; keep();';
  const out = stripComments(src);
  assert.ok(out.includes('keep();'), 'code after a comment-lookalike regex survives');
  assert.ok(out.includes('/[/*]/'), 'the regex literal itself is preserved verbatim');
});

test('wave-9 F-001 shape: odd quote count inside a regex cannot desync the string tracker', () => {
  // redrive.test.js's real helper regex contains three unescaped quotes; an
  // earlier revision entered fake-string mode on the third and stopped
  // stripping comments for the rest of the file.
  const src = [
    "const re = /from '(\\.\\.?\\/[^']+)'/g;",
    '/' + '* a real block comment that MUST be stripped *' + '/',
    'stillHere();',
  ].join('\n');
  const out = stripComments(src);
  assert.ok(!out.includes('MUST be stripped'), 'block comment after the regex is stripped');
  assert.ok(out.includes('stillHere();'), 'code after the comment survives');
  assert.ok(out.includes("from '("), 'regex body preserved verbatim');
});

test('division is not misread as a regex opener', () => {
  const src = 'const x = total / count; /' + '* strip me *' + '/ keep();';
  const out = stripComments(src);
  assert.ok(out.includes('total / count'), 'division preserved');
  assert.ok(!out.includes('strip me'), 'block comment after division is stripped');
  assert.ok(out.includes('keep();'));
});

test('DOCUMENTED RESIDUAL: a regex directly after a value-closer reads as division (token-local heuristic)', () => {
  // `(a) /re/` — after `)` the heuristic says division, so the regex body is
  // NOT lexed. Harmless alone; the compound hazard (such a regex ALSO
  // containing a comment-lookalike) is the residual boundary the module
  // header names. If this assertion ever fails, the residual closed
  // (grammatical regex detection was added) — update the header with it.
  const src = 'const y = (a) /x[/*]y/.source; keep();';
  const out = stripComments(src);
  assert.ok(!out.includes('keep();'),
    'expected the documented residual: closing it must be a conscious change');
});

test('real-corpora smoke: the scanner keeps known live code visible across every scanned source', () => {
  const files = [
    'cli.js',
    ...readdirSync(join(PKG_ROOT, 'commands')).filter((f) => f.endsWith('.js')).map((f) => join('commands', f)),
  ];
  for (const f of files) {
    const src = readFileSync(join(PKG_ROOT, f), 'utf-8');
    const out = stripComments(src);
    assert.equal(out.split('\n').length, src.split('\n').length, f + ': line count preserved');
    assert.ok(out.length <= src.length, f + ': output never grows');
  }
  // The exact live-failure shape, against the real tree: cmdFindings' body
  // (which follows the glob-referencing comment that caused the incident)
  // must remain visible after stripping.
  const cli = readFileSync(join(PKG_ROOT, 'cli.js'), 'utf-8');
  const stripped = stripComments(cli);
  assert.ok(stripped.includes('process.exitCode'), 'cli.js code after prose comments survives');
});
