/**
 * f-837dcb2f-reopen-close-mutual-compensation.test.js
 *
 * F-837dcb2f [HIGH] — C4 (docs/trajectory-and-closure.dispatch.md) is its own
 * locked property, distinct from C1 (reopen) / C2 (close) individually: both
 * verbs are dry-run-first, idempotent, and MUTUALLY compensate (reopen undoes
 * close; close undoes reopen). This is the workflow-standards
 * NAMED_COMPENSATORS obligation made concrete at the FINDING level for the
 * first time in this package (prior compensators here are worktree/tag-
 * level, e.g. compensateOrphanedSavePointTag).
 *
 * PINNED IDIOM (the finding's own explicit ask): this package has TWO
 * genuinely different dry-run conventions coexisting today —
 *   (i)  redrive.js / revalidate.js / clean.js: default = preview,
 *        `--apply` required to mutate ("Dry-run by default; --apply
 *        required to mutate" — redrive.js's own docstring, read verbatim
 *        before writing this file);
 *   (ii) dispatch.js / adjudicate.js / persist.js: default = mutate,
 *        `--dry-run` suppresses.
 * This file pins convention (i) for reopen/close, per the finding's explicit
 * instruction — NOT a coin flip, a decision this test now makes load-bearing
 * for whichever lane implements the verbs.
 *
 * STATUS: RED IN ISOLATION — neither `swarm reopen` nor `swarm close` exist
 * in this worktree. BRIDGED for the v10 `closure_kind`/`verified_how` findings
 * columns (ALTERed on in test setup, try/catch-guarded), so only the verbs
 * themselves are the unbridgeable dependency, on swarm-cp-verbs.
 *
 * Every dry-run assertion checks the DB state directly (not just an exit
 * code or a hopeful stdout regex) — the load-bearing property is "no
 * mutation without --apply", and that is what actually matters if verbs
 * lands slightly different wording than this file guesses.
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

const RUN_ID = 'mutual-compensation-run';

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

function bridgeV10Columns(db) {
  const cols = db.prepare(`PRAGMA table_info(findings)`).all().map(c => c.name);
  if (!cols.includes('closure_kind')) {
    try { db.exec(`ALTER TABLE findings ADD COLUMN closure_kind TEXT`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  if (!cols.includes('verified_how')) {
    try { db.exec(`ALTER TABLE findings ADD COLUMN verified_how TEXT`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}

function seedFinding(db, findingId, status) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(RUN_ID, findingId, `fp-${findingId.toLowerCase()}`, 'HIGH', 'quality',
    'packages/a/src/foo.js', 1, `${findingId} description`, 'fix it', status, null, null);
  return db.prepare(`SELECT id FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, findingId).id;
}

// Raw spawn helpers — DELIBERATELY do not bake in --apply, since this file's
// whole job is testing the apply/no-apply boundary itself.
function runReopenRaw(dbPath, args) {
  return spawnSync(process.execPath, [CLI_PATH, 'reopen', RUN_ID, ...args], {
    encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
  });
}
function runCloseRaw(dbPath, args) {
  return spawnSync(process.execPath, [CLI_PATH, 'close', RUN_ID, ...args], {
    encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
  });
}

let dbDir, dbPath;
beforeEach(() => {
  dbDir = makeTmpDir('mutcomp-db-');
  dbPath = join(dbDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', dbDir, 'a'.repeat(40), 'main', 'health-audit-a');
  bridgeV10Columns(db);
  closeDb(dbPath);
});
afterEach(() => {
  try { closeDb(dbPath); } catch { /* already closed */ }
});

