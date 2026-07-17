/**
 * f-44200377-display-width.test.js — F-44200377 (MEDIUM): findings-render.js's
 * TTY table renderers measured column width with JS string `.length`
 * (UTF-16 code-unit count), not terminal display width — an East-Asian-Wide
 * glyph (CJK, Hangul, fullwidth forms) or common emoji renders as 2 terminal
 * columns but counts as 1 (BMP) or 2 (astral, already a surrogate pair) code
 * units, throwing every column to the right of a wide-glyph cell out of
 * alignment for that row.
 *
 * Two layers of proof:
 *   1. Direct unit tests of the new lib/display-width.js primitives
 *      (displayWidth / sliceToDisplayWidth) against known code points.
 *   2. Integration tests driving the REAL, unmutated renderText() /
 *      renderVerifyFixedText() (never a reimplementation of pad()/maxWidth()/
 *      underline()/truncate()) with realistic CJK/emoji finding content,
 *      proving the emergent column-alignment property this file's own header
 *      comment documents as a guarantee ("aligned columns via String.padEnd
 *      matching the widest cell per column").
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { displayWidth, sliceToDisplayWidth } from './display-width.js';
import { renderText } from './findings-render.js';
import { buildDigestModel } from './findings-digest.js';

const FIRE = '\u{1F525}'; // 🔥 FIRE — astral, Misc Symbols and Pictographs (WIDE)
const CJK_DOMAIN = '前端团队'; // 前端团队 — 4 CJK ideographs (WIDE x4)
const CJK_FILE = '組件/主页面.js'; // 组件/主页面.js — mixed CJK + ASCII
const CJK_SYMBOL = '计算总数'; // 计算总数 — 4 CJK ideographs
const COMBINING_ACUTE = '́'; // combining acute accent — ZERO width

// ═══════════════════════════════════════════════════════════════════════
// 1. displayWidth() — direct unit coverage
// ═══════════════════════════════════════════════════════════════════════

describe('F-44200377 — displayWidth() measures terminal columns, not code units', () => {
  it('ASCII text: display width equals code-unit length', () => {
    assert.equal(displayWidth('backend'), 7);
    assert.equal(displayWidth(''), 0);
    assert.equal(displayWidth('a.js:12'), 7);
  });

  it('CJK ideographs: each character is 2 columns wide, not 1', () => {
    assert.equal(CJK_DOMAIN.length, 4, 'sanity: JS counts 4 UTF-16 code units');
    assert.equal(displayWidth(CJK_DOMAIN), 8, 'but the terminal renders 8 columns');
  });

  it('an astral emoji (surrogate pair) is measured as ONE wide code point, not two narrow ones', () => {
    assert.equal(FIRE.length, 2, 'sanity: JS counts a surrogate pair as 2 code units');
    assert.equal(displayWidth(FIRE), 2, 'the terminal renders one 2-column glyph, not two 1-column ones');
  });

  it('mixed CJK + ASCII sums each code point independently', () => {
    // 组件 (2 CJK, 4 cols) + / (1) + 主页面 (3 CJK, 6 cols) + .js (3) = 4+1+6+3 = 14
    assert.equal(displayWidth(CJK_FILE), 14);
  });

  it('a combining mark is zero-width', () => {
    assert.equal(displayWidth('e' + COMBINING_ACUTE), 1, 'base letter (1) + combining accent (0) = 1');
  });

  it('non-regression: nullish input measures as empty, matching String(s ?? \'\") elsewhere in this file', () => {
    assert.equal(displayWidth(undefined), 0);
    assert.equal(displayWidth(null), 0);
  });
});

describe('F-44200377 — sliceToDisplayWidth() cuts on a column budget without splitting a code point', () => {
  it('slices pure ASCII exactly like String#slice', () => {
    assert.equal(sliceToDisplayWidth('hello world', 5), 'hello');
  });

  it('stops BEFORE a wide character that would overflow the budget, never mid-character', () => {
    // 'ab' (2 cols) + CJK (2 cols) = 4, budget 3 must stop at 'ab' (2 cols),
    // not include half of the CJK character or overflow to 4.
    const s = 'ab' + '中'; // 'ab中'
    assert.equal(sliceToDisplayWidth(s, 3), 'ab');
    assert.equal(sliceToDisplayWidth(s, 4), 'ab中');
  });

  it('never splits an astral surrogate pair in half', () => {
    const s = 'a' + FIRE; // 1 + 2 = 3 columns total
    assert.equal(sliceToDisplayWidth(s, 2), 'a', 'budget 2 excludes the 2-wide emoji entirely, not half of it');
    assert.equal(sliceToDisplayWidth(s, 3), s);
    // Critically: the result must never be an unpaired lone surrogate.
    const cut = sliceToDisplayWidth(s, 2);
    assert.equal([...cut].length, 1, 'result is exactly one valid code point, never a split surrogate');
  });

  it('a zero-column budget returns an empty string', () => {
    assert.equal(sliceToDisplayWidth('anything', 0), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Integration: renderText() column alignment with realistic wide content
// ═══════════════════════════════════════════════════════════════════════

function twoRowModel(domainA, domainB) {
  return buildDigestModel('r-width', 1, [
    {
      domain: domainA,
      parsed: { findings: [{ id: 'F-001', severity: 'HIGH', file: 'src/a.js', line: 1, description: 'MARKER_A' }] },
    },
    {
      domain: domainB,
      parsed: { findings: [{ id: 'F-002', severity: 'HIGH', file: 'src/b.js', line: 2, description: 'MARKER_B' }] },
    },
  ]);
}

/** Column offset (in real terminal columns) at which `marker` begins on its line. */
function columnOffsetOf(text, marker) {
  const line = text.split('\n').find((l) => l.includes(marker));
  assert.ok(line, `expected to find a line containing ${marker}`);
  const idx = line.indexOf(marker);
  return displayWidth(line.slice(0, idx));
}

