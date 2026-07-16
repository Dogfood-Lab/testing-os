/**
 * export-verdict-aborted-sibling-agreement.test.js — F-6859e492:
 * the wave-14 F-b721038e fix corrected computeRunVerdict's (lib/persist/
 * export.js) 'complete' short-circuit but deliberately left the adjacent
 * 'aborted' short-circuit unchanged — the fix's own comment called
 * 'aborted' "the safe/conservative direction... not subject to the same
 * fix." That reasoning did not survive the SAME cross-artifact-agreement
 * test the fix was written to satisfy: buildAuditPayload
 * (lib/persist/repoknowledge-bridge.js) has never special-cased run.status,
 * so for 'aborted' it fell straight through to the open-findings
 * computation 'complete' used pre-fix — reporting overall_status:'pass' /
 * blocking_release:false whenever an aborted run happened to have zero open
 * findings (or all findings closed), while computeRunVerdict kept returning
 * an unconditional 'fail'. Same "two artifacts, one call, opposite
 * verdicts" shape as F-b721038e, relocated to the one status value that
 * fix's own carve-out declined to touch.
 *
 * THE FIX. computeRunVerdict's 'aborted' branch is UNCHANGED (still an
 * unconditional 'fail' — the conservative reading this file's sibling test,
 * export-verdict-complete-open-findings.test.js, already pins for the
 * zero-findings case). buildAuditPayload gained the matching special case:
 * run.status === 'aborted' now forces overall_status:'fail' /
 * overall_posture:'critical' / blocking_release:true ahead of the
 * open-findings computation, so an aborted run can never fall through to
 * 'pass' or 'pass_with_findings' in either artifact.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) for the same reason
 * as export-verdict-complete-open-findings.test.js in this same directory —
 * the swarm-cp-core wave-16 domain owns `packages/dogfood-swarm/lib/**`
 * only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeRunVerdict } from './persist/export.js';
import { buildDogfoodSubmission } from './persist/dogfood-bridge.js';
import { buildAuditPayload } from './persist/repoknowledge-bridge.js';

const COMMIT_SHA = 'd'.repeat(40);

/** A minimal, schema-shaped canonical export literal (mirrors buildRunExport's envelope). */
function makeExport({ status, items }) {
  return {
    run: {
      id: 'run-verdict-aborted', repo: 'dogfood-lab/testing-os', branch: 'main',
      commit_sha: COMMIT_SHA, status, created: '2026-07-01T00:00:00Z',
      completed: null,
    },
    waves: [{
      number: 1, phase: 'treatment', status: 'failed',
      agents: [{ domain: 'core', status: 'complete' }],
      verification: { passed: true, adapter: 'node', test_count: 10 },
      violations: [],
    }],
    verification: [{ wave: 1, phase: 'treatment', passed: true, test_count: 10 }],
    findings: { summary: { total: items.length }, items },
    promotions: [],
  };
}

/** Runs BOTH sibling artifacts through the SAME exportData, mirroring one `swarm persist` call. */
function buildBothArtifacts(exp) {
  const verdict = computeRunVerdict(exp);
  const submission = buildDogfoodSubmission(exp, verdict);
  const audit = buildAuditPayload(exp);
  return { verdict, submission, audit };
}

describe('F-6859e492 — computeRunVerdict and buildAuditPayload agree on aborted runs across the finding-state matrix', () => {
  it('aborted + zero open findings: both artifacts report fail/blocking, neither reports a healthy pass', () => {
    const exp = makeExport({ status: 'aborted', items: [] });
    const { verdict, submission, audit } = buildBothArtifacts(exp);

    // Pre-fix: computeRunVerdict='fail' vs buildAuditPayload.overall_status='pass',
    // blocking_release=false, overall_posture='healthy' — the exact "self-reported
    // pass for a run that never completed" shape README.md disclaims trust in.
    assert.equal(verdict, 'fail');
    assert.equal(submission.overall_verdict, 'fail');
    assert.equal(audit.run.overall_status, 'fail');
    assert.equal(audit.run.overall_posture, 'critical');
    assert.equal(audit.run.blocking_release, true);
  });

  it('aborted + one open HIGH (no critical): both artifacts still agree, not pass_with_findings vs fail', () => {
    const exp = makeExport({
      status: 'aborted',
      items: [{ id: 'F-201', severity: 'HIGH', status: 'new', description: 'Unvalidated redirect' }],
    });
    const { verdict, submission, audit } = buildBothArtifacts(exp);

    // Pre-fix: 'fail' vs 'pass_with_findings'/blocking_release:false.
    assert.equal(verdict, 'fail');
    assert.equal(submission.overall_verdict, 'fail');
    assert.equal(audit.run.overall_status, 'fail');
    assert.equal(audit.run.blocking_release, true);
  });

  it('aborted + all findings closed: both artifacts still agree, not pass vs fail', () => {
    const exp = makeExport({
      status: 'aborted',
      items: [
        { id: 'F-202', severity: 'CRITICAL', status: 'fixed', description: 'Auth bypass' },
        { id: 'F-203', severity: 'LOW', status: 'deferred', description: 'Style nit' },
      ],
    });
    const { verdict, submission, audit } = buildBothArtifacts(exp);

    // Pre-fix: 'fail' vs 'pass'/blocking_release:false/overall_posture:'healthy' —
    // every finding closed is exactly the case an aborted run's incompleteness is
    // easiest to mistake for a clean bill of health.
    assert.equal(verdict, 'fail');
    assert.equal(submission.overall_verdict, 'fail');
    assert.equal(audit.run.overall_status, 'fail');
    assert.equal(audit.run.overall_posture, 'critical');
    assert.equal(audit.run.blocking_release, true);
  });

  it('aborted + an open CRITICAL: both artifacts agree (this was the ONE state that already agreed pre-fix)', () => {
    const exp = makeExport({
      status: 'aborted',
      items: [{ id: 'F-204', severity: 'CRITICAL', status: 'new', description: 'Unsigned token accepted' }],
    });
    const { verdict, submission, audit } = buildBothArtifacts(exp);

    assert.equal(verdict, 'fail');
    assert.equal(submission.overall_verdict, 'fail');
    assert.equal(audit.run.overall_status, 'fail');
    assert.equal(audit.run.blocking_release, true);
  });

  it('regression guard: a COMPLETE run with zero findings is still a genuine pass in both artifacts (aborted fix must not leak into complete)', () => {
    const exp = makeExport({ status: 'complete', items: [] });
    exp.run.completed = '2026-07-01T01:00:00Z';
    const { verdict, submission, audit } = buildBothArtifacts(exp);

    assert.equal(verdict, 'pass');
    assert.equal(submission.overall_verdict, 'pass');
    assert.equal(audit.run.overall_status, 'pass');
    assert.equal(audit.run.blocking_release, false);
  });
});