/** @pins F-837dcb2f */
describe('F-837dcb2f — dry-run-first idiom pin (redrive/revalidate/clean, not dispatch/adjudicate/persist)', () => {
  it('swarm close WITHOUT --apply does not mutate the DB', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-DRY-CLOSE', 'approved');
    closeDb(dbPath);

    const r = runCloseRaw(dbPath, ['--ids', 'F-DRY-CLOSE', '--as', 'fixed', '--reason', 'preview only', '--evidence', 'n/a', '--verified-how', 'self_attested']);
    assert.equal(r.status, 0, `a dry-run preview must not itself be an error; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE id = ?`).get(findingRowId);
    const events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ?`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'approved', `no --apply means NO mutation — status must remain 'approved'; got '${row.status}'`);
    assert.equal(events.length, 0, 'no --apply means zero finding_events rows written');
  });

  it('swarm close WITH --apply mutates the DB', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-APPLY-CLOSE', 'approved');
    closeDb(dbPath);

    const r = runCloseRaw(dbPath, ['--ids', 'F-APPLY-CLOSE', '--as', 'fixed', '--reason', 'apply for real', '--evidence', 'n/a', '--verified-how', 'self_attested', '--apply']);
    assert.equal(r.status, 0, `--apply must succeed; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE id = ?`).get(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'fixed', `--apply must mutate — status must flip to 'fixed'; got '${row.status}'`);
  });

  it('swarm reopen WITHOUT --apply does not mutate the DB', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-DRY-REOPEN', 'fixed');
    closeDb(dbPath);

    const r = runReopenRaw(dbPath, ['--ids', 'F-DRY-REOPEN', '--reason', 'preview only', '--evidence', 'n/a']);
    assert.equal(r.status, 0, `a dry-run preview must not itself be an error; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE id = ?`).get(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'fixed', `no --apply means NO mutation — status must remain 'fixed'; got '${row.status}'`);
  });

  it('swarm reopen WITH --apply mutates the DB', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-APPLY-REOPEN', 'fixed');
    closeDb(dbPath);

    const r = runReopenRaw(dbPath, ['--ids', 'F-APPLY-REOPEN', '--reason', 'apply for real', '--evidence', 'n/a', '--apply']);
    assert.equal(r.status, 0, `--apply must succeed; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE id = ?`).get(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'recurring', `--apply must mutate — status must flip to 'recurring'; got '${row.status}'`);
  });
});

describe('F-837dcb2f — same-args-twice idempotency, per verb', () => {
  it('close applied twice with identical args produces ONE event, not two (finding already closed the 2nd time)', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-IDEMP-CLOSE', 'approved');
    closeDb(dbPath);

    const args = ['--ids', 'F-IDEMP-CLOSE', '--as', 'fixed', '--reason', 'idempotency check', '--evidence', 'n/a', '--verified-how', 'self_attested', '--apply'];
    const first = runCloseRaw(dbPath, args);
    assert.equal(first.status, 0, `first close must succeed; stderr:\n${first.stderr}`);
    const second = runCloseRaw(dbPath, args);
    // Mirrors disposeFindings' own precedent (verified against cli.js before
    // writing this test): a redundant close on an already-terminal status is
    // a SILENT 0-changes success, not a loud refusal.
    assert.equal(second.status, 0, `second (redundant) close must also exit 0 (silent no-op, not a refusal); stderr:\n${second.stderr}`);

    const db2 = openDb(dbPath);
    const events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ?`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(events.length, 1, `exactly ONE close event must exist after applying identical args twice; got ${events.length}`);
  });

  it('reopen applied twice with identical args produces ONE event, not two (2nd call is refused — finding is open again)', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-IDEMP-REOPEN', 'fixed');
    closeDb(dbPath);

    const args = ['--ids', 'F-IDEMP-REOPEN', '--reason', 'idempotency check', '--evidence', 'n/a', '--apply'];
    const first = runReopenRaw(dbPath, args);
    assert.equal(first.status, 0, `first reopen must succeed; stderr:\n${first.stderr}`);
    const second = runReopenRaw(dbPath, args);
    // Unlike close, C1 requires an OPEN-source reopen to be REFUSED LOUDLY
    // (F-a3af1ac5) — the finding is 'recurring' (open) after the first call,
    // so the second identical call must be a loud refusal, not a silent
    // no-op. "Idempotent" here means the STATE converges (one event, no
    // further mutation), not that the second CALL itself is silently ok.
    assert.notEqual(second.status, 0, `second reopen call (against an already-open finding) must be refused; got exit 0`);

    const db2 = openDb(dbPath);
    const events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ?`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(events.length, 1, `exactly ONE reopen event must exist — the refused 2nd call must not append another`);
  });
});

describe('F-837dcb2f — close -> reopen -> close -> reopen convergence', () => {
  it('the finding row converges to a fresh-never-closed baseline (except accumulated event rows) across a full cycle', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-SEQ-001', 'new');
    const baseline = db.prepare(`SELECT finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation FROM findings WHERE id = ?`).get(findingRowId);
    closeDb(dbPath);

    // Step 1: close as fixed, verified independently.
    let r = runCloseRaw(dbPath, ['--ids', 'F-SEQ-001', '--as', 'fixed', '--reason', 'closing step 1', '--evidence', 'evidence 1', '--verified-how', 'independent', '--apply']);
    assert.equal(r.status, 0, `step 1 close must succeed; stderr:\n${r.stderr}`);
    let db2 = openDb(dbPath);
    let row = db2.prepare(`SELECT status, closure_kind, verified_how FROM findings WHERE id = ?`).get(findingRowId);
    let events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'fixed', 'step 1: status must be fixed');
    assert.equal(row.verified_how, 'independent', 'step 1: verified_how must be persisted');
    assert.equal(events.length, 1, 'step 1: exactly one event');
    assert.equal(events[0].event_type, 'fixed', 'step 1: event type must be fixed');
    const event1 = events[0];

    // Step 2: reopen.
    r = runReopenRaw(dbPath, ['--ids', 'F-SEQ-001', '--reason', 'reopening step 2', '--evidence', 'evidence 2', '--apply']);
    assert.equal(r.status, 0, `step 2 reopen must succeed; stderr:\n${r.stderr}`);
    db2 = openDb(dbPath);
    row = db2.prepare(`SELECT status, closure_kind, verified_how FROM findings WHERE id = ?`).get(findingRowId);
    events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'recurring', 'step 2: status must be recurring (C1\'s reopen target)');
    assert.equal(row.closure_kind ?? null, null, 'step 2: reopen must RESET closure_kind — the finding is open again');
    assert.equal(row.verified_how ?? null, null, 'step 2: reopen must RESET verified_how — the finding is open again');
    assert.equal(events.length, 2, 'step 2: exactly two events total');
    assert.deepEqual(events[0], event1, 'step 2: the ORIGINAL close event must survive byte-unchanged');
    assert.equal(events[1].event_type, 'reopened', 'step 2: new event type must be reopened');
    const event2 = events[1];

    // Identity fields must be untouched by close/reopen at every step.
    const dbIdentity2 = openDb(dbPath);
    const identityCheck = dbIdentity2.prepare(`SELECT finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation FROM findings WHERE id = ?`).get(findingRowId);
    closeDb(dbPath);
    assert.deepEqual(identityCheck, baseline, 'step 2: identity fields must match the fresh-never-closed baseline exactly');

    // Step 3: close again — a SECOND operator closure with a different
    // verified_how. (This step's draft used `--as rejected`, written against
    // the pass contract's pre-dispute enum; the accepted contract narrows
    // close to 'fixed' only — rejected/deferred belong to their own verbs,
    // and reopen-from-rejected is pinned by the C1 transition-matrix suite.)
    r = runCloseRaw(dbPath, ['--ids', 'F-SEQ-001', '--as', 'fixed', '--reason', 'closing step 3', '--evidence', 'evidence 3', '--verified-how', 'self_attested', '--apply']);
    assert.equal(r.status, 0, `step 3 close must succeed; stderr:\n${r.stderr}`);
    db2 = openDb(dbPath);
    row = db2.prepare(`SELECT status, verified_how FROM findings WHERE id = ?`).get(findingRowId);
    events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'fixed', 'step 3: status must be fixed');
    assert.equal(row.verified_how, 'self_attested', 'step 3: verified_how must be persisted for the new closure');
    assert.equal(events.length, 3, 'step 3: exactly three events total');
    assert.deepEqual(events[0], event1, 'step 3: event 1 (original close) must still be byte-unchanged');
    assert.deepEqual(events[1], event2, 'step 3: event 2 (first reopen) must still be byte-unchanged');
    assert.equal(events[2].event_type, 'fixed', 'step 3: new event type must mirror the closure status');

    // Step 4: reopen again — convergence check.
    r = runReopenRaw(dbPath, ['--ids', 'F-SEQ-001', '--reason', 'reopening step 4', '--evidence', 'evidence 4', '--apply']);
    assert.equal(r.status, 0, `step 4 reopen must succeed; stderr:\n${r.stderr}`);
    db2 = openDb(dbPath);
    row = db2.prepare(`SELECT status, closure_kind, verified_how FROM findings WHERE id = ?`).get(findingRowId);
    events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id`).all(findingRowId);
    const finalIdentity = db2.prepare(`SELECT finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation FROM findings WHERE id = ?`).get(findingRowId);
    closeDb(dbPath);

    assert.equal(row.status, 'recurring', 'step 4: status must converge back to recurring');
    assert.equal(row.closure_kind ?? null, null, 'step 4: closure_kind must be reset again');
    assert.equal(row.verified_how ?? null, null, 'step 4: verified_how must be reset again');
    assert.equal(events.length, 4, 'step 4: exactly four events total — never edited in place, always appended');
    assert.equal(events[3].event_type, 'reopened', 'step 4: final event type must be reopened');
    assert.deepEqual(finalIdentity, baseline,
      'step 4: after a full close->reopen->close->reopen cycle, identity fields must STILL match the ' +
      'fresh-never-closed baseline exactly — only status/closure fields and the event log may differ');
  });
});
