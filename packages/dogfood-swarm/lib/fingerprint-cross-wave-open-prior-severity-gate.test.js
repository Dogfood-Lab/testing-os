/**
 * fingerprint-cross-wave-open-prior-severity-gate.test.js — F-20bde286:
 * F-a8c0cf04's cross-wave case-collision safety net
 * (disambiguateFingerprints' singleton branch, fingerprint.js) gated its
 * raw-file-identity-mismatch salting on `priorRow.status === 'fixed'` ONLY.
 * For every OTHER prior status — new, recurring, unverified, deferred — a
 * genuinely different, case-variant-file finding still silently collapsed
 * into the unrelated prior's row via the EXACT mechanism F-a8c0cf04 was
 * filed to close: status/last_seen_wave moved, but the new finding's real
 * severity and description were discarded with no trace. Because no
 * recurrence path ever rewrote the `severity` column, a HIGHER-severity
 * collision hiding under a LOWER-severity open row made
 * lib/advance.js#checkFindingSeverity's gate blind to a real, undisclosed
 * CRITICAL/HIGH finding — the wave could silently ADVANCE.
 *
 * THE FIX (see fingerprint.js's shouldSaltCrossWaveCollision for the full
 * case-by-case header):
 *   - 'fixed' keeps its ORIGINAL unconditional-on-raw-mismatch behavior —
 *     unchanged, still pinned by fingerprint-cross-wave-case-collision.test.js.
 *   - {new, recurring, unverified, deferred} now ALSO salt on raw-mismatch,
 *     but gated on SEVERITY: only a STRICTLY higher incoming severity than
 *     the prior's recorded severity is treated as proof this is a
 *     materially different defect, not the SAME still-open bug re-audited
 *     under different path casing (F-c63da27b's intended job — pinned by
 *     fingerprint-cross-wave-case-collision.test.js's "still-open stability"
 *     describe block and NOT re-litigated here).
 *   - Defense-in-depth (part 2): upsertFindings' updateRecurring now bumps
 *     the stored severity to max(prior, incoming) on every ordinary
 *     recurrence — closing the same gate-defeat consequence even for a merge
 *     the identity logic legitimately decided IS the same finding.
 *
 * This file enumerates EVERY prior status the original fix left uncovered,
 * both directions (higher severity -> kept distinct; equal-or-lower ->
 * still collapses), plus a negative control proving 'fixed' was NOT
 * accidentally severity-gated by this change, plus the end-to-end gate
 * consequence itself (checkFindingSeverity's own query shape, reproduced
 * locally — advance.js is a different domain, not imported).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings } from './fingerprint.js';
import { CLOSED_FINDING_STATUSES_SQL } from './finding-status.js';

/** Mirrors fingerprint-cross-wave-case-collision.test.js's setupRun. */
function setupRun(db, opts = {}) {
  const runId = opts.runId || 'r1';
  const phase = opts.phase || 'health-audit-a';
  const waveNumber = opts.waveNumber || 1;

  if (!opts.reuseRun) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['packages/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
  }

  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, 'collected')"
  ).run(runId, phase, waveNumber);

  return { runId, waveId: Number(wave.lastInsertRowid) };
}

/** Reproduces lib/advance.js#checkFindingSeverity's open-severity count query. */
function openSeverityCounts(db, runId) {
  const rows = db.prepare(`
    SELECT severity, COUNT(*) as cnt FROM findings
    WHERE run_id = ? AND status NOT IN (${CLOSED_FINDING_STATUSES_SQL})
    GROUP BY severity
  `).all(runId);
  const counts = {};
  for (const row of rows) counts[row.severity] = row.cnt;
  return counts;
}

