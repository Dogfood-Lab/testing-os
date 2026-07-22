/**
 * stageC-rewind-worktree-cleanup.test.js
 *
 * Stage-C (humanization) amend — d4-swarm-core-B002 (MEDIUM, degradation).
 *
 * `swarm rewind --apply` runs `git reset --hard <tag>` on the main working
 * tree and transitions every non-terminal wave + agent_run to
 * aborted_for_rewind, but did NOT clean up the per-agent worktrees those
 * aborted agent_runs created under --isolate. The aborted rows still carry
 * worktree_path / worktree_branch (set at dispatch), yet rewind never called
 * removeWorktree(). `git reset --hard` only moves the main worktree at `cwd`;
 * the sibling worktrees under .swarm/worktrees/ are SEPARATE git worktrees
 * the reset does not touch — so a rewind left them on disk pointing at
 * branches whose base commit was just rewound away. `git worktree list` and
 * `git branch` show stale entries; disk is not reclaimed.
 *
 * The fix: after the DB transaction commits in the --apply path, best-effort
 * removeWorktree(cwd, worktree_path, worktree_branch) for each APPLIED
 * agent_run that carries a worktree, inside a try/catch that emits a
 * structured logStage('rewind_worktree_cleanup_failed', ...) breadcrumb on
 * failure — the same best-effort + breadcrumb pattern cleanupAllWorktrees
 * uses for `worktree prune`. A cleanup error must NOT sink the rewind (the
 * git reset + DB abort already landed).
 *
 * CORDONED-TEST DISCIPLINE (mirrors rewind.test.js): every test creates a
 * fresh mkdtempSync fixture git repo + fixture DB, passes cwd + dbPath
 * explicitly, and rmSyncs the fixture in finally. No test touches the live
 * repo, process.cwd(), or the real control-plane.db.
 *
 * Pins, test-first:
 *   1. GUARD FIRES: after --apply, the worktrees owned by the aborted
 *      agent_runs are gone from disk AND from `git worktree list`, and their
 *      branches are deleted.
 *   2. HEALTHY INPUT STILL PASSES: a dry-run (no --apply) leaves every
 *      worktree intact — cleanup only happens on the destructive --apply path.
 *   3. RECLAIM + BEST-EFFORT: a worktree `git worktree remove --force` leaves
 *      on disk (a plain directory occupying the recorded path under
 *      .swarm/worktrees/ — the exact Windows npm-workspaces junction-strand
 *      shape) is now RECLAIMED by removeWorktree's fs-level fallback (2026-07-22
 *      Windows-teardown fix, worktree-windows-teardown.test.js), so --apply
 *      cleans it AND completes the abort. When cleanup GENUINELY cannot remove
 *      a path (the fs reclaim also fails), --apply still completes the abort and
 *      emits a rewind_worktree_cleanup_failed breadcrumb — proven POSIX-side,
 *      where a read-only parent makes removal fail deterministically.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { createWorktree, listWorktrees } from './lib/worktree.js';
import { rewind } from './commands/rewind.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Fixture: a fresh git repo with a save-point tag at the initial commit, a
 * second commit on top (so HEAD differs from the tag), a fixture DB with one
 * run + two owned domains, and a dispatched wave whose agent_runs each own a
 * REAL worktree created via createWorktree() and carry worktree_path /
 * worktree_branch.
 */
