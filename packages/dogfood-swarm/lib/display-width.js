/**
 * display-width.js — minimal wcwidth-style terminal column measurement.
 *
 * F-44200377: lib/findings-render.js's TTY table renderers (renderText,
 * renderVerifyFixedText) measured column width with JS string `.length`
 * (UTF-16 code-unit count), which is the wrong unit for a monospace-alignment
 * budget — an East-Asian-Wide glyph (CJK ideograph, Hangul syllable,
 * fullwidth form) renders as 2 terminal columns but counts as 1 code unit,
 * and an astral-plane emoji renders as (typically) 2 columns but counts as 2
 * code units (a surrogate pair) under `.length`, which is also not "2
 * columns" for the right reason. Either way, `.length` silently throws every
 * column to the right of a wide-glyph cell out of alignment for that row.
 *
 * No `string-width`/`wcwidth` package exists in this workspace's lockfile
 * (frozen this wave) — this is a deliberately narrow, local implementation,
 * not a port of the full Unicode East Asian Width (UAX #11) table. Coverage,
 * disclosed rather than silently assumed complete (this repo's own honesty
 * standard, swarms/CLAUDE.md: an undisclosed gap is the defect, not the gap
 * itself):
 *
 *   - WIDE (2 columns): CJK Unified Ideographs (+ Extension A/B and the two
 *     Compatibility blocks), Hangul Jamo + Syllables, Hiragana/Katakana,
 *     Fullwidth Forms/Signs, and the common pictographic/emoji blocks (Misc
 *     Symbols & Pictographs, Emoticons, Transport & Map, Supplemental
 *     Symbols & Pictographs, Symbols & Pictographs Extended-A).
 *   - ZERO (0 columns): any code point whose Unicode general category is Mn
 *     (Nonspacing_Mark) or Me (Enclosing_Mark) — decided by PROPERTY
 *     (`\p{Mn}`/`\p{Me}` Unicode property escapes, resolved against V8's own
 *     Unicode Character Database), not by enumerating one range per script.
 *     This covers combining marks generically: Latin diacritics, Japanese
 *     dakuten/handakuten (U+3099/U+309A — F-dc37b009), Hebrew points, Arabic
 *     diacritics, Thai tone marks, and any other script's Mn/Me block,
 *     including ones this file's authors never anticipated. (Mc,
 *     Spacing_Mark — e.g. Devanagari vowel signs — is deliberately EXCLUDED:
 *     those marks occupy a real terminal column, matching Markus Kuhn's
 *     reference wcwidth() implementation that most terminal emulators
 *     follow.) Plus the explicit fast-path ranges below: zero-width space/
 *     ZWJ/ZWNJ/word-joiner/BOM (U+200B-U+200D, U+2060, U+FEFF) and variation
 *     selectors (U+FE00-U+FE0F, U+E0100-U+E01EF) — kept as explicit ranges
 *     for the non-mark members (the zero-width-space/ZWJ/word-joiner/BOM
 *     code points are General Category Cf, Format, not M, so the property
 *     check does not reach them at all).
 *   - NARROW (1 column): everything else, including all of ASCII/Latin.
 *
 * F-dc37b009 (wave 37): the WIDE_RANGES table's `[0x3041, 0x33ff]` entry
 * ("Hiragana .. CJK Compatibility") had swallowed U+3099/U+309A — the
 * standalone combining dakuten/handakuten marks — because nothing carved
 * them out of the enclosing block range. The narrowest fix would have been
 * to carve just those two code points into ZERO_WIDTH_RANGES; that is the
 * enumerated-instance shape this repo has already relearned the cost of
 * more than once (an enumerated list is a promise to keep enumerating
 * forever, one script at a time). Deciding zero-width-ness by the Unicode
 * PROPERTY every combining mark shares, in every script, means no future
 * combining-mark block can reproduce this bug by sitting undiscovered
 * inside a WIDE range.
 *
 * Known gap (disclosed, not silently assumed away — "conservative" over
 * "exhaustive"): multi-code-point emoji built from ZWJ sequences or
 * skin-tone/flag modifiers are measured per-code-point, not per grapheme
 * cluster, so e.g. a 4-code-point family emoji measures wider than the ~2
 * columns a terminal typically renders it as. This over-counts — it never
 * under-counts — so an affected row's columns run slightly wide rather than
 * collapsing into the next column; full UAX #11 + UAX #29 grapheme
 * clustering is a text-shaping surface well beyond this file's actual job (a
 * table-alignment budget). A future wave needing grapheme-accurate
 * measurement should pull in a real `string-width` dependency rather than
 * grow this file further.
 *
 * Security note: this module runs on text that has ALREADY passed through
 * escapeReasonForDisplay/escapePathForDisplay (see findings-render.js's
 * truncate(), formatLoc(), formatSymbol()) — those neutralize the
 * control-byte/bidi/zero-width-attack class (F-c3d8fd7e, F-8e414a2b) by
 * turning every dangerous code point into a multi-character ASCII literal
 * (`\n`, `\xHH`, `\uHHHH`) before any width measurement runs. This module's
 * zero-width table exists for accurate measurement of genuinely zero-width
 * LEGITIMATE text (a combining accent on an ordinary letter), not as a
 * second security boundary — do not remove the escaping step upstream on the
 * theory that this file's zero-width handling makes it redundant.
 */

