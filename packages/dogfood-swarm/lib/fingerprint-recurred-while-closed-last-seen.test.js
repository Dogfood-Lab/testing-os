/**
 * fingerprint-recurred-while-closed-last-seen.test.js — F-833dff6f: a
 * recurred-while-closed finding must have last_seen_wave bumped to the wave
 * that rediscovered it, WITHOUT its status changing.
 *
 * F-130dee59 (see f-130dee59-deferred-rediscovery.test.js, package root)
 * already closed the status-overwrite hole: a deferred/rejected finding
 * rediscovered by a later wave keeps its status and gets a `finding_events`
 * row (event_type='recurred', notes='recurred-while-<status>: ...'). That
 * fix's OWN header comment states its goal as "so an operator can see 'this
 * keeps coming back' without the recurrence overturning their decision" —
 * but the events-only write never bumped last_seen_wave, so every per-wave
 * operator surface that reasons about "what did THIS wave touch" by reading
 * first_seen_wave/last_seen_wave (not finding_events, which none of them
 * join against) stayed blind to the recurrence. Two concrete consumers
 * confirmed by reading their source (both out of this domain,
 * commands/**\ — read, not edited):
 *   - commands/status.js:102 currentWaveFindingCount:
 *       f => f.first_seen_wave === currentWave.id || f.last_seen_wave === currentWave.id
 *   - commands/revalidate.js:521-528's full-coverage reclassification query:
 *       SELECT * FROM findings WHERE run_id = ? AND last_seen_wave = ?
 * Both existed and were correct in intent; both were blind to a closed
 * finding's recurrence because nothing ever wrote last_seen_wave for that
 * path. This file proves the bump lands, proves status stays untouched
 * (the fix must not re-open F-130dee59's hole while closing this one), and
 * reproduces the status.js-style filter locally to prove the specific field
 * this finding fixes is the field that filter actually reads.
 *
 * TWO PATHS, ONE GAP: 'deferred' vs 'rejected'. Despite F-130dee59 treating
 * both statuses as one class, only 'deferred' actually reaches
 * classified.recurred_while_closed via the real db-backed flow — buildPriorMap
 * excludes 'rejected' rows outright (`status NOT IN ('rejected')`), so a
 * rediscovered 'rejected' finding classifies as `new` and is handled by the
 * separate, older F-6a8a98d6 insert-conflict path instead (see
 * classifyFindings' own comment at fingerprint.js:480-484, which states this
 * explicitly). That path carried the IDENTICAL last_seen_wave gap. F-833dff6f's
 * text scoped its fix to the recurred_while_closed loop only, so this file
 * originally documented the sibling as a known-unfixed limitation; it was filed
 * as its own follow-up and fixed in the same wave, and both paths are now
 * covered here. The path-distinction assertions are kept deliberately: they are
 * what stops the two fixes from silently collapsing into one if buildPriorMap's
 * exclusion ever changes.
 *
 * WHY THIS FILE, NOT AN EDIT TO f-130dee59-deferred-rediscovery.test.js.
 * That file lives at package root, outside this domain's owned glob
 * (packages/dogfood-swarm/lib/**\). This is a NEW file, flat in lib/ (in
 * the owned glob AND in package.json's `"lib/*.test.js"` discovery glob),
 * duplicating that file's `setupRun` fixture helper rather than importing
 * it — matching that file's own precedent of duplicating advance.test.js's
 * setupRun rather than sharing a test-utils module across files.
 *
 * WHY TWO DIFFERENT WAVE NUMBERS. The existing F-130dee59 coverage inserts
 * a finding with first_seen_wave = last_seen_wave = 1 and then rediscovers
 * it AT waveId 1 again (same wave) — a bump to 1 is indistinguishable from
 * "never bumped" when the value was already 1. Proving THIS fix requires
 * seeding the prior at wave 1 and rediscovering at wave 2, so a stale
 * last_seen_wave (still 1) is distinguishable from a correctly bumped one
 * (now 2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { classifyFindings, buildPriorMap, upsertFindings } from './fingerprint.js';

/** Mirrors advance.test.js / f-130dee59-deferred-rediscovery.test.js's setupRun. */
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

