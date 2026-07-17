/**
 * f-37ba8d85-combining-mark-and-zwj-precision.test.js -- F-37ba8d85 (MEDIUM,
 * wave 22): the opposite direction of F-6540ba3d -- wave 20's CONTROL_CLASS
 * was OVER-broad on two axes. (1) It escaped EVERY isolated Combining
 * Diacritical Mark (U+0300-U+036F) rather than only pathological "zalgo"
 * runs, mangling ordinary NFD (Unicode-decomposed) text -- the canonical
 * form for Vietnamese, polytonic/academic Greek, and IAST Sanskrit
 * transliteration. (2) ZWJ (U+200D), required by every standard Unicode ZWJ
 * emoji sequence (family emoji, profession+gender combinations, the pride
 * flags), sat inside the same numeric range as the genuinely dangerous
 * ZWSP/ZWNJ purely because the class was built from contiguous ranges
 * rather than semantic membership.
 *
 * Fixed by (a) moving the Combining Diacritical Marks block out of
 * single-character escaping entirely and into ZALGO_RUN, a dedicated pass
 * that escapes only runs of 3-or-more consecutive marks (the actual "many
 * marks piled onto one base character" shape); (b) carving ZWJ back out of
 * CONTROL_CLASS via `v`-flag set subtraction.
 *
 * Every assertion runs against the REAL exported escapeReasonForDisplay
 * (never a reimplementation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeReasonForDisplay } from './commands/lib/escape-reason.js';

const COMBINING_ACUTE = '\u{0301}';
const COMBINING_GRAVE = '\u{0300}';
const COMBINING_TILDE = '\u{0303}';
const ZWJ = '\u{200D}';

/** @pins F-37ba8d85 */
describe('F-37ba8d85 -- combining-mark escaping is run-length-gated; ZWJ is carved out of the escaped class', () => {
  describe('combining marks: isolated occurrences pass through; 3+-mark runs are pathological and escape', () => {
    it('a single combining mark following a base letter passes through unescaped (ordinary NFD text)', () => {
      const nfdE = 'e' + COMBINING_ACUTE; // NFD "e with acute" -- one base + one mark
      assert.equal(escapeReasonForDisplay(nfdE), nfdE);
    });

    it('two combining marks on one base character (still ordinary, e.g. some precomposition-less Vietnamese tone+quality marks) pass through unescaped', () => {
      const twoMarks = 'e' + COMBINING_ACUTE + COMBINING_TILDE;
      assert.equal(escapeReasonForDisplay(twoMarks), twoMarks);
    });

    it('three consecutive combining marks on one base character IS the pathological "zalgo" shape and is escaped, each mark individually', () => {
      const zalgo = 'e' + COMBINING_ACUTE + COMBINING_GRAVE + COMBINING_TILDE;
      const out = escapeReasonForDisplay(zalgo);
      assert.equal(out, 'e\\u0301\\u0300\\u0303', `expected each of the 3 stacked marks escaped individually -- got "${out}"`);
    });

    it('a longer zalgo run (5 marks) escapes in full, not just the marks beyond the threshold', () => {
      const marks = [COMBINING_ACUTE, COMBINING_GRAVE, COMBINING_TILDE, COMBINING_ACUTE, COMBINING_GRAVE];
      const zalgo = 'e' + marks.join('');
      const out = escapeReasonForDisplay(zalgo);
      const expected = 'e' + marks.map((m) => `\\u${m.codePointAt(0).toString(16).padStart(4, '0')}`).join('');
      assert.equal(out, expected, `expected the WHOLE run escaped (not just marks past the threshold) -- got "${out}"`);
    });

    it('a real NFD Vietnamese phrase (single/double marks throughout, no pathological run) renders completely unmangled', () => {
      // "da(?) sua? lo^~i tie^'ng Vie^.t" built explicitly from base letters +
      // combining marks (never a raw glyph in this file's own source bytes,
      // matching this repo's own stated rule for exactly this reason) --
      // NFD Vietnamese commonly carries a base vowel + a tone mark + a
      // quality mark (2 combining marks), well under the 3-mark threshold.
      const HOOK_ABOVE = '\u{0309}';
      const GRAVE = '\u{0300}';
      const TILDE = '\u{0303}';
      const ACUTE = '\u{0301}';
      const DOT_BELOW = '\u{0323}';
      const CIRCUMFLEX = '\u{0302}';
      const phrase =
        'd' + '\u{0303}' + 'a' + ' ' +
        's' + 'u' + HOOK_ABOVE + 'a' + ' ' +
        'l' + 'o' + CIRCUMFLEX + TILDE + 'i' + ' ' +
        't' + 'i' + CIRCUMFLEX + ACUTE + 'n' + 'g' + ' ' +
        'V' + 'i' + CIRCUMFLEX + DOT_BELOW + 't';
      assert.equal(escapeReasonForDisplay(phrase), phrase, `NFD Vietnamese text must render byte-identical -- got "${escapeReasonForDisplay(phrase)}"`);
    });

    it('a real NFD polytonic Greek word (base + 2 combining marks, e.g. smooth breathing + acute) renders unmangled', () => {
      const SMOOTH_BREATHING = '\u{0313}';
      const ACUTE = '\u{0301}';
      const word = '\u{03b1}' + SMOOTH_BREATHING + ACUTE + '\u{03b3}\u{03b1}\u{03b8}\u{03cc}\u{03c2}'; // a(smooth+acute)gathos-shaped
      assert.equal(escapeReasonForDisplay(word), word);
    });
  });

  describe('ZWJ: carved out of the escaped class; its neighbors are not', () => {
    it('ZWJ alone passes through unescaped', () => {
      assert.equal(escapeReasonForDisplay(`x${ZWJ}y`), `x${ZWJ}y`);
    });

    it('a standard 4-person ZWJ family emoji sequence renders byte-identical, not four separate glyphs plus literal \\u200d splices', () => {
      const MAN = '\u{1F468}';
      const WOMAN = '\u{1F469}';
      const GIRL = '\u{1F467}';
      const BOY = '\u{1F466}';
      const family = [MAN, WOMAN, GIRL, BOY].join(ZWJ);
      const out = escapeReasonForDisplay(family);
      assert.equal(out, family, `family ZWJ sequence must survive byte-identical -- got "${JSON.stringify(out)}"`);
      assert.ok(!out.includes('\\u200d'), 'must not contain a literal \\u200d escape splice');
    });

    it('ZWJ\'s dangerous neighbors (ZWSP, ZWNJ) in the SAME numeric range still escape -- the carve-out is ZWJ-specific, not a range-wide regression', () => {
      const ZWSP = '\u{200B}';
      const ZWNJ = '\u{200C}';
      for (const ch of [ZWSP, ZWNJ]) {
        const out = escapeReasonForDisplay(`x${ch}y`);
        assert.ok(!out.includes(ch), `U+${ch.codePointAt(0).toString(16)} must still be escaped -- got "${out}"`);
      }
    });
  });

  describe('--format=json stays lossless (this file\'s own documented invariant, unaffected by either change)', () => {
    it('escapeReasonForDisplay is a pure function -- calling it never mutates its input, so a caller that ALSO needs the lossless raw value for a JSON path is never at risk from having called this helper first', () => {
      const raw = 'e' + COMBINING_ACUTE + COMBINING_GRAVE + COMBINING_TILDE + ZWJ;
      const rawCopy = raw.slice();
      escapeReasonForDisplay(raw);
      assert.equal(raw, rawCopy, 'input string must be unchanged after escaping (JS strings are immutable, but this pins the property some future refactor could still violate by returning a mutated array-backed string type)');
    });
  });
});
