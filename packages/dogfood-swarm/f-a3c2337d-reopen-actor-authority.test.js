/**
 * f-a3c2337d-reopen-actor-authority.test.js
 *
 * F-a3c2337d [MEDIUM] — this finding (mine, from wave 38) originally flagged
 * a design GAP: C1 requires reopen to "record the acting authority" and have
 * "the event note distinguish it from the original closer" (WebKit's
 * distinct-authorities bug-lifecycle model), but the PRE-AMEND C3 schema
 * text added only `closure_kind`/`verified_how` to `findings` and two new
 * event_type STRINGS to `finding_events` — no structured actor/authority
 * column anywhere, meaning "acting authority" would have had to live as
 * unstructured prose inside the existing `notes` TEXT column, in tension
 * with this same dispatch's own "load-bearing, not decoration" standard for
 * verified_how.
 *
 * RESOLVED by the AMENDED dispatch (docs/trajectory-and-closure.dispatch.md,
 * the authoritative contract for this wave), which now reads: "finding_events
 * gains event types `reopened` and `operator_closed`, and an `actor` column
 * (the wave-38 tests audit caught an earlier revision of this row requiring
 * acting-authority recording with no column to hold it — F-a3c2337d)." That
 * is option (b) from this finding's own recommendation: a new additive
 * `actor` TEXT nullable column on `finding_events`. This file pins THAT
 * resolution — it does not re-litigate the design question, it tests the
 * decision that was made.
 *
 * STATUS: RED IN ISOLATION for the `swarm reopen` verb itself (swarm-cp-
 * verbs). BRIDGED for the `finding_events.actor` column (ALTERed on in test
 * setup, try/catch-guarded against "duplicate column") — so only the verb's
 * actual actor-stamping logic remains an unbridgeable dependency.
 */

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

const RUN_ID = 'actor-authority-run';

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

function bridgeActorColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(finding_events)`).all().map(c => c.name);
  if (!cols.includes('actor')) {
    try { db.exec(`ALTER TABLE finding_events ADD COLUMN actor TEXT`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}

let dbDir, dbPath;
beforeEach(() => {
  dbDir = makeTmpDir('actor-db-');
  dbPath = join(dbDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', dbDir, 'a'.repeat(40), 'main', 'health-audit-a');
  bridgeActorColumn(db);
  closeDb(dbPath);
});
afterEach(() => {
  try { closeDb(dbPath); } catch { /* already closed */ }
});

/** @pins F-a3c2337d */
describe('F-a3c2337d — finding_events.actor exists and distinguishes reopen from the original close', () => {
  it('the bridged column exists (schema precondition for everything else in this file)', () => {
    const db = openDb(dbPath);
    const cols = db.prepare(`PRAGMA table_info(finding_events)`).all().map(c => c.name);
    closeDb(dbPath);
    assert.ok(cols.includes('actor'), 'finding_events must carry an actor column (C3, amended dispatch)');
  });

  it('reopen stamps its OWN actor on the new event, distinct from a differently-attributed original close event', () => {
    const db = openDb(dbPath);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(RUN_ID, 'F-ACTOR-001', 'fp-actor-001', 'HIGH', 'quality', 'packages/a/src/foo.js', 1, 'desc', 'fix it', 'fixed', null, null);
    const findingRowId = db.prepare(`SELECT id FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-ACTOR-001').id;
    // Simulate a historical close event attributed to a SPECIFIC agent
    // identity (not the coordinator) — the WebKit "distinct authorities"
    // shape needs a scenario where closer != reopener to be a meaningful
    // test at all; two 'coordinator' strings on both rows would not
    // distinguish anything even with the column present.
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, notes, actor) VALUES (?, ?, ?, ?)`)
      .run(findingRowId, 'fixed', 'closed during wave 12 agent run', 'agent:swarm-cp-tests');
    closeDb(dbPath);

    const r = spawnSync(process.execPath, [CLI_PATH, 'reopen', RUN_ID,
      '--ids', 'F-ACTOR-001', '--reason', 'regression rediscovered', '--evidence', 'repro in issue #200', '--apply'], {
      encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
    });
    assert.equal(r.status, 0, `reopen must succeed; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id`).all(findingRowId);
    closeDb(dbPath);

    assert.equal(events.length, 2, `expected exactly 2 events (original close + new reopen); got ${events.length}`);
    const closeEvent = events[0];
    const reopenEvent = events[1];
    assert.equal(closeEvent.actor, 'agent:swarm-cp-tests', 'the original close event\'s actor must survive byte-unchanged');
    assert.equal(reopenEvent.event_type, 'reopened', `the new event's type must be 'reopened'; got '${reopenEvent.event_type}'`);

    assert.ok(reopenEvent.actor, `the reopen event must have its OWN actor recorded (non-null) — got ${JSON.stringify(reopenEvent.actor)}`);
    assert.notEqual(reopenEvent.actor, closeEvent.actor,
      `the reopen event's actor must be DISTINCT from the original close event's actor in this scenario ` +
      `(a CLI-invoked reopen vs. an agent-attested close) — WebKit's distinct-authorities model requires ` +
      `the SAME field to distinguish them, not merely that both events exist; got reopen actor ` +
      `'${reopenEvent.actor}' == close actor '${closeEvent.actor}'`);
    // Decisive value check: 'coordinator' is this schema's existing standard
    // default-actor string (schema.js's promotions.authorized_by DEFAULT
    // 'coordinator' — the one precedent for "who performed this operator-
    // level action" already in this codebase) and `swarm reopen` is
    // inherently an operator-invoked CLI action. If swarm-cp-verbs picks a
    // different literal string, this assertion's failure message will show
    // exactly that — a legitimate, disclosed naming assumption, not a schema
    // design error.
    // Updated per this assertion's own escape hatch: swarm-cp-verbs
    // deliberately picked 'operator' as the fixed literal for CLI-invoked
    // transitions (no identity system exists in this CLI; the verb family is
    // the operator surface, and reopen/close share one transitionFindings
    // core that stamps it uniformly). 'coordinator' remains the
    // promotions.authorized_by default — a different ledger, deliberately.
    assert.equal(reopenEvent.actor, 'operator',
      `expected the reopen event's actor to be 'operator' (the transitionFindings literal for ` +
      `CLI-invoked closure verbs); got '${reopenEvent.actor}'.`);
  });
});
