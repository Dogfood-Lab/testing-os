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

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 * @param {string} [opts.priorContext] — findings from prior waves to avoid re-reporting
 * @returns {string}
 */
export function buildAuditPrompt(opts) {
  const lens = STAGE_LENS[opts.phase];
  if (!lens) throw new Error(`Unknown audit phase: ${opts.phase}`);

  // F-d2d06af3: neutralize the invisible/deception codepoint class BEFORE
  // fenceSafeBlock's backtick-fence-parity pass — the two passes operate on
  // disjoint codepoint sets (control/bidi/Tag-block vs. backtick runs), so
  // order does not change either pass's own result, but neutralizing closer
  // to the untrusted source mirrors this package's established
  // escape-then-format discipline (findings-render.js's truncate()).
  const priorSection = opts.priorContext
    ? `\n## Prior Findings (do NOT re-report these)\n\n${fenceSafeBlock(neutralizeForPrompt(opts.priorContext))}\n`
    : '';

  const domainContract = renderDomainContract(
    opts.globs,
    opts.ownershipClass,
    opts.domainSnapshotId,
  );
  const outputContract = renderAuditOutputContract();

  return `# Swarm Audit — ${lens.label}

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}

${domainContract}

## Your Scope

You are the **${opts.domainName}** domain agent. You may ONLY read and analyze files matching these patterns:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit any files. This is an audit-only pass.

## Audit Lens

${lens.instruction}
${priorSection}
${outputContract}

## Output Format

Respond with ONLY a JSON object (no markdown fences, no commentary). The worked
example below illustrates shape; the canonical contract above is load-bearing:

\`\`\`json
{
  "domain": "${opts.domainName}",
  "stage": "${PHASE_TO_STAGE[opts.phase] || opts.phase.toUpperCase()}",
  "findings": [
    {
      "id": "F-001",
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
  const outputContract = renderAmendOutputContract();

  return `# Swarm Amend — Fix Approved Findings

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}

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
illustrates shape; the canonical contract above is load-bearing:

\`\`\`json
{
  "domain": "${opts.domainName}",
  "fixes": [
    {
      "finding_id": "F-001",
      "file": "path/to/file",
      "description": "What was changed"
    }
  ],
  "files_changed": ["path/to/file1", "path/to/file2"],
  "skipped": [
    {
      "finding_id": "F-003",
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
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {string} opts.repo
 * @param {string} opts.domainName
 * @param {string[]} opts.globs
 * @param {number} opts.waveNumber
 * @param {string} [opts.ownershipClass]
 * @param {string} [opts.domainSnapshotId]
 * @returns {string}
 */
export function buildFeatureAuditPrompt(opts) {
  const lens = STAGE_LENS['feature-audit'];

  const domainContract = renderDomainContract(
    opts.globs,
    opts.ownershipClass,
    opts.domainSnapshotId,
  );
  const outputContract = renderFeatureOutputContract();

  return `# Swarm Feature Audit

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}

${domainContract}

## Your Scope

You are the **${opts.domainName}** domain agent. Analyze files matching:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit any files. This is an audit-only pass.

## Audit Lens

${lens.instruction}

${outputContract}

## Output Format

Respond with ONLY a JSON object. The worked example below illustrates shape;
the canonical contract above is load-bearing:

\`\`\`json
{
  "domain": "${opts.domainName}",
  "features": [
    {
      "id": "F-001",
      "priority": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "missing-feature|ux|performance|integration|production-readiness",
      "description": "What is needed",
      "scope": ["file1.js", "file2.js"],
      "effort": "small|medium|large",
      "recommendation": "How to implement"
    }
  ],
  "summary": "Domain feature assessment"
}
\`\`\``;
}

export { STAGE_LENS };
