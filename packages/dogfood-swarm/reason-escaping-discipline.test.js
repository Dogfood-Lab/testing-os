/**
 * reason-escaping-discipline.test.js — mechanical guard against a NEW
 * reason-rendering site shipping unescaped.
 *
 * The wave-18 root cause (F-7c3e91a4 / F-463c7179): wave 16 fixed
 * formatOverrideGroups (cli.js) alone, while seven near-identical sibling
 * call sites (history.js, status.js, rewind.js, redrive.js, revalidate.js,
 * clean-claims.js x2) shipped zero escaping — undetected for two full
 * waves until an auditor's live CLI-subprocess repro found them by hand.
 * That is exactly the failure mode a mechanical, always-on gate exists to
 * catch instead of relying on the next auditor to find it again.
 *
 * Scans every commands/*.js file + cli.js for the bare identifiers this
 * package uses for operator-audit reason text (`reason`, `reasonRecorded`,
 * `lastReason` — the fields wave_state_events.reason / agent_state_events.
 * reason / domain_events.reason and the --reason CLI flag itself all funnel
 * through these names) and requires that any file touching one of them ALSO
 * references escapeReasonForDisplay somewhere in its source, unless
 * explicitly allowlisted below with a named, reviewable justification.
 *
 * SCOPE, STATED PLAINLY (mirrors amend1-wave9-filter-discipline.test.js's
 * own convention of naming a static scanner's boundary rather than
 * overclaiming it): this is a FILE-level co-occurrence check, not a
 * per-line or per-function one. It reliably catches the wave-18 regression
 * SHAPE — an entire file/call-site landing with zero escaping calls
 * anywhere in it, the actual historical defect — but would NOT catch a new
 * unescaped line added to a file that already legitimately calls
 * escapeReasonForDisplay elsewhere for a DIFFERENT site. The companion
 * wave18-4091637-5127-swarm-cp-pins.test.js file has call-site-precise
 * CLI-subprocess proofs for the sites that exist today; this gate is the
 * class-level trip-wire for tomorrow's new site landing with NO escaping
 * call anywhere in its file — the exact shape of gap that let wave 18's
 * seven siblings through undetected. A future maintainer who wants
 * per-call-site precision should extend this file, not silently trust the
 * coarser check; the allowlist below is INTENTIONALLY narrow and forces a
 * documented decision on every file the sweep flags, which is the same
 * "forces a thinking step" discipline amend1-wave9-filter-discipline.test.js
 * established for its own domain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

const REASON_IDENTIFIER = /\b(reason|reasonRecorded|lastReason)\b/;
const ESCAPE_CALL = 'escapeReasonForDisplay(';

// Files that legitimately reference a `reason`-shaped identifier WITHOUT it
// being operator-audit text from wave_state_events / agent_state_events /
// domain_events / the --reason CLI flag rendered to a text surface. Each
// entry MUST have a `reason` so a future maintainer can audit. Keep this
// list minimal — a file that SHOULD escape but doesn't belongs in the fix,
// not here.
// F-7ef099e3 (wave 22): the commands/verify.js entry that used to sit here
// is REMOVED, not reworded. Its text was the factually inverted safety
// argument wave 19/20's own F-5d330a4f / F-4773fb77 findings corrected:
// probe.reason is NOT "verifier-computed diagnostic text" in the safe
// sense that entry implied — it embeds the AUDITED TARGET REPO's own
// manifest `name` field verbatim (node.js/rust.js's probe()), reachable at
// zero operator privilege, which is exactly WHY verify.js now calls
// escapeReasonForDisplay on result.probe.reason (verify.js:254) and
// p.reason (verify.js:286). The entry was already inert before this
// removal — verify.js independently satisfies this gate's own
// `stripped.includes(ESCAPE_CALL)` check via those two real calls, so the
// allowlist text was never actually consulted by the running check — but a
// dead entry with an inverted safety argument is a foot-gun for the next
// maintainer who searches this array for prior art, not documentation.
// Leaving wrong text in place is strictly worse than no entry at all.
//
// F-6c030425 (wave 24): the SAME dead-entry shape independently resurfaced in
// THREE more entries after the fix above was applied to only the one
// instance in front of it — this repo's own most expensive lesson
// (swarms/PROTOCOL.md "Fixing a class, not an instance"). All three are
// REMOVED here, not reworded, for the identical reason verify.js's entry was
// removed rather than corrected: a dead entry a future maintainer might
// search for prior art is worse than no entry at all. (F-7214a8aa, wave 26:
// this passage previously named only resume.js and persist.js and said "TWO
// more entries" / "Both are REMOVED" — commands/adjudicate.js's entry was
// also removed in this same commit and was never mentioned here; see the
// third bullet below.)
//
//   - commands/resume.js (was here): independently re-verified —
//     resume.js:466 calls `escapeReasonForDisplay(a.error)` (a DIFFERENT
//     identifier than the allowlisted `report.reason`), so this file's own
//     `stripped.includes(ESCAPE_CALL)` check already passes before the
//     allowlist is ever consulted. The removed entry's TEXT was accurate
//     (report.reason really is a computed action-classifier string built
//     entirely from counts/statuses, e.g. "Some agents not complete — run
//     `swarm resume`" — never operator free text) — it was dead, not wrong.
//
//   - commands/persist.js (was here): independently re-verified —
//     persist.js:183 calls `escapeReasonForDisplay(r.dogfood?.reason)`,
//     escaping the EXACT field this entry allowlisted, so the same
//     dead-before-consultation shape applies. This one's text was ALSO
//     wrong — a second, independent defect, not just dead code: it claimed
//     r.dogfood.reason is "the dogfood-ingest HTTP/API rejection reason",
//     but persist.js never makes an HTTP/API call; it shells out locally via
//     execFileSync (persist.js:102), and on a failed ingest r.dogfood.reason
//     is a Node child_process error `.message` (persist.js's own
//     F-bf28b667/wave-20 comment says so a few lines above the real escape
//     call). F-bbb69043 already flagged this exact text as a
//     mischaracterization; `git log --oneline -- <this file>` shows only two
//     commits ever touched it (132dc18 wave-18 creation, 40e3d47 wave-22's
//     verify.js removal) — the wrong text was simply never revisited.
//
//   - commands/adjudicate.js (was here): independently re-verified — this
//     same wave's F-0b7ba713 fix gave the file its own, unrelated
//     escapeReasonForDisplay call (adjudicate.js:60 imports it;
//     adjudicate.js:302 calls `escapeReasonForDisplay(o.finding)` for the
//     jury's out_of_brief text), so this file's own
//     `stripped.includes(ESCAPE_CALL)` check already passes before the
//     allowlist is ever consulted — the identical dead-before-consultation
//     shape as the two entries above, just reached by a fix landing in this
//     SAME commit rather than a prior wave. The removed entry's TEXT was
//     accurate (the one `reason` occurrence really was literal usage-hint
//     text inside a help string naming the --reason CLI flag for the
//     operator to type next, not an interpolated/rendered VALUE) — it was
//     dead, not wrong, exactly like resume.js's.
const ALLOWLIST = [
  {
    file: 'commands/collect.js',
    reason: 'check.reason (canTransition()\'s validity-check text) is system-computed state-machine diagnostic text. It is threaded through logStage(\'transition_skipped\', { ..., detail: check.reason }) under the `detail` KEY — never the `reason` key, which at every one of this file\'s three logStage call sites is always one of three fixed literals (\'agent_run_not_found\' / \'state_machine_rejected\' / \'transition_threw\') — and logStage\'s own optional human-readable companion banner (formatHumanBanner/buildSummary, lib/log-stage.js) only ever reads the `reason` key, never `detail`, so check.reason\'s actual dynamic value never reaches that text surface. (F-6c030425, wave 24: this entry\'s PRIOR text — "fed to logStage (a structured JSON event), never rendered to a text/console surface" — overclaimed about logStage ITSELF, the same overclaim shape F-12947492 flagged before: logStage DOES have a text-rendering path, formatHumanBanner, for whatever field a caller places under its `reason` key. The claim only ever held for THIS call site\'s specific choice of key name, not for logStage as a mechanism — corrected here to say exactly that, no more.) collect.js also threads a `reason` PARAMETER through to transitionAgent/transitionWave at several call sites — a DB column write, not a render.',
  },
  {
    file: 'commands/dispatch.js',
    reason: 'every `reason` occurrence is literal usage-hint text inside help/error strings naming the --reason flag for `swarm redrive` / `swarm defer` / `swarm reject` (e.g. "... --reason \\"<text>\\" --apply`"), not an interpolated/rendered VALUE.',
  },
];

/**
 * True when a file already satisfies this gate's own ESCAPE_CALL check on
 * its own, via some call unrelated to any ALLOWLIST entry for it — meaning
 * the entry is never actually consulted (the `if (stripped.includes(
 * ESCAPE_CALL)) continue;` short-circuit in the main gate below fires
 * first, before `allowlistEntryFor` is ever called for that file).
 *
 * F-6c030425 (wave 24): three ALLOWLIST entries independently went dead this
 * way, discovered one at a time across three separate waves (18's original
 * authoring left one dead from the start; F-7ef099e3 in wave 22 caught a
 * second; this finding caught a third and a fourth). This predicate is the
 * standing mechanical check the finding asked for, so a newly-dead entry is
 * caught the next time this suite runs instead of waiting for the next
 * confirming audit to notice by hand.
 */
