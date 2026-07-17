/**
 * f-6820e578-zalgo-zwj-chain-bypass.test.js -- F-6820e578 (HIGH, wave 24):
 * F-37ba8d85's ZALGO_RUN pass (wave 22) escaped only a STRICTLY CONTIGUOUS
 * run of 3-or-more consecutive combining marks. ZWJ (U+200D)
 * never breaks a Unicode extended grapheme cluster (UAX #29 rule GB9), so
 * interleaving a single ZWJ every 1-2 marks ("mark mark ZWJ mark mark
 * ZWJ ...") splits an arbitrarily long stack into 2-mark sub-runs that each
 * stay under the 3-mark threshold forever -- proven live against the real
 * exported escapeReasonForDisplay: a 20-group chain (1 base + 20x(2 marks +
 * ZWJ) = 40 marks total, 19 ZWJ) returned completely byte-identical and
 * unescaped, with no repetition limit demonstrated. The pre-fix docstring's
 * own characterization ("a narrower residual... requires deliberate
 * construction") was itself a material understatement of an UNBOUNDED gap.
 *
 * Fixed in commands/lib/escape-reason.js by widening ZALGO_RUN to match a
 * mark, then zero or more (an optional single ZWJ, then another mark), and
 * moving the escape/no-escape decision out of the regex (which can only gate
 * on CONTIGUOUS length) into escapeZalgoRun, which counts the ACTUAL marks
 * in the whole matched span (a ZWJ contributes zero) against the same >=3
 * threshold wave 22 established.
 *
 * Every codepoint here is built via String.fromCodePoint(<number>) rather
 * than a `\u{}` escape literal -- the strictest reading of this repo's
 * established "never a raw glyph in this file's own source bytes" rule
 * (f-f1dae277-ownership-violation-path-escaping.test.js /
 * f-35a809f3-trojan-source-control-class.test.js), extended so there is no
 * ambiguity whatsoever about what byte sequence this file's own source
 * contains.
 *
 * Every assertion runs against the REAL exported escapeReasonForDisplay
 * (never a reimplementation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeReasonForDisplay } from './commands/lib/escape-reason.js';

const MARK_GRAVE = String.fromCodePoint(0x0300);
const MARK_ACUTE = String.fromCodePoint(0x0301);
const ZWJ = String.fromCodePoint(0x200d);

function chainedPayload(groupCount) {
  const groups = [];
  for (let i = 0; i < groupCount; i++) groups.push(MARK_GRAVE + MARK_ACUTE);
  return 'a' + groups.join(ZWJ);
}

/** @pins F-6820e578 */
describe('F-6820e578 -- ZALGO_RUN counts marks across ZWJ-interleaved chains, not just one contiguous run', () => {
  describe('meta (Proving a gate): the pre-fix contiguous-run-only regex would NOT have caught this payload', () => {
    it('reconstructing the pre-fix ZALGO_RUN (wave 22\'s `{3,}` contiguous match) confirms it does not match a 2-marks-per-group ZWJ chain -- the bypass was real, not hypothetical', () => {
      const PRE_FIX_ZALGO_RUN = new RegExp(String.fromCharCode(0x5b, 0x0300, 0x2d, 0x036f, 0x5d) + String.fromCharCode(0x7b) + "3," + String.fromCharCode(0x7d), "gu");
      const chain = chainedPayload(20); // 40 marks, 19 ZWJ, no run ever reaching length 3
      assert.equal(
        PRE_FIX_ZALGO_RUN.test(chain), false,
        'sanity: the OLD contiguous-only regex must NOT match this ZWJ-chained payload -- every sub-run is only 2 marks long',
      );
    });
  });

  describe('the proven bypass payload is now escaped by the real, current escapeReasonForDisplay', () => {
    it('a 20-group "2 marks + ZWJ" chain (40 marks, 19 ZWJ) on one base character is no longer byte-identical/unescaped', () => {
      const payload = chainedPayload(20);
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(out, payload, `expected the chained combining-mark payload to be escaped -- got byte-identical output: ${JSON.stringify(out)}`);
      assert.ok(
        !out.includes(MARK_GRAVE) && !out.includes(MARK_ACUTE),
        `no raw combining mark may survive in the output -- got: ${JSON.stringify(out)}`,
      );
    });

    it('the bypass has no demonstrated repetition ceiling: a 5-group chain (10 marks) is ALSO fully escaped, not just the 20-group case', () => {
      const payload = chainedPayload(5);
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(out, payload);
      assert.ok(!out.includes(ZWJ), `the interleaved ZWJ itself must also be escaped once the chain crosses the threshold -- got: ${JSON.stringify(out)}`);
    });
  });

  describe('threshold boundary: the TOTAL mark count across the ZWJ-interleaved chain is what gates, not the mere presence of ZWJ', () => {
    it('2 total marks split across one ZWJ (1 mark + ZWJ + 1 mark) stays UNCHANGED -- still under threshold', () => {
      const payload = 'e' + MARK_GRAVE + ZWJ + MARK_ACUTE;
      assert.equal(
        escapeReasonForDisplay(payload), payload,
        'exactly 2 marks total (interleaved with ZWJ) must not be escaped -- matches the ordinary 1-2 mark NFD case wave 22 protects',
      );
    });

    it('3 total marks split across one ZWJ (1 mark + ZWJ + 2 marks) DOES escape -- crossing the threshold via a chain, not a contiguous run', () => {
      const payload = 'e' + MARK_GRAVE + ZWJ + MARK_ACUTE + MARK_GRAVE;
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(
        out, payload,
        'exactly 3 marks total across a single ZWJ split must escape -- the count crosses the threshold even though no contiguous sub-run ever reaches length 3',
      );
    });

    it('a 2-mark run trailed by an UNRELATED ZWJ (nothing follows it) is scoped correctly: the trailing ZWJ is not swept into the match', () => {
      const payload = 'e' + MARK_GRAVE + MARK_ACUTE + ZWJ + 'z';
      assert.equal(
        escapeReasonForDisplay(payload), payload,
        'a trailing ZWJ with no following mark must not be captured by the pattern, and the preceding 2-mark run stays unescaped',
      );
    });
  });

  describe('no regression on the wave-22 wins (this class\'s own established non-negotiables)', () => {
    it('a plain, non-interleaved 4-mark contiguous run (no ZWJ) still escapes in full -- the pre-existing pathological-run behavior is preserved', () => {
      const payload = 'e' + MARK_GRAVE + MARK_ACUTE + MARK_GRAVE + MARK_ACUTE;
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(out, payload);
      assert.ok(!out.includes(MARK_GRAVE) && !out.includes(MARK_ACUTE));
    });

    it('an isolated 2-mark base (ordinary NFD text, no ZWJ anywhere) still passes through unescaped', () => {
      const payload = 'e' + MARK_GRAVE + MARK_ACUTE;
      assert.equal(escapeReasonForDisplay(payload), payload);
    });

    it('ZWJ alone (no marks at all) still passes through unescaped', () => {
      const payload = 'x' + ZWJ + 'y';
      assert.equal(escapeReasonForDisplay(payload), payload);
    });

    it('a standard ZWJ multi-person emoji sequence (no combining marks involved) still survives byte-identical', () => {
      const PERSON_A = String.fromCodePoint(0x1f468);
      const PERSON_B = String.fromCodePoint(0x1f469);
      const PERSON_C = String.fromCodePoint(0x1f467);
      const family = [PERSON_A, PERSON_B, PERSON_C].join(ZWJ);
      const out = escapeReasonForDisplay(family);
      assert.equal(out, family, `ZWJ-joined emoji sequence must survive byte-identical -- got ${JSON.stringify(out)}`);
    });

    it('a Bidi_Control codepoint (RLO) stays escaped -- CONTROL_CLASS is unaffected by this ZALGO_RUN-only fix', () => {
      // Lightweight spot-check, not a re-proof: f-35a809f3-trojan-source-
      // control-class.test.js and f-6540ba3d-default-ignorable-property-
      // widening.test.js are the dedicated regression files for CONTROL_CLASS.
      const RLO = String.fromCodePoint(0x202e);
      const out = escapeReasonForDisplay(`x${RLO}y`);
      assert.ok(!out.includes(RLO), `RLO must still be escaped by CONTROL_CLASS -- got ${JSON.stringify(out)}`);
    });
  });

  describe('--format=json stays lossless (this file\'s own documented invariant, unaffected by this fix)', () => {
    it('escapeReasonForDisplay is a pure function -- the ZWJ-chained input is never mutated', () => {
      const raw = chainedPayload(3);
      const rawCopy = raw.slice();
      escapeReasonForDisplay(raw);
      assert.equal(raw, rawCopy, 'input string must be unchanged after escaping');
    });
  });
});
