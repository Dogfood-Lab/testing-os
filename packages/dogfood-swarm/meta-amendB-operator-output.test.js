/**
 * meta-amendB-operator-output.test.js — Stage C amend (operator-output) regression pins.
 *
 * These tests pin the operator-trust / exit-code / verify-output fixes from the
 * Stage-B proactive sweep (swarm-1780390764-7dab/wave-3). They are NOT bug
 * fixes — the gate was always SAFE (no false ADVANCE) — they close the gap
 * between the machine signal a CI step gates on and the human-readable signal
 * an operator reads. Each block names its finding id.
 *
 * Findings covered here:
 *   cli-p-002  — `swarm verify` exits 0 only on a clean pass (subprocess seam)
 *   ve-p-002   — formatVerify prints the non-pass `reason`
 *   td-p-004   — END-TO-END: adapter no_tests → operator sees explained
 *                NO_TESTS and `swarm verify` exits non-zero
 *   ve-p-003   — the durable receipt carries the verdict + reason (stdout hdr)
 *   ve-p-004   — the verify wave-gate emits a correlated logStage pair
 *   cli-p-001  — `swarm persist --ingest` exits non-zero on ingest failure
 *   fp-p-003   — buildDogfoodSubmission finished_at is stable for an
 *                INCOMPLETE run (idempotent re-ingest)
 *   fp-p-004   — persist reports repo-knowledge artifacts-written, not
 *                submitted
 *   cli-r-002  — the main() refactor keeps the help/usage subprocess contract
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDb, closeDb, openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { verify as runVerify, formatVerify } from './commands/verify.js';
import { formatPersist } from './commands/persist.js';
import { status, formatStatus } from './commands/status.js';
import { advance } from './lib/advance.js';
import { buildRunExport, computeRunVerdict } from './lib/persist/export.js';
import { buildDogfoodSubmission } from './lib/persist/dogfood-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

// Override the three OPTIONAL node-adapter steps (lint/typecheck/build) with
// trivial in-process no-ops so the verify path never shells out to npx/tsc
// (which could hang or fail on a CI host). The `test` step is deliberately
// LEFT at its default `npm test --if-present` so the node adapter's no_tests
// downgrade still fires for a fixture with no `test` script — overriding the
// test step would suppress exactly the path under test.
const SAFE_OPTIONAL_OVERRIDES = {
  lint: { name: 'lint', cmd: process.execPath, args: ['-e', 'process.exit(0)'], optional: true },
  typecheck: { name: 'typecheck', cmd: process.execPath, args: ['-e', 'process.exit(0)'], optional: true },
  build: { name: 'build', cmd: process.execPath, args: ['-e', 'process.exit(0)'], optional: true },
};

function makeNoTestRepo(parent) {
  // A Node repo with NO `test` script: the node adapter scores it (package.json
  // present) but evidence.hasTest === false, so `npm test --if-present` runs
  // nothing and the adapter returns verdict no_tests.
  const dir = join(parent, 'no-test-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-no-test', version: '0.0.0', scripts: { lint: 'true' } }, null, 2),
    'utf-8'
  );
  return dir;
}

function seedRunWithWave(db, runId, localPath) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', localPath, 'a'.repeat(40));
  saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);
  db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')")
    .run(runId);
}

// ═══════════════════════════════════════════
// ve-p-002 / td-p-004 — formatVerify surfaces the reason
// ═══════════════════════════════════════════

describe('ve-p-002: formatVerify prints the non-pass reason', () => {
  it('renders a Reason: line when the verdict carries one', () => {
    const out = formatVerify({
      verdict: 'no_tests',
      reason: 'no `test` script — `npm test --if-present` ran zero tests; not a verified pass',
      adapter: 'node',
      probe: null,
      duration_ms: 5,
      test_count: 0,
      steps: [],
    });
    assert.match(out, /Verification: NO_TESTS/);
    assert.match(out, /Reason: no `test` script/,
      'the adapter reason must reach the operator, not be dropped');
  });

  it('omits the Reason: line for a clean pass (no reason to show)', () => {
    const out = formatVerify({
      verdict: 'pass', reason: undefined, adapter: 'node', probe: null,
      duration_ms: 5, test_count: 3, steps: [],
    });
    assert.match(out, /Verification: PASS/);
    assert.doesNotMatch(out, /Reason:/);
  });
});

// ═══════════════════════════════════════════
// td-p-004 (END-TO-END) + ve-p-003 + ve-p-004
// adapter no_tests → verify() return + persisted receipt + logStage
// ═══════════════════════════════════════════

describe('td-p-004: no_tests propagates end-to-end through verify()', () => {
  // verify() calls openDb(opts.dbPath), which expects a FILE PATH (pool key +
  // new Database(path)) — so this end-to-end block seeds an on-disk control
  // plane and drives verify() against the path, the same way the operator's
  // `swarm verify` does. logStage writes to console.error, which we patch in
  // process to capture the NDJSON correlation events.
  let fixtureRoot;
  let repoPath;
  let dbPath;
  let stderrLines;
  let origErr;

  before(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'amendB-notest-'));
    repoPath = makeNoTestRepo(fixtureRoot);
  });
  after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  beforeEach(() => {
    dbPath = join(fixtureRoot, `cp-${Math.random().toString(36).slice(2)}.db`);
    const db = openDb(dbPath);
    seedRunWithWave(db, 'r1', repoPath);
    closeDb(dbPath);
    stderrLines = [];
    origErr = console.error;
    console.error = (...a) => { stderrLines.push(a.join(' ')); };
  });
  afterEach(() => {
    console.error = origErr;
    try { closeDb(dbPath); } catch { /* */ }
  });

  it('verify() returns verdict no_tests WITH the explanatory reason', () => {
    const result = runVerify({
      runId: 'r1',
      dbPath,
      commandOverrides: SAFE_OPTIONAL_OVERRIDES,
    });
    assert.equal(result.verdict, 'no_tests');
    assert.equal(result.no_tests, true);
    assert.match(result.reason, /no `test` script/,
      'verify() must forward the reason, not strip it (the pre-fix gap)');
  });

  it('formatVerify(result) shows an explained NO_TESTS the operator can act on', () => {
    const result = runVerify({ runId: 'r1', dbPath, commandOverrides: SAFE_OPTIONAL_OVERRIDES });
    const out = formatVerify(result);
    assert.match(out, /Verification: NO_TESTS/);
    assert.match(out, /Reason: no `test` script/,
      'the operator must see WHY, not a bare NO_TESTS token');
  });

  it('ve-p-003: the persisted receipt stdout carries the verdict + reason header', () => {
    const result = runVerify({ runId: 'r1', dbPath, commandOverrides: SAFE_OPTIONAL_OVERRIDES });
    const db = openDb(dbPath);
    const receipt = db.prepare('SELECT * FROM verification_receipts WHERE id = ?').get(result.receiptId);
    assert.ok(receipt, 'receipt must persist');
    assert.equal(receipt.passed, 0, 'no_tests is not a verified pass');
    assert.match(receipt.stdout, /=== verify verdict: no_tests — no `test` script/,
      'the durable receipt must carry the verdict + reason, not just passed=0');
  });

  it('ve-p-004: the wave gate emits a correlated verify_start/verify_complete pair', () => {
    runVerify({ runId: 'r1', dbPath, commandOverrides: SAFE_OPTIONAL_OVERRIDES });
    const events = stderrLines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (e.stage === 'verify_start' || e.stage === 'verify_complete'));
    const start = events.find(e => e.stage === 'verify_start');
    const complete = events.find(e => e.stage === 'verify_complete');
    assert.ok(start, 'verify_start must be emitted before the run');
    assert.ok(complete, 'verify_complete must be emitted after persistence');
    assert.ok(start.correlation_id && /^coord-/.test(start.correlation_id),
      'start must carry a coord- correlation id');
    assert.equal(start.correlation_id, complete.correlation_id,
      'the pair must share one correlation id so a single grep ties them');
    assert.equal(complete.verdict, 'no_tests');
    assert.match(complete.reason, /no `test` script/);
  });
});