function fileAlreadySatisfiesEscapeCall(strippedSource) {
  return strippedSource.includes(ESCAPE_CALL);
}

function relativeFromPkg(absPath) {
  return absPath.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
}

function walkSync(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkSync(p, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(p);
  }
  return files;
}

function allowlistEntryFor(relPath) {
  return ALLOWLIST.find((e) => e.file === relPath) || null;
}

/** The set of commands/*.js + cli.js files this discipline gate scans. */
function scanTargets() {
  const all = walkSync(PKG_ROOT);
  return all.filter((p) => {
    const rel = relativeFromPkg(p);
    if (rel.endsWith('.test.js') || rel.endsWith('.test.mjs')) return false;
    if (rel === 'commands/lib/escape-reason.js') return false; // the helper itself
    return rel === 'cli.js' || rel.startsWith('commands/');
  });
}

describe('Reason-escaping discipline (mechanical guard against a new unescaped render site)', () => {
  it('every commands/*.js + cli.js file that references a reason-shaped identifier also calls escapeReasonForDisplay, unless allowlisted', () => {
    const offenders = [];
    for (const f of scanTargets()) {
      const rel = relativeFromPkg(f);
      const stripped = stripComments(readFileSync(f, 'utf-8'));
      if (!REASON_IDENTIFIER.test(stripped)) continue; // file never touches a reason-shaped field
      if (stripped.includes(ESCAPE_CALL)) continue;     // file DOES route through the helper somewhere

      if (allowlistEntryFor(rel)) continue;

      offenders.push(rel);
    }

    assert.deepEqual(offenders, [],
      `file(s) reference a reason-shaped identifier (reason / reasonRecorded / lastReason) but never call ` +
      `escapeReasonForDisplay anywhere in the file, and are not allowlisted:\n  ${offenders.join('\n  ')}\n\n` +
      `Either route the render site through commands/lib/escape-reason.js's escapeReasonForDisplay, ` +
      `or add a documented ALLOWLIST entry in this test explaining why the reference is not operator-audit text.`);
  });

  it('the allowlist stays honest: every entry resolves to a real file under the scanned tree and carries a real justification', () => {
    const scanned = new Set(scanTargets().map(relativeFromPkg));
    for (const entry of ALLOWLIST) {
      assert.ok(scanned.has(entry.file), `allowlist entry '${entry.file}' is not one of the files this gate scans (typo, or the file moved)`);
      assert.ok(entry.reason && entry.reason.length > 20, `allowlist entry '${entry.file}' needs a real justification`);
    }
  });

  it('no ALLOWLIST entry is dead: its target file does not already satisfy ESCAPE_CALL on its own (F-6c030425)', () => {
    // A dead entry's file already passes the main gate's own
    // `stripped.includes(ESCAPE_CALL)` short-circuit via some OTHER
    // escapeReasonForDisplay call, so `allowlistEntryFor` above is never
    // reached for it — the entry's text, right or wrong, is inert prose
    // nobody consults at runtime. Confirmed real, not hypothetical: this is
    // exactly the shape independently found in three prior entries (see the
    // history above ALLOWLIST). This is the standing re-check that replaces
    // waiting for the next confirming audit to notice by hand.
    const deadEntries = [];
    for (const entry of ALLOWLIST) {
      const abs = join(PKG_ROOT, entry.file);
      const stripped = stripComments(readFileSync(abs, 'utf-8'));
      if (fileAlreadySatisfiesEscapeCall(stripped)) deadEntries.push(entry.file);
    }
    assert.deepEqual(deadEntries, [],
      `these ALLOWLIST entries are DEAD — their target file already satisfies this gate's own ESCAPE_CALL ` +
      `check via an unrelated escapeReasonForDisplay call elsewhere in the file, so the allowlist entry is ` +
      `never actually consulted: ${deadEntries.join(', ')}. Remove the entry (see F-6c030425 / F-7ef099e3 for ` +
      `precedent) rather than leaving a moot justification for the next maintainer to trip over.`);
  });

  it('mutation proof: fileAlreadySatisfiesEscapeCall goes RED for dead-shaped source and GREEN for live-shaped source', () => {
    const deadShaped = stripComments('function f(reason) { escapeReasonForDisplay(reason); return reason; }');
    const liveShaped = stripComments('function f(reason) { return reason; }');
    assert.ok(fileAlreadySatisfiesEscapeCall(deadShaped), 'sanity: a file with a real escape call anywhere is DEAD for allowlist purposes');
    assert.ok(!fileAlreadySatisfiesEscapeCall(liveShaped), 'sanity: a file with no escape call anywhere is LIVE (its allowlist entry, if any, is still consulted)');
  });

  // F-<self>: mutation-style proof that the sweep is not vacuously passing —
  // a file with the bare identifier and NO escape call must be caught. This
  // is the SAME "prove the gate can fail" discipline
  // amend1-wave9-filter-discipline.test.js's own mutation section applies,
  // scoped to this gate's own classification function rather than a
  // production file (which would require landing a real regression to test).
  it('mutation proof: a reason-touching, non-allowlisted, non-escaping file text is classified as an offender', () => {
    const stripped = stripComments('function f(reason) { console.log(`Reason: ${reason}`); }');
    assert.ok(REASON_IDENTIFIER.test(stripped), 'sanity: the probe text matches the identifier pattern');
    assert.ok(!stripped.includes(ESCAPE_CALL), 'sanity: the probe text has no escape call');
  });

  it('mutation proof: the SAME probe text is exempted once it calls escapeReasonForDisplay', () => {
    const stripped = stripComments(
      'function f(reason) { console.log(`Reason: ${escapeReasonForDisplay(reason)}`); }'
    );
    assert.ok(REASON_IDENTIFIER.test(stripped));
    assert.ok(stripped.includes(ESCAPE_CALL));
  });
});

