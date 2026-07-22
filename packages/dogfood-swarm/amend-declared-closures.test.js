/**
 * amend-declared-closures.test.js — collect on an amend wave closes the
 * findings its agents' fixes[] declare (observed in run swarm-1784601601-bd4a).
 *
 * The gap, proven live in that run: wave 3 (health-amend-a) collected clean
 * ("6 agent(s) accepted"), its agents' fixes[] named 9 of the run's 10
 * approved findings — and NOT ONE finding row transitioned. collect.js
 * validated fixes[] for shape (validateAmendOutput) and never read it again;
 * the rows stayed 'approved', so the next audit-class wave's classify sweep
 * (feature-audit, a lens that structurally cannot rediscover health findings)
 * demoted them approved -> unverified, twice, and the coordinator ended up
 * closing them by hand-editing the DB. The README's own lifecycle table
 * already promised "the amend's fix is what marks it fixed", and the v10 C3
 * contract (docs/trajectory-and-closure.dispatch.md) shipped the
 * closure_kind='declared' enum value for exactly this closure — this file
 * pins the promise to the mechanism.
 *
 * Invariants (RED -> GREEN):
 *   1. DECLARED CLOSURE: an amend agent that reaches 'complete' transitions
 *      its fixes[]-named approved findings to 'fixed' with
 *      closure_kind='declared', verified_how='self_attested',
 *      last_seen_wave = the amend wave, and one finding_events row
 *      (event_type='fixed', actor=the declaring domain).
 *   2. OWNERSHIP: a domain cannot close another domain's finding by naming
 *      its id — same one-rule authority as routing/vouching (F-18d0ef6d /
 *      F-8a15be4c lineage). The skip is surfaced, never silent.
 *   3. FAIL CLOSED: an unknown id and a non-approved id close nothing.
 *   4. IDEMPOTENT: a re-collect (the swarm redrive re-open path) does not
 *      double-close or double-event an already-fixed finding.
 *   5. FILE-LESS: a file-less finding is closable by precisely its filing
 *      domain (filed_by_domain), fail-closed when no filer is recorded.
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
import { applyDeclaredFixes } from './lib/declared-closures.js';

const RUN_ID = 'test-amend-declared';

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });
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
     description, recommendation, status, filed_by_domain)
    VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, ?, ?)`);
  insert.run(RUN_ID, 'F-A-001', 'fp-a-1', 'HIGH', 'packages/a/src/foo.js', 10, 'A finding', 'fix A1', 'approved', 'domain-a');
  insert.run(RUN_ID, 'F-B-001', 'fp-b-1', 'HIGH', 'packages/b/src/baz.js', 20, 'B finding', 'fix B1', 'approved', 'domain-b');
  // File-less pair for invariant 5: one with a recorded filer, one without.
  insert.run(RUN_ID, 'F-C-001', 'fp-c-1', 'MEDIUM', null, null, 'file-less, filed by a', null, 'approved', 'domain-a');
  insert.run(RUN_ID, 'F-D-001', 'fp-d-1', 'LOW', null, null, 'file-less, no filer', null, 'approved', null);
  return db;
}

function amendOutput(domain, fixes, extra = {}) {
  return JSON.stringify({
    domain,
    summary: `${domain} amend output (test fixture)`,
    fixes,
    files_changed: [],
    verification_skipped: true,
    ...extra,
  });
}

describe('amend collect — fixes[] declared closures (swarm-1784601601-bd4a gap 1a)', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'amend-declared-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath);
    dispatch({ runId: RUN_ID, phase: 'health-amend-a', dbPath, outputDir: tmpDir, skipVerify: true });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transitions fixes[]-named approved findings to fixed with declared-closure bookkeeping', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, amendOutput('domain-a', [{ finding_id: 'F-A-001', description: 'null check added' }]));
    writeFileSync(outB, amendOutput('domain-b', [{ finding_id: 'F-B-001', description: 'guard added' }]));

    const report = collect({ runId: RUN_ID, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const db = openDb(dbPath);
    for (const fid of ['F-A-001', 'F-B-001']) {
      const row = db.prepare(
        'SELECT status, closure_kind, verified_how, last_seen_wave FROM findings WHERE run_id = ? AND finding_id = ?'
      ).get(RUN_ID, fid);
      assert.equal(row.status, 'fixed',
        `${fid}: an amend agent's declared fix must close the finding — the README lifecycle table promises "the amend's fix is what marks it fixed"`);
      assert.equal(row.closure_kind, 'declared',
        `${fid}: closure_kind must be 'declared' (the C3 enum value shipped for exactly this closure)`);
      assert.equal(row.verified_how, 'self_attested',
        `${fid}: the declaring agent is also the verifier — verify-fixed's independent pass is what audits it`);
      assert.equal(row.last_seen_wave, report.waveId,
        `${fid}: the closing amend wave is the last wave that touched this finding`);

      const events = db.prepare(`
        SELECT fe.event_type, fe.wave_id, fe.agent_run_id, fe.actor FROM finding_events fe
        JOIN findings f ON f.id = fe.finding_id
        WHERE f.run_id = ? AND f.finding_id = ? AND fe.event_type = 'fixed'
      `).all(RUN_ID, fid);
      assert.equal(events.length, 1, `${fid}: exactly one 'fixed' event`);
      assert.equal(events[0].wave_id, report.waveId, `${fid}: event names the amend wave`);
      assert.ok(events[0].agent_run_id, `${fid}: event names the declaring agent_run`);
      assert.match(String(events[0].actor), /^domain-[ab]$/, `${fid}: actor is the declaring domain`);
    }
    db.close();

    // The wave summary tells the truth about what the amend closed.
    assert.equal(report.findings.fixed, 2, 'report.findings.fixed counts the declared closures');
    const agentA = report.agents.find(a => a.domain === 'domain-a');
    assert.equal(agentA.fixes_closed, 1, 'per-agent report carries the closed count');
  });

  it('refuses a cross-domain declaration: naming another domain\'s id closes nothing (surfaced, not silent)', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, amendOutput('domain-a', []));
    // domain-b declares domain-a's finding — the F-18d0ef6d cross-vouching shape.
    writeFileSync(outB, amendOutput('domain-b', [{ finding_id: 'F-A-001', description: 'not mine to close' }]));

    const report = collect({ runId: RUN_ID, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const db = openDb(dbPath);
    const row = db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-A-001');
    assert.equal(row.status, 'approved', 'a domain must not close a finding its globs do not cover');
    db.close();

    const agentB = report.agents.find(a => a.domain === 'domain-b');
    assert.ok(Array.isArray(agentB.fixes_skipped), 'the refused declaration is surfaced on the agent report');
    assert.equal(agentB.fixes_skipped[0].finding_id, 'F-A-001');
    assert.equal(agentB.fixes_skipped[0].reason, 'unowned');
  });

  it('fails closed on unknown and non-approved ids', () => {
    const db0 = openDb(dbPath);
    // A 'new' (not approved) finding in domain-a's territory: never routed to
    // an amend agent, so a declaration against it is refused.
    db0.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES (?, 'F-N-001', 'fp-n-1', 'LOW', 'quality', 'packages/a/src/new.js', 'unapproved', 'new')`)
      .run(RUN_ID);
    db0.close();

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, amendOutput('domain-a', [
      { finding_id: 'F-NOPE-99', description: 'hallucinated id' },
      { finding_id: 'F-N-001', description: 'not routed for amend' },
    ]));
    writeFileSync(outB, amendOutput('domain-b', []));

    const report = collect({ runId: RUN_ID, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const db = openDb(dbPath);
    assert.equal(
      db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-N-001').status,
      'new', 'a non-approved finding is not closable by declaration');
    db.close();

    const agentA = report.agents.find(a => a.domain === 'domain-a');
    const reasons = Object.fromEntries(agentA.fixes_skipped.map(s => [s.finding_id, s.reason]));
    assert.equal(reasons['F-NOPE-99'], 'unknown_id');
    assert.equal(reasons['F-N-001'], 'not_approved');
    assert.equal(agentA.fixes_closed, 0);
  });

  it('is idempotent: re-applying the same declaration neither re-flips nor double-events (redrive re-collect shape)', () => {
    const db = openDb(dbPath);
    const wave = db.prepare('SELECT id FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1').get(RUN_ID);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = ? LIMIT 1').get(wave.id);
    const domain = db.prepare("SELECT * FROM domains WHERE run_id = ? AND name = 'domain-a'").get(RUN_ID);
    const opts = {
      runId: RUN_ID, waveId: wave.id, agentRunId: ar.id,
      domainName: 'domain-a', domainGlobs: JSON.parse(domain.globs),
      fixes: [{ finding_id: 'F-A-001', description: 'once' }],
    };

    const first = applyDeclaredFixes(db, opts);
    assert.equal(first.closed.length, 1);

    const second = applyDeclaredFixes(db, opts);
    assert.equal(second.closed.length, 0, 'second pass closes nothing');
    assert.equal(second.skipped[0].reason, 'already_closed', 'second pass reports the no-op honestly');

    const events = db.prepare(`
      SELECT COUNT(*) AS n FROM finding_events fe JOIN findings f ON f.id = fe.finding_id
      WHERE f.run_id = ? AND f.finding_id = 'F-A-001' AND fe.event_type = 'fixed'
    `).get(RUN_ID);
    assert.equal(events.n, 1, 'exactly one fixed event across both passes');
    db.close();
  });

  it('closes a file-less finding via filed_by_domain, fail-closed when no filer is recorded', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, amendOutput('domain-a', [
      { finding_id: 'F-C-001', description: 'file-less, mine by filing' },
      { finding_id: 'F-D-001', description: 'file-less, nobody\'s' },
    ]));
    writeFileSync(outB, amendOutput('domain-b', []));

    collect({ runId: RUN_ID, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const db = openDb(dbPath);
    assert.equal(
      db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-C-001').status,
      'fixed', 'file-less finding closable by precisely its filing domain (F-8a15be4c rule, third call site)');
    assert.equal(
      db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-D-001').status,
      'approved', 'no recorded filer -> nobody can close it by declaration (honest answer, not a guess)');
    db.close();
  });
});