// ═══════════════════════════════════════════
// cli-p-002 — `swarm verify` exit code (subprocess seam)
// ═══════════════════════════════════════════

describe('cli-p-002: `swarm verify` exits non-zero unless the verdict is a clean pass', () => {
  let tempDir;
  let dbPath;
  let repoPath;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'amendB-verify-cli-'));
    dbPath = join(tempDir, 'control-plane.db');
    repoPath = makeNoTestRepo(tempDir);
    const db = openDb(dbPath);
    seedRunWithWave(db, 'r1', repoPath);
    closeDb(dbPath);
  });
  // F-8ad2d58d: rmSync itself must be Windows-tolerant, not just closeDb —
  // closeDb only releases THIS process's own pooled connection, never the
  // just-exited CLI child's, so the WAL sidecar can still be lock-held for a
  // beat here. Matches the established sibling idiom (redrive.test.js,
  // rewind.test.js, every wave4/6/8/10/12-*-swarm-cp-pins.test.js).
  after(() => {
    try { closeDb(dbPath); } catch { /* */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('a no_tests verdict makes `swarm verify <run>` exit non-zero with an explanation', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'verify', 'r1'], {
      encoding: 'utf-8',
      cwd: __dirname,
      // SEED-2: sandbox the ingest DATA root so persist --ingest never writes
      // a record into the real repo tree (persist.js forwards INGEST_REPO_ROOT).
      env: { ...process.env, SWARM_DB: dbPath, INGEST_REPO_ROOT: tempDir },
    });
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
    assert.notEqual(r.status, 0,
      `a non-pass verdict must NOT exit 0 (CI must see the gate fail); got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /Verification: NO_TESTS/, 'human-readable verdict still printed to stdout');
    assert.match(r.stderr, /swarm verify: NO_TESTS/, 'exit-code path prints the verdict + why to stderr');
  });
});

// ═══════════════════════════════════════════
// cli-p-001 — `swarm persist --ingest` exit code on ingest failure
// ═══════════════════════════════════════════

describe('cli-p-001: `swarm persist --ingest` exits non-zero when ingest hard-fails', () => {
  let tempDir;
  let dbPath;
  // getOutputDir() derives the delta path from dirname(SWARM_DB), so with
  // SWARM_DB inside tempDir the persist artifacts land under tempDir/<runId>/
  // and are removed by the tempDir teardown below — nothing reaches the repo
  // swarms/ tree. (getOutputDir once hardcoded `<repo>/swarms/<runId>/` and
  // ignored SWARM_DB, leaking into the working copy; that was closed when it
  // started tracking the active control plane — see stageD-output-dir-tracks-db.)
  // The unique runId remains so concurrent runs of this file cannot collide.
  const RUN_ID = `amendB-cli-p-001-${Math.random().toString(36).slice(2)}`;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'amendB-persist-cli-'));
    dbPath = join(tempDir, 'control-plane.db');
    const db = openDb(dbPath);
    // A complete run so persist() builds + writes a normal success-shaped
    // report. The ingest is forced to fail deterministically by giving the run
    // a MALFORMED commit_sha ('badsha'): the submission persist writes is then
    // rejected by packages/ingest/run.js (non-zero exit), driving the exact
    // production catch in persist.js step 4 -> report.dogfood.ingested:false.
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at, completed_at)
      VALUES (?, 'org/r', ?, 'badsha', 'main', 'complete', '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z')`)
      .run(RUN_ID, tempDir);
    saveDomainDraft(db, RUN_ID, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, RUN_ID);
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'advanced')")
      .run(RUN_ID);
    closeDb(dbPath);
  });
  after(() => {
    try { closeDb(dbPath); } catch { /* */ }
    // tempDir holds both the control plane and (via getOutputDir tracking
    // SWARM_DB) the persist artifacts — one rmSync clears the lot. No repo-tree
    // cleanup is needed; a leak there would mean getOutputDir regressed, and
    // silently sweeping it would hide that (stageD-output-dir-tracks-db guards it).
    // F-8ad2d58d: rmSync itself must be Windows-tolerant, not just closeDb —
    // the two `it()`s above each spawn a CLI subprocess, which can still hold
    // the WAL sidecar lock for a beat after it exits.
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('exit is non-zero and the reproduce line is surfaced when the ingest subprocess fails', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'persist', RUN_ID, '--ingest'], {
      encoding: 'utf-8',
      cwd: __dirname,
      // SEED-2: sandbox the ingest DATA root so persist --ingest never writes
      // a record into the real repo tree (persist.js forwards INGEST_REPO_ROOT).
      env: { ...process.env, SWARM_DB: dbPath, INGEST_REPO_ROOT: tempDir },
    });
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
    assert.notEqual(r.status, 0,
      `a failed --ingest must NOT exit 0 (a CI gate on $? would treat a failed ` +
      `corpus write as success); got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /Ingested: NO/, 'human-readable ingest failure still printed to stdout');
    assert.match(r.stderr, /ERROR \[INGEST_FAILED\]/,
      'the exit-code path must surface a structured ingest-failure line on stderr');
    assert.match(r.stderr, /Reproduce:/,
      'a copy-pasteable reproduce line must be offered, mirroring persist-results.js');
  });

  it('persist WITHOUT --ingest exits 0 (no false red) and reports artifacts-written honestly', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'persist', RUN_ID], {
      encoding: 'utf-8',
      cwd: __dirname,
      // SEED-2: sandbox the ingest DATA root so persist --ingest never writes
      // a record into the real repo tree (persist.js forwards INGEST_REPO_ROOT).
      env: { ...process.env, SWARM_DB: dbPath, INGEST_REPO_ROOT: tempDir },
    });
    assert.equal(r.status, 0,
      `persist without --ingest must exit 0; got ${r.status}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /Submitted: NO/,
      'fp-p-004: repo-knowledge must report artifacts-written, not a DB submission');
    assert.match(r.stdout, /rk audit import/, 'fp-p-004: must tell the operator how to actually submit');
  });
});

