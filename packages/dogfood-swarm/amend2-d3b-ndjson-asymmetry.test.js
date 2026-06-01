/**
 * amend2-d3b-ndjson-asymmetry.test.js
 *
 * Wave A2 Stage C — NDJSON-asymmetry cluster: D3B-011, D3B-012, D3B-016,
 * D3B-021, D3B-003.
 *
 * The kickoff verdict: failure / skip / transition events were unstructured
 * `console.warn` / `console.error` or bare throws, NOT structured
 * `logStage` events. Operators tailing NDJSON stderr couldn't distinguish
 * "this stage succeeded silently" from "this stage failed silently" from
 * "this skipped on a defensive guard." This cluster makes every load-
 * bearing transition / skip / failure / success path emit a structured,
 * coded, greppable event.
 *
 * Per-finding invariants:
 *   D3B-011 (collect.js tryTransition)
 *     - "agent_run not found" + "state-machine rejected" + "transitionAgent
 *       threw" all emit logStage('warn', { stage:'transition_skipped', ...,
 *       reason:<kind> }) instead of console.warn.
 *
 *   D3B-012 (state-machine.js applyTimeoutPolicy defensive NULL guard)
 *     - The "started_at IS NULL but status is in-flight" branch emits
 *       logStage('warn', { stage:'timeout_skip_null_started_at', ... })
 *       instead of console.warn.
 *
 *   D3B-016 (dispatch.js success path)
 *     - Post-build emits logStage('info', { stage:'wave_dispatched',
 *       waveId, waveNumber, phase, agentCount, ... }).
 *
 *   D3B-021 (log-stage.js itself)
 *     - JSON.stringify(line) inside logStage is wrapped in try/catch.
 *     - On serialization failure (BigInt, circular refs), logStage emits a
 *       safe structured fallback ('{ stage: "log_stage_serialization_failed",
 *       ... }') instead of throwing.
 *     - The logger itself never crashes.
 *
 *   D3B-003 (dispatch.js precondition throws)
 *     - "Run not found", "Domains are not frozen", "No domains defined"
 *       each get a stable code (DISPATCH_RUN_NOT_FOUND etc.) and emit a
 *       logStage('error', { stage:'dispatch_precondition_failed', code,
 *       message }) BEFORE the throw.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, openMemoryDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { applyTimeoutPolicy } from './lib/state-machine.js';
import { logStage } from './lib/log-stage.js';

/**
 * Capture every line written to console.error during a function call, then
 * restore. Each call to console.error contributes one capture entry.
 */
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

/**
 * Return only NDJSON lines (lines that JSON.parse cleanly into an object
 * with a `stage` key — the logStage contract). Filters out the
 * human-readable companion banner emitted under TTY mode.
 */
function ndjsonLines(lines) {
  const out = [];
  for (const ln of lines) {
    if (!ln.startsWith('{')) continue;
    try {
      const obj = JSON.parse(ln);
      if (obj && typeof obj === 'object' && obj.stage) out.push(obj);
    } catch { /* not NDJSON */ }
  }
  return out;
}

const RUN_ID = 'test-ndjson';

function setupRun(dbPath, domains = [
  { name: 'd1', globs: ['packages/d1/**'], ownership_class: 'owned' },
]) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  saveDomainDraft(db, RUN_ID, domains);
  freezeDomains(db, RUN_ID);
}

// ────────────────────────────────────────────────────────────────────────
// D3B-021 — logStage hardening (circular / BigInt safety)
// ────────────────────────────────────────────────────────────────────────

describe('D3B-021 — logStage tolerates non-serializable inputs', () => {
  it('does not throw on a circular reference field', () => {
    // Pre-fix: JSON.stringify(line) throws TypeError on circular structure
    // and the logger crashes the entire stage transition.
    const circular = {};
    circular.self = circular;

    const lines = captureStderr(() => {
      logStage('test_circular', { circular });
    });
    // The logger must not crash; we must observe at least ONE structured
    // line emitted — either the normal payload (if a future fix replaces
    // circulars with a placeholder) or the fallback.
    const ndjson = ndjsonLines(lines);
    assert.ok(ndjson.length >= 1,
      'logStage must emit at least one NDJSON line even when JSON.stringify would have thrown');
  });

  it('emits a structured fallback event when JSON.stringify fails', () => {
    const circular = {};
    circular.self = circular;
    const lines = captureStderr(() => {
      logStage('original_stage', { circular });
    });
    const ndjson = ndjsonLines(lines);
    const fallbacks = ndjson.filter(o =>
      o.stage === 'log_stage_serialization_failed'
      || o.kind === 'log_stage_serialization_failed'
    );
    assert.ok(fallbacks.length >= 1,
      'logStage must emit a structured fallback {stage|kind: log_stage_serialization_failed} on JSON.stringify failure');
    // Fallback line itself must be valid JSON (the entire point of the
    // fallback is to never produce an unparseable line on stderr).
    assert.equal(typeof fallbacks[0], 'object');
  });

  it('handles a BigInt field without crashing', () => {
    // JSON.stringify throws TypeError on BigInt without a replacer.
    const fields = { big: 9007199254740993n };
    const lines = captureStderr(() => {
      logStage('test_bigint', fields);
    });
    const ndjson = ndjsonLines(lines);
    assert.ok(ndjson.length >= 1,
      'logStage must emit at least one NDJSON line on a BigInt field');
  });
});

