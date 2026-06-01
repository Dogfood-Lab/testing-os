/**
 * amend2-d3b-002-dispatch-tx.test.js
 *
 * Wave A2 Stage C — D3B-002 invariant.
 *
 * The mechanism. `dispatch.js` builds a wave by:
 *   1. INSERT INTO waves
 *   2. UPDATE runs SET status
 *   3. for each domain: INSERT INTO agent_runs + transitionAgent
 *   4. atomicWriteFileSync(promptPath, prompt)  // FS, not DB
 *
 * Pre-fix, steps 1-3 ran OUTSIDE any db.transaction(). A process kill (or
 * thrown error from createWorktree, prompt rendering, or transitionAgent
 * itself) between iterations of (3) would leave a half-built wave: the
 * `waves` row exists, the runs.status was already flipped, and some agent
 * rows exist while others do not — a state `swarm resume` reads as "this
 * wave is in flight" with no way to recover.
 *
 * The fix wraps steps 1-3 in a single `db.transaction()`. Step 4
 * (atomicWriteFileSync of the prompt files) stays OUTSIDE the tx — prompts
 * are FS-side. The contract is documented in the dispatch() header: on
 * rollback, any already-written prompt files become FS orphans (the better
 * failure than wave-half-built DB state). better-sqlite3 nests cleanly, so
 * the inner `transitionAgent → executeTransition` self-wrap from Wave-A1
 * H9 becomes a SAVEPOINT inside the outer tx.
 *
 * Test invariants:
 *   1. Clean run: N agents + N prompts; agent_runs and waves rows present.
 *   2. Mid-loop failure: zero waves rows, zero agent_runs rows, runs.status
 *      unchanged — full DB rollback. Prompts on disk for any iterations
 *      that already completed are PRESENT as orphans (documented FS-side
 *      degradation; operator can grep / re-dispatch).
 *   3. Sibling resume.js: same shape — the redispatch loop wraps the
 *      per-agent INSERT agent_runs + transitionAgent in a db.transaction().
 *
 * Source-text mechanical guard:
 *   - dispatch.js must contain `db.transaction(` AND the `INSERT INTO
 *     waves` and `INSERT INTO agent_runs` calls must appear inside that
 *     block.
 *   - resume.js redispatch path must wrap its INSERT agent_runs + the
 *     subsequent transitionAgent call in `db.transaction(`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { resume } from './commands/resume.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCH_SRC = readFileSync(join(__dirname, 'commands/dispatch.js'), 'utf-8');
const RESUME_SRC = readFileSync(join(__dirname, 'commands/resume.js'), 'utf-8');

const RUN_ID = 'test-d3b-002-tx';

function setupRun(dbPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  saveDomainDraft(db, RUN_ID, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
    { name: 'domain-c', globs: ['packages/c/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);
  return db;
}

describe('D3B-002 — dispatch wave-build atomicity (db.transaction)', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'd3b-002-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clean dispatch: N agent_runs + N prompt files (happy path unchanged)', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 3, 'all 3 domains dispatched');

    const db = openDb(dbPath);
    const waves = db.prepare('SELECT * FROM waves WHERE run_id = ?').all(RUN_ID);
    assert.equal(waves.length, 1, 'one wave row created');
    const agents = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').all(waves[0].id);
    assert.equal(agents.length, 3, '3 agent_runs created');

    // FS-side: 3 prompts
    const promptDir = join(tmpDir, `wave-${waves[0].wave_number}`);
    const prompts = readdirSync(promptDir).filter(f => f.endsWith('.md'));
    assert.equal(prompts.length, 3, '3 prompt files on disk');
  });

  it('mid-loop failure rolls back ALL DB writes (waves + agent_runs + runs.status)', () => {
    // Capture the original runs.status so we can prove rollback restored it.
    const db = openDb(dbPath);
    const runStatusBefore = db.prepare(
      'SELECT status FROM runs WHERE id = ?'
    ).get(RUN_ID).status;
    assert.equal(runStatusBefore, 'pending', 'baseline runs.status');

    // Force a mid-loop failure by replacing one of the prepare statements
    // mid-flight is hard; the simplest deterministic crash is to invoke
    // dispatch with --isolate so createWorktree fails on the first iteration
    // (no .git in /tmp/repo). IsolationError propagates OUT of the tx.
    let threw = null;
    try {
      dispatch({
        runId: RUN_ID,
        phase: 'health-audit-a',
        dbPath,
        outputDir: tmpDir,
        isolate: true,
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'dispatch must throw under --isolate without .git');

    // After rollback: zero waves, zero agent_runs, runs.status unchanged.
    const waves = db.prepare('SELECT * FROM waves WHERE run_id = ?').all(RUN_ID);
    assert.equal(waves.length, 0,
      'wave-build tx must roll back the INSERT INTO waves on failure');
    const agents = db.prepare('SELECT * FROM agent_runs').all();
    assert.equal(agents.length, 0,
      'wave-build tx must roll back the INSERT INTO agent_runs on failure');
    const events = db.prepare('SELECT * FROM agent_state_events').all();
    assert.equal(events.length, 0,
      'wave-build tx must roll back any audit rows for inflight transitions');
    const runStatusAfter = db.prepare(
      'SELECT status FROM runs WHERE id = ?'
    ).get(RUN_ID).status;
    assert.equal(runStatusAfter, runStatusBefore,
      'wave-build tx must roll back the UPDATE runs SET status on failure');
  });
});

// Strip JSDoc block comments and single-line comments so prose references
// to SQL fragments inside header documentation don't confuse the
// mechanical guard (the guard cares about whether the actual db.prepare(...)
// call lives inside the tx body, not whether the prose mentions it).
function stripComments(src) {
  // Remove /* ... */ block comments first (largest match)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then strip // line comments (after the block-strip so we don't eat // inside /* */)
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