// ════════════════════════════════════════════════════════════════════════
// Audited-controlled field-family gate: file_path / file / line / line_number
// / symbol / out_of_brief / (finding-shaped) description.
//
// Coordinator-assigned, wave 24 — the class fix behind this wave's 4 HIGH
// findings. HANDOFF.md's wave-22 debt disclosure named this gap directly:
// "the escaping-discipline gate's REASON_IDENTIFIER regex is structurally
// blind to the file/file-path field family — the field family has direct
// pinned coverage, but the FILE-level gate won't catch a *future* new render
// site." verbs + core are escaping ~10 render/prompt sites of this family
// this wave (commands/dispatch.js, commands/adjudicate.js, cli.js,
// lib/findings-render.js, lib/templates.js) because wave 22 fixed the class
// in two lanes (the ownership/file_claims family via escapePathForDisplay,
// F-f1dae277) and still left these siblings. This section is the standing
// gate so the NEXT sibling is caught mechanically instead of by the next
// confirming audit.
//
// Why this is a SEPARATE gate from REASON_IDENTIFIER above, not a widened
// version of it: the reason-family check is FILE-level ("does
// escapeReasonForDisplay appear ANYWHERE in the file") because the wave-18
// defect it was built for really was file-shaped — whole files shipping zero
// escaping. That granularity is PROVABLY too coarse for this field family:
// lib/findings-render.js already calls escapeReasonForDisplay (via its own
// truncate() helper, used for `description`/`evidence`) in the SAME file as
// a genuinely unescaped `loc` (built from `f.file`/`f.line`) and `f.symbol`
// render. A file-level check sees the pre-existing call and marks the WHOLE
// FILE clean, silently exempting the sites next to it — confirmed by
// actually running a bare file-level version of this check against this
// package's real source before choosing this design: it reported
// lib/findings-render.js clean while 7 of its lines were genuinely
// unescaped. So this gate is scoped PER-LINE, and its allowlist is keyed by
// a content anchor (a literal substring of the offending line) rather than a
// line number — the same reason the grandfather-manifest gate is
// content-addressed via a SHA-256 digest (EXPECTED_GRANDFATHER_MANIFEST_HASH
// / grandfatherManifestFingerprint, scripts/check-finding-regression-pins.mjs)
// rather than guarded by a headcount (PROTOCOL.md "Fixing a class, not an
// instance", sub-law 5; F-2e4c3017, wave 26: this comment previously cited a
// never-existed `dispatch.lock.json` file — no such file exists anywhere in
// this repo, tracked or otherwise): a line-number key silently stops
// matching, or silently keeps "protecting" the wrong line, the moment an
// unrelated edit shifts the file.
//
// Scope, stated plainly (same discipline as REASON_IDENTIFIER's own SCOPE
// paragraph above):
//   - every identifier requires a PRECEDING DOT (`\.file_path\b`, not bare
//     `\bfile_path\b`). A SQL column alias inside a query string
//     (`fc.file_path`) and this gate's real target (`f.file_path`
//     interpolated into a console/markdown line) are lexically identical —
//     both are dotted access — so the dot alone cannot separate them.
//   - what DOES separate them, measured (not assumed) against this
//     package's real source: every genuine render site interpolates the
//     value with `${...}`; every SQL alias / DB bind param / dedup-key
//     construction in this package never does — queries are parameterized
//     with `?`, never string-built via template interpolation of a column
//     value. Requiring a `${` co-occurrence on the SAME line eliminated
//     every false positive measured (verify-approved.js / verify-recurring
//     .js / verify-unverified.js's column-alias SELECTs; cli.js's
//     annotateCanonicalFindingIds tupleKey/driftedLineKey dedup keys;
//     clean-claims.js / receipt.js's intermediate claim/violation model
//     objects) while keeping every real render site intact (verified by
//     direct measurement — see the per-line ALLOWLIST below for the
//     disposition of every line this scan actually flagged).
//   - `description` deliberately stays a BARE dotted identifier
//     (`\.description\b`), not scoped to a specific receiver name, because
//     the real sibling this sweep found (cli.js:2636, `swarm trends --query
//     recurring`) renders finding.description through a receiver named `r`,
//     not `f` — a receiver allowlist would have silently missed it. The word
//     also collides with a materially different, lower-privilege field —
//     `swarm domains`'s own `domain.description` (operator/repo-owner-
//     authored config, not audited-target-repo content) at commands/status.js
//     and cli.js's `--desc` domain-edit flag — but both of those measured
//     false positives are ALREADY excluded by the `${` requirement above
//     (neither renders via template interpolation anywhere in this package,
//     confirmed by reading both call sites), so no separate receiver
//     restriction is needed, and one was tried and REMOVED here after it
//     proved to silently exclude the real cli.js:2636 sibling — the fix
//     traded a false negative for an unneeded guard against a false positive
//     the `${` check already handled. Left as a disclosed near-miss rather
//     than silently corrected, per this repo's own "an honest partial beats
//     an overclaim" standard.
//   - like the gate above, this is source-text scanning, not a real parser:
//     a render site that concatenated with `+` instead of interpolating with
//     `${...}` would slip through. Every render site in this package today
//     uses template-literal interpolation (verified by reading every flagged
//     line, not assumed) — if that convention ever changes, this gate's `${`
//     requirement needs to change with it. Disclosed, not silently papered
//     over (swarms/CLAUDE.md "Honesty is a feature of the artifact").
//
// A note on the wave-24 parallel-amend shape (constraint (c) of this gate's
// own dispatch brief): swarm-cp-verbs and swarm-cp-core are escaping their
// named sites in ISOLATED worktrees this same wave, invisible to this
// worktree's copy of the source. This gate is authored to be correct against
// a FULLY ESCAPED tree — it is expected to fail here, in THIS worktree,
// against every site those lanes haven't landed yet. That is the gate
// working, not a bug in it: the coordinator's serial verify (after merging
// every lane) is where this gate gets to actually prove something. Any
// failure it reports that ISN'T one of the sites those two lanes are known
// to be fixing this wave is a genuinely new sibling — see the next
// paragraph.
//
// A sibling this sweep independently found — and this same wave went on to
// fix, not previously named by this wave's routed findings: `swarm trends
// --query recurring`'s formatTrends() rendered `r.description` unescaped —
// `r` here comes from lib/queries/cross-run-analytics.js's
// queryRecurringFindings(), whose SQL selects `MAX(f.description) AS
// description` directly off the `findings` table — the SAME field family,
// reached via a query path (cross-run trend aggregation) none of this
// wave's other named sites touch. This is the gate catching a real gap on
// its own first run, not a false positive: cli.js:2636 now reads
// `escapeReasonForDisplay(r.description)` under an explicit "F-c6f7d8fc
// (wave 24) sweep" comment. (F-1a36730d, wave 26: this passage, the failure
// message below, and a mutation-proof test's inline comment all previously
// described this site as still-open and un-allowlisted "on purpose" — true
// pre-merge, in this domain's own isolated wave-24 worktree per the
// parallel-amend note above, but never reconciled after the merge landed
// the fix in the same commit. See HANDOFF.md's wave-24 entry, which already
// correctly frames this as "a 9th and 10th site the sweep found beyond the
// audit's".)

