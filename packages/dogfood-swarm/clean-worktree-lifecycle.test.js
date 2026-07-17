/**
 * clean-worktree-lifecycle.test.js — `swarm clean <run-id>` coverage.
 *
 * The worktree-lifecycle recovery verb: list the stranded --isolate worktrees
 * (and their swarm/* branches) for a run, report a {removed, stranded, total}
 * rollup, and remove them on --apply. Dry-run by default — matching the
 * revalidate / rewind / redrive recovery-verb contract.
 *
 * NON-NEGOTIABLE CORDONED-TEST DISCIPLINE (mirrors redrive.test.js):
 *   Every test creates a fresh fixture git repo + fixture control-plane.db via
 *   mkdtempSync — never process.cwd(), never the real repo, never the live
 *   shared control-plane.db. afterEach rmSync's the fixture (Windows-tolerant).
 *
 * Pattern #10 (FAILS-then-PASSES proof gate): written against the pre-build
 * cli.js + missing commands/clean.js FIRST (clean verb absent → "unknown
 * command" help / module-not-found), then the verb wired to GREEN.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { createWorktree } from './lib/worktree.js';
import { clean } from './commands/clean.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

/**
 * Init a real git repo with a control-plane.db beside it, register one run
 * pointed at the repo, and create N isolate worktrees for that run.
 *
 * The run id is chosen so its run-short slug (runId without `swarm-` prefix,
 * first 12 chars) is stable — createWorktree derives the swarm/<short>/...
 * branch name from it.
 */
function setupFixture({ runId = 'swarm-cleanfix01', domains = ['backend', 'tests'] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'clean-fixture-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.swarm/\n', 'utf-8');
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf-8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'root']);

  const dbPath = join(repo, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', repo, 'a'.repeat(40));
  closeDb(dbPath);

  const worktrees = domains.map(d =>
    createWorktree(repo, { runId, waveNumber: 1, domainName: d })
  );

  return { repo, dbPath, runId, worktrees };
}

