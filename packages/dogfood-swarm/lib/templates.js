/**
 * templates.js — Agent prompt generation from domain map + phase.
 *
 * Generates ready-to-use prompts for each domain agent in a wave.
 * Templates embed: repo path, domain scope, file list, phase lens, output format.
 *
 * Authority discipline (Stage B Item 1 + Item 4):
 * The output-shape contract appended to every prompt is DERIVED FROM the
 * canonical agent-output schema (@dogfood-lab/schemas) — not hand-typed
 * parallel to it. The
 * worked-example JSON below the contract block stays as a worked example,
 * but the schema fragment is the load-bearing reference. Same root-cause
 * group as Item 4: brief-vs-frozen-state parallel authority. Pact-style
 * contract test in dispatch-prompt-schema.test.js asserts the schema
 * fragment is present in every generated prompt.
 *
 * F-d2d06af3 (HIGH, wave 24): buildAmendPrompt (line ~524) interpolates
 * `f.file_path`/`f.description`/`f.recommendation` — audit-agent-authored
 * text describing a (sometimes-adversarial) target repo, the same
 * zero-privilege origin F-f1dae277 and F-c3d8fd7e already established for
 * this field family elsewhere in this package — with ZERO escaping for
 * `file_path` and only `fenceSafe`'s backtick-fence-parity guard for
 * `description`/`recommendation`. buildAuditPrompt's `opts.priorContext`
 * (the joined prior-findings block commands/dispatch.js hands it) has the
 * identical gap through `fenceSafeBlock`. Neither `fenceSafe` nor
 * `fenceSafeBlock` touch the control-byte/bidi/Tag-block class at all — they
 * exist solely to keep a stray backtick run from breaking THIS document's
 * own Markdown fence structure. The generated prompt is written to
 * `swarms/<run>/wave-N/<domain>.md` and read VERBATIM as the next wave's
 * Sonnet agent's own operating instructions, with no human review step in
 * between — a more direct injection surface than any terminal transcript
 * this package has already hardened, and the exact paradigm case
 * commands/lib/escape-reason.js's own F-6540ba3d docblock names as the
 * highest-risk audience (Graves 2026, arXiv:2603.00164: the Tag-block
 * ASCII-Smuggling primitive is decoded PREFERENTIALLY BY ANTHROPIC MODELS).
 *
 * THE FIX IS DELIBERATELY NOT `escapeReasonForDisplay`: that escaper is
 * built for a QUOTED TERMINAL surface — it doubles backslashes, escapes
 * double-quotes, and renders `\n`/`\t` as visible two-character markers.
 * Applied to a PROMPT an agent reads as prose/instructions, that would
 * mangle ordinary quoted text and paths (a Windows path's backslashes would
 * double) and fight fenceSafeBlock's own deliberate multi-line-chunk
 * handling (F-f2dc3caf). Instead, `neutralizeInvisibleControls` (imported
 * from commands/lib/escape-reason.js, the SAME disclosed lib→commands
 * import seam findings-render.js's F-c3d8fd7e fix established this package,
 * one file over) neutralizes ONLY the invisible/deception codepoint class
 * (Default_Ignorable incl. the Tag block, bidi controls, C0/C1 non-
 * whitespace, pathological combining-mark runs) — composed with, not
 * replacing, fenceSafe/fenceSafeBlock, which stay scoped to their own
 * backtick-fence job. Backslash, quote, tab, and newline all survive
 * untouched, so ordinary prose and paths stay exactly as legible to the
 * reading agent as before.
 *
 * CROSS-DOMAIN NOTE: `neutralizeInvisibleControls` is exported by
 * commands/lib/escape-reason.js, owned this wave by swarm-cp-verbs (which is
 * hardening that same module in parallel). This file only IMPORTS the
 * export; it does not define or duplicate the primitive. If the export is
 * not yet present when this file's own tests run, the import itself fails
 * loud — see this domain's wave-24 output for the coordination note.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { neutralizeInvisibleControls } from '../commands/lib/escape-reason.js';

// Resolve the agent-output schema the SAME way validate-agent-output.js does:
// createRequire on @dogfood-lab/schemas's `./json/*` subpath export (fp-p-006
// consolidation — one source of truth shipped via the dependency, no
// package-local copy to keep in sync). The prompt-builder reads the canonical
// schema so the contract block injected into every dispatched prompt cannot
// drift from the collect-time validator.
const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('@dogfood-lab/schemas/json/agent-output.schema.json');

let _canonicalSchema = null;
function getCanonicalSchema() {
  if (_canonicalSchema) return _canonicalSchema;
  _canonicalSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  return _canonicalSchema;
}

/**
 * Render the audit-output contract block (envelope + finding $def) directly
 * from the canonical schema. The text below the `## Output schema (canonical,
 * derived from agent-output.schema.json)` header is the load-bearing
 * reference; the worked-example JSON in `## Output Format` is illustrative.
 *
 * @returns {string}
 */
function renderAuditOutputContract() {
  const schema = getCanonicalSchema();
  const finding = schema.$defs.finding;
  const severityEnum = finding.properties.severity.enum.join(' | ');
  const categoryEnum = finding.properties.category.enum.join(' | ');
  return `## Output schema (canonical, derived from agent-output.schema.json)

The output JSON envelope below is enforced at write time by the collect-stage
schema gate (validate-agent-output.js). Schema \`$id\`: \`${schema.$id}\`.

Envelope (required keys):
- \`domain\`: string, minLength 1
- \`summary\`: string, minLength 1

Audit envelope adds:
- \`stage\`: one of [${schema.properties.stage.enum.join(', ')}]
- \`findings\`: array of finding objects

Each finding object (required keys: ${finding.required.join(', ')}):
- \`id\`: string, minLength 1
- \`severity\`: one of [${severityEnum}]
- \`category\`: one of [${categoryEnum}]
- \`description\`: string, minLength 1
- \`file\`, \`line\`, \`symbol\`, \`recommendation\`, \`rule_id\` are optional
`;
}