function setupFixtureWithWorktrees({ createOnDisk = true } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'stageC-rewind-wt-'));

  git(tempDir, ['init', '-q', '-b', 'main']);
  git(tempDir, ['config', 'user.email', 'fixture@example.test']);
  git(tempDir, ['config', 'user.name', 'Fixture']);
  git(tempDir, ['config', 'commit.gpgsign', 'false']);

  // .swarm/ must be ignored so the worktree dirs do not trip the dirty-tree
  // guard; *.db sidecars too (openDb creates them).
  writeFileSync(join(tempDir, '.gitignore'), '.swarm/\n*.db\n*.db-wal\n*.db-shm\n', 'utf-8');
  writeFileSync(join(tempDir, 'README.md'), '# fixture\n', 'utf-8');
  git(tempDir, ['add', '.']);
  git(tempDir, ['commit', '-q', '-m', 'fixture: initial']);
  git(tempDir, ['tag', 'swarm-save-fixture-1']);

  writeFileSync(join(tempDir, 'README.md'), '# fixture\n\nsecond\n', 'utf-8');
  git(tempDir, ['add', '.']);
  git(tempDir, ['commit', '-q', '-m', 'fixture: second']);

  const dbPath = join(tempDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run('r1', 'org/r', tempDir, 'a'.repeat(40));
  db.prepare("INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('r1','backend','[\"src/**\"]','owned',1)").run();
  db.prepare("INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('r1','tests','[\"tests/**\"]','owned',1)").run();

  const w = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES ('r1','health-amend-a',1,'dispatched','snap1')"
  ).run();
  const waveId = Number(w.lastInsertRowid);

  const domains = db.prepare("SELECT id, name FROM domains WHERE run_id = 'r1'").all();
  const agents = [];
  for (const d of domains) {
    let worktreePath, branch;
    if (createOnDisk) {
      const wt = createWorktree(tempDir, { runId: 'r1', waveNumber: 1, domainName: d.name });
      worktreePath = wt.worktreePath;
      branch = wt.branch;
    } else {
      // Path that was persisted but never created (or already pruned) — the
      // failure-channel scenario.
      // F-527dc73e naming: w<N>-<domain>-<runShort> (runShortOf('r1') === 'r1').
      worktreePath = join(tempDir, '.swarm', 'worktrees', `w1-${d.name}-r1`);
      branch = `swarm/r1/w1-${d.name}`;
    }
    const ar = db.prepare(
      "INSERT INTO agent_runs (wave_id, domain_id, status, worktree_path, worktree_branch) VALUES (?, ?, 'dispatched', ?, ?)"
    ).run(waveId, d.id, worktreePath, branch);
    agents.push({ id: Number(ar.lastInsertRowid), domain: d.name, worktreePath, branch });
  }
  closeDb(dbPath);

  return { tempDir, dbPath, waveId, agents };
}

function teardown(tempDir, dbPath) {
  if (dbPath) { try { closeDb(dbPath); } catch { /* */ } }
  if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ } }
}

/**
 * Run `fn` capturing both its return value and everything it wrote to
 * console.error (where logStage emits NDJSON). Returns { result, lines }.
 */
function captureRun(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  let result;
  try { result = fn(); } finally { console.error = original; }
  return { result, lines };
}

