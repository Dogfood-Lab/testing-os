/**
 * advance.test.js — Phase 2.5 tests: advancement law, gate predicates, promotions, worktrees.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { transitionAgent } from './lib/state-machine.js';
import {
  checkGates, advance, recordPromotion, getPromotions,
  PHASE_MAP, FINDING_GATED_PHASES,
} from './lib/advance.js';

// ═══════════════════════════════════════════
// Helper: set up a run with a wave
// ═══════════════════════════════════════════

function setupRun(db, opts = {}) {
  const runId = opts.runId || 'r1';
  const phase = opts.phase || 'health-audit-a';
  const waveStatus = opts.waveStatus || 'collected';

  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  const wave = db.prepare(
    'INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, 1, ?)'
  ).run(runId, phase, waveStatus);

  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? AND ownership_class != ?')
    .all(runId, 'shared');

  for (const d of domains) {
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(Number(wave.lastInsertRowid), d.id);
  }

  return { runId, waveId: Number(wave.lastInsertRowid) };
}

// ═══════════════════════════════════════════
// Phase map
// ═══════════════════════════════════════════

describe('Phase map', () => {
  it('defines all expected phases', () => {
    const phases = Object.keys(PHASE_MAP);
    assert.ok(phases.includes('health-audit-a'));
    assert.ok(phases.includes('health-amend-a'));
    assert.ok(phases.includes('stage-d-audit'));
    assert.ok(phases.includes('stage-d-amend'));
    assert.ok(phases.includes('feature-audit'));
    assert.ok(phases.includes('feature-execute'));
    assert.ok(phases.includes('test'));
    assert.ok(phases.includes('treatment'));
  });

  it('health-audit-a advances to health-audit-b', () => {
    assert.equal(PHASE_MAP['health-audit-a'].next, 'health-audit-b');
    assert.equal(PHASE_MAP['health-audit-a'].amend, 'health-amend-a');
  });

  it('health-audit-c advances to stage-d-audit (Stage D inserted between health and feature passes)', () => {
    assert.equal(PHASE_MAP['health-audit-c'].next, 'stage-d-audit');
    assert.equal(PHASE_MAP['health-audit-c'].amend, 'health-amend-c');
  });

  it('stage-d-audit advances to feature-audit and amends to stage-d-amend', () => {
    assert.equal(PHASE_MAP['stage-d-audit'].next, 'feature-audit');
    assert.equal(PHASE_MAP['stage-d-audit'].amend, 'stage-d-amend');
  });

  it('amend phases return to their audit phase', () => {
    assert.equal(PHASE_MAP['health-amend-a'].next, 'health-audit-a');
    assert.equal(PHASE_MAP['health-amend-b'].next, 'health-audit-b');
    assert.equal(PHASE_MAP['health-amend-c'].next, 'health-audit-c');
    assert.equal(PHASE_MAP['stage-d-amend'].next, 'stage-d-audit');
    assert.equal(PHASE_MAP['feature-execute'].next, 'feature-audit');
  });

  it('Stage D is finding-gated alongside health-audit-a/b/c', () => {
    assert.ok(FINDING_GATED_PHASES.has('stage-d-audit'));
    assert.ok(FINDING_GATED_PHASES.has('health-audit-a'));
    assert.ok(FINDING_GATED_PHASES.has('health-audit-b'));
    assert.ok(FINDING_GATED_PHASES.has('health-audit-c'));
  });

  it('treatment advances to complete', () => {
    assert.equal(PHASE_MAP['treatment'].next, 'complete');
  });
});

// ═══════════════════════════════════════════
// Gate checks
// ═══════════════════════════════════════════

describe('Gate checks — clean pass', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('ADVANCE when all gates pass and no findings', () => {
    setupRun(db);
    const result = checkGates(db, 'r1');
    assert.equal(result.verdict, 'ADVANCE');
    assert.equal(result.nextPhase, 'health-audit-b');
    assert.ok(result.gates.every(g => g.passed));
    db.close();
  });

  it('ADVANCE for non-finding-gated phase with findings', () => {
    const { runId } = setupRun(db, { phase: 'test' });
    // Add HIGH finding — test phase is not finding-gated
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'test bug', 'new', 1, 1)
    `).run(runId);

    const result = checkGates(db, runId);
    assert.equal(result.verdict, 'ADVANCE');
    assert.equal(result.nextPhase, 'treatment');
    db.close();
  });
});

describe('Gate checks — AMEND verdict', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('AMEND when HIGH findings exist in finding-gated phase', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'needs fix', 'new', 1, 1)
    `).run(runId);

    const result = checkGates(db, runId);
    assert.equal(result.verdict, 'AMEND');
    assert.equal(result.nextPhase, 'health-amend-a');
    assert.ok(result.overridable);
    db.close();
  });

  it('AMEND when CRITICAL findings exist', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'CRITICAL', 'security', 'vuln', 'new', 1, 1)
    `).run(runId);

    const result = checkGates(db, runId);
    assert.equal(result.verdict, 'AMEND');
    db.close();
  });

  it('ADVANCE when findings are fixed/deferred', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'was fixed', 'fixed', 1, 1)
    `).run(runId);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-2', 'fp2', 'HIGH', 'bug', 'deferred', 'deferred', 1, 1)
    `).run(runId);

    const result = checkGates(db, runId);
    assert.equal(result.verdict, 'ADVANCE');
    db.close();
  });
});

describe('Gate checks — BLOCK verdict', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('BLOCK when wave is still dispatched', () => {
    setupRun(db, { waveStatus: 'dispatched' });
    const result = checkGates(db, 'r1');
    assert.equal(result.verdict, 'BLOCK');
    assert.ok(result.reason.includes('collect'));
    db.close();
  });

  it('BLOCK when wave failed', () => {
    setupRun(db, { waveStatus: 'failed' });
    const result = checkGates(db, 'r1');
    assert.equal(result.verdict, 'BLOCK');
    db.close();
  });

  it('BLOCK when agents are incomplete', () => {
    const db2 = openMemoryDb();
    db2.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db2, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db2, 'r1');
    db2.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'collected')").run();
    const domId = db2.prepare("SELECT id FROM domains WHERE run_id = 'r1'").get().id;
    // Agent still in dispatched state
    db2.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (1, ?, 'dispatched')").run(domId);

    const result = checkGates(db2, 'r1');
    assert.equal(result.verdict, 'BLOCK');
    assert.ok(result.reason.includes('in-flight'));
    db2.close();
    db.close();
  });

  it('BLOCK when verification failed', () => {
    const { runId, waveId } = setupRun(db);
    db.prepare(`
      INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed)
      VALUES (?, 'node', '["npm test"]', 1, 0)
    `).run(waveId);

    const result = checkGates(db, runId);
    assert.equal(result.verdict, 'BLOCK');
    assert.ok(result.reason.includes('Verification failed'));
    assert.ok(result.overridable);
    db.close();
  });
});

// ═══════════════════════════════════════════
// Advancement + Promotion
// ═══════════════════════════════════════════

describe('advance()', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('promotes on clean pass', () => {
    setupRun(db);
    const result = advance(db, 'r1');
    assert.ok(result.promoted);
    assert.equal(result.fromPhase, 'health-audit-a');
    assert.equal(result.toPhase, 'health-audit-b');
    assert.ok(result.promotionId);

    // Wave should be marked advanced
    const wave = db.prepare('SELECT status FROM waves WHERE run_id = ?').get('r1');
    assert.equal(wave.status, 'advanced');

    // Run status updated
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get('r1');
    assert.equal(run.status, 'health-audit-b');
    db.close();
  });

  it('does not promote when AMEND needed', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'needs fix', 'new', 1, 1)
    `).run(runId);

    const result = advance(db, runId);
    assert.ok(!result.promoted);
    assert.equal(result.verdict, 'AMEND');
    assert.equal(result.nextPhase, 'health-amend-a');
    db.close();
  });

  it('allows override for AMEND with reason', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'acceptable risk', 'new', 1, 1)
    `).run(runId);

    const result = advance(db, runId, {
      override: true,
      overrideReason: 'Accepted risk — findings are non-blocking for this stage',
    });
    assert.ok(result.promoted);
    assert.ok(result.verdict.includes('override'));
    db.close();
  });

  it('override without reason is rejected', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'test', 'new', 1, 1)
    `).run(runId);

    const result = advance(db, runId, { override: true });
    assert.ok(!result.promoted); // no reason = no override
    db.close();
  });

  it('treatment → complete sets run to complete', () => {
    setupRun(db, { phase: 'treatment' });
    const result = advance(db, 'r1');
    assert.ok(result.promoted);
    assert.equal(result.toPhase, 'complete');

    const run = db.prepare('SELECT status, completed_at FROM runs WHERE id = ?').get('r1');
    assert.equal(run.status, 'complete');
    assert.ok(run.completed_at);
    db.close();
  });
});

describe('Promotion records', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('records promotion with gate results and finding snapshot', () => {
    setupRun(db);
    advance(db, 'r1');

    const promotions = getPromotions(db, 'r1');
    assert.equal(promotions.length, 1);

    const p = promotions[0];
    assert.equal(p.from_phase, 'health-audit-a');
    assert.equal(p.to_phase, 'health-audit-b');
    assert.equal(p.authorized_by, 'coordinator');
    assert.ok(Array.isArray(p.gates_checked));
    assert.ok(p.finding_snapshot);
    assert.equal(p.finding_snapshot.total, 0);
    db.close();
  });

  it('records override in promotion', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'test', 'new', 1, 1)
    `).run(runId);

    advance(db, runId, {
      override: true,
      overrideReason: 'Risk accepted',
      authorizedBy: 'mike',
    });

    const promotions = getPromotions(db, runId);
    assert.equal(promotions.length, 1);
    assert.ok(promotions[0].overrides);
    assert.equal(promotions[0].overrides[0].reason, 'Risk accepted');
    assert.equal(promotions[0].authorized_by, 'mike');
    db.close();
  });

  it('captures finding snapshot at promotion time', () => {
    const { runId } = setupRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-1', 'fp1', 'MEDIUM', 'quality', 'ok', 'new', 1, 1)
    `).run(runId);

    advance(db, runId);

    const promotions = getPromotions(db, runId);
    const snapshot = promotions[0].finding_snapshot;
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.bySeverity.MEDIUM, 1);
    assert.equal(snapshot.byStatus.new, 1);
    db.close();
  });
});

// ═══════════════════════════════════════════
// Multi-phase advancement
// ═══════════════════════════════════════════

describe('Multi-phase progression', () => {
  it('health-audit-a → b → c → stage-d-audit → feature-audit via promotions', () => {
    const db = openMemoryDb();

    // Phase A
    setupRun(db, { phase: 'health-audit-a' });
    let result = advance(db, 'r1');
    assert.equal(result.toPhase, 'health-audit-b');

    // Phase B — need a new wave
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-b', 2, 'collected')").run();
    const domains = db.prepare("SELECT * FROM domains WHERE run_id = 'r1' AND ownership_class != 'shared'").all();
    for (const d of domains) {
      db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (2, ?, 'complete')").run(d.id);
    }
    result = advance(db, 'r1');
    assert.equal(result.toPhase, 'health-audit-c');

    // Phase C
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-c', 3, 'collected')").run();
    for (const d of domains) {
      db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (3, ?, 'complete')").run(d.id);
    }
    result = advance(db, 'r1');
    assert.equal(result.toPhase, 'stage-d-audit');

    // Stage D
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'stage-d-audit', 4, 'collected')").run();
    for (const d of domains) {
      db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (4, ?, 'complete')").run(d.id);
    }
    result = advance(db, 'r1');
    assert.equal(result.toPhase, 'feature-audit');

    // Verify promotion history
    const promotions = getPromotions(db, 'r1');
    assert.equal(promotions.length, 4);
    assert.equal(promotions[0].to_phase, 'health-audit-b');
    assert.equal(promotions[1].to_phase, 'health-audit-c');
    assert.equal(promotions[2].to_phase, 'stage-d-audit');
    assert.equal(promotions[3].to_phase, 'feature-audit');

    db.close();
  });
});