/**
 * Render the amend-output contract block (envelope + fix $def) directly
 * from the canonical schema.
 *
 * @returns {string}
 */
function renderAmendOutputContract() {
  const schema = getCanonicalSchema();
  const fix = schema.$defs.fix;
  const skip = schema.$defs.skip;
  return `## Output schema (canonical, derived from agent-output.schema.json)

The output JSON envelope below is enforced at write time by the collect-stage
schema gate (validate-agent-output.js). Schema \`$id\`: \`${schema.$id}\`.

Envelope (required keys):
- \`domain\`: string, minLength 1
- \`summary\`: string, minLength 1

Amend envelope adds:
- \`fixes\`: array of fix objects
- \`files_changed\`: array of strings (files the agent edited)
- \`skipped\`: array of skip objects (optional)

Each fix object (required keys: ${fix.required.join(', ')}):
- \`finding_id\`: string, minLength 1
- \`description\`: string, minLength 1
- \`file\`: string (optional)

Each skip object (required keys: ${skip.required.join(', ')}):
- \`finding_id\`: string, minLength 1
- \`reason\`: string, minLength 1
`;
}

/**
 * Render the feature-output contract block (envelope + feature $def) directly
 * from the canonical schema.
 *
 * @returns {string}
 */
function renderFeatureOutputContract() {
  const schema = getCanonicalSchema();
  const feature = schema.$defs.feature;
  const priorityEnum = feature.properties.priority.enum.join(' | ');
  const categoryEnum = feature.properties.category.enum.join(' | ');
  const effortEnum = feature.properties.effort.enum.join(' | ');
  return `## Output schema (canonical, derived from agent-output.schema.json)

The output JSON envelope below is enforced at write time by the collect-stage
schema gate (validate-agent-output.js). Schema \`$id\`: \`${schema.$id}\`.

Envelope (required keys):
- \`domain\`: string, minLength 1
- \`summary\`: string, minLength 1

Feature envelope adds:
- \`features\`: array of feature objects

Each feature object (required keys: ${feature.required.join(', ')}):
- \`id\`: string matching pattern \`${feature.properties.id.pattern}\`
- \`priority\`: one of [${priorityEnum}]
- \`category\`: one of [${categoryEnum}]
- \`description\`: string, minLength 1
- \`use_case\`, \`evidence_base\`, \`scope[]\`, \`cross_ref\`, \`recommendation\` optional
- \`effort\`: one of [${effortEnum}] (optional)
`;
}

/**
 * Neutralize CommonMark fence markers inside interpolated prose (F-019d40b2),
 * but ONLY when the text actually carries the fence-parity hazard.
 *
 * Every prompt built here embeds a worked-example ```json ... ``` fence
 * AFTER interpolating agent- or LLM-authored text (prior findings, finding
 * descriptions/recommendations) that this function does not control. A run
 * of 3+ literal backticks is a CommonMark fence marker; an ODD count of them
 * inside the interpolated text flips the fence-toggle parity for the REST of
 * the document — the real ```json opener meant to start the worked example
 * gets consumed as the CLOSER for the wrongly-opened fence instead, so the
 * worked example renders unfenced and the document ends still "inside" an
 * open fence. Proven against two real findings (F-de02ea22, F-1c99c064) whose
 * own description text was about this exact fence-parity class of bug in
 * scripts/check-doc-drift.mjs.
 *
 * An EVEN count of 3+-backtick runs is NOT a hazard — it already self-closes
 * under CommonMark's fence-toggle model, and it is the overwhelmingly common
 * LEGITIMATE shape: a well-formed fenced code example inside a finding's
 * free-form description/recommendation (one opening fence, one closing
 * fence). F-01458fdb: transforming unconditionally — the pre-fix behavior —
 * mangled that legitimate shape into garbled inline `<code>` spans (proven
 * against a real CommonMark+GFM engine), a NEW cost this function introduced
 * that the pre-fix text never had. Checking parity FIRST means only the
 * actual hazard (an ODD count — a stray, unpaired run) pays the
 * transformation cost; a well-formed paired example is left untouched and
 * renders correctly.
 *
 * When the hazard IS present, the fix still interleaves a zero-width space
 * (U+200B) between every backtick in every run of 3+, so no run of 3+
 * CONSECUTIVE backtick characters survives to be mistaken for a fence marker
 * by any CommonMark-conformant reader — while the visible text (a zero-width
 * space renders as nothing) is unchanged for a human or an LLM reading it.
 * Every template builder below that interpolates finding-authored prose
 * ahead of its own worked-example fence must route that text through this
 * function.
 *
 * @param {string} text
 * @returns {string}
 */
function fenceSafe(text) {
  if (!text) return text;
  const runs = text.match(/`{3,}/g);
  if (!runs || runs.length % 2 === 0) return text;
  const zeroWidthSpace = String.fromCharCode(8203);
  return text.replace(/`{3,}/g, (run) => run.split('').join(zeroWidthSpace));
}

/**
 * F-d2d06af3: neutralize the invisible/deception codepoint class in
 * untrusted finding text before it is interpolated into an agent-read
 * PROMPT — see this file's module docstring for the full rationale on why
 * this is `neutralizeInvisibleControls`, not `escapeReasonForDisplay`.
 * Guards falsy input the same way `fenceSafe` does immediately above, so a
 * missing/undefined field passes through unchanged (never crashing on
 * `String(undefined)`, never turning an absent value into the literal
 * 4-character string "undefined").
 *
 * @param {string|undefined|null} text
 * @returns {string|undefined|null}
 */
function neutralizeForPrompt(text) {
  return text ? neutralizeInvisibleControls(text) : text;
}

