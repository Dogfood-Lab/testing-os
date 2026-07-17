/**
 * f-391f3e5d-truncate-dangling-escape.test.js — F-391f3e5d (LOW, wave 24):
 * lib/findings-render.js's shared truncate() helper escapes BEFORE slicing
 * to the character budget (F-c3d8fd7e), so a raw dangerous byte can never
 * resurface no matter where the cut lands — that security property already
 * holds and is NOT what this file re-proves. What F-c3d8fd7e's own fix
 * missed: the character-count slice has no awareness of escape-TOKEN
 * boundaries, and can cut one of escapeReasonForDisplay's own
 * multi-character tokens (`\xHH` = 4 chars, `\uHHHH` = 6 chars, `\u{H+}` =
 * variable) in half, leaving a dangling, malformed-looking fragment (e.g.
 * `...aaa\x…`) instead of either the complete token or a clean omission.
 *
 * This file reproduces the finding's own exact repro shape — 137 filler
 * characters, a raw ESC byte, then trailing text, sized so the escaped
 * string's n=140 truncation boundary lands inside the 4-character `\x1b`
 * token — against the REAL, unmutated renderMarkdown (never a
 * reimplementation of truncate()), and asserts the rendered output never
 * ends in a dangling escape fragment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from './findings-render.js';
import { buildDigestModel } from './findings-digest.js';

const ESC = '\u{1B}';

function findingsModel(description) {
  return buildDigestModel('r-dangle-esc', 1, [
    {
      domain: 'backend',
      parsed: {
        findings: [
          { id: 'F-001', severity: 'HIGH', file: 'src/a.js', line: 12, description },
        ],
      },
    },
  ]);
}

/** Extract the Description cell (last `|`-delimited column) of the one data row. */
function descriptionCellFrom(markdown) {
  const dataRow = markdown.split('\n').find((l) => l.startsWith('| HIGH |'));
  assert.ok(dataRow, `expected a HIGH-severity data row in:\n${markdown}`);
  const cells = dataRow.split('|').map((c) => c.trim());
  // ['', 'HIGH', 'F-001', 'backend', loc, description, '']
  return cells[cells.length - 2];
}

/** @pins F-391f3e5d */
describe('F-391f3e5d — truncate() never leaves a dangling escape-token fragment at the cut boundary', () => {
  it('the finding\'s own repro: 137 filler chars + raw ESC + trailing text lands the n=140 cut inside \\x1b', () => {
    // Escaped length: 137 ('a') + 4 ('\x1b') + 10 ('Z') = 151 > 140, so
    // truncate() must cut. The naive `slice(0, 139)` boundary falls at
    // index 139 -- exactly after the backslash and 'x' of '\x1b', before
    // the '1b' hex digits -- reproducing the finding's own "...aaa\x…" shape.
    const description = 'a'.repeat(137) + ESC + 'Z'.repeat(10);
    const md = renderMarkdown(findingsModel(description));
    const cell = descriptionCellFrom(md);

    // The security property (F-c3d8fd7e) must still hold: the raw ESC byte
    // never resurfaces, escaped or not, complete or fragmentary.
    assert.ok(!cell.includes(ESC), `raw ESC byte must never survive:\n${JSON.stringify(cell)}`);

    // The defect this finding fixes: no dangling, malformed `\x` (or `\xH`)
    // fragment immediately before the ellipsis -- either a COMPLETE \x1b
    // token survives, or the cut backs up before it entirely.
    assert.ok(!/\\x[0-9a-fA-F]?…$/.test(cell),
      `must not end in a dangling, malformed \\x fragment:\n${JSON.stringify(cell)}`);
    assert.ok(cell.endsWith('…'), `truncated cell must still end in an ellipsis:\n${JSON.stringify(cell)}`);

    // Exact expected shape: backUpIncompleteEscape strips the dangling '\x'
    // pair entirely (neither hex digit was captured by the slice), leaving
    // just the 137 filler characters before the ellipsis.
    assert.equal(cell, 'a'.repeat(137) + '…');
  });

  it('a cut landing inside a \\uHHHH token backs up rather than emitting a bare \\u fragment', () => {
    // RLO (U+202E) escapes to the 6-char token ‮. Filler sized so the
    // naive slice(0, n-1) boundary lands 2 hex digits into the token.
    const RLO = '\u{202E}';
    const description = 'b'.repeat(135) + RLO + 'C'.repeat(10);
    // escaped length: 135 + 6 ('‮') + 10 = 151 > 140.
    // slice(0, 139): 135 fillers (0-134) + '\' 'u' '2' '0' (135-138) = 139 chars,
    // landing inside the 4 hex digits (2 consumed, 2 remaining) -- dangling.
    const md = renderMarkdown(findingsModel(description));
    const cell = descriptionCellFrom(md);

    assert.ok(!cell.includes(RLO), `raw RLO byte must never survive:\n${JSON.stringify(cell)}`);
    assert.ok(!/\\u[0-9a-fA-F]{0,3}…$/.test(cell),
      `must not end in a dangling, malformed \\u fragment:\n${JSON.stringify(cell)}`);
    assert.equal(cell, 'b'.repeat(135) + '…');
  });

  it('a cut landing inside an unclosed \\u{H+} token backs up rather than emitting a bare-brace fragment', () => {
    // The Unicode TAG-block primitive (U+E0041) escapes to the variable-width
    // \u{e0041} form (8 chars: \u{ + 5 hex + }).
    const TAG_A = '\u{e0041}';
    const description = 'd'.repeat(133) + TAG_A + 'E'.repeat(10);
    // escaped length: 133 + 8 ('\u{e0041}') + 10 = 151 > 140.
    // slice(0, 139): 133 fillers (0-132) + '\' 'u' '{' 'e' '0' '0' (133-138) = 139 chars,
    // landing inside the brace form with no closing '}' -- dangling.
    const md = renderMarkdown(findingsModel(description));
    const cell = descriptionCellFrom(md);

    assert.ok(!cell.includes(TAG_A), `raw TAG-block codepoint must never survive:\n${JSON.stringify(cell)}`);
    assert.ok(!/\\u\{[0-9a-fA-F]*…$/.test(cell),
      `must not end in a dangling, unclosed \\u{...} fragment:\n${JSON.stringify(cell)}`);
    assert.equal(cell, 'd'.repeat(133) + '…');
  });

  it('non-regression: a cut landing cleanly between ordinary characters is untouched', () => {
    const description = 'x'.repeat(200);
    const md = renderMarkdown(findingsModel(description));
    const cell = descriptionCellFrom(md);
    assert.equal(cell, 'x'.repeat(139) + '…');
  });

  it('non-regression: a complete escape token immediately followed by more text is left alone (not mistaken for dangling)', () => {
    // Sized so the ENTIRE \x1b token AND all trailing text fit within the
    // budget -- no truncation at all, so the complete token must survive
    // verbatim, not be misidentified as a dangling fragment and stripped.
    const description = 'f'.repeat(50) + ESC + 'trailing text after a complete token';
    const md = renderMarkdown(findingsModel(description));
    const cell = descriptionCellFrom(md);
    assert.ok(cell.includes('\\x1b'), `a complete, non-truncated \\x1b token must survive intact:\n${JSON.stringify(cell)}`);
    assert.ok(cell.includes('trailing text after a complete token'));
    assert.ok(!cell.endsWith('…'), 'a description short enough to fit whole must not be truncated at all');
  });
});
