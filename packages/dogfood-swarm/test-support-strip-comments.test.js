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

test('comments inside ${ } template expressions are stripped, template body untouched', () => {
  const src = 'const t = `head ${ value /' + '/ trailing note\n } tail`;';
  const out = stripComments(src);
  assert.ok(!out.includes('trailing note'), 'comment inside the expression is stripped');
  assert.ok(out.includes('head ') && out.includes(' tail`'), 'template body preserved');
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