/**
 * Apply fenceSafe PER FINDING to an already-joined multi-finding blob, rather
 * than once to the whole blob.
 *
 * F-62e467be: fenceSafe's odd/even parity check is trustworthy for ONE
 * contiguous piece of authored prose — a single finding's own description or
 * recommendation, F-01458fdb's contract — because within one author's text a
 * paired (even) backtick-run count really is overwhelmingly likely to be one
 * legitimate opening + closing fence. buildAuditPrompt's only caller
 * (commands/dispatch.js) never hands fenceSafe one finding's text, though: it
 * hands opts.priorContext, ALREADY joined from every prior finding's raw
 * description into one multi-line blob (one bullet line per finding,
 * `- [status] finding_id: description (file)`) before this module ever sees
 * it. Two INDEPENDENT findings can each carry their own odd (hazardous)
 * backtick-run count that happens to SUM to an even total, and a single
 * fenceSafe(wholeBlob) call would then trust the region between them as
 * "closed" — even though a real top-to-bottom CommonMark reader renders
 * every OTHER finding sandwiched between the two stray runs as if it were
 * inside an open code fence. Proven live: two findings with one stray
 * backtick run each (2 runs total, even) left a third, unrelated finding
 * between them rendered inside a fake open fence, while the aggregate parity
 * check saw nothing wrong.
 *
 * This recovers the SAME per-finding unit buildAmendPrompt already uses
 * without this problem — that call site never concatenates findings before
 * calling fenceSafe; each finding's own description/recommendation gets its
 * own separate call (see the findingsList map below). dispatch.js's bullet
 * format is a documented, load-bearing contract (its own comment describes
 * it as "one bullet line per finding"), so a chunk boundary is recovered by
 * splitting on `- [` at the START of a line — the same anchor discipline
 * runner.js#extractTestCount uses to tell a real summary line from indented
 * continuation content. A chunk with its own legitimate, evenly-paired
 * fenced example — which may itself embed newlines, e.g. a multi-line code
 * block inside one finding's description — survives byte-identical, because
 * the chunk boundary keeps that example's own opener+closer pair together in
 * one fenceSafe call, exactly as a lone finding's text always has.
 *
 * Residual (honest, bounded — narrowed by F-f2dc3caf): the boundary is a
 * heuristic anchored on dispatch.js's actual bullet format, not a
 * structural parse — this module has no finding-boundary metadata to parse
 * against once the caller has already joined everything into one string.
 * F-f2dc3caf: the ORIGINAL anchor (`/^- \[/gm`, matching ANY line starting
 * with the two literal characters `- [`) called the over-segmentation risk
 * "vanishingly unlikely," but it was proven reachable by an entirely
 * ordinary shape — a finding's own multi-line description embedding a GFM
 * task-list checklist (`- [ ] step one` / `- [x] step two`) inside an
 * otherwise legitimate, evenly-paired fenced repro-steps example. Every
 * checklist line matched the bare anchor too, over-segmenting ONE finding
 * into three chunks and neutralizing BOTH markers of a well-formed fence
 * that would otherwise have survived (F-01458fdb's own protection).
 *
 * The anchor now requires the FULL real-bullet shape —
 * `- [<2+ word chars>] <colon-terminated token>` — rather than the bare
 * `- [` prefix. CommonMark/GFM task-list syntax is ALWAYS a single
 * space/x/X inside the brackets (never 2+ word characters), so a checklist
 * line can never satisfy the tightened anchor; it is simply never a
 * boundary candidate, and the finding's whole chunk (fence included) is left
 * intact for a single, whole-chunk fenceSafe() parity check — the same
 * treatment any lone finding already receives.
 *
 * A fence-parity-aware scan (walk the text, toggle an "inside a fence" flag
 * on every backtick run, and reject a `- [` candidate found while that flag
 * is set) was considered and rejected: it cannot distinguish a fence that
 * belongs to and re-closes WITHIN the current finding (the checklist case
 * above) from several INDEPENDENT findings whose own individually-odd stray
 * markers merely happen to sum to even ACROSS a finding boundary — exactly
 * the shape F-62e467be's own pin suite (templates-fence-safe-concatenation
 * .test.js) exists to keep splitting correctly. Collapsing that distinction
 * would silently re-merge neighboring findings into a shared fake fence,
 * regressing F-62e467be. Anchoring on the real bullet shape sidesteps the
 * ambiguity: boundaries are still found unconditionally, independent of any
 * fence state, so F-62e467be's per-finding isolation is untouched, and a
 * checklist line is simply never a candidate in the first place.
 *
 * The residual left standing is narrower, not zero: a finding's own
 * description containing a line that happens to match the FULL tightened
 * shape — a 2+-letter bracketed word immediately followed by a
 * colon-terminated token with no space between them, e.g. a quoted example
 * of another finding's own bullet, or a hyphenated-key log-line sample like
 * `- [ERROR] auth-failed: ...` — would still over-segment. That residual is
 * smaller than the one it replaces (it requires mimicking dispatch.js's
 * specific bullet grammar, not just two Markdown characters) and inherits
 * the same strictly conservative failure direction: a legitimate paired
 * fence split across an accidental boundary becomes two odd chunks and BOTH
 * get neutralized (a fenced-code rendering the reader would otherwise have
 * kept is lost), never the reverse (an actual hazard slipping through
 * because a neighbor chunk happened to complete its parity). That asymmetry
 * — safe to over-transform, never safe to under-transform — is the same
 * "bounded, never data loss" shape fingerprint.js's disambiguateFingerprints
 * documents for its own safety-net residual.
 *
 * @param {string} text
 * @returns {string}
 */
function fenceSafeBlock(text) {
  if (!text) return text;
  // F-f2dc3caf: anchored on dispatch.js's ACTUAL bullet shape
  // (`- [status] finding_id: description (file)`, commands/dispatch.js:494)
  // instead of the bare `- \[` prefix — see the residual paragraph above for
  // why a fence-parity-aware scan was considered and rejected in favor of
  // this tightened anchor.
  const starts = [...text.matchAll(/^- \[[a-zA-Z_]{2,}\] \S+:/gm)].map((m) => m.index);
  if (starts.length === 0) return fenceSafe(text);

  const chunks = [];
  if (starts[0] > 0) chunks.push(text.slice(0, starts[0]));
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    chunks.push(text.slice(starts[i], end));
  }
  return chunks.map(fenceSafe).join('');
}