function branchExists(cwd, branch) {
  try {
    git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════
// Guard fires — --apply tears down the aborted agents' worktrees
// ═══════════════════════════════════════════

describe('B002 — rewind --apply cleans up the aborted agents\' worktrees', () => {
  it('removes the worktree dirs + branches owned by the aborted agent_runs', () => {
    const { tempDir, dbPath, waveId, agents } = setupFixtureWithWorktrees();
    try {
      // Pre-condition: the worktrees exist and git lists them; branches exist.
      for (const a of agents) {
        assert.ok(existsSync(a.worktreePath), `worktree must exist pre-rewind: ${a.worktreePath}`);
        assert.ok(branchExists(tempDir, a.branch), `branch must exist pre-rewind: ${a.branch}`);
      }
      assert.equal(listWorktrees(tempDir).length, agents.length,
        'git must list the swarm worktrees before rewind');

      const { result: r } = captureRun(() => rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'cleanup worktrees on rewind',
        cwd: tempDir,
        dbPath,
        apply: true,
      }));

      // The lawful rewind landed.
      assert.equal(r.git_reset_done, true);
      assert.equal(r.db_transaction_done, true);

      // Every aborted agent_run's worktree is gone — disk, git list, branch.
      for (const a of agents) {
        assert.ok(!existsSync(a.worktreePath),
          `worktree dir must be removed after --apply: ${a.worktreePath}`);
        assert.ok(!branchExists(tempDir, a.branch),
          `worktree branch must be deleted after --apply: ${a.branch}`);
      }
      assert.equal(listWorktrees(tempDir).length, 0,
        'no swarm worktree may survive an applied rewind');

      // And the DB rows are aborted (sanity — the existing rewind contract).
      const db = openDb(dbPath);
      const w = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'aborted_for_rewind');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('a DRY-RUN (no --apply) leaves every worktree intact', () => {
    // Healthy-input control: cleanup is bound to the destructive --apply path.
    // A preview must not touch the filesystem.
    const { tempDir, dbPath, agents } = setupFixtureWithWorktrees();
    try {
      const { result: r } = captureRun(() => rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'preview only',
        cwd: tempDir,
        dbPath,
        // no apply
      }));
      assert.equal(r.dryRun, true);
      assert.equal(r.git_reset_done, false);

      for (const a of agents) {
        assert.ok(existsSync(a.worktreePath),
          `dry-run must leave worktree intact: ${a.worktreePath}`);
        assert.ok(branchExists(tempDir, a.branch),
          `dry-run must leave branch intact: ${a.branch}`);
      }
      assert.equal(listWorktrees(tempDir).length, agents.length);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ═══════════════════════════════════════════
// Best-effort + breadcrumb — an un-removable worktree does not sink the rewind
// ═══════════════════════════════════════════

describe('B002 — rewind worktree cleanup: reclaim, then best-effort breadcrumb', () => {
  it('reclaims a git-stranded survivor under --apply and still completes the abort', () => {
    // The Windows junction-strand shape, portable: a plain (non-worktree)
    // directory occupies the recorded worktree_path under .swarm/worktrees/ —
    // exactly what `git worktree remove --force` leaves behind on Windows for an
    // npm-workspaces --isolate worktree. removeWorktree's fs-level fallback now
    // RECLAIMS it, so the rewind cleans it AND completes the abort (was:
    // reported stranded, left for the operator to prune manually).
    const { tempDir, dbPath, waveId, agents } = setupFixtureWithWorktrees({ createOnDisk: false });

    for (const a of agents) {
      mkdirSync(a.worktreePath, { recursive: true });
      writeFileSync(join(a.worktreePath, 'occupied.txt'), 'not a worktree\n', 'utf-8');
    }

    try {
      const { result: r, lines } = captureRun(() => rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'reclaim a stranded worktree on rewind',
        cwd: tempDir,
        dbPath,
        apply: true,
      }));

      // The lawful rewind landed AND the strand-shape survivors are reclaimed.
      assert.equal(r.git_reset_done, true);
      assert.equal(r.db_transaction_done, true);
      for (const a of agents) {
        assert.ok(!existsSync(a.worktreePath),
          `the strand-shape survivor is reclaimed by --apply: ${a.worktreePath}`);
      }

      const db = openDb(dbPath);
      assert.equal(db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId).status,
        'aborted_for_rewind', 'the DB abort completes regardless of worktree-cleanup outcome');
      closeDb(dbPath);

      const failedRows = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(o => o && o.stage === 'rewind_worktree_cleanup_failed');
      assert.equal(failedRows.length, 0,
        'a reclaimed survivor is not reported as a cleanup failure');
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  // POSIX-only: a read-only PARENT directory makes child removal fail
  // deterministically (rmSync + force cannot chmod the parent to unlink the
  // child). On this rig's Node/Windows there is no comparably reliable way to
  // force removal to fail — an open handle does not block it (Node opens with
  // FILE_SHARE_DELETE) — so the "cleanup genuinely failed" branch is proven
  // POSIX-side, where CI runs. The rewind wiring under test is platform-agnostic.
  it('completes the abort and logs rewind_worktree_cleanup_failed when cleanup genuinely fails',
    { skip: process.platform === 'win32' }, () => {
    const { tempDir, dbPath, waveId, agents } = setupFixtureWithWorktrees({ createOnDisk: false });

    for (const a of agents) {
      mkdirSync(a.worktreePath, { recursive: true });
      writeFileSync(join(a.worktreePath, 'occupied.txt'), 'stuck\n', 'utf-8');
    }
    // Freeze the swarm-worktrees parent read-only so the fs reclaim cannot
    // delete its children — a genuinely-unremovable worktree.
    const worktreesDir = join(tempDir, '.swarm', 'worktrees');
    chmodSync(worktreesDir, 0o555);

    try {
      const { result: r, lines } = captureRun(() => rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'cleanup with a genuinely stuck worktree',
        cwd: tempDir,
        dbPath,
        apply: true,
      }));

      // A stuck cleanup does not sink the rewind.
      assert.equal(r.git_reset_done, true);
      assert.equal(r.db_transaction_done, true);
      const db = openDb(dbPath);
      assert.equal(db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId).status,
        'aborted_for_rewind', 'the DB abort completes regardless of worktree-cleanup outcome');
      closeDb(dbPath);

      const rows = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(o => o && o.stage === 'rewind_worktree_cleanup_failed');
      assert.ok(rows.length > 0,
        'a rewind_worktree_cleanup_failed row is emitted for a genuinely-stuck worktree');
      assert.equal(rows[0].component, 'dogfood-swarm');
      assert.ok(agents.some(a => a.worktreePath === rows[0].worktreePath),
        `the breadcrumb names a recorded worktree path; got ${rows[0].worktreePath}`);
      assert.ok(agents.some(a => existsSync(a.worktreePath)),
        'the stuck dir genuinely survives — the breadcrumb is honest');
    } finally {
      try { chmodSync(worktreesDir, 0o755); } catch { /* restore for teardown */ }
      teardown(tempDir, dbPath);
    }
  });
});
