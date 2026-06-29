/**
 * ds-proac-03-collect-lifecycle.test.js
 *
 * PROACTIVE-HEALTH DS-PROAC-03 (LOW, observability) — `swarm collect` is a
 * multi-item operation (it iterates every agent_run in the wave, validates each
 * output, enforces ownership, dedups findings) but emitted NO lifecycle
 * breadcrumb at start or completion. Its sibling stages DO: verify.js /
 * dispatch.js bracket their work with verify_start / verify_complete (and
 * dispatch emits wave_dispatched) carrying a correlation_id + counts. An
 * operator tailing the NDJSON stream saw collect's per-failure events
 * (agent_output_invalid, ownership_probe_degraded, upsert_findings_failed) but
 * had no "collect began / collect finished with these counts" bracket to anchor
 * them to a single run.
 *
 * The fix adds a collect_start (minted correlation_id, runId, waveId,
 * waveNumber, phase, agentCount) + collect_complete (same correlation_id, plus
 * accepted / invalid / violation counts) logStage pair, matching the
 * verify_start / verify_complete shape.
 *
 * Test invariants (RED→GREEN):
 *   1. LIFECYCLE PAIR: a collect run emits exactly one collect_start and one
 *      collect_complete NDJSON event, sharing the same correlation_id.
 *   2. START CARRIES SCOPE: collect_start names runId + waveId + agentCount so
 *      the operator knows what is about to be processed.
 *   3. COMPLETE CARRIES COUNTS: collect_complete reports accepted / invalid /
 *      violation counts so a degraded run SAYS it degraded (a wave with an
 *      invalid output reports invalid >= 1, never silent success).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';

const RUN_ID = 'test-ds-proac-03';

function captureStderrLines(fn) {
  const prev = process.env.DOGFOOD_LOG_HUMAN;
  process.env.DOGFOOD_LOG_HUMAN = '0';
  const orig = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  let result;
  try { result = fn(); } finally {
    console.error = orig;
    if (prev === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
    else process.env.DOGFOOD_LOG_HUMAN = prev;
  }
  return { result, lines };
}

function ndjsonEvents(lines) {
  const out = [];
  for (const ln of lines) {
    if (!ln.startsWith('{')) continue;
    try { const obj = JSON.parse(ln); if (obj && obj.stage) out.push(obj); } catch { /* */ }
  }
  return out;
}

function setupRun(dbPath, repoPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', repoPath, 'a'.repeat(40));
  saveDomainDraft(db, RUN_ID, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);
  const insert = db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
     description, recommendation, status)
    VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);
  insert.run(RUN_ID, 'F-A-001', 'fp-a-1', 'HIGH', 'packages/a/src/foo.js', 10, 'A finding', 'fix A1');
  insert.run(RUN_ID, 'F-B-001', 'fp-b-1', 'HIGH', 'packages/b/src/baz.js', 20, 'B finding', 'fix B1');
  return db;
}

describe('DS-PROAC-03 — swarm collect lifecycle NDJSON pair', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ds-proac-03-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    dispatch({ runId: RUN_ID, phase: 'health-amend-a', dbPath, outputDir: tmpDir, skipVerify: true });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a collect_start + collect_complete pair sharing one correlation_id, with scope + counts', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a', summary: 'ok',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [], verification_skipped: true,
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b', summary: 'ok',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [], verification_skipped: true,
    }));

    const { result, lines } = captureStderrLines(() => collect({
      runId: RUN_ID, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB },
    }));

    const events = ndjsonEvents(lines);
    const starts = events.filter(e => e.stage === 'collect_start');
    const completes = events.filter(e => e.stage === 'collect_complete');

    assert.equal(starts.length, 1, 'exactly one collect_start');
    assert.equal(completes.length, 1, 'exactly one collect_complete');

    const start = starts[0];
    const complete = completes[0];

    assert.ok(start.correlation_id, 'collect_start carries a correlation_id');
    assert.equal(start.correlation_id, complete.correlation_id,
      'the lifecycle pair shares one correlation_id so the operator can grep them together');

    // Start carries scope.
    assert.equal(start.runId, RUN_ID, 'collect_start names the run');
    assert.equal(start.waveId, result.waveId, 'collect_start names the wave');
    assert.equal(start.agentCount, 2, 'collect_start names how many agents will be processed');

    // Complete carries counts (a healthy 2-agent collect: 2 accepted, 0 invalid/violation).
    assert.equal(complete.accepted, 2, 'collect_complete reports accepted count');
    assert.equal(complete.invalid, 0, 'collect_complete reports invalid count');
    assert.equal(complete.violations, 0, 'collect_complete reports violation count');
  });

  it('a degraded run SAYS it degraded: collect_complete reports invalid >= 1 for a malformed output', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    // domain-a is well-formed; domain-b is structurally invalid (missing the
    // required domain/summary envelope) so the schema gate rejects it.
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a', summary: 'ok',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [], verification_skipped: true,
    }));
    writeFileSync(outB, JSON.stringify({ not: 'a valid agent output' }));

    const { lines } = captureStderrLines(() => collect({
      runId: RUN_ID, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB },
    }));

    const complete = ndjsonEvents(lines).find(e => e.stage === 'collect_complete');
    assert.ok(complete, 'collect_complete must still be emitted on a degraded run');
    assert.ok(complete.invalid >= 1,
      `a malformed output must be reported as invalid, not silently dropped (got invalid=${complete.invalid})`);
  });
});
