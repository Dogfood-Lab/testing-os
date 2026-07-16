/**
 * f-6540ba3d-default-ignorable-property-widening.test.js -- F-6540ba3d
 * (MEDIUM, wave 22): wave 20's CONTROL_CLASS (commands/lib/escape-reason.js)
 * widened the escaped class by hand-naming Unicode BLOCKS (the zero-width
 * block, bidi marks/embeddings/overrides/isolates, ALM, BOM). That approach
 * left 32 further codepoints sharing the exact same invisible/steganography-
 * hazard property Unicode itself names Default_Ignorable_Code_Point (UTS #39,
 * Unicode Security Mechanisms) unescaped -- most consequential the Unicode
 * TAG block (U+E0000-U+E007F), the "ASCII Smuggling" invisible-instruction-
 * injection primitive (Goodside; tooled as Rehberger's "ASCII Smuggler";
 * shown to weaken LLM guardrails by Daniel & Pal 2024, arXiv:2405.14490, and
 * shown to be decoded PREFERENTIALLY BY ANTHROPIC MODELS by Graves 2026,
 * arXiv:2603.00164). Fixed by adopting the real Unicode property directly via
 * `\p{Default_Ignorable_Code_Point}` (Node's `v`-flag Unicode-set notation)
 * instead of another one-off range patch.
 *
 * Every assertion runs against the REAL exported escapeReasonForDisplay
 * (never a reimplementation). Two obligations, mirroring
 * f-35a809f3-trojan-source-control-class.test.js's own established shape:
 *   1. A representative codepoint from EACH previously-unescaped
 *      Default_Ignorable_Code_Point gap is neutralized.
 *   2. Every wave-20 genuine positive (the 12 formal Bidi_Control codepoints,
 *      ZWSP, BOM) still neutralizes -- the property switch must not
 *      regress what was already correct.
 * Plus the one honest, independently-verified discrepancy against the
 * finding's own prose: the interlinear-annotation characters (U+FFF9-U+FFFB)
 * some prose lumped in as "the same property" are confirmed NOT
 * Default_Ignorable_Code_Point members (Unicode's own derivation excludes
 * them), so they correctly stay unescaped -- "authoritative source, never
 * memory" applied to a past finding's own claim, not just to the source code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeReasonForDisplay } from './commands/lib/escape-reason.js';

// Representative codepoints for each gap F-6540ba3d names, all confirmed
// Default_Ignorable_Code_Point members by direct probe against Node's real
// `\p{Default_Ignorable_Code_Point}` engine (not assumed from the finding's
// prose).
const NEWLY_COVERED = [
  { label: 'Unicode TAG block ASCII-Smuggling primitive (U+E0041, "TAG LATIN CAPITAL LETTER A")', cp: 0xe0041 },
  { label: 'Variation Selector (U+FE0F, VS16)', cp: 0xfe0f },
  { label: 'Variation Selector Supplement (U+E0100)', cp: 0xe0100 },
  { label: 'Word Joiner (U+2060)', cp: 0x2060 },
  { label: 'invisible math operator FUNCTION APPLICATION (U+2061)', cp: 0x2061 },
  { label: 'deprecated bidi-shaping control (U+206A)', cp: 0x206a },
  { label: 'Mongolian Free Variation Selector (U+180B)', cp: 0x180b },
  { label: 'Mongolian Vowel Separator (U+180E)', cp: 0x180e },
];

/** @pins F-6540ba3d */
describe('F-6540ba3d -- CONTROL_CLASS adopts the real Default_Ignorable_Code_Point property, closing wave 20\'s named-block gaps', () => {
  it('neutralizes a representative codepoint from each previously-unescaped Default_Ignorable_Code_Point gap', () => {
    for (const { label, cp } of NEWLY_COVERED) {
      const ch = String.fromCodePoint(cp);
      const out = escapeReasonForDisplay(`before${ch}after`);
      assert.ok(!out.includes(ch), `${label} must not survive unescaped -- got "${out}"`);
    }
  });

  it('renders the Tag-block ASCII-Smuggling primitive as an unambiguous \\u{H+} escape, not a malformed fixed-width one', () => {
    const TAG_A = String.fromCodePoint(0xe0041);
    const out = escapeReasonForDisplay(`x${TAG_A}y`);
    assert.equal(out, 'x\\u{e0041}y', `expected the variable-width \\u{...} form for a codepoint above the BMP -- got "${out}"`);
    // The malformed shape a fixed-4-hex-digit table (padStart(4) as a no-op
    // once the hex string already exceeds 4 digits) would have produced: a
    // literal, non-self-delimiting 7-character run with no closing brace.
    assert.ok(!out.includes('\\ue0041'), `must not contain the old malformed fixed-width shape (no closing brace) -- got "${out}"`);
  });

  it('does not regress wave 20\'s own genuine positive: all 12 formal Bidi_Control codepoints still neutralize', () => {
    // ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI -- the complete
    // Unicode Bidi_Control=Yes set.
    const ALL_12_BIDI_CONTROL = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2066, 0x2067, 0x2068, 0x2069,
    ];
    for (const cp of ALL_12_BIDI_CONTROL) {
      const ch = String.fromCodePoint(cp);
      const out = escapeReasonForDisplay(`x${ch}y`);
      assert.ok(!out.includes(ch), `Bidi_Control U+${cp.toString(16)} must still be escaped (no regression) -- got "${out}"`);
    }
  });

  it('does not regress ZWSP or BOM (Default_Ignorable_Code_Point members wave 20 already covered by name)', () => {
    for (const cp of [0x200b, 0xfeff]) {
      const ch = String.fromCodePoint(cp);
      const out = escapeReasonForDisplay(`x${ch}y`);
      assert.ok(!out.includes(ch), `U+${cp.toString(16)} must still be escaped -- got "${out}"`);
    }
  });

  it('the interlinear-annotation characters (U+FFF9-U+FFFB) are confirmed NOT Default_Ignorable_Code_Point members and correctly stay unescaped -- an honest discrepancy against prose that lumped them in as "the same property"', () => {
    for (const cp of [0xfff9, 0xfffa, 0xfffb]) {
      const ch = String.fromCodePoint(cp);
      const out = escapeReasonForDisplay(`x${ch}y`);
      assert.equal(out, `x${ch}y`, `U+${cp.toString(16)} is not a Default_Ignorable_Code_Point member (Unicode's own derivation excludes interlinear annotation characters -- they must render visibly without dedicated support) and must pass through untouched -- got "${out}"`);
    }
  });

  it('ordinary text (ASCII, precomposed accented Latin, CJK, plain emoji) survives completely intact', () => {
    assert.equal(escapeReasonForDisplay('rollback completed cleanly'), 'rollback completed cleanly');
    assert.equal(escapeReasonForDisplay(String.fromCharCode(0x63, 0x61, 0x66, 0xe9)), String.fromCharCode(0x63, 0x61, 0x66, 0xe9)); // precomposed "cafe" + U+00E9
    assert.equal(escapeReasonForDisplay('日本語'), '日本語'); // CJK
    assert.equal(escapeReasonForDisplay('\u{1f389}\u{1f680}'), '\u{1f389}\u{1f680}'); // plain emoji, no ZWJ
  });
});
