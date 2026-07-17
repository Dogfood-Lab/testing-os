/**
 * wave39-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 39 (feature-execute) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — no OWNED domain's globs match
 * `packages/dogfood-swarm/*.test.js` (swarm-cp-verbs owns only `commands/**`
 * + `cli.js`), so resolveExclusiveOwner returns null and checkOwnership's
 * bridge fallback grants ANY calling domain a valid claim — the same
 * rationale wave2/4/6/8/10/12/14/18/29/31/35's own pin files already
 * established for this identical situation.
 *
 * SEAM (state explicitly, per this wave's brief): `closure_kind` / `verified_how`
 * (findings) and `actor` (finding_events) are v10-migration columns (C3,
 * docs/trajectory-and-closure.dispatch.md). swarm-cp-core lands the real
 * ALTERs in its OWN worktree this same wave — this worktree's schema is
 * still v9 (db/schema.js SCHEMA_VERSION=9 here). `withV10Columns()` below
 * applies the SAME three ALTERs in a try/catch (a no-op once the real
 * migration lands at merge — "ALTER on an existing column" throws and is
 * swallowed), so these tests are GREEN in this worktree today AND remain
 * green post-merge. This is the wave-35 cli-smoke / wave-31-family
 * red-in-isolation/green-at-merge precedent this run has already proven.
 *
 * F-8595faf8 (CRITICAL) — `swarm reopen`: fixed|deferred|rejected -> recurring.
 * F-5164d456 (HIGH)     — `swarm close`: new|recurring|approved|unverified -> fixed.
 * F-29640f0b (HIGH)     — every reason/evidence/file_path render in both verbs'
 *                          text output is escaped (control bytes, ANSI, bidi).
 * F-338c8c46 (HIGH)     — T1's CLI surface, `swarm roadmap compile|show`. The
 *                          note-validation half (commands/lib/roadmap-notes.js)
 *                          has NO dependency on core's not-yet-real
 *                          lib/roadmap/compiler.js and is tested for real,
 *                          fully green, below. commands/roadmap.js itself
 *                          (the glue that DOES import that module) is
 *                          red-in-isolation until swarm-cp-core's merge —
 *                          not unit-tested here; see that file's own header
 *                          for the exact contract it is coded against.
 *
 * Both verbs share ONE transition core (transitionFindings, exported from
 * cli.js per this file's own F-264ab3aa-style testability precedent) — most
 * assertions below exercise that shared function directly (fast, in-process,
 * no subprocess spawn) plus a handful of real `runCli` subprocess smoke tests
 * for the argv-validation layer (process.exit paths transitionFindings itself
 * never takes).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import {
  commands, USAGE,
  transitionFindings, formatTransitionReport,
  CLOSE_SOURCE_STATUSES, VERIFIED_HOW_VALUES,
} from './cli.js';
import { CLOSED_FINDING_STATUSES } from './lib/finding-status.js';
import {
  readOperatorNotes, splitExpiredNotes, roadmapError,
  MAX_OPERATOR_NOTES, NOTE_KINDS,
} from './commands/lib/roadmap-notes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

/**
 * Applies the LOCKED v10 spec's three ALTERs (C3) to an already-opened v9
 * handle. Guarded per-statement: once core's real migration has landed (at
 * merge, or in any future run against this same worktree), each ALTER
 * throws "duplicate column name" and is swallowed — this function becomes a
 * no-op, not a failure. Never touches finding_events' event_type vocabulary
 * (C3: "the event types are JS-constant updates, not schema DDL").
 */
function withV10Columns(db) {
  for (const stmt of [
    'ALTER TABLE findings ADD COLUMN closure_kind TEXT',
    'ALTER TABLE findings ADD COLUMN verified_how TEXT',
    'ALTER TABLE findings ADD COLUMN filed_by_domain TEXT',
    'ALTER TABLE finding_events ADD COLUMN actor TEXT',
  ]) {
    try { db.exec(stmt); } catch { /* already migrated (v10 landed) — no-op */ }
  }
  return db;
}

function seedRun(db, runId = 'r1') {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
  ).run(runId);
  return { runId, waveId: Number(wave.lastInsertRowid) };
}

