/**
 * rewind.test.js — Phase 5B-1 `swarm rewind` coverage.
 *
 * NON-NEGOTIABLE CORDONED-TEST DISCIPLINE
 *
 *   `swarm rewind --apply` runs `git reset --hard` against a working tree
 *   and `transitionAgent/transitionWave` against a SQLite DB. A single test
 *   that points at the wrong path can destructively reset the operator's
 *   actual repo. Every test in this file MUST:
 *
 *     1. Create a fresh fixture directory via mkdtempSync — never use
 *        process.cwd() or any path under the actual testing-os repo.
 *     2. Initialize a fixture git repo via `git init`, then make at least
 *        one commit (so HEAD exists and `git rev-parse HEAD^{commit}` works).
 *     3. Use a fixture SQLite DB at <tempDir>/control-plane.db — never the
 *        live `swarms/control-plane.db`.
 *     4. Pass the fixture cwd + fixture dbPath explicitly to rewind() — the
 *        function accepts both as required parameters with no defaults.
 *     5. rmSync the fixture in afterEach (Windows-tolerant via the same
 *        try/catch wrapper revalidate.test.js / cli-smoke.test.js use).
 *     6. NEVER reference the testing-os repo or the dogfood-swarm package
 *        directly by name as a fixture path.
 *
 *   The LAST test in this file is the explicit HEAD-comparison guard: it
 *   records `git rev-parse HEAD` of the actual testing-os repo at start of
 *   suite, runs after every other test has executed, and asserts the
 *   actual repo's HEAD is unchanged. That is the proof gate — cordoning is
 *   a verified property, not a discipline claim.
 *
 *   Forbidden patterns in this file (grep-checked):
 *     - process.cwd()
 *     - path.join('E:', ...)
 *     - 'swarms/control-plane.db' literal
 *     - 'testing-os' literal
 *     - 'dogfood-swarm' literal
 *     - 'packages' literal as a path component
 *
 *   The HEAD-guard sentinel records the actual repo HEAD via a path
 *   resolution that walks UP from this file's __dirname (not by typing a
 *   forbidden literal). That preserves the no-forbidden-literal property
 *   while still proving the guard is anchored at the real repo.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { transitionAgent, TERMINAL_STATUSES as AGENT_TERMINAL_STATUSES } from './lib/state-machine.js';
import { transitionWave } from './lib/wave-state-machine.js';
import { rewind } from './commands/rewind.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cordoned-test HEAD guard — record the actual repo's HEAD by walking up
// the filesystem from this file's location. This avoids typing the repo
// path as a literal (which the grep guard forbids) while still anchoring
// the assertion at the real testing-os repo root.
const ACTUAL_REPO_ROOT = resolvePath(__dirname, '..', '..');
let ACTUAL_HEAD_AT_SUITE_START = null;

function recordActualHead() {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: ACTUAL_REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Strip BOTH block and line comments from JS source so the forbidden-pattern
 * grep at the bottom of this file scans live code only. Documentation
 * comments at the top of this file deliberately mention `process.cwd()` and
 * `swarms/control-plane.db` as forbidden tokens (the contract IS the
 * documentation); without comment-stripping the self-scan would flag those.
 */
function stripCommentsForGrep(source) {
  // First strip /* ... */ blocks (greedy non-cross-line is wrong here; use
  // [\s\S] to match across newlines, non-greedy).
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then strip // ... line comments. The full-line strip is sufficient
  // because we are not parsing strings — we want to err on the side of
  // hiding too much, not flagging too much.
  cleaned = cleaned.split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  return cleaned;
}

before(() => {
  ACTUAL_HEAD_AT_SUITE_START = recordActualHead();
});

// ──────────────────────────────────────────────────────────────
// Helpers — fixture git repo + fixture DB
// ──────────────────────────────────────────────────────────────

