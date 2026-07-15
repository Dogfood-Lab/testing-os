/**
 * wave2-swarm-cp-pins.test.js — Wave-2 (health-amend-a) swarm-cp regression pins.
 *
 * One pin per finding fixed in the wave-2 amend, each written test-first
 * against the pre-fix behavior. Gate-shaped fixes carry BOTH directions
 * (gate non-vacuity rule): the mutated/protected input makes the gate go
 * RED, and the healthy input still passes.
 *
 *   F-8efffdd1  revalidate --apply ingests corrected audit findings
 *   F-5811d6df  revalidate --apply propagates verification_skipped
 *   F-7d2f60e0  revalidate ownership re-check runs the independent git probe
 *   F-d12da6ea  advance Gate 4 enforces waves.serial_verify_required
 *   F-b22182da  status serial-verify check is scoped to the CURRENT wave
 *   F-00c35ce7  findings-digest reads the canonical wave-N/<domain>/output.json
 *   F-4ba6036b  ownership probe sees COMMITTED edits (baseRef union)
 *   F-f405dbd9  resume redispatch carries worktree isolation forward
 *   F-ec97601a  resume redispatch prompts carry the skip-verify directive
 *   F-aba6fa9d  missing agent output fails the wave (no false 'collected')
 *   F-6c5ee5dd  zero-findings audit wave still reclassifies priors
 *   F-cf8b7a6c  dispatch refuses while a wave is in flight
 *   F-527dc73e  worktree dir names carry the run-short slug (no collision)
 *   F-e7369293  terminal cleanup is run-scoped, not repo-wide
 *   F-b9a8f684  receipt reads the LATEST verification receipt
 *   F-5c562913  export verdict counts OPEN findings only
 *   F-3771ff90  state-machine override validates the target status
 *   F-832f8547  cross-run severity is rank-ordered, not alphabetical
 *   F-54cb35f4  clean dry-run JSON is internally consistent
 *   F-6a8a98d6  rejected-finding recurrence writes an explicit event
 *   F-aa32371b  unroutable approved findings are surfaced at dispatch
 *
 * Fix-up pass (post-fix lens ensemble verifier findings):
 *   V2-CONTRACT-001  repoknowledge bridge counts OPEN findings only
 *   V2-CONTRACT-002  receipt recommendation mirrors the serial-verify gate
 *   V2-CONTRACT-003  degraded committed-delta probe is surfaced (+ V2-INVARIAN-006)
 *   V2-INVARIAN-005  export receipt query gets the id DESC tiebreak
 *   V2-INVARIAN-002  narrowing is ONE shared helper for collect + revalidate
 *   V2-INVARIAN-001  committed worktree edits reach the collect seam end-to-end
 *   V2-INVARIAN-003  revalidate-ingested findings recur with fingerprint parity
 *   V2-CONTRACT-006  clean.js consumes the canonical runShortOf
 *   V2-CONTRACT-007  no raw control bytes in package sources
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb, openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains, narrowToExclusivelyOwned } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { revalidate } from './commands/revalidate.js';
import { resume } from './commands/resume.js';
import { status } from './commands/status.js';
import { buildReceipt } from './commands/receipt.js';
import { clean } from './commands/clean.js';
import { checkGates, advance, recordPromotion } from './lib/advance.js';
import { transitionAgent } from './lib/state-machine.js';
import { StateMachineRejectionError, DispatchPreconditionError } from './lib/errors.js';
import { createWorktree, listWorktrees, cleanupRunWorktrees, runShortOf } from './lib/worktree.js';
import { getActualTouchedFiles, resolveWorktreeBaseRef } from './lib/git-touched-files.js';
import { loadDomainOutputs, renderWithStatus } from './lib/findings-digest.js';
import { upsertFindings } from './lib/fingerprint.js';
import { computeRunVerdict, buildRunExport } from './lib/persist/export.js';
import { buildAuditPayload } from './lib/persist/repoknowledge-bridge.js';
import { queryRecurringFindings } from './lib/queries/cross-run-analytics.js';

const PKG_ROOT = fileURLToPath(new URL('.', import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t.t']);
  git(repoPath, ['config', 'user.name', 't']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoPath, '.gitignore'), '.swarm/\n');
  writeFileSync(join(repoPath, 'README.md'), 'seed\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'seed']);
  return git(repoPath, ['rev-parse', 'HEAD']).trim();
}

/**
 * File-backed run fixture with two owned domains, mirroring the
 * stage-c-truth-pins setup. Returns the seed commit sha.
 */
function setupRun(dbPath, repoPath, runId, { findings = true, commitSha } = {}) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(runId, 'org/repo', repoPath, commitSha || 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);
  if (findings) {
    const insert = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
       description, recommendation, status)
      VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);
    insert.run(runId, 'F-A-001', 'fp-a-1', 'HIGH', 'packages/a/src/foo.js', 10, 'A finding', 'fix A1');
    insert.run(runId, 'F-B-001', 'fp-b-1', 'HIGH', 'packages/b/src/baz.js', 20, 'B finding', 'fix B1');
  }
  return db;
}

function writeAmendOutput(path, domain, findingId, extra = {}) {
  writeFileSync(path, JSON.stringify({
    domain,
    summary: 'done',
    fixes: [{ finding_id: findingId, description: 'fixed it' }],
    files_changed: [],
    ...extra,
  }));
}

// ───────────────────────────────────────────────────────
// F-8efffdd1 — revalidate --apply ingests corrected audit findings
// ───────────────────────────────────────────────────────

