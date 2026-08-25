/**
 * liveness-probe.test.js — F-liveness-probe
 *
 * The defect: the ONLY verb that applied the timeout policy was `swarm resume`,
 * and applying it MUTATES (overdue agents transition to `timed_out`, which is
 * the first domino of a redispatch). Operators were explicitly directed to run
 * it to get a truthful liveness answer, so asking a READ-ONLY question
 * re-dispatched expensive agents as a side effect. Observed live on run
 * `swarm-1785831762-2a42`: a liveness check printed
 * `Action: redispatched — Redispatched 9 agents`.
 *
 * The fix has two halves, and the second is the load-bearing one:
 *   1. A read-only surface (`classifyTimeouts`, `swarm resume --dry-run`).
 *   2. That surface shares ONE predicate with the mutating pass. A probe that
 *      computes staleness its own way is worse than no probe — it can report
 *      "alive" for an agent `applyTimeoutPolicy` would reap, with nothing to
 *      reveal which one lied.
 *
 * Coverage per the request:
 *   (a) the read-only path makes no control-plane write
 *   (b) `resume` still redispatches when explicitly invoked
 *   (c) the status report distinguishes "running" from "timed out, not yet reaped"
 * plus the anti-drift property that makes (a) trustworthy.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from './db/connection.js';
import { classifyTimeouts, applyTimeoutPolicy } from './lib/state-machine.js';
import { status } from './commands/status.js';
import { resume } from './commands/resume.js';

const TIMEOUT_MS = 1_800_000;                     // 30 min, the shipped default
const T0 = Date.parse('2026-08-04T08:00:00.000Z');
const NOW = T0 + TIMEOUT_MS + 60_000;             // 1 min past the policy

let dir, dbPath, db;

/**
 * Build a run with one wave and N in-flight agents, each backdated by a chosen
 * age so the timeout predicate has something real to decide.
 */
function seed(agents) {
  db = openDb(dbPath);   // openDb bootstraps + migrates the schema itself
  db.prepare(`INSERT INTO runs (id, repo, status, local_path, branch, commit_sha, timeout_policy_ms)
              VALUES (?,?,?,?,?,?,?)`)
    .run('run-1', 'org/repo', 'health-audit-a', dir, 'main', 'abc1234', TIMEOUT_MS);
  db.prepare(`INSERT INTO waves (id, run_id, wave_number, phase, status)
              VALUES (?,?,?,?,?)`).run(1, 'run-1', 1, 'health-audit-a', 'dispatched');

  agents.forEach((a, i) => {
    db.prepare(`INSERT INTO domains (id, run_id, name, globs, ownership_class)
                VALUES (?,?,?,?,?)`).run(i + 1, 'run-1', a.domain, '["src/**"]', 'owned');
    db.prepare(`INSERT INTO agent_runs (id, wave_id, domain_id, status, started_at)
                VALUES (?,?,?,?,?)`)
      .run(i + 1, 1, i + 1, a.status ?? 'dispatched',
           a.startedAt === null ? null : new Date(a.startedAt ?? T0).toISOString());
  });
  return db;
}

/** Everything the control plane could record. A read-only path must move none of it. */
function controlPlaneSnapshot(d) {
  const count = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return {
    agent_runs: count('agent_runs'),
    agent_state_events: count('agent_state_events'),
    wave_state_events: count('wave_state_events'),
    waves: count('waves'),
    statuses: d.prepare('SELECT id, status, started_at FROM agent_runs ORDER BY id').all(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'liveness-'));
  dbPath = join(dir, 'control-plane.db');
});

afterEach(() => {
  try { db?.close(); } catch { /* already closed */ }
  // Windows-only cleanup hazard, deliberately tolerated rather than asserted on:
  // `status()` and `resume()` each call openDb() and never close the handle (fine
  // for a CLI that exits, a leaked handle in-process). NTFS then refuses the
  // unlink with EBUSY. That is a cleanup concern, not a behaviour under test —
  // failing the suite on it would make these tests report a defect they do not
  // actually cover. The temp dir is OS-reclaimed either way.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY on win32 */ }
});