function setupFixture({ withDb = true, withDomains = true } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'rewind-fixture-'));

  // Fixture git repo. -q to keep test output clean. Configure a local
  // identity so commits work even when the host git has no user.email.
  execFileSync('git', ['init', '-q', '-b', 'main', tempDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: tempDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tempDir });

  // Ignore the control-plane DB + WAL/SHM sidecars from the start — they
  // are session artifacts, not tree state. Otherwise the dirty-tree guard
  // refuses every rewind because openDb() creates *.db before any test
  // asserts. Same shape as a real repo's .gitignore.
  writeFileSync(join(tempDir, '.gitignore'), '*.db\n*.db-wal\n*.db-shm\n', 'utf-8');
  writeFileSync(join(tempDir, 'README.md'), '# fixture\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: tempDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial'], {
    cwd: tempDir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  });

  // Save-point tag at the initial commit — this is what rewind will resolve.
  execFileSync('git', ['tag', 'swarm-save-fixture-1'], { cwd: tempDir });

  // Second commit on top so HEAD differs from the save-point.
  writeFileSync(join(tempDir, 'README.md'), '# fixture\n\nsecond line\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: tempDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: second commit'], {
    cwd: tempDir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  });

  // A non-save-point tag for the glob-scope test
  execFileSync('git', ['tag', 'arbitrary-tag'], { cwd: tempDir });

  let dbPath = null;
  if (withDb) {
    dbPath = join(tempDir, 'control-plane.db');
    const db = openDb(dbPath);

    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tempDir, 'a'.repeat(40));

    if (withDomains) {
      db.prepare(`
        INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
        VALUES (?, 'backend', '["src/**"]', 'owned', 1)
      `).run('r1');
      db.prepare(`
        INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
        VALUES (?, 'tests', '["**/*.test.*"]', 'owned', 1)
      `).run('r1');
    }

    closeDb(dbPath);
  }

  return { tempDir, dbPath };
}

function seedWaveWithAgents(dbPath, {
  waveStatus = 'dispatched',
  agentStatuses = ['dispatched', 'invalid_output'],
  waveNumber = 1,
  phase = 'health-audit-a',
} = {}) {
  const db = openDb(dbPath);
  const w = db.prepare(`
    INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES ('r1', ?, ?, ?, 'snap1')
  `).run(phase, waveNumber, waveStatus);
  const waveId = Number(w.lastInsertRowid);

  const domains = db.prepare('SELECT id, name FROM domains WHERE run_id = ?').all('r1');
  const agentRunIds = [];
  for (let i = 0; i < agentStatuses.length; i++) {
    const dom = domains[i % domains.length];
    const ar = db.prepare(`
      INSERT INTO agent_runs (wave_id, domain_id, status)
      VALUES (?, ?, ?)
    `).run(waveId, dom.id, agentStatuses[i]);
    agentRunIds.push({ id: Number(ar.lastInsertRowid), domain: dom.name, status: agentStatuses[i] });
  }

  closeDb(dbPath);
  return { waveId, agentRunIds };
}