let seq = 0;
function seedFinding(db, runId, waveId, { status, severity = 'HIGH', filePath = 'src/a.js', description = 'a bug' }) {
  seq += 1;
  const findingId = `F-${String(seq).padStart(8, '0')}`;
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, 'bug', ?, ?, ?, ?, ?)
  `).run(runId, findingId, `fp-${findingId}`, severity, filePath, description, status, waveId, waveId);
  return findingId;
}

/** @pins F-8595faf8, F-5164d456 */
describe('F-8595faf8/F-5164d456 — transitionFindings (shared C1/C2 core)', () => {
  let tmp, dbPath, db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave39-transition-'));
    dbPath = join(tmp, 'control-plane.db');
    db = withV10Columns(openDb(dbPath));
  });

  afterEach(() => {
    closeDb(dbPath); // Windows EBUSY on a locked .db if closed after rmSync
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reopen: DRY-RUN makes no DB change and reports the eligible row without flipping it', () => {
    const { runId, waveId } = seedRun(db);
    const fid = seedFinding(db, runId, waveId, { status: 'fixed', severity: 'CRITICAL' });

    const report = transitionFindings({
      verb: 'reopen',
      sourceStatuses: CLOSED_FINDING_STATUSES,
      targetStatus: 'recurring',
      eventType: 'reopened',
      extraSetColumns: { closure_kind: null, verified_how: null },
      buildNotes: (r, e) => `reason: ${r} | evidence: ${e}`,
    }, { runId, ids: [fid], reason: 'wrongly closed', evidence: 'repro still fails', apply: false, dbPath });

    assert.equal(report.dryRun, true);
    assert.equal(report.flipped, 0);
    assert.equal(report.eligible.length, 1);
    assert.equal(report.eligible[0].finding_id, fid);
    assert.equal(report.eligible[0].status, 'fixed');

    const row = db.prepare('SELECT status FROM findings WHERE finding_id = ?').get(fid);
    assert.equal(row.status, 'fixed', 'dry-run must not mutate the row');
    const events = db.prepare('SELECT * FROM finding_events').all();
    assert.equal(events.length, 0, 'dry-run must not write any finding_events row');
  });

  for (const sourceStatus of ['fixed', 'deferred', 'rejected']) {
    it(`reopen --apply: a '${sourceStatus}' finding flips to 'recurring', resets closure_kind/verified_how, and writes a 'reopened' event with actor='operator'`, () => {
      const { runId, waveId } = seedRun(db);
      const fid = seedFinding(db, runId, waveId, { status: sourceStatus, severity: 'HIGH' });
      // Simulate a real prior closure so the reset is observable.
      db.prepare("UPDATE findings SET closure_kind = 'declared', verified_how = 'self_attested' WHERE finding_id = ?").run(fid);
      const priorEvent = db.prepare(
        "INSERT INTO finding_events (finding_id, event_type, notes) SELECT id, 'fixed', 'original closure' FROM findings WHERE finding_id = ?"
      ).run(fid);

      const report = transitionFindings({
        verb: 'reopen',
        sourceStatuses: CLOSED_FINDING_STATUSES,
        targetStatus: 'recurring',
        eventType: 'reopened',
        extraSetColumns: { closure_kind: null, verified_how: null },
        buildNotes: (r, e) => `reason: ${r} | evidence: ${e}`,
      }, { runId, ids: [fid], reason: 'wrongly closed', evidence: 'repro still fails', apply: true, dbPath });

      assert.equal(report.flipped, 1);

      const row = db.prepare('SELECT status, closure_kind, verified_how FROM findings WHERE finding_id = ?').get(fid);
      assert.equal(row.status, 'recurring');
      assert.equal(row.closure_kind, null, 'closure_kind must reset to NULL on reopen');
      assert.equal(row.verified_how, null, 'verified_how must reset to NULL on reopen');

      const events = db.prepare('SELECT * FROM finding_events ORDER BY id').all();
      assert.equal(events.length, 2, 'the prior closure event must survive untouched, plus one new reopened event');
      assert.equal(events[0].id, priorEvent.lastInsertRowid, 'prior event row is never rewritten (append-only)');
      assert.equal(events[0].event_type, 'fixed');
      assert.equal(events[0].notes, 'original closure', 'prior closure event content is untouched');
      assert.equal(events[1].event_type, 'reopened');
      assert.equal(events[1].actor, 'operator');
      assert.match(events[1].notes, /reason: wrongly closed \| evidence: repro still fails/);
    });
  }

  it('reopen: a finding whose status is NOT in fixed|deferred|rejected is reported ineligible and left untouched', () => {
    const { runId, waveId } = seedRun(db);
    const fid = seedFinding(db, runId, waveId, { status: 'approved' });

    const report = transitionFindings({
      verb: 'reopen',
      sourceStatuses: CLOSED_FINDING_STATUSES,
      targetStatus: 'recurring',
      eventType: 'reopened',
      extraSetColumns: { closure_kind: null, verified_how: null },
      buildNotes: (r, e) => `reason: ${r} | evidence: ${e}`,
    }, { runId, ids: [fid], reason: 'x', evidence: 'y', apply: true, dbPath });

    assert.equal(report.flipped, 0);
    assert.equal(report.eligible.length, 0);
    assert.equal(report.ineligible.length, 1);
    assert.match(report.ineligible[0].note, /not eligible for reopen/);
    const row = db.prepare('SELECT status FROM findings WHERE finding_id = ?').get(fid);
    assert.equal(row.status, 'approved', 'an ineligible row must never be mutated');
  });

  it('reopen: an id matching NOTHING in this run reports zero eligible AND zero ineligible (the true zero-existence signal)', () => {
    const { runId } = seedRun(db);
    const report = transitionFindings({
      verb: 'reopen',
      sourceStatuses: CLOSED_FINDING_STATUSES,
      targetStatus: 'recurring',
      eventType: 'reopened',
      extraSetColumns: { closure_kind: null, verified_how: null },
      buildNotes: (r, e) => `reason: ${r} | evidence: ${e}`,
    }, { runId, ids: ['F-DOESNOTEXIST'], reason: 'x', evidence: 'y', apply: true, dbPath });

    assert.equal(report.eligible.length, 0);
    assert.equal(report.ineligible.length, 0);
    assert.equal(report.flipped, 0);
  });

  it("close --apply: an open finding flips to 'fixed', persists closure_kind='operator' + the supplied verified_how, and writes a 'fixed' event (event_type mirrors --as, as cmdClose does in production; 'operator_closed' is a reserved, never-written EVENT_TYPES member)", () => {
    const { runId, waveId } = seedRun(db);
    const fid = seedFinding(db, runId, waveId, { status: 'approved', severity: 'MEDIUM' });

    const report = transitionFindings({
      verb: 'close',
      sourceStatuses: CLOSE_SOURCE_STATUSES,
      targetStatus: 'fixed',
      eventType: 'fixed',
      extraSetColumns: { closure_kind: 'operator', verified_how: 'independent' },
      buildNotes: (r, e) => `reason: ${r} | evidence: ${e} | verified_how: independent`,
    }, { runId, ids: [fid], reason: 'unowned file, director-directed disposal', evidence: 'confirmed by reviewer', apply: true, dbPath });

    assert.equal(report.flipped, 1);
    const row = db.prepare('SELECT status, closure_kind, verified_how FROM findings WHERE finding_id = ?').get(fid);
    assert.equal(row.status, 'fixed');
    assert.equal(row.closure_kind, 'operator');
    assert.equal(row.verified_how, 'independent');

    const events = db.prepare('SELECT * FROM finding_events').all();
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'fixed');
    assert.equal(events[0].actor, 'operator');
    assert.match(events[0].notes, /verified_how: independent/);
  });

  it('CLOSE_SOURCE_STATUSES matches disposeFindings\' own open-status predicate exactly (reuse, not refork)', () => {
    assert.deepEqual([...CLOSE_SOURCE_STATUSES].sort(), ['approved', 'new', 'recurring', 'unverified'].sort());
  });

  it('VERIFIED_HOW_VALUES is exactly the three-value enum the dispatch contract names', () => {
    assert.deepEqual([...VERIFIED_HOW_VALUES].sort(), ['independent', 'operator_evidence', 'self_attested'].sort());
  });
});

// ──────────────────────────────────────────────────────────────
// F-29640f0b — escaping: every text render of reason/evidence/file_path
// ──────────────────────────────────────────────────────────────

/** @pins F-29640f0b */
describe('F-29640f0b — formatTransitionReport escapes reason/evidence/file_path, --format=json stays lossless', () => {
  const ANSI_PAYLOAD = '\x1b[1A\x1b[2K\rFORGED ROW';
  const NEWLINE_PAYLOAD = 'legit reason\n[FAKE] F-999  fixed -> recurring';

  it('a control-byte/ANSI payload in --reason renders escaped in the TEXT report, never raw', () => {
    const report = {
      verb: 'reopen', runId: 'r1', targetStatus: 'recurring', dryRun: true, apply: false,
      ids: ['F-1'], reason: ANSI_PAYLOAD, evidence: 'plain evidence',
      eligible: [{ finding_id: 'F-1', status: 'fixed', severity: 'HIGH', file_path: 'src/a.js' }],
      ineligible: [], flipped: 0, summary: null,
    };
    const text = formatTransitionReport(report);
    assert.ok(!text.includes('\x1b'), 'raw ESC byte must never reach the text render');
    assert.match(text, /\\x1b/, 'the ESC byte must render as its visible \\xHH escape');
  });

  it('an embedded newline in --evidence cannot forge a fake finding row in the TEXT report', () => {
    const report = {
      verb: 'close', runId: 'r1', targetStatus: 'fixed', dryRun: true, apply: false,
      ids: ['F-1'], reason: 'ok', evidence: NEWLINE_PAYLOAD,
      eligible: [{ finding_id: 'F-1', status: 'approved', severity: 'HIGH', file_path: null }],
      ineligible: [], flipped: 0, summary: null,
    };
    const text = formatTransitionReport(report);
    const lines = text.split('\n');
    assert.ok(!lines.some(l => /^\[FAKE\] F-999/.test(l)), 'a literal newline in --evidence must not start a new, attacker-shaped line');
    assert.match(text, /legit reason\\n\[FAKE\]/, 'the newline renders as the visible \\n escape, not a real line break');
  });

  it('a zero-privilege file_path is escaped via escapePathForDisplay in the eligible-row render', () => {
    const report = {
      verb: 'reopen', runId: 'r1', targetStatus: 'recurring', dryRun: true, apply: false,
      ids: ['F-1'], reason: 'r', evidence: 'e',
      eligible: [{ finding_id: 'F-1', status: 'fixed', severity: 'HIGH', file_path: 'src/\x1b[31mnot-a-real-color\x1b[0m.js' }],
      ineligible: [], flipped: 0, summary: null,
    };
    const text = formatTransitionReport(report);
    assert.ok(!text.includes('\x1b'), 'raw ESC in file_path must never reach the text render');
  });

  it('PRECISION GUARD: an ordinary reason/evidence pair with no control bytes renders unchanged', () => {
    const report = {
      verb: 'close', runId: 'r1', targetStatus: 'fixed', dryRun: false, apply: true,
      ids: ['F-1'], reason: 'unowned file', evidence: 'confirmed by reviewer',
      eligible: [{ finding_id: 'F-1', status: 'approved', severity: 'HIGH', file_path: 'src/a.js' }],
      ineligible: [], flipped: 1, summary: null,
    };
    const text = formatTransitionReport(report);
    assert.match(text, /Reason:   "unowned file"/);
    assert.match(text, /Evidence: "confirmed by reviewer"/);
    assert.match(text, /src\/a\.js/);
  });
});

// ──────────────────────────────────────────────────────────────
// CLI argv-validation layer — real subprocess (process.exit paths
// transitionFindings itself never takes)
// ──────────────────────────────────────────────────────────────

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

describe('reopen/close CLI argv validation (subprocess)', () => {
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave39-cli-'));
    dbPath = join(tmp, 'control-plane.db');
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* not opened by this test */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('reopen: missing --evidence exits 1 and cites the Class #14 pin-matcher lesson', () => {
    const r = runCli(['reopen', 'r1', '--ids', 'F-1', '--reason', 'x'], dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--evidence "<text>" is required/);
    assert.match(r.stderr, /Class #14 rewrite/);
  });

  it('close: missing --verified-how exits 1 naming the required enum', () => {
    const r = runCli(['close', 'r1', '--ids', 'F-1', '--reason', 'x', '--evidence', 'y'], dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--verified-how is required/);
    assert.match(r.stderr, /independent\|self_attested\|operator_evidence/);
  });

  it('close: an out-of-enum --verified-how exits 1 with CLI_INVALID_VERIFIED_HOW', () => {
    const r = runCli(['close', 'r1', '--ids', 'F-1', '--reason', 'x', '--evidence', 'y', '--verified-how', 'vibes'], dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CLI_INVALID_VERIFIED_HOW/);
  });

  it("close: --as anything other than 'fixed' exits 1 naming the standalone defer/reject verbs", () => {
    const r = runCli(['close', 'r1', '--ids', 'F-1', '--as', 'rejected', '--reason', 'x', '--evidence', 'y', '--verified-how', 'independent'], dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /swarm defer.*swarm reject/s);
  });

  it('reopen: --ids matching nothing in the run exits 1 via the shared zero-match refusal', () => {
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    closeDb(dbPath);

    const r = runCli(['reopen', 'r1', '--ids', 'F-GHOST', '--reason', 'x', '--evidence', 'y'], dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CLI_FINDINGS_ID_NO_MATCH/);
  });

  it('reopen --help / close --help exit 0 and print their Usage line (F-264ab3aa convention)', () => {
    for (const verb of ['reopen', 'close']) {
      const r = runCli([verb, '--help'], dbPath);
      assert.equal(r.status, 0, `${verb} --help must exit 0`);
      assert.match(r.stdout, new RegExp(`Usage: swarm ${verb}`));
    }
  });

  it('an invalid --format on reopen/close is rejected before any DB work (fail-loud enum validation)', () => {
    for (const verb of ['reopen', 'close']) {
      const r = runCli([verb, 'r1', '--ids', 'F-1', '--reason', 'x', '--evidence', 'y', '--verified-how', 'independent', '--format', 'markdown'], dbPath);
      assert.equal(r.status, 1, `${verb} --format=markdown must be rejected (text|json only)`);
      assert.match(r.stderr, /CLI_INVALID_FORMAT/);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// F-264ab3aa-family structural check — reopen/close are real registered
// verbs, not just locally-defined functions (belt-and-suspenders on top of
// wave31's own generic Object.keys(commands) sweep, which already covers
// this by construction).
// ──────────────────────────────────────────────────────────────

describe('reopen/close are registered verbs', () => {
  it('commands.reopen and commands.close are functions with matching USAGE entries', () => {
    assert.equal(typeof commands.reopen, 'function');
    assert.equal(typeof commands.close, 'function');
    assert.match(USAGE.reopen, /^Usage: swarm reopen/);
    assert.match(USAGE.close, /^Usage: swarm close/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-338c8c46 — T1 roadmap CLI surface: note validation (seam-free half)
// ──────────────────────────────────────────────────────────────

/** @pins F-338c8c46 */
describe('F-338c8c46 — readOperatorNotes: T3 invariant enforcement (fail-loud, not silent clamping)', () => {
  it('a repo with no notes seed file compiles with zero notes (not an error)', () => {
    const { notes } = readOperatorNotes('/repo', { existsSyncFn: () => false });
    assert.deepEqual(notes, []);
  });

  it('unparseable JSON throws ROADMAP_NOTES_UNPARSEABLE naming the path', () => {
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: () => true,
        readFileSyncFn: () => '{ not valid json',
      }),
      (e) => e.code === 'ROADMAP_NOTES_UNPARSEABLE' && /operator-notes seed/.test(e.message)
    );
  });

  it('a non-array, non-{notes:[]} JSON shape throws ROADMAP_NOTES_SHAPE_INVALID', () => {
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify({ wrong: 'shape' }),
      }),
      (e) => e.code === 'ROADMAP_NOTES_SHAPE_INVALID'
    );
  });

  it(`GATE: more than ${MAX_OPERATOR_NOTES} notes is a hard refusal naming the count — not silent truncation to the first ${MAX_OPERATOR_NOTES}`, () => {
    const tooMany = Array.from({ length: MAX_OPERATOR_NOTES + 1 }, (_, i) => ({ kind: 'theme', text: `note ${i}` }));
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify(tooMany),
      }),
      (e) => e.code === 'ROADMAP_TOO_MANY_NOTES' && e.count === MAX_OPERATOR_NOTES + 1
    );
  });

  it(`PRECISION GUARD: exactly ${MAX_OPERATOR_NOTES} notes is accepted (the cap is inclusive)`, () => {
    const exactly = Array.from({ length: MAX_OPERATOR_NOTES }, (_, i) => ({ kind: 'theme', text: `note ${i}` }));
    const { notes } = readOperatorNotes('/repo', {
      existsSyncFn: () => true,
      readFileSyncFn: () => JSON.stringify(exactly),
    });
    assert.equal(notes.length, MAX_OPERATOR_NOTES);
  });

  it('a note missing non-empty "text" throws ROADMAP_NOTE_INVALID naming the index', () => {
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify([{ kind: 'theme', text: '' }]),
      }),
      (e) => e.code === 'ROADMAP_NOTE_INVALID' && e.index === 0
    );
  });

  it(`a note with kind outside ${NOTE_KINDS.join('|')} throws ROADMAP_NOTE_INVALID_KIND`, () => {
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify([{ kind: 'vibes', text: 'x' }]),
      }),
      (e) => e.code === 'ROADMAP_NOTE_INVALID_KIND'
    );
  });

  it("GATE: kind='invariant' with no enforced_by throws ROADMAP_INVARIANT_NO_ENFORCER — \"a lesson without a mechanical verifier is not persisted as a lesson\"", () => {
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: () => true,
        readFileSyncFn: () => JSON.stringify([{ kind: 'invariant', text: 'never regress X' }]),
      }),
      (e) => e.code === 'ROADMAP_INVARIANT_NO_ENFORCER' && e.index === 0
    );
  });

  it('GATE: kind=\'invariant\' whose enforced_by path does not resolve to a real file throws ROADMAP_ENFORCER_NOT_FOUND', () => {
    assert.throws(
      () => readOperatorNotes('/repo', {
        existsSyncFn: (p) => !String(p).includes('nonexistent-gate.test.js'),
        readFileSyncFn: () => JSON.stringify([{ kind: 'invariant', text: 'never regress X', enforced_by: 'nonexistent-gate.test.js' }]),
      }),
      (e) => e.code === 'ROADMAP_ENFORCER_NOT_FOUND' && e.enforcedBy === 'nonexistent-gate.test.js'
    );
  });

  it("PRECISION GUARD: kind='invariant' with a REAL, resolvable enforced_by is accepted", () => {
    const { notes } = readOperatorNotes('/repo', {
      existsSyncFn: () => true, // simulates the enforced_by path resolving
      readFileSyncFn: () => JSON.stringify([
        { kind: 'invariant', text: 'never regress X', enforced_by: 'real-gate.test.js' },
      ]),
    });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].enforced_by, 'real-gate.test.js');
  });

  it('accepts the {"notes": [...]} wrapped shape identically to a bare array', () => {
    const { notes } = readOperatorNotes('/repo', {
      existsSyncFn: () => true,
      readFileSyncFn: () => JSON.stringify({ notes: [{ kind: 'theme', text: 'x' }] }),
    });
    assert.equal(notes.length, 1);
  });

  it('roadmapError builds a plain Error with .code/.hint/extra fields (matches formatError/juryError\'s established factory shape)', () => {
    const e = roadmapError('ROADMAP_TEST', 'msg', 'hint text', { foo: 'bar' });
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'ROADMAP_TEST');
    assert.equal(e.message, 'msg');
    assert.equal(e.hint, 'hint text');
    assert.equal(e.foo, 'bar');
  });
});

describe('F-338c8c46 — splitExpiredNotes: T3 "listed as EXPIRED, not silently omitted"', () => {
  const NOW = new Date('2026-07-17T00:00:00Z');

  it('a note whose ISO-date expires is in the past is moved to expired[]', () => {
    const { active, expired } = splitExpiredNotes(
      [{ kind: 'theme', text: 'old', expires: '2026-01-01' }],
      NOW
    );
    assert.equal(active.length, 0);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].text, 'old');
  });

  it('a note whose ISO-date expires is in the future stays active', () => {
    const { active, expired } = splitExpiredNotes(
      [{ kind: 'theme', text: 'fresh', expires: '2027-01-01' }],
      NOW
    );
    assert.equal(active.length, 1);
    assert.equal(expired.length, 0);
  });

  it('a note with no `expires` field never expires', () => {
    const { active, expired } = splitExpiredNotes([{ kind: 'theme', text: 'evergreen' }], NOW);
    assert.equal(active.length, 1);
    assert.equal(expired.length, 0);
  });

  it('SCOPE DISCLOSURE pin: the "<N runs>" relative form (undated string) does NOT parse as a date and is treated as non-expiring, never silently misread as an already-past ISO date', () => {
    const { active, expired } = splitExpiredNotes(
      [{ kind: 'open-question', text: 'revisit', expires: '3 runs' }],
      NOW
    );
    assert.equal(active.length, 1, '"3 runs" must not be misparsed as a past date and silently dropped');
    assert.equal(expired.length, 0);
  });

  it('an exact boundary (expires === now) counts as expired (>=, not >)', () => {
    const { active, expired } = splitExpiredNotes(
      [{ kind: 'theme', text: 'boundary', expires: NOW.toISOString() }],
      NOW
    );
    assert.equal(expired.length, 1);
    assert.equal(active.length, 0);
  });
});
