/**
 * ingestA-commit-group-partial-promote.test.js
 *
 * Stage A amend wave — two findings on rebuild-indexes.js's commit group.
 *
 *   ingest-A-001 (observability) — `commitGroupRename` promotes the 3 index
 *     temps with per-leg `renameSync`, NOT as one atomic group. On a
 *     mid-promote IO failure the catch re-throws and leaves the journal for
 *     next-run cleanup, but does NOT roll back the already-promoted final —
 *     so a reader in the heal window sees a torn group. The fix corrects the
 *     header/comment claim (recovery-atomic, NOT reader-atomic) AND emits a
 *     structured `logStage('error', { kind: 'commit_group_partial_promote' })`
 *     naming which finals were promoted vs left stale so an operator can force
 *     an immediate rebuild. This test pins that the partial-promote failure
 *     path logs that structured event.
 *
 *   ingest-A-002 (safety) — `cleanupCrashedJournals` deletes EVERY
 *     `.in-progress.*.json` journal regardless of pid, but the comment
 *     asserted the pid suffix "guarantees no collision with concurrent
 *     rebuilds." The fix makes cleanup PID-AWARE: a journal owned by a
 *     still-live process is preserved (it is a concurrent rebuild's in-flight
 *     recovery state); a dead/missing/malformed pid is still reaped. This test
 *     pins: a live-pid journal survives a rebuild; a dead-pid journal is
 *     reaped.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { rebuildIndexes } from './rebuild-indexes.js';

// ─── helpers ────────────────────────────────────────────────────────────

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ingestA-commit-'));
  mkdirSync(join(root, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19'), { recursive: true });
  return root;
}

function seedRecord(repoRoot, runId) {
  const path = join(repoRoot, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19', `run-${runId}.json`);
  writeFileSync(path, JSON.stringify({
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: runId,
    repo: 'mcp-tool-shop-org/demo',
    timing: { finished_at: '2026-03-19T15:45:12Z' },
    scenario_results: [{ scenario_id: 's1', product_surface: 'cli', verdict: 'pass' }],
    overall_verdict: { verified: 'pass' },
    verification: { status: 'accepted' },
  }, null, 2), 'utf-8');
}

function captureStderrSync(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured;
}

function parseStageEvents(captured) {
  const events = [];
  for (const chunk of captured) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.stage) events.push(parsed);
      } catch { /* skip non-JSON */ }
    }
  }
  return events;
}

function listJournals(repoRoot) {
  const indexDir = join(repoRoot, 'indexes');
  if (!existsSync(indexDir)) return [];
  return readdirSync(indexDir).filter(f => f.startsWith('.in-progress.'));
}

// ─── ingest-A-001 ─────────────────────────────────────────────────────────

describe('ingest-A-001 — partial-promote failure logs a structured error event', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('logs commit_group_partial_promote naming promoted vs stale finals on a mid-promote failure', () => {
    seedRecord(repoRoot, 'a-001');

    // Force a mid-promote IO failure on the SECOND leg (failing.json):
    // pre-create `failing.json` as a NON-EMPTY directory so `renameSync`
    // of a temp file onto it fails (a file cannot replace a non-empty dir
    // on any platform). The first leg (latest-by-repo.json) promotes fine,
    // so we land squarely in the torn-group window.
    const indexDir = join(repoRoot, 'indexes');
    mkdirSync(indexDir, { recursive: true });
    const failingAsDir = join(indexDir, 'failing.json');
    mkdirSync(failingAsDir, { recursive: true });
    writeFileSync(join(failingAsDir, 'occupant.txt'), 'blocks the rename', 'utf-8');

    let threw = false;
    const captured = captureStderrSync(() => {
      try {
        rebuildIndexes(repoRoot);
      } catch {
        threw = true;
      }
    });

    assert.equal(threw, true, 'a blocked promote must still surface as a thrown error');

    const events = parseStageEvents(captured);
    const ev = events.find(e =>
      e.stage === 'error' && e.kind === 'commit_group_partial_promote'
    );
    assert.ok(ev,
      `expected a stage:error event with kind=commit_group_partial_promote; ` +
      `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind })))}`);

    // The event must name which finals were promoted vs left stale so an
    // operator can force an immediate rebuild.
    assert.ok(Array.isArray(ev.promoted_finals), 'event carries promoted_finals[]');
    assert.ok(Array.isArray(ev.stale_finals), 'event carries stale_finals[]');
    assert.equal(ev.promoted_count, ev.promoted_finals.length,
      'promoted_count agrees with promoted_finals length');
    // First leg promoted, second leg (the blocked failing.json) failed, so
    // the still-staged finals must include failing.json.
    assert.ok(ev.promoted_finals.some(p => p.endsWith('latest-by-repo.json')),
      'latest-by-repo.json must be in promoted_finals (first leg succeeded)');
    assert.ok(ev.stale_finals.some(p => p.endsWith('failing.json')),
      'failing.json must be in stale_finals (its promote was blocked)');
    assert.ok(typeof ev.journal === 'string' && ev.journal.length > 0,
      'event names the preserved journal so the operator can find recovery state');
  });

  it('NEGATIVE: a clean rebuild emits no commit_group_partial_promote event', () => {
    seedRecord(repoRoot, 'b-001');
    const captured = captureStderrSync(() => { rebuildIndexes(repoRoot); });
    const events = parseStageEvents(captured);
    const ev = events.find(e =>
      e.stage === 'error' && e.kind === 'commit_group_partial_promote'
    );
    assert.ok(!ev, `clean rebuild must not log a partial-promote error; got ${JSON.stringify(ev)}`);
  });
});