describe('F-8efffdd1 — revalidate --apply ingests findings from a corrected audit output', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-reval-ingest-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-ingest', { findings: false });
    dispatch({ runId: 'r-ingest', phase: 'health-audit-a', dbPath, outputDir: tmp });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('repaired findings land in the findings table and the severity gate goes RED', () => {
    // domain-a writes garbage (blocks as invalid_output); domain-b is clean
    // with zero findings.
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, 'NOT JSON {{{');
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
    collect({ runId: 'r-ingest', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    // Operator repairs domain-a's output — it carries a HIGH finding.
    const corrected = join(tmp, 'a-corrected.json');
    writeFileSync(corrected, JSON.stringify({
      domain: 'domain-a',
      stage: 'A',
      summary: 'audit complete',
      findings: [{
        id: 'F-REPAIRED-1',
        severity: 'HIGH', category: 'bug', file: 'packages/a/src/foo.js', line: 3,
        description: 'repaired-output finding — must reach the control plane',
      }],
    }));
    const report = revalidate({
      runId: 'r-ingest', dbPath, reason: 'schema repair',
      outputs: { 'domain-a': corrected }, apply: true,
    });
    assert.equal(report.waveStatusAfter, 'collected', 'wave recovers to collected');

    // GATE GOES RED: the ingested HIGH finding must block advancement.
    const db = openDb(dbPath);
    const rows = db.prepare("SELECT * FROM findings WHERE run_id = 'r-ingest'").all();
    assert.equal(rows.length, 1, 'the corrected output finding must be upserted');
    assert.equal(rows[0].severity, 'HIGH');
    assert.equal(rows[0].status, 'new');

    const gates = checkGates(db, 'r-ingest');
    assert.equal(gates.verdict, 'AMEND',
      'severity gate must see the repaired finding (pre-fix: silent ADVANCE)');
  });

  it('healthy path: a corrected output with zero findings still recovers and ADVANCEs', () => {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, 'NOT JSON {{{');
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
    collect({ runId: 'r-ingest', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const corrected = join(tmp, 'a-clean.json');
    writeFileSync(corrected, JSON.stringify({ domain: 'domain-a', stage: 'A', summary: 'clean', findings: [] }));
    revalidate({
      runId: 'r-ingest', dbPath, reason: 'schema repair',
      outputs: { 'domain-a': corrected }, apply: true,
    });

    const db = openDb(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id = 'r-ingest'").get().n, 0);
    assert.equal(checkGates(db, 'r-ingest').verdict, 'ADVANCE');
  });
});

// ───────────────────────────────────────────────────────
// F-5811d6df — revalidate propagates verification_skipped
// ───────────────────────────────────────────────────────

describe('F-5811d6df — revalidate --apply propagates the serial-verify discipline signal', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-reval-vskip-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-vskip');
    dispatch({ runId: 'r-vskip', phase: 'health-amend-a', dbPath, outputDir: tmp, skipVerify: true });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('mirrors collect: agent_runs.verification_skipped=1 and waves.serial_verify_required=1', () => {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, 'NOT JSON {{{');
    writeAmendOutput(outB, 'domain-b', 'F-B-001', { verification_skipped: true });
    collect({ runId: 'r-vskip', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const corrected = join(tmp, 'a-corrected.json');
    writeAmendOutput(corrected, 'domain-a', 'F-A-001', { verification_skipped: true });
    revalidate({
      runId: 'r-vskip', dbPath, reason: 'repair', outputs: { 'domain-a': corrected }, apply: true,
    });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-vskip' ORDER BY wave_number DESC LIMIT 1").get();
    assert.equal(wave.serial_verify_required, 1,
      'the wave-level TRUTH-001 signal must survive a revalidate recovery');
    const ar = db.prepare(`
      SELECT ar.verification_skipped FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ? AND d.name = 'domain-a'
      ORDER BY ar.id DESC LIMIT 1
    `).get(wave.id);
    assert.equal(ar.verification_skipped, 1, 'the per-agent TRUTH-003 signal must be set');
  });
});

// ───────────────────────────────────────────────────────
// F-7d2f60e0 — revalidate runs the independent git probe
// ───────────────────────────────────────────────────────

describe('F-7d2f60e0 — revalidate ownership re-check cannot be gamed via files_changed', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-reval-probe-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-probe');
    dispatch({ runId: 'r-probe', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('REFUSES the repair while the out-of-domain edit remains in the worktree', () => {
    const db0 = openDb(dbPath);
    const arA = db0.prepare(`
      SELECT ar.* FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id = 'r-probe' AND d.name = 'domain-a'
    `).get();
    assert.ok(arA.worktree_path, 'precondition: isolate gave domain-a a worktree');

    // The agent actually edits OUT of its domain in the worktree (staged, so
    // the porcelain probe reports the full path rather than collapsing the
    // untracked directory)...
    mkdirSync(join(arA.worktree_path, 'packages', 'b'), { recursive: true });
    writeFileSync(join(arA.worktree_path, 'packages', 'b', 'hack.js'), '// out of domain\n');
    git(arA.worktree_path, ['add', '-A']);
    // ...and confesses in files_changed, so collect blocks it.
    const outA = join(tmp, 'a.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001', { files_changed: ['packages/b/hack.js'] });
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    collect({ runId: 'r-probe', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
    const blocked = openDb(dbPath).prepare('SELECT status FROM agent_runs WHERE id = ?').get(arA.id);
    assert.equal(blocked.status, 'ownership_violation', 'precondition: collect blocked the agent');

    // The gamed repair: files_changed edited to drop the path, edit still on disk.
    const gamed = join(tmp, 'a-gamed.json');
    writeAmendOutput(gamed, 'domain-a', 'F-A-001', { files_changed: [] });
    const report = revalidate({
      runId: 'r-probe', dbPath, reason: 'trying to slip through',
      outputs: { 'domain-a': gamed }, apply: true,
    });
    assert.equal(report.repairs.length, 0, 'gamed repair must not be planned');
    assert.equal(report.refusals.length, 1, 'gamed repair must be refused');
    assert.match(report.refusals[0].reason, /ownership/i);
    assert.match(report.refusals[0].reason, /packages\/b\/hack\.js/);
  });
});

// ───────────────────────────────────────────────────────
// F-d12da6ea — advance Gate 4 enforces serial_verify_required
// ───────────────────────────────────────────────────────

describe('F-d12da6ea — the advancement gate refuses a --skip-verify wave with no passing verify', () => {
  let db;

  function seed(runId, { serialVerify = 1, receipt = null } = {}) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status, serial_verify_required) VALUES (?, 'health-audit-a', 1, 'collected', ?)"
    ).run(runId, serialVerify);
    const waveId = Number(wave.lastInsertRowid);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, dom.id);
    if (receipt) {
      db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed)
        VALUES (?, 'node', '["npm test"]', ?, ?)`).run(waveId, receipt.passed ? 0 : 1, receipt.passed ? 1 : 0);
    }
    return waveId;
  }

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('GATE RED: verdict VERIFY, non-overridable — even `advance --override` cannot promote', () => {
    seed('r1');
    const gates = checkGates(db, 'r1');
    assert.equal(gates.verdict, 'VERIFY',
      'a --skip-verify wave with no receipt must land on the VERIFY verdict');
    assert.equal(gates.overridable, false, 'the serial-verify gate is NOT overridable');

    const result = advance(db, 'r1', { override: true, overrideReason: 'trying to skip the mandatory verify' });
    assert.equal(result.promoted, false,
      'pre-fix: this promoted with zero verification anywhere in the wave');
    assert.equal(result.verdict, 'VERIFY');
  });

  it('GATE RED on a FAILED receipt too', () => {
    seed('r2', { receipt: { passed: false } });
    const gates = checkGates(db, 'r2');
    assert.equal(gates.verdict, 'VERIFY');
  });

  it('GATE GREEN: a passing receipt for THIS wave satisfies the obligation', () => {
    seed('r3', { receipt: { passed: true } });
    assert.equal(checkGates(db, 'r3').verdict, 'ADVANCE');
  });

  it('healthy input: a wave WITHOUT the obligation still treats verify as optional', () => {
    seed('r4', { serialVerify: 0 });
    assert.equal(checkGates(db, 'r4').verdict, 'ADVANCE');
  });
});

// ───────────────────────────────────────────────────────
// F-b22182da — status serial-verify check scoped to the current wave
// ───────────────────────────────────────────────────────

describe('F-b22182da — a stale receipt from a PRIOR wave cannot satisfy the current wave', () => {
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-status-scope-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r-2wave', 'org/r', tmp, 'a'.repeat(40));
    saveDomainDraft(db, 'r-2wave', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r-2wave');
    const dom = db.prepare("SELECT id FROM domains WHERE run_id = 'r-2wave'").get();

    // Wave 1: verified-pass (this is the STALE receipt).
    const w1 = Number(db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r-2wave', 'health-amend-a', 1, 'advanced')"
    ).run().lastInsertRowid);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')").run(w1, dom.id);
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, created_at)
      VALUES (?, 'node', '["npm test"]', 0, 1, '2026-01-01 00:00:00')`).run(w1);

    // Wave 2: --skip-verify, collected, NEVER verified.
    const w2 = Number(db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status, serial_verify_required) VALUES ('r-2wave', 'health-amend-a', 2, 'collected', 1)"
    ).run().lastInsertRowid);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')").run(w2, dom.id);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: shows VERIFY REQUIRED, not READY TO ADVANCE (the TRUTH-001 false claim)', () => {
    const s = status({ runId: 'r-2wave', dbPath });
    assert.equal(s.assessment.state, 'VERIFY REQUIRED',
      'wave-1 receipt must not satisfy wave-2 (pre-fix: run-wide latest receipt leaked across waves)');
    assert.equal(s.lastVerification, null,
      'the display block must not render the prior wave\'s receipt as this wave\'s verification');
  });

  it('GATE GREEN: a passing receipt for wave 2 itself clears the refusal', () => {
    const db = openDb(dbPath);
    const w2 = db.prepare("SELECT id FROM waves WHERE run_id = 'r-2wave' AND wave_number = 2").get();
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed)
      VALUES (?, 'node', '["npm test"]', 0, 1)`).run(w2.id);
    const s = status({ runId: 'r-2wave', dbPath });
    assert.equal(s.assessment.state, 'READY TO ADVANCE');
    assert.equal(s.lastVerification.passed, true);
  });
});

// ───────────────────────────────────────────────────────
// F-00c35ce7 — findings-digest canonical layout
// ───────────────────────────────────────────────────────

describe('F-00c35ce7 — findings-digest reads the canonical wave-N/<domain>/output.json layout', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'w2-digest-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('a canonical-layout wave is NOT classified pipeline_broken', () => {
    const waveDir = join(tmp, 'wave-1');
    mkdirSync(join(waveDir, 'backend'), { recursive: true });
    writeFileSync(join(waveDir, 'backend.md'), '# prompt');
    writeFileSync(join(waveDir, 'backend', 'output.json'), JSON.stringify({
      domain: 'backend', summary: 'ok',
      findings: [{ id: 'F-1', severity: 'HIGH', category: 'bug', description: 'x' }],
    }));

    const outputs = loadDomainOutputs(waveDir);
    assert.equal(outputs.length, 1, 'canonical subdirectory output must be loaded');
    assert.equal(outputs[0].domain, 'backend');
    assert.ok(!outputs[0].parseError);

    const { status: digestStatus, exitCode } = renderWithStatus('r-x', 1, outputs);
    assert.notEqual(digestStatus, 'pipeline_broken',
      'pre-fix: a healthy canonical wave rendered "THIS IS NOT A CLEAN WAVE" with exit 2');
    assert.equal(exitCode, 1, 'findings present → CI exit 1');
  });

  it('mixed dir: canonical subdirs and legacy flat <domain>.json both load; reserved names skipped', () => {
    const waveDir = join(tmp, 'wave-2');
    mkdirSync(join(waveDir, 'backend'), { recursive: true });
    writeFileSync(join(waveDir, 'backend', 'output.json'), JSON.stringify({ domain: 'backend', findings: [] }));
    writeFileSync(join(waveDir, 'docs.json'), JSON.stringify({ domain: 'docs', findings: [] }));
    writeFileSync(join(waveDir, 'manifest.json'), '{}');
    mkdirSync(join(waveDir, 'empty-dir'));

    const outputs = loadDomainOutputs(waveDir);
    // F-197de6dd (wave 4): a subdirectory WITHOUT output.json is a domain
    // whose agent never reported — it now surfaces as a parseError entry
    // (pipeline_broken) instead of being silently skipped.
    assert.deepEqual(outputs.map(o => o.domain).sort(), ['backend', 'docs', 'empty-dir']);
    const emptyDir = outputs.find(o => o.domain === 'empty-dir');
    assert.match(emptyDir.parseError, /output\.json missing/);
    assert.ok(!outputs.find(o => o.domain === 'backend').parseError);
    assert.ok(!outputs.find(o => o.domain === 'docs').parseError);
  });
});

// ───────────────────────────────────────────────────────
// F-4ba6036b — committed edits stay visible to the ownership probe
// ───────────────────────────────────────────────────────

describe('F-4ba6036b — getActualTouchedFiles sees committed edits via baseRef', () => {
  let repo, baseSha;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'w2-touched-'));
    baseSha = initGitRepo(repo);
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('GATE RED without baseRef, GREEN with: a committed edit is invisible to status alone', () => {
    writeFileSync(join(repo, 'committed.js'), 'edit\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'agent committed its work']);

    const statusOnly = getActualTouchedFiles(repo);
    assert.equal(statusOnly.all.length, 0,
      'sanity: the committed edit is invisible to the status-only probe (the pre-fix bypass)');

    const withBase = getActualTouchedFiles(repo, { baseRef: baseSha });
    assert.ok(withBase.all.includes('committed.js'),
      'the committed delta must be unioned into the touched set');
  });

  it('uncommitted + untracked files still show with baseRef supplied', () => {
    writeFileSync(join(repo, 'README.md'), 'modified\n');
    writeFileSync(join(repo, 'untracked.js'), 'new\n');
    const t = getActualTouchedFiles(repo, { baseRef: baseSha });
    assert.ok(t.all.includes('README.md'));
    assert.ok(t.all.includes('untracked.js'));
  });

  it('a bad baseRef degrades loudly, not silently', () => {
    const t = getActualTouchedFiles(repo, { baseRef: 'no-such-ref-xyz' });
    assert.equal(t.baseDiffUnavailable, true);
  });

  it('resolveWorktreeBaseRef resolves the worktree branch point, not current main HEAD', () => {
    const { worktreePath } = createWorktree(repo, { runId: 'swarm-base', waveNumber: 1, domainName: 'backend' });
    const branchPoint = git(repo, ['rev-parse', 'HEAD']).trim();
    // main advances AFTER the fork (another wave's merge).
    writeFileSync(join(repo, 'main-moved.js'), 'x\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main advanced']);
    // agent commits in its worktree
    writeFileSync(join(worktreePath, 'agent.js'), 'y\n');
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-q', '-m', 'agent work']);

    const base = resolveWorktreeBaseRef(worktreePath, 'main');
    assert.equal(base, branchPoint, 'base must be the fork point (dispatch-time HEAD)');
    const t = getActualTouchedFiles(worktreePath, { baseRef: base });
    assert.ok(t.all.includes('agent.js'), 'the agent\'s committed edit is attributed');
    assert.ok(!t.all.includes('main-moved.js'),
      'main\'s post-fork commit must NOT be attributed to this agent');
  });
});

// ───────────────────────────────────────────────────────
// F-f405dbd9 + F-ec97601a — resume redispatch: isolation + skip-verify carry forward
// ───────────────────────────────────────────────────────

describe('F-f405dbd9 / F-ec97601a — redispatch carries isolation and the skip-verify directive', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-resume-iso-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    const sha = initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-resume', { commitSha: sha });
    dispatch({
      runId: 'r-resume', phase: 'health-amend-a', dbPath, outputDir: tmp,
      isolate: true, skipVerify: true,
    });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('a timed-out isolated agent is redispatched WITH a worktree and a skip-verify prompt', () => {
    // Far-future clock: every dispatched agent times out, forcing redispatch.
    const report = resume({
      runId: 'r-resume', dbPath, outputDir: tmp,
      nowMs: Date.now() + 24 * 60 * 60 * 1000,
    });
    assert.equal(report.action, 'redispatched');
    assert.ok(report.redispatch.length >= 1);

    const db = openDb(dbPath);
    for (const rd of report.redispatch) {
      const newAr = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(rd.newAgentRunId);
      assert.ok(newAr.worktree_path,
        `F-f405dbd9: redispatched ${rd.domain} must carry worktree_path (pre-fix: NULL → shared-tree edits)`);
      assert.ok(newAr.worktree_branch, 'worktree_branch must be carried');
      assert.ok(existsSync(newAr.worktree_path), 'the recreated worktree must exist on disk');

      const prompt = readFileSync(rd.promptPath, 'utf-8');
      assert.match(prompt, /verification_skipped/,
        `F-ec97601a: redispatched ${rd.domain} prompt must carry the SKIP_VERIFY_DIRECTIVE`);
      assert.match(prompt, /Do NOT run per-agent verification/);
    }
  });
});

// ───────────────────────────────────────────────────────
// F-aba6fa9d — missing output fails the wave
// ───────────────────────────────────────────────────────

describe('F-aba6fa9d — a missing agent output fails the wave instead of overstating success', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-missing-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-missing');
    dispatch({ runId: 'r-missing', phase: 'health-amend-a', dbPath, outputDir: tmp });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: wave → failed, missing agent named, accepted count honest', () => {
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    const report = collect({
      runId: 'r-missing', dbPath,
      outputs: { 'domain-a': join(tmp, 'does-not-exist.json'), 'domain-b': outB },
    });
    assert.equal(report.waveStatusAfter, 'failed',
      'pre-fix: the wave landed "collected" with a failed agent inside it');
    assert.equal(report.missing_outputs.length, 1);
    assert.equal(report.missing_outputs[0].domain, 'domain-a');

    const db = openDb(dbPath);
    const ev = db.prepare(`
      SELECT reason FROM wave_state_events WHERE wave_id =
        (SELECT id FROM waves WHERE run_id = 'r-missing' ORDER BY wave_number DESC LIMIT 1)
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.match(ev.reason, /missing output/, 'the transition reason must name the missing output');
    assert.match(ev.reason, /redrive/, 'the recovery verb must be named');
  });

  it('healthy input: all outputs present still collects', () => {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    const report = collect({ runId: 'r-missing', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
    assert.equal(report.waveStatusAfter, 'collected');
  });
});

