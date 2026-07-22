/**
 * worktree-windows-teardown.test.js — robust Windows --isolate worktree reclaim.
 *
 * INCIDENT (ai-rpg-engine v2.8 dogfood cycle, 2026-07-22, Windows): `swarm
 * clean --apply` and the recordPromotion terminal teardown could not fully
 * remove --isolate worktrees for an npm-workspaces repo. `git worktree remove
 * --force` reported success yet LEFT the worktree directory on disk. Reproduced
 * live here: the untracked node_modules/ subtree that holds the workspace
 * directory JUNCTIONS (provisionWorkspaceLinks, lib/workspace-links.js)
 * survives git's removal, while git has already dropped the worktree admin ref
 * — so `git worktree list` reports clean and a SECOND `swarm clean` can no
 * longer even see the orphan. Every wave then needed a manual `git worktree
 * remove` + `rm -rf .swarm/worktrees/*` + `git branch -D` + `git worktree
 * prune`; `swarm clean --apply` reported "0 removed, N stranded".
 *
 * THE FIX (lib/worktree.js#removeWorktree): after `git worktree remove
 * --force`, if the swarm worktree path survives on disk, reclaim it at the fs
 * level (forceRemoveDir — rmSync recursive+force, with a read-only pre-clear
 * fallback), then `git worktree prune` and delete the branch. Two safety
 * properties, both proven below: the fs reclaim is bounded to `.swarm/
 * worktrees/` scratch (containment guard) and is junction-safe (rmSync unlinks
 * a junction as a leaf, never following it into an external target).
 *
 * CORDONED-TEST DISCIPLINE (mirrors clean-worktree-lifecycle / redrive): every
 * test builds a fresh fixture repo + control-plane.db via mkdtempSync — never
 * process.cwd(), never the real repo, never the live shared control-plane.db.
 * afterEach rmSync's the fixture (Windows-tolerant).
 *
 * PLATFORM NOTE: the git-strand is Windows-specific — POSIX `git worktree
 * remove` deletes the tree cleanly (junctions materialize as plain symlinks and
 * are removed with it). To give Linux CI a RED-before / GREEN-after proof of
 * the reclaim LOGIC, the removeWorktree-level tests use a git-unremovable
 * SURVIVOR PROXY: a real worktree whose git registration is then broken so `git
 * worktree remove --force` errors and leaves the dir — the identical
 * post-condition to the Windows junction strand, portable to both platforms.
 * The `swarm clean` headline test uses REAL workspace junctions (createWorktree
 * on an npm-workspaces fixture) and so is RED-before only on Windows; on POSIX
 * it is a passing regression guard.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import {
  createWorktree, removeWorktree, listWorktrees, forceRemoveDir,
} from './lib/worktree.js';
import { clean } from './commands/clean.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');
const isWindows = process.platform === 'win32';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Init a bare git repo with the swarm .gitignore + a root commit. */
function initRepo(extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-win-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, '.gitignore'), '.swarm/\nnode_modules/\n', 'utf-8');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
  for (const [rel, body] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body, 'utf-8');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'root']);
  return root;
}

/** An npm-workspaces fixture — createWorktree provisions real node_modules
 *  junctions for this shape (the exact ai-rpg-engine trigger). */
function initWorkspacesRepo() {
  return initRepo({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2) + '\n',
    'packages/core/package.json': JSON.stringify({ name: '@fx/core', version: '1.0.0' }) + '\n',
    'packages/core/index.js': "export const x = 'core';\n",
    'packages/cli/package.json': JSON.stringify({ name: '@fx/cli', version: '1.0.0' }) + '\n',
    'packages/cli/index.js': "export const x = 'cli';\n",
  });
}

/**
 * Break a worktree's git registration so `git worktree remove --force` can no
 * longer delete it — the portable stand-in for the Windows junction strand.
 * After this, the worktree DIRECTORY is a plain orphan on disk while git no
 * longer tracks it (identical post-condition to the live incident).
 */