// Each entry is [start, end], inclusive, sorted ascending by start.
const WIDE_RANGES = [
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2329, 0x232a],   // Angle brackets (legacy wide punctuation)
  [0x2e80, 0x303e],   // CJK Radicals Supplement .. CJK Symbols and Punctuation
  [0x3041, 0x33ff],   // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf],   // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff],   // CJK Unified Ideographs
  [0xa000, 0xa4cf],   // Yi Syllables/Radicals
  [0xac00, 0xd7a3],   // Hangul Syllables
  [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f],   // CJK Compatibility Forms
  [0xff00, 0xff60],   // Fullwidth Forms
  [0xffe0, 0xffe6],   // Fullwidth Signs
  [0x1f300, 0x1f5ff], // Misc Symbols and Pictographs
  [0x1f600, 0x1f64f], // Emoticons
  [0x1f680, 0x1f6ff], // Transport and Map Symbols
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x1fa70, 0x1faff], // Symbols and Pictographs Extended-A
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extension B and beyond
];

const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f],   // Combining Diacritical Marks
  [0x200b, 0x200d],   // Zero Width Space, ZWNJ, ZWJ
  [0x2060, 0x2060],   // Word Joiner
  [0xfe00, 0xfe0f],   // Variation Selectors
  [0xfeff, 0xfeff],   // BOM / zero width no-break space
  [0xe0100, 0xe01ef], // Variation Selectors Supplement
];

/**
 * @param {number} cp
 * @param {number[][]} ranges - sorted ascending by start; [lo, hi] inclusive.
 * @returns {boolean}
 */
function inRanges(cp, ranges) {
  // Linear scan with an early exit: both tables are short (<20 entries) and
  // this runs over table-row-sized strings (a handful to a few hundred code
  // points), not document-sized text — a sorted-binary-search would be
  // premature optimization for the actual call sites (pad/maxWidth/underline/
  // truncate on one finding's domain/id/file/symbol/description cell).
  for (const [lo, hi] of ranges) {
    if (cp < lo) break; // ranges are sorted ascending; no later range can match
    if (cp <= hi) return true;
  }
  return false;
}

// F-dc37b009: decide zero-width-ness for combining marks by Unicode general
// CATEGORY (Mn/Me), not by enumerating a range per script — see the file
// header for the full rationale. Only ever consulted for a code point
// neither fast-path range table above already classified, so the common
// ASCII/CJK/emoji case never pays for a regex test.
const COMBINING_MARK_RE = /^[\p{Mn}\p{Me}]$/u;

function isCombiningMark(cp) {
  // No Unicode Mn/Me code point exists below U+0300 (Combining Diacritical
  // Marks, the first combining-mark block) — a cheap, universally-true
  // fast-reject for the overwhelmingly common ASCII/Latin-1 case, not a
  // script-specific carve-out.
  if (cp < 0x300) return false;
  return COMBINING_MARK_RE.test(String.fromCodePoint(cp));
}

function codePointWidth(cp) {
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  if (isCombiningMark(cp)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Terminal display width of `str`, in columns. Iterates by Unicode code
 * point (`for...of` over a string steps over a surrogate pair as one code
 * point) rather than by UTF-16 code unit, so an astral emoji is measured
 * once, not twice.
 *
 * @param {string} str
 * @returns {number}
 */
export function displayWidth(str) {
  let width = 0;
  for (const ch of String(str ?? '')) {
    width += codePointWidth(ch.codePointAt(0));
  }
  return width;
}

/**
 * Slice `str` to the longest PREFIX whose display width does not exceed
 * `maxColumns`, cutting only on code-point boundaries (never mid-surrogate-
 * pair — a cut always lands either before or after a full code point).
 * Returns an ordinary code-unit substring, so callers keep treating the
 * result as a normal JS string (e.g. feeding it to a regex-based
 * post-processor that itself only needs to see complete ASCII tokens).
 *
 * @param {string} str
 * @param {number} maxColumns
 * @returns {string}
 */
export function sliceToDisplayWidth(str, maxColumns) {
  const s = String(str ?? '');
  if (maxColumns <= 0) return '';
  let width = 0;
  let idx = 0;
  for (const ch of s) {
    const w = codePointWidth(ch.codePointAt(0));
    if (width + w > maxColumns) break;
    width += w;
    idx += ch.length; // 1 for a BMP code point, 2 for a surrogate pair
  }
  return s.slice(0, idx);
}
