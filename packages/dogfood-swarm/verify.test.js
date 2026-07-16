/**
 * verify.test.js — Phase 2 tests: adapter registry, probing, verification runner.
 *
 * NOTE (F-W1-TEST-001): adapter probes are exercised against synthetic
 * fixture repos that this test materializes into a tmpdir. The previous
 * generation of these tests pointed at hardcoded local paths
 * (F:/AI/stillpoint, F:/AI/ai-eyes-mcp, F:/AI/saints-mile) and silently
 * `return`-ed when the path was absent, which made every adapter test
 * pass on CI with zero assertions. The tmpdir approach gives CI a real
 * assertion bedrock for the adapter selection layer.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stripComments } from './test-support/strip-comments.js';

// ── Adapters ──
import { nodeAdapter } from './lib/verify/adapters/node.js';
import { pythonAdapter } from './lib/verify/adapters/python.js';
import { rustAdapter } from './lib/verify/adapters/rust.js';

// ── Registry ──
import { probeAll, selectAdapter, listAdapters } from './lib/verify/registry.js';

// ── Runner ──
import { runStep } from './lib/verify/runner.js';

// ── Control plane integration ──
import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';

// ═══════════════════════════════════════════
// Synthetic fixture repos
// ═══════════════════════════════════════════
//
// Each builder materializes the smallest set of files that the adapter's
// probe() function looks for. Probe shape is documented at
// packages/dogfood-swarm/lib/verify/adapters/*.js. Keep these in lockstep
// when probe scoring changes.

function makeNodeFixture(parent) {
  const dir = join(parent, 'node-fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-node-repo',
        version: '0.0.0',
        scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc -b' },
      },
      null,
      2
    ),
    'utf-8'
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 2),
    'utf-8'
  );
  return dir;
}

function makePythonFixture(parent) {
  const dir = join(parent, 'python-fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pyproject.toml'),
    [
      '[project]',
      'name = "fixture-python-repo"',
      'version = "0.0.0"',
      '',
      '[tool.ruff]',
      'line-length = 120',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
      '',
    ].join('\n'),
    'utf-8'
  );
  mkdirSync(join(dir, 'tests'), { recursive: true });
  return dir;
}

function makeRustFixture(parent) {
  const dir = join(parent, 'rust-fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'Cargo.toml'),
    [
      '[package]',
      'name = "fixture-rust-repo"',
      'version = "0.0.0"',
      'edition = "2021"',
      '',
    ].join('\n'),
    'utf-8'
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'lib.rs'), 'pub fn add(a: u32, b: u32) -> u32 { a + b }\n', 'utf-8');
  return dir;
}

function makeEmptyFixture(parent) {
  // A directory with nothing any adapter recognizes — used for "no adapter
  // matches" assertions. Use mkdtempSync inside parent for uniqueness so
  // adapters can't latch onto a sibling fixture by accident.
  const dir = mkdtempSync(join(parent, 'empty-'));
  return dir;
}

// ═══════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════

describe('Runner — runStep', () => {
  it('captures passing command', () => {
    const result = runStep('.', { name: 'echo', cmd: 'node', args: ['-e', '"process.exit(0)"'] });
    assert.equal(result.passed, true);
    assert.equal(result.exit_code, 0);
    assert.ok(result.duration_ms >= 0);
    assert.equal(result.name, 'echo');
  });

  it('captures failing command', () => {
    const result = runStep('.', { name: 'fail', cmd: 'node', args: ['-e', '"process.exit(1)"'] });
    assert.equal(result.passed, false);
    assert.equal(result.exit_code, 1);
  });

  it('captures stdout', () => {
    const result = runStep('.', { name: 'out', cmd: 'node', args: ['-e', '"console.log(42)"'] });
    assert.ok(result.stdout.includes('42'));
  });

  it('marks optional flag', () => {
    const result = runStep('.', { name: 'opt', cmd: 'node', args: ['-e', '"process.exit(1)"'], optional: true });
    assert.equal(result.passed, false);
    assert.equal(result.optional, true);
  });
});

describe('Runner — subprocess invocation discipline (F-W1-BACK-003)', () => {
  // F-W1-BACK-003: runStep mirrors the v1.2.0 doctrine established in
  // lib/worktree.js's gitArgs() helper and lib/domains.js — every subprocess
  // call uses execFileSync(cmd, args[]) rather than building a shell command
  // string and handing it to execSync(). This is a source-text gate, not a
  // behavioral injection round-trip: runStep's own header documents that
  // `shell: true` means the argv array does NOT neutralize shell
  // metacharacters (every live step.args entry is a hardcoded literal, which
  // is the actual safety guarantee) — so the property worth pinning is that
  // the CALL SHAPE stays execFileSync(step.cmd, cmdArgs, ...), matching the
  // package-wide convention, not execSync of a joined string. Same test shape
  // as F-21240958's persist.js pin.
  //
  // F-911b18ef (wave 22): routed through stripComments — this is the exact
  // "raw-source-grep pin false-positiving on a comment" shape F-21240958
  // itself was filed and fixed for (commands/persist.js's own header comment
  // mentions execSync( in prose). lib/verify/runner.js carries no such
  // comment today, so this was a latent, undisclosed fragility rather than a
  // live failure — stripped anyway so a future doc comment describing this
  // fix (the way persist.js's own F-21240958 comment does) cannot trip either
  // assertion below.
  const RUNNER_SRC = stripComments(readFileSync(new URL('./lib/verify/runner.js', import.meta.url), 'utf-8'));

  it('GATE: no execSync( call in runner.js — execFileSync with a real argv array only', () => {
    assert.doesNotMatch(RUNNER_SRC, /execSync\(/,
      'runner.js must not call execSync( — every subprocess invocation uses execFileSync with an argv array (F-W1-BACK-003)');
    assert.match(RUNNER_SRC, /execFileSync\(step\.cmd,\s*cmdArgs,/,
      'runStep must call execFileSync(step.cmd, cmdArgs, ...) — the argv-array form, matching lib/worktree.js#gitArgs and lib/domains.js (F-W1-BACK-003)');
  });

  it('execFileSync receives the argv array (cmdArgs), never the human-readable joined display string (fullCmd)', () => {
    assert.doesNotMatch(RUNNER_SRC, /execFileSync\(step\.cmd,\s*fullCmd/,
      'fullCmd is display-only (returned to callers/tests as `command`) — it must never be the value handed to execFileSync');
  });
});

// ═══════════════════════════════════════════
// Node adapter probing
// ═══════════════════════════════════════════

describe('Node adapter — probe', () => {
  let fixtureRoot;
  let nodeRepo;
  let emptyRepo;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'verify-test-node-'));
    nodeRepo = makeNodeFixture(fixtureRoot);
    emptyRepo = makeEmptyFixture(fixtureRoot);
  });
  after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('scores high for a Node repo (package.json + tsconfig + test script)', () => {
    const result = nodeAdapter.probe(nodeRepo);
    assert.ok(result.score >= 50, `Expected score >= 50, got ${result.score}`);
    assert.equal(result.evidence.packageJson, true);
    assert.equal(result.evidence.hasTest, true);
    assert.ok(result.reason.includes('Node'));
  });

  it('scores zero for an empty repo', () => {
    const result = nodeAdapter.probe(emptyRepo);
    assert.equal(result.score, 0);
  });
});

describe('Python adapter — probe', () => {
  let fixtureRoot;
  let pyRepo;
  let emptyRepo;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'verify-test-python-'));
    pyRepo = makePythonFixture(fixtureRoot);
    emptyRepo = makeEmptyFixture(fixtureRoot);
  });
  after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('scores high for a Python repo (pyproject.toml + pytest + tests/)', () => {
    const result = pythonAdapter.probe(pyRepo);
    assert.ok(result.score >= 50, `Expected score >= 50, got ${result.score}`);
    assert.equal(result.evidence.pyprojectToml, true);
    assert.equal(result.evidence.hasPytest, true);
    assert.equal(result.evidence.hasRuff, true);
  });

  it('scores zero for an empty repo', () => {
    const result = pythonAdapter.probe(emptyRepo);
    assert.equal(result.score, 0);
  });
});

describe('Rust adapter — probe', () => {
  let fixtureRoot;
  let rustRepo;
  let emptyRepo;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'verify-test-rust-'));
    rustRepo = makeRustFixture(fixtureRoot);
    emptyRepo = makeEmptyFixture(fixtureRoot);
  });
  after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('scores high for a Rust repo (Cargo.toml + src/)', () => {
    const result = rustAdapter.probe(rustRepo);
    assert.ok(result.score >= 60, `Expected score >= 60, got ${result.score}`);
    assert.equal(result.evidence.cargoToml, true);
    assert.equal(result.evidence.srcDir, true);
  });

  it('scores zero for an empty repo', () => {
    const result = rustAdapter.probe(emptyRepo);
    assert.equal(result.score, 0);
  });
});

// ═══════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════

describe('Registry — probeAll', () => {
  let fixtureRoot;
  let nodeRepo;
  let pyRepo;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'verify-test-registry-probeall-'));
    nodeRepo = makeNodeFixture(fixtureRoot);
    pyRepo = makePythonFixture(fixtureRoot);
  });
  after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('returns sorted results with the matching adapter first for a Node repo', () => {
    const results = probeAll(nodeRepo);
    assert.ok(results.length >= 3);
    assert.equal(results[0].name, 'node');
    assert.ok(results[0].score > 0);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score);
    }
  });

  it('returns sorted results with the matching adapter first for a Python repo', () => {
    const results = probeAll(pyRepo);
    assert.equal(results[0].name, 'python');
    assert.ok(results[0].score > 0);
  });
});

describe('Registry — selectAdapter', () => {
  let fixtureRoot;
  let nodeRepo;
  let pyRepo;
  let emptyRepo;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'verify-test-registry-select-'));
    nodeRepo = makeNodeFixture(fixtureRoot);
    pyRepo = makePythonFixture(fixtureRoot);
    emptyRepo = makeEmptyFixture(fixtureRoot);
  });
  after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('selects node for a Node repo', () => {
    const selection = selectAdapter(nodeRepo);
    assert.equal(selection.name, 'node');
  });

  it('selects python for a Python repo', () => {
    const selection = selectAdapter(pyRepo);
    assert.equal(selection.name, 'python');
  });

  it('respects explicit override', () => {
    const selection = selectAdapter(nodeRepo, 'python');
    assert.equal(selection.name, 'python');
  });

  it('throws on unknown adapter override', () => {
    assert.throws(() => selectAdapter('.', 'cobol'), /Unknown adapter/);
  });

  it('returns null for an empty repo (no adapter matches)', () => {
    const selection = selectAdapter(emptyRepo);
    assert.equal(selection, null);
  });
});

describe('Registry — listAdapters', () => {
  it('lists all three adapters', () => {
    const adapters = listAdapters();
    assert.ok(adapters.includes('node'));
    assert.ok(adapters.includes('python'));
    assert.ok(adapters.includes('rust'));
  });
});

// ═══════════════════════════════════════════
// Control plane integration
// ═══════════════════════════════════════════

describe('Verification receipt persistence', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'collected')")
      .run();
  });

  it('inserts verification receipt into DB', () => {
    db.prepare(`
      INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
      VALUES (1, 'node', '["npm test"]', 0, 1, 42)
    `).run();

    const receipt = db.prepare('SELECT * FROM verification_receipts WHERE wave_id = 1').get();
    assert.ok(receipt);
    assert.equal(receipt.repo_type, 'node');
    assert.equal(receipt.passed, 1);
    assert.equal(receipt.test_count, 42);
    db.close();
  });

  it('verification pass updates wave to verified', () => {
    // Simulate what verify command does
    db.prepare(`
      INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
      VALUES (1, 'node', '["npm test"]', 0, 1, 42)
    `).run();
    db.prepare("UPDATE waves SET status = 'verified' WHERE id = 1 AND status = 'collected'").run();

    const wave = db.prepare('SELECT status FROM waves WHERE id = 1').get();
    assert.equal(wave.status, 'verified');
    db.close();
  });

  it('verification fail does NOT update wave to verified', () => {
    db.prepare(`
      INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
      VALUES (1, 'node', '["npm test"]', 1, 0, 0)
    `).run();
    // Do NOT update wave status

    const wave = db.prepare('SELECT status FROM waves WHERE id = 1').get();
    assert.equal(wave.status, 'collected'); // unchanged
    db.close();
  });
});

// ═══════════════════════════════════════════
// Node adapter — commands shape
// ═══════════════════════════════════════════

describe('Node adapter — commands', () => {
  it('produces correct default steps', () => {
    const steps = nodeAdapter.commands();
    assert.ok(steps.length >= 3);

    const names = steps.map(s => s.name);
    assert.ok(names.includes('lint'));
    assert.ok(names.includes('typecheck'));
    assert.ok(names.includes('test'));
  });

  it('allows command overrides', () => {
    const steps = nodeAdapter.commands({
      test: { name: 'test', cmd: 'vitest', args: ['run'] },
    });
    const testStep = steps.find(s => s.name === 'test');
    assert.equal(testStep.cmd, 'vitest');
  });
});

describe('Python adapter — commands', () => {
  it('produces correct default steps', () => {
    const steps = pythonAdapter.commands();
    const names = steps.map(s => s.name);
    assert.ok(names.includes('lint'));
    assert.ok(names.includes('test'));
  });
});

describe('Rust adapter — commands', () => {
  it('produces correct default steps', () => {
    const steps = rustAdapter.commands();
    const names = steps.map(s => s.name);
    assert.ok(names.includes('check'));
    assert.ok(names.includes('test'));
  });
});
