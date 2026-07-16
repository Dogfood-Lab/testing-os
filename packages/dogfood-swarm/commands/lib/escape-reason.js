/**
 * commands/lib/escape-reason.js — single source of truth for rendering
 * untrusted operator-supplied reason/label free text onto a plain-text
 * display surface (a terminal, a CI log, a Markdown-rendered transcript).
 *
 * Every `--reason "<text>"` flag across this package (advance --override,
 * revalidate, rewind, redrive, clean-claims, domains --unfreeze) is
 * unrestricted operator free text — no character validation anywhere
 * upstream — and every one of those reasons is eventually rendered back to
 * a text surface, either as an immediate echo of the operator's own
 * just-typed flag (rewind/redrive/revalidate/clean-claims/domains's plan
 * summaries) or as a STORED value replayed later by an unrelated read verb
 * (`swarm history`, `swarm status`'s breadcrumb, `swarm domains --history`,
 * `swarm advance --history`, `swarm receipt`'s state-transitions section).
 * `escapeReasonForDisplay` is the ONE function every one of those render
 * sites must route through.
 *
 * History of the escaping contract (do not re-narrow any of these):
 *
 *   F-51fa8e13 / F-fa23cc37 (formatOverrideGroups, cli.js): a reason
 *     containing '; ', ': ', or a raw '"' could forge what looks like
 *     genuine clause structure in the `--history` text view. Fixed by
 *     wrapping each reason in double quotes and escaping backslash + quote,
 *     backslash-first so a pre-existing `\"` round-trips as `\\"` instead of
 *     being misread as an escape it never was.
 *
 *   F-11f0e453 (wave 16, formatOverrideGroups): quote/backslash fencing only
 *     stops a reason forging fake STRUCTURE within the one line it is
 *     printed on. A literal '\n' forges an entire fake LINE — `console.log`
 *     prints whatever bytes it is given, so an embedded newline ends the
 *     current line and starts a new, attacker-shaped one. '\n', '\r', '\t'
 *     escaped to their visible two-character form closed that gap — but
 *     only at the ONE call site (formatOverrideGroups) the fix touched.
 *
 *   F-7c3e91a4 / F-463c7179 (wave 18): the wave-16 fix hardened exactly ONE
 *     call site. Every OTHER reason-rendering site in the package
 *     (`swarm history`, `swarm status`'s breadcrumb, the immediate-echo
 *     summaries in rewind/redrive/revalidate/clean-claims/domains, and
 *     `swarm receipt`'s state-transitions section) applied ZERO escaping —
 *     proven live: a --reason containing a raw newline plus a
 *     column-aligned fake row renders a byte-perfect FORGED transition row
 *     in `swarm history`; a raw ANSI cursor-erase sequence
 *     (`\x1b[1A\x1b[2K\r`) does not just append a fake line, it blanks out
 *     and overwrites the genuinely-printed line above it — strictly worse
 *     than append-only forgery, and a proven violation of history.js's own
 *     documented "No ANSI" render contract. This wave (a) extracts the
 *     helper out of cli.js so every commands/*.js render site can reach it
 *     without an inverted import (cli.js imports FROM commands/*, never the
 *     reverse — matching this package's existing layering; see this
 *     package's CLAUDE.md "Workspace dependency graph" section for the same
 *     discipline one level up, at the cross-PACKAGE granularity) and (b)
 *     widens the escaped class from the three named whitespace controls to
 *     every C0 control byte (0x00-0x1F), DEL (0x7F), the C1 range
 *     (0x80-0x9F, also live escape-sequence introducers on 8-bit
 *     terminals), and the Unicode line/paragraph separators U+2028/U+2029
 *     (invisible to a live terminal, but treated as line boundaries by some
 *     non-Node text consumers, e.g. Python's `str.splitlines()`). Named
 *     controls (\n \r \t \v \f) keep their familiar two-character mnemonic;
 *     anything else in the class renders as \xHH (or \uHHHH above 0xFF) —
 *     matching history.js's own "No ANSI" contract by construction, as a
 *     CLASS, rather than by enumerating attack payloads one at a time
 *     (exactly the shape of gap that let wave-18's ESC/\v/\f payloads
 *     through a fix that only named \n \r \t).
 *
 *   F-35a809f3 (wave 20): wave 18's CLASS widening was itself incomplete —
 *     it covered every codepoint that changes WHERE text appears (control
 *     bytes, line/paragraph separators) but not codepoints that change HOW
 *     already-placed text is displayed. Proven live via a real
 *     `node cli.js history <wave-id>` subprocess against a scratch DB: a
 *     reason containing U+202E (RLO) ... U+202C (PDF) renders with the
 *     wrapped substring visually REVERSED in the terminal, and the same
 *     bytes survive unescaped into the checked-in, GitHub-rendered
 *     `wave-N-receipt.md` (commands/receipt.js's exportReceipt), where
 *     GitHub's own Markdown viewer applies the Unicode bidi algorithm
 *     unconditionally — a materially more consequential audience than the
 *     live-terminal-only surfaces the class was previously proven against.
 *     This is the "Trojan Source" class (Boucher & Anderson, CVE-2021-42574;
 *     the reason GitHub/GitLab added dedicated bidi-control warnings to
 *     their diff/blob viewers). Widened CONTROL_CLASS to also cover: the
 *     bidi embedding/override controls U+202A-U+202E (LRE/RLE/PDF/LRO/RLO),
 *     the bidi isolate controls U+2066-U+2069 (LRI/RLI/FSI/PDI), the bidi
 *     marks U+200E-U+200F (LRM/RLM) and U+061C (ALM); the zero-width/
 *     invisible block U+200B-U+200D (ZWSP/ZWNJ/ZWJ, contiguous with the bidi
 *     marks above) and U+FEFF (BOM/ZWNBSP); and the Combining Diacritical
 *     Marks block U+0300-U+036F (unbounded stacking of combining marks —
 *     "zalgo text" — can visually obliterate adjacent genuine output the
 *     same way the already-fixed ANSI cursor-erase primitive did, one layer
 *     up in the Unicode rendering pipeline instead of the terminal's).
 *     Still a codepoint CLASS via ranges, not an enumerated payload list —
 *     each new range is pinned both directions (neutralized in every text
 *     render; `--format=json` stays lossless) in
 *     wave18-4091637-5127-swarm-cp-pins.test.js, the same proof discipline
 *     this file's own header has required since wave 18.
 *
 * `--format=json` output for every verb bypasses this helper entirely and
 * stays the lossless, unescaped canonical form — JSON's own string escaping
 * already makes control bytes safe and machine-parseable losslessly.
 * Nothing in this file is ever called from a `--format=json` branch, nor
 * from any data-producing function whose return value also feeds a JSON
 * path (e.g. status.js#summarizeWaveHistory, history.js's history()) — only
 * from the TEXT-rendering functions that consume their output. Grep this
 * package for `escapeReasonForDisplay` if that invariant is ever in doubt.
 *
 * Placement note: this lives under `commands/lib/`, not the package-level
 * `packages/dogfood-swarm/lib/`. During wave 18 (run swarm-1784091637-5127)
 * `lib/**` is a DIFFERENT domain's exclusive glob (swarm-cp-core); every
 * consumer of this helper (cli.js + commands/*.js) already lives inside
 * `commands/**` or is `cli.js` itself, both this domain's (swarm-cp-verbs)
 * exclusive glob, so nesting the leaf helper here needs no cross-domain
 * coordination this wave. Nothing about the module's shape is
 * commands-specific — a future wave that consolidates ownership can `git mv`
 * it into the package-level `lib/` mechanically.
 */