// ───────────────────────────────────────────────────────
// F-6c5ee5dd — clean audit wave still reclassifies priors
// ───────────────────────────────────────────────────────

describe('F-6c5ee5dd — a zero-findings audit wave reclassifies prior findings', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-cleanwave-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    const db = setupRun(dbPath, repoPath, 'r-clean', { findings: false });
    // A prior open finding the clean re-audit does NOT rediscover.
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES ('r-clean', 'F-P-001', 'fp-prior-1', 'HIGH', 'bug', 'packages/a/x.js', 'old defect', 'new')`).run();
    dispatch({ runId: 'r-clean', phase: 'health-audit-a', dbPath, outputDir: tmp });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('the non-rediscovered prior is reclassified with a finding_events row', () => {
    // CP4-SCOPE-WIRING (wave 4) upgraded this pin's expectation: this wave
    // dispatches EVERY owned domain and both agents complete, so the wave is
    // FULL coverage and the absent prior is positive evidence of `fixed`
    // (pre-CP4 it landed `unverified` because collect never passed a scope).
    // The original F-6c5ee5dd property — a clean wave still RECLASSIFIES
    // priors instead of skipping the pass — is unchanged.
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, JSON.stringify({ domain: 'domain-a', stage: 'A', summary: 'clean', findings: [] }));
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
    const report = collect({ runId: 'r-clean', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
    assert.equal(report.findings.fixed, 1,
      'pre-fix: the classification pass was skipped entirely when allFindings was empty');
    assert.equal(report.findings.unverified, 0);

    const db = openDb(dbPath);
    const f = db.prepare("SELECT * FROM findings WHERE run_id = 'r-clean'").get();
    assert.equal(f.status, 'fixed');
    const ev = db.prepare('SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id DESC LIMIT 1').get(f.id);
    assert.equal(ev.event_type, 'fixed', 'the clean wave must leave an audit-trail event');
  });
});

// ───────────────────────────────────────────────────────
// F-cf8b7a6c — dispatch refuses while a wave is in flight
// ───────────────────────────────────────────────────────

describe('F-cf8b7a6c — dispatch refuses to strand an in-flight wave', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-inflight-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-flight');
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: a second dispatch while wave 1 is dispatched throws DISPATCH_WAVE_IN_FLIGHT', () => {
    dispatch({ runId: 'r-flight', phase: 'health-audit-a', dbPath, outputDir: tmp });
    assert.throws(
      () => dispatch({ runId: 'r-flight', phase: 'health-audit-a', dbPath, outputDir: tmp }),
      (e) => e instanceof DispatchPreconditionError && e.code === 'DISPATCH_WAVE_IN_FLIGHT'
        && /collect/.test(e.hint),
      'pre-fix: the double-dispatch silently orphaned wave 1 forever'
    );
    const db = openDb(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM waves WHERE run_id = 'r-flight'").get().n, 1,
      'no second wave row may be created');
  });

  it('healthy input: dispatch after collect proceeds', () => {
    dispatch({ runId: 'r-flight', phase: 'health-audit-a', dbPath, outputDir: tmp });
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, JSON.stringify({ domain: 'domain-a', summary: 'clean', findings: [] }));
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', summary: 'clean', findings: [] }));
    collect({ runId: 'r-flight', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
    const second = dispatch({ runId: 'r-flight', phase: 'health-audit-b', dbPath, outputDir: tmp });
    assert.equal(second.waveNumber, 2);
  });
});

// ───────────────────────────────────────────────────────
// F-527dc73e — worktree path collision between runs
// ───────────────────────────────────────────────────────

describe('F-527dc73e — two runs\' worktrees cannot collide on the same path', () => {
  let repo;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'w2-wtcollide-')); initGitRepo(repo); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('run B\'s createWorktree does not destroy run A\'s live worktree', () => {
    const a = createWorktree(repo, { runId: 'swarm-111111111111-aaaa', waveNumber: 1, domainName: 'backend' });
    writeFileSync(join(a.worktreePath, 'uncommitted-agent-work.js'), 'precious\n');

    const b = createWorktree(repo, { runId: 'swarm-222222222222-bbbb', waveNumber: 1, domainName: 'backend' });
    assert.notEqual(a.worktreePath, b.worktreePath,
      'pre-fix: identical w1-backend paths — B\'s stale-cleanup force-removed A\'s live worktree');
    assert.ok(existsSync(join(a.worktreePath, 'uncommitted-agent-work.js')),
      'run A\'s uncommitted agent edits must survive run B\'s dispatch');
    assert.ok(a.worktreePath.includes(runShortOf('swarm-111111111111-aaaa')),
      'the run-short slug is part of the directory name');
  });
});

// ───────────────────────────────────────────────────────
// F-e7369293 — terminal cleanup is run-scoped
// ───────────────────────────────────────────────────────

describe('F-e7369293 — completing run A leaves run B\'s worktrees alone', () => {
  let repo, db;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'w2-scoped-clean-'));
    initGitRepo(repo);
    db = openMemoryDb();
  });
  afterEach(() => { db.close(); rmSync(repo, { recursive: true, force: true }); });

  function seedRun(runId) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', repo, 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'treatment', 1, 'collected')"
    ).run(runId);
    const waveId = Number(wave.lastInsertRowid);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')").run(waveId, dom.id);
    return waveId;
  }

  it('run-A terminal promotion removes ONLY run-A worktrees', () => {
    const waveA = seedRun('swarm-aaaa1');
    seedRun('swarm-bbbb2');
    const wtA = createWorktree(repo, { runId: 'swarm-aaaa1', waveNumber: 1, domainName: 'backend' });
    const wtB = createWorktree(repo, { runId: 'swarm-bbbb2', waveNumber: 1, domainName: 'backend' });
    writeFileSync(join(wtB.worktreePath, 'in-flight.js'), 'unmerged\n');

    recordPromotion(db, 'swarm-aaaa1', waveA, 'treatment', 'complete', {
      gates: [{ name: 'g', passed: true }],
    });

    assert.ok(!existsSync(wtA.worktreePath), 'run A\'s worktree is reclaimed');
    assert.ok(existsSync(wtB.worktreePath),
      'pre-fix: cleanupAllWorktrees swept run B\'s in-flight worktree too');
    assert.ok(existsSync(join(wtB.worktreePath, 'in-flight.js')), 'run B\'s edits survive');

    // F-1ab3fd1f (wave 4): the run-scoped helper now SKIPS run B's DIRTY
    // worktree instead of force-destroying the uncommitted edit — the guard
    // this pin's original `removed: 1` expectation predated.
    const guarded = cleanupRunWorktrees(repo, 'swarm-bbbb2');
    assert.equal(guarded.skipped, 1, 'dirty worktree must be preserved, not removed');
    assert.equal(guarded.removed, 0);
    assert.ok(existsSync(join(wtB.worktreePath, 'in-flight.js')));

    // Once the dirty edit is disposed of, the clean worktree is reclaimable.
    rmSync(join(wtB.worktreePath, 'in-flight.js'));
    const outcome = cleanupRunWorktrees(repo, 'swarm-bbbb2');
    assert.equal(outcome.removed, 1);
    assert.equal(listWorktrees(repo).length, 0);
  });
});

// ───────────────────────────────────────────────────────
// F-b9a8f684 — receipt reads the LATEST verification receipt
// ───────────────────────────────────────────────────────

describe('F-b9a8f684 — receipt and advance agree after a fail-then-pass verify sequence', () => {
  let tmp, dbPath, repoPath;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-receipt-order-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    const db = setupRun(dbPath, repoPath, 'r-rcpt', { findings: false });
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r-rcpt', 'health-audit-a', 1, 'collected')"
    ).run();
    const waveId = Number(wave.lastInsertRowid);
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, created_at)
      VALUES (?, 'node', '["npm test"]', 1, 0, '2026-01-01 00:00:00')`).run(waveId);
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, created_at)
      VALUES (?, 'node', '["npm test"]', 0, 1, '2026-01-02 00:00:00')`).run(waveId);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('the durable receipt renders the NEWEST row (pass), matching Gate 4', () => {
    const receipt = buildReceipt({ runId: 'r-rcpt', dbPath });
    assert.equal(receipt.verification.passed, true,
      'pre-fix: bare .get() returned the OLDEST row — receipt said FAIL while advance passed');
  });

  // V2-INVARIAN-005 — the export's receipt query was the fourth site missing
  // the id DESC tiebreak this wave applied to receipt/status/advance.
  it('V2-INVARIAN-005: same-second fail-then-pass — the export picks the newest receipt', () => {
    const db = openDb(dbPath);
    const wave = db.prepare("SELECT id FROM waves WHERE run_id = 'r-rcpt'").get();
    // Newest pair shares one created_at second: fail inserted first, pass second.
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, created_at)
      VALUES (?, 'node', '["npm test"]', 1, 0, '2026-01-03 00:00:00')`).run(wave.id);
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, created_at)
      VALUES (?, 'node', '["npm test"]', 0, 1, '2026-01-03 00:00:00')`).run(wave.id);

    const exp = buildRunExport(db, 'r-rcpt');
    assert.equal(exp.waves[0].verification.passed, true,
      'pre-fix: created_at-only ordering tied on the same second and surfaced the FAIL row');
    // And the durable receipt (already id DESC) agrees — one DB truth.
    const receipt = buildReceipt({ runId: 'r-rcpt', dbPath });
    assert.equal(receipt.verification.passed, true);
  });
});

// ───────────────────────────────────────────────────────
// F-5c562913 — verdict over OPEN findings only
// ───────────────────────────────────────────────────────

describe('F-5c562913 — computeRunVerdict counts OPEN findings only', () => {
  const base = (items) => ({
    run: { status: 'health-audit-a' },
    findings: { summary: { total: items.length }, items },
  });

  it('a FIXED critical no longer forces fail', () => {
    const v = computeRunVerdict(base([
      { severity: 'CRITICAL', status: 'fixed' },
      { severity: 'LOW', status: 'new' },
    ]));
    assert.equal(v, 'partial',
      'pre-fix: by_severity counted the fixed CRITICAL → mid-run persist wrote overall FAIL to the corpus');
  });

  it('an open CRITICAL still fails (gate can go red)', () => {
    assert.equal(computeRunVerdict(base([{ severity: 'CRITICAL', status: 'new' }])), 'fail');
  });

  it('all findings closed → pass', () => {
    assert.equal(computeRunVerdict(base([
      { severity: 'CRITICAL', status: 'fixed' },
      { severity: 'HIGH', status: 'rejected' },
      { severity: 'LOW', status: 'deferred' },
    ])), 'pass');
  });

  // V2-CONTRACT-001 — the THIRD unmigrated consumer of findings.summary:
  // buildRepoKnowledgeExport / buildAuditPayload still counted CLOSED findings
  // into criticalCount/highCount → overall_status / blocking_release.
  const rkExport = (items) => ({
    run: {
      id: 'r-rk', repo: 'org/r', commit_sha: 'a'.repeat(40), branch: 'main',
      status: 'health-audit-a', created: '2026-01-01', completed: null,
    },
    findings: {
      summary: {
        total: items.length,
        by_severity: items.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {}),
        by_status: items.reduce((m, f) => ((m[f.status] = (m[f.status] || 0) + 1), m), {}),
      },
      items,
    },
    verification: [],
    waves: [],
    promotions: [],
  });

  it('V2-CONTRACT-001: a FIXED critical must not export blocking_release:true', () => {
    const { run, metrics } = buildAuditPayload(rkExport([
      { severity: 'CRITICAL', status: 'fixed', category: 'bug', description: 'closed defect' },
    ]));
    assert.equal(run.blocking_release, false,
      'pre-fix: by_severity counted the FIXED critical into the audit-DB release gate');
    assert.notEqual(run.overall_status, 'fail');
    assert.equal(metrics.critical_count, 0, 'metrics mirror the open-only gate semantics');
  });

  it('V2-CONTRACT-001: an OPEN critical still blocks (gate can go red)', () => {
    const { run, metrics } = buildAuditPayload(rkExport([
      { severity: 'CRITICAL', status: 'new', category: 'bug', description: 'live defect' },
    ]));
    assert.equal(run.blocking_release, true);
    assert.equal(run.overall_status, 'fail');
    assert.equal(metrics.critical_count, 1);
  });
});

// ───────────────────────────────────────────────────────
// F-3771ff90 — override target validation
// ───────────────────────────────────────────────────────

describe('F-3771ff90 — the override path validates the target status', () => {
  let db;
  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'dispatched')"
    ).run();
    const dom = db.prepare("SELECT id FROM domains WHERE run_id = 'r1'").get();
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'invalid_output')")
      .run(Number(wave.lastInsertRowid), dom.id);
  });
  afterEach(() => { db.close(); });

  it('GATE RED: a non-canonical override target throws instead of writing garbage', () => {
    const ar = db.prepare('SELECT id FROM agent_runs').get();
    assert.throws(
      () => transitionAgent(db, ar.id, 'totally-bogus-status', 'operator says so', true),
      (e) => e instanceof StateMachineRejectionError && /not a canonical agent status/.test(e.message),
      'pre-fix: executeTransition wrote ANY string into agent_runs.status'
    );
    assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(ar.id).status,
      'invalid_output', 'the row must be untouched');
  });

  it('healthy input: a canonical override target still works', () => {
    const ar = db.prepare('SELECT id FROM agent_runs').get();
    const r = transitionAgent(db, ar.id, 'complete', 'lawful repair', true);
    assert.equal(r.to, 'complete');
  });
});

// ───────────────────────────────────────────────────────
// F-832f8547 — cross-run severity ranking
// ───────────────────────────────────────────────────────

describe('F-832f8547 — cross-run recurring severity is the MOST SEVERE observation', () => {
  it('CRITICAL in one run + MEDIUM in another reports CRITICAL, not the alphabetical MEDIUM', () => {
    const db = openMemoryDb();
    for (const [runId, sev, at] of [['r1', 'CRITICAL', '2026-01-01'], ['r2', 'MEDIUM', '2026-01-02']]) {
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40), at);
      db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status)
        VALUES (?, 'F-x', 'fp-shared', ?, 'bug', 'same defect', 'new')`).run(runId, sev);
    }
    const rows = queryRecurringFindings(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, 'CRITICAL',
      "pre-fix: MAX('CRITICAL','MEDIUM') picked 'MEDIUM' alphabetically");
    db.close();
  });
});