// ────────────────────────────────────────────────────────────────────────
// D3B-016 — dispatch success path emits wave_dispatched
// ────────────────────────────────────────────────────────────────────────

describe('D3B-016 — dispatch emits a wave_dispatched success event', () => {
  let tmpDir;
  let dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'd3b-016-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath, [
      { name: 'd1', globs: ['packages/d1/**'], ownership_class: 'owned' },
      { name: 'd2', globs: ['packages/d2/**'], ownership_class: 'owned' },
    ]);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits stage=wave_dispatched with correlation_id + run/wave/agent metadata on success', () => {
    const lines = captureStderr(() => {
      dispatch({
        runId: RUN_ID,
        phase: 'health-audit-a',
        dbPath,
        outputDir: tmpDir,
      });
    });
    const ndjson = ndjsonLines(lines);
    const success = ndjson.filter(o => o.stage === 'wave_dispatched');
    assert.ok(success.length >= 1,
      'dispatch success must emit at least one stage=wave_dispatched NDJSON event');
    const evt = success[0];
    assert.equal(evt.runId, RUN_ID);
    assert.equal(evt.phase, 'health-audit-a');
    assert.equal(evt.agentCount, 2);
    assert.ok(evt.waveId, 'wave_dispatched must carry waveId');
    assert.ok(evt.correlation_id && evt.correlation_id.startsWith('coord-'),
      'wave_dispatched must carry a correlation_id with the coord- prefix');
  });
});

// ────────────────────────────────────────────────────────────────────────
// D3B-003 — dispatch precondition throws get codes + logStage
// ────────────────────────────────────────────────────────────────────────

describe('D3B-003 — dispatch precondition failures emit structured coded events', () => {
  let tmpDir;
  let dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'd3b-003-'));
    dbPath = join(tmpDir, 'control-plane.db');
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Run not found emits stage=dispatch_precondition_failed code=DISPATCH_RUN_NOT_FOUND, then throws with the code', () => {
    let threw = null;
    const lines = captureStderr(() => {
      try {
        dispatch({
          runId: 'nonexistent-run-id',
          phase: 'health-audit-a',
          dbPath,
          outputDir: tmpDir,
        });
      } catch (e) {
        threw = e;
      }
    });
    assert.ok(threw, 'dispatch must throw when run does not exist');
    assert.equal(threw.code, 'DISPATCH_RUN_NOT_FOUND',
      'precondition throw must carry stable code DISPATCH_RUN_NOT_FOUND');
    const ndjson = ndjsonLines(lines);
    const precond = ndjson.filter(o => o.stage === 'dispatch_precondition_failed');
    assert.ok(precond.length >= 1,
      'must emit at least one stage=dispatch_precondition_failed NDJSON event before throwing');
    assert.equal(precond[0].code, 'DISPATCH_RUN_NOT_FOUND');
  });

  it('Domains are not frozen emits code=DISPATCH_DOMAINS_NOT_FROZEN before throwing', () => {
    // Set up a run with DRAFT domains (not frozen).
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'd1', globs: ['packages/d1/**'], ownership_class: 'owned' },
    ]);
    // intentionally NOT calling freezeDomains

    let threw = null;
    const lines = captureStderr(() => {
      try {
        dispatch({
          runId: RUN_ID,
          phase: 'health-audit-a',
          dbPath,
          outputDir: tmpDir,
          // autoFreeze omitted -> must throw
        });
      } catch (e) {
        threw = e;
      }
    });
    assert.ok(threw, 'dispatch must throw when domains are not frozen');
    assert.equal(threw.code, 'DISPATCH_DOMAINS_NOT_FROZEN',
      'precondition throw must carry stable code DISPATCH_DOMAINS_NOT_FROZEN');
    const ndjson = ndjsonLines(lines);
    const precond = ndjson.filter(o =>
      o.stage === 'dispatch_precondition_failed' && o.code === 'DISPATCH_DOMAINS_NOT_FROZEN'
    );
    assert.ok(precond.length >= 1,
      'must emit dispatch_precondition_failed with code=DISPATCH_DOMAINS_NOT_FROZEN');
  });
});

