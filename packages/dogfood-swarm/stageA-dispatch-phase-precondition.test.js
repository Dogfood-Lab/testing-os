/**
 * stageA-dispatch-phase-precondition.test.js
 *
 * Stage A amend — d5-swarm-cli-001 (HIGH).
 *
 * `swarm dispatch <run> <phase>` never validated `phase` against the known
 * phase set before mutating the control plane. The wave-build transaction
 * (buildWave) INSERTs the waves row at status='dispatched', INSERTs
 * agent_runs, and flips runs.status to the phase string — and COMMITS —
 * before the phase is ever checked. The only phase rejection happened later,
 * OUTSIDE the transaction, in the prompt-render loop where templates.js
 * throws `Unknown audit phase`. So a one-char phase typo left the DB with a
 * phantom dispatched wave + dispatched agent_run + bad runs.status — exactly
 * the "DB row that promises agents which never got their prompts" state the
 * dispatch.js header explicitly promises NEVER to create.
 *
 * The fix adds a phase-validation precondition at the TOP of dispatch()
 * (alongside the run-not-found / domains-not-frozen / no-domains guards,
 * BEFORE buildWave()). An invalid phase now throws a structured
 * DispatchPreconditionError with code DISPATCH_INVALID_PHASE and a hint
 * listing valid phases — and leaves the control-plane DB completely
 * unmutated.
 *
 * Test invariants (MUTATE-and-assert-the-gate-fires discipline):
 *   1. An invalid phase throws DispatchPreconditionError with code
 *      DISPATCH_INVALID_PHASE BEFORE any DB write.
 *   2. The control-plane DB is byte-for-byte UNMUTATED: no waves row, no
 *      agent_runs row, runs.status unchanged from its pre-dispatch value.
 *   3. A valid phase (audit AND amend) is still accepted (guard does not
 *      over-reject).
 *   4. CLI seam: `swarm dispatch r1 helth-audit-a` exits non-zero, prints
 *      the structured `ERROR [DISPATCH_INVALID_PHASE]` envelope (NOT the flat
 *      `ERROR:` form), and leaves the DB unmutated.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

const RUN_ID = 'test-d5-cli-001-phase';

function setupRun(dbPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  saveDomainDraft(db, RUN_ID, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);
  closeDb(dbPath);
}

describe('d5-swarm-cli-001 — dispatch validates phase BEFORE mutating the control plane', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'd5-cli-001-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    // WAL-mode handles are pooled by path; close before rmSync or Windows
    // EBUSY's the still-open control-plane.db file. F-60942f46: closeDb only
    // ever releases THIS process's own pooled connection — it cannot release
    // the just-exited CLI-seam subprocess's (below) OS-level lock on the
    // -wal/-shm sidecar files, so rmSync itself must also be Windows-tolerant
    // (matches the sibling idiom F-8ad2d58d established package-wide this
    // wave: redrive.test.js, rewind.test.js, verify-json-purity.test.js,
    // w3-trends-and-json-output.test.js, gate-verbs-json.test.js,
    // amend2-d3b-004-cli-globs.test.js, meta-amendB-operator-output.test.js,
    // cli-smoke.test.js).
    closeDb(dbPath);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('an invalid phase throws DISPATCH_INVALID_PHASE before any DB write', () => {
    let threw = null;
    try {
      dispatch({
        runId: RUN_ID,
        phase: 'helth-audit-a', // one-char typo
        dbPath,
        outputDir: tmpDir,
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'dispatch must throw on an invalid phase');
    assert.equal(threw.code, 'DISPATCH_INVALID_PHASE',
      'invalid phase must be a structured DispatchPreconditionError, not a flat untyped Error');
    assert.match(threw.message, /Unknown phase/);
    // The hint enumerates the valid phases so the operator can correct the typo.
    assert.ok(threw.hint && /health-audit-a/.test(threw.hint),
      'hint must list the valid phases');
  });

  it('the control-plane DB is UNMUTATED after an invalid-phase dispatch (no waves, no agent_runs, runs.status unchanged)', () => {
    const db = openDb(dbPath);
    const statusBefore = db.prepare('SELECT status FROM runs WHERE id = ?').get(RUN_ID).status;
    assert.equal(statusBefore, 'pending', 'baseline runs.status (set at setup, freezeDomains does not touch it)');
    closeDb(dbPath);

    try {
      dispatch({ runId: RUN_ID, phase: 'helth-audit-a', dbPath, outputDir: tmpDir });
      assert.fail('dispatch should have thrown');
    } catch (e) {
      assert.equal(e.code, 'DISPATCH_INVALID_PHASE');
    }

    const after = openDb(dbPath);
    const waves = after.prepare('SELECT * FROM waves WHERE run_id = ?').all(RUN_ID);
    assert.equal(waves.length, 0,
      'd5-cli-001 regression: invalid-phase dispatch left a phantom waves row');
    const agents = after.prepare('SELECT * FROM agent_runs').all();
    assert.equal(agents.length, 0,
      'd5-cli-001 regression: invalid-phase dispatch left a phantom agent_run');
    const events = after.prepare('SELECT * FROM agent_state_events').all();
    assert.equal(events.length, 0,
      'd5-cli-001 regression: invalid-phase dispatch emitted agent_state_events');
    const statusAfter = after.prepare('SELECT status FROM runs WHERE id = ?').get(RUN_ID).status;
    assert.equal(statusAfter, statusBefore,
      'd5-cli-001 regression: invalid-phase dispatch flipped runs.status to the typo phase');
    closeDb(dbPath);
  });

  it('a valid AUDIT phase is still accepted (guard does not over-reject)', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 2, 'valid audit phase dispatches normally');
  });

  it('a valid AMEND phase is still accepted (guard does not over-reject)', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 2, 'valid amend phase dispatches normally');
  });

  it('CLI seam: `swarm dispatch r1 <typo-phase>` exits non-zero, prints the structured envelope, leaves DB unmutated', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'dispatch', RUN_ID, 'helth-audit-a'], {
      encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
    });
    assert.notEqual(r.status, 0, 'a typo\'d phase must NOT exit 0');
    // Structured DISPATCH_* envelope, NOT the flat `ERROR: Unknown audit phase` form.
    assert.match(r.stderr, /ERROR \[DISPATCH_INVALID_PHASE\]/,
      'invalid phase must surface the structured envelope (sibling preconditions get it)');
    assert.match(r.stderr, /Next:/, 'the structured envelope must carry an actionable hint');

    const db = openDb(dbPath);
    const waves = db.prepare('SELECT * FROM waves WHERE run_id = ?').all(RUN_ID);
    assert.equal(waves.length, 0, 'CLI seam: invalid-phase dispatch left a phantom waves row');
    const agents = db.prepare('SELECT * FROM agent_runs').all();
    assert.equal(agents.length, 0, 'CLI seam: invalid-phase dispatch left a phantom agent_run');
    closeDb(dbPath);
  });
});

describe('F-3c8a62f1 — dispatch refuses when there are zero AGENT domains (no agent to run)', () => {
  // dispatch.js's `domains.length === 0` precondition (line 226) reads the
  // RAW getDomains() list, but the agent-dispatch loop (line 470-472) skips
  // `ownership_class === 'shared'` domains ("shared is a zone, not an
  // agent"). Two frozen `shared` domains therefore pass the raw guard
  // (length 2) and dispatch() proceeds: it commits a `waves` row at
  // status='dispatched', then returns `{ agents: [] }` — a silent no-op
  // that reports success and wedges the run (the NEXT dispatch throws
  // DISPATCH_WAVE_IN_FLIGHT because a 'dispatched' wave already exists,
  // and there is no agent output anyone can collect to get out of it).
  //
  // Per coordinator ruling: the production fix lives in commands/dispatch.js
  // (swarm-cp-verbs' domain, assigned to verbs THIS wave) and must throw a
  // NEW code, DISPATCH_NO_AGENT_DOMAINS — distinct from DISPATCH_NO_DOMAINS,
  // which verbs is keeping for the genuinely-empty-domain-map case (0
  // domains at all, checked above at line 226 today). Two different causes,
  // two different codes; this test pins the new one, not the old one.
  //
  // Both halves of the invariant are pinned so this cannot become a
  // half-guard that passes identically whether the fix landed or not: (a)
  // all-shared refuses and commits nothing; (b) a normal MIXED owned+shared
  // map still dispatches the owned domain and exits fine (the guard must
  // key off "zero agent domains", not "any shared domain present").
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'f-3c8a62f1-'));
    dbPath = join(tmpDir, 'control-plane.db');
  });

  afterEach(() => {
    // F-60942f46: neither it() in this block spawns the CLI today (both (a)
    // and (b) exercise dispatch() in-process), so this describe block is not
    // currently exposed to the WAL-sidecar teardown race guarded above —
    // but guarding it too removes the stylistic inconsistency and protects
    // against a future test being added here that spawns the CLI.
    closeDb(dbPath);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('(a) all-`shared` domain map refuses with DISPATCH_NO_AGENT_DOMAINS and commits no wave', () => {
    const ALL_SHARED_RUN_ID = 'test-f-3c8a62f1-all-shared';
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(ALL_SHARED_RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
    saveDomainDraft(db, ALL_SHARED_RUN_ID, [
      { name: 'shared-a', globs: ['*.json'], ownership_class: 'shared' },
      { name: 'shared-b', globs: ['*.yaml'], ownership_class: 'shared' },
    ]);
    freezeDomains(db, ALL_SHARED_RUN_ID);
    closeDb(dbPath);

    let threw = null;
    try {
      dispatch({
        runId: ALL_SHARED_RUN_ID,
        phase: 'health-audit-a',
        dbPath,
        outputDir: tmpDir,
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw,
      'dispatch must refuse when every frozen domain is `shared` — there is no agent for anyone to run, ' +
      'and the current { agents: [] } silent-success shape wedges the run on the NEXT dispatch call');
    assert.equal(threw.code, 'DISPATCH_NO_AGENT_DOMAINS',
      'refusal must be the NEW structured code (distinct from DISPATCH_NO_DOMAINS, which stays reserved ' +
      'for a genuinely empty domain map) — matching the sibling DISPATCH_INVALID_PHASE shape, not a flat Error');

    const after = openDb(dbPath);
    const waves = after.prepare('SELECT * FROM waves WHERE run_id = ?').all(ALL_SHARED_RUN_ID);
    assert.equal(waves.length, 0,
      'F-3c8a62f1 regression: an all-shared dispatch left a phantom waves row (mirrors the phantom-agent_run assertion above)');
    const agents = after.prepare('SELECT * FROM agent_runs').all();
    assert.equal(agents.length, 0,
      'F-3c8a62f1 regression: an all-shared dispatch left a phantom agent_run');
    closeDb(dbPath);
  });

  it('(b) a normal MIXED owned+shared domain map still dispatches the owned domain and exits fine', () => {
    // The other half of the invariant: the guard must key off the
    // POST-FILTER agent count being zero, not off "any shared domain is
    // present" — a repo with one real (owned) domain and one shared zone
    // (globs/**/*.json etc.) is the common shape, not the edge case, and
    // must keep working exactly as before.
    const MIXED_RUN_ID = 'test-f-3c8a62f1-mixed';
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(MIXED_RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
    saveDomainDraft(db, MIXED_RUN_ID, [
      { name: 'backend', globs: ['packages/**'], ownership_class: 'owned' },
      { name: 'shared-config', globs: ['*.json'], ownership_class: 'shared' },
    ]);
    freezeDomains(db, MIXED_RUN_ID);
    closeDb(dbPath);

    const result = dispatch({
      runId: MIXED_RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 1,
      'the one owned domain must still dispatch — a fix for the all-shared case must not over-reject a mixed map');
    assert.equal(result.agents[0].domain, 'backend');

    const after = openDb(dbPath);
    const waves = after.prepare('SELECT * FROM waves WHERE run_id = ?').all(MIXED_RUN_ID);
    assert.equal(waves.length, 1, 'a normal mixed-domain dispatch commits its wave as usual');
    closeDb(dbPath);
  });
});