/**
 * Render the CLOSED-priors section — do-not-re-report material. Shared by
 * buildAuditPrompt and buildFeatureAuditPrompt (F-f86e42eb) so the two
 * callers cannot independently drift on this treatment the way
 * lib/fingerprint.js's and commands/collect.js's normalizePath copies did
 * (F-swarmcpcore-008) — one function, every call site.
 *
 * @param {string} [priorContext] — CLOSED prior findings (fixed/deferred/
 *   rejected). Their absence is already terminal in classifyFindings, so
 *   nothing is inferred from an agent's silence about them.
 * @returns {string}
 */
function renderPriorSection(priorContext) {
  // F-d2d06af3: neutralize the invisible/deception codepoint class BEFORE
  // fenceSafeBlock's backtick-fence-parity pass — the two passes operate on
  // disjoint codepoint sets (control/bidi/Tag-block vs. backtick runs), so
  // order does not change either pass's own result, but neutralizing closer
  // to the untrusted source mirrors this package's established
  // escape-then-format discipline (findings-render.js's truncate()).
  return priorContext
    ? `\n## Prior Findings — already CLOSED (do NOT re-report these)\n\n${fenceSafeBlock(neutralizeForPrompt(priorContext))}\n`
    : '';
}

/**
 * Render the OPEN-priors CONFIRM-queue section. Shared by buildAuditPrompt
 * and buildFeatureAuditPrompt (F-f86e42eb) — see renderPriorSection's header
 * for why this is a shared function rather than two independently-typed
 * copies.
 *
 * Open priors carry the OPPOSITE instruction from closed ones, and the
 * difference is load-bearing rather than cosmetic. classifyFindings reads a
 * prior's ABSENCE from a full-coverage wave as positive evidence it was
 * fixed. That inference is sound ONLY if this agent would have re-reported
 * the defect had it still been there. This brief used to emit one flat
 * "do NOT re-report these" list covering every prior — open ones included —
 * which made their absence guaranteed by instruction: the evidence was
 * manufactured by the order forbidding the evidence. On run
 * swarm-1784091637-5127 wave 28, an audit-only wave with no amend before it,
 * 9 untouched findings closed themselves that way. F-bd8b4353 caught the
 * same lie once as a one-off ("a false entry in the swarm's own fix ledger")
 * and it was closed by correcting the affected files, never the mechanism.
 * F-8f44c67f: this heading used to read "in your scope" unconditionally, but
 * dispatch.js builds openPriorContext ONCE per wave from the ENTIRE run's
 * priorMap (no domain/glob filter) and splices the identical text into every
 * domain's prompt — empirically, ~88% of a typical queue sits outside the
 * receiving domain's own globs. "in your scope" was therefore false for most
 * entries most of the time, for every domain simultaneously. Filtering the
 * queue itself is commands/dispatch.js's call (out of this domain's owned
 * globs); this section instead states the true shape — a run-wide queue,
 * narrowed to "your scope" only as an instruction to the agent, not as a
 * pre-filtered fact — so the claim matches what dispatch.js actually does.
 *
 * F-f86e42eb: before this function existed, `buildFeatureAuditPrompt` never
 * rendered this section at all — a feature-audit brief had no 'Known OPEN
 * findings' section and its worked example never mentioned `confirmed`,
 * even though the CONSUMPTION side (collect.js's AUDIT_PHASES array includes
 * 'feature-audit'; classifyFindings/scopeConfirmedToOwningDomain read
 * `agent.confirmed` generically) already treated feature-audit as a
 * first-class audit phase. The mechanism to CLOSE a prior via a
 * feature-audit wave's declaration worked end-to-end; no feature-audit brief
 * ever told the agent the mechanism existed. Sharing this function with
 * buildFeatureAuditPrompt closes that gap at the template level instead of
 * a per-wave coordinator instance patch.
 *
 * @param {string} [openPriorContext] — OPEN prior findings/features. The
 *   agent's confirmation queue, NOT a do-not-report list — classifyFindings
 *   infers `fixed` from a full-coverage wave's silence about these, so the
 *   brief must ask for the re-report that makes that silence meaningful.
 * @returns {string}
 */
function renderOpenPriorSection(openPriorContext) {
  return openPriorContext
    ? `\n## Known OPEN findings across the run — CONFIRM the ones in your scope\n\n`
      + `These are already filed and still open, from EVERY domain in this run, not\n`
      + `just yours. This is **not** a do-not-report list — it is a confirmation queue,\n`
      + `and your report decides the fate of the ones you can actually check:\n\n`
      + `- **Still present?** Report it again, reusing its id from below AND keeping\n`
      + `  its \`file\` exactly as listed there (the id+file pair is what the control\n`
      + `  plane matches on; your description and line may be fresh). That records it\n`
      + `  as recurring, not as a duplicate. This is wanted, not noise.\n`
      + `- **Verified gone?** Put its id in your output's \`confirmed\` array AND omit\n`
      + `  it from \`findings\`. That declaration is what closes it, on your authority.\n`
      + `- **Did not check it, or it names a file outside your domain?** Leave it out of\n`
      + `  \`confirmed\`. It stays open and the next wave re-asks — no penalty, and far\n`
      + `  better than closing a live defect. Note the out-of-domain ones in your\n`
      + `  \`summary\` so the coordinator can see they are waiting on a different agent.\n\n`
      + `\`confirmed\` is a declaration, not a formality: an id you list is one you are\n`
      + `stating you checked. Silence alone no longer closes anything — list only what\n`
      + `you actually verified. Most of this list will name files outside the globs\n`
      + `below; that is expected, not an error — it belongs to whichever domain owns\n`
      + `that file, and your silence about it has no effect on its fate.\n\n`
      + `${fenceSafeBlock(neutralizeForPrompt(openPriorContext))}\n`
    : '';
}