describe('upsertFindings — recurred_while_closed bumps last_seen_wave without touching status (F-833dff6f)', () => {
  it('a deferred finding rediscovered in a LATER wave gets last_seen_wave bumped to that wave', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-defer', 'HIGH', 'bug', 'accepted risk', 'deferred', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    assert.notEqual(wave1Id, wave2Id, 'fixture sanity: the two waves must be distinct or a stale value cannot be told apart from a bumped one');

    const priorMap = buildPriorMap(db, runId);
    const current = [
      { category: 'bug', description: 'accepted risk', fingerprint: 'fp-defer', severity: 'HIGH' },
    ];
    const classified = classifyFindings(current, priorMap);
    assert.equal(classified.recurred_while_closed.length, 1, 'fixture sanity: must exercise the recurred_while_closed path');

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.preserved, 1);

    const row = db.prepare('SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-defer');
    assert.equal(row.status, 'deferred', 'status must stay untouched — F-130dee59 is not being re-litigated');
    assert.equal(row.first_seen_wave, wave1Id, 'first_seen_wave must be untouched');
    assert.equal(row.last_seen_wave, wave2Id, 'last_seen_wave must be bumped to the rediscovering wave — this is the F-833dff6f fix');
  });

  // The SIBLING case, on the path 'rejected' actually takes — and the reason
  // the two fixes are not redundant. A rejected finding rediscovered via the
  // REAL db flow never reaches classified.recurred_while_closed at all:
  // buildPriorMap's WHERE clause is `status NOT IN ('rejected')` (excludes
  // it), and classifyFindings' own comment confirms the consequence
  // (lib/fingerprint.js:480-484): "buildPriorMap excludes it today so this
  // branch cannot currently observe it." A rediscovered 'rejected' finding
  // instead classifies as `new`, collides on the UNIQUE index at INSERT, and
  // is handled by the SEPARATE F-6a8a98d6 code path (the `existing.status
  // === 'rejected'` branch above the loop F-833dff6f fixed), which carried
  // the identical last_seen_wave gap and now carries the identical bump.
  // The path-distinction assertions below are the load-bearing ones: if a
  // future change to buildPriorMap's exclusion routes 'rejected' through
  // recurred_while_closed instead, they fail loudly rather than letting the
  // two paths silently converge.
  it('a rejected finding rediscovered takes the SEPARATE F-6a8a98d6 insert-conflict path — last_seen_wave is bumped there too, status preserved', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r2', waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-reject', 'HIGH', 'bug', 'not a real bug', 'rejected', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    assert.notEqual(wave1Id, wave2Id, 'fixture sanity: the two waves must be distinct or a stale value cannot be told apart from a bumped one');

    const priorMap = buildPriorMap(db, runId);
    const current = [
      { category: 'bug', description: 'not a real bug', fingerprint: 'fp-reject', severity: 'HIGH' },
    ];
    const classified = classifyFindings(current, priorMap);
    assert.equal(classified.recurred_while_closed.length, 0, 'confirms rejected takes the new+conflict path, not recurred_while_closed, via the real buildPriorMap flow');
    assert.equal(classified.new.length, 1);

    upsertFindings(db, runId, wave2Id, classified);

    const row = db.prepare('SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-reject');
    assert.equal(row.status, 'rejected', 'status must stay untouched — a coordinator\'s rejection is not overturned by mere recurrence');
    assert.equal(row.first_seen_wave, wave1Id, 'first_seen_wave must be untouched');
    assert.equal(row.last_seen_wave, wave2Id, 'last_seen_wave must be bumped on the insert-conflict path too — the sibling of the F-833dff6f fix');

    const event = db.prepare("SELECT * FROM finding_events WHERE finding_id = ? AND notes LIKE 'recurred-while-rejected%'").get(row.id);
    assert.ok(event, 'the F-6a8a98d6 observability event must still be logged alongside the bump');
  });

  it('reproduces commands/status.js:102\'s filter for the REJECTED path — a wave rediscovering only rejected findings no longer counts 0', () => {
    // The consumer consequence that makes the bump worth making on this path:
    // status.js:102's currentWaveFindingCount is the one last_seen_wave reader
    // with no status gate, and it feeds the half-state breadcrumb ("artifacts
    // present, findings absent"). Pre-fix, a wave whose only rediscovery was a
    // rejected finding matched NEITHER half of the OR and reported 0.
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r4', waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-reject2', 'HIGH', 'bug', 'not a real bug', 'rejected', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);
    const current = [
      { category: 'bug', description: 'not a real bug', fingerprint: 'fp-reject2', severity: 'HIGH' },
    ];
    upsertFindings(db, runId, wave2Id, classifyFindings(current, priorMap));

    const allFindings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    const touchedWave2 = allFindings.filter(f => f.first_seen_wave === wave2Id || f.last_seen_wave === wave2Id);
    assert.equal(touchedWave2.length, 1, 'the rejected-then-rediscovered finding must be visible to a "what did this wave touch" filter');

    // The status-GATED readers (status.js:77-78, receipt.js:119-120) must NOT
    // pick it up — the bump must not make a rejected finding look recurring or
    // fixed to any per-wave count.
    assert.equal(
      allFindings.filter(f => f.last_seen_wave === wave2Id && f.status === 'recurring').length, 0,
      'a bumped rejected row must not leak into the status-gated recurring count',
    );
    assert.equal(
      allFindings.filter(f => f.last_seen_wave === wave2Id && f.status === 'fixed').length, 0,
      'a bumped rejected row must not leak into the status-gated fixed count',
    );
  });

  it('reproduces commands/status.js:102\'s "what did this wave touch" filter to prove it now sees the recurrence', () => {
    // f => f.first_seen_wave === currentWave.id || f.last_seen_wave === currentWave.id
    // Reproduced locally (status.js is a different domain, not imported) —
    // this is the exact filter shape the finding named as blind pre-fix.
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r3', waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-defer2', 'HIGH', 'bug', 'accepted risk', 'deferred', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);
    const current = [
      { category: 'bug', description: 'accepted risk', fingerprint: 'fp-defer2', severity: 'HIGH' },
    ];
    upsertFindings(db, runId, wave2Id, classifyFindings(current, priorMap));

    const allFindings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    const touchedWave2 = allFindings.filter(f => f.first_seen_wave === wave2Id || f.last_seen_wave === wave2Id);
    assert.equal(
      touchedWave2.length, 1,
      'the deferred-then-rediscovered finding must be visible to a "what did this wave touch" filter — ' +
        'pre-fix, first_seen_wave stayed at wave1Id and last_seen_wave was never bumped, so it matched NEITHER half of the OR',
    );
  });
});
