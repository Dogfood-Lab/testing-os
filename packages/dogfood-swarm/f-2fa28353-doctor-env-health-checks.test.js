/**
 * f-2fa28353-doctor-env-health-checks.test.js — F-2fa28353 (MEDIUM):
 * swarm doctor preflight omitted the three environment health-checks the
 * trajectory note requires folding in from the claude-guardian job:
 *   (1) disk free on the SWARM_DB / .swarm worktrees volume
 *   (2) control-plane.db + .db-wal + .db-shm combined size
 *   (3) stranded --isolate residue under .swarm/worktrees
 *
 * Direction locked: extend commands/doctor.js (WARN-class; exit contract
 * unchanged — WARN does not gate). Do not fork claude-guardian. Repair for
 * (3) stays `swarm clean <run-id>`; doctor is read-only.
 *
 * Test invariants (RED→GREEN):
 *   1. runDoctor inventories disk-free, control-plane-size, stranded-worktrees.
 *   2. Each is WARN-class (never hard FAIL) — forced-warn paths keep exitCode 0.
 *   3. Threshold overrides force WARN/PASS without volume surgery.
 *   4. stranded-worktrees reuses listWorktrees / worktreeDisposition seams
 *      (injectable) and the hint names `swarm clean`.
 *   5. CONTROL: a clean temp repo + tiny DB + high disk floor reports PASS
 *      for all three new checks.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runDoctor,
  DISK_FREE_WARN_BYTES,
  CONTROL_PLANE_SIZE_WARN_BYTES,
} from './commands/doctor.js';
import { openDb, closeDb } from './db/connection.js';

const cleanupPaths = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

function freshScratch(prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(tmp);
  return tmp;
}

function freshDbPath(prefix) {
  const tmp = freshScratch(prefix);
  // Default layout so inferRepoPath resolves to tmp (parent of swarms/).
  const swarms = join(tmp, 'swarms');
  mkdirSync(swarms, { recursive: true });
  const dbPath = join(swarms, 'control-plane.db');
  openDb(dbPath);
  closeDb(dbPath);
  return { tmp, dbPath, repoPath: tmp };
}

/** @pins F-2fa28353 */
describe('F-2fa28353 — doctor env health-checks (disk / WAL / stranded worktrees)', () => {
  it('inventories the three new check ids alongside the prior four', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-inventory-');
    const report = runDoctor({
      dbPath,
      repoPath,
      listWorktrees: () => [],
    });
    const ids = report.checks.map((c) => c.id);
    assert.deepEqual(
      ids,
      [
        'node-version',
        'control-plane-writable',
        'schema-version',
        'git-available',
        'disk-free',
        'control-plane-size',
        'stranded-worktrees',
      ],
      `doctor check inventory drifted: ${JSON.stringify(ids)}`,
    );
  });

  it('disk-free WARNs below the floor and does not gate exit', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-disk-warn-');
    const report = runDoctor({
      dbPath,
      repoPath,
      // Force the soft floor above any realistic free amount.
      diskFreeWarnBytes: Number.MAX_SAFE_INTEGER,
      listWorktrees: () => [],
    });
    const check = report.checks.find((c) => c.id === 'disk-free');
    assert.ok(check, 'disk-free check must be present');
    assert.equal(check.status, 'warn');
    assert.notEqual(check.status, 'fail', 'disk-free is WARN-class, never hard FAIL');
    assert.match(check.message, /free/i);
    assert.equal(report.exitCode, 0, 'WARN must not gate the exit code');
  });

  it('disk-free PASSes on a healthy volume with the documented floor', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-disk-pass-');
    const report = runDoctor({
      dbPath,
      repoPath,
      diskFreeWarnBytes: DISK_FREE_WARN_BYTES,
      listWorktrees: () => [],
    });
    const check = report.checks.find((c) => c.id === 'disk-free');
    assert.equal(check.status, 'pass',
      `CI/dev volumes must clear the ${DISK_FREE_WARN_BYTES} byte floor; got: ${check.message}`);
  });

  it('control-plane-size WARNs when db+wal+shm exceed the ceiling', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-size-warn-');
    // Tiny ceiling forces WARN against a real freshly-created DB.
    const report = runDoctor({
      dbPath,
      repoPath,
      controlPlaneSizeWarnBytes: 1,
      listWorktrees: () => [],
    });
    const check = report.checks.find((c) => c.id === 'control-plane-size');
    assert.ok(check);
    assert.equal(check.status, 'warn');
    assert.match(check.message, /wal/i);
    assert.match(check.message, /shm/i);
    assert.equal(report.exitCode, 0);
  });

  it('control-plane-size PASSes under the documented ceiling for a fresh DB', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-size-pass-');
    const report = runDoctor({
      dbPath,
      repoPath,
      controlPlaneSizeWarnBytes: CONTROL_PLANE_SIZE_WARN_BYTES,
      listWorktrees: () => [],
    });
    const check = report.checks.find((c) => c.id === 'control-plane-size');
    assert.equal(check.status, 'pass',
      `fresh control-plane.db must sit under ${CONTROL_PLANE_SIZE_WARN_BYTES} bytes; got: ${check.message}`);
  });

  it('control-plane-size counts sibling -wal/-shm into the total', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-size-sidecars-');
    // Oversized WAL sidecar alone should trip a low ceiling.
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(4096));
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(1024));
    const report = runDoctor({
      dbPath,
      repoPath,
      controlPlaneSizeWarnBytes: 1024,
      listWorktrees: () => [],
    });
    const check = report.checks.find((c) => c.id === 'control-plane-size');
    assert.equal(check.status, 'warn');
    assert.match(check.message, /wal/i);
  });

  it('stranded-worktrees WARNs when listWorktrees returns residue and hints swarm clean', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-wt-warn-');
    const report = runDoctor({
      dbPath,
      repoPath,
      listWorktrees: () => ([
        {
          path: join(repoPath, '.swarm', 'worktrees', 'w5-demo-abcdef123456'),
          branch: 'refs/heads/swarm/abcdef123456/w5-demo',
        },
      ]),
      worktreeDisposition: () => ({ dirty: true, unmerged: false }),
    });
    const check = report.checks.find((c) => c.id === 'stranded-worktrees');
    assert.ok(check);
    assert.equal(check.status, 'warn');
    assert.match(check.message, /1 git-tracked/);
    assert.match(check.message, /dirty\/unmerged/);
    assert.match(check.message, /abcdef123456/);
    assert.match(check.hint || '', /swarm clean/);
    assert.equal(report.exitCode, 0, 'stranded-worktrees WARN must not gate');
  });

  it('stranded-worktrees PASSes when listWorktrees is empty and no orphan dirs exist', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-wt-pass-');
    const report = runDoctor({
      dbPath,
      repoPath,
      listWorktrees: () => [],
      worktreeDisposition: () => ({ dirty: false, unmerged: false }),
    });
    const check = report.checks.find((c) => c.id === 'stranded-worktrees');
    assert.equal(check.status, 'pass', check.message);
  });

  it('stranded-worktrees WARNs on fs-only orphan dirs even when git list is empty', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-wt-orphan-');
    const orphan = join(repoPath, '.swarm', 'worktrees', 'w9-orphan-deadbeef0001');
    mkdirSync(orphan, { recursive: true });
    const report = runDoctor({
      dbPath,
      repoPath,
      listWorktrees: () => [],
    });
    const check = report.checks.find((c) => c.id === 'stranded-worktrees');
    assert.equal(check.status, 'warn');
    assert.match(check.message, /fs-only orphan/);
    assert.match(check.hint || '', /swarm clean/);
  });

  it('a WARN-only report from the three new checks never sets exitCode non-zero', () => {
    const { dbPath, repoPath } = freshDbPath('f-2fa28353-exit-');
    const report = runDoctor({
      dbPath,
      repoPath,
      diskFreeWarnBytes: Number.MAX_SAFE_INTEGER,
      controlPlaneSizeWarnBytes: 1,
      listWorktrees: () => ([
        { path: join(repoPath, '.swarm', 'worktrees', 'w1-x'), branch: 'refs/heads/swarm/x/w1-x' },
      ]),
      worktreeDisposition: () => ({ dirty: false, unmerged: true }),
    });
    for (const id of ['disk-free', 'control-plane-size', 'stranded-worktrees']) {
      const c = report.checks.find((x) => x.id === id);
      assert.equal(c.status, 'warn', `${id} should warn under forced thresholds`);
      assert.notEqual(c.status, 'fail');
    }
    assert.equal(report.overallStatus, 'warn');
    assert.equal(report.exitCode, 0);
  });
});
