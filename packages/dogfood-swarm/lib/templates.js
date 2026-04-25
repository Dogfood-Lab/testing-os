/**
 * templates.js — Agent prompt generation from domain map + phase.
 *
 * Generates ready-to-use prompts for each domain agent in a wave.
 * Templates embed: repo path, domain scope, file list, phase lens, output format.
 */

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
 * @param {string} [opts.priorContext] — findings from prior waves to avoid re-reporting
 * @returns {string}
 */
export function buildAuditPrompt(opts) {
  const lens = STAGE_LENS[opts.phase];
  if (!lens) throw new Error(`Unknown audit phase: ${opts.phase}`);

  const priorSection = opts.priorContext
    ? `\n## Prior Findings (do NOT re-report these)\n\n${opts.priorContext}\n`
    : '';

  return `# Swarm Audit — ${lens.label}

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}

## Your Scope

You are the **${opts.domainName}** domain agent. You may ONLY read and analyze files matching these patterns:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit any files. This is an audit-only pass.

## Audit Lens

${lens.instruction}
${priorSection}
## Output Format

Respond with ONLY a JSON object (no markdown fences, no commentary):

\`\`\`json
{
  "domain": "${opts.domainName}",
  "stage": "${opts.phase.split('-').pop().toUpperCase()}",
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
 */
export function buildAmendPrompt(opts) {
  const findingsList = opts.findings
    .map(f => `- [${f.severity}] ${f.finding_id}: ${f.description} (${f.file_path || 'no file'}:${f.line_number || '?'})${f.recommendation ? '\n  Fix: ' + f.recommendation : ''}`)
    .join('\n');

  return `# Swarm Amend — Fix Approved Findings

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}

## Your Scope

You are the **${opts.domainName}** domain agent. You may ONLY edit files matching these patterns:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit files outside your domain. If a fix requires cross-domain changes, note it in your output but do NOT make the edit.

## Findings to Fix

${findingsList}

## Output Format

After making fixes, respond with ONLY a JSON object:

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
 */
export function buildFeatureAuditPrompt(opts) {
  const lens = STAGE_LENS['feature-audit'];

  return `# Swarm Feature Audit

**Repo:** ${opts.repo}
**Path:** ${opts.repoPath}
**Domain:** ${opts.domainName}
**Wave:** ${opts.waveNumber}

## Your Scope

You are the **${opts.domainName}** domain agent. Analyze files matching:

\`\`\`
${opts.globs.join('\n')}
\`\`\`

**HARD RULE:** Do not edit any files. This is an audit-only pass.

## Audit Lens

${lens.instruction}

## Output Format

Respond with ONLY a JSON object:

\`\`\`json
{
  "domain": "${opts.domainName}",
  "features": [
    {
      "id": "FT-001",
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
