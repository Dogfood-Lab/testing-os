/**
 * dispatch-state-machine.test.js — F-002109-003 regression.
 *
 * Initial dispatch must route the new agent_run through the state machine
 * (`pending` → `dispatched`) rather than INSERTing directly with
 * status='dispatched'. The direct-insert shortcut violated the
 * state-machine.js header invariant ("Every agent_run status change MUST
 * go through this module" / "Every legal transition is logged") with two
 * concrete symptoms:
 *
 *   1. `started_at` is left NULL — applyTimeoutPolicy() then computes
 *      `now - 0 > timeoutMs`, which is true for any sane timeout, so the
 *      first wave's agents are misclassified as timed out the instant
 *      resume runs (or, before F-742440-001 was fixed, never timed out at
 *      all). This is the surface symptom captured by F-002.
 *   2. No `agent_state_events` row is written for the `pending → dispatched`
 *      transition, so getTransitionHistory() is incomplete for every agent
 *      in the wave.
 *
 * The fix is to mirror commands/resume.js:116-123 — INSERT at 'pending'
 * then call transitionAgent(db, id, 'dispatched', 'initial dispatch').
 *
 * These tests must FAIL on direct-insert code and PASS on the fixed code.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { applyTimeoutPolicy, getTransitionHistory } from './lib/state-machine.js';

const RUN_ID = 'test-dispatch-sm';

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

  return db;
}

describe('dispatch — state-machine routing (F-002109-003)', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-sm-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes started_at on every freshly-dispatched agent_run', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    assert.equal(result.agents.length, 2, 'two agents dispatched');

    const db = openDb(dbPath);
    for (const a of result.agents) {
      const row = db.prepare(
        'SELECT id, status, started_at FROM agent_runs WHERE id = ?'
      ).get(a.agentRunId);

      assert.equal(row.status, 'dispatched',
        `${a.domain}: expected status=dispatched, got ${row.status}`);
      assert.notEqual(row.started_at, null,
        `${a.domain}: started_at must be populated by the state machine, not NULL`);
      assert.match(row.started_at, /^\d{4}-\d{2}-\d{2}T/,
        `${a.domain}: started_at must be ISO-8601 (state machine writes via toISOString)`);
    }
  });

  it('emits a pending → dispatched event for every freshly-dispatched agent_run', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    const db = openDb(dbPath);
    for (const a of result.agents) {
      const events = getTransitionHistory(db, a.agentRunId);

      // Exactly one transition must have been recorded: pending → dispatched.
      // Direct INSERT bypasses the state machine and writes zero events.
      assert.equal(events.length, 1,
        `${a.domain}: expected 1 state event, got ${events.length}`);
      assert.equal(events[0].from_status, 'pending',
        `${a.domain}: expected from_status=pending, got ${events[0].from_status}`);
      assert.equal(events[0].to_status, 'dispatched',
        `${a.domain}: expected to_status=dispatched, got ${events[0].to_status}`);
    }
  });

  it('lets applyTimeoutPolicy correctly handle a freshly-dispatched agent', () => {
    // Dispatch creates the wave + agents. With the fix, started_at is set.
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    const db = openDb(dbPath);
    const wave = db.prepare(
      'SELECT id FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
    ).get(RUN_ID);

    // Read the start time the state machine wrote, then fire applyTimeoutPolicy
    // exactly 1 second later with a 10-minute timeout. Nothing should time out.
    const firstAgent = db.prepare(
      'SELECT started_at FROM agent_runs WHERE id = ?'
    ).get(result.agents[0].agentRunId);
    const startMs = new Date(firstAgent.started_at).getTime();
    const nowMs = startMs + 1000;
    const timeoutMs = 10 * 60 * 1000;

    const timedOut = applyTimeoutPolicy(db, wave.id, timeoutMs, nowMs);
    assert.equal(timedOut.length, 0,
      'freshly-dispatched agents must not be classified as timed out');

    // And every agent must still be 'dispatched' (not flipped to timed_out).
    for (const a of result.agents) {
      const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(a.agentRunId);
      assert.equal(row.status, 'dispatched',
        `${a.domain}: status must remain 'dispatched' after a non-elapsing timeout check`);
    }
  });
});