// ═══════════════════════════════════════════
// fp-p-004 — formatPersist honest repo-knowledge wording
// ═══════════════════════════════════════════

describe('fp-p-004: formatPersist distinguishes artifacts-written from submitted', () => {
  it('prints Submitted: NO with the rk audit import hint when not submitted', () => {
    const out = formatPersist({
      runId: 'r1',
      verdict: 'pass',
      artifacts: { export: '/x/e.json', dogfoodSubmission: '/x/s.json', audit: '/x/audit' },
      dogfood: { ingested: false, reason: 'Not requested' },
      repoKnowledge: { artifactsWritten: true, submitted: false, path: '/x/audit', status: 'pass', posture: 'healthy' },
    });
    assert.match(out, /Submitted: NO/);
    assert.match(out, /rk audit import/, 'must tell the operator how to actually submit');
    assert.doesNotMatch(out, /Submitted: YES/);
  });
});

// ═══════════════════════════════════════════
// fp-p-003 — incomplete-run ingest idempotency (stable finished_at)
// ═══════════════════════════════════════════

describe('fp-p-003: buildDogfoodSubmission is dedup-stable for an INCOMPLETE run', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => db.close());

  function buildIncompleteRun() {
    // run.completed is NULL (status not complete) — the case where the pre-fix
    // code fell back to new Date() for finished_at and shifted the dedup key.
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at, completed_at)
      VALUES ('r1', 'org/r', '/tmp/r', ?, 'main', 'health-audit-a', '2026-04-11T10:00:00Z', NULL)`)
      .run('a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'collected')")
      .run();
  }

  it('finished_at is derived from a stable run column, identical across re-builds', () => {
    buildIncompleteRun();
    const exp = buildRunExport(db, 'r1');
    const verdict = computeRunVerdict(exp);

    const sub1 = buildDogfoodSubmission(exp, verdict);
    const sub2 = buildDogfoodSubmission(exp, verdict);

    // The dedup key in packages/ingest/run.js is (run_id, repo, finished_at).
    // run_id + repo are already stable; the fix makes finished_at stable too.
    assert.ok(sub1.timing?.finished_at, 'submission must carry timing.finished_at');
    assert.equal(sub1.timing.finished_at, sub2.timing.finished_at,
      're-running persist --ingest on an incomplete run must produce a stable ' +
      'finished_at so the ingest dedup probe matches (idempotent re-ingest)');
    // And it must equal the stable run column (created), not wall-clock.
    assert.equal(sub1.timing.finished_at, '2026-04-11T10:00:00Z',
      'finished_at for an incomplete run falls back to run.created, not new Date()');
  });
});

// ═══════════════════════════════════════════
// cli-r-002 — main() refactor preserves the help/usage subprocess contract
// ═══════════════════════════════════════════

describe('cli-r-002: main() extraction keeps the help + usage contract intact', () => {
  // SWARM_DB pin (task_6026249b): help/usage paths exit before touching the DB
  // today, but that ordering is not contractual (cmdHistory already opens the
  // DB before arg validation) — never let a CLI child inherit the repo default.
  // Enforced package-wide by meta-wal-sidecar-teardown-guard.test.js.
  const safeDbDir = mkdtempSync(join(tmpdir(), 'cli-r-002-safe-db-'));
  after(() => { try { rmSync(safeDbDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ } });

  function runCli(args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: join(safeDbDir, 'control-plane.db') },
    });
  }

  it('no-args prints the help banner and exits 0', () => {
    const r = runCli([]);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 0, `no-args must exit 0; got ${r.status}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /swarm — Truthful swarm control plane for repo work/);
    assert.match(r.stdout, /Phases:/);
  });

  it('an unknown command exits 1 and still prints the help banner', () => {
    const r = runCli(['definitely-not-a-command']);
    assert.equal(r.status, 1, `unknown command must exit 1; got ${r.status}`);
    assert.match(r.stdout, /Commands:/);
  });

  it('verify with no run-id exits 1 with its Usage line (guard unchanged by exit-code fix)', () => {
    const r = runCli(['verify']);
    assert.equal(r.status, 1, `verify no-args must exit 1; got ${r.status}`);
    assert.match(r.stderr, /Usage: swarm verify/);
  });

  it('persist with no run-id exits 1 with its Usage line', () => {
    const r = runCli(['persist']);
    assert.equal(r.status, 1, `persist no-args must exit 1; got ${r.status}`);
    assert.match(r.stderr, /Usage: swarm persist/);
  });
});

