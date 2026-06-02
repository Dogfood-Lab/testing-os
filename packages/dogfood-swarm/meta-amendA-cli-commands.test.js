/**
 * meta-amendA-cli-commands.test.js — regression coverage for the cli-commands
 * amend agent (dogfood swarm-1780390764-7dab, Stage A).
 *
 * One co-located test file pinning the five CONFIRMED findings this agent
 * fixed. Each describe block names its finding id and the failure mode it
 * locks down. These tests were written to FAIL against the pre-fix code and
 * PASS after the surgical fix (Pattern #10 proof-gate discipline).
 *
 *   cli-001 (HIGH)  — commands/rewind.js: DB abort scoped by run, not global.
 *   ve-002  (HIGH)  — cli.js parseVerifyFlags: --threshold space-form NaN guard.
 *   cli-002 (MED)   — cli.js cmdApprove: no duplicate `approved` events on re-run.
 *   cli-003 (LOW)   — cli.js: `--reason --flag` is a MISSING reason, not '--flag'.
 *   +1 (MED)        — commands/status.js: collect-crash half-state breadcrumb.
 *
 * CORDONED-TEST DISCIPLINE (inherited from rewind.test.js):
 *   The cli-001 rewind tests run `git reset --hard` + DB writes. Every such
 *   test creates a fresh mkdtemp fixture git repo + fixture control-plane.db
 *   and passes both explicitly. No test references process.cwd(), the live
 *   swarms DB, or the real repo tree. A HEAD-guard sentinel (last describe
 *   block) asserts the actual repo HEAD is unchanged after the whole suite.
 *
 * EXTENSION (2026-06-02): the cli-003 block below also pins cmdAdvance's
 * `--override --reason` parser (cli.js ~912) — the FOURTH `--reason` site. The
 * original amend agent declined to file it ("no irreversible side effect"), but
 * a `--`-prefixed value still pollutes the promotion/override audit record, so
 * the same guard was applied and is regression-pinned by the two `advance` tests.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { rewind } from './commands/rewind.js';
import { parseVerifyFlags } from './cli.js';
import { status } from './commands/status.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

// Cordoned HEAD guard — record the real repo HEAD by walking up from this
// file (no live-repo path literal). Asserted unchanged at the end.
const ACTUAL_REPO_ROOT = resolvePath(__dirname, '..', '..');
let ACTUAL_HEAD_AT_SUITE_START = null;
function recordActualHead() {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: ACTUAL_REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}
before(() => { ACTUAL_HEAD_AT_SUITE_START = recordActualHead(); });

function teardown(...dirs) {
  for (const d of dirs) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

// ──────────────────────────────────────────────────────────────
// cli-001 — rewind DB abort is scoped to the run owning the cwd
// ──────────────────────────────────────────────────────────────

/**
 * Build a fixture git repo for run A (the tree rewind resets) plus a shared
 * fixture control-plane.db holding TWO runs:
 *   - run A: local_path = the fixture git tree, with an in-flight wave.
 *   - run B: local_path = a SEPARATE temp dir (NOT a git repo, never reset),
 *            with its own in-flight wave + agent_runs.
 * Rewinding run A must NOT touch run B's live rows.
 */
