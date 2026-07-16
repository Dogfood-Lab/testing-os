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
 * THE FIX (wave 16). computeRunVerdict's 'aborted' branch is UNCHANGED
 * (still an unconditional 'fail' — the conservative reading this file's
 * sibling test, export-verdict-complete-open-findings.test.js, already pins
 * for the zero-findings case). buildAuditPayload gained the matching
 * special case: run.status === 'aborted' now forces overall_status:'fail' /
 * overall_posture:'critical' / blocking_release:true ahead of the
 * open-findings computation, so an aborted run can never fall through to
 * 'pass' or 'pass_with_findings' in either artifact.
 *
 * F-be8db3ee (wave 18): the wave-16 fix above only touched THREE fields
 * (overall_status/overall_posture/blocking_release). metrics.critical_count/
 * high_count (computed from the SAME criticalCount/highCount locals BEFORE
 * the aborted branch runs) and the human-readable run.summary sentence were
 * left untouched — so an aborted run with zero (or non-critical) open
 * findings produced a payload that was internally self-contradictory within
 * its OWN return value: overall_posture:'critical' sitting next to
 * metrics.critical_count:0 and a summary sentence that also says "0 open
 * critical, 0 open high", with no field anywhere explaining why a
 * zero-finding run is labelled 'critical'. Worse, run.json and metrics.json
 * are written as SEPARATE files by `swarm persist` (commands/persist.js) —
 * a consumer reading metrics.json alone has no access to run.overall_posture
 * or run.summary at all, so the contradiction isn't even resolvable by
 * reading the "other" field.
 *
 * THE FIX (wave 18). Chose option (a) from the finding's own remediation
 * text over introducing a new overall_posture enum value: persist.test.js
 * (package root, out of this domain's glob) already hard-asserts
 * `overall_posture` is one of exactly ['healthy','needs_attention',
 * 'critical'] — a fourth value risks breaking that assertion AND the
 * downstream repo-knowledge consumer's own enum, neither of which this
 * domain can safely verify or edit. Instead: metrics gained an explicit
 * `run_aborted` boolean (always present, true/false) so metrics.json read
 * in ISOLATION carries its own honest signal, and run.summary now says
 * "RUN ABORTED before completion" for aborted runs instead of silently
 * reporting bare counts as if the sweep had finished. critical_count/
 * high_count stay HONEST (the real, possibly-zero open count) — the
 * `run_aborted` flag is what explains why a zero-count run still blocks
 * release, rather than the counts themselves being altered to manufacture
 * agreement.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) for the same reason
 * as export-verdict-complete-open-findings.test.js in this same directory —
 * the swarm-cp-core domain owns `packages/dogfood-swarm/lib/**` only.
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

    // F-be8db3ee: pre-fix, metrics/summary disagreed with the forced posture
    // above IN THE SAME RETURN VALUE — critical_count:0, high_count:0, and a
    // summary sentence reading "0 findings (0 open critical, 0 open high)"
    // sitting next to overall_posture:'critical' with no field explaining why.
    // The counts stay honest (this run genuinely has zero open findings) —
    // metrics.run_aborted is the explicit signal that resolves the
    // contradiction, and it must be readable from metrics.json ALONE (a
    // separate file from run.json per commands/persist.js).
    assert.equal(audit.metrics.critical_count, 0);
    assert.equal(audit.metrics.high_count, 0);
    assert.equal(audit.metrics.run_aborted, true,
      'metrics.json read in isolation must still be able to tell this run never completed');
    assert.match(audit.run.summary, /aborted/i,
      'summary must say the run was aborted, not just report bare (honest but misleading-alone) counts');
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
    assert.equal(audit.run.overall_posture, 'critical');
    assert.equal(audit.run.blocking_release, true);

    // F-be8db3ee: the real open HIGH count stays honest and visible — the
    // aborted override forces 'critical'/fail regardless of severity, but
    // must not hide or overwrite what was actually found before the run
    // stopped.
    assert.equal(audit.metrics.critical_count, 0);
    assert.equal(audit.metrics.high_count, 1);
    assert.equal(audit.metrics.run_aborted, true);
    assert.match(audit.run.summary, /aborted/i);
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

    // F-be8db3ee: both findings are CLOSED (fixed/deferred), so the open
    // counts are genuinely zero — the case where "0 open critical, 0 open
    // high" is easiest to misread as a clean sweep instead of an incomplete
    // one. run_aborted is what tells metrics.json apart from a real pass.
    assert.equal(audit.metrics.critical_count, 0);
    assert.equal(audit.metrics.high_count, 0);
    assert.equal(audit.metrics.run_aborted, true);
    assert.match(audit.run.summary, /aborted/i);
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
    assert.equal(audit.run.overall_posture, 'critical');
    assert.equal(audit.run.blocking_release, true);

    // F-be8db3ee: this is the one state where posture was ALREADY 'critical'
    // pre-fix (a real open CRITICAL earns it independent of the aborted
    // override) — metrics must still show the honest count AND run_aborted,
    // since both are true here and neither should suppress the other.
    assert.equal(audit.metrics.critical_count, 1);
    assert.equal(audit.metrics.run_aborted, true);
    assert.match(audit.run.summary, /aborted/i);
  });

  it('regression guard: a COMPLETE run with zero findings is still a genuine pass in both artifacts (aborted fix must not leak into complete)', () => {
    const exp = makeExport({ status: 'complete', items: [] });
    exp.run.completed = '2026-07-01T01:00:00Z';
    const { verdict, submission, audit } = buildBothArtifacts(exp);

    assert.equal(verdict, 'pass');
    assert.equal(submission.overall_verdict, 'pass');
    assert.equal(audit.run.overall_status, 'pass');
    assert.equal(audit.run.blocking_release, false);

    // F-be8db3ee: the new run_aborted signal and "aborted" summary wording
    // are specific to the aborted branch — they must not leak into a
    // genuine complete-run pass. run_aborted is explicitly false (not just
    // falsy/undefined), so a metrics.json consumer can rely on the field
    // always being present with a real boolean.
    assert.equal(audit.metrics.run_aborted, false);
    assert.doesNotMatch(audit.run.summary, /aborted/i);
  });
});