function strandGitRegistration(repo, worktreePath) {
  rmSync(join(worktreePath, '.git'), { recursive: true, force: true });
  git(repo, ['worktree', 'prune']);
  assert.ok(existsSync(worktreePath), 'precondition: the orphaned worktree dir is still on disk');
}

/**
 * Capture NDJSON logStage rows (DOGFOOD_LOG_HUMAN=0 suppresses the human
 * banner) plus the callback's return value. Mirrors ph-ds-01's capture().
 */
function capture(fn) {
  const prev = process.env.DOGFOOD_LOG_HUMAN;
  process.env.DOGFOOD_LOG_HUMAN = '0';
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  let value;
  try { value = fn(); } finally {
    console.error = original;
    if (prev === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
    else process.env.DOGFOOD_LOG_HUMAN = prev;
  }
  return { value, rows: lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
}

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ════════════════════════════════════════════════════════════════════════
// removeWorktree — fs-level reclaim of a git-stranded --isolate worktree
// ════════════════════════════════════════════════════════════════════════

describe('removeWorktree — reclaims a worktree git cannot delete', () => {
  let repo;
  beforeEach(() => { repo = initRepo(); });
  afterEach(() => cleanup(repo));

  it('fully reclaims a git-stranded worktree carrying a read-only file and a staged change', () => {
    // The incident shape, portable: a real --isolate worktree that (a) carries
    // a read-only working file + a staged change (the "already collected /
    // scratch" case `swarm clean --force` must be able to destroy) and (b) has
    // become a git-orphan so `git worktree remove --force` leaves it on disk.
    const wt = createWorktree(repo, { runId: 'swarm-winfix0001', waveNumber: 1, domainName: 'backend' });
    writeFileSync(join(wt.worktreePath, 'edit.txt'), 'staged edit\n', 'utf-8');
    git(wt.worktreePath, ['add', '-A']);                       // staged (dirty) change
    const roFile = join(wt.worktreePath, 'ro.txt');
    writeFileSync(roFile, 'read only\n', 'utf-8');
    chmodSync(roFile, 0o444);                                  // read-only working file
    strandGitRegistration(repo, wt.worktreePath);

    const { value } = capture(() => removeWorktree(repo, wt.worktreePath, wt.branch));

    // RED before the fix: removeWorktree returns { removed:false, stranded:true }
    // and leaves the directory. GREEN after: the fs-level reclaim removes it.
    assert.equal(value.stranded, false, 'a reclaimable worktree must not be reported stranded');
    assert.equal(value.removed, true, 'the worktree is reclaimed at the fs level');
    assert.ok(!existsSync(wt.worktreePath), 'the worktree directory is gone from disk');

    // Branch deleted + git worktree list clean (no orphan bookkeeping).
    const branches = git(repo, ['branch', '--list', wt.branch.replace('refs/heads/', '')]).trim();
    assert.equal(branches, '', 'the swarm/* branch is deleted');
    assert.equal(listWorktrees(repo).length, 0, 'git worktree list carries no survivor for this run');
  });

  it('emits a worktree_fs_reclaimed breadcrumb when the fs fallback fires', () => {
    const wt = createWorktree(repo, { runId: 'swarm-winfix0002', waveNumber: 1, domainName: 'tests' });
    strandGitRegistration(repo, wt.worktreePath);

    const { rows } = capture(() => removeWorktree(repo, wt.worktreePath, wt.branch));

    const reclaimed = rows.find(r => r.stage === 'worktree_fs_reclaimed');
    assert.ok(reclaimed, 'the operator gets a durable record that the fs-level reclaim was needed');
    assert.equal(reclaimed.component, 'dogfood-swarm');
    assert.equal(reclaimed.worktreePath, wt.worktreePath, 'the breadcrumb names the reclaimed path');
    assert.ok(!rows.some(r => r.stage === 'worktree_cleanup_failed'),
      'a successful reclaim must NOT also report cleanup_failed');
  });

  it('does NOT emit worktree_fs_reclaimed on the clean git-removal path', () => {
    // A healthy worktree git removes directly — the fs fallback never fires,
    // so neither the reclaim nor the failure breadcrumb is emitted.
    const wt = createWorktree(repo, { runId: 'swarm-winfix0003', waveNumber: 1, domainName: 'docs' });

    const { value, rows } = capture(() => removeWorktree(repo, wt.worktreePath, wt.branch));

    assert.equal(value.removed, true);
    assert.equal(value.stranded, false);
    assert.ok(!rows.some(r => r.stage === 'worktree_fs_reclaimed'),
      'the fs-reclaim breadcrumb must fire only when git actually left the path behind');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Safety: the fs reclaim is bounded and junction-safe
// ════════════════════════════════════════════════════════════════════════

describe('removeWorktree — the fs reclaim is bounded to swarm scratch', () => {
  let repo;
  beforeEach(() => { repo = initRepo(); });
  afterEach(() => cleanup(repo));

  it('refuses to force-remove a survivor path OUTSIDE .swarm/worktrees (stays stranded)', () => {
    // Defense in depth: force-removal only ever targets `.swarm/worktrees/`
    // scratch. A path that survives git-removal but is NOT swarm scratch is
    // left on disk and reported stranded — the fs bulldozer never touches it.
    const outside = join(repo, 'not-a-swarm-worktree');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'precious\n', 'utf-8');

    const { value, rows } = capture(() => removeWorktree(repo, outside, 'swarm/x/none'));

    assert.equal(value.stranded, true, 'a non-swarm survivor is reported stranded, not silently nuked');
    assert.ok(existsSync(join(outside, 'keep.txt')), 'the out-of-jail directory is left untouched');
    assert.ok(rows.some(r => r.stage === 'worktree_cleanup_failed'),
      'the operator is told the path was left for manual handling');
  });
});

describe('forceRemoveDir — junction-safe', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wt-jsafe-')); });
  afterEach(() => cleanup(root));

  it('unlinks a junction/symlink as a leaf without deleting its external target', () => {
    // The critical isolation invariant: workspace links inside a worktree are
    // reparse points. forceRemoveDir must remove the link, never recurse
    // through it into the target — otherwise reclaiming a worktree could delete
    // content outside it.
    const external = join(root, 'external-target');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'precious.txt'), 'DO NOT DELETE\n', 'utf-8');

    const box = join(root, 'box');
    mkdirSync(join(box, 'node_modules'), { recursive: true });
    symlinkSync(external, join(box, 'node_modules', 'linked'), 'junction'); // 'junction' ignored on POSIX
    writeFileSync(join(box, 'file.txt'), 'ordinary\n', 'utf-8');

    forceRemoveDir(box);

    assert.ok(!existsSync(box), 'the box (including the junction entry) is removed');
    assert.ok(existsSync(join(external, 'precious.txt')),
      'the junction target OUTSIDE the box survives — the link was unlinked, not followed');
  });

  it('removes a tree containing read-only files', () => {
    const box = join(root, 'ro-box');
    mkdirSync(join(box, 'nested'), { recursive: true });
    const f = join(box, 'nested', 'locked.txt');
    writeFileSync(f, 'x\n', 'utf-8');
    chmodSync(f, 0o444);

    forceRemoveDir(box);

    assert.ok(!existsSync(box), 'read-only content does not strand the removal');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Defensive: a genuinely-unremovable worktree still strands honestly
// ════════════════════════════════════════════════════════════════════════

describe('removeWorktree — genuinely-unremovable worktree still reports stranded', () => {
  let repo;
  beforeEach(() => { repo = initRepo(); });
  afterEach(() => {
    // Restore write on the swarm dir so the fixture teardown can delete it.
    try { chmodSync(join(repo, '.swarm', 'worktrees'), 0o755); } catch { /* best-effort */ }
    cleanup(repo);
  });

  // POSIX-only: a read-only PARENT directory blocks child removal even for
  // rmSync+force. On this rig's Node/Windows there is no comparably reliable
  // way to make removal fail (an open handle does not block it — Node opens
  // with FILE_SHARE_DELETE), so the defensive branch is exercised on POSIX,
  // where CI runs. The stranded code path itself is platform-agnostic.
  it('reports stranded + worktree_cleanup_failed when even the fs reclaim fails', { skip: isWindows }, () => {
    const wtDir = join(repo, '.swarm', 'worktrees', 'stuck-w1-backend-winfix00');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, 'child.txt'), 'x\n', 'utf-8');
    chmodSync(join(repo, '.swarm', 'worktrees'), 0o555); // read-only parent → child unremovable

    const { value, rows } = capture(() => removeWorktree(repo, wtDir, 'swarm/winfix00/w1-backend'));

    assert.equal(value.stranded, true, 'a genuinely-unremovable worktree is honestly reported stranded');
    assert.equal(value.removed, false);
    const failed = rows.find(r => r.stage === 'worktree_cleanup_failed');
    assert.ok(failed, 'the operator gets a worktree_cleanup_failed breadcrumb naming the survivor');
    assert.equal(failed.worktreePath, wtDir);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Headline: `swarm clean --apply --force` fully reclaims stranded worktrees
// ════════════════════════════════════════════════════════════════════════

describe('swarm clean --apply --force — reclaims the incident-shape worktrees', () => {
  let repo;
  let dbPath;
  const runId = 'swarm-winclean01';

  beforeEach(() => {
    repo = initWorkspacesRepo();
    dbPath = join(repo, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, branch) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 'org/r', repo, 'a'.repeat(40), 'main');
    closeDb(dbPath);
  });
  afterEach(() => cleanup(repo));

  it('fully reclaims a dirty read-only isolate worktree: dir gone, branch deleted, list clean', () => {
    // Faithful reproduction: a real npm-workspaces --isolate worktree (real
    // node_modules junctions) made dirty (staged change) + read-only. On
    // Windows `git worktree remove --force` strands it; the fix reclaims it.
    // RED before the fix on Windows; a passing regression guard on POSIX.
    const wt = createWorktree(repo, { runId, waveNumber: 1, domainName: 'backend' });
    assert.ok(existsSync(join(wt.worktreePath, 'node_modules', '@fx', 'core')),
      'precondition: the workspace junction is provisioned (the strand trigger)');
    writeFileSync(join(wt.worktreePath, 'packages', 'core', 'index.js'), "export const x='edited';\n", 'utf-8');
    git(wt.worktreePath, ['add', '-A']);                       // dirty (staged)
    chmodSync(join(wt.worktreePath, 'packages', 'cli', 'index.js'), 0o444); // read-only tracked file

    const report = clean({ runId, dbPath, apply: true, force: true });

    assert.equal(report.total, 1, 'the run worktree is enumerated');
    assert.equal(report.stranded, 0, 'nothing strands after the fix');
    assert.equal(report.removed, 1, 'the dirty read-only worktree is reclaimed under --force');
    assert.ok(!existsSync(wt.worktreePath), 'the worktree directory is gone from disk');
    const branches = git(repo, ['branch', '--list', wt.branch.replace('refs/heads/', '')]).trim();
    assert.equal(branches, '', 'the swarm/* branch is deleted');
    assert.equal(listWorktrees(repo).length, 0, 'git worktree list is clean for this run');
  });

  it('CLI: `swarm clean --apply --force` exits 0 and removes the worktree', () => {
    const wt = createWorktree(repo, { runId, waveNumber: 2, domainName: 'tests' });
    writeFileSync(join(wt.worktreePath, 'packages', 'core', 'index.js'), "export const x='edit2';\n", 'utf-8');
    git(wt.worktreePath, ['add', '-A']);

    const r = runCli(['clean', runId, '--apply', '--force'], dbPath);
    assert.doesNotMatch(r.stderr || '', /SyntaxError|Cannot find module/, `cli load error:\n${r.stderr}`);
    assert.equal(r.status, 0, `clean --apply --force should exit 0; got ${r.status}\n${r.stderr}`);
    assert.ok(!existsSync(wt.worktreePath), 'the CLI --apply --force reclaimed the worktree');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Windows-faithful: the real junction strand, reclaimed (win32-only)
// ════════════════════════════════════════════════════════════════════════

describe('Windows junction strand — removeWorktree reclaims it', () => {
  let repo;
  beforeEach(() => { repo = initWorkspacesRepo(); });
  afterEach(() => cleanup(repo));

  // On Windows the provisioned node_modules junctions make `git worktree remove
  // --force` leave the directory on disk (git drops its own admin ref but
  // cannot delete the reparse-point tree). This asserts the exact live failure
  // is reclaimed. POSIX removes the tree cleanly, so this proof is win32-only.
  it('reclaims a provisioned worktree git worktree remove --force leaves behind', { skip: !isWindows }, () => {
    const wt = createWorktree(repo, { runId: 'swarm-winreal001', waveNumber: 1, domainName: 'backend' });
    assert.ok(existsSync(join(wt.worktreePath, 'node_modules', '@fx', 'core')));

    // Prove the strand precondition against git directly (the bug), then that
    // removeWorktree reclaims it (the fix).
    git(repo, ['worktree', 'remove', wt.worktreePath, '--force']);
    assert.ok(existsSync(wt.worktreePath),
      'precondition: git worktree remove --force strands the junction worktree on Windows');
    // Re-register-independent reclaim: removeWorktree force-removes the orphan.
    const { value } = capture(() => removeWorktree(repo, wt.worktreePath, wt.branch));
    assert.equal(value.removed, true, 'removeWorktree reclaims the stranded junction worktree');
    assert.ok(!existsSync(wt.worktreePath), 'the stranded worktree directory is gone');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Create path: re-dispatch / resume onto a stale strand reclaims it first
// ════════════════════════════════════════════════════════════════════════

describe('createWorktree — reclaims a stale strand before re-creating', () => {
  let repo;
  beforeEach(() => { repo = initWorkspacesRepo(); });
  afterEach(() => cleanup(repo));

  it('re-creates a worktree at a path a prior strand left occupied (resume / re-dispatch)', () => {
    // Resume / re-dispatch targets the SAME deterministic wtDir (runId + wave +
    // domain). A prior Windows junction strand leaves an orphan directory there;
    // before the fix the re-create's `git worktree add` fails on the occupied
    // path (proven: "already exists"). The stale-removal now fs-reclaims the
    // orphan first, so the re-create lands clean. Portable: strandGitRegistration
    // leaves the same orphan-at-wtDir shape on both platforms.
    const first = createWorktree(repo, { runId: 'swarm-winrecreate1', waveNumber: 1, domainName: 'backend' });
    strandGitRegistration(repo, first.worktreePath);
    assert.ok(existsSync(first.worktreePath), 'precondition: a stale orphan occupies the target path');

    const { value: second } = capture(() =>
      createWorktree(repo, { runId: 'swarm-winrecreate1', waveNumber: 1, domainName: 'backend' }));

    assert.equal(second.worktreePath, first.worktreePath, 'the re-create targets the same deterministic path');
    assert.ok(existsSync(join(second.worktreePath, '.git')),
      'the re-created worktree is a real git worktree again (add succeeded on the reclaimed path)');
    assert.ok(existsSync(join(second.worktreePath, 'node_modules', '@fx', 'core')),
      'workspace junctions are re-provisioned in the fresh worktree');
    assert.equal(listWorktrees(repo).length, 1, 'exactly one live worktree survives for this run');
  });
});
