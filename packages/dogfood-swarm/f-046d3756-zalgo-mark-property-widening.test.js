/**
 * f-046d3756-zalgo-mark-property-widening.test.js -- F-046d3756 (HIGH,
 * wave 26): ZALGO_RUN (commands/lib/escape-reason.js), even after two rounds
 * of fixes (F-37ba8d85 wave 22, F-6820e578 wave 24), still matched its mark
 * class as ONE hardcoded Unicode block enumeration (U+0300-U+036F,
 * "Combining Diacritical Marks" proper) rather than the Unicode Mark
 * property -- exactly the enumerated-list shape F-6540ba3d had already
 * generalized CONTROL_CLASS away from (replacing it with
 * `\p{Default_Ignorable_Code_Point}`), never applied to its neighbor.
 *
 * At least four further standard blocks are General_Category=Mn or Me and
 * visually stack onto a preceding base exactly like the covered block:
 * Combining Diacritical Marks Supplement (U+1DC0-U+1DFF, Mn), Combining
 * Diacritical Marks for Symbols (U+20D0-U+20FF -- both Mn, e.g. U+20D3, and
 * Me, e.g. U+20DD), Combining Half Marks (U+FE20-U+FE2F, Mn), and the
 * Combining Cyrillic Titlo/Palatalization pair (U+0483-U+0484, Mn). Proven
 * live against the real, unmutated exported functions: a 20x U+20D3 stack on
 * one base character, with NO ZWJ or interleaving trick required at all,
 * returned completely byte-identical from all three exported functions;
 * separately, interleaving a classic-range mark with an alternate-range mark
 * on the same base defeated both the pre-wave-24 and the wave-24 fix
 * simultaneously, because the old hardcoded class recognized neither range
 * as containing the other.
 *
 * Fixed by replacing the hardcoded block with a Unicode-property union,
 * `[\p{Mn}\p{Me}]`, mirroring F-6540ba3d's own "property, not enumerated
 * list" discipline. `\p{Mc}` (spacing combining marks) is deliberately
 * EXCLUDED -- they carry their own visible advance width and are not the
 * invisible-pileup threat this pass targets; folding them in would reopen
 * F-37ba8d85's over-broad NFD-mangling problem in the opposite direction.
 * The >=3-mark threshold and the ZWJ-interleave counting F-6820e578 built
 * are unchanged.
 *
 * Every codepoint here is built via String.fromCodePoint(<number>) rather
 * than a `\u{}` escape literal or a raw glyph -- this repo's established
 * "never a raw glyph in this file's own source bytes" rule
 * (f-f1dae277-ownership-violation-path-escaping.test.js /
 * f-35a809f3-trojan-source-control-class.test.js /
 * f-6820e578-zalgo-zwj-chain-bypass.test.js). Expected-escaped assertions
 * check only that the dangerous raw character no longer survives in the
 * output (`assert.ok(!out.includes(ch))`), never a hand-typed
 * escaped-string literal for these codepoints -- the exact `\xHH`/`\uHHHH`/
 * `\u{H+}` formatting boundary is already the dedicated subject of
 * f-6540ba3d-default-ignorable-property-widening.test.js and is out of
 * scope for this class-widening fix.
 *
 * Every assertion runs against the REAL exported functions (never a
 * reimplementation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  escapeReasonForDisplay,
  neutralizeInvisibleControls,
  escapePathForDisplay,
} from './commands/lib/escape-reason.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The four further standard blocks the finding names, plus a representative
// codepoint from each -- one Mn member and one Me member from the same block
// (Combining Diacritical Marks for Symbols is the one block in this set that
// contains both categories).
//
// F-1c634b2f (wave 29, defense in depth): Hebrew POINT SHEVA added -- a major
// script (Hebrew) this fix's own wave-26 commit message never named, verified
// directly against Node's real \p{Mn} engine (Mn=true, Me=false, Mc=false)
// rather than assumed, so a future narrowing of the mark class has to
// specifically re-cover named scripts, not just re-enumerate the 5 blocks the
// original author happened to sample.
const NEW_BLOCK_MARKS = [
  { label: 'Combining Diacritical Marks Supplement (Mn)', cp: 0x1dc0, category: 'Mn' },
  { label: 'Combining Diacritical Marks for Symbols (Mn, COMBINING ANTICLOCKWISE ARROW ABOVE)', cp: 0x20d3, category: 'Mn' },
  { label: 'Combining Diacritical Marks for Symbols (Me, COMBINING ENCLOSING CIRCLE)', cp: 0x20dd, category: 'Me' },
  { label: 'Combining Half Marks (Mn)', cp: 0xfe20, category: 'Mn' },
  { label: 'Combining Cyrillic Titlo (Mn)', cp: 0x0483, category: 'Mn' },
  { label: 'Hebrew POINT SHEVA (Mn)', cp: 0x05b0, category: 'Mn' },
];

const CLASSIC_GRAVE = String.fromCodePoint(0x0300); // the one block the old hardcoded class DID cover
const CLASSIC_ACUTE = String.fromCodePoint(0x0301);
const ZWJ = String.fromCodePoint(0x200d);

function stackedPayload(cp, count) {
  return 'a' + String.fromCodePoint(cp).repeat(count);
}

// Reconstructs wave-24's hardcoded-block ZALGO_RUN (the pattern this finding
// replaces) via numeric codepoint construction -- never a raw combining-mark
// glyph typed directly into this file's own source bytes.
function buildPreFixZalgoRun() {
  const open = String.fromCharCode(0x5b); // [
  const dash = String.fromCharCode(0x2d); // -
  const close = String.fromCharCode(0x5d); // ]
  const lo = String.fromCodePoint(0x0300);
  const hi = String.fromCodePoint(0x036f);
  const zwj = String.fromCodePoint(0x200d);
  const mark = open + lo + dash + hi + close;
  return new RegExp(mark + '(?:' + zwj + '?' + mark + ')*', 'gu');
}

/** @pins F-046d3756 */
describe('F-046d3756 -- ZALGO_RUN matches the real Unicode Mn/Me mark property, not one hardcoded block', () => {
  describe('meta (Proving a gate): the pre-fix hardcoded-range ZALGO_RUN would NOT have caught any of these payloads', () => {
    it('reconstructing wave-24\'s hardcoded [U+0300-U+036F] class confirms it does not match a 20x stack of any newly-covered codepoint', () => {
      const preFix = buildPreFixZalgoRun();
      for (const { label, cp } of NEW_BLOCK_MARKS) {
        preFix.lastIndex = 0;
        const payload = stackedPayload(cp, 20);
        assert.equal(
          preFix.test(payload), false,
          `sanity: the OLD hardcoded-range regex must NOT match a U+${cp.toString(16)} stack (${label}) -- it is a real bypass, not hypothetical`,
        );
      }
    });

    it('reconstructing wave-24\'s hardcoded class also fails to catch a classic-range mark interleaved with an alternate-range mark on the same base', () => {
      const preFix = buildPreFixZalgoRun();
      const ALT = String.fromCodePoint(0x20d3);
      const payload = 'e' + [CLASSIC_GRAVE, ALT, CLASSIC_ACUTE, ALT, CLASSIC_GRAVE, ALT, CLASSIC_ACUTE, ALT, CLASSIC_GRAVE, ALT].join('');
      // The old class only ever matches a single classic-range mark at a time
      // (the alternate-range mark breaks continuation), so no contiguous
      // match of length >= 3 exists anywhere in this payload.
      let longestRun = 0;
      let m;
      preFix.lastIndex = 0;
      while ((m = preFix.exec(payload)) !== null) {
        longestRun = Math.max(longestRun, Array.from(m[0]).length);
        if (m.index === preFix.lastIndex) preFix.lastIndex++;
      }
      assert.ok(longestRun < 3, `sanity: the OLD hardcoded-range regex must never see a run >= 3 marks long in this interleaved payload -- longest was ${longestRun}`);
    });
  });

  // F-1c634b2f (wave 29): the section above -- and "the proven bypass payloads
  // are now escaped" below -- are BOTH sampling tests: they prove specific
  // codepoints round-trip correctly, but a regex that hardcodes a bigger
  // enumerated list covering exactly those samples would pass every one of
  // them identically to the real \p{Mn}\p{Me} property-based fix. Proven by
  // direct construction (scratch copy, zero repo writes): a mutant hardcoding
  // the union of the 5 sampled blocks fools every test in both describe
  // blocks above and below, 18/18 green, while remaining structurally the
  // exact "enumerated list, not a property" disease this file's own header
  // says F-046d3756 was fixing. This section pins the MECHANISM directly
  // (source-text, analogous to this repo's declared-pin AST check) rather
  // than more sampled outputs of it -- PROTOCOL.md "Proving a gate" applied to
  // the TEST's own verification, not just the code it protects.
  //
  // No @pins tag on the test below: this fix is entirely inside this test
  // file (a new assertion reading ZALGO_RUN's own declaration text) with no
  // corresponding production-source change -- commands/lib/escape-reason.js's
  // ZALGO_RUN was already correct and is unchanged by this wave. No
  // production-source F-1c634b2f pin exists for a declared tag to resolve
  // against (same shape as wave-22 F-7d4ac5ce, reason-escaping-discipline.
  // test.js's F-84badba1). The existing `@pins F-046d3756` on the outer
  // describe above already credits that finding; this section extends its
  // coverage rather than opening a second one.
  describe('structural pin (not sampling): ZALGO_RUN\'s declared regex source is provably property-based', () => {
    it('the real ZALGO_RUN declaration in commands/lib/escape-reason.js literally references \\p{Mn} and \\p{Me}, not a re-enumerated block list', () => {
      // ZALGO_RUN is module-private (not exported) -- reading the source text
      // directly is the mechanism-level pin available without a cross-domain
      // export change to commands/lib/escape-reason.js (owned by
      // swarm-cp-verbs, out of this domain's scope).
      const escapeReasonSrc = stripComments(
        readFileSync(join(__dirname, 'commands/lib/escape-reason.js'), 'utf-8')
      );
      const declarationLine = escapeReasonSrc
        .split('\n')
        .find((line) => line.trim().startsWith('const ZALGO_RUN ='));

      assert.ok(declarationLine,
        'sanity: could not find the `const ZALGO_RUN = ...` declaration in commands/lib/escape-reason.js -- ' +
        'this pin\'s anchor text needs updating if the declaration moved or was renamed');
      assert.ok(declarationLine.includes('\\p{Mn}'),
        `ZALGO_RUN's declaration must literally reference the \\p{Mn} Unicode property, not a hardcoded ` +
        `range union -- got: ${declarationLine}`);
      assert.ok(declarationLine.includes('\\p{Me}'),
        `ZALGO_RUN's declaration must literally reference the \\p{Me} Unicode property -- got: ${declarationLine}`);
    });

    it('mutation proof: a 5-block hardcoded-enumeration mutant (deliberately generous -- covers every codepoint the sampling tests above check) fails this structural pin', () => {
      // Reconstructs the exact class of mutant the finding describes: a
      // regex covering precisely the 5 sampled blocks NEW_BLOCK_MARKS checks,
      // widened generously, but built from hardcoded ranges rather than
      // \p{Mn}\p{Me}. This is a scratch STRING, never written to disk or to
      // the real source file.
      const mutantLine =
        "const ZALGO_RUN = /[\\u0300-\\u036f\\u0480-\\u0489\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]" +
        "(?:\\u200d?[\\u0300-\\u036f\\u0480-\\u0489\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f])*/gu;";

      assert.ok(!mutantLine.includes('\\p{Mn}') || !mutantLine.includes('\\p{Me}'),
        'sanity: the reconstructed mutant must NOT carry the property escapes (it is meant to fail the pin)');

      // The same check the real test above runs, applied to the mutant line.
      const mutantPassesStructuralPin = mutantLine.includes('\\p{Mn}') && mutantLine.includes('\\p{Me}');
      assert.equal(mutantPassesStructuralPin, false,
        'the 5-block hardcoded mutant must fail the structural pin -- if this assertion fails, the pin ' +
        'is not actually distinguishing a property fix from a bigger enumerated list');

      // And confirm the mutant is a FAITHFUL stand-in, not a strawman: it
      // must still match every codepoint the existing sampling tests check
      // (i.e., it would fool those tests exactly as the finding proved).
      const mutantRegex = new RegExp(
        '[\\u0300-\\u036f\\u0480-\\u0489\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]' +
        '(?:\\u200d?[\\u0300-\\u036f\\u0480-\\u0489\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f])*',
        'gu'
      );
      for (const { label, cp } of NEW_BLOCK_MARKS.filter((m) => m.cp !== 0x05b0)) {
        mutantRegex.lastIndex = 0;
        assert.ok(mutantRegex.test(stackedPayload(cp, 3)),
          `sanity: the reconstructed mutant must still match U+${cp.toString(16)} (${label}) -- ` +
          `otherwise it is not the faithful stand-in the finding describes`);
      }
    });
  });

  describe('the proven bypass payloads are now escaped by the real, current exported functions', () => {
    for (const { label, cp } of NEW_BLOCK_MARKS) {
      it(`a 20x stack of U+${cp.toString(16)} (${label}) on one base character is escaped by escapeReasonForDisplay, neutralizeInvisibleControls, and escapePathForDisplay alike`, () => {
        const payload = stackedPayload(cp, 20);
        const ch = String.fromCodePoint(cp);

        const out1 = escapeReasonForDisplay(payload);
        assert.notEqual(out1, payload, `escapeReasonForDisplay must escape this payload -- got byte-identical output`);
        assert.ok(!out1.includes(ch), `escapeReasonForDisplay must not leave the raw mark in its output`);

        const out2 = neutralizeInvisibleControls(payload);
        assert.notEqual(out2, payload, `neutralizeInvisibleControls must escape this payload -- shares ZALGO_RUN with escapeReasonForDisplay`);
        assert.ok(!out2.includes(ch), `neutralizeInvisibleControls must not leave the raw mark in its output`);

        const out3 = escapePathForDisplay(payload);
        assert.notEqual(out3, payload, `escapePathForDisplay must escape this payload -- it delegates to escapeReasonForDisplay`);
        assert.ok(!out3.includes(ch), `escapePathForDisplay must not leave the raw mark in its output`);
      });
    }

    it('interleaving a classic-range mark with an alternate-range mark on the same base (10 marks, no ZWJ) is now escaped -- the second bypass construction the finding proved', () => {
      const ALT = String.fromCodePoint(0x20d3);
      const payload = 'e' + [CLASSIC_GRAVE, ALT, CLASSIC_ACUTE, ALT, CLASSIC_GRAVE, ALT, CLASSIC_ACUTE, ALT, CLASSIC_GRAVE, ALT].join('');
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(out, payload, 'the classic+alternate interleave must now escape as one contiguous 10-mark run');
      assert.ok(!out.includes(CLASSIC_GRAVE) && !out.includes(ALT), 'no raw mark from either range may survive');
    });
  });

  describe('non-regression: ordinary 1-2 mark NFD text in any script (any covered block) stays byte-identical', () => {
    it('a real NFD Vietnamese syllable (base + 1 combining mark) renders unmangled', () => {
      const HOOK_ABOVE = String.fromCodePoint(0x0309);
      const phrase = 's' + 'u' + HOOK_ABOVE + 'a';
      assert.equal(escapeReasonForDisplay(phrase), phrase);
    });

    it('a real NFD polytonic Greek syllable (base + 2 combining marks: smooth breathing + acute) renders unmangled', () => {
      const ALPHA = String.fromCodePoint(0x03b1);
      const SMOOTH_BREATHING = String.fromCodePoint(0x0313);
      const word = ALPHA + SMOOTH_BREATHING + CLASSIC_ACUTE;
      assert.equal(escapeReasonForDisplay(word), word);
    });

    it('an isolated single mark from one of the NEWLY covered blocks (U+20D3, Mn) still passes through unescaped -- the threshold is unchanged, only the recognized mark SET grew', () => {
      const ch = String.fromCodePoint(0x20d3);
      const payload = 'e' + ch;
      assert.equal(escapeReasonForDisplay(payload), payload);
    });

    it('two marks from a newly-covered block (U+20DD, Me) on one base still pass through unescaped', () => {
      const ch = String.fromCodePoint(0x20dd);
      const payload = 'e' + ch + ch;
      assert.equal(escapeReasonForDisplay(payload), payload);
    });
  });

  describe('the deliberate Mc (spacing combining mark) exclusion holds', () => {
    it('a single Mc codepoint (U+093E DEVANAGARI VOWEL SIGN AA) is not escaped', () => {
      const AA = String.fromCodePoint(0x093e);
      const KA = String.fromCodePoint(0x0915);
      const payload = KA + AA;
      assert.equal(escapeReasonForDisplay(payload), payload);
    });

    it('Mc is excluded regardless of run length -- 20 repeated Mc codepoints on one base still pass through unescaped', () => {
      const AA = String.fromCodePoint(0x093e);
      const KA = String.fromCodePoint(0x0915);
      const payload = KA + AA.repeat(20);
      assert.equal(
        escapeReasonForDisplay(payload), payload,
        'Mc must never be treated as part of the invisible-pileup mark class, however many are chained',
      );
    });
  });

  describe('no regression on the wave-24 ZWJ-interleaving fix (F-6820e578)', () => {
    it('a 20-group "2 classic marks + ZWJ" chain (40 marks, 19 ZWJ) still escapes in full', () => {
      const groups = [];
      for (let i = 0; i < 20; i++) groups.push(CLASSIC_GRAVE + CLASSIC_ACUTE);
      const payload = 'a' + groups.join(ZWJ);
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(out, payload, 'the wave-24 ZWJ-chain bypass fix must still hold after this wave\'s class widening');
      assert.ok(!out.includes(CLASSIC_GRAVE) && !out.includes(CLASSIC_ACUTE));
    });

    it('a ZWJ-interleaved chain built from a NEWLY covered block (U+20D3) also escapes -- the ZWJ counting logic is mark-set-agnostic', () => {
      const ALT = String.fromCodePoint(0x20d3);
      const groups = [];
      for (let i = 0; i < 20; i++) groups.push(ALT + ALT);
      const payload = 'a' + groups.join(ZWJ);
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(out, payload, 'ZWJ-interleaved chains built from the newly-covered blocks must escape exactly like the classic block does');
    });
  });

  describe('CONTROL_CLASS is unaffected by this ZALGO_RUN-only fix', () => {
    it('a Bidi_Control codepoint (RLO, U+202E) still escapes -- spot-check, not a re-proof', () => {
      const RLO = String.fromCodePoint(0x202e);
      const out = escapeReasonForDisplay(`x${RLO}y`);
      assert.ok(!out.includes(RLO));
    });
  });

  describe('purity (this file\'s own documented invariant, unaffected by this fix)', () => {
    it('escapeReasonForDisplay never mutates its input', () => {
      const raw = stackedPayload(0x20d3, 5);
      const rawCopy = raw.slice();
      escapeReasonForDisplay(raw);
      assert.equal(raw, rawCopy);
    });
  });
});
