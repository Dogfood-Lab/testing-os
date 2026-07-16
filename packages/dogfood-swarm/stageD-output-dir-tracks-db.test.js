/**
 * stageD-output-dir-tracks-db.test.js — getOutputDir tracks the active control plane.
 *
 * Stage D fix-up: getOutputDir(runId) used to hardcode the build-relative
 * `../../swarms` dir, ignoring SWARM_DB. A verify-* run against a custom
 * SWARM_DB (a relocated control plane, or a test's temp DB) therefore wrote its
 * delta JSON into THIS repo's swarms/ tree — polluting the canonical backing
 * store and leaking untracked test artifacts. The fix derives the output base
 * from dirname(getDbPath()), so the delta follows the DB in use. Default
 * behavior (no SWARM_DB) is unchanged.
 *
 * CLI-subprocess test (mirrors verify-json-purity.test.js): runs `verify-fixed
 * <run>` with SWARM_DB pointed at a temp dir and asserts (a) the delta lands
 * under that temp dir and (b) no run directory is created in the repo swarms/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from './db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');
const REPO_SWARMS = resolve(__dirname, '..', '..', 'swarms');
const RUN_ID = 'outdir-probe-run';

// task_6026249b: the live control plane's own file family is ambient state,
// not a getOutputDir output — operator CLI use (`swarm status`, `swarm
// collect`) and WAL checkpointing churn control-plane.db's -shm/-wal sidecars
// independently of this test's snapshot window, and under full-suite
// concurrency that churn landed INSIDE the window and flaked this test. The
// leak this test polices is run-directory/delta creation in the repo tree, so
// the DB family is excluded from the diff. (The companion fix: the live-DB
// isolation sweep in meta-wal-sidecar-teardown-guard.test.js keeps sibling
// tests from opening the repo DB at all; this filter keeps the snapshot honest
// even against an operator terminal churning sidecars mid-run.)
const LIVE_DB_FAMILY = /^control-plane\.db(-shm|-wal|-journal)?$/;

test('getOutputDir: verify-* delta follows SWARM_DB and does not pollute the repo swarms/ tree', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'swarm-outdir-'));
  const dbPath = join(tmp, 'control-plane.db');

  try {
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
       VALUES (?, 'org/repo-a', ?, ?, 'main', 'health-audit-a', '2026-06-01 00:00:00')`
    ).run(RUN_ID, tmp, 'a'.repeat(40));
    db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    closeDb(dbPath);

    const before = existsSync(REPO_SWARMS) ? new Set(readdirSync(REPO_SWARMS)) : new Set();

    spawnSync(process.execPath, [CLI_PATH, 'verify-fixed', RUN_ID], {
      env: { ...process.env, SWARM_DB: dbPath },
      encoding: 'utf-8',
    });

    // (a) the delta JSON landed under the temp control plane's dir.
    assert.ok(
      existsSync(join(tmp, RUN_ID)),
      `expected verify delta under the SWARM_DB dir (${join(tmp, RUN_ID)})`,
    );

    // (b) the repo swarms/ tree gained no run directory for this probe.
    assert.ok(
      !existsSync(join(REPO_SWARMS, RUN_ID)),
      `getOutputDir leaked into the repo swarms/ tree: ${join(REPO_SWARMS, RUN_ID)} was created`,
    );
    const after = existsSync(REPO_SWARMS) ? new Set(readdirSync(REPO_SWARMS)) : new Set();
    const leaked = [...after].filter((n) => !before.has(n) && !LIVE_DB_FAMILY.test(n));
    assert.deepEqual(leaked, [], `repo swarms/ gained unexpected entries: ${leaked.join(', ')}`);
  } finally {
    // F-8ad2d58d-class: spawnSync above runs the CLI as a real child process
    // against this real file-backed dbPath (WAL mode). closeDb only releases
    // this process's own pooled connection, never the just-exited child's
    // OS-level lock on the -wal/-shm sidecar files, so rmSync must tolerate
    // Windows lock lag too (matches the established package-wide idiom).
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});