// ───────────────────────────────────────────────────────
// F-54cb35f4 — clean dry-run JSON consistency
// ───────────────────────────────────────────────────────

describe('F-54cb35f4 — clean dry-run per-entry flags agree with the rollup', () => {
  let tmp, dbPath, repo;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-clean-dry-'));
    dbPath = join(tmp, 'control-plane.db');
    repo = join(tmp, 'repo');
    initGitRepo(repo);
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('swarm-cleandry1', 'org/r', repo, 'a'.repeat(40));
    createWorktree(repo, { runId: 'swarm-cleandry1', waveNumber: 1, domainName: 'backend' });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('dry-run: stranded=false per entry AND stranded=0 in the rollup', () => {
    const report = clean({ runId: 'swarm-cleandry1', dbPath });
    assert.equal(report.dryRun, true);
    assert.equal(report.total, 1);
    assert.equal(report.stranded, 0);
    assert.equal(report.removed, 0);
    for (const w of report.worktrees) {
      assert.equal(w.stranded, false,
        'pre-fix: every dry-run entry said stranded:true while the rollup said stranded:0');
      assert.equal(w.removed, false);
    }
  });
});

// ───────────────────────────────────────────────────────
// F-6a8a98d6 — rejected-finding recurrence leaves an event
// ───────────────────────────────────────────────────────

