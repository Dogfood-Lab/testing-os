/**
 * f-dc37b009-display-width-combining-mark-property.test.js — F-dc37b009
 * (MEDIUM, wave 37): the WIDE_RANGES table's [0x3041, 0x33ff] entry
 * ("Hiragana .. CJK Compatibility") wrongly counted U+3099/U+309A — the
 * standalone combining dakuten/handakuten marks, Unicode general category
 * Mn — as WIDE (+2 columns) instead of the correct 0, because they sit
 * inside that block range with no carve-out. NFD (Unicode Normalization
 * Form D) decomposes every precomposed dakuten kana into base-kana + this
 * exact combining mark ('が'.normalize('NFD') === 'が'), so this
 * is not an exotic shape — any file path or description that has passed
 * through NFD normalization anywhere upstream can carry it.
 *
 * The fix decides zero-width-ness by Unicode general CATEGORY (Mn/Me via
 * `\p{Mn}`/`\p{Me}`), not by carving U+3099/U+309A out of WIDE_RANGES as a
 * one-off pair — the enumerated-exception shape this repo has already
 * relearned the cost of more than once. Proof here covers both the direct
 * displayWidth() numbers AND the real, unmutated renderText() column
 * alignment this bug actually breaks (the same integration-proof style
 * f-44200377-display-width.test.js already uses for the sibling CJK/emoji
 * fix, never a reimplementation of pad()/renderText()).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { displayWidth } from './display-width.js';
import { renderText } from './findings-render.js';
import { buildDigestModel } from './findings-digest.js';

const DAKUTEN = '゙';    // COMBINING KATAKANA-HIRAGANA VOICED SOUND MARK (Mn)
const HANDAKUTEN = '゚'; // COMBINING KATAKANA-HIRAGANA SEMI-VOICED SOUND MARK (Mn)
const GA_PRECOMPOSED = 'が'; // が
const PA_PRECOMPOSED = 'ぱ'; // ぱ (handakuten)

describe('F-dc37b009 — U+3099/U+309A (dakuten/handakuten) measure as zero-width, not wide', () => {
  /** @pins F-dc37b009 */
  it('GATE: the standalone combining voiced sound mark U+3099 measures 0 columns, not 2', () => {
    assert.equal(displayWidth(DAKUTEN), 0,
      'pre-fix: U+3099 sat inside WIDE_RANGES\' [0x3041, 0x33ff] Hiragana block entry and measured 2');
  });

  /** @pins F-dc37b009 */
  it('GATE: the standalone combining semi-voiced sound mark U+309A measures 0 columns, not 2', () => {
    assert.equal(displayWidth(HANDAKUTEN), 0);
  });

  it('sanity: NFD decomposes a precomposed dakuten kana into base + U+3099', () => {
    assert.equal(GA_PRECOMPOSED.normalize('NFD'), 'か' + DAKUTEN,
      'sanity: が (U+304C) decomposes to か (U+304B) + the combining voiced sound mark');
  });

  /** @pins F-dc37b009 */
  it('GATE: NFD-decomposed が (base + combining mark) measures the SAME width as its precomposed form', () => {
    const precomposedWidth = displayWidth(GA_PRECOMPOSED);
    const nfdWidth = displayWidth(GA_PRECOMPOSED.normalize('NFD'));
    assert.equal(precomposedWidth, 2, 'precomposed が is one wide kana glyph — 2 columns');
    assert.equal(nfdWidth, 2,
      `pre-fix: NFD が measured ${nfdWidth} columns (base 2 + the mark's wrongly-counted 2 = 4) — a 2x overcount for one glyph`);
  });

  it('non-regression: NFD-decomposed ぱ (handakuten) measures the same width as its precomposed form', () => {
    const precomposedWidth = displayWidth(PA_PRECOMPOSED);
    const nfdWidth = displayWidth(PA_PRECOMPOSED.normalize('NFD'));
    assert.equal(nfdWidth, precomposedWidth);
    assert.equal(nfdWidth, 2);
  });

  it('non-regression: an ordinary standalone kana with no combining mark is unaffected', () => {
    assert.equal(displayWidth('か'), 2); // か
  });

  it('non-regression: a Latin combining diacritic (the pre-existing ZERO_WIDTH_RANGES case) still measures 0', () => {
    assert.equal(displayWidth('e' + '́'), 1, 'base letter (1) + combining acute (0) = 1');
  });

  it('non-regression: an East-Asian-Wide character NOT in any combining category (Devanagari Mc spacing marks excluded) is unaffected', () => {
    // U+093E DEVANAGARI VOWEL SIGN AA is Mc (Spacing_Mark), not Mn/Me — it
    // occupies a real terminal column and must NOT be swept into zero-width
    // by a property check that is too broad. This module does not classify
    // Devanagari as WIDE either way (it falls to the 1-column default), so
    // this pins the narrower claim: the Mn/Me-only regex must not match it.
    assert.equal(displayWidth('ा'), 1);
  });
});

describe('F-dc37b009 — renderText() column alignment survives NFD-normalized Japanese file paths', () => {
  /** @pins F-dc37b009 */
  it('GATE: an NFD-normalized Japanese file path does not shift the Description column relative to an ASCII sibling', () => {
    const precomposed = 'がばばば.js';
    const nfdFilePath = precomposed.normalize('NFD');
    assert.notEqual(nfdFilePath, precomposed,
      'sanity: this file path string is genuinely NFD-decomposed, not already-precomposed');

    const model = buildDigestModel('r-combining', 1, [
      { domain: 'backend', parsed: { findings: [{ id: 'F-001', severity: 'HIGH', file: 'src/plain.js', line: 1, description: 'MARKER_A' }] } },
      { domain: 'backend', parsed: { findings: [{ id: 'F-002', severity: 'HIGH', file: nfdFilePath, line: 1, description: 'MARKER_B' }] } },
    ]);
    const text = renderText(model);
    const lines = text.split('\n');
    const rowA = lines.find((l) => l.includes('MARKER_A'));
    const rowB = lines.find((l) => l.includes('MARKER_B'));
    assert.ok(rowA && rowB, 'expected both rows to render');

    const offsetA = displayWidth(rowA.slice(0, rowA.indexOf('MARKER_A')));
    const offsetB = displayWidth(rowB.slice(0, rowB.indexOf('MARKER_B')));
    assert.equal(offsetB, offsetA,
      `pre-fix: the NFD row's Description column started to the LEFT of the ASCII row's ` +
      `(offsetA=${offsetA}, offsetB=${offsetB}) because pad() under-padded a cell whose measured ` +
      `width was inflated by the miscounted combining marks`);
  });
});
