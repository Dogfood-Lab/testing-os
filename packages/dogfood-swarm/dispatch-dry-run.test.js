/**
 * dispatch-dry-run.test.js — `swarm dispatch <run> <phase> --dry-run`.
 *
 * The dry-run/preview path for dispatch: WITHOUT mutating the control plane or
 * the working tree, preview the wave shape —
 *   - which domains become agents (shared skipped; owned/bridge dispatched)
 *   - the prompt paths that WOULD be written
 *   - (amend phases) the per-domain approved-finding routing counts
 *   - (--isolate) the worktrees that WOULD be created
 *
 * The load-bearing invariant: NO INSERT/UPDATE, NO file writes, NO worktree
 * creation. The test pins row-count identity before/after.
 *
 * Cordoned: fresh temp DB per test, never the live control plane.
 *
 * Pattern #10 (FAILS-then-PASSES): the --dry-run flag did not exist pre-build;
 * the preview report shape is the new behavior this test defines.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';

const RUN_ID = 'test-dispatch-dryrun';

function setupRun(dbPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));

  saveDomainDraft(db, RUN_ID, [
    { name: 'backend', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'frontend', globs: ['packages/b/**'], ownership_class: 'owned' },
    { name: 'shared', globs: ['shared/**'], ownership_class: 'shared' },
  ]);
  freezeDomains(db, RUN_ID);

  const insert = db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
     description, recommendation, status)
    VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);
  insert.run(RUN_ID, 'F-A-001', 'fp-a-1', 'HIGH', 'packages/a/src/foo.js', 10, 'A1', 'fix A1');
  insert.run(RUN_ID, 'F-A-002', 'fp-a-2', 'MEDIUM', 'packages/a/src/bar.js', 20, 'A2', 'fix A2');
  insert.run(RUN_ID, 'F-B-001', 'fp-b-1', 'HIGH', 'packages/b/src/baz.js', 30, 'B1', 'fix B1');

  return db;
}

function rowCounts(dbPath) {
  const db = openDb(dbPath);
  const counts = {
    waves: db.prepare('SELECT COUNT(*) c FROM waves').get().c,
    agent_runs: db.prepare('SELECT COUNT(*) c FROM agent_runs').get().c,
    agent_state_events: db.prepare('SELECT COUNT(*) c FROM agent_state_events').get().c,
    run_status: db.prepare('SELECT status FROM runs WHERE id = ?').get(RUN_ID).status,
  };
  closeDb(dbPath);
  return counts;
}

describe('dispatch --dry-run — control plane + tree unchanged', () => {
  let tmpDir, dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-dryrun-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
    closeDb(dbPath);
  });
  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves DB row counts and run status identical', () => {
    const before = rowCounts(dbPath);

    const report = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: join(tmpDir, 'out'),
      dryRun: true,
    });

    const after = rowCounts(dbPath);
    assert.deepEqual(after, before, 'dry-run must not mutate the control plane or run status');
    assert.equal(report.dryRun, true);
  });

  it('writes NO prompt files to the output dir', () => {
    const outDir = join(tmpDir, 'out');
    dispatch({
      runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: outDir, dryRun: true,
    });
    const waveDir = join(outDir, 'wave-1');
    assert.equal(existsSync(waveDir) && readdirSync(waveDir).length > 0, false,
      'dry-run must not write prompt files');
  });

  it('previews the wave shape: shared skipped, owned dispatched, prompt paths named', () => {
    const report = dispatch({
      runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: join(tmpDir, 'out'), dryRun: true,
    });

    assert.equal(report.waveNumber, 1, 'next wave would be #1');
    const domains = report.agents.map(a => a.domain).sort();
    assert.deepEqual(domains, ['backend', 'frontend'], 'shared is a zone, not an agent');
    for (const a of report.agents) {
      assert.match(a.promptPath, new RegExp(`wave-1[\\\\/]+${a.domain}\\.md$`),
        'prompt path is the deterministic would-write path');
    }
  });

  it('amend phase: reports per-domain approved-finding routing counts', () => {
    const report = dispatch({
      runId: RUN_ID, phase: 'health-amend-a', dbPath, outputDir: join(tmpDir, 'out'), dryRun: true,
    });
    const byDomain = Object.fromEntries(report.agents.map(a => [a.domain, a.approvedFindingCount]));
    assert.equal(byDomain.backend, 2, 'backend owns F-A-001 + F-A-002');
    assert.equal(byDomain.frontend, 1, 'frontend owns F-B-001');
  });

  it('--isolate: previews the worktrees that WOULD be created without creating them', () => {
    const report = dispatch({
      runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: join(tmpDir, 'out'),
      dryRun: true, isolate: true,
    });
    for (const a of report.agents) {
      assert.ok(a.worktreePath, 'isolate dry-run names the would-create worktree path');
      assert.ok(a.worktreeBranch, 'isolate dry-run names the would-create branch');
      assert.equal(existsSync(a.worktreePath), false, 'no worktree directory is actually created');
    }
  });
});
