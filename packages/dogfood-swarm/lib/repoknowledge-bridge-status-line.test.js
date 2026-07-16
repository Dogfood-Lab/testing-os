/**
 * repoknowledge-bridge-status-line.test.js — F-09c4777a: buildAuditPayload's
 * wave-18 aborted-run fix (F-be8db3ee) closed the WITHIN-payload contradiction
 * (overall_posture:'critical' now agrees with metrics.run_aborted and
 * run.summary — see export-verdict-aborted-sibling-agreement.test.js) but
 * never reached the one production consumer that reads
 * overall_status/overall_posture in ISOLATION: commands/persist.js's
 * formatPersist() (the `swarm persist` terminal output). That file is
 * OUTSIDE this domain's owned glob (packages/dogfood-swarm/lib/**\, db/**\,
 * persist-results.js — commands/** belongs to swarm-cp-verbs), so for an
 * aborted run with zero open findings the operator watching `swarm persist`
 * scroll by saw a bare "Status (pending): fail (critical)" with nothing
 * telling them a phantom critical did NOT trigger the block.
 *
 * THE FIX (this domain's half). buildAuditPayload's overall_posture stays
 * inside the fixed ['healthy','needs_attention','critical'] enum
 * persist.test.js (package root, out of this domain) already hard-pins — see
 * export-verdict-aborted-sibling-agreement.test.js's wave-18 note for why a
 * fourth enum value was rejected there. formatAuditStatusLine()
 * (lib/persist/repoknowledge-bridge.js) is a new, single lib-owned helper
 * that instead folds metrics.run_aborted into the rendered TEXT, so any
 * renderer that calls it — rather than hand-formatting `${status}
 * (${posture})` itself — gets the abort qualifier for free and cannot
 * regress it by forgetting to separately check run_aborted. The cross-domain
 * wiring (commands/persist.js calling this helper) is recorded in this
 * wave's skipped[] for swarm-cp-verbs; this test pins the helper's OWN
 * contract so that wiring has a stable, already-proven function to call.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns packages/dogfood-swarm/lib/**\ only — same
 * reasoning as every other lib/*-test.js file in this directory testing a
 * lib/persist/* or lib/*.js module.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditPayload, formatAuditStatusLine } from './persist/repoknowledge-bridge.js';

const COMMIT_SHA = 'e'.repeat(40);

/** A minimal, schema-shaped canonical export literal (mirrors buildRunExport's envelope). */
function makeExport({ status, items }) {
  return {
    run: {
      id: 'run-status-line', repo: 'dogfood-lab/testing-os', branch: 'main',
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

/** @pins F-09c4777a */
describe('formatAuditStatusLine — folds run_aborted into rendered text, not the posture enum (F-09c4777a)', () => {
  it('a normal (non-aborted, clean) run renders the bare status/posture pair, unqualified', () => {
    const exp = makeExport({ status: 'complete', items: [] });
    exp.run.completed = '2026-07-01T01:00:00Z';
    const audit = buildAuditPayload(exp);

    assert.equal(formatAuditStatusLine(audit), 'pass (healthy)');
  });

  it('GATE: an aborted run with ZERO open findings — the exact "phantom critical" scenario F-09c4777a traced to the CLI — names the abort in the rendered line', () => {
    const exp = makeExport({ status: 'aborted', items: [] });
    const audit = buildAuditPayload(exp);

    // Pre-helper: a renderer hand-formatting `${status} (${posture})` from
    // this exact payload (as commands/persist.js's formatPersist() does
    // today) produces the bare "fail (critical)" the finding traced all the
    // way to `swarm persist`'s terminal output, with nothing telling the
    // operator a phantom critical did NOT trigger the block.
    assert.equal(audit.run.overall_status, 'fail');
    assert.equal(audit.run.overall_posture, 'critical');
    assert.equal(audit.metrics.critical_count, 0);

    const line = formatAuditStatusLine(audit);
    assert.match(line, /^fail \(critical\)/);
    assert.match(line, /aborted/i, 'the rendered line must name the abort, not just the bare status/posture pair');
  });

  it('an aborted run with a real open CRITICAL still names the abort (both true, neither suppresses the other)', () => {
    const exp = makeExport({
      status: 'aborted',
      items: [{ id: 'F-301', severity: 'CRITICAL', status: 'new', description: 'Unsigned token accepted' }],
    });
    const audit = buildAuditPayload(exp);

    const line = formatAuditStatusLine(audit);
    assert.match(line, /^fail \(critical\)/);
    assert.match(line, /aborted/i);
  });

  it('a COMPLETE run with open findings (pass_with_findings) still renders unqualified — the aborted qualifier must not leak into a genuine completed run', () => {
    const exp = makeExport({
      status: 'complete',
      items: [{ id: 'F-302', severity: 'HIGH', status: 'new', description: 'Missing rate limit' }],
    });
    exp.run.completed = '2026-07-01T01:00:00Z';
    const audit = buildAuditPayload(exp);

    assert.equal(audit.run.overall_status, 'pass_with_findings');
    assert.equal(formatAuditStatusLine(audit), 'pass_with_findings (needs_attention)');
  });

  it('overall_posture itself never gains a 4th enum value — the qualifier lives only in the rendered TEXT, never the field value', () => {
    const exp = makeExport({ status: 'aborted', items: [] });
    const audit = buildAuditPayload(exp);
    assert.ok(
      ['healthy', 'needs_attention', 'critical'].includes(audit.run.overall_posture),
      "buildAuditPayload.run.overall_posture must stay within the enum persist.test.js pins — F-09c4777a folds the abort " +
      "signal into formatAuditStatusLine()'s TEXT output, never into this field's value",
    );
  });
});