/**
 * Render the T4 roadmap-digest section — cross-run targeting context from a
 * PRIOR run's compiled roadmap (docs/trajectory-and-closure.dispatch.md,
 * T1/T2/T4), injected at the TOP of a generated brief (Lost in the Middle,
 * arXiv:2307.03172, cited directly in the dispatch) rather than sharing
 * priorContext/openPriorContext's lower position.
 *
 * IDENTICAL neutralization treatment to opts.priorContext (F-swarmcpcore-009):
 * a roadmap digest echoes finding `description`/`file_path` text (the
 * attention-score top-K list, the drain-queue summary) via the SAME
 * zero-privilege, potentially-adversarial-repo origin as any other
 * agent-authored text this file already hardened (F-d2d06af3). Routing it
 * through this file's existing fenceSafeBlock(neutralizeForPrompt(...)) seam
 * is what makes it inherit that hardening for free — a caller that instead
 * string-concatenates a digest into a prompt built OUTSIDE this module would
 * reopen the exact injection class F-d2d06af3 closed.
 *
 * Advisory-only per T2's own text, stated in the heading itself: this is
 * targeting CONTEXT — a ranked attention list, unexpired operator notes, a
 * drain-queue summary — never a gate, predictor, or auto-blame signal, and
 * never grounds for skipping independent judgment on any file in scope.
 * Whether to pass a digest AT ALL (the run's explicit opt-in flag, T4) is the
 * CALLER's decision (commands/dispatch.js); this function only renders what
 * it is given.
 *
 * @param {string} [roadmapDigest]
 * @returns {string}
 */
function renderRoadmapDigestSection(roadmapDigest) {
  return roadmapDigest
    ? `\n## Roadmap Digest — cross-run targeting context (advisory only)\n\n`
      + `This is context carried forward from a PRIOR run's compiled roadmap, seeded\n`
      + `into this run by an explicit operator opt-in. It is advisory: a ranked\n`
      + `attention list, unexpired operator notes, and a drain-queue summary — never\n`
      + `a gate, never a predictor, and never grounds for skipping your own\n`
      + `independent judgment on any file in your scope.\n\n`
      + `${fenceSafeBlock(neutralizeForPrompt(roadmapDigest))}\n`
    : '';
}

// Bound the package scan: `repoPath` is an UNTRUSTED external repo, and this
// runs once per agent at dispatch. A directory with tens of thousands of
// entries must not turn prompt rendering into a filesystem walk.
const PY_PACKAGE_SCAN_CAP = 8;

// Directory names that carry an `__init__.py` but are never the import surface
// under test. Only consulted for the flat layout — a `src/` layout is already
// unambiguous.
const PY_NON_PACKAGE_DIRS = new Set(['tests', 'test', 'docs', 'doc', 'site', 'scripts', 'examples']);

/**
 * Probe a repo for a Python import surface: `{ layout, packages }`, or null
 * when this is not a Python project.
 *
 * Deliberately filesystem-only. The import package name is NOT the
 * distribution name — prompt-craft ships as `prompt-crafter` on PyPI and
 * imports as `pcraft` — so reading `[project].name` out of pyproject.toml
 * would name a package the agent cannot import. Directories carrying an
 * `__init__.py` are the actual import surface, so that is what we report.
 *
 * Every fs call is individually guarded: an unreadable or vanished repo
 * degrades to "no Python detected" and simply omits the section, rather than
 * throwing out of prompt rendering and failing the whole dispatch.
 *
 * @param {string} [repoPath]
 * @returns {{layout: 'src'|'flat', packages: string[]}|null}
 */
function detectPythonImportRoots(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') return null;

  const isPython = ['pyproject.toml', 'setup.cfg', 'setup.py'].some((m) => {
    try {
      return existsSync(join(repoPath, m));
    } catch {
      return false;
    }
  });
  if (!isPython) return null;

  const scan = (dir) => {
    const found = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const e of entries) {
      if (found.length >= PY_PACKAGE_SCAN_CAP) break;
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__pycache__') continue;
      try {
        if (existsSync(join(dir, e.name, '__init__.py'))) found.push(e.name);
      } catch {
        // unreadable child — not a package we can name
      }
    }
    return found;
  };

  let hasSrc = false;
  try {
    hasSrc = existsSync(join(repoPath, 'src'));
  } catch {
    hasSrc = false;
  }

  if (hasSrc) {
    const packages = scan(join(repoPath, 'src'));
    if (packages.length > 0) return { layout: 'src', packages };
  }

  const packages = scan(repoPath).filter((p) => !PY_NON_PACKAGE_DIRS.has(p));
  return { layout: 'flat', packages };
}

/**
 * Render the Python half of the containment note. Empty string for a
 * non-Python repo.
 *
 * Measured in run swarm-1787033129-beab wave 2 (prompt-craft): the repo's
 * single shared `.venv` had the package installed EDITABLE against the main
 * checkout, so from inside an --isolate worktree `import pcraft` resolved to
 * `<main>/src/pcraft/__init__.py`. An agent running pytest there collected
 * ITS tests and imported the MAIN checkout's unmodified source — its own
 * fixes invisible to its own test run.
 *
 * The failure is silent and bidirectional, which is why it needs the same
 * loud treatment as the npm sibling: a correct regression test reads as a
 * failed fix, and a green suite proves nothing about the agent's changes.
 * Two of five agents in that wave caught it independently; three did not and
 * had to be corrected mid-run.
 *
 * Unlike the npm case there is no dispatch-time provisioning step to point
 * at — `PYTHONPATH` is the cheapest correct repair and is what the agents
 * who caught it arrived at by hand — so this section prescribes it directly
 * rather than only warning.
 *
 * @param {string} [repoPath]
 * @returns {string}
 */
