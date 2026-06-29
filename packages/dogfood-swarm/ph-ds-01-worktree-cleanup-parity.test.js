/**
 * ph-ds-01-worktree-cleanup-parity.test.js
 *
 * PROACTIVE-HEALTH PH-DS-01 (LOW, graceful-degradation parity) —
 * the completion-path worktree teardown (lib/worktree.js
 * removeWorktree / cleanupAllWorktrees) was missing the survivor breadcrumb
 * that rewind.js's --apply teardown already has.
 *
 * rewind.js, after each removeWorktree(), re-checks existsSync(path) and emits
 * a `rewind_worktree_cleanup_failed` logStage row naming any worktree that
 * SURVIVED the remove attempt (occupied dir / not-a-worktree / locked), plus
 * counts the survivors as `worktrees_stranded`. The completion path
 * (recordPromotion → cleanupAllWorktrees) had no such recheck: a worktree
 * whose `git worktree remove --force` silently failed was reported as cleaned
 * with NO operator-visible signal and NO stranded count — exactly the
 * silent-degradation this Stage-C pass exists to close.
 *
 * The fix brings completion-path cleanup to parity:
 *   - removeWorktree() re-checks existsSync after the remove attempt and emits
 *     `worktree_cleanup_failed` (component, repoPath, worktreePath, branch) for
 *     a survivor, returning { removed, stranded }.
 *   - cleanupAllWorktrees() aggregates and returns { removed, stranded, total }.
 *
 * Test invariants (RED→GREEN):
 *   1. SURVIVOR BREADCRUMB: a worktree path that survives the remove attempt
 *      (a plain non-worktree directory occupying the recorded path) emits a
 *      `worktree_cleanup_failed` NDJSON row naming the surviving path, and is
 *      counted as stranded.
 *   2. AGGREGATE: cleanupAllWorktrees returns { removed, stranded } and counts
 *      a survivor as stranded alongside a healthy removal.
 *   3. HEALTHY INPUT STILL PASSES: a real swarm worktree is removed, counted as
 *      removed (not stranded), and emits NO worktree_cleanup_failed row.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorktree, removeWorktree, cleanupAllWorktrees, listWorktrees } from './lib/worktree.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ph-ds-01-'));
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
 * Capture stderr lines AND the callback's return value. The fix routes the
 * human-banner suppression via DOGFOOD_LOG_HUMAN=0 so only NDJSON lines land.
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

/**
 * Turn a real worktree into a survivor: a plain directory occupying the
 * recorded path that `git worktree remove --force` can no longer remove.
 */
function makeSurvivor(repo, waveNumber, domainName) {
  const wt = createWorktree(repo, { runId: 'r1', waveNumber, domainName });
  rmSync(join(wt.worktreePath, '.git'), { recursive: true, force: true });
  git(repo, ['worktree', 'prune']);
  writeFileSync(join(wt.worktreePath, 'leftover.txt'), 'x', 'utf-8');
  assert.ok(existsSync(wt.worktreePath), 'precondition: a plain directory occupies the recorded path');
  return wt;
}

describe('PH-DS-01 — completion-path worktree cleanup parity with rewind', () => {
  let repo;
  beforeEach(() => { repo = initRepo(); });
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('a survivor path emits worktree_cleanup_failed and is counted as stranded', () => {
    const wt = makeSurvivor(repo, 1, 'backend');

    const { value, rows } = capture(() => removeWorktree(repo, wt.worktreePath, wt.branch));

    assert.equal(value.removed, false, 'a survivor is not counted as removed');
    assert.equal(value.stranded, true, 'a survivor is counted as stranded');

    const row = rows.find(o => o.stage === 'worktree_cleanup_failed');
    assert.ok(row, 'a worktree_cleanup_failed NDJSON row must reach the operator for a survivor');
    assert.equal(row.component, 'dogfood-swarm');
    assert.equal(row.worktreePath, wt.worktreePath, 'the breadcrumb must name the surviving worktree path');
    assert.equal(row.branch, wt.branch, 'the breadcrumb names the branch');
  });

  it('cleanupAllWorktrees returns a structured {removed, stranded, total} summary', () => {
    // Two healthy worktrees that git lists. The load-bearing change is that
    // cleanupAllWorktrees now returns the structured outcome (removed/stranded/
    // total) instead of a bare count that conflated "swept" with "removed". The
    // stranded-counting path is exercised directly at the removeWorktree level
    // (test 1); here we pin the aggregate shape + the removed count.
    createWorktree(repo, { runId: 'r1', waveNumber: 1, domainName: 'backend' });
    createWorktree(repo, { runId: 'r1', waveNumber: 1, domainName: 'tests' });
    assert.equal(listWorktrees(repo).length, 2);

    const { value } = capture(() => cleanupAllWorktrees(repo));

    assert.equal(typeof value, 'object', 'cleanupAllWorktrees returns a structured summary');
    assert.equal(value.total, 2, 'total names how many worktrees were swept');
    assert.equal(value.removed, 2, 'both healthy worktrees are counted as removed');
    assert.equal(value.stranded, 0, 'no survivors for two clean removals');
    assert.equal(listWorktrees(repo).length, 0, 'no swarm worktrees survive the sweep');
  });

  it('a healthy worktree is removed, counted, and emits NO cleanup_failed row', () => {
    const { worktreePath, branch } = createWorktree(repo, {
      runId: 'r1', waveNumber: 1, domainName: 'backend',
    });
    assert.equal(listWorktrees(repo).length, 1);

    const { value, rows } = capture(() => removeWorktree(repo, worktreePath, branch));

    assert.equal(value.removed, true, 'a healthy worktree is counted as removed');
    assert.equal(value.stranded, false, 'a healthy worktree is NOT stranded');
    assert.ok(!existsSync(worktreePath), 'the worktree directory is gone');
    assert.ok(!rows.some(o => o.stage === 'worktree_cleanup_failed'),
      'a clean removal must NOT emit a worktree_cleanup_failed breadcrumb');
  });
});