describe('F-6a8a98d6 — a rediscovered rejected finding writes an explicit event, without reopening', () => {
  it('recurred-while-rejected event lands; rejected status preserved', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'dispatched')"
    ).run();
    const waveId = Number(wave.lastInsertRowid);
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status)
      VALUES ('r1', 'F-rej12345', 'rej-fp-1', 'HIGH', 'bug', 'rejected once', 'rejected')`).run();

    // A rediscovery classifies 'new' (buildPriorMap excludes rejected) and
    // conflicts on UNIQUE(run_id, fingerprint) inside upsertFindings.
    const stats = upsertFindings(db, 'r1', waveId, {
      new: [{ fingerprint: 'rej-fp-1', severity: 'HIGH', category: 'bug', description: 'rejected once, seen again' }],
      recurring: [], fixed: [], unverified: [],
    });
    assert.equal(stats.inserted, 0, 'the conflicting insert is skipped, not duplicated');

    const f = db.prepare("SELECT * FROM findings WHERE run_id = 'r1'").get();
    assert.equal(f.status, 'rejected', 'recurrence must NOT overturn the coordinator\'s rejection');
    const ev = db.prepare('SELECT * FROM finding_events WHERE finding_id = ?').all(f.id);
    assert.equal(ev.length, 1,
      'pre-fix: the recurrence was invisible in the DB (NDJSON breadcrumb only)');
    assert.equal(ev[0].event_type, 'recurred');
    assert.match(ev[0].notes, /recurred-while-rejected/);
    db.close();
  });
});

// ───────────────────────────────────────────────────────
// F-aa32371b — unroutable approved findings surfaced at dispatch
// ───────────────────────────────────────────────────────

describe('F-aa32371b — approved findings routed to zero agents are surfaced', () => {
  let tmp, dbPath, repoPath;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-unrouted-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    const db = setupRun(dbPath, repoPath, 'r-unrouted');
    // A repo-level HIGH finding with NO file_path — matches no domain glob.
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status)
      VALUES ('r-unrouted', 'F-NOFILE-1', 'fp-nofile-1', 'HIGH', 'process', 'repo-level defect', 'approved')`).run();
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('dispatch names the orphaned finding ids in the report (dry-run and apply)', () => {
    const dry = dispatch({ runId: 'r-unrouted', phase: 'health-amend-a', dbPath, outputDir: tmp, dryRun: true });
    assert.equal(dry.unroutedApprovedFindings.length, 1,
      'pre-fix: the file-less approved finding was routed to zero agents with NO surface naming it');
    assert.equal(dry.unroutedApprovedFindings[0].finding_id, 'F-NOFILE-1');

    const applied = dispatch({ runId: 'r-unrouted', phase: 'health-amend-a', dbPath, outputDir: tmp });
    assert.equal(applied.unroutedApprovedFindings.length, 1);
    assert.equal(applied.unroutedApprovedFindings[0].severity, 'HIGH');
  });

  it('healthy input: fully-routed findings produce an empty list', () => {
    const db = openDb(dbPath);
    db.prepare("DELETE FROM findings WHERE finding_id = 'F-NOFILE-1'").run();
    const dry = dispatch({ runId: 'r-unrouted', phase: 'health-amend-a', dbPath, outputDir: tmp, dryRun: true });
    assert.equal(dry.unroutedApprovedFindings.length, 0);
  });
});

