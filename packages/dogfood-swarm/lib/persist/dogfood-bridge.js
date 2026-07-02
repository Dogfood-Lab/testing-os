/**
 * dogfood-bridge.js — Bridge from swarm control plane to dogfood-labs evidence store.
 *
 * Transforms a canonical run export into a dogfood record submission
 * compatible with tools/ingest/run.js and the dogfood-record-submission schema.
 *
 * Each wave becomes a scenario result. Verification steps become CI checks.
 */

import { buildSubmission } from '@dogfood-lab/report/build-submission.js';
import { isOpenFinding } from '../finding-status.js';

/**
 * Build a dogfood submission from a canonical run export.
 *
 * @param {object} exportData — output of buildRunExport()
 * @param {string} overallVerdict — pass/fail/partial/blocked
 * @returns {object} — dogfood record submission
 */
export function buildDogfoodSubmission(exportData, overallVerdict) {
  const run = exportData.run;
  const waves = exportData.waves;

  // Each wave becomes a scenario result
  const scenarioResults = waves.map(w => {
    const agentSteps = w.agents.map(a => ({
      step_id: `agent-${a.domain}`,
      status: a.status === 'complete' ? 'pass' :
              ['invalid_output', 'ownership_violation'].includes(a.status) ? 'fail' :
              ['dispatched', 'running'].includes(a.status) ? 'blocked' : 'fail',
      notes: a.status !== 'complete' ? `Agent status: ${a.status}` : undefined,
    }));

    // Add verification step if present
    if (w.verification) {
      agentSteps.push({
        step_id: 'verification',
        status: w.verification.passed ? 'pass' : 'fail',
        notes: `${w.verification.adapter} adapter, ${w.verification.test_count || 0} tests`,
      });
    }

    // Determine wave verdict
    const allAgentsPass = w.agents.every(a => a.status === 'complete');
    const verifyPass = !w.verification || w.verification.passed;
    const waveVerdict = allAgentsPass && verifyPass ? 'pass' :
                        w.violations.length > 0 ? 'fail' : 'partial';

    // Determine product surface from domain structure
    const hasFrontend = w.agents.some(a => a.domain === 'frontend');
    const surface = hasFrontend ? 'web' : 'cli';

    return {
      scenario_id: `swarm-wave-${w.number}-${w.phase}`,
      scenario_name: `Wave ${w.number}: ${w.phase}`,
      product_surface: surface,
      execution_mode: 'bot',
      verdict: waveVerdict,
      step_results: agentSteps,
      evidence: w.violations.length > 0 ? [{
        kind: 'artifact',
        url: `swarm://${run.id}/wave-${w.number}/violations`,
        description: `${w.violations.length} ownership violation(s)`,
      }] : undefined,
    };
  });

  // Build CI checks from verification receipts
  const ciChecks = exportData.verification.map(v => ({
    id: `verify-wave-${v.wave}`,
    kind: 'test',
    status: v.passed ? 'pass' : 'fail',
    value: v.test_count || 0,
  }));

  // Add finding summary as a check.
  //
  // F-5c562913 (sibling): the severity check counts OPEN findings only —
  // by_severity spans every status, so a CRITICAL that was already fixed
  // (or rejected/deferred) kept failing this check in the durable corpus.
  // Open/closed semantics from lib/finding-status.js, same as the gate.
  const findingSummary = exportData.findings.summary;
  if (findingSummary.total > 0) {
    const openItems = (exportData.findings.items || []).filter(f => isOpenFinding(f.status));
    const openHighOrCritical = openItems.filter(
      f => f.severity === 'CRITICAL' || f.severity === 'HIGH'
    ).length;
    ciChecks.push({
      id: 'findings-severity',
      kind: 'security',
      status: openHighOrCritical > 0 ? 'fail' : 'pass',
      value: findingSummary.total,
    });
  }

  // fp-p-003: the dogfood ingest is duplicate-guarded on
  // (run_id, repo, timing.finished_at) (packages/ingest/run.js). Falling back
  // to `new Date()` for an INCOMPLETE run (run.completed null) made finished_at
  // wall-clock-at-persist, so it shifted on every invocation, the duplicate
  // probe never matched, and each re-persist minted a NEW corpus record (which
  // ingest.yml commits to main). Derive both timestamps from a STABLE run
  // column — run.created is non-null for any persisted run — so the dedup key
  // is deterministic for a given run regardless of completion state, making
  // `swarm persist --ingest` idempotent on re-run even mid-flight.
  const startedAt = run.created || new Date().toISOString();
  const finishedAt = run.completed || run.created || new Date().toISOString();

  return buildSubmission({
    repo: run.repo,
    commitSha: run.commit_sha,
    branch: run.branch,
    workflow: 'swarm-control-plane',
    providerRunId: run.id,
    runUrl: `https://github.com/${run.repo}`,
    startedAt,
    finishedAt,
    scenarioResults,
    ciChecks: ciChecks.length > 0 ? ciChecks : undefined,
    overallVerdict,
    notes: `Swarm run ${run.id}: ${exportData.waves.length} waves, ${findingSummary.total} findings, ${exportData.promotions.length} promotions`,
  });
}
