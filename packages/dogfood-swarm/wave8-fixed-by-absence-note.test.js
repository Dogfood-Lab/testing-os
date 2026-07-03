/**
 * wave8-fixed-by-absence-note.test.js — Stage C (humanization / audit-trail)
 * observability pin for F-2c6d825d.
 *
 * classifyFindings routes a prior finding into `classified.fixed` when the
 * current wave's scope COVERED its path but the wave did NOT re-report it — i.e.
 * closed *by absence* in a full-coverage re-audit, not by a rediscovered-then-
 * fixed event. upsertFindings recorded that closure as a generic
 * `finding_events` row with `notes = null`, indistinguishable in the ledger
 * from any other 'fixed' event. An operator auditing the trail could not tell a
 * by-absence closure from a by-fix one.
 *
 * This pin asserts the by-absence closure now carries a distinguishing note.
 * It is observability ONLY: it does NOT touch classifyFindings' bucketing, does
 * NOT change which findings land in classified.fixed, and does NOT touch the
 * gate — the finding's terminal status is still 'fixed'.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { classifyFindings, upsertFindings, buildPriorMap } from './lib/fingerprint.js';

const RUN_ID = 'test-absence-note';

function seedRun(db) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(RUN_ID, 'org/test', '/tmp/test', 'c'.repeat(40));
}

describe('fixed-by-absence closure carries a distinguishing note (F-2c6d825d)', () => {
  it("a prior finding closed by absence gets a non-null 'fixed' finding_events note", () => {
    const db = openMemoryDb();
    seedRun(db);

    // Wave 1 — report a finding at src/b.js.
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')").run(RUN_ID);
    upsertFindings(db, RUN_ID, 1, {
      new: [{ fingerprint: 'fp-absent', severity: 'LOW', category: 'quality', description: 'will vanish', file: 'src/b.js' }],
      recurring: [],
      fixed: [],
    });
    db.prepare("UPDATE findings SET file_path = 'src/b.js' WHERE fingerprint = 'fp-absent'").run();

    // Wave 2 — scope covers all of src/ but fp-absent is NOT re-reported →
    // classifyFindings routes it to `fixed` by absence.
    const wave2 = db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 2, 'dispatched')").run(RUN_ID);
    const priorMap = buildPriorMap(db, RUN_ID);
    const classified = classifyFindings([], priorMap, { scopePaths: ['src/'] });
    assert.equal(classified.fixed.length, 1, 'fp-absent must classify as fixed-by-absence');

    upsertFindings(db, RUN_ID, Number(wave2.lastInsertRowid), classified);

    // finding_events.finding_id references findings.id (the numeric PK), not
    // the F-xxxxxxxx finding_id string.
    const row = db.prepare("SELECT id, status FROM findings WHERE fingerprint = 'fp-absent'").get();
    assert.equal(row.status, 'fixed', 'terminal status must still be fixed (gate/bucketing unchanged)');

    const latestFixedEvent = db.prepare(`
      SELECT notes FROM finding_events
      WHERE finding_id = ? AND event_type = 'fixed'
      ORDER BY id DESC LIMIT 1
    `).get(row.id);

    assert.ok(latestFixedEvent, "a 'fixed' finding_events row must exist");
    assert.notEqual(latestFixedEvent.notes, null, "the fixed-by-absence closure must NOT record a null note");
    assert.match(latestFixedEvent.notes, /absence/i, "the note must distinguish closure by absence");

    db.close();
  });
});