// ───────────────────────────────────────────────────────
// V2-CONTRACT-002 — receipt recommendation mirrors the serial-verify gate
// ───────────────────────────────────────────────────────

describe('V2-CONTRACT-002 — computeRecommendation cannot say ADVANCE while Gate 4 says VERIFY', () => {
  let tmp, dbPath;

  function seed(runId, { receipt = null } = {}) {
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', tmp, 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status, serial_verify_required) VALUES (?, 'health-audit-a', 1, 'collected', 1)"
    ).run(runId);
    const waveId = Number(wave.lastInsertRowid);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, dom.id);
    if (receipt) {
      db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed)
        VALUES (?, 'node', '["npm test"]', ?, ?)`).run(waveId, receipt.passed ? 0 : 1, receipt.passed ? 1 : 0);
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-rcpt-verify-'));
    dbPath = join(tmp, 'control-plane.db');
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: a --skip-verify wave with no receipt recommends VERIFY, not ADVANCE', () => {
    seed('r-noverify');
    const receipt = buildReceipt({ runId: 'r-noverify', dbPath });
    assert.equal(receipt.recommendation.action, 'VERIFY',
      'pre-fix: the receipt said ADVANCE while checkGates returned the non-overridable VERIFY');
    assert.equal(checkGates(openDb(dbPath), 'r-noverify').verdict, 'VERIFY',
      'sanity: the actual gate agrees');
  });

  it('GATE RED: a FAILED receipt still recommends VERIFY', () => {
    seed('r-failverify', { receipt: { passed: false } });
    const receipt = buildReceipt({ runId: 'r-failverify', dbPath });
    assert.equal(receipt.recommendation.action, 'VERIFY');
  });

  it('GATE GREEN: a passing wave-scoped receipt clears the obligation → ADVANCE', () => {
    seed('r-okverify', { receipt: { passed: true } });
    const receipt = buildReceipt({ runId: 'r-okverify', dbPath });
    assert.equal(receipt.recommendation.action, 'ADVANCE');
  });
});

// ───────────────────────────────────────────────────────
// V2-CONTRACT-003 / V2-INVARIAN-006 — degraded committed-delta probe is surfaced
// ───────────────────────────────────────────────────────

describe('V2-CONTRACT-003 / V2-INVARIAN-006 — a degraded committed-delta probe is loud, not silent', () => {
  let tmp, dbPath, repoPath, sha;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-basediff-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    sha = initGitRepo(repoPath);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  function collectBoth(runId) {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    return collect({ runId, dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
  }

  it('GATE RED: an unresolvable runs.commit_sha surfaces base_diff_unavailable on the agent report', () => {
    // setupRun's default commit_sha is 40 a's — not a real ref in this repo,
    // so the committed-delta diff fails and coverage silently narrowed pre-fix.
    // F-0e55b5ca made non-isolated collect prefer the per-wave dispatch_sha;
    // NULL it out to simulate the LEGACY wave this fallback (and this
    // degradation surface) still serves.
    setupRun(dbPath, repoPath, 'r-badbase');
    dispatch({ runId: 'r-badbase', phase: 'health-amend-a', dbPath, outputDir: tmp });
    openDb(dbPath).prepare("UPDATE waves SET dispatch_sha = NULL WHERE run_id = 'r-badbase'").run();
    const report = collectBoth('r-badbase');
    const a = report.agents.find(x => x.domain === 'domain-a');
    assert.ok(a.base_diff_unavailable,
      'pre-fix: baseDiffUnavailable had ZERO consumers — the degradation never reached the report');
    assert.match(a.base_diff_unavailable.reason, /committed edits/i);
  });

  it('GATE RED: an isolated agent whose fork point cannot be resolved surfaces the same way', () => {
    const db = setupRun(dbPath, repoPath, 'r-ghost', { commitSha: sha });
    // resolveWorktreeBaseRef(worktree, 'ghost-branch') → merge-base fails → null.
    db.prepare("UPDATE runs SET branch = 'ghost-branch' WHERE id = 'r-ghost'").run();
    dispatch({ runId: 'r-ghost', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });
    // F-COORD-DIFFBASE made ISOLATED collect prefer the per-wave dispatch_sha
    // too; NULL it out to simulate the LEGACY wave this fallback (and this
    // degradation surface) still serves — the identical treatment F-0e55b5ca
    // applied to this test's non-isolated sibling above, for the identical
    // reason. With a dispatch_sha recorded there is no unresolvable fork point
    // to report: dispatch_sha IS the fork point, the committed-delta diff runs
    // against it, and firing the note would assert that committed edits are
    // invisible when they are fully visible. The degradation is only real —
    // and must still be loud — when NO recorded base exists AND merge-base
    // cannot derive one, which is exactly what this fixture now builds.
    openDb(dbPath).prepare("UPDATE waves SET dispatch_sha = NULL WHERE run_id = 'r-ghost'").run();
    const report = collectBoth('r-ghost');
    const a = report.agents.find(x => x.domain === 'domain-a');
    assert.ok(a.base_diff_unavailable,
      'pre-fix: a null baseRef silently skipped the committed-delta half of the probe');
    assert.match(a.base_diff_unavailable.reason, /fork point/i);
  });

  it('healthy input: a resolvable base leaves no degradation note', () => {
    setupRun(dbPath, repoPath, 'r-goodbase', { commitSha: sha });
    dispatch({ runId: 'r-goodbase', phase: 'health-amend-a', dbPath, outputDir: tmp });
    const report = collectBoth('r-goodbase');
    // F-dcb00802: an unguarded `for` over an empty report.agents would pass
    // vacuously, and `assert.equal(a.base_diff_unavailable, undefined)` would
    // pass on ANY absent property (surviving a rename of the field itself).
    // Mirror the RED siblings above: assert population, then dereference by
    // domain so a missing/renamed agent throws instead of passing silently.
    assert.equal(report.agents.length, 2, 'both frozen domains reported');
    const a = report.agents.find(x => x.domain === 'domain-a');
    assert.ok(!('base_diff_unavailable' in a),
      'a healthy probe must not carry the degradation note');
  });
});

// ───────────────────────────────────────────────────────
// V2-INVARIAN-001 — committed worktree edits reach the collect seam end-to-end
// ───────────────────────────────────────────────────────

describe('V2-INVARIAN-001 — an --isolate agent that git-commits its edits is still enforced at collect', () => {
  let tmp, dbPath, repoPath, arA;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-committed-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    const sha = initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-commit', { commitSha: sha });
    dispatch({ runId: 'r-commit', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });
    arA = openDb(dbPath).prepare(`
      SELECT ar.* FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id = 'r-commit' AND d.name = 'domain-a'
    `).get();
    assert.ok(arA.worktree_path, 'precondition: isolate gave domain-a a worktree');
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  function commitInWorktree(relPath) {
    const full = join(arA.worktree_path, ...relPath.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// committed by the agent\n');
    git(arA.worktree_path, ['add', '-A']);
    git(arA.worktree_path, ['commit', '-q', '-m', 'agent committed its work']);
  }

  function collectBoth(filesChangedA = []) {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001', { files_changed: filesChangedA });
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    return collect({ runId: 'r-commit', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
  }

  it('an in-domain committed edit omitted from files_changed surfaces in the divergence set', () => {
    commitInWorktree('packages/a/committed.js');
    const report = collectBoth([]);
    const a = report.agents.find(x => x.domain === 'domain-a');
    assert.equal(a.status, 'complete', 'in-domain edit — no violation');
    assert.ok(a.files_changed_divergence,
      'the independent probe must diverge from the empty self-report');
    assert.ok(a.files_changed_divergence.missing_from_report.includes('packages/a/committed.js'),
      'the committed file must reach the independent set end-to-end (status probe alone is blind to it)');
    assert.equal(report.waveStatusAfter, 'collected');
  });

  it('an OUT-of-domain committed edit flags ownership_violation despite a clean self-report', () => {
    commitInWorktree('packages/b/hack.js');
    const report = collectBoth([]);
    const a = report.agents.find(x => x.domain === 'domain-a');
    assert.equal(a.status, 'ownership_violation',
      'a git-committing agent must not vanish from ownership enforcement');
    assert.ok(report.violations.some(v => v.file === 'packages/b/hack.js'));
    assert.equal(report.waveStatusAfter, 'failed');
  });
});

// ───────────────────────────────────────────────────────
// V2-INVARIAN-003 — revalidate-ingested findings recur with fingerprint parity
// ───────────────────────────────────────────────────────

describe('V2-INVARIAN-003 — a finding re-reported via revalidate --apply recurs on ONE row (F-8efffdd1 recurrence half)', () => {
  let tmp, dbPath, repoPath;

  const findingX = {
    id: 'F-X-1', severity: 'HIGH', category: 'bug',
    file: 'packages/a/src/foo.js', line: 3,
    description: 'X: the same defect reported twice',
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w2-recur-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    const sha = initGitRepo(repoPath);
    // Real source file so BOTH ingestion paths fold the context-snippet
    // (fp-p-005 sourceText) into the fingerprint — parity is the point.
    mkdirSync(join(repoPath, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'packages', 'a', 'src', 'foo.js'),
      Array.from({ length: 10 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n');
    setupRun(dbPath, repoPath, 'r-recur', { findings: false, commitSha: sha });
    dispatch({ runId: 'r-recur', phase: 'health-audit-a', dbPath, outputDir: tmp });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('exactly one findings row, classified recurring, with the collect-minted fingerprint', () => {
    // Wave: domain-a reports X and lands; domain-b writes garbage and blocks.
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a', stage: 'A', summary: 'audit', findings: [{ ...findingX }],
    }));
    writeFileSync(outB, 'NOT JSON {{{');
    collect({ runId: 'r-recur', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const db = openDb(dbPath);
    const first = db.prepare("SELECT * FROM findings WHERE run_id = 'r-recur'").get();
    assert.equal(first.status, 'new', 'precondition: collect ingested X');

    // Corrected domain-b output RE-REPORTS X (same file/line/description).
    const corrected = join(tmp, 'b-corrected.json');
    writeFileSync(corrected, JSON.stringify({
      domain: 'domain-b', stage: 'A', summary: 'redone', findings: [{ ...findingX }],
    }));
    const rep = revalidate({
      runId: 'r-recur', dbPath, reason: 'schema repair',
      outputs: { 'domain-b': corrected }, apply: true,
    });
    assert.equal(rep.findings.recurring, 1, 'the re-report must classify recurring, not new');
    assert.equal(rep.findings.new, 0);

    const rows = db.prepare("SELECT * FROM findings WHERE run_id = 'r-recur'").all();
    assert.equal(rows.length, 1,
      'sourceText fingerprint parity: a second row means revalidate minted a different fingerprint than collect');
    assert.equal(rows[0].status, 'recurring');
    assert.equal(rows[0].fingerprint, first.fingerprint, 'identical fingerprint across both paths');
  });
});

// ───────────────────────────────────────────────────────
// V2-INVARIAN-002 — the narrowing is ONE shared helper (wave2-live-001)
// ───────────────────────────────────────────────────────

describe('V2-INVARIAN-002 — narrowToExclusivelyOwned is the single non-isolated narrowing', () => {
  it('keeps only files this domain wins under specificity arbitration, not bare membership', () => {
    const domains = [
      { name: 'tests', ownership_class: 'owned', globs: ['**/*.test.*'] },
      { name: 'domain-a', ownership_class: 'owned', globs: ['packages/a/**'] },
    ];
    const files = ['packages/a/x.test.js', 'packages/a/src/y.js', 'packages/b/z.js'];
    assert.deepEqual(
      narrowToExclusivelyOwned(domains, 'domain-a', files),
      ['packages/a/x.test.js', 'packages/a/src/y.js'],
      'bare membership would hand x.test.js to tests; arbitration keeps it with the more specific owner');
    assert.deepEqual(narrowToExclusivelyOwned(domains, 'tests', files), [],
      'the overlapping broad glob must not over-collect the sibling package\'s edits');
  });

  it('BOTH collect and revalidate consume the shared helper (no forked filter)', () => {
    for (const rel of ['commands/collect.js', 'commands/revalidate.js']) {
      const src = readFileSync(join(PKG_ROOT, ...rel.split('/')), 'utf-8');
      assert.match(src, /narrowToExclusivelyOwned\(/,
        `${rel} must route through lib/domains.js#narrowToExclusivelyOwned so the wave2-live-001 pin covers both paths`);
      assert.ok(!/resolveExclusiveOwner\(/.test(src),
        `${rel} must not re-implement the narrowing with a bare resolveExclusiveOwner filter`);
    }
  });
});

