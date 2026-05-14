/**
 * verification-discipline.test.js — Phase 2-B verification-discipline slice.
 *
 * Three independent assertions:
 *
 *   Item 5 (Serial final verification)
 *     - `swarm dispatch --skip-verify` appends the SKIP_VERIFY_DIRECTIVE to
 *       amend prompts (audit prompts are unaffected — they don't run tests).
 *     - When an agent JSON carries `verification_skipped: true`, `swarm
 *       collect` propagates that into `report.serial_verify_required` so the
 *       CLI can surface the Next-step hint.
 *
 *   VD-NEW-1 (files_changed independent diff cross-check)
 *     - Ownership runs against the union of agent self-reported `files_changed`
 *       AND the independently-computed touched-file set from
 *       `lib/git-touched-files.js`. An agent that under-reports `files_changed`
 *       cannot bypass ownership enforcement.
 *
 *   VD-NEW-1 helper unit
 *     - `diffReportedVsActual` reports symmetric divergences in both
 *       directions (missing_from_report and extra_in_report).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import {
  getActualTouchedFiles,
  diffReportedVsActual,
} from './lib/git-touched-files.js';

const RUN_ID = 'test-verification-discipline';

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

  // Approved findings so the amend dispatch has real work.
  const insert = db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
     description, recommendation, status)
    VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);
  insert.run(RUN_ID, 'F-A-001', 'fp-a-1', 'HIGH',
    'packages/a/src/foo.js', 10, 'A finding', 'fix A1');
  insert.run(RUN_ID, 'F-B-001', 'fp-b-1', 'HIGH',
    'packages/b/src/baz.js', 20, 'B finding', 'fix B1');

  return db;
}

describe('Item 5 — `swarm dispatch --skip-verify` appends parallel-wave directive to amend prompts', () => {
  let tmpDir, dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-dispatch-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath, '/tmp/repo');
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends the SKIP_VERIFY_DIRECTIVE when skipVerify=true on an amend wave', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
      skipVerify: true,
    });

    assert.equal(result.agents.length, 2);

    for (const a of result.agents) {
      const prompt = readFileSync(a.promptPath, 'utf-8');
      assert.match(prompt, /Verification discipline \(parallel-wave\)/,
        `${a.domain}: directive header missing`);
      assert.match(prompt, /Do NOT run per-agent verification/,
        `${a.domain}: imperative missing`);
      assert.match(prompt, /verification_skipped.*true/,
        `${a.domain}: contract field missing`);
    }
  });

  it('omits the SKIP_VERIFY_DIRECTIVE when skipVerify is unset', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const a of result.agents) {
      const prompt = readFileSync(a.promptPath, 'utf-8');
      assert.doesNotMatch(prompt, /Verification discipline \(parallel-wave\)/,
        `${a.domain}: directive leaked into a non-skip-verify wave`);
    }
  });
});

describe('Item 5 — `swarm collect` propagates verification_skipped into serial_verify_required', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-collect-'));
    dbPath = join(tmpDir, 'control-plane.db');
    // Real git repo so getActualTouchedFiles() works; the touched-file probe
    // is exercised in the VD-NEW-1 block, but collect.js still runs it on
    // every amend agent and we don't want it to silently degrade here.
    repoPath = join(tmpDir, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    // Dispatch the amend wave so agent_runs exist.
    dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
      skipVerify: true,
    });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets serial_verify_required when any agent JSON carries verification_skipped:true', () => {
    // Both agents skipped verify per the discipline.
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'skipped',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [],
      verification_skipped: true,
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'skipped',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
      verification_skipped: true,
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.equal(report.serial_verify_required, true,
      'serial_verify_required must be set when agents skip verify');
    const aReport = report.agents.find(r => r.domain === 'domain-a');
    assert.equal(aReport.verification_skipped, true,
      'per-agent verification_skipped must surface on the agent report');
  });

  it('leaves serial_verify_required=false when no agent skipped verify', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'verified locally',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'verified locally',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.equal(report.serial_verify_required, false,
      'serial_verify_required must stay false in legacy single-agent semantics');
  });
});

describe('VD-NEW-1 — files_changed is no longer the sole ownership input', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-vdnew1-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    mkdirSync(join(repoPath, 'packages/a/src'), { recursive: true });
    mkdirSync(join(repoPath, 'packages/b/src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'seed\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('catches a domain-a agent that touches domain-b files even when files_changed is empty', () => {
    // Domain-a agent self-reports an empty files_changed list — but in the
    // worktree, they actually edited a file owned by domain-b. Pre-fix:
    // checkOwnership saw an empty list and skipped enforcement entirely.
    // Post-fix: the git probe surfaces the edit and ownership flags it.
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'tampered by A\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'under-reporting probe',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'no work',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    // Domain-a touched packages/b/src/baz.js — domain-b territory. The
    // ownership check must now fire on the independently-computed set.
    const aReport = report.agents.find(r => r.domain === 'domain-a');
    assert.equal(aReport.status, 'ownership_violation',
      'an agent that under-reports files_changed must still be caught by the independent diff');
    assert.ok(report.violations.some(v => v.file === 'packages/b/src/baz.js'),
      'the violated file must appear in the ownership-violations report');
  });
});

describe('VD-NEW-1 — diffReportedVsActual helper', () => {
  it('reports missing_from_report when actual has files the agent did not list', () => {
    const d = diffReportedVsActual(['a.js'], ['a.js', 'b.js']);
    assert.deepEqual(d.missing_from_report, ['b.js']);
    assert.deepEqual(d.extra_in_report, []);
    assert.equal(d.match, false);
  });

  it('reports extra_in_report when the agent listed files the worktree did not actually touch', () => {
    const d = diffReportedVsActual(['a.js', 'phantom.js'], ['a.js']);
    assert.deepEqual(d.missing_from_report, []);
    assert.deepEqual(d.extra_in_report, ['phantom.js']);
    assert.equal(d.match, false);
  });

  it('flags a perfect match', () => {
    const d = diffReportedVsActual(['a.js', 'b.js'], ['b.js', 'a.js']);
    assert.equal(d.match, true);
  });

  it('normalizes backslash paths so Windows agent reports compare against forward-slash git output', () => {
    const d = diffReportedVsActual(['packages\\a\\src\\foo.js'], ['packages/a/src/foo.js']);
    assert.equal(d.match, true);
  });
});

describe('VD-NEW-1 — getActualTouchedFiles graceful degradation', () => {
  it('returns unavailable=true when the path is not a git repo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'not-a-git-repo-'));
    try {
      const r = getActualTouchedFiles(tmp);
      assert.equal(r.unavailable, true);
      assert.deepEqual(r.all, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