// ────────────────────────────────────────────────────────────────────────
// D3B-012 — applyTimeoutPolicy NULL started_at silent skip → logStage
// ────────────────────────────────────────────────────────────────────────

describe('D3B-012 — applyTimeoutPolicy NULL started_at emits structured warn', () => {
  it('emits stage=timeout_skip_null_started_at when an in-flight agent has NULL started_at', () => {
    const db = openMemoryDb();
    try {
      db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status)
        VALUES ('r1', 'org/x', '/tmp/x', ?, 'health-audit-a')`).run('a'.repeat(40));
      saveDomainDraft(db, 'r1', [
        { name: 'dx', globs: ['**'], ownership_class: 'owned' },
      ]);
      freezeDomains(db, 'r1');
      db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status)
        VALUES ('r1', 'health-audit-a', 1, 'dispatched')`).run();
      const dom = db.prepare("SELECT * FROM domains WHERE run_id = 'r1' LIMIT 1").get();
      const arRow = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status)
        VALUES (1, ?, 'dispatched')`).run(dom.id);
      // Force the invariant-broken state: started_at NULL even though status=dispatched.
      // (Cannot use transitionAgent — that writes started_at via executeTransition.)
      const agentId = Number(arRow.lastInsertRowid);
      db.prepare('UPDATE agent_runs SET started_at = NULL WHERE id = ?').run(agentId);

      const lines = captureStderr(() => {
        applyTimeoutPolicy(db, 1, 60000, Date.parse('2026-06-01'));
      });
      const ndjson = ndjsonLines(lines);
      const nullSkip = ndjson.filter(o => o.stage === 'timeout_skip_null_started_at');
      assert.ok(nullSkip.length >= 1,
        'applyTimeoutPolicy must emit a structured stage=timeout_skip_null_started_at NDJSON event when started_at is NULL');
      assert.equal(nullSkip[0].agent_run_id || nullSkip[0].agentRunId, agentId);
    } finally {
      db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// D3B-011 — collect.js tryTransition emits structured warn (not console)
// ────────────────────────────────────────────────────────────────────────

describe('D3B-011 — collect.js tryTransition emits structured logStage events', () => {
  let tmpDir;
  let dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'd3b-011-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits stage=transition_skipped when collect tries to flip a complete agent_run (state-machine rejection path)', () => {
    // Dispatch a wave, then mark the agent as 'complete' directly, then run
    // collect — the tryTransition('failed') call on the now-complete row
    // hits the state-machine rejection path which (pre-fix) console.warn'd.
    // Actually: easier — just run collect with no output file; tryTransition
    // is invoked with 'failed' on a 'dispatched' agent. To trigger the
    // rejection path, we'd need the agent to already be in a terminal state.
    // Use the "agent_run not found" branch by passing a fake agentRunId
    // path — but collect reads agent_runs itself. The simplest trigger: run
    // collect without an output path so tryTransition('failed') fires; the
    // transition succeeds. Then run collect AGAIN — second time the row is
    // already 'failed', which means tryTransition('failed') hits the
    // ar.status === to short-circuit. That's the "already in target state"
    // path. To hit the REJECTION path, we set the row to 'complete' (which
    // is terminal) and call tryTransition('failed') indirectly.

    dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });
    const db = openDb(dbPath);
    const ar = db.prepare("SELECT id FROM agent_runs LIMIT 1").get();
    // Force agent into the terminal `complete` state directly so collect's
    // tryTransition('failed', ...) hits the state-machine rejection path.
    db.prepare("UPDATE agent_runs SET status = 'complete' WHERE id = ?").run(ar.id);

    // Now run collect without an output file. Pre-fix this would
    // console.warn — post-fix it emits a structured logStage event.
    const lines = captureStderr(() => {
      try {
        collect({
          runId: RUN_ID,
          dbPath,
          outputs: {},
        });
      } catch { /* errors aside; we're verifying the warn path */ }
    });
    const ndjson = ndjsonLines(lines);
    const skips = ndjson.filter(o => o.stage === 'transition_skipped');
    assert.ok(skips.length >= 1,
      'tryTransition must emit at least one stage=transition_skipped NDJSON event when the state machine rejects');
  });
});