describe('F-liveness-probe — (a) the read-only path makes no control-plane write', () => {
  it('classifyTimeouts writes nothing, even with agents well past the policy', () => {
    const d = seed([
      { domain: 'schema', startedAt: T0 },                       // overdue
      { domain: 'editor', startedAt: NOW - 60_000 },             // fresh
    ]);
    const before = controlPlaneSnapshot(d);

    const c = classifyTimeouts(d, 1, TIMEOUT_MS, NOW);
    assert.equal((c.timedOut).length, 1);
    assert.equal((c.stillRunning).length, 1);

    assert.deepEqual(controlPlaneSnapshot(d), before);
  });

  it('classifyTimeouts is idempotent — 50 calls still write nothing', () => {
    const d = seed([{ domain: 'schema', startedAt: T0 }]);
    const before = controlPlaneSnapshot(d);
    for (let i = 0; i < 50; i++) classifyTimeouts(d, 1, TIMEOUT_MS, NOW);
    assert.deepEqual(controlPlaneSnapshot(d), before);
  });

  it('resume({ dryRun: true }) writes nothing and does not reap the overdue agent', () => {
    const d = seed([
      { domain: 'schema', startedAt: T0 },                       // overdue
      { domain: 'editor', startedAt: NOW - 60_000 },             // fresh
    ]);
    const before = controlPlaneSnapshot(d);
    d.close();

    const r = resume({ runId: 'run-1', dbPath, outputDir: dir, nowMs: NOW, dryRun: true });

    assert.equal(r.action, 'dry-run');
    assert.equal(r.dryRun, true);
    // It still ANSWERS the question — a probe that reports nothing is useless.
    assert.deepEqual(r.wouldTimeOut.map(a => a.domain), ['schema']);

    const after = openDb(dbPath);
    assert.deepEqual(controlPlaneSnapshot(after), before);
    // The overdue agent is still in-flight: the preview did not reap it.
    assert.equal(after.prepare('SELECT status FROM agent_runs WHERE id = 1').get().status, 'dispatched');
    after.close();
  });
});

describe('F-liveness-probe — (b) resume still redispatches when explicitly invoked', () => {
  it('the real path reaps the overdue agent and creates a redispatch row', () => {
    const d = seed([{ domain: 'schema', startedAt: T0 }]);      // overdue
    const before = controlPlaneSnapshot(d);
    d.close();

    const r = resume({ runId: 'run-1', dbPath, outputDir: dir, nowMs: NOW });

    assert.equal(r.action, 'redispatched');
    assert.equal((r.redispatch).length, 1);
    assert.equal(r.redispatch[0].domain, 'schema');

    const after = openDb(dbPath);
    const snap = controlPlaneSnapshot(after);
    // A new agent_run exists, and the original was transitioned.
    assert.ok((snap.agent_runs) > (before.agent_runs));
    assert.equal(after.prepare('SELECT status FROM agent_runs WHERE id = 1').get().status, 'timed_out');
    after.close();
  });

  it('a fresh agent is left alone by BOTH paths — the probe and the action agree', () => {
    const d = seed([{ domain: 'schema', startedAt: NOW - 60_000 }]);  // fresh
    d.close();

    const preview = resume({ runId: 'run-1', dbPath, outputDir: dir, nowMs: NOW, dryRun: true });
    assert.equal((preview.wouldTimeOut).length, 0);
    assert.equal((preview.wouldRedispatch).length, 0);

    const real = resume({ runId: 'run-1', dbPath, outputDir: dir, nowMs: NOW });
    assert.equal(real.action, 'waiting');
    assert.equal((real.still_running).length, 1);

    const after = openDb(dbPath);
    assert.equal(after.prepare('SELECT status FROM agent_runs WHERE id = 1').get().status, 'dispatched');
    after.close();
  });
});

