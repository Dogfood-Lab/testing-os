/**
 * revalidate.test.js — tests for the lawful recovery CLI command.
 *
 * Mirrors hardening.test.js's override-with-reason contract (lines 155-166)
 * but at the CLI-command surface, not the state-machine primitive. The
 * regression-anchor case here is the exact scenario the wave-2 amend hit:
 * four blocked agents in a wave moved to 'failed', JSONs corrected on disk,
 * coordinator wants the wave to return to 'collected' through a lawful audited
 * command rather than direct SQL.
 *
 * Architectural grounding: study-swarm 2026-05-14 cited Step Functions
 * Redrive, Temporal reset, Airflow clear/set-state, Stripe Ledger as
 * convergent examples that "executed but invalid output" is repairable in
 * place with a required reason captured in audit history.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { getTransitionHistory } from './lib/state-machine.js';
import { revalidate } from './commands/revalidate.js';

describe('revalidate — lawful repair of blocked agent_runs', () => {
  let tempDir;
  let dbPath;
  let outputDir;
  const RUN_ID = 'test-revalidate-r1';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'revalidate-test-'));
    dbPath = join(tempDir, 'control-plane.db');
    outputDir = join(tempDir, 'outputs');
    mkdirSync(outputDir, { recursive: true });

    const db = openDb(dbPath);

    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/r', tempDir, 'a'.repeat(40));

    saveDomainDraft(db, RUN_ID, [
      { name: 'backend',    globs: ['packages/**'],   ownership_class: 'owned' },
      { name: 'ci-tooling', globs: ['.github/**'],    ownership_class: 'owned' },
      { name: 'docs',       globs: ['*.md'],          ownership_class: 'owned' },
      { name: 'tests',      globs: ['**/*.test.*'],   ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);

    // Wave 2 (amend) in 'failed' status — the exact post-collect-rejection shape.
    db.prepare(`
      INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES (1, ?, 'health-amend-a', 2, 'failed', 'snap-test')
    `).run(RUN_ID);

    const domains = db.prepare(
      'SELECT * FROM domains WHERE run_id = ? AND ownership_class != ? ORDER BY name'
    ).all(RUN_ID, 'shared');

    // 4 agent_runs, all stuck in invalid_output (the wave-2 scenario).
    for (const d of domains) {
      db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status, error_message, started_at)
        VALUES (1, ?, 'invalid_output', 'old schema rejection', ?)
      `).run(d.id, new Date('2026-05-14T00:00:00Z').toISOString());
    }

    db.close();
  });

  afterEach(() => {
    // Close pooled DB handle before rmSync — Windows EBUSY on locked .db
    // file otherwise. closeDb(path) clears the connection.js pool entry.
    closeDb(dbPath);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAmendOutput(domain, fixes = [{ finding_id: `F-${domain}`, description: `${domain} fix` }]) {
    const outputPath = join(outputDir, `${domain}.json`);
    const files = fixes.map(f => f.file).filter(Boolean);
    const output = {
      domain,
      summary: `${domain} amend output (test fixture)`,
      fixes,
      files_changed: files,
    };
    writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    return outputPath;
  }

  // ───────────────────────────────────────────────────────
  // Contract guards
  // ───────────────────────────────────────────────────────

  it('requires a non-empty reason', () => {
    const outputs = { backend: writeAmendOutput('backend') };

    assert.throws(
      () => revalidate({ runId: RUN_ID, dbPath, outputs, reason: '' }),
      /reason is required/,
    );
    assert.throws(
      () => revalidate({ runId: RUN_ID, dbPath, outputs, reason: '   ' }),
      /reason is required/,
    );
    assert.throws(
      () => revalidate({ runId: RUN_ID, dbPath, outputs }),
      /reason is required/,
    );
  });

  it('requires at least one --domain=name:path', () => {
    assert.throws(
      () => revalidate({ runId: RUN_ID, dbPath, outputs: {}, reason: 'something' }),
      /at least one --domain=name:path/,
    );
  });

  // ───────────────────────────────────────────────────────
  // Dry-run vs apply
  // ───────────────────────────────────────────────────────

  it('dry-run does not mutate the DB', () => {
    const outputs = { backend: writeAmendOutput('backend') };

    const db = openDb(dbPath);
    const before = db.prepare(
      `SELECT status FROM agent_runs WHERE wave_id = 1 AND domain_id = (SELECT id FROM domains WHERE run_id = ? AND name = 'backend')`
    ).get(RUN_ID);
    assert.equal(before.status, 'invalid_output');
    db.close();

    const result = revalidate({ runId: RUN_ID, dbPath, outputs, reason: 'corrected', apply: false });

    assert.equal(result.dryRun, true);
    assert.equal(result.repairs.length, 1);
    assert.equal(result.repairs[0].applied, false);

    const db2 = openDb(dbPath);
    const after = db2.prepare(
      `SELECT status FROM agent_runs WHERE wave_id = 1 AND domain_id = (SELECT id FROM domains WHERE run_id = ? AND name = 'backend')`
    ).get(RUN_ID);
    assert.equal(after.status, 'invalid_output'); // unchanged
    db2.close();
  });

  it('--apply transitions blocked → complete and records agent_state_events row', () => {
    const outputs = { backend: writeAmendOutput('backend') };

    const result = revalidate({
      runId: RUN_ID, dbPath, outputs, reason: 'wave-2 schema mismatch corrected', apply: true,
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.repairs.length, 1);
    assert.equal(result.repairs[0].applied, true);
    assert.equal(result.repairs[0].from, 'invalid_output');
    assert.equal(result.repairs[0].to, 'complete');

    const db = openDb(dbPath);
    const ar = db.prepare(
      `SELECT id, status FROM agent_runs WHERE wave_id = 1 AND domain_id = (SELECT id FROM domains WHERE run_id = ? AND name = 'backend')`
    ).get(RUN_ID);
    assert.equal(ar.status, 'complete');

    const events = getTransitionHistory(db, ar.id);
    const override = events.find(e => e.to_status === 'complete' && e.reason === 'wave-2 schema mismatch corrected');
    assert.ok(override, 'agent_state_events row should record the override with the operator reason');
    db.close();
  });

  // ───────────────────────────────────────────────────────
  // Validation refusals
  // ───────────────────────────────────────────────────────

  it('refuses output that fails the envelope schema', () => {
    const outputPath = join(outputDir, 'backend.json');
    writeFileSync(outputPath, JSON.stringify({ wrong_shape: true }), 'utf-8');

    const result = revalidate({
      runId: RUN_ID, dbPath, outputs: { backend: outputPath }, reason: 'still broken', apply: true,
    });

    assert.equal(result.repairs.length, 0);
    assert.equal(result.refusals.length, 1);
    assert.match(result.refusals[0].reason, /schema/);

    const db = openDb(dbPath);
    const ar = db.prepare(
      `SELECT status FROM agent_runs WHERE wave_id = 1 AND domain_id = (SELECT id FROM domains WHERE run_id = ? AND name = 'backend')`
    ).get(RUN_ID);
    assert.equal(ar.status, 'invalid_output'); // unchanged on refusal
    db.close();
  });

  it('refuses output that fails the legacy amend validator (no fixes array)', () => {
    const outputPath = join(outputDir, 'backend.json');
    writeFileSync(outputPath, JSON.stringify({
      domain: 'backend',
      summary: 'missing fixes array',
      // no `fixes` → legacy validateAmendOutput rejects
    }), 'utf-8');

    const result = revalidate({
      runId: RUN_ID, dbPath, outputs: { backend: outputPath }, reason: 'still broken', apply: true,
    });

    assert.equal(result.repairs.length, 0);
    assert.equal(result.refusals.length, 1);
  });

  // ───────────────────────────────────────────────────────
  // Wave-level rollback (the regression case from this session)
  // ───────────────────────────────────────────────────────

  it('partial repair: N=4 blocked, repair N-1 → wave stays failed', () => {
    const outputs = {
      backend:      writeAmendOutput('backend'),
      'ci-tooling': writeAmendOutput('ci-tooling'),
      docs:         writeAmendOutput('docs'),
      // tests omitted — that agent_run stays invalid_output
    };

    const result = revalidate({
      runId: RUN_ID, dbPath, outputs, reason: 'partial repair regression test', apply: true,
    });

    assert.equal(result.repairs.length, 3);
    assert.ok(result.repairs.every(r => r.applied));
    assert.equal(result.waveStatusBefore, 'failed');
    assert.equal(result.waveStatusAfter, 'failed'); // wave MUST stay failed

    const db = openDb(dbPath);
    const wave = db.prepare('SELECT status FROM waves WHERE id = 1').get();
    assert.equal(wave.status, 'failed');

    // Confirm the 4th agent_run is still invalid_output
    const stuck = db.prepare(`
      SELECT ar.status FROM agent_runs ar
      JOIN domains d ON d.id = ar.domain_id
      WHERE ar.wave_id = 1 AND d.name = 'tests'
    `).get();
    assert.equal(stuck.status, 'invalid_output');
    db.close();
  });

  it('full repair: all 4 blocked → wave transitions to collected in the same transaction', () => {
    const outputs = {
      backend:      writeAmendOutput('backend'),
      'ci-tooling': writeAmendOutput('ci-tooling'),
      docs:         writeAmendOutput('docs'),
      tests:        writeAmendOutput('tests'),
    };

    const result = revalidate({
      runId: RUN_ID, dbPath, outputs, reason: 'full repair test', apply: true,
    });

    assert.equal(result.repairs.length, 4);
    assert.ok(result.repairs.every(r => r.applied));
    assert.equal(result.waveStatusBefore, 'failed');
    assert.equal(result.waveStatusAfter, 'collected');

    const db = openDb(dbPath);
    const wave = db.prepare('SELECT status, completed_at FROM waves WHERE id = 1').get();
    assert.equal(wave.status, 'collected');
    assert.ok(wave.completed_at, 'completed_at should be set when wave transitions to collected');
    db.close();
  });

  // ───────────────────────────────────────────────────────
  // Idempotency + status guards
  // ───────────────────────────────────────────────────────

  it('idempotent: re-running on already-complete rows is a no-op skip', () => {
    const outputs = { backend: writeAmendOutput('backend') };

    revalidate({ runId: RUN_ID, dbPath, outputs, reason: 'first repair', apply: true });
    const second = revalidate({ runId: RUN_ID, dbPath, outputs, reason: 'second repair', apply: true });

    assert.equal(second.repairs.length, 0, 'no new repairs on second call');
    assert.equal(second.skipped.length, 1);
    assert.match(second.skipped[0].reason, /already 'complete'/);
  });

  it('refuses non-blocked statuses (only invalid_output / ownership_violation can be repaired)', () => {
    // Move agent to 'dispatched' (not blocked) — revalidate must refuse.
    const db = openDb(dbPath);
    db.prepare(`UPDATE agent_runs SET status = 'dispatched' WHERE wave_id = 1 AND domain_id = (SELECT id FROM domains WHERE run_id = ? AND name = 'backend')`)
      .run(RUN_ID);
    db.close();

    const outputs = { backend: writeAmendOutput('backend') };
    const result = revalidate({
      runId: RUN_ID, dbPath, outputs, reason: 'wrong status — should refuse', apply: true,
    });

    assert.equal(result.repairs.length, 0);
    assert.equal(result.refusals.length, 1);
    assert.match(result.refusals[0].reason, /not blocked/);
  });

  it('handles unknown domain name with a refusal (not a crash)', () => {
    const outputs = { 'no-such-domain': writeAmendOutput('backend') };
    const result = revalidate({
      runId: RUN_ID, dbPath, outputs, reason: 'unknown domain', apply: true,
    });

    assert.equal(result.repairs.length, 0);
    assert.equal(result.refusals.length, 1);
    assert.match(result.refusals[0].reason, /unknown domain/);
  });
});