// ═══════════════════════════════════════════
// F-f3c729eb — `swarm status` surfaces ownership_probe_degraded
// ═══════════════════════════════════════════

describe('F-f3c729eb: `swarm status` surfaces the persisted ownership_probe_degraded signal', () => {
  // The wave-level ownership_probe_degraded column appears in the receipt but
  // not in `swarm status` — the primary at-a-glance operator surface — while
  // its lockstep sibling serial_verify_required appears in BOTH. This pins the
  // status side into symmetry: the degraded attribution must read at the same
  // surface where the operator reads gate state.
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'amendB-probe-status-'));
    dbPath = join(tempDir, 'control-plane.db');
  });
  afterEach(() => {
    if (dbPath) { try { closeDb(dbPath); } catch { /* */ } }
    if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ } }
  });

  function seedWave(degraded) {
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tempDir, 'a'.repeat(40));
    db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, ownership_probe_degraded)
      VALUES ('r1', 'health-amend-b', 1, 'collected', ?)
    `).run(degraded);
    closeDb(dbPath);
  }

  it('a degraded wave sets waves.current.ownershipProbeDegraded AND renders the breadcrumb', () => {
    seedWave(1);
    const s = status({ runId: 'r1', dbPath });
    assert.equal(s.waves.current.ownershipProbeDegraded, true,
      'pre-fix: status() read serial_verify_required but omitted ownership_probe_degraded');
    const out = formatStatus(s);
    assert.match(out, /ownership probe DEGRADED/,
      'the degraded attribution must read at the status surface, not only in the receipt');
    assert.match(out, /--isolate/,
      'the breadcrumb must name the remediation (mirrors the receipt wording)');
  });

  it('an isolated (non-degraded) wave leaves the flag false and renders NO breadcrumb', () => {
    seedWave(0);
    const s = status({ runId: 'r1', dbPath });
    assert.equal(s.waves.current.ownershipProbeDegraded, false,
      'the default-quiet state must stay false');
    const out = formatStatus(s);
    assert.doesNotMatch(out, /ownership probe DEGRADED/,
      'steady-state status output must not gain a per-wave line when attribution is full');
  });
});

// ═══════════════════════════════════════════
// F-1c0188c9 — `swarm advance` distinguishes override-refused from plain-blocked
// ═══════════════════════════════════════════

describe('F-1c0188c9: advance() marks an override refused by a non-overridable gate', () => {
  // When `--override --reason` is refused because a non-overridable gate
  // dominates (serial-verify VERIFY, or a BLOCK from gates 1/2), advance() fell
  // through to the plain non-promoted return with NO field distinguishing
  // "blocked, no override attempted" from "blocked, override refused". The
  // operator who explicitly consented saw an identical BLOCKED with no
  // acknowledgement. This pins an explicit overrideRefused marker + the
  // refusedBy gate name(s). Observability-only — the promotion decision is
  // unchanged.
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  function seedSerialVerifyWave(runId) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status, serial_verify_required) VALUES (?, 'health-amend-a', 1, 'collected', 1)"
    ).run(runId);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(Number(wave.lastInsertRowid), dom.id);
  }

  it('override refused by a non-overridable gate returns overrideRefused + refusedBy', () => {
    seedSerialVerifyWave('r-refused');
    const result = advance(db, 'r-refused', {
      override: true,
      overrideReason: 'operator consented to advance',
    });
    assert.equal(result.promoted, false);
    assert.equal(result.verdict, 'VERIFY');
    assert.equal(result.overrideRefused, true,
      'pre-fix: no field distinguished a refused override from a plain block');
    assert.ok(Array.isArray(result.refusedBy) && result.refusedBy.includes('verification'),
      'refusedBy must name the non-overridable gate that outranked the override');
  });

  it('a plain block with NO override attempted carries no overrideRefused marker', () => {
    seedSerialVerifyWave('r-plain');
    const result = advance(db, 'r-plain'); // no override
    assert.equal(result.promoted, false);
    assert.equal(result.verdict, 'VERIFY');
    assert.ok(!result.overrideRefused,
      'the marker must be absent/false when the operator never passed --override');
  });
});
