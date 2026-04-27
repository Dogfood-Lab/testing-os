/**
 * wave12-observability.test.js — Wave-12 backend observability receipts.
 *
 *   F-693631-001  commands/dispatch.js silent --isolate catch. When
 *                 createWorktree threw, the bare catch set worktreePath/
 *                 worktreeBranch to null and continued; agent ran in the
 *                 main repo while the operator believed isolation was in
 *                 effect. Re-emergence of F-742440-007 (wave-1) — the
 *                 prior fix added documentation but no observability at
 *                 the catch site. Wave-12 fix throws IsolationError +
 *                 emits structured NDJSON via logStage.
 *
 *   F-693631-002  commands/collect.js called upsertFindings with no
 *                 try/catch. The inner db.transaction() rolled back its
 *                 own writes on throw, but the throw escaped collect
 *                 AFTER artifact rows + file_claims + agent state
 *                 transitions had been committed and BEFORE the wave
 *                 status UPDATE ran. swarm resume could not recover the
 *                 inconsistency. Wave-12 fix wraps with try/catch,
 *                 logs structured stderr context, throws CollectUpsertError.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { transitionAgent } from './lib/state-machine.js';
import { IsolationError, CollectUpsertError } from './lib/errors.js';

// ═══════════════════════════════════════════
// F-693631-001 — dispatch --isolate must throw, not silent-fallback
// ═══════════════════════════════════════════

describe('dispatch — F-693631-001 --isolate failure surfaces IsolationError', () => {
  let tmp;
  let dbPath;
  const RUN_ID = 'r-w12-isolate';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w12-isolate-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    // local_path points at a non-existent dir — git execSync inside
    // createWorktree will throw, exercising the catch branch.
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', join(tmp, 'does-not-exist'), 'a'.repeat(40));

    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws IsolationError when --isolate is set and createWorktree fails', () => {
    const origErr = console.error;
    const errCalls = [];
    console.error = (...args) => errCalls.push(args.join(' '));

    let thrown;
    try {
      try {
        dispatch({
          runId: RUN_ID,
          phase: 'health-audit-a',
          dbPath,
          outputDir: tmp,
          isolate: true,
        });
      } catch (e) {
        thrown = e;
      }
    } finally {
      console.error = origErr;
    }

    assert.ok(thrown, 'dispatch must throw when --isolate fails');
    assert.ok(thrown instanceof IsolationError,
      `expected IsolationError, got ${thrown?.constructor?.name}: ${thrown?.message}`);
    assert.equal(thrown.code, 'ISOLATION_FAILED');
    assert.match(thrown.message, /--isolate/,
      'IsolationError message must mention --isolate so the operator sees what failed');
    assert.match(thrown.message, /backend/,
      'IsolationError message must include the failing domain');
    assert.ok(thrown.cause, 'IsolationError must carry the underlying cause');

    // Structured NDJSON line on stderr — wave-9 ingest pattern, now shared.
    const isolateLog = errCalls.find(s => {
      try {
        const obj = JSON.parse(s);
        return obj.stage === 'isolate_failed'
          && obj.component === 'dogfood-swarm'
          && obj.domain === 'backend'
          && obj.runId === RUN_ID
          && typeof obj.err === 'string';
      } catch { return false; }
    });
    assert.ok(isolateLog,
      `expected NDJSON {stage:"isolate_failed", component:"dogfood-swarm", domain:"backend", runId, err}; got:\n${errCalls.join('\n')}`);
  });

  it('does NOT throw when --isolate is not set, even with a non-existent local_path', () => {
    // Without --isolate, createWorktree is never called. dispatch must
    // succeed and write agent_runs with worktreePath = null.
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmp,
      // isolate omitted
    });

    assert.equal(result.agents.length, 1, 'one agent dispatched');
    assert.equal(result.agents[0].worktreePath, null,
      'no worktree without --isolate');
  });
});

// ═══════════════════════════════════════════
// F-693631-002 — collect upsertFindings failure surfaces CollectUpsertError
// ═══════════════════════════════════════════

describe('collect — F-693631-002 upsertFindings failure surfaces CollectUpsertError', () => {
  let tmp;
  let dbPath;
  const RUN_ID = 'r-w12-upsert';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w12-upsert-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));

    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws CollectUpsertError when upsertFindings hits a SQLite error mid-tx', async () => {
    const { computeFingerprint } = await import('./lib/fingerprint.js');

    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });

    const findingPayload = {
      id: 'F-W12-001',
      severity: 'HIGH',
      category: 'bug',
      file: 'packages/backend/x.js',
      line: 10,
      symbol: 'fooFn',
      description: 'collision target',
    };
    const fp = computeFingerprint(findingPayload);

    // Seed a finding with the same (run_id, fingerprint) so the upsert
    // INSERT will violate UNIQUE(run_id, fingerprint) when classifyFindings
    // mis-classifies it as `new` (no priorMap entry exists for waves 0).
    //
    // But buildPriorMap reads ALL findings for the run, so the seeded row
    // WILL be in the priorMap — classifyFindings will mark our finding
    // `recurring`, not `new`, so no INSERT collision occurs.
    //
    // To force the inner tx to throw, we instead corrupt the schema so
    // the prepared INSERT fails. Drop the finding_events table so the
    // INSERT INTO finding_events inside the tx throws "no such table".
    const db = openDb(dbPath);
    db.exec('DROP TABLE finding_events');

    const outputPath = join(tmp, 'backend.json');
    writeFileSync(outputPath, JSON.stringify({
      domain: 'backend',
      stage: 'A',
      findings: [findingPayload],
      summary: 'one finding',
    }), 'utf-8');

    const origErr = console.error;
    const errCalls = [];
    console.error = (...args) => errCalls.push(args.join(' '));

    let thrown;
    try {
      try {
        collect({
          runId: RUN_ID,
          dbPath,
          outputs: { backend: outputPath },
        });
      } catch (e) {
        thrown = e;
      }
    } finally {
      console.error = origErr;
    }

    assert.ok(thrown, 'collect must throw when upsertFindings fails');
    assert.ok(thrown instanceof CollectUpsertError,
      `expected CollectUpsertError, got ${thrown?.constructor?.name}: ${thrown?.message}`);
    assert.equal(thrown.code, 'COLLECT_UPSERT_FAILED');
    assert.equal(thrown.findingsAttempted, 1);
    assert.ok(thrown.cause, 'CollectUpsertError must carry the underlying cause');

    const upsertLog = errCalls.find(s => {
      try {
        const obj = JSON.parse(s);
        return obj.stage === 'upsert_findings_failed'
          && obj.component === 'dogfood-swarm'
          && obj.runId === RUN_ID
          && obj.findingsAttempted === 1
          && typeof obj.err === 'string';
      } catch { return false; }
    });
    assert.ok(upsertLog,
      `expected NDJSON {stage:"upsert_findings_failed", findingsAttempted:1}; got:\n${errCalls.join('\n')}`);

    // Atomicity: no findings row was committed (the SQLite tx rolled back).
    // The wave status is also still 'dispatched' — the wave-status UPDATE
    // below upsertFindings did NOT run because we threw. This is the
    // "fail loud + don't claim partial success" contract: the operator
    // sees the error, the wave is left in its pre-collect state, and
    // re-running collect after fixing the underlying issue is safe.
    const findingCount = db.prepare(
      'SELECT COUNT(*) as n FROM findings WHERE run_id = ?'
    ).get(RUN_ID);
    assert.equal(findingCount.n, 0,
      'no finding row may persist when the tx threw — atomicity contract');

    const waveAfter = db.prepare(
      'SELECT status FROM waves WHERE run_id = ?'
    ).get(RUN_ID);
    assert.equal(waveAfter.status, 'dispatched',
      'wave status must remain dispatched — no half-written transition');
  });
});