function teardown(repo) {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('clean — required-parameter contract', () => {
  it('throws when run-id is missing', () => {
    assert.throws(() => clean({ dbPath: '/x.db' }), /run-id.*required/);
  });

  it('throws when dbPath is missing (no implicit default)', () => {
    assert.throws(() => clean({ runId: 'r1', dbPath: '' }), /dbPath.*required/);
  });

  it('throws when run is not found', () => {
    const { repo, dbPath } = setupFixture();
    try {
      assert.throws(
        () => clean({ runId: 'swarm-doesnotexist', dbPath }),
        (err) => err.code === 'RUN_NOT_FOUND',
      );
    } finally {
      teardown(repo);
    }
  });
});

describe('clean — dry-run by default', () => {
  it('lists the run worktrees as survivors and removes NOTHING', () => {
    const fx = setupFixture();
    try {
      const before = fx.worktrees.map(w => w.worktreePath);
      assert.ok(before.every(p => existsSync(p)), 'precondition: worktrees exist');

      const report = clean({ runId: fx.runId, dbPath: fx.dbPath });

      assert.equal(report.apply, false);
      assert.equal(report.dryRun, true);
      assert.equal(report.total, 2, 'both run worktrees are listed');
      assert.equal(report.removed, 0, 'dry-run removes nothing');
      assert.equal(report.stranded, 0);
      assert.equal(report.worktrees.length, 2);
      for (const p of before) {
        assert.ok(existsSync(p), 'dry-run must leave every worktree on disk');
      }
    } finally {
      teardown(fx.repo);
    }
  });

  it('scopes to the run — a sibling run worktree is NOT listed', () => {
    const fx = setupFixture({ runId: 'swarm-runalpha001', domains: ['backend'] });
    try {
      // A second run in the SAME repo with its own worktree.
      const db = openDb(fx.dbPath);
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run('swarm-runbravo002', 'org/r', fx.repo, 'b'.repeat(40));
      closeDb(fx.dbPath);
      createWorktree(fx.repo, { runId: 'swarm-runbravo002', waveNumber: 1, domainName: 'tests' });

      const report = clean({ runId: fx.runId, dbPath: fx.dbPath });

      assert.equal(report.total, 1, 'only the target run\'s worktree is listed');
      assert.equal(report.worktrees[0].branch.includes('runalpha001'), true);
    } finally {
      teardown(fx.repo);
    }
  });
});

describe('clean — --apply removes and reports counts', () => {
  it('removes every run worktree and reports the {removed, stranded, total} rollup', () => {
    const fx = setupFixture();
    try {
      const paths = fx.worktrees.map(w => w.worktreePath);

      const report = clean({ runId: fx.runId, dbPath: fx.dbPath, apply: true });

      assert.equal(report.apply, true);
      assert.equal(report.total, 2);
      assert.equal(report.removed, 2, 'both worktrees removed');
      assert.equal(report.stranded, 0);
      for (const p of paths) {
        assert.ok(!existsSync(p), '--apply must remove the worktree directory');
      }
    } finally {
      teardown(fx.repo);
    }
  });
});

describe('clean — CLI surface', () => {
  it('is a registered command — dry-run by default, exits 0', () => {
    const fx = setupFixture();
    try {
      const r = runCli(['clean', fx.runId], fx.dbPath);
      assert.doesNotMatch(r.stderr || '', /SyntaxError|Cannot find module/, `cli load error:\n${r.stderr}`);
      assert.equal(r.status, 0, `clean dry-run should exit 0; got ${r.status}\n${r.stderr}`);
      assert.match(r.stdout, /DRY-RUN/i, 'dry-run is the default and is labelled');
      // dry-run leaves the worktrees on disk
      assert.ok(fx.worktrees.every(w => existsSync(w.worktreePath)), 'CLI dry-run removed nothing');
    } finally {
      teardown(fx.repo);
    }
  });

  it('--apply removes the worktrees', () => {
    const fx = setupFixture();
    try {
      const r = runCli(['clean', fx.runId, '--apply'], fx.dbPath);
      assert.equal(r.status, 0, `clean --apply should exit 0; got ${r.status}\n${r.stderr}`);
      assert.ok(fx.worktrees.every(w => !existsSync(w.worktreePath)), 'CLI --apply removed the worktrees');
    } finally {
      teardown(fx.repo);
    }
  });

  it('--format=json emits a parseable rollup', () => {
    const fx = setupFixture();
    try {
      const r = runCli(['clean', fx.runId, '--format=json'], fx.dbPath);
      assert.equal(r.status, 0, `clean --format=json should exit 0; got ${r.status}\n${r.stderr}`);
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
        `clean --format=json must emit parseable JSON; got:\n${r.stdout}`);
      assert.equal(parsed.total, 2);
      assert.equal(parsed.removed, 0, 'json dry-run reports nothing removed');
      assert.equal(parsed.dryRun, true);
      assert.ok(Array.isArray(parsed.worktrees));
      // Sibling of F-dc577139/F-db2ed146 (sweep-discovered, same wave): a bare
      // Array.isArray check is satisfied equally by an empty `worktrees` array
      // as by the real, populated one -- even with parsed.total already
      // pinned to 2 above, a --format=json serialization bug could silently
      // drop the array's own contents while leaving `total` correct (they are
      // two independently-serialized fields). Cross-check length against the
      // already-asserted total, and against the JS-level report shape this
      // same file proves elsewhere (line ~119: report.worktrees.length === 2;
      // line ~141: report.worktrees[0].branch).
      assert.equal(parsed.worktrees.length, parsed.total,
        'worktrees[] length must agree with the total field the JSON also reports');
      assert.equal(parsed.worktrees.length, 2);
      for (const w of parsed.worktrees) {
        assert.equal(typeof w.branch, 'string', `each JSON worktree entry must carry a branch string, got: ${JSON.stringify(w)}`);
      }
    } finally {
      teardown(fx.repo);
    }
  });
});