describe('F-liveness-probe — (c) status distinguishes running from timed-out-not-yet-reaped', () => {
  it('marks the overdue agent stale and the fresh one not, without reaping either', () => {
    const d = seed([
      { domain: 'schema', startedAt: T0 },                       // overdue
      { domain: 'editor', startedAt: NOW - 60_000 },             // fresh
    ]);
    const before = controlPlaneSnapshot(d);
    d.close();

    const s = status({ runId: 'run-1', dbPath, nowMs: NOW });

    const byDomain = Object.fromEntries(s.agents.map(a => [a.domain, a]));
    assert.equal(byDomain.schema.stale, true);
    assert.equal(byDomain.editor.stale, false);
    assert.equal(s.agentSummary.inFlight, 2);
    assert.equal(s.agentSummary.stalePastTimeout, 1);

    // Both are STILL `dispatched` in the DB — "timed out" here is an
    // observation, not a transition. That distinction is the whole point:
    // the operator learns the agent is dead without the report killing it.
    const after = openDb(dbPath);
    assert.deepEqual(controlPlaneSnapshot(after), before);
    after.close();
  });

  it('reports zero stale when every agent is within policy', () => {
    const d = seed([
      { domain: 'schema', startedAt: NOW - 60_000 },
      { domain: 'editor', startedAt: NOW - 120_000 },
    ]);
    d.close();
    const s = status({ runId: 'run-1', dbPath, nowMs: NOW });
    assert.equal(s.agentSummary.stalePastTimeout, 0);
    assert.equal(s.agents.every(a => a.stale === false), true);
  });
});

describe('F-liveness-probe — the probe and the action share ONE predicate', () => {
  it('classifyTimeouts.timedOut is EXACTLY the set applyTimeoutPolicy reaps', () => {
    // Ages straddling the boundary in both directions, so an off-by-one or a
    // flipped comparison in either copy would show up as a set difference.
    const d = seed([
      { domain: 'a', startedAt: NOW - TIMEOUT_MS - 1000 },  // just over  -> reap
      { domain: 'b', startedAt: NOW - TIMEOUT_MS + 1000 },  // just under -> keep
      { domain: 'c', startedAt: T0 },                       // far over   -> reap
      { domain: 'd', startedAt: NOW },                      // brand new  -> keep
    ]);

    const predicted = classifyTimeouts(d, 1, TIMEOUT_MS, NOW).timedOut
      .map(a => a.domain).sort();
    const actuallyReaped = applyTimeoutPolicy(d, 1, TIMEOUT_MS, NOW)
      .map(a => a.domain).sort();

    assert.deepEqual(predicted, ['a', 'c']);
    // The assertion that makes the preview trustworthy: prediction === outcome.
    assert.deepEqual(actuallyReaped, predicted);
  });

  it('a NULL started_at is classified `unknown` — never reaped, never called healthy', () => {
    // A state-machine bypass (direct INSERT / manual SQL repair) leaves an
    // in-flight row with no started_at. We cannot prove timing we do not have,
    // so it must not be instant-timed-out — but it must not be silently
    // reported as running either, or the operator is told a dead agent is fine.
    const d = seed([{ domain: 'ghost', startedAt: null }]);

    const c = classifyTimeouts(d, 1, TIMEOUT_MS, NOW);
    assert.deepEqual(c.unknown.map(a => a.domain), ['ghost']);
    assert.equal((c.timedOut).length, 0);
    assert.equal((c.stillRunning).length, 0);

    // And the mutating pass agrees: it reaps nothing.
    assert.equal((applyTimeoutPolicy(d, 1, TIMEOUT_MS, NOW)).length, 0);
    assert.equal(d.prepare('SELECT status FROM agent_runs WHERE id = 1').get().status, 'dispatched');
  });
});
