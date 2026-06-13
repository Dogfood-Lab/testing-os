/**
 * stageA-findings-digest-severity-case.test.js — Stage A re-audit (ra3) sibling
 * of the d4-swarm-core-001 UPPERCASE-severity fix.
 *
 * buildDigestModel reads the same raw-agent-JSON severity the persist-results
 * release gate does, then keys counts[] against an UPPERCASE-only map and sorts
 * via SEV_ORDER. Pre-fix a stray-case severity ('critical') was mislabeled
 * 'unknown' and sorted last; the fix normalizes to UPPERCASE before both lookups
 * so the whole raw-JSON-consuming family shares one case convention — while a
 * genuinely missing/garbage value still falls through to unknownCount so the
 * loud operator warning is preserved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigestModel } from './findings-digest.js';

const out = (domain, findings) => ({ domain, parsed: { findings, summary: 's' }, parseError: null });

describe('buildDigestModel normalizes stray-case severity (ra3 / d4-swarm-core-001 sibling)', () => {
  it('counts a lowercase-severity finding in its real bucket, not unknown (RED pre-fix)', () => {
    const model = buildDigestModel('r', 1, [
      out('backend', [
        { id: 'F-1', severity: 'critical', category: 'bug', file: 'a.js', line: 1, description: 'x' },
        { id: 'F-2', severity: 'HIGH', category: 'bug', file: 'b.js', line: 2, description: 'y' },
      ]),
    ]);
    assert.equal(model.counts.CRITICAL, 1, 'lowercase "critical" counts as CRITICAL, not unknown');
    assert.equal(model.counts.HIGH, 1);
    assert.equal(model.unknownCount, 0, 'no finding mislabeled unknown by case alone');
    // The gate signal was never inverted (status derives from finding COUNT, not
    // the per-severity buckets) — pin that it still reports findings/exit 1.
    assert.equal(model.status, 'findings');
    assert.equal(model.exitCode, 1);
  });

  it('sorts a lowercase critical ABOVE an uppercase medium', () => {
    const model = buildDigestModel('r', 1, [
      out('backend', [
        { id: 'F-med', severity: 'MEDIUM', category: 'bug', file: 'm.js', line: 1, description: 'm' },
        { id: 'F-crit', severity: 'critical', category: 'bug', file: 'c.js', line: 2, description: 'c' },
      ]),
    ]);
    assert.equal(model.findings[0].id, 'F-crit', 'lowercase critical sorts first (case-insensitive order)');
  });

  it('still routes a genuinely missing/garbage severity to unknownCount', () => {
    const model = buildDigestModel('r', 1, [
      out('backend', [
        { id: 'F-x', severity: undefined, category: 'bug', file: 'a.js', line: 1, description: 'x' },
        { id: 'F-y', severity: 'banana', category: 'bug', file: 'b.js', line: 2, description: 'y' },
      ]),
    ]);
    assert.equal(model.unknownCount, 2, 'truly-unknown severities still counted as unknown (warning preserved)');
    assert.equal(
      model.counts.CRITICAL + model.counts.HIGH + model.counts.MEDIUM + model.counts.LOW, 0,
      'no garbage severity leaked into a real bucket',
    );
  });
});
