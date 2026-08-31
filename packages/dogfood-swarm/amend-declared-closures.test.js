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
 *   6. READER HALF (F-a1e35a0d / #65): after collect records unknown_id on
 *      the agent report, `swarm status --format=json` and `swarm receipt
 *      --format=json` must also surface that skip (count + reason). Collect-
 *      report presence alone is not "surfaced".
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { applyDeclaredFixes } from './lib/declared-closures.js';

const RUN_ID = 'test-amend-declared';
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

/** Deep-walk status/receipt JSON for unknown_id skip signals (flexible shape). */
function collectUnknownIdSignals(node, acc = []) {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectUnknownIdSignals(item, acc);
    return acc;
  }
  if (node.reason === 'unknown_id') {
    acc.push({ finding_id: node.finding_id ?? null, reason: 'unknown_id' });
  }
  if (typeof node.unknown_id === 'number' && node.unknown_id > 0) {
    acc.push({ count: node.unknown_id, via: 'unknown_id_count' });
  }
  if (node.by_reason && typeof node.by_reason === 'object'
      && typeof node.by_reason.unknown_id === 'number'
      && node.by_reason.unknown_id > 0) {
    acc.push({ count: node.by_reason.unknown_id, via: 'by_reason.unknown_id' });
  }
  for (const value of Object.values(node)) {
    collectUnknownIdSignals(value, acc);
  }
  return acc;
}

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
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
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

  it('closes findings on uppercase-named files under uppercase globs (F-case-fold, run swarm-1788165870-6880 wave 2)', () => {
    // Observed live 2026-08-31: a public-surfaces domain owning README* / SHIP_GATE.md
    // could NEVER close findings on those files — normalizeFilePathForGlobMatch folds
    // the PATH to lowercase while matchesAnyGlob handed minimatch the RAW globs
    // case-sensitively, so 'readme.pypi.md' vs 'README*' skipped as unowned. Only the
    // all-lowercase 'grok.md' closed. Same trap class as F-00d67cb6 (path side) and
    // the open F-f347d858; the fix belongs in the one shared matcher.
    const db = openDb(dbPath);
    const wave = db.prepare('SELECT id FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1').get(RUN_ID);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = ? LIMIT 1').get(wave.id);
    const insert = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
       description, recommendation, status, filed_by_domain)
      VALUES (?, ?, ?, ?, 'docs', ?, ?, ?, ?, 'approved', 'public-surfaces')`);
    insert.run(RUN_ID, 'F-UC-001', 'fp-uc-1', 'HIGH', 'README.pypi.md', 98, 'stale claim', 'fix it');
    insert.run(RUN_ID, 'F-UC-002', 'fp-uc-2', 'LOW', 'SHIP_GATE.md', 47, 'stale receipt', 'refresh');
    insert.run(RUN_ID, 'F-UC-003', 'fp-uc-3', 'MEDIUM', 'npm/README.md', 65, 'stale line', 'fix it');

    const result = applyDeclaredFixes(db, {
      runId: RUN_ID, waveId: wave.id, agentRunId: ar.id,
      domainName: 'public-surfaces',
      domainGlobs: ['README*', 'SHIP_GATE.md', 'npm/README.md'],
      fixes: [
        { finding_id: 'F-UC-001', description: 'front door fixed' },
        { finding_id: 'F-UC-002', description: 'receipt refreshed' },
        { finding_id: 'F-UC-003', description: 'registry body fixed' },
      ],
    });
    assert.deepEqual(
      result.closed.map(c => c.finding_id).sort(),
      ['F-UC-001', 'F-UC-002', 'F-UC-003'],
      `uppercase-named files must close under their owner's uppercase globs; skipped: ${JSON.stringify(result.skipped)}`
    );

    // Case-insensitivity must WIDEN legitimate ownership, never weaken the refusal:
    // a different domain still cannot close them by naming ids.
    insert.run(RUN_ID, 'F-UC-004', 'fp-uc-4', 'LOW', 'ADVISOR.md', 1, 'stale fence', 'fix it');
    const foreign = applyDeclaredFixes(db, {
      runId: RUN_ID, waveId: wave.id, agentRunId: ar.id,
      domainName: 'domain-b', domainGlobs: ['packages/b/**'],
      fixes: [{ finding_id: 'F-UC-004', description: 'not mine to close' }],
    });
    assert.equal(foreign.closed.length, 0);
    assert.equal(foreign.skipped[0].reason, 'unowned', 'cross-domain refusal survives the case-fold fix');
    db.close();
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

  /** @pins F-a1e35a0d F-64e6da30 */
  it('surfaces unknown_id skips on swarm status and swarm receipt JSON (F-a1e35a0d reader half)', () => {
    const HALLUCINATED = 'F-NOPE-99';
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, amendOutput('domain-a', [
      { finding_id: HALLUCINATED, description: 'hallucinated id — must not vanish off coordinator surfaces' },
    ]));
    writeFileSync(outB, amendOutput('domain-b', []));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    // Writer half — keep the existing collect-report contract.
    const agentA = report.agents.find(a => a.domain === 'domain-a');
    assert.ok(Array.isArray(agentA.fixes_skipped), 'collect report still carries fixes_skipped');
    assert.equal(agentA.fixes_skipped[0].finding_id, HALLUCINATED);
    assert.equal(agentA.fixes_skipped[0].reason, 'unknown_id');

    // Reader half — status / receipt must make the same skip coordinator-visible.
    const statusResult = runCli(['status', RUN_ID, '--format=json'], dbPath);
    assert.equal(statusResult.status, 0,
      `swarm status --format=json must exit 0; stderr:\n${statusResult.stderr}`);
    let statusJson;
    assert.doesNotThrow(() => { statusJson = JSON.parse(statusResult.stdout); },
      `swarm status --format=json must be parseable; got:\n${statusResult.stdout}`);

    const receiptResult = runCli(['receipt', RUN_ID, '--format=json'], dbPath);
    assert.equal(receiptResult.status, 0,
      `swarm receipt --format=json must exit 0; stderr:\n${receiptResult.stderr}`);
    let receiptJson;
    assert.doesNotThrow(() => { receiptJson = JSON.parse(receiptResult.stdout); },
      `swarm receipt --format=json must be parseable; got:\n${receiptResult.stdout}`);

    for (const [label, parsed] of [['status', statusJson], ['receipt', receiptJson]]) {
      const blob = JSON.stringify(parsed);
      assert.ok(
        blob.includes('fixes_skipped') || blob.includes('unknown_id'),
        `${label} JSON must mention fixes_skipped or unknown_id — collect-report-only is not "surfaced"`,
      );
      const signals = collectUnknownIdSignals(parsed);
      assert.ok(
        signals.length > 0,
        `${label} JSON must expose an unknown_id skip signal (count and/or reason); got none in ${blob.slice(0, 500)}`,
      );
      const mentionsId = blob.includes(HALLUCINATED)
        || signals.some(s => s.finding_id === HALLUCINATED);
      const hasCount = signals.some(s => typeof s.count === 'number' && s.count > 0);
      assert.ok(
        mentionsId || hasCount,
        `${label} JSON must show the hallucinated id and/or a positive unknown_id count`,
      );
    }
  });
});
