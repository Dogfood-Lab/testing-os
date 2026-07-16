/**
 * commands/lib/escape-reason.js -- single source of truth for rendering
 * untrusted operator-supplied reason/label free text onto a plain-text
 * display surface (a terminal, a CI log, a Markdown-rendered transcript).
 *
 * Every `--reason "<text>"` flag across this package (advance --override,
 * revalidate, rewind, redrive, clean-claims, domains --unfreeze) is
 * unrestricted operator free text -- no character validation anywhere
 * upstream -- and every one of those reasons is eventually rendered back to
 * a text surface, either as an immediate echo of the operator's own
 * just-typed flag (rewind/redrive/revalidate/clean-claims/domains's plan
 * summaries) or as a STORED value replayed later by an unrelated read verb
 * (`swarm history`, `swarm status`'s breadcrumb, `swarm domains --history`,
 * `swarm advance --history`, `swarm receipt`'s state-transitions section).
 * `escapeReasonForDisplay` is the ONE function every one of those render
 * sites must route through. `escapePathForDisplay` (below) is a thin,
 * same-logic delegate for the sibling case of a bare file path rather than
 * a reason/label string -- see its own doc comment for why the escaping
 * logic is shared rather than duplicated.
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
 *     printed on. A literal '\n' forges an entire fake LINE -- `console.log`
 *     prints whatever bytes it is given, so an embedded newline ends the
 *     current line and starts a new, attacker-shaped one. '\n', '\r', '\t'
 *     escaped to their visible two-character form closed that gap -- but
 *     only at the ONE call site (formatOverrideGroups) the fix touched.
 *
 *   F-7c3e91a4 / F-463c7179 (wave 18): the wave-16 fix hardened exactly ONE
 *     call site. Every OTHER reason-rendering site in the package
 *     (`swarm history`, `swarm status`'s breadcrumb, the immediate-echo
 *     summaries in rewind/redrive/revalidate/clean-claims/domains, and
 *     `swarm receipt`'s state-transitions section) applied ZERO escaping --
 *     proven live: a --reason containing a raw newline plus a
 *     column-aligned fake row renders a byte-perfect FORGED transition row
 *     in `swarm history`; a raw ANSI cursor-erase sequence
 *     (`\x1b[1A\x1b[2K\r`) does not just append a fake line, it blanks out
 *     and overwrites the genuinely-printed line above it -- strictly worse
 *     than append-only forgery, and a proven violation of history.js's own
 *     documented "No ANSI" render contract. This wave (a) extracts the
 *     helper out of cli.js so every commands/*.js render site can reach it
 *     without an inverted import (cli.js imports FROM commands/*, never the
 *     reverse -- matching this package's existing layering; see this
 *     package's CLAUDE.md "Workspace dependency graph" section for the same
 *     discipline one level up, at the cross-PACKAGE granularity) and (b)
 *     widens the escaped class from the three named whitespace controls to
 *     every C0 control byte (0x00-0x1F), DEL (0x7F), the C1 range
 *     (0x80-0x9F, also live escape-sequence introducers on 8-bit
 *     terminals), and the Unicode line/paragraph separators U+2028/U+2029
 *     (invisible to a live terminal, but treated as line boundaries by some
 *     non-Node text consumers, e.g. Python's `str.splitlines()`). Named
 *     controls (\n \r \t \v \f) keep their familiar two-character mnemonic;
 *     anything else in the class renders as \xHH (or \uHHHH above 0xFF) --
 *     matching history.js's own "No ANSI" contract by construction, as a
 *     CLASS, rather than by enumerating attack payloads one at a time
 *     (exactly the shape of gap that let wave-18's ESC/\v/\f payloads
 *     through a fix that only named \n \r \t).
 *
 *   F-35a809f3 (wave 20): wave 18's CLASS widening was itself incomplete --
 *     it covered every codepoint that changes WHERE text appears (control
 *     bytes, line/paragraph separators) but not codepoints that change HOW
 *     already-placed text is displayed. Proven live via a real
 *     `node cli.js history <wave-id>` subprocess against a scratch DB: a
 *     reason containing U+202E (RLO) ... U+202C (PDF) renders with the
 *     wrapped substring visually REVERSED in the terminal, and the same
 *     bytes survive unescaped into the checked-in, GitHub-rendered
 *     `wave-N-receipt.md` (commands/receipt.js's exportReceipt), where
 *     GitHub's own Markdown viewer applies the Unicode bidi algorithm
 *     unconditionally -- a materially more consequential audience than the
 *     live-terminal-only surfaces the class was previously proven against.
 *     This is the "Trojan Source" class (Boucher & Anderson, CVE-2021-42574;
 *     the reason GitHub/GitLab added dedicated bidi-control warnings to
 *     their diff/blob viewers). Widened CONTROL_CLASS to also cover: the
 *     bidi embedding/override controls U+202A-U+202E (LRE/RLE/PDF/LRO/RLO),
 *     the bidi isolate controls U+2066-U+2069 (LRI/RLI/FSI/PDI), the bidi
 *     marks U+200E-U+200F (LRM/RLM) and U+061C (ALM); the zero-width/
 *     invisible block U+200B-U+200D (ZWSP/ZWNJ/ZWJ, contiguous with the bidi
 *     marks above) and U+FEFF (BOM/ZWNBSP); and the Combining Diacritical
 *     Marks block U+0300-U+036F (unbounded stacking of combining marks --
 *     "zalgo text" -- can visually obliterate adjacent genuine output the
 *     same way the already-fixed ANSI cursor-erase primitive did, one layer
 *     up in the Unicode rendering pipeline instead of the terminal's).
 *     Still a codepoint CLASS via ranges, not an enumerated payload list --
 *     each new range is pinned both directions (neutralized in every text
 *     render; `--format=json` stays lossless) in
 *     wave18-4091637-5127-swarm-cp-pins.test.js, the same proof discipline
 *     this file's own header has required since wave 18.
 *
 *   F-6540ba3d / F-37ba8d85 (wave 22): wave 20's CONTROL_CLASS was wrong in
 *     BOTH directions on the exact axis its own docstring worried about --
 *     "closer to a large enumerated list than the property it gestures at."
 *     Under-broad: 32 further codepoints sharing the same invisible/
 *     steganography-hazard property Unicode itself names
 *     Default_Ignorable_Code_Point (UTS #39, Unicode Security Mechanisms)
 *     passed through unescaped -- most consequential the Unicode TAG block
 *     (U+E0000-U+E007F), the "ASCII Smuggling" invisible-instruction-
 *     injection primitive (Goodside; tooled as Rehberger's "ASCII
 *     Smuggler"; shown to weaken LLM guardrails by Daniel & Pal 2024,
 *     arXiv:2405.14490, and shown to be decoded PREFERENTIALLY BY
 *     ANTHROPIC MODELS by Graves 2026, arXiv:2603.00164 -- directly on
 *     point here, since this package's own render surfaces are read by
 *     Claude-driven coordinator sessions as normal operating procedure).
 *     Over-broad: escaping EVERY isolated Combining Diacritical Mark
 *     (U+0300-U+036F) mangled ordinary NFD (decomposed) text -- the
 *     canonical form for Vietnamese, polytonic/academic Greek, and IAST
 *     Sanskrit transliteration -- even though the actual threat (unbounded
 *     "zalgo" stacking) only exists once many marks pile onto one base
 *     character; and ZWJ (U+200D), required by every standard Unicode ZWJ
 *     emoji sequence (family emoji, profession+gender combinations, the
 *     pride flags), sat inside the same numeric range as the genuinely
 *     dangerous ZWSP/ZWNJ purely because the class was built from
 *     contiguous ranges rather than semantic membership. Fixed by (a)
 *     replacing the named-block enumeration with the real Unicode property
 *     via `\p{Default_Ignorable_Code_Point}` (Node's `v`-flag Unicode-set
 *     notation, available Node 20+; this repo's CI runs 22/24), so the next
 *     steganography-hazard codepoint Unicode ever adds is covered
 *     automatically instead of needing another one-off range patch,
 *     unioned via `v`-flag set SUBTRACTION (`--`) with ZWJ carved back OUT
 *     (it carries no reordering/overwrite capability alone, and its only
 *     realistic legitimate use is exactly the emoji-joining case above);
 *     (b) moving the Combining Diacritical Marks block out of the
 *     single-character CONTROL_CLASS entirely and into ZALGO_RUN, a
 *     dedicated pass that escapes only runs of 3-or-more consecutive marks
 *     (see that constant's own comment, below). Independently re-verified
 *     against Node's real `\p{}` engine rather than carried forward from
 *     either finding's prose (this protocol's "authoritative source, never
 *     memory" sub-law): every named gap above IS a
 *     Default_Ignorable_Code_Point member and is covered automatically by
 *     the property switch; the interlinear-annotation characters
 *     (U+FFF9-U+FFFB) some prose lumped in as "the same property" are NOT
 *     members -- Unicode's own derivation explicitly excludes them because
 *     they must render visibly without dedicated interlinear-annotation
 *     support -- so they correctly stay unescaped rather than being
 *     hand-added to chase a claim the formal property does not itself make.
 *
 *   F-f1dae277 (wave 22): the escaping contract above was scoped to
 *     `reason`-shaped fields; the identical zero-privilege boundary applies
 *     to `file_claims.file_path` / `ownership.violations[].file` -- proven
 *     live at four direct render sites, plus (via `agent_runs.error_message`
 *     laundering the same joined-path text through a different column) four
 *     more indirect ones. See escapePathForDisplay's own doc comment below
 *     for the full site list and the zero-privilege argument.
 *
 * `--format=json` output for every verb bypasses this helper entirely and
 * stays the lossless, unescaped canonical form -- JSON's own string escaping
 * already makes control bytes safe and machine-parseable losslessly.
 * Nothing in this file is ever called from a `--format=json` branch, nor
 * from any data-producing function whose return value also feeds a JSON
 * path (e.g. status.js#summarizeWaveHistory, history.js's history(),
 * receipt.js's buildReceipt(), resume.js's resume()) -- only from the
 * TEXT-rendering functions that consume their output. The same invariant
 * holds for escapePathForDisplay: every one of its call sites (F-f1dae277,
 * below) sits inside a *format* function, never a data-building one. Grep
 * this package for `escapeReasonForDisplay` or `escapePathForDisplay` if
 * that invariant is ever in doubt.
 *
 * Placement note: this lives under `commands/lib/`, not the package-level
 * `packages/dogfood-swarm/lib/`. During wave 18 (run swarm-1784091637-5127)
 * `lib/**` is a DIFFERENT domain's exclusive glob (swarm-cp-core); every
 * consumer of this helper (cli.js + commands/*.js) already lives inside
 * `commands/**` or is `cli.js` itself, both this domain's (swarm-cp-verbs)
 * exclusive glob, so nesting the leaf helper here needs no cross-domain
 * coordination this wave. Nothing about the module's shape is
 * commands-specific -- a future wave that consolidates ownership can `git mv`
 * it into the package-level `lib/` mechanically.
 */

