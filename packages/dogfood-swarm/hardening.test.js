/**
 * hardening.test.js — Phase 1.5 tests: timeout law, domain UX, receipts, status.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { SCHEMA_VERSION } from './db/schema.js';
import {
  saveDomainDraft, getDomains, freezeDomains, unfreezeDomains,
  aredomainsFrozen, editDomain, addDomain, removeDomain,
  getDomainEvents, takeDomainSnapshot,
} from './lib/domains.js';
import {
  canTransition, transitionAgent, applyTimeoutPolicy,
  getTimeoutPolicy, setTimeoutPolicy, getTransitionHistory,
  isBlocked, isTerminal, isRedispatchable, isInFlight,
  TRANSITIONS, BLOCKED_STATUSES,
} from './lib/state-machine.js';

// ═══════════════════════════════════════════
// Schema v2
// ═══════════════════════════════════════════

describe('Schema v2+', () => {
  it('is at version 3 or higher', () => {
    assert.ok(SCHEMA_VERSION >= 3);
  });

  it('creates v2 tables (agent_state_events, domain_events, wave_receipts)', () => {
    const db = openMemoryDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    assert.ok(tables.includes('agent_state_events'));
    assert.ok(tables.includes('domain_events'));
    assert.ok(tables.includes('wave_receipts'));
    db.close();
  });

  it('adds timeout_policy_ms to runs', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    const run = db.prepare('SELECT timeout_policy_ms FROM runs WHERE id = ?').get('r1');
    assert.equal(run.timeout_policy_ms, 1800000);
    db.close();
  });

  it('adds domain_snapshot_id to waves', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, domain_snapshot_id) VALUES (?, 'test', 1, 'snap123')")
      .run('r1');
    const wave = db.prepare('SELECT domain_snapshot_id FROM waves WHERE run_id = ?').get('r1');
    assert.equal(wave.domain_snapshot_id, 'snap123');
    db.close();
  });
});

// ═══════════════════════════════════════════
// State Machine (Timeout Law)
// ═══════════════════════════════════════════

describe('State machine — transitions', () => {
  it('allows legal transitions', () => {
    assert.ok(canTransition('pending', 'dispatched').allowed);
    assert.ok(canTransition('dispatched', 'running').allowed);
    assert.ok(canTransition('dispatched', 'complete').allowed);
    assert.ok(canTransition('dispatched', 'failed').allowed);
    assert.ok(canTransition('dispatched', 'timed_out').allowed);
    assert.ok(canTransition('running', 'complete').allowed);
    assert.ok(canTransition('running', 'timed_out').allowed);
    assert.ok(canTransition('failed', 'dispatched').allowed);
    assert.ok(canTransition('timed_out', 'dispatched').allowed);
  });

  it('blocks illegal transitions', () => {
    // Terminal: complete cannot transition
    assert.ok(!canTransition('complete', 'dispatched').allowed);
    assert.ok(canTransition('complete', 'dispatched').reason.includes('terminal'));

    // Blocked: invalid_output and ownership_violation
    assert.ok(!canTransition('invalid_output', 'dispatched').allowed);
    assert.ok(canTransition('invalid_output', 'dispatched').reason.includes('blocked'));
    assert.ok(!canTransition('ownership_violation', 'dispatched').allowed);

    // Skip states
    assert.ok(!canTransition('pending', 'complete').allowed);
    assert.ok(!canTransition('pending', 'running').allowed);
  });

  it('unknown status is rejected', () => {
    assert.ok(!canTransition('bogus', 'dispatched').allowed);
  });
});

describe('State machine — transitionAgent', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    db.prepare("INSERT INTO waves (run_id, phase, wave_number) VALUES ('r1', 'test', 1)");
    db.prepare("INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)")
      .run('r1', 'test', 1);
    const domainId = db.prepare('SELECT id FROM domains WHERE run_id = ?').get('r1').id;
    db.prepare('INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (1, ?, ?)')
      .run(domainId, 'pending');
  });

  it('performs legal transition and logs event', () => {
    const result = transitionAgent(db, 1, 'dispatched', 'initial dispatch');
    assert.equal(result.from, 'pending');
    assert.equal(result.to, 'dispatched');

    const events = getTransitionHistory(db, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].from_status, 'pending');
    assert.equal(events[0].to_status, 'dispatched');
    assert.equal(events[0].reason, 'initial dispatch');
    db.close();
  });

  it('rejects illegal transition', () => {
    // F-091578-002 (wave-17): rejection now throws StateMachineRejectionError
    // with kind=INVALID and an actionable hint. Old shape was a bare
    // `Illegal transition: ...` Error without a `code`.
    assert.throws(
      () => transitionAgent(db, 1, 'complete', 'skip ahead'),
      (err) => err.code === 'STATE_MACHINE_INVALID' && /not allowed/.test(err.message)
    );
    db.close();
  });

  it('blocks transition out of invalid_output without override', () => {
    // First get to invalid_output
    transitionAgent(db, 1, 'dispatched');
    // Manually set to invalid_output for test
    db.prepare("UPDATE agent_runs SET status = 'invalid_output' WHERE id = 1").run();

    // F-091578-002 (wave-17): blocked-status rejection now throws
    // StateMachineRejectionError with kind=BLOCKED and a manual-override hint.
    assert.throws(
      () => transitionAgent(db, 1, 'dispatched'),
      (err) => err.code === 'STATE_MACHINE_BLOCKED' && /blocked/.test(err.message)
    );
    db.close();
  });

  it('allows override for blocked status with reason', () => {
    transitionAgent(db, 1, 'dispatched');
    db.prepare("UPDATE agent_runs SET status = 'invalid_output' WHERE id = 1").run();

    const result = transitionAgent(db, 1, 'dispatched', 'coordinator fixed output', true);
    assert.equal(result.to, 'dispatched');

    const events = getTransitionHistory(db, 1);
    const override = events.find(e => e.reason === 'coordinator fixed output');
    assert.ok(override);
    db.close();
  });

  it('requires reason for override', () => {
    transitionAgent(db, 1, 'dispatched');
    db.prepare("UPDATE agent_runs SET status = 'invalid_output' WHERE id = 1").run();

    assert.throws(() => transitionAgent(db, 1, 'dispatched', null, true), /requires a reason/);
    db.close();
  });
});

describe('State machine — timeout policy', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    db.prepare("INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)")
      .run('r1', 'test', 1);
    const domainId = db.prepare('SELECT id FROM domains WHERE run_id = ?').get('r1').id;
    // Seed started_at in the SAME shape executeTransition() writes it: ISO with Z.
    // The previous fixture used '2026-04-10T10:00:00' (no Z) which masked F-742440-001.
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, started_at) VALUES (1, ?, 'dispatched', ?)")
      .run(domainId, '2026-04-10T10:00:00.000Z');
  });

  it('times out stale agents deterministically', () => {
    // 31 minutes after start
    const now = new Date('2026-04-10T10:31:00Z').getTime();
    const timedOut = applyTimeoutPolicy(db, 1, 1800000, now);
    assert.equal(timedOut.length, 1);

    const ar = db.prepare('SELECT status FROM agent_runs WHERE id = 1').get();
    assert.equal(ar.status, 'timed_out');

    // Verify event was logged
    const events = getTransitionHistory(db, 1);
    assert.ok(events.some(e => e.to_status === 'timed_out'));
    db.close();
  });

  it('does NOT time out fresh agents', () => {
    // 10 minutes after start
    const now = new Date('2026-04-10T10:10:00Z').getTime();
    const timedOut = applyTimeoutPolicy(db, 1, 1800000, now);
    assert.equal(timedOut.length, 0);

    const ar = db.prepare('SELECT status FROM agent_runs WHERE id = 1').get();
    assert.equal(ar.status, 'dispatched');
    db.close();
  });

  it('respects custom timeout policy', () => {
    setTimeoutPolicy(db, 'r1', 300000); // 5 min
    assert.equal(getTimeoutPolicy(db, 'r1'), 300000);

    // 6 minutes after start
    const now = new Date('2026-04-10T10:06:00Z').getTime();
    const timedOut = applyTimeoutPolicy(db, 1, 300000, now);
    assert.equal(timedOut.length, 1);
    db.close();
  });
});

// F-742440-001 regression: production write path (transitionAgent) writes
// started_at via toISOString() which already ends in 'Z'. Earlier hardening
// tests seed started_at via raw SQL without 'Z', which masks the bug. These
// tests drive the bug through the same code path production uses.
describe('State machine — timeout policy (production write path)', () => {
  let db;
  let pendingAgentId;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    db.prepare("INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)")
      .run('r1', 'test', 1);
    const domainId = db.prepare('SELECT id FROM domains WHERE run_id = ?').get('r1').id;
    db.prepare('INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (1, ?, ?)')
      .run(domainId, 'pending');
    pendingAgentId = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get().id;
  });

  it('times out agent dispatched via transitionAgent (production write path)', () => {
    // Production path: transitionAgent writes started_at via new Date().toISOString()
    // which yields a string already terminated with 'Z'.
    transitionAgent(db, pendingAgentId, 'dispatched', 'initial dispatch');

    const startedAt = db.prepare('SELECT started_at FROM agent_runs WHERE id = ?')
      .get(pendingAgentId).started_at;
    assert.ok(startedAt.endsWith('Z'), `started_at must end in Z (got: ${startedAt})`);

    // 31 minutes after the recorded started_at
    const startedAtMs = new Date(startedAt).getTime();
    const now = startedAtMs + 31 * 60 * 1000;

    const timedOut = applyTimeoutPolicy(db, 1, 1800000, now);
    assert.equal(timedOut.length, 1, 'agent dispatched via production path must time out');

    const ar = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(pendingAgentId);
    assert.equal(ar.status, 'timed_out');
    db.close();
  });

  it('does NOT time out fresh agent dispatched via transitionAgent', () => {
    transitionAgent(db, pendingAgentId, 'dispatched', 'initial dispatch');

    const startedAt = db.prepare('SELECT started_at FROM agent_runs WHERE id = ?')
      .get(pendingAgentId).started_at;
    const startedAtMs = new Date(startedAt).getTime();
    // 10 minutes after start — well inside the 30 min policy
    const now = startedAtMs + 10 * 60 * 1000;

    const timedOut = applyTimeoutPolicy(db, 1, 1800000, now);
    assert.equal(timedOut.length, 0);

    const ar = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(pendingAgentId);
    assert.equal(ar.status, 'dispatched');
    db.close();
  });
});

describe('State machine — status predicates', () => {
  it('identifies blocked statuses', () => {
    assert.ok(isBlocked('invalid_output'));
    assert.ok(isBlocked('ownership_violation'));
    assert.ok(!isBlocked('failed'));
    assert.ok(!isBlocked('complete'));
  });

  it('identifies terminal statuses', () => {
    assert.ok(isTerminal('complete'));
    assert.ok(!isTerminal('failed'));
  });

  it('identifies redispatchable statuses', () => {
    assert.ok(isRedispatchable('pending'));
    assert.ok(isRedispatchable('failed'));
    assert.ok(isRedispatchable('timed_out'));
    assert.ok(!isRedispatchable('complete'));
    assert.ok(!isRedispatchable('invalid_output'));
  });

  it('identifies in-flight statuses', () => {
    assert.ok(isInFlight('dispatched'));
    assert.ok(isInFlight('running'));
    assert.ok(!isInFlight('complete'));
    assert.ok(!isInFlight('pending'));
  });
});

// ═══════════════════════════════════════════
// Domain UX
// ═══════════════════════════════════════════

describe('Domain edit', () => {
  let db;
  const RUN_ID = 'dom-test';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);
  });

  it('edits globs on unfrozen domain', () => {
    editDomain(db, RUN_ID, 'backend', { globs: ['src/**', 'lib/**'] });
    const d = getDomains(db, RUN_ID).find(d => d.name === 'backend');
    assert.deepEqual(d.globs, ['src/**', 'lib/**']);
    db.close();
  });

  it('edits ownership class', () => {
    editDomain(db, RUN_ID, 'backend', { ownership_class: 'bridge' });
    const d = getDomains(db, RUN_ID).find(d => d.name === 'backend');
    assert.equal(d.ownership_class, 'bridge');
    db.close();
  });

  it('rejects edit on frozen domain', () => {
    freezeDomains(db, RUN_ID);
    assert.throws(() => editDomain(db, RUN_ID, 'backend', { globs: ['new/**'] }), /frozen/);
    db.close();
  });

  it('rejects invalid ownership class', () => {
    assert.throws(() => editDomain(db, RUN_ID, 'backend', { ownership_class: 'bogus' }), /Invalid/);
    db.close();
  });

  it('logs edit event', () => {
    editDomain(db, RUN_ID, 'backend', { globs: ['src/**', 'lib/**'], reason: 'added lib' });
    const events = getDomainEvents(db, RUN_ID);
    const editEvt = events.find(e => e.event_type === 'edited');
    assert.ok(editEvt);
    assert.ok(editEvt.old_value.includes('src/**'));
    assert.ok(editEvt.new_value.includes('lib/**'));
    db.close();
  });
});

describe('Domain add/remove', () => {
  let db;
  const RUN_ID = 'dom-ar';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
  });

  it('adds a new domain', () => {
    addDomain(db, RUN_ID, { name: 'bridge-types', globs: ['types/**'], ownership_class: 'bridge' });
    const domains = getDomains(db, RUN_ID);
    assert.equal(domains.length, 2);
    assert.ok(domains.some(d => d.name === 'bridge-types'));
    db.close();
  });

  it('removes a domain', () => {
    removeDomain(db, RUN_ID, 'backend');
    const domains = getDomains(db, RUN_ID);
    assert.equal(domains.length, 0);
    db.close();
  });

  it('rejects add when frozen', () => {
    freezeDomains(db, RUN_ID);
    assert.throws(() => addDomain(db, RUN_ID, { name: 'x', globs: ['x/**'], ownership_class: 'owned' }), /frozen/);
    db.close();
  });

  it('rejects remove when frozen', () => {
    freezeDomains(db, RUN_ID);
    assert.throws(() => removeDomain(db, RUN_ID, 'backend'), /frozen/);
    db.close();
  });
});

describe('Domain freeze/unfreeze', () => {
  let db;
  const RUN_ID = 'dom-fu';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
  });

  it('freezes and unfreezes with reason', () => {
    freezeDomains(db, RUN_ID);
    assert.ok(aredomainsFrozen(db, RUN_ID));

    unfreezeDomains(db, RUN_ID, 'Need to add bridge domain');
    assert.ok(!aredomainsFrozen(db, RUN_ID));

    // Can edit after unfreeze
    editDomain(db, RUN_ID, 'backend', { globs: ['src/**', 'lib/**'] });
    const d = getDomains(db, RUN_ID).find(d => d.name === 'backend');
    assert.deepEqual(d.globs, ['src/**', 'lib/**']);
    db.close();
  });

  it('unfreeze requires reason', () => {
    freezeDomains(db, RUN_ID);
    assert.throws(() => unfreezeDomains(db, RUN_ID), /requires a reason/);
    assert.throws(() => unfreezeDomains(db, RUN_ID, ''), /requires a reason/);
    db.close();
  });

  it('logs freeze and unfreeze events', () => {
    freezeDomains(db, RUN_ID);
    unfreezeDomains(db, RUN_ID, 'test reason');

    const events = getDomainEvents(db, RUN_ID);
    // created (from saveDomainDraft) + frozen + unfrozen
    assert.ok(events.some(e => e.event_type === 'frozen'));
    assert.ok(events.some(e => e.event_type === 'unfrozen' && e.reason === 'test reason'));
    db.close();
  });
});

describe('Domain snapshots', () => {
  let db;
  const RUN_ID = 'dom-snap';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);
  });

  it('produces stable snapshot ID for same config', () => {
    const snap1 = takeDomainSnapshot(db, RUN_ID);
    const snap2 = takeDomainSnapshot(db, RUN_ID);
    assert.equal(snap1.snapshotId, snap2.snapshotId);
    db.close();
  });

  it('produces different snapshot after edit', () => {
    const snap1 = takeDomainSnapshot(db, RUN_ID);
    editDomain(db, RUN_ID, 'backend', { globs: ['src/**', 'lib/**'] });
    const snap2 = takeDomainSnapshot(db, RUN_ID);
    assert.notEqual(snap1.snapshotId, snap2.snapshotId);
    db.close();
  });

  it('captures domain config in snapshot', () => {
    const snap = takeDomainSnapshot(db, RUN_ID);
    assert.equal(snap.domains.length, 2);
    assert.ok(snap.domains.some(d => d.name === 'backend'));
    db.close();
  });
});

// ═══════════════════════════════════════════
// Receipts
// ═══════════════════════════════════════════

import { buildReceipt, computeRecommendation } from './commands/receipt.js';

describe('Wave receipt', () => {
  let db, dbPath;

  beforeEach(() => {
    db = openMemoryDb();
    // buildReceipt uses openDb(path) so we need to use a real path
    // but for unit tests we'll test the structure against a pre-built DB
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, branch) VALUES (?, ?, ?, ?, ?)')
      .run('r1', 'org/test', '/tmp/test', 'c'.repeat(40), 'main');
    saveDomainDraft(db, 'r1', [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, 'r1');
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES (?, ?, ?, ?, ?)")
      .run('r1', 'health-audit-a', 1, 'collected', 'snap-abc');
    const domainId = db.prepare('SELECT id FROM domains WHERE run_id = ?').get('r1').id;
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, completed_at) VALUES (1, ?, 'complete', datetime('now'))")
      .run(domainId);
  });

  it('receipt structure has required fields', () => {
    // Build receipt manually from the in-memory DB
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('r1');
    const wave = db.prepare('SELECT * FROM waves WHERE run_id = ?').get('r1');
    const agents = db.prepare(`
      SELECT ar.*, d.name as domain_name, d.ownership_class
      FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
    `).all(wave.id);

    assert.ok(run);
    assert.ok(wave);
    assert.equal(wave.domain_snapshot_id, 'snap-abc');
    assert.equal(agents.length, 1);
    assert.equal(agents[0].status, 'complete');
    db.close();
  });

  it('receipt captures domain snapshot id', () => {
    const wave = db.prepare('SELECT * FROM waves WHERE run_id = ?').get('r1');
    assert.equal(wave.domain_snapshot_id, 'snap-abc');
    db.close();
  });
});

describe('Receipt recommendation footer', () => {
  const completeAgents = [{ status: 'complete' }, { status: 'complete' }];
  const auditWave = { phase: 'health-audit-a' };
  const postAuditWave = { phase: 'health-audit-b' };

  it('surfaces wave-delta AND run-total in ADVANCE reason when open counts are zero', () => {
    const open = { CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 5 };
    const waveDelta = { waveNew: 3, waveNewCrit: 0, waveNewHigh: 0, totalFixed: 37 };
    const rec = computeRecommendation(auditWave, completeAgents, open, waveDelta);
    assert.equal(rec.action, 'ADVANCE');
    assert.match(rec.reason, /Wave: 3 new \(0 CRIT \+ 0 HIGH\)/);
    assert.match(rec.reason, /Run total: 0 CRIT \+ 0 HIGH open \(fixed: 37\)/);
  });

  it('does NOT recommend AMEND when CRIT/HIGH are all fixed (aggregate-drift regression)', () => {
    // The codecomfy drift: 2 CRIT + 13 HIGH existed historically but are all fixed.
    // Wave 5 returned 3 new MEDIUMs. Old code said AMEND; new code must say ADVANCE.
    const open = { CRITICAL: 0, HIGH: 0, MEDIUM: 3, LOW: 0 };
    const waveDelta = { waveNew: 3, waveNewCrit: 0, waveNewHigh: 0, totalFixed: 15 };
    const rec = computeRecommendation(auditWave, completeAgents, open, waveDelta);
    assert.equal(rec.action, 'ADVANCE');
    assert.doesNotMatch(rec.reason, /AMEND/);
  });

  it('recommends AMEND with wave-delta + run-total when open CRIT/HIGH remain in Stage A', () => {
    const open = { CRITICAL: 1, HIGH: 4, MEDIUM: 2, LOW: 0 };
    const waveDelta = { waveNew: 5, waveNewCrit: 1, waveNewHigh: 4, totalFixed: 10 };
    const rec = computeRecommendation(auditWave, completeAgents, open, waveDelta);
    assert.equal(rec.action, 'AMEND');
    assert.match(rec.reason, /Wave: 5 new \(1 CRIT \+ 4 HIGH\)/);
    assert.match(rec.reason, /Run total: 1 CRIT \+ 4 HIGH open \(fixed: 10\)/);
  });

  it('ADVANCE in post-Stage-A phases even when open CRIT/HIGH exist (gate is audit-a only)', () => {
    const open = { CRITICAL: 2, HIGH: 3, MEDIUM: 0, LOW: 0 };
    const waveDelta = { waveNew: 0, waveNewCrit: 0, waveNewHigh: 0, totalFixed: 0 };
    const rec = computeRecommendation(postAuditWave, completeAgents, open, waveDelta);
    assert.equal(rec.action, 'ADVANCE');
  });

  it('WAIT reason short-circuits before wave-delta formatting (no waveDelta deref)', () => {
    const rec = computeRecommendation(
      auditWave,
      [{ status: 'running' }, { status: 'complete' }],
      { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      { waveNew: 0, waveNewCrit: 0, waveNewHigh: 0, totalFixed: 0 },
    );
    assert.equal(rec.action, 'WAIT');
  });
});

// ═══════════════════════════════════════════
// Integration: full state law lifecycle
// ═══════════════════════════════════════════

describe('State law integration', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, 'r1');
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES (?, ?, ?, ?, ?)")
      .run('r1', 'health-audit-a', 1, 'dispatched', 'snap1');
    const domains = getDomains(db, 'r1');
    for (const d of domains) {
      if (d.ownership_class !== 'shared') {
        db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (1, ?, 'pending')")
          .run(d.id);
      }
    }
  });

  it('happy path: pending → dispatched → running → complete', () => {
    const ars = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').all();

    for (const ar of ars) {
      transitionAgent(db, ar.id, 'dispatched', 'wave 1 start');
      transitionAgent(db, ar.id, 'running', 'agent started');
      transitionAgent(db, ar.id, 'complete', 'output collected');
    }

    const final = db.prepare('SELECT status FROM agent_runs WHERE wave_id = 1').all();
    assert.ok(final.every(a => a.status === 'complete'));

    // Each agent should have 3 events
    for (const ar of ars) {
      const events = getTransitionHistory(db, ar.id);
      assert.equal(events.length, 3);
    }
    db.close();
  });

  it('timeout + redispatch: dispatched → timed_out → dispatched (new agent)', () => {
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1 LIMIT 1').get();
    transitionAgent(db, ar.id, 'dispatched', 'start');

    // Simulate timeout
    const now = Date.now() + 3600000; // 1 hour later
    db.prepare("UPDATE agent_runs SET started_at = '2020-01-01T00:00:00' WHERE id = ?").run(ar.id);
    const timedOut = applyTimeoutPolicy(db, 1, 1800000, now);
    assert.ok(timedOut.length >= 1);

    // Verify timed_out status
    const status = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(ar.id);
    assert.equal(status.status, 'timed_out');

    // Redispatch is legal from timed_out
    assert.ok(isRedispatchable('timed_out'));
    db.close();
  });

  it('blocked agents cannot be auto-retried', () => {
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1 LIMIT 1').get();
    transitionAgent(db, ar.id, 'dispatched');
    db.prepare("UPDATE agent_runs SET status = 'invalid_output' WHERE id = ?").run(ar.id);

    assert.ok(isBlocked('invalid_output'));
    assert.ok(!isRedispatchable('invalid_output'));

    // Cannot transition without override
    assert.throws(() => transitionAgent(db, ar.id, 'dispatched'));

    // CAN transition with override + reason
    transitionAgent(db, ar.id, 'dispatched', 'coordinator fixed the output', true);
    const status = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(ar.id);
    assert.equal(status.status, 'dispatched');
    db.close();
  });

  it('complete is terminal — no transitions out', () => {
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1 LIMIT 1').get();
    transitionAgent(db, ar.id, 'dispatched');
    transitionAgent(db, ar.id, 'complete');

    assert.ok(isTerminal('complete'));
    assert.throws(() => transitionAgent(db, ar.id, 'dispatched'), /terminal/);
    db.close();
  });
});