function renderPythonContainment(repoPath) {
  const py = detectPythonImportRoots(repoPath);
  if (!py) return '';

  const pkg = py.packages[0] || '<import-package>';
  const srcRoot = py.layout === 'src' ? `${repoPath}/src` : repoPath;
  const alsoKnown = py.packages.length > 1
    ? `\n(This repo also exposes ${py.packages.slice(1).join(', ')} — check whichever your tests import.)\n`
    : '';

  return `
### Python: your interpreter probably does NOT see this worktree

A Python repo usually has ONE shared virtualenv with the package installed
editable against the MAIN checkout. If so, \`import ${pkg}\` from inside this
worktree resolves to the main checkout's source — so \`pytest\` here collects
YOUR tests but imports code you did not edit. Your fixes become invisible to
your own test run, in BOTH directions: a correct regression test reads as a
failed fix, and a green suite proves nothing.

Verify before trusting any result:

\`\`\`
python -c "import ${pkg},inspect,os;p=inspect.getsourcefile(${pkg});print(p);print('IN WORKTREE:',os.path.abspath(p).lower().startswith(os.getcwd().lower()))"
\`\`\`
${alsoKnown}
If that prints \`IN WORKTREE: False\`, re-run everything with your own source
first on the path, and re-check the line above before believing the result:

\`\`\`
PYTHONPATH=${srcRoot} python -m pytest -q
\`\`\`

Then re-verify every red-then-green claim you have already made, and say in
your output summary which results were measured under the corrected path. Do
NOT "repair" this with \`pip install\` — reinstalling the editable rewrites
the shared venv that every sibling agent is also using, which is outside
every domain's scope.
`;
}

/**
 * Render the isolated-worktree setup note. Empty string when the agent runs
 * against the shared tree (non---isolate dispatch).
 *
 * Observed in run swarm-1784601601-bd4a (ai-rpg-engine): an isolated agent
 * in an npm-workspaces repo found its worktree's workspace imports silently
 * resolving to the MAIN checkout (nested worktree + no node_modules → walk-up
 * resolution), and "repaired" it with `npm install` — rewriting
 * package-lock.json, an out-of-scope edit. Provisioning now happens at
 * dispatch (lib/workspace-links.js); this section tells the agent that, gives
 * it the one-liner to verify containment, and names the ONE forbidden repair.
 *
 * @param {boolean} [isolatedWorktree]
 * @param {string} [repoPath] — the provisioned worktree path, probed for
 *   language-specific containment hazards (see renderPythonContainment).
 * @returns {string}
 */
function renderWorktreeSection(isolatedWorktree, repoPath) {
  if (!isolatedWorktree) return '';
  return `
## Isolated worktree (provisioned)

The path above is an ISOLATED git worktree, not the main checkout. If this
repo is an npm-workspaces monorepo, its workspace links
(\`node_modules/<name>\` → this worktree's own package dirs) were provisioned
at dispatch, so bare workspace imports resolve to THIS worktree's code.

Before trusting any test run, you may spot-check containment:

\`\`\`
node -e "console.log(require('fs').realpathSync('node_modules/<workspace-pkg-name>'))"
\`\`\`

That path must sit UNDER this worktree. If any workspace package resolves
OUTSIDE the worktree (into the main checkout), STOP trusting test results and
report it in your output summary. Do NOT "repair" resolution with
\`npm install\` / \`npm ci\` — that can rewrite package-lock.json, which is
outside every domain's scope.
${renderPythonContainment(repoPath)}`;
}

/**
 * Render the per-domain ownership block — globs + ownership class + (optional)
 * frozen-snapshot ID. Agents read the SAME ownership facts the collect-time
 * checkOwnership() will enforce against, not a paraphrased coordinator brief.
 *
 * Stage B Item 4: closes the brief-vs-frozen-state asymmetry that triggered
 * the wave-2 ci-tooling revalidate refusal. The coordinator brief continues
 * to be the operator-readable summary, but the prompt itself is now
 * self-sufficient.
 *
 * @param {string[]} globs
 * @param {string} [ownershipClass]
 * @param {string} [domainSnapshotId]
 * @returns {string}
 */
function renderDomainContract(globs, ownershipClass, domainSnapshotId) {
  const lines = [];
  lines.push('## Your domain (canonical, derived from frozen map)');
  lines.push('');
  // F-950fe296: state the TRUE enforcement property. checkOwnership reads the
  // frozen domain MAP (lib/domains.js documents the snapshot as forensic-only;
  // sm-001 tracks threading the snapshot id into enforcement). Claiming
  // "enforces against the snapshot" told every agent a false property.
  lines.push('These globs come from the frozen domain map. If the coordinator');
  lines.push('brief lists different files or scopes, this block wins —');
  lines.push('collect-time `checkOwnership()` enforces against the frozen domain');
  lines.push('map; the snapshot ID below is the audit anchor for this wave.');
  lines.push('');
  if (ownershipClass) {
    lines.push(`Ownership class: \`${ownershipClass}\``);
  }
  if (domainSnapshotId) {
    lines.push(`Domain snapshot ID: \`${domainSnapshotId}\``);
  }
  lines.push('');
  lines.push('Owned globs:');
  lines.push('');
  lines.push('```');
  lines.push(globs.join('\n'));
  lines.push('```');
  return lines.join('\n');
}

/**
 * Maps phase name → audit-output stage letter.
 *
 * Naming convention isn't symmetric across health-audit-{a,b,c} (letter
 * last) and stage-d-{audit,amend} (action last), so an explicit map is
 * clearer than a brittle split/pop derivation. The validator at
 * `output-schema.js` accepts these letters; keep them in sync.
 */
const PHASE_TO_STAGE = {
  'health-audit-a': 'A',
  'health-audit-b': 'B',
  'health-audit-c': 'C',
  'stage-d-audit': 'D',
};

