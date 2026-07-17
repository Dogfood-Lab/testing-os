/**
 * f-a3af1ac5-reopen-transition-matrix.test.js
 *
 * F-a3af1ac5 [HIGH] — C1 (docs/trajectory-and-closure.dispatch.md) pins
 * `swarm reopen`'s full transition matrix before the verb exists:
 *
 *   - fixed|deferred|rejected -> recurring is the ONLY legal transition.
 *   - Reopening an already-OPEN finding (new/recurring/approved/unverified)
 *     is REFUSED LOUDLY, never silently no-op'd (this repo's ethos rejects
 *     silent success as a category).
 *   - Missing --reason and missing --evidence each independently refuse.
 *     --evidence is the deliberate DELTA from the sibling defer/reject verbs
 *     (cli.js's disposeFindings requires only --reason) — this file asserts
 *     --evidence is REQUIRED for reopen and says nothing about defer/reject.
 *   - The prior closure event survives UNMODIFIED in finding_events while a
 *     NEW 'reopened' event is appended (never edit-in-place — T5's supersede-
 *     only ethos applied at the row level).
 *
 * Modeled directly on wave-state-machine.test.js's structure: transition-
 * table exhaustiveness (one hand-written `it()` per source state, never a
 * loop that could hide which case failed) + a Pattern #10-style static scan.
 *
 * STATUS split:
 *
 *   The transition-matrix / --reason / --evidence / event-immutability
 *   describe blocks are RED IN ISOLATION — `swarm reopen` does not exist in
 *   this worktree (cli.js's `commands` map has no 'reopen' key as of this
 *   write). Needed from swarm-cp-verbs: `swarm reopen <run-id> --ids
 *   F-001,F-002 --reason "<text>" --evidence "<text>"`. Every assertion below
 *   checks SPECIFIC stderr content (never a bare exit code) precisely because
 *   today's actual output — "Unknown command: 'reopen'." — always exits 1
 *   regardless of finding status, so a bare exit-code check would pass
 *   vacuously for the OPEN-source refusal cases (which SHOULD exit non-zero)
 *   for the wrong reason.
 *
 *   The Pattern #10 static-scan describe block at the bottom is GREEN TODAY —
 *   it pins a real, already-true invariant over the CURRENT writer
 *   population (grep confirms `lib/fingerprint.js` is the only file that
 *   raw-writes `UPDATE findings SET status = 'recurring'` anywhere in the
 *   package right now) and is expected to correctly flip red the moment
 *   swarm-cp-verbs lands the reopen verb's implementation file — see that
 *   describe block's own comment for why that is the intended mechanism, not
 *   a defect in this test.
 */

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { stripComments } from './test-support/strip-comments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');
const PKG_DIR = __dirname;

const RUN_ID = 'reopen-tm-run';

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

/**
 * Seeds one finding at the given status, optionally with a single prior
 * finding_events row (the "original close event") so event-immutability can
 * be checked after a reopen. Returns the findings.id (row id, not
 * finding_id) for direct finding_events queries.
 */
function seedFinding(db, findingId, status, priorEvent) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(RUN_ID, findingId, `fp-${findingId.toLowerCase()}`, 'HIGH', 'quality',
    `packages/a/src/${findingId}.js`, 1, `${findingId} description`, 'fix it', status, null, null);
  const row = db.prepare(`SELECT id FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, findingId);
  if (priorEvent) {
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, notes) VALUES (?, ?, ?)`)
      .run(row.id, priorEvent.event_type, priorEvent.notes);
  }
  return row.id;
}

/**
 * F-837dcb2f pins reopen/close to the redrive.js/revalidate.js/clean.js
 * dry-run idiom: default = preview (no mutation), `--apply` = mutate. Every
 * call site in THIS file is testing the transition/refusal CONTRACT, not the
 * dry-run mechanics themselves (that is
 * f-837dcb2f-reopen-close-mutual-compensation.test.js's job), so `--apply` is
 * baked into this helper unconditionally — omitting it here would make every
 * "status flips to X" assertion below fail against a CORRECTLY-implemented
 * verb, since a bare invocation would then be a no-op preview by design.
 */