const AUDITED_FIELD_IDENTIFIER = /\.(file_path|line_number|out_of_brief|file|line|symbol|description)\b/;

// This package has TWO legitimate escaping primitives for TWO different
// render surfaces, and this gate recognizes both:
//   - TERMINAL / markdown-to-a-human surface → escapeReasonForDisplay /
//     escapePathForDisplay (the full pass: backslash + quote + newline +
//     the invisible/bidi/Tag-block CONTROL_CLASS + ZALGO_RUN). A terminal
//     render needs the newline/quote passes because an embedded newline
//     forges a whole fake line on a console (the wave-16→22 history in
//     commands/lib/escape-reason.js).
//   - PROMPT surface (text handed to the NEXT agent as its prompt) →
//     neutralizeInvisibleControls, the core-lane primitive added this wave
//     (wave 24) alongside the existing two in commands/lib/escape-reason.js.
//     It applies ONLY the invisible/Tag-block/bidi CONTROL_CLASS + ZALGO_RUN
//     passes and deliberately OMITS the backslash/quote/newline passes:
//     those would mangle legitimate agent-read prompt prose and fight
//     lib/templates.js's fenceSafeBlock (which owns the backtick-fence
//     hazard on that surface). The real injection risk on an LLM-read prompt
//     is the invisible/steganography/bidi class (ASCII-smuggling via the Tag
//     block, bidi override, zero-width) — exactly what the neutralizer
//     strips — not newline forgery, which has no meaning to a prompt reader.
//
// SCOPE BOUNDARY, stated plainly (same honesty standard as this file's other
// disclosed boundaries): this is a same-line "was SOME recognized escaping
// primitive called" check — it does NOT verify the primitive MATCHES the
// surface. A hypothetical terminal render site that called only
// neutralizeInvisibleControls (too weak for a console — no newline pass)
// would be greenlit here. That false-green is identical in kind to the
// pre-existing one for truncate() below (a commands/** terminal site calling
// some unrelated truncate() would also be greenlit), and it is accepted for
// the same reason: closing it needs a real per-surface parser this gate
// deliberately is not (see the header's "source-text scanning, not a real
// parser" boundary). The realistic risk is low — a name like
// neutralizeInvisibleControls is self-describing enough that no one reaches
// for it to escape a terminal line — but it is disclosed, not hidden.
const FIELD_ESCAPE_MARKERS = [
  'escapeReasonForDisplay(',
  'escapePathForDisplay(',
  // The prompt-surface primitive (core-lane, wave 24). See the two-primitive
  // note directly above for why the prompt surface uses a DIFFERENT, lighter
  // escaper than the terminal one — and why recognizing its call is the right
  // mechanism for the templates.js prompt sites, NOT a FIELD_FAMILY_ALLOWLIST
  // exemption (the sites are genuinely fixed by this call, not excused).
  'neutralizeInvisibleControls(',
  // lib/templates.js's local prompt wrapper (wave 24) — a thin delegate to
  // neutralizeInvisibleControls that only adds a falsy-input guard
  // (`text ? neutralizeInvisibleControls(text) : text`). Recognized here for
  // the same reason as the primitive itself: the prompt render sites call this
  // wrapper name, and it IS a real invocation of the prompt escaper, not an
  // exemption. Confirmed against source that neutralizeForPrompt's only body
  // is that delegate — if it ever grows a second, weaker branch this marker
  // would need to become the primitive again.
  'neutralizeForPrompt(',
  // lib/findings-render.js's own local helper — its doc comment and its
  // implementation both confirm it escapes BEFORE truncating, so a field
  // routed through truncate(...) is exactly as escaped as one calling
  // escapeReasonForDisplay directly.
  'truncate(',
];