describe('F-44200377 — renderText() keeps columns aligned across ASCII and CJK/emoji rows', () => {
  /** @pins F-44200377 */
  it('GATE: a CJK domain cell pads to the SAME display width as an ASCII sibling, so Description starts at the same column', () => {
    const text = renderText(twoRowModel('backend', CJK_DOMAIN));
    const offsetAscii = columnOffsetOf(text, 'MARKER_A');
    const offsetCjk = columnOffsetOf(text, 'MARKER_B');
    assert.equal(
      offsetCjk, offsetAscii,
      `Description column must start at the same terminal column for both rows (ascii=${offsetAscii}, cjk=${offsetCjk})`,
    );
  });

  it('GATE: a CJK file path (File:Line column) does not shift the Description column relative to a plain-ASCII sibling', () => {
    const model = buildDigestModel('r-width-file', 1, [
      { domain: 'backend', parsed: { findings: [{ id: 'F-001', severity: 'HIGH', file: 'src/plain.js', line: 3, description: 'MARKER_A' }] } },
      { domain: 'backend', parsed: { findings: [{ id: 'F-002', severity: 'HIGH', file: CJK_FILE, line: 3, description: 'MARKER_B' }] } },
    ]);
    const text = renderText(model);
    assert.equal(columnOffsetOf(text, 'MARKER_A'), columnOffsetOf(text, 'MARKER_B'));
  });

  // DISCLOSED, checked directly (not assumed): a LONE wide astral emoji does
  // NOT by itself discriminate this bug — `'🔥'.length === 2` (a surrogate
  // pair) and `displayWidth('🔥') === 2` (a wide glyph) are numerically
  // equal, by coincidence of that character class (2 code units, 2 display
  // columns — a 1:1 ratio, same as ASCII's own 1:1 ratio), so old code and
  // new code pad a lone-emoji cell identically. The mismatch this finding
  // describes needs a code point whose code-unit count and display width
  // actually DIFFER — every BMP-range wide character (CJK, Hangul, fullwidth
  // forms: 1 code unit, 2 display columns) qualifies; a lone wide emoji does
  // not. This test therefore combines the emoji with CJK text in the same
  // cell (a realistic mixed-script filename), which both proves the emoji
  // portion is measured correctly AND keeps the case a genuine discriminator
  // via the CJK portion.
  it('GATE: a mixed emoji+CJK file path does not shift the Description column', () => {
    assert.equal(`${FIRE}前端.js`.length, 7, 'sanity: 7 UTF-16 code units');
    assert.equal(displayWidth(`${FIRE}前端.js`), 9, 'sanity: but 9 real terminal columns — a genuine mismatch');
    const model = buildDigestModel('r-width-emoji', 1, [
      { domain: 'backend', parsed: { findings: [{ id: 'F-001', severity: 'HIGH', file: 'src/plain.js', line: 1, description: 'MARKER_A' }] } },
      { domain: 'backend', parsed: { findings: [{ id: 'F-002', severity: 'HIGH', file: `${FIRE}前端.js`, line: 1, description: 'MARKER_B' }] } },
    ]);
    const text = renderText(model);
    assert.equal(columnOffsetOf(text, 'MARKER_A'), columnOffsetOf(text, 'MARKER_B'));
  });

  it('the header row and every data row report the same Description start column', () => {
    const text = renderText(twoRowModel(CJK_DOMAIN, 'backend'));
    const lines = text.split('\n');
    const headerLine = lines.find((l) => l.includes('Description'));
    const headerOffset = displayWidth(headerLine.slice(0, headerLine.indexOf('Description')));
    assert.equal(columnOffsetOf(text, 'MARKER_A'), headerOffset);
    assert.equal(columnOffsetOf(text, 'MARKER_B'), headerOffset);
  });

  it('non-regression: an all-ASCII digest still aligns exactly as before (byte-for-byte, not just column-equal)', () => {
    const text = renderText(twoRowModel('backend', 'frontend'));
    const lines = text.split('\n');
    const rowA = lines.find((l) => l.includes('MARKER_A'));
    const rowB = lines.find((l) => l.includes('MARKER_B'));
    // For pure ASCII, the raw code-unit offset already equals the
    // display-width offset (true both before and after this fix) — this is
    // the "unaffected common case behaves identically" check.
    assert.equal(rowA.indexOf('MARKER_A'), rowB.indexOf('MARKER_B'));
    assert.equal(rowA.indexOf('MARKER_A'), columnOffsetOf(text, 'MARKER_A'));
  });
});