const STAGE_LENS = {
  'health-audit-a': {
    label: 'Bug/Security Fix',
    instruction: `Audit for:
- Bugs and logic errors
- Security vulnerabilities
- Code quality issues
- Type safety violations
- Test coverage gaps
- Documentation accuracy

Focus on defects. Severity triage everything.`,
  },
  'health-audit-b': {
    label: 'Proactive Health',
    instruction: `Audit with a PROACTIVE lens:
- Defensive coding gaps (missing guards, unchecked returns)
- Observability (logging, metrics, health checks)
- Graceful degradation (offline behavior, partial failure handling)
- Future-proofing (extensibility, migration paths)

These are not afterthoughts. They represent the gap between "code that works" and "code that respects the user."`,
  },
  'health-audit-c': {
    label: 'Humanization',
    instruction: `Audit with a USER EXPERIENCE lens:
- Error messages: do they help the user fix the problem?
- Reconnection/retry feedback: does the user know what's happening?
- Responsive layouts: does the UI work at all breakpoints?
- Loading states: is there feedback during async operations?
- State persistence: does the app remember user context across sessions?
- Accessibility of content: keyboard navigation, screen reader support

This is the bridge between "not broken" and "actually good to use."
Stage C addresses BEHAVIORAL polish (text, behavior, accessibility-of-content).
Visual polish (typography, layout, brand) is Stage D.`,
  },
  'stage-d-audit': {
    label: 'Visual Polish',
    instruction: `Audit with a VISUAL UI/UX lens:
- Typography, spacing, layout hierarchy in rendered output
- Iconography & assets (logos, illustrations, command-palette icons)
- Color/theming including dark mode parity, contrast ratios
- Animated demonstrations (GIFs/screenshots for marketplace)
- Command palette presentation (categories, descriptions, icons)
- Status bar integration, first-run welcome, settings UI grouping
- Marketplace listing visuals (hero banner, badges, screenshots)

Frontend domain primary; Bridge + CI/Docs participate. Visual polish is NOT
afterthought — it represents the gap between "respects the user behaviorally"
(Stage C) and "respects the user visually" (Stage D). Triage findings with
the same severity rigor as bug fixes. Polish IS quality.`,
  },
  'feature-audit': {
    label: 'Feature Audit',
    instruction: `Audit for capabilities, not defects:
- Missing capabilities and feature gaps
- Production readiness (error handling, logging, graceful degradation)
- UX improvements (CLI ergonomics, API surface, user-facing messages)
- Performance opportunities
- Integration completeness

Prioritize by impact. Estimate effort (small/medium/large).`,
  },
};

/**
 * Build an audit prompt for a domain agent.
 *
 * @param {object} opts
 * @param {string} opts.repoPath — absolute path to repo
 * @param {string} opts.repo — org/repo name
 * @param {string} opts.domainName — agent's domain
 * @param {string[]} opts.globs — glob patterns for this domain
 * @param {string} opts.phase — wave phase
 * @param {number} opts.waveNumber — current wave number
 * @param {string} [opts.ownershipClass] — domain ownership class (owned/shared/bridge)
 * @param {string} [opts.domainSnapshotId] — frozen domain snapshot id
 * @param {string} [opts.priorContext] — CLOSED prior findings (fixed/deferred/
 *   rejected). Do-not-re-report material: their absence is already terminal in
 *   classifyFindings, so nothing is inferred from an agent's silence about them.
 * @param {string} [opts.openPriorContext] — OPEN prior findings. The agent's
 *   confirmation queue, NOT a do-not-report list — classifyFindings infers
 *   `fixed` from a full-coverage wave's silence about these, so the brief must
 *   ask for the re-report that makes that silence meaningful. Keep the two
 *   lists separate; merging them re-creates the false-fixed defect.
 * @param {string} [opts.roadmapDigest] — T4 cross-run targeting context from a
 *   prior run's compiled roadmap. Advisory only; rendered at the TOP of the
 *   brief. See renderRoadmapDigestSection's header for the full contract.
 * @param {boolean} [opts.isolatedWorktree] — repoPath is a provisioned
 *   --isolate worktree; render the worktree setup note (see
 *   renderWorktreeSection, run swarm-1784601601-bd4a).
 * @returns {string}
 */
export function buildAuditPrompt(opts) {
  const lens = STAGE_LENS[opts.phase];
  if (!lens) throw new Error(`Unknown audit phase: ${opts.phase}`);

  const roadmapSection = renderRoadmapDigestSection(opts.roadmapDigest);
  const priorSection = renderPriorSection(opts.priorContext);
  const openPriorSection = renderOpenPriorSection(opts.openPriorContext);

  const domainContract = renderDomainContract(
    opts.globs,
    opts.ownershipClass,
    opts.domainSnapshotId,
  );
  const worktreeSection = renderWorktreeSection(opts.isolatedWorktree, opts.repoPath);
  const outputContract = renderAuditOutputContract();

  return `# Swarm Audit — ${lens.label}

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}
${roadmapSection}${worktreeSection}
${domainContract}

## Your Scope

You are the **${opts.domainName}** domain agent. You may ONLY read and analyze files matching these patterns:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit any files. This is an audit-only pass.

## Audit Lens

${lens.instruction}
${priorSection}${openPriorSection}
${outputContract}

## Output Format

Respond with ONLY a JSON object (no markdown fences, no commentary). The worked
example below illustrates shape; the canonical contract above is load-bearing.
\`findings[].id\` MUST be a fresh canonical id — F-xxxxxxxx or DOMAIN-B-001 —
never F-001/F-002/F-003:

\`\`\`json
{
  "domain": "${opts.domainName}",
  "stage": "${PHASE_TO_STAGE[opts.phase] || opts.phase.toUpperCase()}",
  "findings": [
    {
      "id": "F-xxxxxxxx",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "<category>",
      "file": "path/to/file",
      "line": 42,
      "symbol": "functionName",
      "description": "What is wrong",
      "recommendation": "How to fix it"
    }
  ],
  "summary": "Brief domain health assessment"
}
\`\`\`

Be thorough. Every finding must have a severity and a concrete recommendation.`;
}

/**
 * Build an amend prompt for a domain agent.
 *
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {string} opts.repo
 * @param {string} opts.domainName
 * @param {string[]} opts.globs
 * @param {string} opts.phase
 * @param {number} opts.waveNumber
 * @param {Array<object>} opts.findings — approved findings filtered for this domain
 * @param {string} [opts.ownershipClass]
 * @param {string} [opts.domainSnapshotId]
 * @param {boolean} [opts.isolatedWorktree] — repoPath is a provisioned
 *   --isolate worktree; render the worktree setup note. The AMEND prompt is
 *   the one that matters most here — amend agents run tests, and the
 *   green-illusion class (run swarm-1784601601-bd4a) is a test-run defect.
 * @returns {string}
 */