// Controls with a conventional single-letter mnemonic. Every other member of
// the escaped class (see CONTROL_CLASS below) falls through to the generic
// \xHH / \uHHHH branch in escapeReasonForDisplay.
const NAMED_ESCAPES = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\f': '\\f',
};

// The full escaped class:
//   - C0 controls (0x00-0x1F, includes ESC 0x1B, the proven cursor-erase
//     primitive), DEL (0x7F), the C1 control range (0x80-0x9F)
//   - the Unicode line/paragraph separators (codepoints U+2028/U+2029)
//   - F-35a809f3 (wave 20), the "Trojan Source" class (CVE-2021-42574):
//     the zero-width block plus bidi marks (U+200B through U+200F --
//     ZWSP/ZWNJ/ZWJ/LRM/RLM, one contiguous range), the bidi
//     embedding/override controls (U+202A through U+202E --
//     LRE/RLE/PDF/LRO/RLO), the bidi isolate controls (U+2066 through
//     U+2069 -- LRI/RLI/FSI/PDI), the Arabic Letter Mark (U+061C), and
//     BOM/ZWNBSP (U+FEFF)
//   - F-35a809f3 (wave 20): the Combining Diacritical Marks block
//     (U+0300 through U+036F) -- unbounded stacking ("zalgo text") can
//     visually obliterate adjacent genuine output
// Deliberately a byte/codepoint CLASS, not an enumerated list of the
// payloads a past finding happened to demonstrate — see this file's header.
const CONTROL_CLASS = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u0300-\u036f]/g;

/**
 * Escape a free-text reason/label for embedding in a plain-text display
 * surface. Backslash-first, then quote, then the control-byte class — each
 * pass matches only characters the PRIOR pass could not have produced, so a
 * single left-to-right scan never re-escapes an already-escaped sequence
 * (standard escape-pair ordering, JSON/CSV-style).
 *
 * @param {string} reason
 * @returns {string}
 */
export function escapeReasonForDisplay(reason) {
  return String(reason)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(CONTROL_CLASS, (ch) => {
      if (NAMED_ESCAPES[ch]) return NAMED_ESCAPES[ch];
      const code = ch.codePointAt(0);
      return code > 0xff
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\x${code.toString(16).padStart(2, '0')}`;
    });
}