/**
 * The additional files (beyond scanTargets()'s commands/**+cli.js) where
 * this wave names the audited-controlled field family as rendered. Kept as
 * a SEPARATE population from scanTargets() rather than widening that
 * function: lib/templates.js legitimately references bare `reason` inside
 * its own static prompt-schema example text (the JSON-shaped block every
 * amend prompt embeds to show an agent what an output finding object looks
 * like) — folding it into the reason-family scan would force an unrelated
 * new entry into THAT gate's ALLOWLIST, coupling two independently-working
 * gates for no benefit. Verified before this design was chosen (not
 * assumed): lib/findings-render.js has exactly ONE REASON_IDENTIFIER match
 * post-strip (F-2d61dade, wave 26: its own `import { escapeReasonForDisplay,
 * escapePathForDisplay } from '../commands/lib/escape-reason.js'` line — the
 * match is the literal substring 'reason' inside the file PATH
 * `escape-reason.js`, a word boundary created by the hyphen, not any
 * reason-shaped content in the file) — so it is safe either way regardless;
 * lib/templates.js is not.
 */
function fieldFamilyScanTargets() {
  const extra = ['lib/findings-render.js', 'lib/templates.js'].map((rel) => join(PKG_ROOT, rel));
  return [...scanTargets(), ...extra];
}

/**
 * Per-line offenders: a line touching an audited-controlled field via
 * template interpolation, with no recognized escaping helper on that SAME
 * line. Pure function over already-comment-stripped text so it can be
 * mutation-proved directly with literal strings (below), independent of
 * today's real-file defect population.
 */
function findFieldFamilyOffenders(strippedSource) {
  const offenders = [];
  const lines = strippedSource.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!AUDITED_FIELD_IDENTIFIER.test(text)) continue;
    if (!text.includes('${')) continue; // require template-interpolation co-occurrence
    if (FIELD_ESCAPE_MARKERS.some((m) => text.includes(m))) continue;
    offenders.push({ lineNo: i + 1, text });
  }
  return offenders;
}

