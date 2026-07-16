/**
 * f-d2d06af3-neutralizer-primitive.test.js — the neutralizeInvisibleControls
 * primitive (commands/lib/escape-reason.js), coordinator-added at the wave-24
 * merge to close the core↔verbs seam.
 *
 * F-d2d06af3 (HIGH) fixed prompt-injection into the next audit agent's prompt
 * (lib/templates.js buildAmendPrompt/buildAuditPrompt) by neutralizing the
 * invisible/deception codepoint class in audited-repo-controlled finding
 * fields. That surface must NOT use escapeReasonForDisplay: its backslash- and
 * quote-escaping passes corrupt legitimate quoted paths/code the agent reads
 * verbatim, and fight fenceSafeBlock. This file pins the PRIMITIVE's defining
 * contract — the two behaviours that make it distinct from the terminal
 * escaper, which is the entire reason it exists as a separate wrapper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  neutralizeInvisibleControls,
  escapeReasonForDisplay,
} from './commands/lib/escape-reason.js';

// U+E0041 TAG LATIN CAPITAL LETTER A — the Tag-block ASCII-smuggling channel
// (F-6540ba3d), built from a codepoint number so no raw invisible glyph lives
// in this file's source bytes (the hazard verbs caught in its own tests).
const TAG_A = String.fromCodePoint(0xe0041);
const RLO = String.fromCodePoint(0x202e); // bidi override

describe('neutralizeInvisibleControls — the security half only (F-d2d06af3)', () => {
  /** @pins F-d2d06af3 */
  it('strips the invisible/deception class (Tag block, bidi) — the injection vector', () => {
    const out = neutralizeInvisibleControls(`file${TAG_A}${RLO}.js`);
    assert.ok(!out.includes(TAG_A), 'Tag-block codepoint must not survive');
    assert.ok(!out.includes(RLO), 'bidi override must not survive');
  });

  /** @pins F-d2d06af3 */
  it('PRESERVES real whitespace (tab, newline, CR) — a prompt is multi-line by design', () => {
    // The wave-24 serial verify caught the first cut of this primitive
    // flattening real newlines to visible \x0a markers (it reused the terminal
    // CONTROL_CLASS, which spans \x00-\x1f). A multi-line description / fenced
    // code block the next agent reads must keep its real line breaks.
    const input = 'line one\nline two\tindented\r\nline three';
    assert.equal(neutralizeInvisibleControls(input), input,
      'tab/LF/CR must pass through as real whitespace, not visible escape markers');
  });

  /** @pins F-d2d06af3 */
  it('PRESERVES backslash and double-quote verbatim — the difference from the terminal escaper', () => {
    // This is the whole point: on an agent-read prompt, legitimate quoted
    // paths/code must survive byte-for-byte. escapeReasonForDisplay would
    // double the backslash and escape the quote; the neutralizer must not.
    const input = 'const p = "C:\\\\Users\\\\a"; // a "quoted" path';
    assert.equal(neutralizeInvisibleControls(input), input,
      'ordinary backslash/quote prose must pass through unmodified');

    const terminal = escapeReasonForDisplay(input);
    assert.notEqual(terminal, input,
      'sanity: the terminal escaper DOES alter backslash/quote (that is why prompts need the neutralizer instead)');
  });

  /** @pins F-d2d06af3 */
  it('shares the zalgo-ZWJ-chain protection (F-6820e578) — density is bounded regardless of ZWJ interleaving', () => {
    // 1 base + 20 groups of (2 combining marks + ZWJ) = the chain that
    // bypassed the pre-F-6820e578 contiguous-run check. The shared primitive
    // means the verbs zalgo fix protects this wrapper too.
    const mark1 = String.fromCodePoint(0x0300);
    const mark2 = String.fromCodePoint(0x0301);
    const zwj = String.fromCodePoint(0x200d);
    const payload = 'A' + Array.from({ length: 20 }, () => mark1 + mark2 + zwj).join('');
    const out = neutralizeInvisibleControls(payload);
    assert.notEqual(out, payload, 'a 40-mark ZWJ-chained zalgo payload must be escaped, not passed through');
  });
});
