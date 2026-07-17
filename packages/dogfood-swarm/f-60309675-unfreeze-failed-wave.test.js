/**
 * f-60309675-unfreeze-failed-wave.test.js — F-60309675: unfreezeDomains'
 * sm-001 no-drift guard did not cover a 'failed' wave, a sibling of the
 * 'dispatched' door it already refused.
 *
 * commands/revalidate.js re-runs the ownership check on the 'failed' ->
 * 'collected' recovery path, and checkOwnership resolves against the LIVE
 * domain map, not the wave's dispatch-time snapshot. So the exact drift the
 * guard exists to prevent was reachable: unfreeze a 'failed' wave (permitted
 * before this fix), broaden the globs to cover the violating files, re-freeze,
 * then `swarm revalidate --apply` — laundering an ownership violation into a
 * pass with no error, against a map the agents were never briefed with.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains, unfreezeDomains, hasActiveWave } from './lib/domains.js';

function setup(db, runId, waveStatus) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);
  db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, ?)")
    .run(runId, waveStatus);
}

describe('unfreezeDomains — a failed wave is treated as in-flight (F-60309675)', () => {
  it('refuses to unfreeze while the latest wave is "failed"', () => {
    const db = openMemoryDb();
    setup(db, 'r1', 'failed');
    assert.throws(() => unfreezeDomains(db, 'r1', 'operator reason'), /in flight/);
    db.close();
  });

  it('the documented force escape hatch still works for a genuinely-halted failed wave', () => {
    const db = openMemoryDb();
    setup(db, 'r1', 'failed');
    assert.doesNotThrow(() => unfreezeDomains(db, 'r1', 'operator halted by hand', { force: true }));
    db.close();
  });

  it('hasActiveWave reports true for a failed wave', () => {
    const db = openMemoryDb();
    setup(db, 'r1', 'failed');
    assert.equal(hasActiveWave(db, 'r1'), true);
    db.close();
  });

  it('does NOT regress the pre-existing statuses: a "collected" wave may still be unfrozen freely', () => {
    const db = openMemoryDb();
    setup(db, 'r1', 'collected');
    assert.doesNotThrow(() => unfreezeDomains(db, 'r1', 'operator reason'));
    db.close();
  });

  it('still refuses while "dispatched" (pre-existing behavior, not regressed)', () => {
    const db = openMemoryDb();
    setup(db, 'r1', 'dispatched');
    assert.throws(() => unfreezeDomains(db, 'r1', 'operator reason'), /in flight/);
    db.close();
  });
});