// Controls with a conventional single-letter mnemonic. Every other member of
// the escaped class (see CONTROL_CLASS below) falls through to the generic
// \xHH / \uHHHH / \u{H+} branch in formatEscape, below.
const NAMED_ESCAPES = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\f': '\\f',
};

// The full escaped class:
//   - C0 controls (0x00-0x1F, includes ESC 0x1B, the proven cursor-erase
//     primitive), DEL (0x7F), the C1 control range (0x80-0x9F) -- kept as
//     explicit ranges because they are NOT Default_Ignorable_Code_Point
//     members (verified against Node's real `\p{}` engine): they have a
//     visible, structural rendering effect, whereas "default ignorable"
//     is specifically about codepoints a compliant renderer draws with
//     zero advance width absent special support for them.
//   - the Unicode line/paragraph separators (U+2028/U+2029) -- likewise
//     confirmed NOT Default_Ignorable_Code_Point members; kept explicit
//     for the reason wave 18 added them (some non-Node text consumers,
//     e.g. Python's `str.splitlines()`, treat them as line boundaries).
//   - F-6540ba3d (wave 22): every codepoint Unicode itself classifies
//     Default_Ignorable_Code_Point (UTS #39), via
//     `\p{Default_Ignorable_Code_Point}` -- this single property covers
//     every named block wave 20 added by hand (the zero-width block, all
//     bidi marks/embeddings/overrides/isolates, the Arabic Letter Mark,
//     BOM/ZWNBSP) plus the gaps wave 20 left (the Unicode TAG block
//     U+E0000-U+E007F, both Variation Selector ranges, Word Joiner, the
//     invisible math operators, the deprecated bidi-shaping controls, the
//     Mongolian Free Variation Selector/Vowel Separator) in one
//     self-updating expression instead of another one-off range patch --
//     MINUS ZWJ, immediately below.
// Excluded despite being a Default_Ignorable_Code_Point member:
//   - F-37ba8d85 (wave 22): ZWJ (U+200D), carved out via `v`-flag set
//     SUBTRACTION (`--`) -- required by every standard Unicode ZWJ emoji
//     sequence and carries no reordering/overwrite capability alone,
//     unlike its ZWSP/ZWNJ/LRM/RLM neighbors, which stay escaped.
// Handled separately, NOT as single-character escapes in this class:
//   - F-37ba8d85 (wave 22): the Combining Diacritical Marks block
//     (U+0300-U+036F) -- moved out of per-character escaping entirely and
//     into ZALGO_RUN, below, which escapes only pathological RUNS.
// Confirmed NOT Default_Ignorable_Code_Point members despite surface
// resemblance in some prose (independently re-verified against Node's real
// `\p{}` engine, not carried forward from memory): the interlinear-
// annotation characters (U+FFF9-U+FFFB) -- Unicode's own derivation
// explicitly excludes them because they must render visibly without
// dedicated interlinear-annotation support.
// Deliberately a byte/codepoint CLASS, not an enumerated list of the
// payloads a past finding happened to demonstrate -- see this file's header.
const CONTROL_CLASS = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}[\p{Default_Ignorable_Code_Point}--\u{200D}]]/gv;

