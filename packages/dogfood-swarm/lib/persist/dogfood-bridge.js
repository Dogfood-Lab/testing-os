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
    // F-8451abe4: hoisted above the step-synthesis block below so both that
    // block and the wave-verdict computation branch on the SAME condition.
    // Previously the step synthesis guarded on `agentSteps.length === 0`
    // (an easy-to-conflate but DIFFERENT condition — see below) while the
    // verdict already used `noAgentsDispatched`; declaring one flag up front
    // makes it structurally impossible for the two to drift apart again.
    const noAgentsDispatched = w.agents.length === 0;

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

    // A wave with zero dispatched agents leaves step_results without any
    // agent-* step, which both submission gates reject on their own terms —
    // the schema's minItems:1 and verify/validators/steps.js's own "at least
    // one entry" check behind the step-results-present rule. Emit the truth
    // instead: 'blocked' is the step-status enum's term for did-not-run, so
    // this records non-execution rather than fabricating a run.
    //
    // F-8451abe4: this used to guard on `agentSteps.length === 0`, which is a
    // DIFFERENT condition than `noAgentsDispatched` (below, driving
    // waveVerdict) whenever the verification push above already ran — a wave
    // with zero agents but a real verification receipt got a 'blocked'
    // verdict backed ONLY by that receipt's step, e.g. {verdict:'blocked',
    // step_results:[{step_id:'verification', status:'pass', ...}]} — a
    // 'blocked' record with no blocked/fail step anywhere in it, silently
    // falsifying this comment's prior claim that the synthesized step
    // "agrees with the blocked wave verdict below... the two are only ever
    // emitted together" (that claim was simply false whenever a verification
    // receipt coexisted with zero agents). Guard on `noAgentsDispatched`
    // instead, so a 'blocked' verdict ALWAYS carries this step regardless of
    // what an unrelated verification receipt already pushed — dispatching
    // zero agents and holding a verification receipt for the wave are
    // independent facts; one does not explain away the other.
    if (noAgentsDispatched) {
      agentSteps.push({
        step_id: 'dispatch',
        status: 'blocked',
        notes: w.verification
          ? `wave ${w.number} (${w.phase}) dispatched zero agents — the verification receipt exists but does not substitute for agent dispatch evidence`
          : `wave ${w.number} (${w.phase}) dispatched zero agents and recorded no verification receipt`,
      });
    }

    // Determine wave verdict.
    //
    // F-1f8fd647: `w.agents.every(...)` is vacuously TRUE on an empty array,
    // so a wave that dispatched ZERO agents (the already-established
    // all-domains-'shared' 0-agent dispatch shape — buildRunExport's
    // `agents: agents.map(...)` in export.js carries an empty array straight
    // through with no guard) fell through to allAgentsPass:true and reported
    // a clean 'pass' scenario_result with an empty step_results array —
    // success claimed with literally zero evidence behind it. Guard the
    // empty case explicitly, before the vacuous-truth `.every()` ever runs:
    // zero agents is never a pass on its own terms, regardless of what
    // `.every()` returns for it. 'blocked' (paired with `blocking_reason`
    // below) is the schema's own vocabulary for "could not verify", and is
    // more honest here than 'partial', which implies some evidence exists.
    const allAgentsPass = !noAgentsDispatched && w.agents.every(a => a.status === 'complete');
    const verifyPass = !w.verification || w.verification.passed;
    const waveVerdict = noAgentsDispatched ? 'blocked' :
                        allAgentsPass && verifyPass ? 'pass' :
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
      // dogfood-record-submission.schema.json documents blocking_reason as
      // "Required when verdict is blocked" and packages/verify/validators/
      // policy.js enforces that pairing — set it here so the artifact is
      // never a 'blocked' verdict with a silently-missing reason.
      //
      // F-8451abe4: "no evidence to verify" was always true when
      // w.verification was absent, but false — and self-contradictory next to
      // a passing verification step_result — whenever a verification receipt
      // existed for a zero-agent wave. Match the wording to the dispatch
      // step's own notes above so the reason and the evidence never disagree.
      ...(noAgentsDispatched ? {
        blocking_reason: w.verification
          ? `wave ${w.number} (${w.phase}) dispatched zero agents — a verification receipt exists but is not agent dispatch evidence`
          : `wave ${w.number} (${w.phase}) dispatched zero agents — no evidence to verify`,
      } : {}),
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
  // ingest.yml commits to main). Derive both timestamps from STABLE DB truth
  // so the dedup key is deterministic for a given run state, making
  // `swarm persist --ingest` idempotent on re-run even mid-flight.
  //
  // Observed in run swarm-1784601601-bd4a (ai-rpg-engine): the direct
  // completed→created fallback made an open run report
  // started_at == finished_at and duration_ms 0 against ~52 minutes of
  // recorded wave activity. run.last_terminal_event_at (buildRunExport) is
  // the latest completion/receipt/promotion timestamp in the DB — honest,
  // and still DB-derived rather than the export wall clock, so fp-p-003's
  // stability survives: re-persisting the SAME DB state reuses the same
  // finished_at (new activity legitimately moves it). run.created remains
  // the last-resort fallback for a run with zero terminal events.
  const startedAt = run.created || new Date().toISOString();
  const finishedAt = run.completed || run.last_terminal_event_at || run.created || new Date().toISOString();

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