describe('cross-wave case collision vs an OPEN prior — higher-severity finding kept distinct (F-20bde286)', () => {
  for (const status of ['new', 'recurring', 'unverified']) {
    it(`status='${status}': a CRITICAL at the real spelling is inserted as NEW, not merged into a ${status} MEDIUM at a differently-cased spelling`, () => {
      const db = openMemoryDb();
      const { runId, waveId: wave1Id } = setupRun(db, { runId: `open-${status}`, waveNumber: 1 });

      const oldFp = computeFingerprint({
        category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
        file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
      });
      db.prepare(`
        INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
        VALUES (?, 'F-old', ?, 'MEDIUM', 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'the old, still-live defect', ?, ?, ?)
      `).run(runId, oldFp, status, wave1Id, wave1Id);

      const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
      const priorMap = buildPriorMap(db, runId);

      const newFinding = {
        category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
        file: 'packages/dogfood-swarm/lib/legacy/domains.js', // the REAL, correctly-cased path
        severity: 'CRITICAL', description: 'a wholly unrelated, more severe new defect',
      };
      assert.equal(computeFingerprint(newFinding), oldFp,
        'fixture sanity: differently-cased path spellings must still fold to the same base fingerprint');

      const classified = classifyFindings([newFinding], priorMap);
      assert.equal(classified.new.length, 1,
        `status='${status}': the CRITICAL finding must classify as NEW, not merged into the ${status} row`);
      assert.equal(classified.recurring.length, 0);
      assert.equal(classified.recurred_while_closed.length, 0);

      const stats = upsertFindings(db, runId, wave2Id, classified);
      assert.equal(stats.inserted, 1, 'the new finding must actually be inserted as its own row');

      const all = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId);
      assert.equal(all.length, 2, 'both the old row AND the new row must exist — nothing swallowed');

      const oldRow = all.find((f) => f.finding_id === 'F-old');
      // NOT `status === status` (the original value): `currentFindings` here
      // deliberately contains ONLY the adversarial CRITICAL finding, not also
      // a same-wave re-report of the old bug — re-reporting it here (at
      // EITHER casing) would fold to the SAME base fingerprint as the
      // adversarial finding via normalizePath's case-insensitive fold,
      // forming a same-WAVE 2-member collision group instead of the
      // cross-wave SINGLETON scenario this file is about (a different,
      // already-covered code path — chooseBareKeeper/saltByContent). Because
      // the old row's fingerprint is therefore never rediscovered this wave
      // and no `scope` is passed, classifyFindings' own documented safe
      // default ("no scope supplied -> ALL not-rediscovered prior findings
      // are classified unverified") reclassifies it from new/recurring/
      // unverified to 'unverified' — this is pre-existing, correct,
      // orthogonal behavior (B-BACK-003), not something F-20bde286 touches.
      // What DOES matter here, and what F-20bde286 is actually about, is
      // that the collision-safety-net leaves the old row's SEVERITY and
      // DESCRIPTION untouched — a real merge would have discarded them.
      assert.equal(oldRow.status, 'unverified',
        'not rediscovered this wave + no scope supplied -> unverified, per classifyFindings\' own documented safe default (unrelated to this fix)');
      assert.equal(oldRow.severity, 'MEDIUM', 'the old row\'s severity must not be touched by the unrelated collision');
      assert.equal(oldRow.description, 'the old, still-live defect', 'the old row\'s description must not be touched by the unrelated collision');

      const newRow = all.find((f) => f.finding_id !== 'F-old');
      assert.equal(newRow.severity, 'CRITICAL', 'the new finding\'s real severity must survive, not be discarded');
      assert.equal(newRow.status, 'new');

      // The gate-defeat consequence itself: an open CRITICAL must be VISIBLE
      // to checkFindingSeverity's count, not hidden behind the old MEDIUM row.
      const counts = openSeverityCounts(db, runId);
      assert.equal(counts.CRITICAL, 1,
        'checkFindingSeverity must see the real open CRITICAL — pre-fix it was invisible, merged into a MEDIUM row');
      db.close();
    });
  }

  it("status='deferred': a CRITICAL at the real spelling is inserted as NEW, not silently absorbed under the deferred row's banner", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'open-deferred', waveNumber: 1 });

    const oldFp = computeFingerprint({
      category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-old', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'a specific, already-understood, accepted-risk defect', 'deferred', ?, ?)
    `).run(runId, oldFp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const newFinding = {
      category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/legacy/domains.js',
      severity: 'CRITICAL', description: 'a wholly unrelated, never-seen, more severe defect',
    };
    assert.equal(computeFingerprint(newFinding), oldFp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([newFinding], priorMap);
    assert.equal(classified.new.length, 1,
      'the CRITICAL finding must classify as NEW, not absorbed into the deferred row\'s recurred_while_closed bucket');
    assert.equal(classified.recurred_while_closed.length, 0);
    assert.equal(classified.recurring.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.inserted, 1);
    assert.equal(stats.preserved, 0, 'nothing should route through the recurred_while_closed preserve path');

    const all = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId);
    assert.equal(all.length, 2);
    const oldRow = all.find((f) => f.finding_id === 'F-old');
    assert.equal(oldRow.status, 'deferred', 'the coordinator\'s deferred decision on the ORIGINAL bug must be untouched');
    assert.equal(oldRow.severity, 'HIGH');
    assert.equal(oldRow.description, 'a specific, already-understood, accepted-risk defect');

    const newRow = all.find((f) => f.finding_id !== 'F-old');
    assert.equal(newRow.severity, 'CRITICAL');
    assert.equal(newRow.status, 'new', 'the new, never-seen defect must surface on its own — not hidden behind the deferred banner');
    db.close();
  });
});

describe('cross-wave case collision vs an OPEN or deferred prior — equal-or-lower severity still collapses (F-20bde286 does not regress F-c63da27b/F-130dee59)', () => {
  it("status='recurring': a re-audit re-casing the SAME live bug at an EQUAL severity still collapses to recurring", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'equal-recurring', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R2', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/Foo.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-open', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Foo.js', 10, 'doThing', 'still-open defect', 'recurring', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R2', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/foo.js', // different case, SAME real bug
      severity: 'HIGH', description: 'still-open defect',
    };
    assert.equal(computeFingerprint(rediscovered), fp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurring.length, 1,
      'an EQUAL-severity re-casing of an OPEN prior must still collapse — the severity gate only fires on a STRICTLY higher incoming severity');
    assert.equal(classified.new.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.updated, 1);
    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    assert.equal(all.length, 1, 'must still be ONE row');
    assert.equal(all[0].status, 'recurring');
    assert.equal(all[0].severity, 'HIGH');
    db.close();
  });

  it("status='unverified': a re-audit re-casing the SAME bug at a LOWER severity still collapses (does not spuriously split)", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'lower-unverified', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R3', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/Baz.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-unv', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Baz.js', 10, 'doThing', 'still-open defect, reassessed', 'unverified', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R3', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/baz.js',
      severity: 'LOW', description: 'still-open defect, reassessed',
    };
    assert.equal(computeFingerprint(rediscovered), fp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurring.length, 1,
      'a LOWER-severity re-casing must still collapse — only a STRICTLY HIGHER incoming severity is treated as a distinct defect');
    assert.equal(classified.new.length, 0);
    db.close();
  });

  it("status='deferred': a re-audit re-casing the SAME deferred bug at an EQUAL severity still routes to recurred_while_closed, status untouched", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'equal-deferred', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R4', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/Qux.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-def', ?, 'MEDIUM', 'bug', 'packages/dogfood-swarm/lib/Qux.js', 10, 'doThing', 'accepted risk', 'deferred', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R4', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/qux.js',
      severity: 'MEDIUM', description: 'accepted risk',
    };
    assert.equal(computeFingerprint(rediscovered), fp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurred_while_closed.length, 1,
      'an EQUAL-severity re-casing of a deferred prior must still route to recurred_while_closed — F-130dee59 must not regress');
    assert.equal(classified.new.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.preserved, 1);
    const row = db.prepare('SELECT * FROM findings WHERE run_id = ?').get(runId);
    assert.equal(row.status, 'deferred', 'status must stay untouched — a coordinator\'s deferred call is not overturned by recurrence');
    assert.equal(row.last_seen_wave, wave2Id, 'last_seen_wave must still bump (F-833dff6f) even under the widened net');
    db.close();
  });
});

describe("'fixed' status is NOT accidentally severity-gated by the F-20bde286 widening (negative control)", () => {
  it("a raw-mismatch against a 'fixed' prior salts even when the incoming severity is LOWER — 'fixed' stays unconditional", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'fixed-lower-severity', waveNumber: 1 });

    const oldFp = computeFingerprint({
      category: 'bug', rule_id: 'R5', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-old', ?, 'CRITICAL', 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'the old, already-resolved defect', 'fixed', ?, ?)
    `).run(runId, oldFp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const newFinding = {
      category: 'bug', rule_id: 'R5', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/legacy/domains.js',
      severity: 'LOW', // strictly LOWER than the fixed prior's CRITICAL
      description: 'a wholly unrelated, minor new defect',
    };
    assert.equal(computeFingerprint(newFinding), oldFp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([newFinding], priorMap);
    assert.equal(classified.new.length, 1,
      "'fixed' + raw-mismatch must salt UNCONDITIONALLY regardless of severity direction — it must not have been folded into the severity gate");
    assert.equal(classified.recurring.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.inserted, 1);
    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    assert.equal(all.length, 2);
    const oldRow = all.find((f) => f.finding_id === 'F-old');
    assert.equal(oldRow.status, 'fixed');
    assert.equal(oldRow.severity, 'CRITICAL', 'the fixed row must not be reopened/altered by the unrelated LOW finding');
    db.close();
  });
});