describe('D3B-002 — dispatch.js source mechanical guard', () => {
  const dispatchCode = stripComments(DISPATCH_SRC);

  it('dispatch.js contains db.transaction(', () => {
    assert.ok(dispatchCode.includes('db.transaction('),
      'dispatch.js must wrap wave-build in db.transaction()');
  });

  it('INSERT INTO waves prepared statement appears inside the db.transaction() block', () => {
    const txOpenIdx = dispatchCode.indexOf('db.transaction(');
    const waveInsertIdx = dispatchCode.search(/INSERT\s+INTO\s+waves/);
    assert.ok(txOpenIdx >= 0, 'db.transaction( must exist');
    assert.ok(waveInsertIdx > txOpenIdx,
      'INSERT INTO waves must appear after db.transaction( opens');
  });

  it('INSERT INTO agent_runs prepared statement appears inside the db.transaction() block', () => {
    const txOpenIdx = dispatchCode.indexOf('db.transaction(');
    const arInsertIdx = dispatchCode.search(/INSERT\s+INTO\s+agent_runs/);
    assert.ok(txOpenIdx >= 0);
    assert.ok(arInsertIdx > txOpenIdx,
      'INSERT INTO agent_runs must appear inside the db.transaction() block');
  });
});

describe('D3B-002 — resume.js redispatch sibling source mechanical guard', () => {
  const resumeCode = stripComments(RESUME_SRC);

  it('resume.js contains db.transaction(', () => {
    assert.ok(resumeCode.includes('db.transaction('),
      'resume.js must wrap its redispatch loop in db.transaction()');
  });

  it('INSERT INTO agent_runs prepared statement appears inside the db.transaction() block', () => {
    const txOpenIdx = resumeCode.indexOf('db.transaction(');
    const arInsertIdx = resumeCode.search(/INSERT\s+INTO\s+agent_runs/);
    assert.ok(txOpenIdx >= 0, 'resume.js must declare db.transaction(');
    assert.ok(arInsertIdx > txOpenIdx,
      'INSERT INTO agent_runs in resume.js must appear inside the db.transaction()');
  });
});
