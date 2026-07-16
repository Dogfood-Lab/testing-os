/**
 * export-verdict-complete-open-findings.test.js — F-b721038e:
 * computeRunVerdict()'s first line short-circuited `if (status === 'complete')
 * return 'pass'` BEFORE the function's own open-findings count ever ran
 * (lib/persist/export.js). 'complete' is the run's normal SUCCESS terminal
 * state, not an edge case, so this was dead code on the success path: a
 * completed run carrying an open CRITICAL (e.g. forced past the
 * finding_severity gate via a documented `swarm advance --override`) still
 * published overall_verdict:'pass' into the durable dogfood-submission.json,
 * while the sibling repoknowledge-bridge#buildAuditPayload — built from the
 * SAME exportData in the SAME `swarm persist` call, and which has never
 * special-cased run.status — correctly reported overall_status:'fail' /
 * blocking_release:true for the identical finding state. Two artifacts, one
 * call, opposite verdicts.
 *
 * THE FIX. `complete` no longer short-circuits: it falls through to the same
 * open-findings count every other non-aborted status already used, so
 * 'complete' means 'pass' only when it is actually earned. `aborted` keeps
 * its unconditional 'fail' (the conservative direction), unchanged.
 *
 * SCOPE NOTE. This file lives under lib/ (not at the package root) because
 * the swarm-cp-core domain for wave 14 owns `packages/dogfood-swarm/lib/**`
 * only. The existing root-level packages/dogfood-swarm/persist.test.js has
 * an adjacent, DB-backed 'Run verdict' describe block whose 'pass for
 * complete run' fixture (buildCompleteRun always inserts an open MEDIUM,
 * F-002, regardless of the findingStatus opt — only F-001's status is
 * configurable) now genuinely returns 'partial' instead of 'pass' post-fix.
 * That file is outside this domain's owned globs and is deliberately NOT
 * edited here — see this agent's output.json `skipped[]` entry for the exact
 * companion change it still needs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeRunVerdict } from './persist/export.js';
import { buildDogfoodSubmission } from './persist/dogfood-bridge.js';
import { buildAuditPayload } from './persist/repoknowledge-bridge.js';

const COMMIT_SHA = 'b'.repeat(40);

/** A minimal, schema-shaped canonical export literal (mirrors buildRunExport's envelope). */
function makeExport({ status, items }) {
  return {
    run: {
      id: 'run-verdict-complete', repo: 'dogfood-lab/testing-os', branch: 'main',
      commit_sha: COMMIT_SHA, status, created: '2026-07-01T00:00:00Z',
      completed: status === 'complete' ? '2026-07-01T01:00:00Z' : null,
    },
    waves: [{
      number: 1, phase: 'treatment', status: 'advanced',
      agents: [{ domain: 'core', status: 'complete' }],
      verification: { passed: true, adapter: 'node', test_count: 10 },
      violations: [],
    }],
    verification: [{ wave: 1, phase: 'treatment', passed: true, test_count: 10 }],
    findings: { summary: { total: items.length }, items },
    promotions: [],
  };
}

describe('F-b721038e — computeRunVerdict no longer short-circuits complete before counting open findings', () => {
  it('a COMPLETE run with an open CRITICAL is fail, not pass', () => {
    const exp = makeExport({
      status: 'complete',
      items: [{ id: 'F-101', severity: 'CRITICAL', status: 'new', description: 'Auth bypass' }],
    });
    assert.equal(exp.run.status, 'complete', 'fixture sanity: this is exactly the terminal state the pre-fix early return special-cased');
    assert.equal(computeRunVerdict(exp), 'fail',
      "pre-fix: `if (status === 'complete') return 'pass'` fired before the open-CRITICAL check ever ran");
  });

  it('a COMPLETE run with only an open non-critical finding is partial, not pass', () => {
    const exp = makeExport({
      status: 'complete',
      items: [{ id: 'F-102', severity: 'MEDIUM', status: 'new', description: 'Missing null check' }],
    });
    assert.equal(computeRunVerdict(exp), 'partial');
  });

  it('a COMPLETE run with every finding closed is genuinely pass', () => {
    const exp = makeExport({
      status: 'complete',
      items: [
        { id: 'F-103', severity: 'CRITICAL', status: 'fixed', description: 'Auth bypass' },
        { id: 'F-104', severity: 'LOW', status: 'deferred', description: 'Style nit' },
      ],
    });
    assert.equal(computeRunVerdict(exp), 'pass');
  });

  it('a COMPLETE run with no findings at all is pass', () => {
    const exp = makeExport({ status: 'complete', items: [] });
    assert.equal(computeRunVerdict(exp), 'pass');
  });

  it('aborted still fails unconditionally, even with zero findings (unchanged, conservative direction)', () => {
    const exp = makeExport({ status: 'aborted', items: [] });
    assert.equal(computeRunVerdict(exp), 'fail');
  });

  it('the two sibling artifacts built from the SAME exportData now AGREE for a complete run with an open CRITICAL', () => {
    // Corroborating proof: pre-fix, dogfood-submission said 'pass' while
    // repoknowledge said 'fail'/blocking_release:true for one run in one
    // `swarm persist` invocation. Both bridges read the SAME exportData;
    // only export.js's computeRunVerdict needed the fix, since
    // repoknowledge-bridge#buildAuditPayload never special-cased run.status.
    const exp = makeExport({
      status: 'complete',
      items: [{ id: 'F-105', severity: 'CRITICAL', status: 'new', description: 'Unsigned token accepted' }],
    });
    const verdict = computeRunVerdict(exp);
    const submission = buildDogfoodSubmission(exp, verdict);
    const audit = buildAuditPayload(exp);

    assert.equal(submission.overall_verdict, 'fail');
    assert.equal(audit.run.overall_status, 'fail');
    assert.equal(audit.run.blocking_release, true);
  });
});
