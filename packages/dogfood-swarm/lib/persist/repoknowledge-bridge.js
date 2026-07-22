/**
 * repoknowledge-bridge.js — Bridge from swarm control plane to repo-knowledge audit DB.
 *
 * Transforms a canonical run export into the repo-knowledge audit import format:
 *   run.json    — run metadata envelope
 *   findings.json — normalized findings
 *   metrics.json  — severity counts and coverage
 *
 * Compatible with `rk audit import <dir>` and `audit_submit` MCP tool.
 */

import { isOpenFinding } from '../finding-status.js';

/**
 * The fixed repo-knowledge audit-domain enum, mirrored here as the contract the
 * audit payload must honour. These two repos share NO code dependency, so this
 * is a hand-maintained mirror of repo-knowledge's `DOMAINS`
 * (src/audit/controls.ts — also the CHECK enum in migration-002-audit.sql and
 * AUDIT-CONTRACT.md's "Domains (fixed enum)"). `rk audit import` REJECTS any
 * finding whose domain is outside this set, and the reject fails the ENTIRE
 * atomic import — one bad domain drops the whole evidence bundle. If rk ever
 * extends its enum, update this list too. lib/repoknowledge-bridge-domain-map
 * .test.js keeps its own independent copy and pins that the two agree.
 */
export const RK_AUDIT_DOMAINS = Object.freeze([
  'inventory', 'code_quality', 'security_sast', 'dependencies_sca',
  'licenses', 'secrets', 'config_iac', 'containers', 'runtime',
  'performance', 'observability', 'testing', 'cicd', 'deployment',
  'backup_dr', 'monitoring', 'compliance_privacy', 'supply_chain',
  'integrations',
]);

/**
 * Map a swarm finding category to a repo-knowledge audit domain. Every value on
 * the right MUST be a member of RK_AUDIT_DOMAINS above.
 *
 * `docs` → `inventory`: rk has no `documentation` domain (emitting one caused
 * the ai-rpg-engine v2.8 `rk audit import` failure, 2026-07-22). `inventory`
 * is rk's documentation-artifact domain — its controls are README currency,
 * manifest/entrypoint identification, and ownership docs (INV-001 is literally
 * "README present and materially current"). Mapping there keeps docs findings
 * queryable as a DISTINCT domain rather than collapsing them into the
 * `code_quality` fallback that already absorbs seven other categories.
 *
 * An unmapped category falls back to `code_quality` (see the `||` at the call
 * site) — the neutral general bucket, also a valid rk domain.
 */
export const CATEGORY_TO_AUDIT_DOMAIN = Object.freeze({
  bug: 'code_quality',
  security: 'security_sast',
  quality: 'code_quality',
  types: 'code_quality',
  tests: 'testing',
  docs: 'inventory',
  defensive: 'code_quality',
  observability: 'monitoring',
  degradation: 'code_quality',
  ux: 'code_quality',
  accessibility: 'code_quality',
});

/**
 * Build a repo-knowledge audit payload from a canonical run export.
 *
 * @param {object} exportData — output of buildRunExport()
 * @returns {{ run: object, findings: object[], metrics: object }}
 */
