/**
 * stageC-advance-worktree-cleanup.test.js
 *
 * Stage-C (humanization) amend — d4-swarm-core-B001 (MEDIUM, degradation).
 *
 * The per-agent worktree lifecycle documented in lib/worktree.js was
 * half-wired: dispatch.js CREATES worktrees under --isolate (and persists
 * worktree_path/worktree_branch into agent_runs), and collect.js READS from
 * them, but NOTHING ever tore them down. removeWorktree / cleanupAllWorktrees
 * were invoked only by tests. So every --isolate wave left its
 * .swarm/worktrees/w<N>-<domain>/ dirs and swarm/<run>/w<N>-<domain> branches
 * on disk permanently — dozens of orphans over a multi-wave dogfood run.
 *
 * The fix wires the cleanup half of the lifecycle into the run's LAWFUL
 * terminal path: recordPromotion() calls cleanupAllWorktrees(run.local_path)
 * when toPhase === 'complete' (the run's documented end). The cleanup is a
 * filesystem side-effect, NOT part of the atomic gate decision, so it runs
 * AFTER the promotion DB transaction commits and is best-effort: a cleanup
 * failure must NOT sink the promotion (the gate decision is already durable).
 * On failure a structured logStage('worktree_cleanup_failed', ...) breadcrumb
 * names the run + path so the operator can `git worktree prune` manually.
 *
 * This file pins, test-first:
 *   1. GUARD FIRES: a complete promotion against a run whose local_path holds
 *      real swarm worktrees removes them from disk + from `git worktree list`.
 *   2. HEALTHY INPUT STILL PASSES: a NON-complete promotion (health-audit-a →
 *      health-audit-b) leaves the worktrees untouched — cleanup is gated on
 *      the terminal transition, not every advance.
 *   3. BEST-EFFORT + BREADCRUMB: when cleanup cannot run (local_path is not a
 *      git repo), the promotion STILL commits (run → complete) and the
 *      operator sees a forensic NDJSON breadcrumb (cleanupAllWorktrees' own
 *      worktree_prune_failed row) — the failure is visible, not swallowed,
 *      and it does NOT sink the wave.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { recordPromotion } from './lib/advance.js';
import { createWorktree, listWorktrees } from './lib/worktree.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'stageC-advance-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, '.gitignore'), '.swarm/\n', 'utf-8');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'root']);
  return root;
}

/**
 * Seed a run with a wave + complete agent_runs whose local_path is a real
 * git repo, then create two swarm worktrees on disk. Returns the run id +
 * wave id + repo path + the worktree dirs created.
 */
function seedRunWithWorktrees(db, repoPath, { phase = 'treatment', runId = 'r1' } = {}) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', repoPath, 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  const wave = db.prepare(
    'INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, 1, ?)'
  ).run(runId, phase, 'collected');
  const waveId = Number(wave.lastInsertRowid);

  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? AND ownership_class != ?')
    .all(runId, 'shared');

  const wtDirs = [];
  for (const d of domains) {
    const { worktreePath } = createWorktree(repoPath, {
      runId, waveNumber: 1, domainName: d.name,
    });
    wtDirs.push(worktreePath);
    db.prepare(
      "INSERT INTO agent_runs (wave_id, domain_id, status, worktree_path) VALUES (?, ?, 'complete', ?)"
    ).run(waveId, d.id, worktreePath);
  }

  return { runId, waveId, repoPath, wtDirs };
}

function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { fn(); } finally { console.error = original; }
  return lines;
}

// ═══════════════════════════════════════════
// Guard fires — complete promotion tears down the worktrees
// ═══════════════════════════════════════════