// ───────────────────────────────────────────────────────
// V2-CONTRACT-006 — clean.js consumes the canonical runShortOf
// ───────────────────────────────────────────────────────

describe('V2-CONTRACT-006 — clean.js has no forked runShortOf', () => {
  it('the slug derivation is imported from lib/worktree.js, not duplicated', () => {
    const src = readFileSync(join(PKG_ROOT, 'commands', 'clean.js'), 'utf-8');
    assert.ok(!/function runShortOf/.test(src),
      'pre-fix: a local duplicate could drift from createWorktree\'s slug byte-for-byte contract');
    assert.match(src, /import \{[^}]*\brunShortOf\b[^}]*\} from '\.\.\/lib\/worktree\.js'/,
      'clean.js must consume the single source of truth (matches the dispatch.js migration)');
  });
});

// ───────────────────────────────────────────────────────
// V2-CONTRACT-007 — no raw control bytes in package sources
// ───────────────────────────────────────────────────────

describe('V2-CONTRACT-007 — package sources contain no raw control bytes', () => {
  it('every .js/.mjs/.json/.md source keeps bytes < 0x20 to \\t \\n \\r only', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(js|mjs|json|md)$/.test(e.name)) continue;
        const buf = readFileSync(full);
        for (let i = 0; i < buf.length; i++) {
          const b = buf[i];
          if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
            offenders.push(`${full} byte 0x${b.toString(16)} @${i}`);
            break; // one report per file is enough
          }
        }
      }
    };
    walk(PKG_ROOT);
    assert.deepEqual(offenders, [],
      'raw control bytes make grep classify the file as binary (pre-fix: two raw NULs in lib/domains.js)');
  });
});