describe('F-44200377 — CJK symbol column in renderVerifyFixedText stays aligned', () => {
  it('GATE: a CJK symbol does not shift the Evidence column relative to an ASCII sibling', async () => {
    const { renderVerifyFixedText } = await import('./findings-render.js');
    const model = {
      schema: 'verify-fixed-delta/v1',
      runId: 'r-width-vf',
      waveNumber: 1,
      checkedAt: '2026-07-17T00:00:00.000Z',
      summary: { total: 2, verified: 2, regressed: 0, claimedButStillPresent: 0, unverifiable: 0 },
      threshold: 0,
      thresholdExceeded: false,
      exitCode: 0,
      findings: [
        { finding_id: 'F-1', fingerprint: 'fp1', classification: 'verified', file: 'a.js', line: 1, symbol: 'doThing', severity: 'HIGH', evidence: 'MARKER_A', originalFixedWave: 1 },
        { finding_id: 'F-2', fingerprint: 'fp2', classification: 'verified', file: 'b.js', line: 2, symbol: CJK_SYMBOL, severity: 'HIGH', evidence: 'MARKER_B', originalFixedWave: 1 },
      ],
    };
    const text = renderVerifyFixedText(model);
    assert.equal(columnOffsetOf(text, 'MARKER_A'), columnOffsetOf(text, 'MARKER_B'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Integration: truncate() budgets in real columns, not code units
// ═══════════════════════════════════════════════════════════════════════

describe('F-44200377 — truncate() enforces a real column budget for CJK-heavy text', () => {
  it('GATE: a 100-character CJK description (200 display columns) is actually truncated to the 140-column budget', () => {
    // Pre-fix: flat.length (100, code units) <= 140 → NOT truncated at all,
    // so the rendered description sailed through at 200 display columns —
    // up to ~2x the intended 140-column budget for a description cell.
    const cjkChar = '漢'; // 漢, a single common CJK ideograph
    const longCjkDescription = cjkChar.repeat(100);
    const model = buildDigestModel('r-width-truncate', 1, [
      { domain: 'backend', parsed: { findings: [{ id: 'F-001', severity: 'HIGH', file: 'a.js', line: 1, description: longCjkDescription }] } },
    ]);
    const text = renderText(model);
    const line = text.split('\n').find((l) => l.includes(cjkChar));
    assert.ok(line, 'expected to find the rendered description row');
    // Extract the description cell: everything from the first CJK char onward.
    const descStart = line.indexOf(cjkChar);
    const descCell = line.slice(descStart);
    assert.ok(
      displayWidth(descCell) <= 140,
      `truncated description must respect the 140-column budget, got ${displayWidth(descCell)} columns: ${descCell.slice(0, 20)}...`,
    );
    // And it must actually have been cut short of the full 200-column input
    // (proving truncation fired at all, not merely happening to fit).
    assert.ok(descCell.length < longCjkDescription.length, 'must be shorter than the untruncated 100-char input');
    assert.ok(descCell.endsWith('…'), 'truncated cell ends with the ellipsis marker');
  });

  it('non-regression: an ASCII description under the budget is unaffected', () => {
    const model = buildDigestModel('r-width-truncate-ascii', 1, [
      { domain: 'backend', parsed: { findings: [{ id: 'F-001', severity: 'HIGH', file: 'a.js', line: 1, description: 'a short ascii description' }] } },
    ]);
    const text = renderText(model);
    assert.match(text, /a short ascii description/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. underline() — section-header rule length matches display width
// ═══════════════════════════════════════════════════════════════════════

describe('F-44200377 — underline() repeats to the title\'s display width, not its code-unit length', () => {
  it('a CJK-bearing runId still gets an underline of the correct on-screen length', () => {
    const model = buildDigestModel(CJK_DOMAIN, 1, [
      { domain: 'backend', parsed: { findings: [] } },
    ]);
    const text = renderText(model);
    const lines = text.split('\n');
    const titleIdx = lines.findIndex((l) => l.startsWith('Findings Digest'));
    assert.ok(titleIdx >= 0, 'expected the title line');
    const title = lines[titleIdx];
    const rule = lines[titleIdx + 1];
    assert.equal(rule.length, displayWidth(title), 'underline length must match the title\'s DISPLAY width');
    assert.notEqual(rule.length, title.length, 'sanity: for this CJK-bearing title, code-unit length and display width actually differ');
  });
});
