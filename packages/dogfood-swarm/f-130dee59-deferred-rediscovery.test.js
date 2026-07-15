/**
 * f-130dee59-deferred-rediscovery.test.js — F-130dee59: a coordinator's
 * `deferred` decision must survive rediscovery, exactly as `rejected` already
 * does.
 *
 * Root cause (lib/fingerprint.js): buildPriorMap excludes only 'rejected', so
 * 'deferred' rows enter the prior fingerprint map. The rediscovered branch in
 * classifyFindings then pushed ANY prior-map hit into `result.recurring` with
 * no status check, and upsertFindings' updateRecurring unconditionally ran
 * `UPDATE findings SET status='recurring'` — silently overwriting a
 * coordinator's `deferred` verdict the moment the same defect was reported
 * again, with no log line, no finding_event, no warning. `rejected` was
 * explicitly protected (excluded from the prior map; the INSERT-OR-IGNORE
 * conflict path in upsertFindings preserves it and logs a 'recurred' event);
 * `deferred` — which finding-status.js defines as the SAME class of decision
 * and CLOSED_FINDING_STATUSES treats identically — had no protection at all.
 *
 * These tests are deliberately NOT the vacuous shape control-plane.test.js:250
 * ('does not mark deferred findings as fixed') has: that test passes
 * `current = []`, so it never exercises rediscovery and would pass identically
 * with or without this fix. Every test below puts the deferred fingerprint
 * PRESENT in `current`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { checkGates } from './lib/advance.js';
import { classifyFindings, buildPriorMap, upsertFindings } from './lib/fingerprint.js';

/** Mirrors advance.test.js's setupRun — a minimal run+wave+complete-agents fixture. */
function setupRun(db, opts = {}) {
  const runId = opts.runId || 'r1';
  const phase = opts.phase || 'health-audit-a';
  const waveNumber = opts.waveNumber || 1;

  if (!opts.reuseRun) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
  }

  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, 'collected')"
  ).run(runId, phase, waveNumber);

  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? AND ownership_class != ?')
    .all(runId, 'shared');
  for (const d of domains) {
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(Number(wave.lastInsertRowid), d.id);
  }

  return { runId, waveId: Number(wave.lastInsertRowid) };
}

describe('classifyFindings — deferred/rejected rediscovery is NOT silently reclassified', () => {
  it('a deferred finding rediscovered lands in recurred_while_closed, not recurring', () => {
    const current = [
      { category: 'bug', file: 'a.js', line: 10, description: 'still there', fingerprint: 'fp-defer' },
    ];
    const prior = new Map([['fp-defer', { id: 1, status: 'deferred', fingerprint: 'fp-defer' }]]);

    const result = classifyFindings(current, prior);
    assert.equal(result.recurring.length, 0, 'deferred must not silently become recurring');
    assert.equal(result.recurred_while_closed.length, 1);
    assert.equal(result.recurred_while_closed[0].priorStatus, 'deferred');
    assert.equal(result.recurred_while_closed[0].prior.id, 1);
  });

  it('a rejected finding rediscovered ALSO lands in recurred_while_closed (defensive symmetry)', () => {
    // buildPriorMap excludes 'rejected' today, so this path is not reachable
    // via the normal DB flow — asserted directly here because the fix (per
    // finding text) guards both statuses at this point on purpose, and a
    // future change to buildPriorMap's exclusion must not silently reopen
    // the gap this closes for 'deferred'.
    const current = [
      { category: 'bug', file: 'a.js', line: 10, description: 'still there', fingerprint: 'fp-reject' },
    ];
    const prior = new Map([['fp-reject', { id: 2, status: 'rejected', fingerprint: 'fp-reject' }]]);

    const result = classifyFindings(current, prior);
    assert.equal(result.recurring.length, 0);
    assert.equal(result.recurred_while_closed.length, 1);
    assert.equal(result.recurred_while_closed[0].priorStatus, 'rejected');
  });

  it('does NOT protect fixed — a regression is new information and reopens as recurring', () => {
    const current = [
      { category: 'bug', file: 'a.js', line: 10, description: 'broke again', fingerprint: 'fp-fixed' },
    ];
    const prior = new Map([['fp-fixed', { id: 3, status: 'fixed', fingerprint: 'fp-fixed' }]]);

    const result = classifyFindings(current, prior);
    assert.equal(result.recurred_while_closed.length, 0, 'fixed is deliberately NOT covered by this guard');
    assert.equal(result.recurring.length, 1, 'a fixed finding reappearing is a regression — it reopens');
  });

  it('a genuinely new finding at a fresh fingerprint is unaffected', () => {
    const current = [{ category: 'bug', file: 'b.js', line: 1, description: 'new', fingerprint: 'fp-new' }];
    const result = classifyFindings(current, new Map());
    assert.equal(result.new.length, 1);
    assert.equal(result.recurred_while_closed.length, 0);
  });
});