// Per-line allowlist. Keyed by `file` + a literal, unique SUBSTRING of the
// offending line (`match`) rather than a line number, so an unrelated edit
// elsewhere in the file can never silently invalidate or misapply an entry.
// The honesty test below asserts every `match` still anchors a real
// candidate-shaped line in the CURRENT file, so a line that gets fixed or
// deleted is caught as staleness rather than silently suppressing nothing.
const FIELD_FAMILY_ALLOWLIST = [
  {
    file: 'commands/collect.js',
    match: 'const violMsg = `Out-of-domain edits:',
    reason: 'v.file is joined into violMsg here, but per F-f1dae277 (wave 22, commands/lib/escape-reason.js) this exact joined-path text is escaped at every one of its READERS once stored to agent_runs.error_message (receipt.js\'s Agents table, status.js\'s Agents list/BLOCKER lines, and resume.js\'s Blocked list all call escapeReasonForDisplay(a.error) downstream) — deliberately deferred to the render site, not the join site, the same pattern commands/revalidate.js uses for the identical field (see the next entry).',
  },
  {
    file: 'commands/revalidate.js',
    match: 'reason: `ownership (reported + git-observed):',
    reason: 'v.file is joined into a `reason:`-keyed field here, escaped downstream at its actual render site (revalidate.js:703, `escapeReasonForDisplay(r.reason)`) rather than at this join — the file\'s own F-4773fb77/wave-20 comment a few lines below this join documents the deferral as deliberate.',
  },
  {
    file: 'lib/findings-render.js',
    match: "pad('Class', widths.cls)",
    reason: 'widths.symbol / widths.loc here are computed column-width INTEGERS (maxWidth()\'s return value, used to pad the markdown/text table HEADER row), never the finding\'s own file/symbol string content — this header row has no finding-authored text in it at all.',
  },
  {
    file: 'lib/findings-render.js',
    match: 'dash(widths.cls)',
    reason: 'same as the header-row entry above: widths.loc / widths.symbol are column-width integers used to draw the ASCII underline row, not rendered finding content.',
  },
  {
    file: 'lib/findings-render.js',
    match: 'pad(r.symbol, widths.symbol)',
    reason: 'the renderVerifyFixedText DATA row (F-8e414a2b, wave 24): r.loc / r.symbol / r.evidence are all pre-escaped at row CONSTRUCTION a few lines above — loc via formatLoc() (escapePathForDisplay), symbol via formatSymbol() (escapeReasonForDisplay), evidence via truncate() — so this line pads already-escaped values. The escaping is real, it just happens at the row-build map rather than on this render line, which the same-line scan cannot see. The markdown sibling renderer keeps truncate() ON its line and so passes without an entry; this text renderer builds rows first, hence the entry.',
  },
  {
    file: 'commands/dispatch.js',
    match: '${f.finding_id}: ${f.description} (${f.file_path',
    reason: 'buildPriorMap → priorContext (F-d2d06af3, wave 24): this line joins f.description / f.file_path into the priorContext string RAW, but the whole joined string is neutralized DOWNSTREAM at its only render site — lib/templates.js:514, buildAuditPrompt does `fenceSafeBlock(neutralizeForPrompt(opts.priorContext))` before the prompt reaches the next agent. Because neutralizeInvisibleControls is per-codepoint, neutralizing the joined blob is equivalent to neutralizing each field. Deferred to the render boundary (one neutralization pass at the surface) rather than the join, the same downstream-escaping pattern as the collect.js/revalidate.js entries above.',
  },
];

/**
 * F-84badba1 (wave 26): four of the six FIELD_FAMILY_ALLOWLIST entries above
 * justify themselves by naming a SPECIFIC downstream/upstream file + call
 * that escapes the value on the exempted line's behalf — the exempted line
 * itself has no escaping call the same-line scan above could ever see (it's
 * a join/assignment with no `${` of its own, or is in a file that gate
 * doesn't scan). The "stays honest" test above only re-verifies the
 * EXEMPTED line's own shape (does `entry.match` still anchor a real,
 * candidate-shaped line); it never re-derives the cross-file claim the
 * reason text makes. That gap is not theoretical: mutating either dependency
 * below in an isolated scratch copy (removing lib/templates.js's
 * `neutralizeForPrompt(opts.priorContext)` call, or reverting
 * lib/findings-render.js's row-build to `symbol: f.symbol`) leaves this
 * whole suite 16/16 GREEN today — the only real protection against either
 * regression is an unrelated, out-of-domain behavioral test (see the SCOPE
 * BOUNDARY note below the checks that follow).
 *
 * The other two FIELD_FAMILY_ALLOWLIST entries (`pad('Class', widths.cls)`,
 * `dash(widths.cls)`) are deliberately absent here: their justification is
 * "this is a column-width INTEGER, not finding-authored content at all", not
 * "escaped elsewhere" — there is no downstream call to re-verify.
 *
 * Each entry names the FIELD_FAMILY_ALLOWLIST entry it backs (by file +
 * match, so a future edit/removal of that entry is caught as a stale
 * dependency rather than silently checking a ghost) and the literal,
 * comment-stripped call(s) its reason text claims exist elsewhere.
 */
const CROSS_FILE_ESCAPE_DEPENDENCIES = [
  {
    entryFile: 'commands/dispatch.js',
    entryMatch: '${f.finding_id}: ${f.description} (${f.file_path',
    dependsOn: [
      // buildAuditPrompt's only render of opts.priorContext.
      { file: 'lib/templates.js', call: 'neutralizeForPrompt(opts.priorContext)' },
    ],
  },
  {
    entryFile: 'lib/findings-render.js',
    entryMatch: 'pad(r.symbol, widths.symbol)',
    dependsOn: [
      // Same file, the row-build line a few lines above the padded render —
      // the pre-escape this entry's reason text says happens there.
      { file: 'lib/findings-render.js', call: 'symbol: formatSymbol(f.symbol)' },
    ],
  },
  {
    entryFile: 'commands/collect.js',
    entryMatch: 'const violMsg = `Out-of-domain edits:',
    dependsOn: [
      // Every reader of agent_runs.error_message this entry names.
      { file: 'commands/receipt.js', call: 'escapeReasonForDisplay(a.error)' },
      { file: 'commands/status.js', call: 'escapeReasonForDisplay(a.error)' },
      { file: 'commands/resume.js', call: 'escapeReasonForDisplay(a.error)' },
    ],
  },
  {
    entryFile: 'commands/revalidate.js',
    entryMatch: 'reason: `ownership (reported + git-observed):',
    dependsOn: [
      // Same file, the actual render site (revalidate.js:703) this entry
      // says the join is deferred to.
      { file: 'commands/revalidate.js', call: 'escapeReasonForDisplay(r.reason)' },
    ],
  },
];

/**
 * True when `call` literally appears in `strippedSource` (already
 * comment-stripped by the caller). Pure function over plain text so it can
 * be mutation-proved directly with literal strings (below), independent of
 * today's real files — same discipline as fileAlreadySatisfiesEscapeCall /
 * findFieldFamilyOffenders above.
 */
function crossFileEscapeDependencyHolds(strippedSource, call) {
  return strippedSource.includes(call);
}