export function buildAuditPayload(exportData) {
  const run = exportData.run;
  const findingSummary = exportData.findings.summary;
  const findingItems = exportData.findings.items;

  // Map swarm finding status to audit status
  const statusMap = {
    new: 'open',
    recurring: 'open',
    approved: 'open',
    fixed: 'fixed',
    deferred: 'accepted_risk',
    rejected: 'false_positive',
  };

  // Build audit findings. Category → domain via CATEGORY_TO_AUDIT_DOMAIN
  // (module scope); an unmapped category falls back to the neutral
  // `code_quality` bucket. Both are guaranteed rk-valid — see RK_AUDIT_DOMAINS.
  const auditFindings = findingItems.map(f => ({
    domain: CATEGORY_TO_AUDIT_DOMAIN[f.category] || 'code_quality',
    title: `[${f.severity}] ${f.description.slice(0, 80)}`,
    description: f.description,
    severity: f.severity.toLowerCase(),
    confidence: 'high',
    status: statusMap[f.status] || 'open',
    location: f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : undefined,
    tool_source: 'swarm-control-plane',
    remediation: f.recommendation || undefined,
  }));

  // Compute domains checked from findings + verification
  const domainsChecked = new Set();
  for (const f of auditFindings) domainsChecked.add(f.domain);
  if (exportData.verification.length > 0) {
    domainsChecked.add('testing');
    domainsChecked.add('cicd');
  }

  // Determine overall status — from OPEN findings only (V2-CONTRACT-001, the
  // third F-5c562913 consumer). by_severity spans every lifecycle status, so a
  // CRITICAL that was already fixed (or rejected/deferred) kept exporting
  // overall_status:'fail' + blocking_release:true into the audit DB after the
  // amend loop had closed it — and the hand-rolled by_status sum missed
  // 'unverified' (open, per the gate). Open/closed semantics come from
  // lib/finding-status.js, the same source the advancement gate,
  // computeRunVerdict (export.js), and the dogfood-bridge severity check use.
  const openItems = findingItems.filter(f => isOpenFinding(f.status));
  const openBySeverity = {};
  for (const f of openItems) {
    openBySeverity[f.severity] = (openBySeverity[f.severity] || 0) + 1;
  }
  const criticalCount = openBySeverity.CRITICAL || 0;
  const highCount = openBySeverity.HIGH || 0;
  const openFindings = openItems.length;

  // F-6859e492: this function has never special-cased run.status (see the
  // F-5c562913 comment above) — it fell straight through to the open-findings
  // computation regardless of whether the run actually completed. For
  // run.status:'aborted' that meant reporting overall_status:'pass' /
  // blocking_release:false whenever zero findings happened to be open (or all
  // were closed), while the sibling computeRunVerdict (export.js) has always
  // returned an unconditional 'fail' for 'aborted' — the exact "two
  // artifacts, one call, opposite verdicts" shape F-b721038e fixed for
  // 'complete', just relocated to the status value that fix's own comment
  // carved out as already safe. Mirror computeRunVerdict's conservative
  // reading here instead of loosening it there: a run that never completed
  // is not a safe 'pass' in either artifact, no matter what findings happen
  // to be open — "no open findings" on an aborted run means "we stopped
  // looking," not "nothing left to find." Keep this branch ahead of the
  // open-findings computation so no aborted run can fall through to 'pass'
  // or 'pass_with_findings'. See export-verdict-aborted-sibling-agreement
  // .test.js for the 4-state × both-artifacts pin.
  const runAborted = run.status === 'aborted';

  let overallStatus, overallPosture;
  if (runAborted) {
    overallStatus = 'fail';
    overallPosture = 'critical';
  } else if (criticalCount > 0) {
    overallStatus = 'fail';
    overallPosture = 'critical';
  } else if (openFindings > 0) {
    overallStatus = 'pass_with_findings';
    overallPosture = highCount > 0 ? 'needs_attention' : 'healthy';
  } else {
    overallStatus = 'pass';
    overallPosture = 'healthy';
  }

  // Get test count from verification
  const testCount = exportData.verification.reduce((sum, v) => sum + (v.test_count || 0), 0);

  // F-be8db3ee: the aborted branch above forces overall_status/overall_posture/
  // blocking_release to the release-blocking reading regardless of what was
  // actually open when the run stopped — but the summary sentence used to
  // report ONLY the raw counts ("N findings (X open critical, Y open high)"),
  // with nothing distinguishing "we found a critical" from "we stopped
  // looking". For an aborted run with zero (or non-critical) open findings,
  // that summary flatly contradicted overall_posture:'critical' sitting
  // right next to it. Naming the abort explicitly here — instead of silently
  // forcing counts that don't match reality — keeps the counts honest while
  // making the REASON for the critical posture legible from the sentence
  // alone.
  const summary = runAborted
    ? `Swarm audit: RUN ABORTED before completion (${findingSummary.total} findings observed, ` +
      `${criticalCount} open critical, ${highCount} open high, at time of abort). ` +
      `${exportData.waves.length} waves, ${exportData.promotions.length} promotions.`
    : `Swarm audit: ${findingSummary.total} findings (${criticalCount} open critical, ${highCount} open high). ` +
      `${exportData.waves.length} waves, ${exportData.promotions.length} promotions.`;

  const auditRun = {
    slug: run.repo,
    commit_sha: run.commit_sha,
    branch: run.branch,
    auditor: 'swarm-control-plane',
    scope_level: 'full',
    overall_status: overallStatus,
    overall_posture: overallPosture,
    domains_checked: [...domainsChecked].sort(),
    summary,
    // F-6859e492: blocking_release must agree with overallStatus above — an
    // aborted run blocks release the same way an open CRITICAL does.
    blocking_release: runAborted || criticalCount > 0,
    started_at: run.created,
    completed_at: run.completed,
  };

  // Severity metrics mirror the open-only gate semantics above. The full
  // per-status truth is still exported: every item in `findings` carries its
  // lifecycle status, and run.summary reports the historical total.
  //
  // F-be8db3ee: critical_count/high_count stay the HONEST open-finding
  // counts even when runAborted forced overall_posture to 'critical' above —
  // this file is written to metrics.json, a SEPARATE artifact from run.json
  // (see commands/persist.js), so a consumer reading metrics.json alone has
  // no access to overall_posture or the summary sentence at all. run_aborted
  // is the signal that lets metrics.json explain itself in isolation: a
  // reader who sees critical_count:0 next to run_aborted:true knows the
  // release is blocked because the sweep never finished, not because a
  // phantom critical was fabricated into the count. Always present
  // (true/false, never omitted) so the field's absence never has to be
  // interpreted as "false".
  const metrics = {
    critical_count: criticalCount,
    high_count: highCount,
    medium_count: openBySeverity.MEDIUM || 0,
    low_count: openBySeverity.LOW || 0,
    info_count: 0,
    test_count: testCount,
    controls_passed: exportData.waves.filter(w => w.status === 'advanced' || w.status === 'verified').length,
    controls_failed: exportData.waves.filter(w => w.status === 'failed').length,
    controls_total: exportData.waves.length,
    run_aborted: runAborted,
  };

  return { run: auditRun, findings: auditFindings, metrics };
}