describe('B001 — recordPromotion cleans up worktrees on the terminal (complete) path', () => {
  let repo;
  let db;

  beforeEach(() => { repo = initRepo(); db = openMemoryDb(); });
  afterEach(() => {
    db.close();
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('a treatment → complete promotion removes the swarm worktrees from disk and git', () => {
    const { runId, waveId, wtDirs } = seedRunWithWorktrees(db, repo, { phase: 'treatment' });

    // Pre-condition: the worktrees exist on disk and in `git worktree list`.
    for (const dir of wtDirs) {
      assert.ok(existsSync(dir), `worktree dir must exist before cleanup: ${dir}`);
    }
    assert.equal(listWorktrees(repo).length, wtDirs.length,
      'git must list the swarm worktrees before cleanup');

    // The lawful terminal transition.
    const promotionId = recordPromotion(db, runId, waveId, 'treatment', 'complete', {
      gates: [{ name: 'g', passed: true }],
    });
    assert.ok(promotionId, 'promotion still records normally');

    // Run is complete (DB tx committed before the FS-side cleanup).
    const run = db.prepare('SELECT status, completed_at FROM runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'complete');
    assert.ok(run.completed_at);

    // Post-condition: every swarm worktree is gone — disk AND git.
    for (const dir of wtDirs) {
      assert.ok(!existsSync(dir), `worktree dir must be removed after complete promotion: ${dir}`);
    }
    assert.equal(listWorktrees(repo).length, 0,
      'no swarm worktrees may survive a complete promotion');
  });

  it('a NON-terminal promotion (health-audit-a → health-audit-b) leaves the worktrees intact', () => {
    // Healthy-input control: cleanup is gated on the terminal transition. A
    // routine advance between audit phases must NOT tear down live worktrees
    // (sibling waves may still be reading from them).
    const { runId, waveId, wtDirs } = seedRunWithWorktrees(db, repo, { phase: 'health-audit-a' });

    assert.equal(listWorktrees(repo).length, wtDirs.length);

    recordPromotion(db, runId, waveId, 'health-audit-a', 'health-audit-b', {
      gates: [{ name: 'g', passed: true }],
    });

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'health-audit-b');

    // Worktrees survive an intermediate advance.
    for (const dir of wtDirs) {
      assert.ok(existsSync(dir), `worktree must survive a non-terminal advance: ${dir}`);
    }
    assert.equal(listWorktrees(repo).length, wtDirs.length,
      'a non-terminal promotion must not remove worktrees');
  });
});

// ═══════════════════════════════════════════
// Best-effort + breadcrumb — cleanup failure does not sink the promotion
// ═══════════════════════════════════════════

describe('B001 — terminal cleanup is best-effort with a forensic breadcrumb', () => {
  let db;
  let nonRepo;

  beforeEach(() => {
    db = openMemoryDb();
    // A directory that is NOT a git repo — cleanupAllWorktrees' internal
    // `git worktree prune` will fail there, exercising the failure channel.
    nonRepo = mkdtempSync(join(tmpdir(), 'stageC-advance-norepo-'));
  });
  afterEach(() => {
    db.close();
    try { rmSync(nonRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('a complete promotion still commits when cleanup degrades, and the operator sees a forensic row', () => {
    // Run whose local_path is not a git repo. cleanupAllWorktrees is internally
    // best-effort: listWorktrees() returns [] (its own try/catch) and the
    // `git worktree prune` step emits worktree_prune_failed rather than
    // throwing. The terminal-path wiring must (a) NOT let any cleanup outcome
    // sink the promotion, and (b) leave the operator a breadcrumb naming the
    // path that still needs a manual prune. We assert BOTH: run reaches
    // complete AND a worktree_prune_failed NDJSON row is on stderr.
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', nonRepo, 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'treatment', 1, 'collected')"
    ).run();
    const waveId = Number(wave.lastInsertRowid);
    const domId = db.prepare("SELECT id FROM domains WHERE run_id = 'r1'").get().id;
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, domId);

    let promotionId;
    const lines = captureStderr(() => {
      promotionId = recordPromotion(db, 'r1', waveId, 'treatment', 'complete', {
        gates: [{ name: 'g', passed: true }],
      });
    });

    // The promotion (the load-bearing gate decision) is durable regardless.
    assert.ok(promotionId, 'a cleanup failure must NOT sink the promotion');
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get('r1');
    assert.equal(run.status, 'complete', 'run still reaches complete despite cleanup failure');

    // The failure is visible on the NDJSON channel — names the repo path so
    // the operator can prune manually. (cleanupAllWorktrees' own breadcrumb.)
    const row = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(o => o && o.stage === 'worktree_prune_failed');
    assert.ok(row, 'a worktree_prune_failed NDJSON row must reach the operator on cleanup failure');
    assert.equal(row.component, 'dogfood-swarm');
    assert.equal(row.repoPath, nonRepo, 'the breadcrumb must name the path to prune');
    assert.ok(typeof row.err === 'string' && row.err.length > 0, 'the underlying error is captured');
  });
});