function runReopen(dbPath, args) {
  return spawnSync(process.execPath, [CLI_PATH, 'reopen', RUN_ID, ...args, '--apply'], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

let dbDir, dbPath;
beforeEach(() => {
  dbDir = makeTmpDir('reopen-tm-db-');
  dbPath = join(dbDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', dbDir, 'a'.repeat(40), 'main', 'health-audit-a');
  closeDb(dbPath);
});
afterEach(() => {
  try { closeDb(dbPath); } catch { /* already closed */ }
});

/** @pins F-a3af1ac5 */
describe('F-a3af1ac5 — swarm reopen: CLOSED sources are reopenable', () => {
  it('fixed -> recurring is ALLOWED', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-FIXED', 'fixed', { event_type: 'fixed', notes: 'original fix landed' });
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-FIXED', '--reason', 'regression seen again', '--evidence', 'CI run #42 failed the same assertion']);
    assert.equal(r.status, 0, `fixed source must be reopenable; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RO-FIXED');
    closeDb(dbPath);
    assert.equal(row.status, 'recurring', `status must flip to 'recurring'; got '${row.status}'`);
  });

  it('deferred -> recurring is ALLOWED', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-DEFERRED', 'deferred', { event_type: 'deferred', notes: 'accepted for now' });
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-DEFERRED', '--reason', 'no longer acceptable to defer', '--evidence', 'incident INC-501 traced to this']);
    assert.equal(r.status, 0, `deferred source must be reopenable; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RO-DEFERRED');
    closeDb(dbPath);
    assert.equal(row.status, 'recurring', `status must flip to 'recurring'; got '${row.status}'`);
  });

  it('rejected -> recurring is ALLOWED', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-REJECTED', 'rejected', { event_type: 'rejected', notes: 'triaged as not-a-defect' });
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-REJECTED', '--reason', 'it was in fact a real defect', '--evidence', 'repro attached in issue #88']);
    assert.equal(r.status, 0, `rejected source must be reopenable; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RO-REJECTED');
    closeDb(dbPath);
    assert.equal(row.status, 'recurring', `status must flip to 'recurring'; got '${row.status}'`);
  });
});

describe('F-a3af1ac5 — swarm reopen: OPEN sources are refused loudly, never silently no-op\'d', () => {
  it('new -> reopen is REFUSED', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-RO-NEW', 'new');
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-NEW', '--reason', 'trying to reopen an open finding', '--evidence', 'n/a']);
    assert.notEqual(r.status, 0, `reopening a 'new' (already-open) finding must be refused; got exit 0`);
    assert.match(r.stderr, /not closed|already open|not eligible|cannot reopen/i,
      `refusal must explain WHY (not closed), not just fail generically; got stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE id = ?`).get(findingRowId);
    const events = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ?`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(row.status, 'new', `status must remain 'new' after a refused reopen`);
    assert.equal(events.length, 0, `a refused reopen must not append any finding_events row`);
  });

  it('recurring -> reopen is REFUSED', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-RECURRING', 'recurring');
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-RECURRING', '--reason', 'trying to reopen an open finding', '--evidence', 'n/a']);
    assert.notEqual(r.status, 0, `reopening a 'recurring' (already-open) finding must be refused; got exit 0`);
    assert.match(r.stderr, /not closed|already open|not eligible|cannot reopen/i,
      `refusal must explain WHY, not just fail generically; got stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RO-RECURRING');
    closeDb(dbPath);
    assert.equal(row.status, 'recurring', `status must remain unchanged after a refused reopen`);
  });

  it('approved -> reopen is REFUSED', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-APPROVED', 'approved');
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-APPROVED', '--reason', 'trying to reopen an open finding', '--evidence', 'n/a']);
    assert.notEqual(r.status, 0, `reopening an 'approved' (already-open) finding must be refused; got exit 0`);
    assert.match(r.stderr, /not closed|already open|not eligible|cannot reopen/i,
      `refusal must explain WHY, not just fail generically; got stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RO-APPROVED');
    closeDb(dbPath);
    assert.equal(row.status, 'approved', `status must remain unchanged after a refused reopen`);
  });

  it('unverified -> reopen is REFUSED', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-UNVERIFIED', 'unverified');
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-UNVERIFIED', '--reason', 'trying to reopen an open finding', '--evidence', 'n/a']);
    assert.notEqual(r.status, 0, `reopening an 'unverified' (already-open) finding must be refused; got exit 0`);
    assert.match(r.stderr, /not closed|already open|not eligible|cannot reopen/i,
      `refusal must explain WHY, not just fail generically; got stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RO-UNVERIFIED');
    closeDb(dbPath);
    assert.equal(row.status, 'unverified', `status must remain unchanged after a refused reopen`);
  });
});

describe('F-a3af1ac5 — swarm reopen: --reason and --evidence are BOTH independently required', () => {
  it('missing --reason is refused', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-NOREASON', 'fixed', { event_type: 'fixed', notes: 'closed' });
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-NOREASON', '--evidence', 'some evidence']);
    assert.notEqual(r.status, 0, 'missing --reason must be refused');
    assert.match(r.stderr, /--reason/, `refusal must name --reason specifically; got stderr:\n${r.stderr}`);
  });

  it('missing --evidence is refused (the deliberate delta from defer/reject, which require only --reason)', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-RO-NOEVIDENCE', 'fixed', { event_type: 'fixed', notes: 'closed' });
    closeDb(dbPath);

    const r = runReopen(dbPath, ['--ids', 'F-RO-NOEVIDENCE', '--reason', 'seen again']);
    assert.notEqual(r.status, 0, 'missing --evidence must be refused');
    assert.match(r.stderr, /--evidence/, `refusal must name --evidence specifically; got stderr:\n${r.stderr}`);
  });
});

describe('F-a3af1ac5 — swarm reopen: append-only event discipline', () => {
  it('reopening a fixed finding appends a NEW "reopened" event while the ORIGINAL close event survives byte-unchanged', () => {
    const db = openDb(dbPath);
    const findingRowId = seedFinding(db, 'F-RO-IMMUT', 'fixed', { event_type: 'fixed', notes: 'original fix landed in wave 3' });
    const before = db.prepare(`SELECT * FROM finding_events WHERE finding_id = ?`).all(findingRowId);
    closeDb(dbPath);
    assert.equal(before.length, 1, 'fixture precondition: exactly one prior close event');
    const originalEvent = before[0];

    const r = runReopen(dbPath, ['--ids', 'F-RO-IMMUT', '--reason', 'regression rediscovered', '--evidence', 'repro steps in issue #77']);
    assert.equal(r.status, 0, `reopen of a fixed finding must succeed; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const after = db2.prepare(`SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id`).all(findingRowId);
    closeDb(dbPath);

    assert.equal(after.length, 2, `exactly one NEW event must be appended (never edited in place); got ${after.length} row(s)`);
    const stillOriginal = after.find(e => e.id === originalEvent.id);
    assert.ok(stillOriginal, 'the original close event row must still exist by id');
    assert.deepEqual(stillOriginal, originalEvent, 'the ORIGINAL close event row must be byte-unchanged after reopen');
    const newEvent = after.find(e => e.id !== originalEvent.id);
    assert.ok(newEvent, 'a new event row must exist');
    assert.equal(newEvent.event_type, 'reopened', `the new event's type must be 'reopened'; got '${newEvent.event_type}'`);
  });
});

/**
 * Walk the dogfood-swarm package recursively, returning non-test JS source
 * files. Mirrors wave-state-machine.test.js's Pattern #10 walker: test files
 * are out of scope for a PRODUCTION-writer invariant (fixture setup
 * legitimately writes raw SQL for its own seeding).
 */
function* walkJs(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'swarms' || entry === '.swarm') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkJs(full);
    } else if (st.isFile() && /\.(js|mjs|cjs)$/.test(entry) && !/\.test\.(js|mjs|cjs)$/.test(entry)) {
      yield full;
    }
  }
}

