/**
 * case-file-adjudication-gate.test.js — the v9 wave-gating integration: the
 * adjudications store and the sixth advance gate (checkAdjudication).
 *
 * The cross-family jury verdict is ADVISORY — evidence, not law. These tests pin
 * how it gates `swarm advance`:
 *   - no adjudication run  → advances cleanly (absence is not a blocker)
 *   - corroborate          → advances cleanly
 *   - refute/contested/insufficient_context → BLOCK, but OVERRIDABLE: the
 *     Director disposes with --override --reason. The jury never hard-blocks;
 *     only the deterministic verification floor is non-overridable.
 * Plus the store roundtrip, the enum guard, and the named compensator.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { checkGates, advance } from './lib/advance.js';
import {
  persistAdjudication,
  getLatestAdjudication,
  deleteAdjudication,
  ADJUDICATION_VERDICTS,
} from './lib/adjudication-store.js';

// Mirrors advance.test.js#setupRun — a wave in the advanceable (collected, all
// agents complete, no findings) state so the ONLY variable is the adjudication.
function setupRun(db, opts = {}) {
  const runId = opts.runId || 'r1';
  const phase = opts.phase || 'health-audit-a';
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);
  const wave = db.prepare(
    'INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, 1, ?)'
  ).run(runId, phase, 'collected');
  const waveId = Number(wave.lastInsertRowid);
  const domains = db.prepare("SELECT * FROM domains WHERE run_id = ? AND ownership_class != 'shared'").all(runId);
  for (const d of domains) {
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')").run(waveId, d.id);
  }
  return { runId, waveId };
}

const result = (overall, seats = ['openai', 'mistral', 'qwen']) => ({
  overall, authority: 'advisory', panel_size: seats.length, seats,
});

describe('adjudication store', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('persists and reads back the latest adjudication, hashing the receipt', () => {
    const { runId, waveId } = setupRun(db);
    const id = persistAdjudication(db, {
      waveId, runId, result: result('corroborate'),
      caseFileRef: 'src/x.js@1', receiptPath: 'swarms/r1/adjudications/1.json',
      receiptContent: '{"overall":"corroborate"}',
    });
    assert.ok(id > 0);
    const row = getLatestAdjudication(db, waveId);
    assert.equal(row.overall, 'corroborate');
    assert.equal(row.authority, 'advisory');
    assert.equal(row.panel_size, 3);
    assert.deepEqual(JSON.parse(row.seats), ['openai', 'mistral', 'qwen']);
    assert.equal(row.case_file_ref, 'src/x.js@1');
    assert.match(row.receipt_hash, /^[0-9a-f]{64}$/, 'receipt is content-addressed');
    db.close();
  });

  it('returns the newest row when a wave is re-adjudicated', () => {
    const { runId, waveId } = setupRun(db);
    persistAdjudication(db, { waveId, runId, result: result('refute') });
    persistAdjudication(db, { waveId, runId, result: result('corroborate') });
    assert.equal(getLatestAdjudication(db, waveId).overall, 'corroborate');
    db.close();
  });

  it('refuses an out-of-vocabulary verdict (SQLite has no enum enforcement)', () => {
    const { runId, waveId } = setupRun(db);
    assert.throws(
      () => persistAdjudication(db, { waveId, runId, result: result('maybe') }),
      /invalid overall verdict/,
    );
    assert.deepEqual(ADJUDICATION_VERDICTS, ['corroborate', 'refute', 'contested', 'insufficient_context']);
    db.close();
  });

  it('deleteAdjudication (the named compensator) rolls a row back', () => {
    const { runId, waveId } = setupRun(db);
    const id = persistAdjudication(db, { waveId, runId, result: result('refute') });
    assert.equal(deleteAdjudication(db, id), 1);
    assert.equal(getLatestAdjudication(db, waveId), undefined);
    db.close();
  });
});

describe('checkAdjudication gate (the sixth advance gate)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('advances cleanly when no adjudication was run (advisory absence is not a blocker)', () => {
    setupRun(db);
    const r = checkGates(db, 'r1');
    assert.equal(r.verdict, 'ADVANCE');
    // the sixth gate exists and passes
    const adjGate = r.gates.find(g => g.name === 'adjudication');
    assert.ok(adjGate && adjGate.passed);
    assert.equal(r.gates.length, 6);
    db.close();
  });

  it('advances cleanly on a corroborate verdict', () => {
    const { runId, waveId } = setupRun(db);
    persistAdjudication(db, { waveId, runId, result: result('corroborate') });
    const r = checkGates(db, runId);
    assert.equal(r.verdict, 'ADVANCE');
    db.close();
  });

  for (const verdict of ['refute', 'contested', 'insufficient_context']) {
    it(`BLOCKS overridably on a ${verdict} verdict (needs Director disposition)`, () => {
      const { runId, waveId } = setupRun(db);
      persistAdjudication(db, { waveId, runId, result: result(verdict) });
      const r = checkGates(db, runId);
      assert.equal(r.verdict, 'BLOCK');
      assert.equal(r.overridable, true);
      const adjGate = r.gates.find(g => g.name === 'adjudication');
      assert.equal(adjGate.passed, false);
      assert.equal(adjGate.overridable, true);
      assert.match(adjGate.reason, /disposition/i);
      db.close();
    });
  }

  it('the deterministic floor outranks the advisory jury (a failed verify surfaces first)', () => {
    const { runId, waveId } = setupRun(db);
    // both a failed verification receipt AND a refute adjudication
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed) VALUES (?, 'node', '["npm test"]', 1, 0)`).run(waveId);
    persistAdjudication(db, { waveId, runId, result: result('refute') });
    const r = checkGates(db, runId);
    assert.equal(r.verdict, 'BLOCK');
    assert.match(r.reason, /Verification failed/, 'the floor reason surfaces before the jury reason');
    db.close();
  });
});

describe('advance() with a non-corroborate jury verdict', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('does not promote without a Director override', () => {
    const { runId, waveId } = setupRun(db);
    persistAdjudication(db, { waveId, runId, result: result('refute') });
    const r = advance(db, runId);
    assert.equal(r.promoted, false);
    assert.equal(r.verdict, 'BLOCK');
    db.close();
  });

  it('promotes with an override + reason (Director disposition), recording it', () => {
    const { runId, waveId } = setupRun(db);
    persistAdjudication(db, { waveId, runId, result: result('contested') });
    const r = advance(db, runId, {
      override: true,
      overrideReason: 'jury split on AC-2; deterministic tests pass — dispositioned to advance',
      authorizedBy: 'mike',
    });
    assert.equal(r.promoted, true);
    assert.match(r.verdict, /override/);
    assert.equal(r.toPhase, 'health-audit-b');
    // the override is recorded against the adjudication gate
    const wave = db.prepare('SELECT status FROM waves WHERE run_id = ?').get(runId);
    assert.equal(wave.status, 'advanced');
    db.close();
  });
});