// Pathological combining-mark runs ("zalgo text"): F-37ba8d85 (wave 22) moved
// the Combining Diacritical Marks block OUT of CONTROL_CLASS above and into
// this separate, run-length-gated pass -- see that finding's history entry
// above for why a single mark must NOT be escaped the way wave 20 escaped it.
// Three or more marks stacked consecutively can only ever be stacked on the
// ONE base character immediately preceding them (a run breaks the instant any
// non-mark character -- including a new base letter -- appears), so matching a
// contiguous run of length >= 3 correctly captures "many marks piled onto one
// base" without needing to separately capture that base character.
const ZALGO_RUN = /[\u0300-\u036f]{3,}/gu;

// F-6540ba3d (wave 22): the Unicode TAG block (U+E0000-U+E007F) and the
// Variation Selectors Supplement (U+E0100-U+E01EF) sit ABOVE the BMP
// (codepoint greater than 0xFFFF). The pre-wave-22 two-branch table (`\xHH`
// at or below 0xFF, else a fixed 4-hex-digit `\uHHHH`) was never exercised
// past 0xFFFF -- every codepoint CONTROL_CLASS could match was <= U+FEFF --
// so padStart(4) silently becomes a no-op once the hex string already
// exceeds 4 digits: codepoint 0xE0041 (a Tag-block character) would render
// as the literal 7-character run consisting of a backslash, "u", and the
// five hex digits "e0041" -- not a well-formed `\uHHHH` escape of ANY width,
// and not self-delimiting (a reader, or a future parser, cannot tell where
// the escape ends and adjacent literal hex-looking text begins). The
// variable-width `\u{...}` form is the correct, unambiguous representation
// for that range and is itself valid ECMAScript escape syntax.
function formatEscape(code) {
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
  if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, '0')}`;
  return `\\u{${code.toString(16)}}`;
}

function escapeControlChar(ch) {
  if (NAMED_ESCAPES[ch]) return NAMED_ESCAPES[ch];
  return formatEscape(ch.codePointAt(0));
}

// Escapes every codepoint in a matched zalgo run individually (rather than
// collapsing the run to one placeholder) so the escaped output still shows
// the reader exactly how many marks were stacked and what they were.
function escapeZalgoRun(run) {
  return Array.from(run, (ch) => formatEscape(ch.codePointAt(0))).join('');
}

/**
 * Escape a free-text reason/label for embedding in a plain-text display
 * surface. Backslash-first, then quote, then the control-byte class, then
 * pathological combining-mark runs -- each pass matches only characters the
 * PRIOR passes could not have produced (CONTROL_CLASS and ZALGO_RUN are
 * disjoint codepoint sets by construction), so a single left-to-right
 * pipeline never re-escapes an already-escaped sequence (standard
 * escape-pair ordering, JSON/CSV-style).
 *
 * Known residual (disclosed, not silently papered over -- see
 * swarms/CLAUDE.md "Honesty is a feature of the artifact"): a ZWJ
 * deliberately interleaved mid-run (mark, mark, ZWJ, mark, mark) is NOT
 * itself escaped (ZWJ is excluded from CONTROL_CLASS, see above) and splits
 * what would otherwise be one 4-mark pathological run into two 2-mark runs,
 * neither reaching ZALGO_RUN's 3-mark threshold. This is a narrower
 * residual than wave 20's over-broad behavior it replaces (it requires an
 * attacker to deliberately construct this exact interleaving, rather than
 * firing on any ordinary NFD text) and is out of scope for F-37ba8d85,
 * which asked for the over-broad/under-broad fix, not a new run-continuity
 * model for a character the finding asked to stop treating as part of the
 * threat class.
 *
 * @param {string} reason
 * @returns {string}
 */
export function escapeReasonForDisplay(reason) {
  return String(reason)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(CONTROL_CLASS, escapeControlChar)
    .replace(ZALGO_RUN, escapeZalgoRun);
}

/**
 * Escape a free-text FILE PATH for the same plain-text display surfaces
 * escapeReasonForDisplay protects. A thin, semantically-named DELEGATE, not
 * a second implementation -- the two must never drift apart the way this
 * package's own history warns against (see swarms/PROTOCOL.md "Fixing a
 * class, not an instance", sub-law 5: "a count is not integrity" applies
 * just as much to "two functions that happen to agree today").
 *
 * F-f1dae277 (wave 22): `file_claims.file_path` / `ownership.violations[].file`
 * is exactly as zero-privilege as the package.json/Cargo.toml `name`
 * F-4773fb77 (wave 20) already routed through escapeReasonForDisplay -- it
 * is either a name the reporting agent itself chose, or a path that was
 * ALREADY SITTING in the audited repo's own tree before that agent's
 * ordinary, in-domain work incidentally touched it. This field family
 * reaches eight render sites across this domain (proven live, none
 * previously escaped):
 *
 *   direct (a bare path, or a path-only string, rendered as-is):
 *     - commands/receipt.js's Ownership Violations section
 *     - commands/revalidate.js's Refused list (`r.reason`, itself a
 *       composite string built by joining `ownership.violations[].file`
 *       into a fixed template -- escaped via escapeReasonForDisplay at
 *       render time, not this function, since it is reason-shaped by the
 *       time it reaches the render site; see revalidate.js for why the
 *       escape lives there and not at the join site)
 *     - commands/clean-claims.js's per-claim file listing
 *     - cli.js's `swarm collect` OWNERSHIP VIOLATIONS block
 *
 *   indirect (the SAME joined-path text, laundered through
 *   `agent_runs.error_message` -- collect.js's `violMsg` is written to that
 *   column for an `ownership_violation` status agent_run, and none of its
 *   four independent readers escaped it before this wave):
 *     - commands/receipt.js's Agents table (error column)
 *     - commands/status.js's Agents list and BLOCKER lines
 *     - commands/resume.js's Blocked -- manual fix list
 *
 * The escaping LOGIC is identical for a bare path and for a reason string a
 * path was joined into -- both are "free text rendered onto a plain-text
 * display surface," this file's own established threat model -- so this
 * export exists purely so a call site rendering a bare path reads correctly
 * at a glance (`escapePathForDisplay(v.file)`, not the semantically-odd
 * `escapeReasonForDisplay(v.file)`), never because paths need a different
 * escaping RULE. If a genuine path-specific rule is ever needed (paths do
 * have a different legitimate-character profile than free-form prose --
 * e.g. this repo's own path separators, which this function does not
 * special-case), extend the shared implementation this delegates to, not a
 * fork of it.
 *
 * @param {string} path
 * @returns {string}
 */
export function escapePathForDisplay(path) {
  return escapeReasonForDisplay(path);
}
