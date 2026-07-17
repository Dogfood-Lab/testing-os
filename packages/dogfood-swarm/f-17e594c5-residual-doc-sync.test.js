/**
 * f-17e594c5-residual-doc-sync.test.js -- F-17e594c5 (MEDIUM, wave 26): the
 * "Known residual" doc comment immediately above escapeReasonForDisplay
 * (commands/lib/escape-reason.js) stated that a ZWJ deliberately interleaved
 * mid-run (mark, mark, ZWJ, mark, mark) is NOT itself escaped. That was true
 * when F-37ba8d85 (wave 22) wrote it, but F-6820e578 (wave 24, same file,
 * same wave the stale text survived) fixed exactly that case -- proven live
 * here: the literal scenario the stale paragraph described now returns fully
 * escaped output, not the byte-identical output the old text claimed. The
 * file carried two internally contradictory statements about the identical
 * scenario: the "History of the escaping contract" log (correct) and the
 * residual callout (stale), with the stale one positioned where a reader is
 * more likely to trust it at face value.
 *
 * Fixed by rewriting the paragraph to (a) state plainly that the ZWJ-mid-run
 * case is closed, pointing at the History log instead of re-describing a
 * closed case as current, and (b) disclose the boundary that ACTUALLY
 * remains post-F-046d3756 (this same wave's mark-class-property fix): a run
 * broken by a visible `\p{Mc}` spacing mark, interleaved the same
 * structural way ZWJ used to be, is not counted as one span -- verified live
 * below, not asserted from the finding's prose (this protocol's own
 * "authoritative source, never memory" sub-law). Note this test does NOT
 * point the residual note at F-046d3756 itself as "the current gap" (a
 * literal reading of one phrasing in the brief) -- that fix lands in the
 * SAME wave, in the SAME file, so a residual note naming it as "current"
 * would go stale the moment both fixes are committed together. Source (the
 * real, both-fixes-applied file) wins over that brief phrasing; this is the
 * documented discrepancy.
 *
 * Two kinds of assertion, deliberately combined:
 *   1. Textual: the raw (UNSTRIPPED) source of escape-reason.js no longer
 *      contains the stale claim's distinguishing phrase. Comments are
 *      intentionally NOT stripped here (unlike the pin-matcher / call-shape
 *      sweeps elsewhere in this package) because the doc TEXT itself, inside
 *      a comment, is the exact thing under test -- stripping comments would
 *      remove the very content this test verifies.
 *   2. Behavioral: the real exported escapeReasonForDisplay is executed
 *      against the stale paragraph's own literal example, and against the
 *      new paragraph's own literal Mc-interleaving example, so the doc's
 *      CURRENT claims are grounded in direct execution, not just text
 *      presence.
 *
 * Every codepoint here is built via String.fromCodePoint(<number>), never a
 * raw glyph typed into this file's own source bytes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { escapeReasonForDisplay } from './commands/lib/escape-reason.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ESCAPE_REASON_PATH = path.join(__dirname, 'commands', 'lib', 'escape-reason.js');

function readSourceRaw() {
  // Deliberately NOT stripComments()'d -- see file header. The assertion
  // target here is doc TEXT, which lives only inside comments.
  return readFileSync(ESCAPE_REASON_PATH, 'utf-8');
}

/** @pins F-17e594c5 */
describe('F-17e594c5 -- the "Known residual" doc comment stays synchronized with the file\'s own fix history', () => {
  describe('the stale claim is gone from source', () => {
    it('the file no longer contains the old paragraph\'s distinguishing claim that a ZWJ-interleaved run is not caught by the 3-mark threshold', () => {
      const src = readSourceRaw();
      assert.ok(
        !src.includes("neither reaching ZALGO_RUN's 3-mark threshold"),
        'the stale phrase from the pre-fix "Known residual" paragraph must not survive anywhere in the file',
      );
    });

    it('the correction is attributed inline (F-17e594c5) rather than silently rewritten with no trace', () => {
      const src = readSourceRaw();
      assert.ok(
        src.includes('F-17e594c5'),
        'the residual paragraph should name the finding that corrected it, matching this file\'s own established attribution discipline',
      );
    });
  });

  describe('the doc\'s claim about the (now-closed) ZWJ-mid-run case is behaviorally accurate', () => {
    it('the stale paragraph\'s own literal example -- base + mark + mark + ZWJ + mark + mark -- is fully escaped by the real exported function, contradicting what the old text claimed', () => {
      const MARK_GRAVE = String.fromCodePoint(0x0300);
      const MARK_ACUTE = String.fromCodePoint(0x0301);
      const ZWJ = String.fromCodePoint(0x200d);
      const payload = 'e' + MARK_GRAVE + MARK_ACUTE + ZWJ + MARK_GRAVE + MARK_ACUTE;

      const out = escapeReasonForDisplay(payload);
      assert.notEqual(
        out, payload,
        'this exact scenario must now escape -- F-6820e578 (wave 24) fixed it, and the doc must not claim otherwise',
      );
      assert.ok(
        !out.includes(MARK_GRAVE) && !out.includes(MARK_ACUTE) && !out.includes(ZWJ),
        'none of the 4 marks or the interleaved ZWJ may survive raw in the output',
      );
    });
  });

  describe('the doc\'s claim about the CURRENT residual (Mc-interleaving) is behaviorally accurate', () => {
    it('alternating short Mn groups with a single Mc spacing mark between each never accumulates 3 counted marks in one match, exactly as the rewritten paragraph discloses', () => {
      const MN = String.fromCodePoint(0x0300); // classic combining grave, Mn
      const MC = String.fromCodePoint(0x093e); // DEVANAGARI VOWEL SIGN AA, Mc
      let payload = 'a';
      for (let i = 0; i < 10; i++) payload += MN + MN + MC;

      const out = escapeReasonForDisplay(payload);
      assert.equal(
        out, payload,
        'the disclosed residual must be real: this Mc-interleaved chain stays byte-identical, the same way the file\'s new "Known residual" paragraph says it does',
      );
    });

    it('the same Mn marks, WITHOUT the Mc interleaving, on one base DO escape -- isolating that Mc specifically is what breaks the run, not just "20 marks somewhere in the string"', () => {
      const MN = String.fromCodePoint(0x0300);
      const payload = 'a' + MN.repeat(20);
      const out = escapeReasonForDisplay(payload);
      assert.notEqual(
        out, payload,
        'without the Mc interleaving, a 20-mark contiguous run must still escape -- confirms the residual is specifically about the Mc break, not a general regression',
      );
    });

    it('the rewritten residual paragraph explicitly names \\p{Mc} as the current boundary, so a future reader is not left with only the closed ZWJ case as the stated residual', () => {
      const src = readSourceRaw();
      assert.ok(
        src.includes('\\p{Mc}'),
        'the current "Known residual" text should name the Mc boundary it discloses',
      );
    });
  });
});
