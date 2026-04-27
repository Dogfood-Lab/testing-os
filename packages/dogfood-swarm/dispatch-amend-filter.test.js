/**
 * dispatch-amend-filter.test.js — F-COORD-001 + F-742440-003 regression.
 *
 * Both `dispatch` (initial amend wave) and `resume` (re-dispatch after
 * timeout/failure) must hand each domain agent ONLY the approved findings
 * whose file_path matches the agent's owned globs.
 *
 * Pre-fix behaviour (the bug):
 *   - dispatch joined `findings` to `file_claims` to filter by domain. Audits
 *     never write file_claims, so on the FIRST amend wave the join returned
 *     0 rows for every domain. A fallback then loaded ALL approved findings
 *     and fed them to every agent — defeating exclusive ownership.
 *   - resume skipped the filter entirely and always sent every approved
 *     finding to every redispatched agent.
 *
 * These tests must FAIL on the broken code (each agent's prompt contains
 * findings owned by the OTHER domain) and PASS on the fixed code (each
 * agent's prompt contains only its own findings).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { resume } from './commands/resume.js';

const RUN_ID = 'test-amend-filter';

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

  // 4 approved findings: 2 in domain-a's tree, 2 in domain-b's tree.
  // first_seen_wave / last_seen_wave left null — no wave exists yet, and
  // the amend filter doesn't read those columns.
  const insert = db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
     description, recommendation, status)
    VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);

  insert.run(RUN_ID, 'F-A-001', 'fp-a-1', 'HIGH',
    'packages/a/src/foo.js', 10, 'A finding 1', 'fix A1');
  insert.run(RUN_ID, 'F-A-002', 'fp-a-2', 'MEDIUM',
    'packages/a/src/bar.js', 20, 'A finding 2', 'fix A2');
  insert.run(RUN_ID, 'F-B-001', 'fp-b-1', 'HIGH',
    'packages/b/src/baz.js', 30, 'B finding 1', 'fix B1');
  insert.run(RUN_ID, 'F-B-002', 'fp-b-2', 'LOW',
    'packages/b/src/qux.js', 40, 'B finding 2', 'fix B2');

  return db;
}

describe('dispatch — amend findings filter (F-COORD-001)', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'amend-filter-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hands each domain only its own approved findings', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    assert.equal(result.agents.length, 2, 'two agent prompts written');

    const promptByDomain = {};
    for (const a of result.agents) {
      promptByDomain[a.domain] = readFileSync(a.promptPath, 'utf-8');
    }

    const a = promptByDomain['domain-a'];
    const b = promptByDomain['domain-b'];
    assert.ok(a, 'domain-a prompt exists');
    assert.ok(b, 'domain-b prompt exists');

    // domain-a sees A findings, NOT B findings
    assert.match(a, /F-A-001/);
    assert.match(a, /F-A-002/);
    assert.doesNotMatch(a, /F-B-001/, 'domain-a leaked F-B-001');
    assert.doesNotMatch(a, /F-B-002/, 'domain-a leaked F-B-002');

    // domain-b sees B findings, NOT A findings
    assert.match(b, /F-B-001/);
    assert.match(b, /F-B-002/);
    assert.doesNotMatch(b, /F-A-001/, 'domain-b leaked F-A-001');
    assert.doesNotMatch(b, /F-A-002/, 'domain-b leaked F-A-002');
  });

  it('returns empty findings list (no fallback) when domain owns nothing approved', () => {
    // Mark all B findings as fixed so domain-b legitimately has zero approved work.
    const db = openDb(dbPath);
    db.prepare("UPDATE findings SET status = 'fixed' WHERE finding_id LIKE 'F-B-%'")
      .run();

    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    const bAgent = result.agents.find(a => a.domain === 'domain-b');
    const bPrompt = readFileSync(bAgent.promptPath, 'utf-8');

    // The dangerous all-approved fallback would have re-injected F-A-001/002
    // into domain-b's prompt. The fix removes that fallback.
    assert.doesNotMatch(bPrompt, /F-A-001/, 'fallback re-injected A-1 into domain-b');
    assert.doesNotMatch(bPrompt, /F-A-002/, 'fallback re-injected A-2 into domain-b');
  });
});

describe('resume — amend findings filter (F-742440-003)', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'amend-filter-resume-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redispatched amend agents see only their own approved findings', () => {
    // First, dispatch the amend wave normally (creates wave + agent_runs).
    dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    // Force both agents into a redispatchable state so resume rebuilds their prompts.
    const db = openDb(dbPath);
    db.prepare("UPDATE agent_runs SET status = 'failed' WHERE wave_id = 1").run();

    const report = resume({
      runId: RUN_ID,
      dbPath,
      outputDir: tmpDir,
    });

    assert.equal(report.action, 'redispatched');
    assert.equal(report.redispatch.length, 2, 'both agents redispatched');

    const promptByDomain = {};
    for (const r of report.redispatch) {
      promptByDomain[r.domain] = readFileSync(r.promptPath, 'utf-8');
    }

    const a = promptByDomain['domain-a'];
    const b = promptByDomain['domain-b'];

    assert.match(a, /F-A-001/);
    assert.match(a, /F-A-002/);
    assert.doesNotMatch(a, /F-B-001/, 'resume leaked F-B-001 to domain-a');
    assert.doesNotMatch(a, /F-B-002/, 'resume leaked F-B-002 to domain-a');

    assert.match(b, /F-B-001/);
    assert.match(b, /F-B-002/);
    assert.doesNotMatch(b, /F-A-001/, 'resume leaked F-A-001 to domain-b');
    assert.doesNotMatch(b, /F-A-002/, 'resume leaked F-A-002 to domain-b');
  });
});
