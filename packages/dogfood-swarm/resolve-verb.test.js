/**
 * resolve-verb.test.js — `swarm resolve` gives the dispatch banner's
 * coordinator_resolved closure a lawful verb (observed in run
 * swarm-1784601601-bd4a).
 *
 * The banner (dispatch.js unrouted_approved_findings hint, echoed by
 * cli.js's approve-time hint) has always instructed coordinators: "attach
 * coordinator_resolved: true + a one-line verified_via_evidence so
 * `swarm verify-fixed` classifies the closure as allowlist" — and shipped NO
 * verb that writes those columns. `swarm close` writes closure_kind/
 * verified_how but never coordinator_resolved/verified_via_evidence, so the
 * allowlist channel stayed reachable only by raw SQL. In the live run the
 * coordinator hand-edited 16 rows to 'fixed' + coordinator_resolved=1 with
 * zero finding_events — closures invisible to the append-only audit trail.
 *
 * Invariants (RED -> GREEN — pre-fix `swarm resolve` is an unknown command):
 *   1. Dry-run by default (recovery-verb family polarity); --apply mutates.
 *   2. --apply writes status='fixed', coordinator_resolved=1,
 *      verified_via_evidence=<--evidence>, closure_kind='operator',
 *      verified_how='operator_evidence', plus one finding_events row.
 *   3. verify-fixed's v2 classifier reads the closure as allowlist — the
 *      banner's promised destination, end to end.
 *   4. Unknown ids refuse loudly (CLI_FINDINGS_ID_NO_MATCH); --evidence is
 *      mandatory; an already-closed id is a benign, visible skip.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { loadFixedFindings } from './lib/verify-fixed.js';
import { buildV2Delta } from './lib/verify-classifier-v2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');
const RUN_ID = 'test-resolve-verb';

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

describe('swarm resolve — the coordinator_resolved closure, no more raw SQL', () => {
  let tempDir, dbPath;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resolve-verb-'));
    dbPath = join(tempDir, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/r', tempDir, 'a'.repeat(40));
    const insert = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES (?, ?, ?, ?, 'quality', ?, ?, ?)`);
    insert.run(RUN_ID, 'F-RES-001', 'fp-res-1', 'HIGH', 'packages/a/x.js', 'unrouted approved finding', 'approved');
    insert.run(RUN_ID, 'F-RES-002', 'fp-res-2', 'LOW', null, 'already closed elsewhere', 'fixed');
    db.close();
  });

  afterEach(() => {
    closeDb(dbPath);
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('dry-runs by default: previews the closure, mutates nothing', () => {
    const res = runCli(['resolve', RUN_ID, '--ids', 'F-RES-001', '--evidence', 'fix landed in commit abc123; suite green'], dbPath);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /DRY-RUN/, 'default polarity is the recovery-verb family\'s dry-run');
    assert.match(res.stdout, /F-RES-001/, 'preview names the finding');

    const db = openDb(dbPath);
    const row = db.prepare('SELECT status, coordinator_resolved FROM findings WHERE run_id = ? AND finding_id = ?')
      .get(RUN_ID, 'F-RES-001');
    assert.equal(row.status, 'approved', 'dry-run must not mutate');
    assert.equal(row.coordinator_resolved, 0);
    db.close();
  });

  it('--apply closes with the banner\'s exact bookkeeping, and verify-fixed classifies it as allowlist', () => {
    const evidence = 'fix landed in commit abc123; packages/a suite green';
    const res = runCli(['resolve', RUN_ID, '--ids', 'F-RES-001', '--evidence', evidence, '--apply'], dbPath);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /APPLIED/);

    const db = openDb(dbPath);
    const row = db.prepare(`SELECT status, coordinator_resolved, verified_via_evidence, closure_kind, verified_how
      FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-RES-001');
    assert.equal(row.status, 'fixed');
    assert.equal(row.coordinator_resolved, 1, 'the column the banner instructs — now written by a verb');
    assert.equal(row.verified_via_evidence, evidence, 'the operator-readable evidence rides the row');
    assert.equal(row.closure_kind, 'operator', 'an operator-forced closure, honestly labeled');
    assert.equal(row.verified_how, 'operator_evidence');

    const events = db.prepare(`
      SELECT fe.event_type, fe.actor, fe.notes FROM finding_events fe
      JOIN findings f ON f.id = fe.finding_id
      WHERE f.run_id = ? AND f.finding_id = 'F-RES-001'
    `).all(RUN_ID);
    assert.equal(events.length, 1, 'the closure is event-sourced — the raw-SQL path left zero events');
    assert.equal(events[0].event_type, 'fixed');
    assert.equal(events[0].actor, 'operator');
    assert.match(events[0].notes, /abc123/, 'notes carry the evidence');

    // End-to-end: the banner promises verify-fixed reads this closure as
    // allowlist. coordinator_resolved short-circuits the anchor check, so no
    // source file is needed.
    const fixed = loadFixedFindings(db, RUN_ID);
    const delta = buildV2Delta({
      verb: 'verify-fixed', schema: 'verify-fixed-delta/v2',
      runId: RUN_ID, waveNumber: null, findings: fixed, repoRoot: tempDir, threshold: 0,
    });
    const entry = delta.findings.find(f => f.finding_id === 'F-RES-001');
    assert.ok(entry, 'the resolved row reaches verify-fixed');
    assert.equal(entry.verified_via, 'allowlist', 'the dispatch banner\'s promised classification, end to end');
    db.close();
  });

  it('refuses unknown ids loudly and requires --evidence', () => {
    const unknown = runCli(['resolve', RUN_ID, '--ids', 'F-NOPE-42', '--evidence', 'x', '--apply'], dbPath);
    assert.equal(unknown.status, 1, 'unknown ids exit non-zero');
    assert.match(unknown.stderr, /CLI_FINDINGS_ID_NO_MATCH/, 'the shared zero-existence refusal fires');

    const noEvidence = runCli(['resolve', RUN_ID, '--ids', 'F-RES-001'], dbPath);
    assert.equal(noEvidence.status, 1, 'missing --evidence exits non-zero');
    assert.match(noEvidence.stderr, /--evidence/, 'the error names the missing flag');

    const db = openDb(dbPath);
    const row = db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-RES-001');
    assert.equal(row.status, 'approved', 'refusals mutate nothing');
    db.close();
  });

  it('an already-closed id is a visible skip, not a silent success or an error', () => {
    const res = runCli(['resolve', RUN_ID, '--ids', 'F-RES-002', '--evidence', 'already handled', '--apply'], dbPath);
    assert.equal(res.status, 0, `close-family redundant-closure precedent: benign, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /SKIP.*F-RES-002|F-RES-002.*not eligible/s, 'the skip is rendered, not swallowed');

    const db = openDb(dbPath);
    const row = db.prepare('SELECT status, coordinator_resolved FROM findings WHERE run_id = ? AND finding_id = ?')
      .get(RUN_ID, 'F-RES-002');
    assert.equal(row.coordinator_resolved, 0, 'an ineligible row is untouched');
    db.close();
  });
});