describe('upsertFindings — deferred status survives rediscovery in the DB', () => {
  it('does not overwrite status and logs a recurred-while-deferred event', () => {
    const db = openMemoryDb();
    const { runId, waveId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-defer', 'HIGH', 'bug', 'deferred earlier', 'deferred', 1, 1)
    `).run(runId);

    const current = [
      { category: 'bug', description: 'deferred earlier', fingerprint: 'fp-defer', severity: 'HIGH' },
    ];
    const priorMap = buildPriorMap(db, runId);
    const classified = classifyFindings(current, priorMap);
    const stats = upsertFindings(db, runId, waveId, classified);

    const row = db.prepare('SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-defer');
    assert.equal(row.status, 'deferred', 'status must stay deferred, not flip to recurring');
    assert.equal(stats.updated, 0, 'updateRecurring must not have run for this finding');
    assert.equal(stats.preserved, 1);

    const events = db.prepare('SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id').all(row.id);
    const preservedEvent = events.find(e => e.notes && e.notes.includes('recurred-while-deferred'));
    assert.ok(preservedEvent, 'an observability event must be logged, matching the rejected path');
    assert.equal(preservedEvent.event_type, 'recurred');
    db.close();
  });
});

describe('End-to-end: a deferred HIGH survives rediscovery through checkGates (F-130dee59 repro)', () => {
  it('wave 1 ADVANCEs with the deferred HIGH; wave 2 rediscovers it and STILL ADVANCEs', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { waveNumber: 1 });

    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-defer', 'HIGH', 'bug', 'accepted risk', 'deferred', 1, 1)
    `).run(runId);

    const wave1Result = checkGates(db, runId);
    assert.equal(wave1Result.verdict, 'ADVANCE', 'baseline: a deferred HIGH alone must not block');

    // Wave 2 rediscovers the IDENTICAL fingerprint.
    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);
    const current = [
      { category: 'bug', description: 'accepted risk', fingerprint: 'fp-defer', severity: 'HIGH' },
    ];
    const classified = classifyFindings(current, priorMap);
    upsertFindings(db, runId, wave2Id, classified);

    const wave2Result = checkGates(db, runId);
    assert.equal(
      wave2Result.verdict, 'ADVANCE',
      'rediscovery must not silently overturn the coordinator\'s deferred decision'
    );

    const row = db.prepare('SELECT status FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-defer');
    assert.equal(row.status, 'deferred');
    db.close();
  });

  it('contrast: the identical scenario with rejected stays rejected and ADVANCEs (regression guard, pre-existing behavior)', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r2', waveNumber: 1 });
    void wave1Id;

    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-reject', 'HIGH', 'bug', 'not a real bug', 'rejected', 1, 1)
    `).run(runId);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    // 'rejected' rows are excluded from buildPriorMap, so the rediscovered
    // finding classifies as `new` and collides at INSERT time — the OTHER
    // (pre-existing, already-correct) protection path.
    const priorMap = buildPriorMap(db, runId);
    const current = [
      { category: 'bug', description: 'not a real bug', fingerprint: 'fp-reject', severity: 'HIGH' },
    ];
    const classified = classifyFindings(current, priorMap);
    upsertFindings(db, runId, wave2Id, classified);

    const result = checkGates(db, runId);
    assert.equal(result.verdict, 'ADVANCE');
    const row = db.prepare('SELECT status FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-reject');
    assert.equal(row.status, 'rejected');
    db.close();
  });
});