describe('F-a3af1ac5 — Pattern #10 invariant: raw `recurring` writers', () => {
  it('no file outside the approved writer set sets findings.status to \'recurring\' via raw SQL', () => {
    // Approved writers, TODAY: only the existing content-match auto-
    // rediscovery path (lib/fingerprint.js — F-130dee59, explicitly named as
    // STAYING, not a new gap, in docs/trajectory-and-closure.dispatch.md's
    // refusals section: "one auto-reopen already exists by design"). Once
    // swarm-cp-verbs lands `swarm reopen`'s implementation file, add its path
    // here IN THE SAME COMMIT — this test is EXPECTED to go red the moment
    // that file exists and isn't yet allowlisted; that is Pattern #10 working
    // as designed (a deliberate, reviewed allowlist update), not a bug in
    // this test.
    const APPROVED_RECURRING_WRITERS = ['lib/fingerprint.js'];

    const rawWriteRe = /UPDATE\s+findings\s+SET\s+[^;]*\bstatus\s*=\s*'recurring'/i;
    const offenders = [];
    for (const file of walkJs(PKG_DIR)) {
      const relFromPkg = relative(PKG_DIR, file).replace(/\\/g, '/');
      if (APPROVED_RECURRING_WRITERS.includes(relFromPkg)) continue;

      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (rawWriteRe.test(lines[i])) {
          offenders.push(`${relFromPkg}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Pattern #10 violation — raw \`UPDATE findings SET status = 'recurring'\` outside the approved ` +
      `writer set ${JSON.stringify(APPROVED_RECURRING_WRITERS)}:\n` + offenders.map(o => `  ${o}`).join('\n')
    );
  });
});