// ─── ingest-A-002 ─────────────────────────────────────────────────────────

describe('ingest-A-002 — cleanupCrashedJournals is pid-aware', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('preserves a journal owned by a still-live, OTHER process (a concurrent rebuild)', async () => {
    seedRecord(repoRoot, 'c-001');
    const indexDir = join(repoRoot, 'indexes');
    mkdirSync(indexDir, { recursive: true });

    // Spawn a real, separate, long-lived child so the planted journal's pid
    // is BOTH alive AND different from this process — exactly the concurrent
    // rebuild shape. (Using `process.pid` would model "our own stale
    // journal," which is correctly reaped, not the concurrent-peer case.)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      // Wait until the child is actually scheduled (pid assigned + running).
      await new Promise((res, rej) => {
        child.once('spawn', res);
        child.once('error', rej);
      });
      assert.notEqual(child.pid, process.pid, 'child must be a distinct process');

      const liveTmp = join(indexDir, 'latest-by-repo.json.live0001.tmp');
      writeFileSync(liveTmp, '{"concurrent": true}', 'utf-8');
      const liveJournal = join(indexDir, `.in-progress.${child.pid}.live.json`);
      writeFileSync(liveJournal, JSON.stringify({
        pid: child.pid,
        started_at: new Date().toISOString(),
        entries: [{ tmpPath: liveTmp, finalPath: join(indexDir, 'latest-by-repo.json') }],
      }), 'utf-8');

      rebuildIndexes(repoRoot);

      assert.equal(existsSync(liveJournal), true,
        'a live-pid journal must NOT be reaped — it is a concurrent rebuild\'s recovery state');
      assert.equal(existsSync(liveTmp), true,
        'a live-pid journal\'s staged temp must NOT be reaped');
    } finally {
      child.kill();
    }
  });

  it('reaps a journal owned by a dead process', () => {
    seedRecord(repoRoot, 'd-001');
    const indexDir = join(repoRoot, 'indexes');
    mkdirSync(indexDir, { recursive: true });

    // pid 1 exists on POSIX (init) but pid 0x7fffffff is reliably dead on
    // both POSIX and Windows. Use a high, never-allocated pid.
    const deadPid = 0x7ffffffe;
    const deadTmp = join(indexDir, 'failing.json.dead0001.tmp');
    writeFileSync(deadTmp, '{"crashed": true}', 'utf-8');
    const deadJournal = join(indexDir, `.in-progress.${deadPid}.dead.json`);
    writeFileSync(deadJournal, JSON.stringify({
      pid: deadPid,
      started_at: '2026-04-26T00:00:00Z',
      entries: [{ tmpPath: deadTmp, finalPath: join(indexDir, 'failing.json') }],
    }), 'utf-8');

    rebuildIndexes(repoRoot);

    assert.equal(existsSync(deadJournal), false,
      'a dead-pid journal is crashed residue and must be reaped');
    assert.equal(existsSync(deadTmp), false,
      'a dead-pid journal\'s staged temp must be reaped');
  });

  it('reaps a journal with a missing/malformed pid (cannot be proven live)', () => {
    seedRecord(repoRoot, 'e-001');
    const indexDir = join(repoRoot, 'indexes');
    mkdirSync(indexDir, { recursive: true });

    const noPidTmp = join(indexDir, 'stale.json.nopid001.tmp');
    writeFileSync(noPidTmp, '{"crashed": true}', 'utf-8');
    const noPidJournal = join(indexDir, '.in-progress.nopid.json');
    writeFileSync(noPidJournal, JSON.stringify({
      started_at: '2026-04-26T00:00:00Z',
      entries: [{ tmpPath: noPidTmp, finalPath: join(indexDir, 'stale.json') }],
    }), 'utf-8');

    rebuildIndexes(repoRoot);

    assert.equal(existsSync(noPidJournal), false,
      'a journal with no provable live pid must be reaped, not preserved forever');
    assert.equal(existsSync(noPidTmp), false,
      'its staged temp must be reaped too');
  });
});
