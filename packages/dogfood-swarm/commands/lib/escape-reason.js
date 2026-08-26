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
 *   F-6820e578 (wave 24): F-37ba8d85's run-length gate (`{3,}` contiguous
 *     marks) had an unbounded bypass its own docstring understated as "a
 *     narrower residual... requires deliberate construction": ZWJ never
 *     breaks a Unicode extended grapheme cluster (UAX #29 rule GB9), so
 *     interleaving a single ZWJ every 1-2 marks ("mark mark ZWJ mark mark
 *     ZWJ ...") splits an arbitrarily long stack into 2-mark sub-runs that
 *     each stay under the 3-mark threshold forever -- proven live against
 *     the real exported function with a 20-group chain (40 marks, 19 ZWJ)
 *     returning completely byte-identical/unescaped. Fixed by widening
 *     ZALGO_RUN to match a mark, then zero or more (an optional single ZWJ,
 *     then another mark) -- so a ZWJ between two marks no longer ENDS the
 *     match, only a non-mark/non-ZWJ character (or two ZWJ in a row with no
 *     mark between them) does -- and moving the escape/no-escape decision
 *     from the regex itself (which can only gate on CONTIGUOUS length) into
 *     escapeZalgoRun, which counts the actual marks in the whole matched
 *     span (ZWJ contributes zero) against the same >=3 threshold. A trailing
 *     ZWJ with no following mark is never captured by the pattern (the
 *     optional-ZWJ branch requires a mark after it to consume), so this
 *     stays scoped to mark-interleaved-with-ZWJ chains and does not reach
 *     into unrelated ZWJ usage (e.g. a mark run trailed by an emoji-joining
 *     ZWJ). Every other codepoint Default_Ignorable_Code_Point classifies as
 *     an interleaving candidate is moot here: CONTROL_CLASS already escapes
 *     everything in that property except ZWJ (the one deliberate carve-out,
 *     F-37ba8d85), and its pass runs BEFORE ZALGO_RUN in the pipeline below,
 *     so any other Default_Ignorable interleaving character has already
 *     been turned into literal `\xHH`/`\uHHHH` text -- no longer a mark or a
 *     ZWJ -- by the time ZALGO_RUN ever sees the string. ZWJ is the only
 *     codepoint that survives CONTROL_CLASS unescaped, which is exactly why
 *     it was the only viable interleaving character for this bypass.
 *
 *   F-046d3756 (wave 26): ZALGO_RUN, even after both prior fixes, still
 *     matched its mark class as ONE hardcoded Unicode block enumeration
 *     (U+0300-U+036F, "Combining Diacritical Marks" proper) -- exactly the
 *     enumerated-list shape F-6540ba3d had already generalized CONTROL_CLASS
 *     away from, never applied to its neighbor. At least four further
 *     standard blocks are General_Category=Mn or Me and visually stack onto
 *     a preceding base exactly like the covered block: Combining Diacritical
 *     Marks Supplement (U+1DC0-U+1DFF, Mn), Combining Diacritical Marks for
 *     Symbols (U+20D0-U+20FF -- both Mn, e.g. U+20D3 COMBINING
 *     ANTICLOCKWISE ARROW ABOVE, and Me, e.g. U+20DD COMBINING ENCLOSING
 *     CIRCLE), Combining Half Marks (U+FE20-U+FE2F, Mn), and the Combining
 *     Cyrillic Titlo/Palatalization pair (U+0483-U+0484, Mn) -- proven live
 *     against the real, unmutated exported functions: a 20x U+20D3 stack on
 *     one base character, with NO ZWJ or interleaving trick required at all,
 *     returned completely byte-identical from escapeReasonForDisplay,
 *     neutralizeInvisibleControls, AND escapePathForDisplay; separately,
 *     interleaving a classic-range mark with an alternate-range mark on the
 *     same base (e.g. 0300, 20D3, 0301, 20D3, ...) also returned
 *     byte-identical, because the OLD class recognized neither range as
 *     containing the other, so no contiguous run of hardcoded-range
 *     characters ever reached length 3. Fixed by replacing the hardcoded
 *     block with a Unicode-property union, `[\p{Mn}\p{Me}]` (nonspacing and
 *     enclosing marks), mirroring F-6540ba3d's own "property, not enumerated
 *     list" discipline, so the next combining mark Unicode ever assigns to
 *     either category is covered automatically instead of needing another
 *     one-off range patch. `\p{Mc}` (spacing combining marks -- Devanagari/
 *     Tamil/Thai dependent vowel signs and similar) is deliberately
 *     EXCLUDED: they carry their own visible advance width and are not the
 *     invisible-pileup threat this pass targets -- folding them in would
 *     reopen F-37ba8d85's over-broad NFD-mangling problem in the opposite
 *     direction (see "Known residual" below escapeReasonForDisplay for the
 *     resulting, deliberately-accepted boundary this creates). The >=3-mark
 *     threshold and the ZWJ-interleave counting F-6820e578 built are
 *     unchanged, and apply identically regardless of which covered block
 *     each mark in a run comes from, since the class is now a single
 *     property union rather than a set of disjoint hardcoded ranges.
 *
 *   F-35304e50 (wave 29): the "Known residual" boundary below (the `\p{Mc}`
 *     interleave, disclosed since F-046d3756) had two open questions: was it
 *     a one-codepoint quirk, and could some OTHER codepoint reach the same
 *     trick INVISIBLY rather than visibly (a materially worse defect than
 *     "looks choppy"). Both closed live, not asserted. (1) GENERALIZED: the
 *     identical interleave (alternating 2-mark Mn groups with one interleaved
 *     spacing mark) stays byte-identical for 14 `\p{Mc}` codepoints across 14
 *     scripts (Devanagari U+093E, Bengali U+09BE, Gurmukhi U+0A3E, Gujarati
 *     U+0ABE, Oriya U+0B3E, Tamil U+0BBE, Telugu U+0C41, Kannada U+0CBE,
 *     Malayalam U+0D3E, Sinhala U+0D83, Tibetan U+0F3E, Myanmar U+102B, Khmer
 *     U+17B6, Limbu U+1923), at both a single occurrence and 20x repetition --
 *     it is the general Mn/Mc boundary, not an artifact of the one U+093E
 *     example the shipped test drives. (2) CLOSED: exhaustive enumeration of
 *     the ENTIRE Unicode codespace (0..0x10FFFF) found exactly 32
 *     Cf-not-Default_Ignorable and 17 Zs-not-Default_Ignorable codepoints
 *     capable of ending a ZALGO_RUN match while surviving CONTROL_CLASS
 *     unescaped -- no more, no fewer -- and Unicode's own TR44 derivation
 *     formula (live-fetched) subtracts every one of them from
 *     Default_Ignorable_Code_Point BY NAME with the explicit rationale
 *     "(Exceptional format characters that should be visible)": the 17 Zs are
 *     literal visible-width spaces (U+0020, U+00A0, U+1680, U+2000-200A,
 *     U+202F, U+205F, U+3000); the 32 Cf resolve to exactly three named
 *     sub-groups -- U+FFF9-FFFB (already adjudicated visible by F-6540ba3d,
 *     above), the Egyptian Hieroglyph format controls (U+13430-1343F), and
 *     the Prepended_Concatenation_Mark property (U+0600-0605/U+06DD/U+070F/
 *     U+0890-0891/U+08E2/U+110BD/U+110CD). Separately, Mn and Mc are proven
 *     mutually exclusive General_Category assignments across the entire
 *     codespace (0 codepoints are both), so "a `\p{Mc}` mark that renders
 *     with near-zero width" (the shape this boundary would need to be worse
 *     than display-quality) is a structural impossibility, not merely
 *     unobserved. The invisible-pileup class is CLOSED: every mechanical
 *     run-breaker that exists is, by Unicode's own stated design intent,
 *     visible. One boundary stays honestly open, not newly introduced:
 *     Private Use Area codepoints (137,468 of them) have Unicode-UNDEFINED
 *     rendering (a private font/producer agreement, not a Unicode guarantee)
 *     -- equally true of CONTROL_CLASS's own Default_Ignorable_Code_Point
 *     basis above, so not new risk this finding introduced or left. No code
 *     change: the residual stays display-quality-only, matching this file's
 *     own severity framing, now cited rather than inferred. See "Known
 *     residual" below escapeReasonForDisplay for the updated conclusion.
 *
 *   F-29640f0b (wave 39): the C1/C2 closure verbs (`swarm reopen` / `swarm
 *     close`, cli.js's transitionFindings/formatTransitionReport) add THREE
 *     new call sites to this list, filed preemptively rather than
 *     reactively -- this exact class has independently bitten seven prior
 *     render sites in this file's own history above, one new site
 *     discovered at a time across waves 16-24. New sites: (1) the dry-run
 *     preview's `Reason:` / `Evidence:` echo lines, (2) the per-finding
 *     eligible/ineligible list rows (`f.file_path` via escapePathForDisplay,
 *     `f.note` -- a composite string built from the operator's own
 *     --reason/--evidence and this file's own `f.status` -- via
 *     escapeReasonForDisplay), and (3) the apply-confirmation summary line.
 *     `--format=json` (transitionFindings' OTHER caller-side branch in
 *     cmdReopen/cmdClose) never reaches formatTransitionReport, so the raw/
 *     lossless values still reach JSON consumers unescaped, unchanged from
 *     this file's established invariant.
 *
 *   F-648f8b51 (wave 41): a FOURTH cmdReopen render site F-29640f0b's own
 *     site inventory did not enumerate, because it sits OUTSIDE
 *     formatTransitionReport entirely: the apply-success "Next: swarm
 *     approve ... --ids ..." hint line (cli.js, immediately after
 *     `console.log(formatTransitionReport(report))` in cmdReopen) echoed
 *     the RAW, unescaped `ids` array parsed straight from the operator's
 *     own --ids flag -- proven live with a raw ANSI escape byte (ESC,
 *     0x1B) reaching stdout unneutralized via `cat -A`. Fixed by a
 *     DIFFERENT remediation shape than every site above: instead of adding
 *     an escapeReasonForDisplay/escapePathForDisplay call, the hint now
 *     reads `report.eligible.map(f => f.finding_id)` -- DB-canonical
 *     finding_id values (matched against `findings.finding_id`, minted by
 *     the fingerprint pipeline, never raw operator text) -- instead of the
 *     raw `ids` array. This closes the escaping gap AND a second bug in
 *     the same line: `ids` is the FULL parsed array including any entry
 *     matching no real finding, which survives into the hint even though
 *     it is silently absent from the eligible/ineligible report itself. No
 *     new escape call was needed or added here, unlike every site above --
 *     noted explicitly so a future auditor grepping for
 *     escapeReasonForDisplay does not read its absence at this line as an
 *     oversight; cmdClose's own equivalent hint (`Next: re-run with
 *     --apply to close N finding(s) as ${report.targetStatus}`) never
 *     echoed ids at all and needed no change.
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
// this separate pass -- see that finding's history entry above for why a
// single (or double) mark must NOT be escaped the way wave 20 escaped it.
// F-6820e578 (wave 24): matching only a STRICTLY CONTIGUOUS run of length >=3
// (wave 22's original `{3,}`) is defeated by interleaving a single ZWJ every
// 1-2 marks -- ZWJ never breaks a Unicode extended grapheme cluster (UAX #29
// rule GB9), so "mark mark ZWJ mark mark ZWJ ..." repeats without limit while
// every contiguous sub-run stays under the threshold. This pattern instead
// matches a mark, then zero or more (an optional single ZWJ, then another
// mark) -- a ZWJ between two marks no longer ends the match, only a
// character that is neither a mark nor a ZWJ does (or two ZWJ in a row with
// no mark between them, since each ZWJ branch must be immediately followed
// by a mark to be consumed). The escape decision itself moved out of the
// regex (which can only gate on contiguous length) and into escapeZalgoRun,
// below, which counts the ACTUAL marks in the whole matched span --
// interleaved ZWJ contributes zero -- against ZALGO_MARK_THRESHOLD, so an
// isolated 1-2 mark sequence still passes through untouched (interleaved
// with ZWJ or not), and a trailing ZWJ with nothing following it is never
// captured at all (the optional-ZWJ branch requires a mark after it).
// F-046d3756 (wave 26): "a mark" above was, until this wave, the single
// hardcoded block [\u0300-\u036f] -- so any combining mark from one of the
// several OTHER standard Unicode blocks that are General_Category=Mn/Me
// (Combining Diacritical Marks Supplement U+1DC0-U+1DFF, Combining
// Diacritical Marks for Symbols U+20D0-U+20FF, Combining Half Marks
// U+FE20-U+FE2F, the Cyrillic Titlo/Palatalization pair U+0483-U+0484, and
// any future mark Unicode assigns) was invisible to this pattern entirely --
// not merely under-threshold, but not a "mark" as this regex understood the
// word at all, so it could neither start nor continue a run, nor be counted
// by escapeZalgoRun below. Fixed by matching the real Unicode property union
// `\p{Mn}\p{Me}` (nonspacing and enclosing marks) instead of the one
// hardcoded block, mirroring CONTROL_CLASS's own Default_Ignorable_Code_Point
// property adoption (F-6540ba3d) one mechanism over. `\p{Mc}` (spacing
// combining marks) is deliberately NOT unioned in -- see the F-6540ba3d/
// F-37ba8d85 entry above for why reusing a spacing-mark property here would
// reopen the exact over-broad NFD-mangling direction that finding fixed.
const ZALGO_RUN = /[\p{Mn}\p{Me}](?:\u200d?[\p{Mn}\p{Me}])*/gu;

// Same threshold wave 22 established for a contiguous run -- now enforced by
// escapeZalgoRun's count rather than the regex's own match length, since a
// single ZALGO_RUN match can legitimately be as short as one mark.
const ZALGO_MARK_THRESHOLD = 3;

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
// the reader exactly how many marks (and any interleaved ZWJ) were stacked
// and where. F-6820e578 (wave 24): ZALGO_RUN can now match as few as one
// mark (so a ZWJ-interleaved chain is captured as ONE span instead of
// several sub-threshold ones), so the escape/no-escape decision lives HERE,
// counting the real marks in the span (a ZWJ contributes zero) rather than
// relying on the regex's match length. Below threshold, the run is returned
// UNCHANGED (a no-op replacement) so ordinary 1-2 mark NFD text --
// Vietnamese, polytonic Greek, IAST Sanskrit -- keeps rendering
// byte-identical, exactly as F-37ba8d85 established.
function escapeZalgoRun(run) {
  const chars = Array.from(run);
  const markCount = chars.filter((ch) => ch !== '\u200d').length;
  if (markCount < ZALGO_MARK_THRESHOLD) return run;
  return chars.map((ch) => formatEscape(ch.codePointAt(0))).join('');
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
 * swarms/CLAUDE.md "Honesty is a feature of the artifact"; this paragraph
 * corrected by F-17e594c5, wave 26, which found it contradicting this file's
 * own already-landed fix): the ZWJ-mid-run case this note used to describe
 * (mark, mark, ZWJ, mark, mark) is CLOSED, not residual -- F-6820e578 (wave
 * 24, see "History of the escaping contract" above) made escapeZalgoRun
 * count marks across the whole matched span, so that exact example now
 * escapes (proven live against the real exported function: a base letter
 * followed by U+0300, U+0301, U+200D, U+0300, U+0301 now returns each of
 * the five codepoints individually escaped, not the byte-identical output
 * this paragraph used to claim).
 *
 * The boundary that actually remains, verified live post-F-046d3756: a run
 * broken by ANY character that is neither a matched mark nor ZWJ still ends
 * the match there, by construction -- each ZALGO_RUN match is one contiguous
 * span, and escapeZalgoRun counts only what that one span captured. `\p{Mc}`
 * (spacing combining marks), deliberately excluded from the mark class
 * above, is a concrete instance: alternating short Mn/Me groups with a
 * single Mc character between each (proven live: 10 repetitions of two
 * U+0300 marks plus one U+093E DEVANAGARI VOWEL SIGN AA on one base stays
 * completely byte-identical) never accumulates 3 counted marks in any one
 * match, however many groups are chained. This is NOT the closed ZWJ case's
 * severity: every Mc character in the chain renders with its own visible
 * advance width, so the result is a visually choppy run of small accent
 * clusters separated by visible glyphs, not one base character vanishing
 * under an invisible mountain of marks -- the specific harm this file's own
 * threat model (see above) is scoped to. Whether this boundary warrants its
 * own fix (an interleaving-aware count across non-mark, non-ZWJ breaks, the
 * way F-6820e578 built specifically for ZWJ) is left for a future finding,
 * not folded into F-046d3756's own narrower ask (widen the mark PROPERTY,
 * not redesign run-continuity around a second character class).
 *
 * F-35304e50 (wave 29): this boundary is confirmed GENERAL -- 14 `\p{Mc}`
 * codepoints across 14 scripts, not just the one Devanagari example above,
 * at both a single occurrence and 20x repetition -- and the stronger open
 * question (can some OTHER codepoint reach the same trick INVISIBLY rather
 * than visibly) is CLOSED: every codepoint in the entire Unicode codespace
 * capable of ending a ZALGO_RUN match while surviving CONTROL_CLASS
 * unescaped (32 Cf + 17 Zs, exhaustively enumerated -- no more, no fewer) is,
 * by Unicode's own live-fetched TR44 derivation, visible by explicit design
 * intent -- and Mn/Mc are proven mutually exclusive General_Category
 * assignments codespace-wide, so a near-zero-width `\p{Mc}` mark is a
 * structural impossibility, not an unobserved case. See this file's header
 * "History of the escaping contract" for the full citation trail. Still no
 * code fix: the residual stays display-quality-only, unchanged from the
 * conclusion above, now proven rather than argued.
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
 * The invisible/deception subset of CONTROL_CLASS that a PROMPT surface must
 * still strip — everything CONTROL_CLASS covers EXCEPT tab (U+0009), LF
 * (U+000A) and CR (U+000D). Those three are legitimate whitespace in
 * multi-line agent-read prompt text (a prompt is multi-line by design, and
 * lib/templates.js's fenceSafeBlock relies on real newlines), so escaping them
 * to visible `\x0a` markers would corrupt every multi-line description /
 * fenced code example the next agent must read verbatim (the F-d2d06af3
 * regression the wave-24 serial verify caught). U+2028/U+2029 (the Unicode
 * line/paragraph separators) STAY escaped — they are invisible-newline forgery,
 * not the ordinary whitespace legitimate prompt content uses.
 */
const PROMPT_INVISIBLE_CLASS =
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u{2028}\u{2029}[\p{Default_Ignorable_Code_Point}--\u{200D}]]/gv;

/**
 * Neutralize only the invisible/deception codepoint class for an AGENT-READ
 * PROMPT surface (lib/templates.js's buildAmendPrompt/buildAuditPrompt,
 * F-d2d06af3). Applies PROMPT_INVISIBLE_CLASS (the Default_Ignorable/Tag-block/
 * bidi/C1 class MINUS tab/LF/CR — see that constant) plus the same
 * ZALGO_RUN pass escapeReasonForDisplay uses (so F-6820e578's zalgo-ZWJ-chain
 * fix protects this wrapper by construction), and DELIBERATELY OMITS the
 * backslash-, quote-, and whitespace-escaping passes.
 *
 * Why this differs from escapeReasonForDisplay: on a prompt, doubling
 * backslashes, escaping double-quotes, and flattening newlines to visible
 * markers would corrupt legitimate quoted paths, code, and multi-line prose
 * the audit agent reads verbatim, and fights fenceSafeBlock — while the
 * invisible classes (Tag-block ASCII-smuggling, bidi override, zalgo) are the
 * actual injection vector and MUST still be stripped. Terminal surfaces keep
 * using escapeReasonForDisplay (the full treatment); prompt surfaces use this.
 *
 * Coordinator-added at wave-24 merge to close the core↔verbs seam:
 * swarm-cp-core (templates.js) imports this, swarm-cp-verbs owns this file and
 * hardened the shared primitives; the export itself is the one-line
 * integration the amend split left for serial-verify reconciliation.
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeInvisibleControls(text) {
  return String(text)
    .replace(PROMPT_INVISIBLE_CLASS, escapeControlChar)
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

/**
 * Escape a cell value for a GitHub-flavored Markdown pipe table.
 *
 * F-03526468: escapeReasonForDisplay neutralizes controls/bidi/zalgo but
 * leaves literal `|` untouched. In formatReceiptMarkdown's Agents table a
 * raw `|` in Error or Fixes skipped splits one cell into forged columns
 * (header has 7 `|` delimiters; `boom | forged | cell` yields 9). Cell-
 * boundary only — do not fold this into escapeReasonForDisplay, or plain-
 * text status/history lines grow backslash noise for a grammar they never
 * use.
 *
 * @param {string} cell
 * @returns {string}
 */
export function escapeMarkdownTableCell(cell) {
  return String(cell).replace(/\|/g, '\\|');
}