describe('upsertFindings.updateRecurring — severity escalates to the more severe of (prior, incoming) on recurrence (F-20bde286 part 2, defense-in-depth)', () => {
  it('an ordinary same-fingerprint recurrence with a HIGHER incoming severity bumps the stored severity', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'bump-up', waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-bump-up', 'LOW', 'bug', 'reassessed defect', 'new', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);
    const classified = classifyFindings(
      [{ category: 'bug', description: 'reassessed defect', fingerprint: 'fp-bump-up', severity: 'CRITICAL' }],
      priorMap,
    );
    assert.equal(classified.recurring.length, 1, 'fixture sanity: same fingerprint must classify as recurring');

    upsertFindings(db, runId, wave2Id, classified);

    const row = db.prepare('SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-bump-up');
    assert.equal(row.status, 'recurring');
    assert.equal(row.severity, 'CRITICAL',
      'a re-audit assessing the SAME finding as more severe must update the stored severity — checkFindingSeverity reads this column directly');

    const event = db.prepare(
      "SELECT * FROM finding_events WHERE finding_id = ? AND event_type = 'recurred' ORDER BY id DESC LIMIT 1"
    ).get(row.id);
    assert.match(event.notes, /severity escalated LOW -> CRITICAL/,
      'the escalation must be visible in the finding_events audit trail, not just the resulting column value');
    db.close();
  });

  it('an ordinary same-fingerprint recurrence with a LOWER incoming severity does NOT downgrade the stored severity', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'no-downgrade', waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-no-downgrade', 'HIGH', 'bug', 'same defect', 'new', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);
    const classified = classifyFindings(
      [{ category: 'bug', description: 'same defect', fingerprint: 'fp-no-downgrade', severity: 'LOW' }],
      priorMap,
    );

    upsertFindings(db, runId, wave2Id, classified);

    const row = db.prepare('SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-no-downgrade');
    assert.equal(row.severity, 'HIGH',
      'the WORST-known severity must be kept — a later wave under-reporting severity must not erase the earlier, more severe assessment');

    const event = db.prepare(
      "SELECT * FROM finding_events WHERE finding_id = ? AND event_type = 'recurred' ORDER BY id DESC LIMIT 1"
    ).get(row.id);
    assert.equal(event.notes, null, 'no escalation occurred, so the note stays exactly as before (null) — no spurious noise');
    db.close();
  });

  it('an ordinary same-fingerprint recurrence with an EQUAL incoming severity leaves severity and notes unchanged', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'no-change', waveNumber: 1 });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp-no-change', 'MEDIUM', 'bug', 'same defect', 'new', ?, ?)
    `).run(runId, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);
    const classified = classifyFindings(
      [{ category: 'bug', description: 'same defect', fingerprint: 'fp-no-change', severity: 'MEDIUM' }],
      priorMap,
    );

    upsertFindings(db, runId, wave2Id, classified);

    const row = db.prepare('SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?').get(runId, 'fp-no-change');
    assert.equal(row.severity, 'MEDIUM');
    const event = db.prepare(
      "SELECT * FROM finding_events WHERE finding_id = ? AND event_type = 'recurred' ORDER BY id DESC LIMIT 1"
    ).get(row.id);
    assert.equal(event.notes, null, 'the baseline (pre-F-20bde286) behavior — plain recurring, no severity commentary — is unchanged when nothing escalated');
    db.close();
  });
});