export function buildAmendPrompt(opts) {
  // F-d2d06af3: `file_path`/`description`/`recommendation` are audit-agent-
  // authored text describing a (sometimes-adversarial) target repo. Route
  // each through neutralizeForPrompt BEFORE fenceSafe — closing the
  // control-byte/bidi/Tag-block gap fenceSafe was never built to cover,
  // without disturbing its own backtick-fence-parity job. `file_path` had
  // no escaping at all pre-fix; it gets the same treatment here.
  const findingsList = opts.findings
    .map(f => `- [${f.severity}] ${f.finding_id}: ${fenceSafe(neutralizeForPrompt(f.description))} (${neutralizeForPrompt(f.file_path) || 'no file'}:${f.line_number || '?'})${f.recommendation ? '\n  Fix: ' + fenceSafe(neutralizeForPrompt(f.recommendation)) : ''}`)
    .join('\n');

  const domainContract = renderDomainContract(
    opts.globs,
    opts.ownershipClass,
    opts.domainSnapshotId,
  );
  const worktreeSection = renderWorktreeSection(opts.isolatedWorktree, opts.repoPath);
  const outputContract = renderAmendOutputContract();

  return `# Swarm Amend — Fix Approved Findings

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}
${worktreeSection}
${domainContract}

## Your Scope

You are the **${opts.domainName}** domain agent. You may ONLY edit files matching these patterns:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit files outside your domain. If a fix requires cross-domain changes, note it in your output but do NOT make the edit.

## Findings to Fix

${findingsList}

${outputContract}

## Output Format

After making fixes, respond with ONLY a JSON object. The worked example below
illustrates shape; the canonical contract above is load-bearing.
\`finding_id\` MUST be one of the ids under Findings to Fix (never F-001/F-002/F-003):

\`\`\`json
{
  "domain": "${opts.domainName}",
  "fixes": [
    {
      "finding_id": "F-xxxxxxxx",
      "file": "path/to/file",
      "description": "What was changed"
    }
  ],
  "files_changed": ["path/to/file1", "path/to/file2"],
  "skipped": [
    {
      "finding_id": "F-xxxxxxxx",
      "reason": "Requires cross-domain edit in frontend/app.js"
    }
  ],
  "summary": "Brief description of changes made"
}
\`\`\``;
}

/**
 * Build a feature audit prompt for a domain agent.
 *
 * F-f86e42eb: before this fix, this function never accepted or rendered
 * opts.priorContext/opts.openPriorContext at all, even though collect.js's
 * AUDIT_PHASES array already includes 'feature-audit' and
 * classifyFindings/scopeConfirmedToOwningDomain already read `agent.confirmed`
 * generically regardless of whether the agent's output is findings[]- or
 * features[]-shaped. The mechanism to CLOSE a prior finding via a
 * feature-audit wave's `confirmed` declaration worked end-to-end; no
 * feature-audit brief ever told the agent the mechanism existed, or showed
 * it the queue to confirm against. Fixed by routing through the SAME shared
 * renderPriorSection/renderOpenPriorSection functions buildAuditPrompt uses
 * — one rendering, both callers, so the two cannot independently drift the
 * way lib/fingerprint.js's and commands/collect.js's normalizePath copies
 * did (F-swarmcpcore-008).
 *
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {string} opts.repo
 * @param {string} opts.domainName
 * @param {string[]} opts.globs
 * @param {number} opts.waveNumber
 * @param {string} [opts.ownershipClass]
 * @param {string} [opts.domainSnapshotId]
 * @param {string} [opts.priorContext] — CLOSED prior findings/features
 *   (fixed/deferred/rejected). Same do-not-re-report contract as
 *   buildAuditPrompt's identically-named param.
 * @param {string} [opts.openPriorContext] — OPEN prior findings/features —
 *   the CONFIRM queue. Same contract as buildAuditPrompt's identically-named
 *   param; see renderOpenPriorSection's header for the F-f86e42eb history.
 * @param {string} [opts.roadmapDigest] — T4 cross-run targeting context.
 *   Same contract as buildAuditPrompt's identically-named param.
 * @param {boolean} [opts.isolatedWorktree] — repoPath is a provisioned
 *   --isolate worktree; render the worktree setup note. Same contract as
 *   buildAuditPrompt's identically-named param.
 * @returns {string}
 */
export function buildFeatureAuditPrompt(opts) {
  const lens = STAGE_LENS['feature-audit'];

  const roadmapSection = renderRoadmapDigestSection(opts.roadmapDigest);
  const priorSection = renderPriorSection(opts.priorContext);
  const openPriorSection = renderOpenPriorSection(opts.openPriorContext);

  const domainContract = renderDomainContract(
    opts.globs,
    opts.ownershipClass,
    opts.domainSnapshotId,
  );
  const worktreeSection = renderWorktreeSection(opts.isolatedWorktree, opts.repoPath);
  const outputContract = renderFeatureOutputContract();

  return `# Swarm Feature Audit

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}
${roadmapSection}${worktreeSection}
${domainContract}

## Your Scope

You are the **${opts.domainName}** domain agent. Analyze files matching:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit any files. This is an audit-only pass.

## Audit Lens

${lens.instruction}
${priorSection}${openPriorSection}
${outputContract}

## Output Format

Respond with ONLY a JSON object. The worked example below illustrates shape;
the canonical contract above is load-bearing.
\`features[].id\` MUST be a fresh canonical id (F-xxxxxxxx), never
F-001/F-002/F-003; \`confirmed\` entries MUST be ids from the CONFIRM queue
(never F-001/F-002/F-003):

\`\`\`json
{
  "domain": "${opts.domainName}",
  "features": [
    {
      "id": "F-xxxxxxxx",
      "priority": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "missing-feature|ux|performance|integration|production-readiness",
      "description": "What is needed",
      "scope": ["file1.js", "file2.js"],
      "effort": "small|medium|large",
      "recommendation": "How to implement"
    }
  ],
  "confirmed": ["F-xxxxxxxx"],
  "summary": "Domain feature assessment"
}
\`\`\``;
}

export { STAGE_LENS };
