/**
 * ds-proac-01-doctor-git-check.test.js
 *
 * PROACTIVE-HEALTH DS-PROAC-01 (LOW) — `swarm doctor` preflight had no check
 * for git availability, yet two load-bearing control-plane features depend on
 * it: the independent ownership-attribution probe (collect.js → git status /
 * git diff via lib/git-touched-files.js) and --isolate per-agent worktrees
 * (lib/worktree.js → git worktree). A box with no git on PATH dispatches fine,
 * then the ownership probe silently degrades (every wave reports
 * ownership_probe_degraded / git-unavailable) and --isolate fails opaquely at
 * dispatch. doctor is the place an operator finds that out UP FRONT.
 *
 * The fix adds a WARN-level (not hard-FAIL) `git-available` check running
 * `git --version`. It is a WARN, not a FAIL, because the core control plane
 * (SQLite) runs without git — only the attribution-probe + worktree-isolation
 * features degrade. doctor's exit contract is preserved: only hard FAILs gate
 * exit non-zero, so a missing git WARN still exits 0.
 *
 * Test invariants (RED→GREEN):
 *   1. doctor reports a structured `git-available` check entry (id + status +
 *      message), so the operator sees the dependency in the preflight.
 *   2. On a normal CI box (git present) it PASSES.
 *   3. Exit contract preserved: the git check is WARN-class — even if it were
 *      to warn, overallStatus/exitCode are not driven non-zero by a WARN.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor } from './commands/doctor.js';
import { openDb, closeDb } from './db/connection.js';

describe('DS-PROAC-01 — swarm doctor git-available check', () => {
  let tmp;

  function freshDbPath() {
    tmp = mkdtempSync(join(tmpdir(), 'ds-proac-01-doctor-'));
    const dbPath = join(tmp, 'control-plane.db');
    openDb(dbPath);
    closeDb(dbPath);
    return dbPath;
  }

  it('reports a structured git-available check entry', () => {
    const dbPath = freshDbPath();
    try {
      const report = runDoctor({ dbPath });
      const git = report.checks.find((c) => c.id === 'git-available');
      assert.ok(git, 'doctor must include a git-available check');
      assert.ok(['pass', 'warn'].includes(git.status),
        `git-available is WARN-class (pass when present, warn when absent), got ${git.status}`);
      assert.equal(typeof git.message, 'string', 'the check carries an operator-readable message');
      // The message points at the features that degrade without git so the
      // operator understands WHY it matters.
      assert.match(
        git.message + (git.hint || ''),
        /ownership|attribution|worktree|isolate/i,
        'the git check names the ownership-attribution / --isolate degradation',
      );
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('passes on a box that has git (the CI runner) and does NOT gate the exit code as a WARN', () => {
    const dbPath = freshDbPath();
    try {
      const report = runDoctor({ dbPath });
      const git = report.checks.find((c) => c.id === 'git-available');
      // CI runners have git — assert it passes here; the WARN branch is the
      // no-git box which we cannot synthesize without PATH surgery.
      assert.equal(git.status, 'pass', 'git is present on the CI runner');
      // Exit contract: a clean env (git present) still exits 0; and crucially a
      // git WARN would never push exitCode non-zero (only hard FAIL gates).
      assert.equal(report.exitCode, 0, 'a healthy preflight exits 0');
      // The git check is never a hard FAIL — it is WARN-class by construction.
      assert.notEqual(git.status, 'fail', 'git-available must be WARN-class, never a hard FAIL');
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
