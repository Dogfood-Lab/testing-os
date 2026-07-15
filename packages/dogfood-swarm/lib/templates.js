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
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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

  const priorSection = opts.priorContext
    ? `\n## Prior Findings (do NOT re-report these)\n\n${opts.priorContext}\n`
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
  const findingsList = opts.findings
    .map(f => `- [${f.severity}] ${f.finding_id}: ${f.description} (${f.file_path || 'no file'}:${f.line_number || '?'})${f.recommendation ? '\n  Fix: ' + f.recommendation : ''}`)
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