/**
 * F-09c4777a: buildAuditPayload's aborted branch (see the F-be8db3ee comment
 * above) keeps overall_posture inside the fixed
 * ['healthy','needs_attention','critical'] enum persist.test.js (package
 * root, out of this domain) already hard-pins, and the downstream
 * repo-knowledge consumer's own schema expects the same enum — so the abort
 * signal cannot be smuggled into that field's VALUE (a fourth value was
 * considered and rejected by the wave-18 fix for exactly this reason).
 *
 * The one production consumer that reads overall_status/overall_posture in
 * ISOLATION — `swarm persist`'s terminal output (commands/persist.js,
 * outside this domain's owned glob) — was traced end-to-end and found to
 * hand-format `${status} (${posture})` directly from this payload, with no
 * access to metrics.run_aborted or run.summary. For an aborted run with zero
 * open findings that renders a bare "fail (critical)" with nothing telling
 * the operator a phantom critical did NOT trigger the block.
 *
 * This helper is the lib-owned fix for that gap: it folds metrics.run_aborted
 * into the rendered TEXT (never the enum value), so any renderer that calls
 * it — instead of hand-formatting the status/posture pair itself — gets the
 * abort qualifier for free and cannot regress it by forgetting to separately
 * check run_aborted. Wiring commands/persist.js (report.repoKnowledge +
 * formatPersist()) to call this is a cross-domain change outside this wave's
 * owned glob; see this wave's skipped[] entry for F-09c4777a.
 *
 * @param {{ run: { overall_status: string, overall_posture: string }, metrics: { run_aborted: boolean } }} auditPayload — the return of buildAuditPayload()
 * @returns {string} e.g. "pass (healthy)" or "fail (critical) — run aborted before completion"
 */
export function formatAuditStatusLine(auditPayload) {
  const { run, metrics } = auditPayload;
  const base = `${run.overall_status} (${run.overall_posture})`;
  return metrics.run_aborted ? `${base} — run aborted before completion` : base;
}