describe('Audited-controlled field-family escaping discipline (file_path/file/line/symbol/out_of_brief/description — coordinator-assigned, wave 24, F-6c030425 umbrella)', () => {
  it('every render line touching an audited-controlled field also calls an escaping helper, unless allowlisted', () => {
    const offenders = [];
    for (const f of fieldFamilyScanTargets()) {
      const rel = relativeFromPkg(f);
      const stripped = stripComments(readFileSync(f, 'utf-8'));
      for (const { lineNo, text } of findFieldFamilyOffenders(stripped)) {
        const allowed = FIELD_FAMILY_ALLOWLIST.some((e) => e.file === rel && text.includes(e.match));
        if (!allowed) offenders.push(`${rel}:${lineNo}: ${text.trim()}`);
      }
    }

    assert.deepEqual(offenders, [],
      `line(s) render an audited-controlled field (file_path / file / line / line_number / symbol / ` +
      `out_of_brief / finding.description) via template interpolation with no escaping helper on the same ` +
      `line, and are not allowlisted:\n  ${offenders.join('\n  ')}\n\n` +
      `Either route the value through escapeReasonForDisplay/escapePathForDisplay, or add a documented ` +
      `FIELD_FAMILY_ALLOWLIST entry explaining why this specific line is not an audited-repo-controlled render.\n\n` +
      `NOTE (wave 24, parallel amend): if this fails against sites swarm-cp-verbs/swarm-cp-core are actively ` +
      `escaping in their own isolated worktrees this wave, that is this gate working as designed — it goes ` +
      `green once the coordinator merges those lanes. A failure naming a site NOT already tracked by this ` +
      `wave is a genuinely new sibling this sweep found — this is exactly how cli.js:2636's \`swarm trends\` ` +
      `site was caught and fixed within wave 24 itself (see this file's header comment); see ` +
      `swarms/PROTOCOL.md "Fixing a class, not an instance".`);
  });

  it('the field-family allowlist stays honest: every entry names a real scanned file and still anchors a real candidate line', () => {
    const scanned = fieldFamilyScanTargets();
    const byRel = new Map(scanned.map((f) => [relativeFromPkg(f), f]));
    for (const entry of FIELD_FAMILY_ALLOWLIST) {
      assert.ok(entry.reason && entry.reason.length > 20, `allowlist entry '${entry.file}' / '${entry.match}' needs a real justification`);
      const abs = byRel.get(entry.file);
      assert.ok(abs, `allowlist entry '${entry.file}' is not one of the files fieldFamilyScanTargets() scans (typo, or the file moved)`);
      const stripped = stripComments(readFileSync(abs, 'utf-8'));
      const line = stripped.split('\n').find((text) => text.includes(entry.match));
      assert.ok(line, `allowlist entry '${entry.file}' / '${entry.match}' no longer matches any line in the current file — the line was fixed or removed; update or delete this entry`);
      assert.ok(AUDITED_FIELD_IDENTIFIER.test(line) && line.includes('${'),
        `allowlist entry '${entry.file}' / '${entry.match}' points at a line that is no longer candidate-shaped ` +
        `(no audited-field identifier + template interpolation) — it is not suppressing anything real; update or delete it`);
    }
  });

  // No @pins tag by design (F-84badba1): this finding's fix is entirely inside
  // this gate test file — adding the cross-file escape-dependency re-verification
  // so an allowlist entry's named downstream/upstream call is checked to still
  // exist. No production-source F-84badba1 pin exists for a declared tag to
  // resolve against (same shape as wave-22 F-7d4ac5ce). The test below still runs.
  it('cross-file escape dependency check: entries that defer to a NAMED downstream/upstream call are re-verified against that call, not just trusted (F-84badba1)', () => {
    assert.ok(CROSS_FILE_ESCAPE_DEPENDENCIES.length > 0,
      'CROSS_FILE_ESCAPE_DEPENDENCIES must not be empty — an empty list would make this check vacuously pass, ' +
      'indistinguishable from "every deferred-escaping claim was verified" (PROTOCOL.md "Proving a gate")');

    const failures = [];
    for (const dep of CROSS_FILE_ESCAPE_DEPENDENCIES) {
      const stillReferenced = FIELD_FAMILY_ALLOWLIST.some((e) => e.file === dep.entryFile && e.match === dep.entryMatch);
      assert.ok(stillReferenced,
        `CROSS_FILE_ESCAPE_DEPENDENCIES names a FIELD_FAMILY_ALLOWLIST entry ('${dep.entryFile}' / ` +
        `'${dep.entryMatch}') that no longer exists — update or remove this dependency so it isn't silently ` +
        `checking a ghost entry`);

      for (const { file, call } of dep.dependsOn) {
        const stripped = stripComments(readFileSync(join(PKG_ROOT, file), 'utf-8'));
        if (!crossFileEscapeDependencyHolds(stripped, call)) {
          failures.push(`${dep.entryFile}'s allowlist entry ('${dep.entryMatch}') defers its escaping to ` +
            `${file}'s '${call}' call, which no longer appears there`);
        }
      }
    }
    assert.deepEqual(failures, [],
      `these FIELD_FAMILY_ALLOWLIST entries rely on a downstream/upstream escaping call that this same-line ` +
      `scan cannot see on the exempted line itself, and that call has been removed or renamed — so the ` +
      `deferred escaping the entry's own reason text promises no longer exists:\n  ${failures.join('\n  ')}\n\n` +
      `Either restore the named call, or if the escaping genuinely moved, update the entry's reason text AND ` +
      `its CROSS_FILE_ESCAPE_DEPENDENCIES entry to point at the new location (F-84badba1).`);
  });

  it('mutation proof: crossFileEscapeDependencyHolds goes RED when the named call is absent, GREEN when present', () => {
    const withCall = 'const priorSection = opts.priorContext ? fenceSafeBlock(neutralizeForPrompt(opts.priorContext)) : \'\';';
    const withoutCall = 'const priorSection = opts.priorContext ? fenceSafeBlock(opts.priorContext) : \'\';';
    assert.ok(crossFileEscapeDependencyHolds(withCall, 'neutralizeForPrompt(opts.priorContext)'),
      'sanity: the call, present verbatim, is recognized');
    assert.ok(!crossFileEscapeDependencyHolds(withoutCall, 'neutralizeForPrompt(opts.priorContext)'),
      'sanity: the SAME line with the call stripped back out to raw interpolation is no longer recognized — ' +
      'this is the RED case a real regression (reverting neutralizeForPrompt to raw opts.priorContext) would ' +
      'actually produce, and which the field-family gate above cannot see on dispatch.js\'s own exempted line');
  });

  it('mutation proof: crossFileEscapeDependencyHolds only credits the CALL, not a comment merely mentioning it (F-6c030425 sub-law 3: strip comments before asserting)', () => {
    const commentOnly = stripComments('// TODO: consider calling neutralizeForPrompt(opts.priorContext) here\nconst priorSection = opts.priorContext;');
    assert.ok(!crossFileEscapeDependencyHolds(commentOnly, 'neutralizeForPrompt(opts.priorContext)'),
      'sanity: a comment merely naming the call must not be credited as the call actually existing — the ' +
      'caller is required to pass already-stripped text, matching this file\'s own strip-before-assert discipline');
  });

  // SCOPE BOUNDARY, stated plainly (same honesty standard as this file's
  // other disclosed boundaries): CROSS_FILE_ESCAPE_DEPENDENCIES only covers
  // the FIELD_FAMILY_ALLOWLIST entries that name a SPECIFIC call in a
  // SPECIFIC file — it re-derives "does the named call still appear in the
  // named file", nothing more. It does NOT verify that the call's own
  // behavior still does what the reason text claims (e.g. that
  // neutralizeForPrompt hasn't been gutted into a no-op while keeping its
  // name), and it does NOT discover a dependency this list doesn't already
  // know about — it is a targeted anchor check, not a general dataflow
  // analysis (the same "source-text scanning, not a real parser" boundary
  // this file's header comment already discloses for the sibling gate
  // above). Independent, real, out-of-domain protection for the underlying
  // BEHAVIOR of the two production dependencies this check anchors already
  // exists and predates this wave's check: lib/f-d2d06af3-prompt-invisible-
  // neutralization.test.js drives lib/templates.js's neutralizeForPrompt
  // end-to-end, and lib/f-8e414a2b-findings-loc-symbol-escaping.test.js does
  // the same for lib/findings-render.js's formatSymbol/formatLoc row-build —
  // this check and those two are complementary, not redundant: this one
  // catches "the call disappeared from the file"; those catch "the call is
  // present but broken".

  it('sanity: fieldFamilyScanTargets() is non-empty and includes the 3 hard-named wave-24 fix-surface files', () => {
    // The "emptiness" operator this gate's own PROTOCOL.md ("Proving a gate")
    // requires: an empty scan population would make the assertion above
    // vacuously pass with zero offenders found, which is indistinguishable
    // from "everything is escaped" without this check.
    const scanned = fieldFamilyScanTargets().map(relativeFromPkg);
    assert.ok(scanned.length > 0, 'scan population must not be empty — an empty population makes the gate above vacuously pass');
    for (const must of ['cli.js', 'lib/findings-render.js', 'lib/templates.js']) {
      assert.ok(scanned.includes(must), `fieldFamilyScanTargets() must include ${must} — it is one of this wave's named fix-surface files`);
    }
  });

  it('mutation proof: a candidate-shaped line (audited field + template interpolation, no escape marker) is classified as an offender', () => {
    const src = 'function f(finding) { lines.push(`${finding.file}:${finding.line} ${finding.symbol}`); }';
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 1, 'sanity: exactly one candidate line, and it is classified as an offender');
  });

  it('mutation proof: the SAME line is exempted once escaped', () => {
    const src = 'function f(finding) { lines.push(`${escapePathForDisplay(finding.file)}:${finding.line} ${finding.symbol}`); }';
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 0, 'sanity: the same line, once it calls an escaping helper, is no longer an offender');
  });

  it('mutation proof: a PROMPT-surface render escaped via neutralizeInvisibleControls is recognized (core-lane primitive, wave 24)', () => {
    // Proves the recognition works independently of core's real templates.js
    // fix landing in THIS worktree — the gate treats the prompt-surface
    // primitive as adequate escaping the moment the call appears on the line.
    const src = 'const list = findings.map(f => `- ${f.finding_id}: ${neutralizeInvisibleControls(f.description)} (${neutralizeInvisibleControls(f.file_path)})`);';
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 0, 'sanity: neutralizeInvisibleControls is the recognized prompt-surface escaper; a line calling it is not an offender');
  });

  it('mutation proof: a dotted identifier with NO template interpolation is not a candidate (the SQL-alias / dedup-key shape)', () => {
    const src = "db.prepare('SELECT f.file_path AS file_path FROM findings').all();";
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 0, 'sanity: no ${} interpolation on the line means this is not classified as a render site');
  });

  it('mutation proof: out_of_brief is caught even though the anchor identifier itself sits outside the ${} (the for-of clause), because the render is on the same line', () => {
    const src = "for (const o of result.out_of_brief) lines.push(`(${o.jurors}) ${o.finding}`);";
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 1, 'sanity: same-line co-occurrence still catches this real wave-24 shape (commands/adjudicate.js:290)');
  });

  it('mutation proof: description is receiver-agnostic — a non-`f.` receiver (e.g. `r.description`, the cli.js:2636 `swarm trends` shape this sweep found and fixed) is still caught', () => {
    const src = 'for (const r of payload) { lines.push(`    ${r.description}`); }';
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 1, 'sanity: cli.js:2636 renders finding.description through a receiver named `r`, not `f` — the identifier must not be receiver-scoped');
  });

  it('mutation proof: a plain assignment/object-literal use of `description` with NO template interpolation is not a candidate (the domain.description shape)', () => {
    const src = "if (desc !== undefined) changes.description = desc;\nconsole.log(formatDomainRow({ name: d.name, description: d.description }));";
    const offenders = findFieldFamilyOffenders(stripComments(src));
    assert.equal(offenders.length, 0, 'sanity: commands/status.js\'s domain.description and cli.js\'s --desc assignment never interpolate with ${...} anywhere in this package, so the ${} requirement alone excludes them without needing a receiver restriction');
  });
});