function setupTwoRunFixture() {
  const treeA = mkdtempSync(join(tmpdir(), 'meta-rewind-A-'));
  const dirB = mkdtempSync(join(tmpdir(), 'meta-rewind-B-'));

  execFileSync('git', ['init', '-q', '-b', 'main', treeA], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: treeA });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: treeA });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: treeA });

  writeFileSync(join(treeA, '.gitignore'), '*.db\n*.db-wal\n*.db-shm\n', 'utf-8');
  writeFileSync(join(treeA, 'README.md'), '# fixture A\n', 'utf-8');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  execFileSync('git', ['add', '.'], { cwd: treeA });
  execFileSync('git', ['commit', '-q', '-m', 'A: initial'], { cwd: treeA, env });
  execFileSync('git', ['tag', 'swarm-save-A-1'], { cwd: treeA });
  writeFileSync(join(treeA, 'README.md'), '# fixture A\n\nsecond\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: treeA });
  execFileSync('git', ['commit', '-q', '-m', 'A: second'], { cwd: treeA, env });

  const dbPath = join(treeA, 'control-plane.db');
  const db = openDb(dbPath);

  // Run A — owns treeA.
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run('runA', 'org/a', treeA, 'a'.repeat(40));
  db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('runA','backend','["src/**"]','owned',1)`).run();
  const wA = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES ('runA','health-audit-a',1,'dispatched','snapA')`).run();
  const waveA = Number(wA.lastInsertRowid);
  const domA = db.prepare(`SELECT id FROM domains WHERE run_id='runA'`).get().id;
  const arA = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')`).run(waveA, domA);
  const agentA = Number(arA.lastInsertRowid);

  // Run B — owns a DIFFERENT dir, in-flight, must be left untouched.
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run('runB', 'org/b', dirB, 'b'.repeat(40));
  db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('runB','backend','["src/**"]','owned',1)`).run();
  const wB = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES ('runB','health-audit-a',1,'dispatched','snapB')`).run();
  const waveB = Number(wB.lastInsertRowid);
  const domB = db.prepare(`SELECT id FROM domains WHERE run_id='runB'`).get().id;
  const arB1 = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')`).run(waveB, domB);
  const arB2 = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'invalid_output')`).run(waveB, domB);
  const agentB1 = Number(arB1.lastInsertRowid);
  const agentB2 = Number(arB2.lastInsertRowid);

  closeDb(dbPath);
  return { treeA, dirB, dbPath, waveA, agentA, waveB, agentB1, agentB2 };
}

describe('cli-001: rewind aborts only the run owning the cwd', () => {
  it('dry-run plan lists only run A, never run B', () => {
    const fx = setupTwoRunFixture();
    try {
      const r = rewind({
        savePointTag: 'swarm-save-A-1',
        reason: 'scope check',
        cwd: fx.treeA,
        dbPath: fx.dbPath,
      });
      // Only run A's single wave + agent are in the plan.
      assert.equal(r.planned_waves.length, 1);
      assert.equal(r.planned_waves[0].run_id, 'runA');
      assert.equal(r.planned_agent_runs.length, 1);
      // The report names the scoped run id for operator visibility.
      assert.deepEqual(r.scopedRunIds, ['runA']);
      // Run B's wave/agents (1 wave, 2 agents) are NOT in the plan.
      assert.ok(r.planned_waves.every(w => w.run_id === 'runA'));
    } finally {
      teardown(fx.treeA, fx.dirB);
    }
  });

  it('--apply aborts run A in-flight rows but leaves run B untouched', () => {
    const fx = setupTwoRunFixture();
    try {
      const r = rewind({
        savePointTag: 'swarm-save-A-1',
        reason: 'apply scope check',
        cwd: fx.treeA,
        dbPath: fx.dbPath,
        apply: true,
      });
      assert.equal(r.git_reset_done, true);
      assert.equal(r.db_transaction_done, true);

      const db = openDb(fx.dbPath);
      // Run A: wave + agent now aborted_for_rewind.
      assert.equal(db.prepare('SELECT status FROM waves WHERE id = ?').get(fx.waveA).status, 'aborted_for_rewind');
      assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(fx.agentA).status, 'aborted_for_rewind');

      // Run B: every live row UNCHANGED — this is the cli-001 regression.
      assert.equal(db.prepare('SELECT status FROM waves WHERE id = ?').get(fx.waveB).status, 'dispatched',
        'cli-001 regression: rewinding run A drove run B\'s wave to aborted_for_rewind');
      assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(fx.agentB1).status, 'dispatched',
        'cli-001 regression: run B agent_run was aborted by run A rewind');
      assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(fx.agentB2).status, 'invalid_output',
        'cli-001 regression: run B blocked agent_run was aborted by run A rewind');

      // Run B left NO state-event rows from this rewind.
      const bWaveEvents = db.prepare('SELECT COUNT(*) AS n FROM wave_state_events WHERE wave_id = ?').get(fx.waveB).n;
      assert.equal(bWaveEvents, 0, 'run B must have no rewind audit rows');
      closeDb(fx.dbPath);
    } finally {
      teardown(fx.treeA, fx.dirB);
    }
  });

  it('preserved counts are scoped to the cwd run (do not count run B terminal rows)', () => {
    const fx = setupTwoRunFixture();
    try {
      // Give run B a terminal (complete) agent so an UNSCOPED preserved count
      // would be inflated by it.
      const db = openDb(fx.dbPath);
      const domB = db.prepare(`SELECT id FROM domains WHERE run_id='runB'`).get().id;
      db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`).run(fx.waveB, domB);
      closeDb(fx.dbPath);

      const r = rewind({
        savePointTag: 'swarm-save-A-1',
        reason: 'preserved scope',
        cwd: fx.treeA,
        dbPath: fx.dbPath,
      });
      // Run A has zero terminal rows; the count must be 0, not run B's 1.
      assert.equal(r.preserved_agent_run_count, 0,
        'preserved count leaked a run-B terminal agent_run');
    } finally {
      teardown(fx.treeA, fx.dirB);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// ve-002 — parseVerifyFlags rejects a non-numeric --threshold (space form)
// ──────────────────────────────────────────────────────────────

describe('ve-002: parseVerifyFlags --threshold space-form guard', () => {
  it('throws (does NOT yield NaN) for a non-numeric threshold', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold', 'foo']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD' && /non-negative integer/.test(e.message),
      'parseVerifyFlags must reject --threshold foo, not silently produce NaN',
    );
  });

  it('throws for a negative threshold', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold', '-1']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD',
    );
  });

  it('throws for a partially-numeric threshold (parseInt would have accepted 3)', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold', '3abc']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD',
    );
  });

  it('accepts a valid integer space-form threshold', () => {
    const { threshold } = parseVerifyFlags(['run', '--threshold', '5']);
    assert.equal(threshold, 5);
  });

  it('accepts the equals-form and bare default unchanged', () => {
    assert.equal(parseVerifyFlags(['run', '--threshold=3']).threshold, 3);
    assert.equal(parseVerifyFlags(['run']).threshold, 0);
  });

  it('a trailing --threshold with no value keeps the default 0 (no throw)', () => {
    // args[tIdx+1] === undefined → not a typo'd value, just an omitted one.
    assert.equal(parseVerifyFlags(['run', '--threshold']).threshold, 0);
  });

  it('CLI seam: `swarm verify-fixed <run> --threshold foo` exits non-zero, not a green pass', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'meta-thr-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const db = openDb(dbPath);
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run('r1', 'org/r', tmp, 'a'.repeat(40));
      closeDb(dbPath);

      const r = spawnSync(process.execPath, [CLI_PATH, 'verify-fixed', 'r1', '--threshold', 'foo'], {
        encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.notEqual(r.status, 0,
        'a typo\'d threshold must NOT exit 0 (that would silently disable the gate)');
      assert.match(r.stderr, /CLI_INVALID_THRESHOLD|non-negative integer/);
    } finally {
      teardown(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// cli-002 — cmdApprove does not duplicate `approved` events on re-run
// ──────────────────────────────────────────────────────────────

describe('cli-002: re-running `swarm approve --all` does not double events', () => {
  function setupApproveFixture() {
    const tmp = mkdtempSync(join(tmpdir(), 'meta-approve-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tmp, 'a'.repeat(40));
    const w = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES ('r1','health-audit-a',1,'collected','snap1')`).run();
    const waveId = Number(w.lastInsertRowid);
    // Two findings, both new/recurring (approvable).
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave) VALUES ('r1','F-001','fp1','HIGH','bug','d1','new',?)`).run(waveId);
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave) VALUES ('r1','F-002','fp2','MEDIUM','bug','d2','recurring',?)`).run(waveId);
    closeDb(dbPath);
    return { tmp, dbPath };
  }

  function approvedEventCount(dbPath) {
    const db = openDb(dbPath);
    const n = db.prepare(
      "SELECT COUNT(*) AS n FROM finding_events WHERE event_type = 'approved'"
    ).get().n;
    return n;
  }

  function runApprove(dbPath) {
    return spawnSync(process.execPath, [CLI_PATH, 'approve', 'r1', '--all'], {
      encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  it('first approve emits exactly 2 events; second approve emits 0 more', () => {
    const fx = setupApproveFixture();
    try {
      const r1 = runApprove(fx.dbPath);
      assert.equal(r1.status, 0, `first approve failed: ${r1.stderr}`);
      assert.match(r1.stdout, /Approved 2 findings/);
      assert.equal(approvedEventCount(fx.dbPath), 2, 'first approve must record 2 events');

      // Re-run: both findings already approved. The UPDATE flips 0 rows, so
      // NO new approved events should be inserted (cli-002 regression: the old
      // code re-selected all status='approved' rows and inserted a duplicate
      // event per finding on every call).
      const r2 = runApprove(fx.dbPath);
      assert.equal(r2.status, 0, `second approve failed: ${r2.stderr}`);
      assert.match(r2.stdout, /Approved 0 findings/);
      assert.equal(approvedEventCount(fx.dbPath), 2,
        'cli-002 regression: re-running approve duplicated approved events');
    } finally {
      teardown(fx.tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// cli-003 — `--reason --flag` is a MISSING reason, not a swallowed flag
// ──────────────────────────────────────────────────────────────

describe('cli-003: --reason space-parser rejects a following flag as the reason', () => {
  // Run each verb against a fresh empty DB. The reason guard fires before any
  // DB mutation, so an empty DB is sufficient — and proves the irreversible
  // path never started (no run/wave needed).
  function freshDb() {
    const tmp = mkdtempSync(join(tmpdir(), 'meta-reason-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath); void db; closeDb(dbPath);
    return { tmp, dbPath };
  }

  function runCli(verb, args, dbPath, cwd) {
    return spawnSync(process.execPath, [CLI_PATH, verb, ...args], {
      encoding: 'utf-8', cwd: cwd || __dirname, env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  it('revalidate `--reason --apply` errors "reason required", does not run', () => {
    const fx = freshDb();
    try {
      const r = runCli('revalidate', ['r1', '--reason', '--apply', '--domain=x:y.json'], fx.dbPath);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /revalidate: --reason "<text>" is required/);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('rewind `--reason --apply` errors "reason required", does not reset', () => {
    const fx = freshDb();
    try {
      // cwd is the fresh (non-git) temp dir; the reason guard fires before any
      // git access, so it errors on reason, not on "not a git repo".
      const r = runCli('rewind', ['swarm-save-x', '--reason', '--apply'], fx.dbPath, fx.tmp);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /rewind: --reason "<text>" is required/);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('redrive `--reason --apply` errors "reason required", does not redrive', () => {
    const fx = freshDb();
    try {
      const r = runCli('redrive', ['1', '--reason', '--apply'], fx.dbPath);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /redrive: --reason "<text>" is required/);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('a real reason text is still accepted (guard does not over-reject)', () => {
    const fx = freshDb();
    try {
      // Valid reason → guard passes; revalidate then fails on the MISSING
      // --domain (a later guard), proving the reason was accepted.
      const r = runCli('revalidate', ['r1', '--reason', 'genuine reason'], fx.dbPath);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /at least one --domain=name:path is required/);
    } finally {
      teardown(fx.tmp);
    }
  });

  // cmdAdvance's override path is the FOURTH `--reason` site (cli.js ~912). It
  // differs from the three above: the override block is overridable with NO
  // irreversible side effect, so the cli-001/002/003 amend agent explicitly
  // declined to file it. But a `--`-prefixed value still pollutes the
  // promotion/override audit record — advance.js persists override reasons as
  // overrides:[{reason}] — so the same guard applies. NOTE: the finding's literal
  // example `--override --reason --history` is intercepted by cmdAdvance's
  // `--history` early-return (exits 0, prints promotion history) before it ever
  // reaches the reason parser; these tests use `--apply` (like the three siblings
  // above), a following flag that actually reaches the fixed line.
  it('advance `--override --reason --apply` errors "requires --reason", does not override', () => {
    const fx = freshDb();
    try {
      const r = runCli('advance', ['r1', '--override', '--reason', '--apply'], fx.dbPath);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--override requires --reason/);
      // The bug was a SILENT override carrying overrideReason='--apply'. Had the
      // guard been bypassed, runAdvance → checkGates would throw "Run not found:
      // r1"; its ABSENCE proves the reason guard fired before any override ran.
      assert.doesNotMatch(r.stderr, /Run not found/);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('advance `--override --reason "<text>"` is accepted (guard does not over-reject)', () => {
    const fx = freshDb();
    try {
      // Valid reason → guard passes; advance proceeds into runAdvance and fails
      // on the MISSING run r1 (checkGates throws "Run not found"), proving the
      // reason was accepted rather than rejected as a swallowed flag.
      const r = runCli('advance', ['r1', '--override', '--reason', 'genuine override reason'], fx.dbPath);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Run not found/);
      assert.doesNotMatch(r.stderr, /--override requires --reason/);
    } finally {
      teardown(fx.tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// +1 status half-state — collect-crash breadcrumb
// ──────────────────────────────────────────────────────────────

describe('status half-state: collect-crash breadcrumb when artifacts persisted but 0 findings', () => {
  function setupWave({ withArtifact, withFinding }) {
    const tmp = mkdtempSync(join(tmpdir(), 'meta-halfstate-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, ?, ?, ?, ?)')
      .run('r1', 'org/r', tmp, 'a'.repeat(40), 'health-audit-a');
    db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('r1','backend','["src/**"]','owned',1)`).run();
    const domId = db.prepare(`SELECT id FROM domains WHERE run_id='r1'`).get().id;
    // Wave still `dispatched`, agent `complete` — the collect-crash signature.
    const w = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES ('r1','health-audit-a',1,'dispatched','snap1')`).run();
    const waveId = Number(w.lastInsertRowid);
    const ar = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`).run(waveId, domId);
    const arId = Number(ar.lastInsertRowid);
    if (withArtifact) {
      db.prepare(`INSERT INTO artifacts (agent_run_id, artifact_type, path, content_hash) VALUES (?, 'audit_output', '/x/out.json', 'h1')`).run(arId);
    }
    if (withFinding) {
      db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave) VALUES ('r1','F-001','fp1','HIGH','bug','d1','new',?)`).run(waveId);
    }
    closeDb(dbPath);
    return { tmp, dbPath, waveId };
  }

  it('artifacts present + 0 findings → READY TO COLLECT with a "collect may have failed" breadcrumb', () => {
    const fx = setupWave({ withArtifact: true, withFinding: false });
    try {
      const s = status({ runId: 'r1', dbPath: fx.dbPath });
      assert.equal(s.assessment.state, 'READY TO COLLECT');
      assert.match(s.assessment.nextAction, /no findings were persisted/);
      assert.match(s.assessment.nextAction, /a prior `swarm collect` may have failed/);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('happy path (no artifacts yet) → plain "Run `swarm collect`" message, no breadcrumb', () => {
    const fx = setupWave({ withArtifact: false, withFinding: false });
    try {
      const s = status({ runId: 'r1', dbPath: fx.dbPath });
      assert.equal(s.assessment.state, 'READY TO COLLECT');
      assert.match(s.assessment.nextAction, /Run `swarm collect` to merge outputs\./);
      assert.doesNotMatch(s.assessment.nextAction, /may have failed/);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('artifacts present AND findings present → no breadcrumb (a real collect ran)', () => {
    const fx = setupWave({ withArtifact: true, withFinding: true });
    try {
      const s = status({ runId: 'r1', dbPath: fx.dbPath });
      // Findings reference the wave, so this is not the crash signature even
      // though artifacts exist. (Wave is still `dispatched` in this fixture,
      // so it stays READY TO COLLECT — but WITHOUT the failure breadcrumb.)
      assert.equal(s.assessment.state, 'READY TO COLLECT');
      assert.doesNotMatch(s.assessment.nextAction, /may have failed/);
    } finally {
      teardown(fx.tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Cordoned HEAD guard — MUST be last
// ──────────────────────────────────────────────────────────────

describe('cordoned HEAD guard (MUST be last)', () => {
  it('actual repo HEAD is unchanged after the full suite', () => {
    const headNow = recordActualHead();
    assert.equal(headNow, ACTUAL_HEAD_AT_SUITE_START,
      `Cordoned-test contract violated: actual repo HEAD changed from ` +
      `${ACTUAL_HEAD_AT_SUITE_START} to ${headNow}. A rewind test escaped its fixture.`);
    assert.ok(headNow, 'HEAD must resolve at the repo root');
  });
});