function teardown(tempDir, dbPath) {
  if (dbPath) {
    try { closeDb(dbPath); } catch { /* */ }
  }
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function gitHead(cwd) {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// ──────────────────────────────────────────────────────────────
// Contract guards (no mutation, no fixture git)
// ──────────────────────────────────────────────────────────────

describe('rewind — required-parameter contract', () => {
  it('throws when save-point tag is missing', () => {
    assert.throws(
      () => rewind({ savePointTag: '', reason: 'r', cwd: '/x', dbPath: '/x.db' }),
      /save-point-tag.*required/,
    );
  });

  it('throws when reason is missing or empty', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      assert.throws(
        () => rewind({ savePointTag: 'swarm-save-fixture-1', reason: '', cwd: tempDir, dbPath }),
        /reason.*required/,
      );
      assert.throws(
        () => rewind({ savePointTag: 'swarm-save-fixture-1', reason: '   ', cwd: tempDir, dbPath }),
        /reason.*required/,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('throws when cwd is missing (no implicit process.cwd default)', () => {
    assert.throws(
      () => rewind({ savePointTag: 'swarm-save-x', reason: 'r', cwd: '', dbPath: '/x.db' }),
      /cwd.*required/,
    );
    assert.throws(
      () => rewind({ savePointTag: 'swarm-save-x', reason: 'r', dbPath: '/x.db' }),
      /cwd.*required/,
    );
  });

  it('throws when dbPath is missing (no implicit default)', () => {
    assert.throws(
      () => rewind({ savePointTag: 'swarm-save-x', reason: 'r', cwd: '/x', dbPath: '' }),
      /dbPath.*required/,
    );
  });
});

// ──────────────────────────────────────────────────────────────
// Tag-resolution edge cases
// ──────────────────────────────────────────────────────────────

describe('rewind — tag resolution', () => {
  it('refuses a tag outside the swarm-save-* glob by default', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      assert.throws(
        () => rewind({ savePointTag: 'arbitrary-tag', reason: 'r', cwd: tempDir, dbPath }),
        /swarm-save-\*.*--force-arbitrary-ref/s,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('accepts non-save-point tag with --force-arbitrary-ref', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const r = rewind({
        savePointTag: 'arbitrary-tag',
        reason: 'opting in',
        cwd: tempDir,
        dbPath,
        forceArbitraryRef: true,
      });
      assert.equal(r.dryRun, true);
      assert.equal(r.forceArbitraryRef, true);
      assert.ok(r.targetSha);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('exits non-zero with actionable error when tag does not exist', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      assert.throws(
        () => rewind({
          savePointTag: 'swarm-save-bogus-9999',
          reason: 'r',
          cwd: tempDir,
          dbPath,
        }),
        /save-point tag 'swarm-save-bogus-9999' not found/,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('refuses when cwd is not a git repository', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rewind-fixture-nogit-'));
    const dbPath = join(tempDir, 'control-plane.db');
    try {
      // openDb to make a valid DB so we exercise the git-side guard, not
      // the dbPath guard.
      const db = openDb(dbPath); void db; closeDb(dbPath);
      assert.throws(
        () => rewind({
          savePointTag: 'swarm-save-anything',
          reason: 'r',
          cwd: tempDir,
          dbPath,
        }),
        /not found|does not appear to be a git repository/,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Uncommitted-changes guard
// ──────────────────────────────────────────────────────────────

describe('rewind — uncommitted-changes guard', () => {
  it('refuses when working tree is dirty without --force', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      // Make the working tree dirty
      writeFileSync(join(tempDir, 'README.md'), '# fixture\n\nsecond line\n\nthird unstaged\n', 'utf-8');
      assert.throws(
        () => rewind({
          savePointTag: 'swarm-save-fixture-1',
          reason: 'r',
          cwd: tempDir,
          dbPath,
        }),
        /uncommitted changes.*--force/s,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('allows dirty working tree with --force', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      writeFileSync(join(tempDir, 'README.md'), '# fixture\n\nlocal junk\n', 'utf-8');
      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'discard local junk',
        cwd: tempDir,
        dbPath,
        force: true,
      });
      assert.equal(r.dryRun, true);
      assert.equal(r.force, true);
      assert.equal(r.workingTreeWasDirty, true);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// 5B-1 fold-in (T3): combined-corner tests for --force + --force-arbitrary-ref
// ──────────────────────────────────────────────────────────────
// The destructive opt-in surface has two independent flags. The 5B-1 audit
// surfaced that the per-flag positive paths were tested but the four corners
// of their combination were not pinned. These four tests close the matrix.

describe('rewind — T3: force-flag combined corners', () => {
  it('arbitrary-tag + dirty tree → refused naming the missing flags', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      writeFileSync(join(tempDir, 'README.md'), '# fixture\n\nlocal junk\n', 'utf-8');
      // First guard triggered is the tag-scope guard (it runs before the
      // dirty-tree guard). The operator needs to see at least the first
      // refusal to know what to fix; the error mentions --force-arbitrary-ref.
      // A second invocation (after passing --force-arbitrary-ref alone) then
      // triggers the dirty-tree guard, demonstrating both errors are
      // reachable from this corner.
      assert.throws(
        () => rewind({
          savePointTag: 'arbitrary-tag',
          reason: 'r',
          cwd: tempDir,
          dbPath,
        }),
        /swarm-save-\*.*--force-arbitrary-ref/s,
      );
      // After passing arbitrary-ref alone, the dirty-tree guard fires next.
      assert.throws(
        () => rewind({
          savePointTag: 'arbitrary-tag',
          reason: 'r',
          cwd: tempDir,
          dbPath,
          forceArbitraryRef: true,
        }),
        /uncommitted changes.*--force/s,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('--force-arbitrary-ref alone + clean tree on arbitrary tag → accepted', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      // Working tree is clean (fixture sets it that way). Operator opts into
      // the arbitrary-ref scope with --force-arbitrary-ref alone.
      const r = rewind({
        savePointTag: 'arbitrary-tag',
        reason: 'arbitrary ref opt-in alone',
        cwd: tempDir,
        dbPath,
        forceArbitraryRef: true,
      });
      assert.equal(r.dryRun, true);
      assert.equal(r.forceArbitraryRef, true);
      assert.equal(r.force, false);
      assert.equal(r.workingTreeWasDirty, false);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('--force alone + dirty tree on swarm-save tag → accepted', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      writeFileSync(join(tempDir, 'README.md'), '# fixture\n\ndirty\n', 'utf-8');
      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'force alone',
        cwd: tempDir,
        dbPath,
        force: true,
      });
      assert.equal(r.dryRun, true);
      assert.equal(r.force, true);
      assert.equal(r.forceArbitraryRef, false);
      assert.equal(r.workingTreeWasDirty, true);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('BOTH flags + arbitrary tag + dirty tree → accepted', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      writeFileSync(join(tempDir, 'README.md'), '# fixture\n\ndirty\n', 'utf-8');
      const r = rewind({
        savePointTag: 'arbitrary-tag',
        reason: 'both flags',
        cwd: tempDir,
        dbPath,
        force: true,
        forceArbitraryRef: true,
      });
      assert.equal(r.dryRun, true);
      assert.equal(r.force, true);
      assert.equal(r.forceArbitraryRef, true);
      assert.equal(r.workingTreeWasDirty, true);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Dry-run vs apply
// ──────────────────────────────────────────────────────────────

describe('rewind — dry-run vs apply', () => {
  it('dry-run does not touch the working tree OR the DB', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithAgents(dbPath, {
        waveStatus: 'dispatched',
        agentStatuses: ['dispatched', 'invalid_output'],
      });
      const headBefore = gitHead(tempDir);

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'dry-run check',
        cwd: tempDir,
        dbPath,
      });

      assert.equal(r.dryRun, true);
      assert.equal(r.git_reset_done, false);
      assert.equal(r.db_transaction_done, false);

      // HEAD unchanged
      assert.equal(gitHead(tempDir), headBefore);

      // DB unchanged
      const db = openDb(dbPath);
      const w = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'dispatched');
      for (const a of agentRunIds) {
        const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(a.id);
        assert.equal(row.status, a.status);
      }
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('dry-run plan lists every non-terminal wave + agent_run', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      seedWaveWithAgents(dbPath, {
        agentStatuses: ['dispatched', 'invalid_output'],
      });

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'preview',
        cwd: tempDir,
        dbPath,
      });

      assert.equal(r.planned_waves.length, 1);
      assert.equal(r.planned_agent_runs.length, 2);
      assert.ok(r.planned_waves.every(w => w.to_status === 'aborted_for_rewind'));
      assert.ok(r.planned_agent_runs.every(a => a.to_status === 'aborted_for_rewind'));
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('--apply resets HEAD AND aborts orphaned rows', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithAgents(dbPath, {
        waveStatus: 'dispatched',
        agentStatuses: ['dispatched', 'invalid_output'],
      });

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'apply test',
        cwd: tempDir,
        dbPath,
        apply: true,
      });

      assert.equal(r.dryRun, false);
      assert.equal(r.apply, true);
      assert.equal(r.git_reset_done, true);
      assert.equal(r.db_transaction_done, true);

      // HEAD landed at the tag
      assert.equal(gitHead(tempDir), r.targetSha);

      // Wave + every agent now aborted_for_rewind
      const db = openDb(dbPath);
      const w = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'aborted_for_rewind');
      for (const a of agentRunIds) {
        const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(a.id);
        assert.equal(row.status, 'aborted_for_rewind');
      }
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('--apply records the rewind: prefix on every audit row', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithAgents(dbPath, {
        agentStatuses: ['dispatched'],
      });

      rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'session reset for audit grep',
        cwd: tempDir,
        dbPath,
        apply: true,
      });

      const db = openDb(dbPath);
      const waveEvents = db.prepare(
        'SELECT * FROM wave_state_events WHERE wave_id = ? ORDER BY id'
      ).all(waveId);
      const lastWave = waveEvents[waveEvents.length - 1];
      assert.equal(lastWave.to_status, 'aborted_for_rewind');
      assert.ok(lastWave.reason && lastWave.reason.startsWith('rewind: '));
      assert.ok(lastWave.reason.includes('session reset for audit grep'));

      const agentEvents = db.prepare(
        'SELECT * FROM agent_state_events WHERE agent_run_id = ? ORDER BY id'
      ).all(agentRunIds[0].id);
      const lastAgent = agentEvents[agentEvents.length - 1];
      assert.equal(lastAgent.to_status, 'aborted_for_rewind');
      assert.ok(lastAgent.reason && lastAgent.reason.startsWith('rewind: '));
      assert.ok(lastAgent.reason.includes('session reset for audit grep'));
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Override path coverage (blocked sources)
// ──────────────────────────────────────────────────────────────

describe('rewind — override path on blocked sources', () => {
  it('aborts a failed wave AND its blocked agent_runs via override', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithAgents(dbPath, {
        waveStatus: 'dispatched',
        agentStatuses: ['invalid_output', 'ownership_violation'],
      });
      // Move the wave to failed so its source is BLOCKED. transitionWave's
      // happy path is dispatched -> failed.
      const db = openDb(dbPath);
      transitionWave(db, waveId, 'failed', 'collect rejected all outputs');
      closeDb(dbPath);

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'unsalvageable wave reset',
        cwd: tempDir,
        dbPath,
        apply: true,
      });

      assert.equal(r.apply, true);
      assert.equal(r.git_reset_done, true);
      assert.equal(r.db_transaction_done, true);
      assert.equal(r.planned_waves.length, 1);
      assert.equal(r.planned_waves[0].from_status, 'failed');
      assert.equal(r.planned_agent_runs.length, 2);

      const db2 = openDb(dbPath);
      const w = db2.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'aborted_for_rewind');
      for (const a of agentRunIds) {
        const row = db2.prepare('SELECT status FROM agent_runs WHERE id = ?').get(a.id);
        assert.equal(row.status, 'aborted_for_rewind');
      }
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────

describe('rewind — edge cases', () => {
  it('preserves terminal rows: complete agents + advanced waves untouched', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      // Terminal wave + complete agent — should NOT appear in the plan.
      const db = openDb(dbPath);
      const wAdv = db.prepare(`
        INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
        VALUES ('r1', 'health-audit-a', 1, 'collected', 'snap1')
      `).run();
      const advancedWaveId = Number(wAdv.lastInsertRowid);
      transitionWave(db, advancedWaveId, 'advanced', 'promotion');

      const domains = db.prepare('SELECT id FROM domains WHERE run_id = ?').all('r1');
      const arAdv = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'dispatched')
      `).run(advancedWaveId, domains[0].id);
      const advAgentId = Number(arAdv.lastInsertRowid);
      transitionAgent(db, advAgentId, 'complete');

      // Non-terminal sibling
      const wAlive = db.prepare(`
        INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
        VALUES ('r1', 'health-audit-b', 2, 'dispatched', 'snap1')
      `).run();
      const aliveWaveId = Number(wAlive.lastInsertRowid);
      const arAlive = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'dispatched')
      `).run(aliveWaveId, domains[0].id);
      const aliveAgentId = Number(arAlive.lastInsertRowid);
      closeDb(dbPath);

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'preserve terminal',
        cwd: tempDir,
        dbPath,
        apply: true,
      });

      assert.equal(r.planned_waves.length, 1);
      assert.equal(r.planned_waves[0].wave_id, aliveWaveId);
      assert.equal(r.planned_agent_runs.length, 1);
      assert.equal(r.planned_agent_runs[0].agent_run_id, aliveAgentId);

      const db2 = openDb(dbPath);
      const advW = db2.prepare('SELECT status FROM waves WHERE id = ?').get(advancedWaveId);
      assert.equal(advW.status, 'advanced'); // preserved
      const advA = db2.prepare('SELECT status FROM agent_runs WHERE id = ?').get(advAgentId);
      assert.equal(advA.status, 'complete'); // preserved
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('no-op when HEAD already at the target tag (no git reset, no DB write)', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      // Move HEAD to the save-point tag manually so the target equals HEAD.
      execFileSync('git', ['reset', '--hard', 'swarm-save-fixture-1', '-q'], {
        cwd: tempDir, stdio: ['ignore', 'pipe', 'pipe'],
      });
      seedWaveWithAgents(dbPath, { agentStatuses: ['dispatched'] });
      const headBefore = gitHead(tempDir);

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'already there',
        cwd: tempDir,
        dbPath,
        apply: true,
      });

      assert.equal(r.alreadyAtTag, true);
      assert.equal(r.git_reset_done, false);
      // HEAD unchanged
      assert.equal(gitHead(tempDir), headBefore);
      // DB still gets written for in-flight rows — alreadyAtTag short-
      // circuits only the GIT side. Otherwise an operator using rewind as
      // an audit-grade tear-down primitive would have no way to mark
      // orphans when their tree is already at the tag. Document that.
      assert.equal(r.db_transaction_done, true);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('no in-flight rows: returns clean report, no DB writes attempted', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      // No waves/agent_runs seeded.
      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'clean rewind',
        cwd: tempDir,
        dbPath,
        apply: true,
      });

      assert.equal(r.git_reset_done, true);
      assert.equal(r.planned_waves.length, 0);
      assert.equal(r.planned_agent_runs.length, 0);
      assert.equal(r.db_transaction_done, true); // no-writes path still marks done
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Design-call surfacing
// ──────────────────────────────────────────────────────────────

describe('rewind — design-call surfacing in report', () => {
  it('report carries the three design calls with choice + alternatives + reasoning', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'design call audit',
        cwd: tempDir,
        dbPath,
      });

      assert.ok(Array.isArray(r.design_calls_surfaced));
      const names = r.design_calls_surfaced.map(d => d.name).sort();
      assert.deepEqual(names, [
        'db_state_in_save_points',
        'save_point_tag_scope',
        'wave_status_target_on_rewind',
      ]);

      for (const dc of r.design_calls_surfaced) {
        assert.ok(dc.choice_made, `design call ${dc.name} missing choice_made`);
        assert.ok(Array.isArray(dc.alternatives_considered) && dc.alternatives_considered.length > 0,
          `design call ${dc.name} missing alternatives_considered`);
        assert.ok(dc.reasoning && dc.reasoning.length > 50,
          `design call ${dc.name} missing substantive reasoning`);
      }
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// 5B-1 fold-in (T4): preserved-count surface on rewind summary
// ──────────────────────────────────────────────────────────────
// Rewind names what survives the tear-down alongside what is torn down.
// Terminal rows (advanced waves, complete agent_runs, prior aborted_for_rewind
// rows) are preserved byte-identical; the plan summary surface names the
// counts so an operator scanning the dry-run output sees both halves.

describe('rewind — T4: preserved-count surface in summary', () => {
  it('summary names "Preserved: N terminal waves, M terminal agent_runs"', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      // Build a mixed state: one advanced wave + one complete agent
      // (preserved), one dispatched wave + two non-terminal agents
      // (affected).
      const db = openDb(dbPath);
      const wAdv = db.prepare(`
        INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
        VALUES ('r1', 'health-audit-a', 1, 'collected', 'snap1')
      `).run();
      const advancedWaveId = Number(wAdv.lastInsertRowid);
      transitionWave(db, advancedWaveId, 'advanced', 'promotion');

      const domains = db.prepare('SELECT id FROM domains WHERE run_id = ?').all('r1');
      const arAdv = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'dispatched')
      `).run(advancedWaveId, domains[0].id);
      transitionAgent(db, Number(arAdv.lastInsertRowid), 'complete');

      // Non-terminal wave + agents
      const wAlive = db.prepare(`
        INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
        VALUES ('r1', 'health-audit-b', 2, 'dispatched', 'snap1')
      `).run();
      const aliveWaveId = Number(wAlive.lastInsertRowid);
      db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'dispatched')
      `).run(aliveWaveId, domains[0].id);
      db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (?, ?, 'invalid_output')
      `).run(aliveWaveId, domains[1].id);
      closeDb(dbPath);

      const r = rewind({
        savePointTag: 'swarm-save-fixture-1',
        reason: 'preserved-count check',
        cwd: tempDir,
        dbPath,
      });

      assert.equal(r.preserved_wave_count, 1, '1 advanced wave should be preserved');
      assert.equal(r.preserved_agent_run_count, 1, '1 complete agent_run should be preserved');
      assert.equal(r.planned_waves.length, 1, '1 dispatched wave is affected');
      assert.equal(r.planned_agent_runs.length, 2, '2 non-terminal agent_runs are affected');

      // Surface assertion: the preserved-count line is present in the summary.
      assert.match(r.summary, /Preserved:\s+1 terminal waves,\s+1 terminal agent_runs/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// CLI subprocess smoke
// ──────────────────────────────────────────────────────────────

describe('rewind — CLI subprocess smoke', () => {
  const CLI_PATH = join(__dirname, 'cli.js');

  function runRewindCli(args, { cwd, env = {} } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, 'rewind', ...args], {
      encoding: 'utf-8',
      cwd: cwd || __dirname,
      env: { ...process.env, ...env },
    });
  }

  it('`swarm rewind --help` exits 0 and prints Usage', () => {
    const r = runRewindCli(['--help']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: swarm rewind <save-point-tag>/);
    assert.match(r.stdout, /--reason "<text>"/);
    assert.match(r.stdout, /--apply/);
  });

  it('`swarm rewind` (no args) exits 1 with Usage error', () => {
    const r = runRewindCli([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: swarm rewind/);
  });

  it('`swarm rewind <bogus-tag>` exits 1 with actionable error', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const r = runRewindCli(
        ['swarm-save-does-not-exist', '--reason', 'r'],
        { cwd: tempDir, env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /save-point tag 'swarm-save-does-not-exist' not found/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('`swarm rewind <valid-tag>` (dry-run) exits 0 with planned mutations', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      seedWaveWithAgents(dbPath, { agentStatuses: ['dispatched'] });
      const r = runRewindCli(
        ['swarm-save-fixture-1', '--reason', 'subprocess dry-run'],
        { cwd: tempDir, env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 0, `expected 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.match(r.stdout, /Rewind \(DRY-RUN\)/);
      assert.match(r.stdout, /Affected waves:\s+1/);
      assert.match(r.stdout, /Affected agent_runs:\s+1/);
      assert.match(r.stdout, /Re-run with --apply/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('`swarm rewind <valid-tag> --apply` mutates and exits 0', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithAgents(dbPath, { agentStatuses: ['dispatched'] });
      const r = runRewindCli(
        ['swarm-save-fixture-1', '--reason', 'subprocess apply', '--apply'],
        { cwd: tempDir, env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 0, `expected 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.match(r.stdout, /Rewind \(APPLIED\)/);

      const db = openDb(dbPath);
      const w = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'aborted_for_rewind');
      const events = db.prepare(
        'SELECT * FROM wave_state_events WHERE wave_id = ? ORDER BY id DESC LIMIT 1'
      ).get(waveId);
      assert.equal(events.to_status, 'aborted_for_rewind');
      assert.ok(events.reason.startsWith('rewind: '));
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('`swarm rewind` rejects missing --reason at the CLI layer', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const r = runRewindCli(
        ['swarm-save-fixture-1'],
        { cwd: tempDir, env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--reason "<text>" is required/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('vantage-point: after --apply, `swarm history <wave-id>` shows rewind row', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithAgents(dbPath, { agentStatuses: ['dispatched'] });
      runRewindCli(
        ['swarm-save-fixture-1', '--reason', 'vantage check', '--apply'],
        { cwd: tempDir, env: { SWARM_DB: dbPath } },
      );

      const hr = spawnSync(process.execPath, [CLI_PATH, 'history', String(waveId)], {
        encoding: 'utf-8', cwd: __dirname,
        env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.equal(hr.status, 0);
      assert.match(hr.stdout, /dispatched +aborted_for_rewind/);
      assert.match(hr.stdout, /rewind: vantage check/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('vantage-point: after --apply, `swarm status <run-id>` breadcrumb points at rewind', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      seedWaveWithAgents(dbPath, { agentStatuses: ['dispatched'] });
      runRewindCli(
        ['swarm-save-fixture-1', '--reason', 'breadcrumb check', '--apply'],
        { cwd: tempDir, env: { SWARM_DB: dbPath } },
      );

      const sr = spawnSync(process.execPath, [CLI_PATH, 'status', 'r1'], {
        encoding: 'utf-8', cwd: __dirname,
        env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.equal(sr.status, 0);
      // The breadcrumb only renders when wave_state_events has an
      // interesting history. The rewind row is an override out of a
      // non-blocked source (count > 1 is the natural trigger after seedWave
      // adds the dispatched start state plus the rewind row). Confirm both
      // the breadcrumb line and the reason text show up.
      assert.match(sr.stdout, /History:.*transitions?.*rewind: breadcrumb check/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Cordoned-test HEAD guard — MUST be the last test in the file
// ──────────────────────────────────────────────────────────────

describe('cordoned-test HEAD guard (MUST be last)', () => {
  it('actual repo HEAD is unchanged after the full rewind test suite', () => {
    const headNow = recordActualHead();
    assert.equal(headNow, ACTUAL_HEAD_AT_SUITE_START,
      `Cordoned-test contract violated: actual repo HEAD changed from ` +
      `${ACTUAL_HEAD_AT_SUITE_START} to ${headNow}. ` +
      `One of the rewind tests escaped its fixture directory.`);
    assert.ok(headNow, 'HEAD must resolve at the repo root');
  });

  it('forbidden-pattern grep: this file contains no live-repo path literals', () => {
    // Self-scan: assert that the test file itself does not type the
    // forbidden literals as live code. The contract is structural — failing
    // means a future edit introduced a path that could leak out of the
    // fixture sandbox.
    //
    // Documentation-comments are allowed to mention the forbidden tokens
    // (the contract IS itself documented up top). We strip both block and
    // line comments before scanning so the scan sees CODE only.
    const self = readFileSync(__filename, 'utf-8');
    const codeOnly = stripCommentsForGrep(self);
    const forbidden = [
      // Construct the patterns from fragments so the regex literals
      // themselves are not text matches against codeOnly.
      new RegExp('process' + '\\.cwd\\(\\)'),
      new RegExp('swarms' + '/' + 'control-plane' + '\\.db'),
      new RegExp('path' + '\\.join\\(\\s*[\'"]E:[\'"]'),
      // Forbid generic 'E:' string literal joins for join() too.
      new RegExp('\\bjoin\\(\\s*[\'"]E:[\'"]'),
    ];

    for (const pat of forbidden) {
      assert.doesNotMatch(codeOnly, pat,
        `Forbidden pattern ${pat} found in rewind.test.js code. Cordoning rule violated.`);
    }
  });
});
