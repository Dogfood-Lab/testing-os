/**
 * deferred-gate-consistency.test.js — F-CORE-001.
 *
 * The REAL advance gate (lib/advance.js#checkFindingSeverity) treats a
 * `deferred` finding as CLOSED: `WHERE status NOT IN ('fixed','rejected',
 * 'deferred')`. So after a CRITICAL/HIGH is deferred, `swarm advance` returns
 * ADVANCE.
 *
 * Before this fix, `swarm receipt` (computeRecommendation) and `swarm status`
 * (computeAssessment) computed their open-by-severity counts with only
 * `status !== 'fixed' && status !== 'rejected'` — counting a deferred
 * CRITICAL/HIGH as OPEN. Net: advance ADVANCEd while status + receipt
 * recommended AMEND for the same DB state. These tests pin that the three
 * surfaces agree on a deferred CRITICAL/HIGH.
 *
 * The tests exercise the REAL caller entry points (checkGates, buildReceipt,
 * status) rather than the leaf functions, because the divergence lived in HOW
 * each caller computed openBySeverity, not in the leaf functions themselves.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { checkGates } from './lib/advance.js';
import { buildReceipt } from './commands/receipt.js';
import { status } from './commands/status.js';

function setupRunWithDeferred(dbPath, severity) {
  const db = openDb(dbPath);
  const runId = 'r1';
  const phase = 'health-audit-a'; // finding-gated

  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, 1, 'collected')"
  ).run(runId, phase);
  const waveId = Number(wave.lastInsertRowid);

  const domains = db.prepare('SELECT id FROM domains WHERE run_id = ?').all(runId);
  for (const d of domains) {
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, d.id);
  }

  // A single CRITICAL/HIGH finding, DEFERRED. Per advance.js this is CLOSED.
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
    VALUES (?, 'F-1', 'fp1', ?, 'bug', 'deferred crit/high', 'deferred', ?, ?)
  `).run(runId, severity, waveId, waveId);

  return { runId, waveId };
}

describe('F-CORE-001 — deferred CRITICAL/HIGH is consistently treated as closed', () => {
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'deferred-gate-'));
    dbPath = join(tmp, 'control-plane.db');
  });

  afterEach(() => {
    // Close the pooled handle before rmSync — Windows EBUSY on a locked .db.
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const severity of ['CRITICAL', 'HIGH']) {
    it(`advance gate, receipt, and status all agree to ADVANCE on a deferred ${severity}`, () => {
      const { runId } = setupRunWithDeferred(dbPath, severity);

      // 1. The REAL advance gate — already excludes 'deferred'.
      const gate = checkGates(openDb(dbPath), runId);
      assert.equal(gate.verdict, 'ADVANCE',
        `advance gate must ADVANCE on a deferred ${severity} (deferred is closed)`);

      // 2. The receipt recommendation — must agree with the gate.
      const receipt = buildReceipt({ runId, dbPath });
      assert.equal(receipt.recommendation.action, 'ADVANCE',
        `receipt must recommend ADVANCE on a deferred ${severity}, not AMEND — ` +
        `it must match the advance gate which treats deferred as closed`);
      assert.equal(receipt.findings.by_status.deferred, 1);

      // 3. The status assessment — must agree with the gate.
      const s = status({ runId, dbPath });
      assert.equal(s.assessment.state, 'READY TO ADVANCE',
        `status must report READY TO ADVANCE on a deferred ${severity}, not AMEND NEEDED`);
      assert.equal(s.findings.open.CRITICAL, 0,
        'a deferred finding must not count as open in status');
      assert.equal(s.findings.open.HIGH, 0,
        'a deferred finding must not count as open in status');
    });
  }

  it('a NEW CRITICAL still drives AMEND across all three surfaces (no over-correction)', () => {
    const db = openDb(dbPath);
    const runId = 'r1';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(runId);
    const waveId = Number(wave.lastInsertRowid);
    for (const d of db.prepare('SELECT id FROM domains WHERE run_id = ?').all(runId)) {
      db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
        .run(waveId, d.id);
    }
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'CRITICAL', 'security', 'open vuln', 'new', ?, ?)
    `).run(runId, waveId, waveId);

    assert.equal(checkGates(db, runId).verdict, 'AMEND');
    assert.equal(buildReceipt({ runId, dbPath }).recommendation.action, 'AMEND');
    assert.equal(status({ runId, dbPath }).assessment.state, 'AMEND NEEDED');
  });
});
