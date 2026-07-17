/**
 * wave4-swarm-cp-pins.test.js — Wave-4 (health-amend-a) swarm-cp regression pins.
 *
 * One pin per finding fixed in the wave-4 amend, written test-first against
 * the pre-fix behavior. Gate-shaped fixes carry BOTH directions (gate
 * non-vacuity rule): the protected input makes the gate go RED, and the
 * healthy input still passes.
 *
 *   F-feb78e7b  override is per-gate consent, never a master key; all five
 *               gates are evaluated + recorded in gates_checked
 *   F-1ab3fd1f  terminal cleanup skips dirty / unmerged worktrees; `swarm
 *               clean` preview surfaces what --apply would destroy
 *   F-0e55b5ca  non-isolated ownership probe diffs against the per-wave
 *               dispatch_sha, not the stale init-time runs.commit_sha
 *   F-15fc601e  missing-output failed wave routes to `swarm redrive`, not
 *               the resume→collect→revalidate dead-end
 *   CP4-SCOPE-WIRING  full-coverage wave classifies absent priors as fixed;
 *               partial coverage keeps the safe unverified default
 *   F-c5eb20ef  degraded-probe note states the true property (self-report
 *               only), not "restricted" partial coverage
 *   F-7e2dbf43  runShortOf keeps the full random suffix (same-second runs
 *               cannot collide on the slug)
 *   F-f35352cb  revalidate refusal for failed/timed_out names redrive
 *   F-197de6dd  a domain dir without output.json is pipeline_broken, not
 *               silently skipped
 *   F-7970a30b  dispatch over a failed wave with blocked agents warns that
 *               the revalidate window is closing
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb, openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { revalidate } from './commands/revalidate.js';
import { status } from './commands/status.js';
import { buildReceipt } from './commands/receipt.js';
import { clean, formatClean } from './commands/clean.js';
import { checkGates, advance, recordPromotion, getPromotions } from './lib/advance.js';
import { createWorktree, listWorktrees, cleanupRunWorktrees, runShortOf } from './lib/worktree.js';
import { loadDomainOutputs, renderWithStatus } from './lib/findings-digest.js';
import { classifyFindings } from './lib/fingerprint.js';

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

/** File-backed run fixture with two owned domains (wave-2 pins pattern). */
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

/** Capture stderr NDJSON emitted by logStage during fn(). */
function captureStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { fn(); } finally { console.error = orig; }
  const events = [];
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { /* human banner / non-JSON */ }
  }
  return { lines, events };
}

// ───────────────────────────────────────────────────────
// F-feb78e7b — override is per-gate consent, never a master key
// ───────────────────────────────────────────────────────

describe('F-feb78e7b — advance --override cannot promote past an unevaluated non-overridable gate', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  function seed(runId, { phase = 'health-amend-a', serialVerify = 0, violation = false, highFinding = false } = {}) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      'INSERT INTO waves (run_id, phase, wave_number, status, serial_verify_required) VALUES (?, ?, 1, ?, ?)'
    ).run(runId, phase, 'collected', serialVerify);
    const waveId = Number(wave.lastInsertRowid);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId);
    const ar = db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, dom.id);
    if (violation) {
      db.prepare(`INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
        VALUES (?, 'other/file.js', 'edit', ?, 1)`).run(Number(ar.lastInsertRowid), dom.id);
    }
    if (highFinding) {
      db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status)
        VALUES (?, 'F-1', 'fp1', 'HIGH', 'bug', 'open defect', 'new')`).run(runId);
    }
    return waveId;
  }

  it('GATE RED: ownership-violation override on a serial-verify wave with no receipt must NOT promote', () => {
    // Gate 3 (ownership, overridable) fails FIRST in gate order; Gate 4
    // (serial verify, NON-overridable) is also unmet. Pre-fix checkGates
    // returned at Gate 3 and the override branch promoted without ever
    // consulting Gate 4 — the mandatory serial-verify gate silently passed.
    seed('r-master-key', { serialVerify: 1, violation: true });

    const gateResult = checkGates(db, 'r-master-key');
    assert.equal(gateResult.verdict, 'VERIFY',
      'the non-overridable serial-verify failure must dominate the overridable ownership failure');
    assert.equal(gateResult.overridable, false);
    assert.equal(gateResult.gates.length, 6,
      'ALL gates must be evaluated (pre-fix: checkGates returned at the first failure); v9 added the adjudication gate');

    const result = advance(db, 'r-master-key', {
      override: true,
      overrideReason: 'accepted the cross-domain edit',
    });
    assert.equal(result.promoted, false,
      'pre-fix: the override promoted with ZERO test verification anywhere in the wave');
    assert.equal(result.verdict, 'VERIFY');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 0,
      'no promotion row may be recorded');
  });

  it('gates_checked records ALL evaluated gates on an overridden promotion, with per-gate overridden flags', () => {
    seed('r-audit-ov', { phase: 'health-audit-a', highFinding: true });

    const result = advance(db, 'r-audit-ov', { override: true, overrideReason: 'risk accepted' });
    assert.equal(result.promoted, true);
    assert.equal(result.toPhase, 'health-audit-b', 'F-5a251061 semantics preserved: past the gate, not into the amend loop');

    const [p] = getPromotions(db, 'r-audit-ov');
    assert.equal(p.gates_checked.length, 6,
      'pre-fix: gates_checked permanently omitted every gate after the first failure; v9 added the adjudication gate');
    const names = p.gates_checked.map(g => g.name).sort();
    assert.deepEqual(names,
      ['adjudication', 'agent_completion', 'finding_severity', 'ownership', 'verification', 'wave_status'].sort());
    const findingGate = p.gates_checked.find(g => g.name === 'finding_severity');
    assert.equal(findingGate.passed, false);
    assert.equal(findingGate.overridden, true, 'the masked gate must be marked overridden in the audit trail');
    const verifyGate = p.gates_checked.find(g => g.name === 'verification');
    assert.equal(verifyGate.passed, true, 'gate 4 was actually consulted and recorded');
    assert.equal(p.overrides[0].gate, 'finding_severity');
  });

  it('healthy path: an ownership-only failure (no serial-verify obligation) is still overridable', () => {
    seed('r-own-only', { violation: true });
    const gateResult = checkGates(db, 'r-own-only');
    assert.equal(gateResult.verdict, 'BLOCK');
    assert.equal(gateResult.overridable, true);

    const result = advance(db, 'r-own-only', { override: true, overrideReason: 'accepted' });
    assert.equal(result.promoted, true);
    const [p] = getPromotions(db, 'r-own-only');
    assert.equal(p.overrides[0].gate, 'ownership');
  });
});

// ───────────────────────────────────────────────────────
// F-1ab3fd1f — terminal cleanup must not destroy unmerged agent work
// ───────────────────────────────────────────────────────

describe('F-1ab3fd1f — terminal worktree cleanup skips dirty / unmerged work', () => {
  let repo, db;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'w4-wt-guard-'));
    initGitRepo(repo);
    db = openMemoryDb();
  });
  afterEach(() => { db.close(); rmSync(repo, { recursive: true, force: true }); });

  function seedRun(runId) {
    db.prepare("INSERT INTO runs (id, repo, local_path, commit_sha, branch) VALUES (?, ?, ?, ?, 'main')")
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

  it('GATE RED: a DIRTY worktree survives the terminal promotion with a breadcrumb', () => {
    const waveId = seedRun('swarm-dirty1');
    const wt = createWorktree(repo, { runId: 'swarm-dirty1', waveNumber: 1, domainName: 'backend' });
    writeFileSync(join(wt.worktreePath, 'uncommitted-agent-work.js'), 'precious\n');

    const { events } = captureStderr(() => {
      recordPromotion(db, 'swarm-dirty1', waveId, 'treatment', 'complete', {
        gates: [{ name: 'g', passed: true }],
      });
    });

    assert.ok(existsSync(join(wt.worktreePath, 'uncommitted-agent-work.js')),
      'pre-fix: `git worktree remove --force` discarded the uncommitted agent edits');
    const skip = events.find(e => e.stage === 'worktree_unmerged_skipped');
    assert.ok(skip, 'the skip must be a loud structured warning, not silence');
    assert.equal(skip.worktreePath.replace(/\\/g, '/'), wt.worktreePath.replace(/\\/g, '/'),
      'the breadcrumb must name the surviving worktree');
    assert.match(skip.remediation || '', /swarm clean/,
      '`swarm clean` is the named disposal verb for preserved work');
  });

  it('GATE RED: a branch with UNMERGED commits survives the terminal promotion', () => {
    const waveId = seedRun('swarm-unmerged1');
    const wt = createWorktree(repo, { runId: 'swarm-unmerged1', waveNumber: 1, domainName: 'backend' });
    writeFileSync(join(wt.worktreePath, 'agent-fix.js'), 'committed but never merged\n');
    git(wt.worktreePath, ['add', '.']);
    git(wt.worktreePath, ['commit', '-q', '-m', 'agent fix']);

    recordPromotion(db, 'swarm-unmerged1', waveId, 'treatment', 'complete', {
      gates: [{ name: 'g', passed: true }],
    });

    assert.ok(existsSync(wt.worktreePath),
      'pre-fix: `git branch -D` force-deleted the unmerged branch; the committed fixes were lost');
    const branches = git(repo, ['branch', '--list', wt.branch]).trim();
    assert.ok(branches.includes(wt.branch.replace(/^refs\/heads\//, '')),
      'the unmerged branch must survive');
  });

  it('healthy path: a clean, merged worktree is still reclaimed at the terminal promotion', () => {
    const waveId = seedRun('swarm-cleanwt1');
    const wt = createWorktree(repo, { runId: 'swarm-cleanwt1', waveNumber: 1, domainName: 'backend' });

    recordPromotion(db, 'swarm-cleanwt1', waveId, 'treatment', 'complete', {
      gates: [{ name: 'g', passed: true }],
    });

    assert.ok(!existsSync(wt.worktreePath), 'clean worktrees are still cleaned up');
    assert.equal(listWorktrees(repo).length, 0);
  });

  it('`swarm clean` DRY-RUN preview surfaces dirty/unmerged status so --apply is informed consent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w4-clean-flags-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const fdb = openDb(dbPath);
      fdb.prepare("INSERT INTO runs (id, repo, local_path, commit_sha, branch) VALUES (?, ?, ?, ?, 'main')")
        .run('swarm-cleanflag1', 'org/r', repo, 'a'.repeat(40));
      const wt = createWorktree(repo, { runId: 'swarm-cleanflag1', waveNumber: 1, domainName: 'backend' });
      writeFileSync(join(wt.worktreePath, 'dirty.js'), 'uncommitted\n');

      const report = clean({ runId: 'swarm-cleanflag1', dbPath });
      assert.equal(report.dryRun, true);
      assert.equal(report.worktrees.length, 1);
      assert.equal(report.worktrees[0].dirty, true,
        'pre-fix: the preview gave no signal that --apply would destroy uncommitted work');
      assert.equal(report.worktrees[0].unmerged, false);
    } finally {
      closeDb(dbPath);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('`swarm clean` DRY-RUN preview surfaces UNMERGED branch commits (the merge-base half)', () => {
    // F-81fe8ae0: the sibling dirty-case pin above only exercises the
    // `git status --porcelain` half of worktreeDisposition. If the
    // `merge-base --is-ancestor` probe regressed (or the branch side of
    // worktreeDisposition always returned unmerged:false), the preview would
    // under-report the UNMERGED work `--apply` is about to force-destroy and
    // this describe block would stay GREEN. This case commits to the branch
    // WITHOUT dirtying the tree, isolating the merge-base signal.
    const tmp = mkdtempSync(join(tmpdir(), 'w4-clean-unmerged-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const fdb = openDb(dbPath);
      fdb.prepare("INSERT INTO runs (id, repo, local_path, commit_sha, branch) VALUES (?, ?, ?, ?, 'main')")
        .run('swarm-cleanunmerged1', 'org/r', repo, 'a'.repeat(40));
      const wt = createWorktree(repo, { runId: 'swarm-cleanunmerged1', waveNumber: 1, domainName: 'backend' });
      writeFileSync(join(wt.worktreePath, 'agent-fix.js'), 'committed but never merged\n');
      git(wt.worktreePath, ['add', '.']);
      git(wt.worktreePath, ['commit', '-q', '-m', 'agent fix']);

      const report = clean({ runId: 'swarm-cleanunmerged1', dbPath });
      assert.equal(report.dryRun, true);
      assert.equal(report.worktrees.length, 1);
      assert.equal(report.worktrees[0].unmerged, true,
        'RED if worktreeDisposition\'s merge-base probe always reported merged (unmerged:false)');
      assert.equal(report.worktrees[0].dirty, false,
        'the commit was clean — this isolates the merge-base signal from the dirty-tree signal');
      assert.match(formatClean(report), /UNMERGED commits/,
        'the risk banner must name UNMERGED so --apply is informed consent');
    } finally {
      closeDb(dbPath);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────
// F-0e55b5ca — per-wave dispatch_sha diff base
// ───────────────────────────────────────────────────────

describe('F-0e55b5ca — the non-isolated committed-delta probe uses the per-wave dispatch base', () => {
  let tmp, dbPath, repoPath, seedSha;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-dispatch-sha-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    seedSha = initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-base', { commitSha: seedSha });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: prior waves\' committed edits are NOT attributed to this wave\'s agent', () => {
    // Simulate wave-1 results landing on the branch AFTER init (the exact
    // testing-os flow — e.g. commit a0579a5).
    mkdirSync(join(repoPath, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'packages', 'a', 'src', 'prior-wave-fix.js'), 'landed by wave 1\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-q', '-m', 'wave-1 results']);
    const headAtDispatch = git(repoPath, ['rev-parse', 'HEAD']).trim();

    dispatch({ runId: 'r-base', phase: 'health-amend-a', dbPath, outputDir: tmp });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-base' ORDER BY wave_number DESC LIMIT 1").get();
    assert.equal(wave.dispatch_sha, headAtDispatch,
      'the wave row must carry the dispatch-time HEAD as its diff base');
    assert.notEqual(wave.dispatch_sha, seedSha, 'the base must NOT be the stale init-time commit_sha');

    // Agent touches nothing and honestly reports files_changed: [].
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    const report = collect({ runId: 'r-base', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const aReport = report.agents.find(a => a.domain === 'domain-a');
    assert.equal(aReport.files_changed_divergence, undefined,
      'pre-fix: the stale init-sha base flagged the prior wave\'s commit as missing_from_report');
    const claims = db.prepare(`
      SELECT fc.* FROM file_claims fc
      JOIN agent_runs ar ON fc.agent_run_id = ar.id
      WHERE ar.wave_id = ?
    `).all(wave.id);
    assert.equal(claims.length, 0,
      'pre-fix: prior waves\' in-domain edits were INSERTed as THIS agent\'s file_claims');
  });

  it('healthy path: an edit made DURING the wave is still probed against the dispatch base', () => {
    dispatch({ runId: 'r-base', phase: 'health-amend-a', dbPath, outputDir: tmp });
    mkdirSync(join(repoPath, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'packages', 'a', 'src', 'wave-edit.js'), 'edited this wave\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-q', '-m', 'agent committed mid-wave']);

    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001', { files_changed: ['packages/a/src/wave-edit.js'] });
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    const report = collect({ runId: 'r-base', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    const aReport = report.agents.find(a => a.domain === 'domain-a');
    assert.equal(aReport.files_changed_divergence, undefined,
      'the committed mid-wave edit must still be visible to the probe (report matches actual)');
  });
});

// ───────────────────────────────────────────────────────
// F-15fc601e — missing-output recovery routes to redrive
// ───────────────────────────────────────────────────────

describe('F-15fc601e — a missing-output failed wave names `swarm redrive` as the recovery verb', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-redrive-route-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-deadend');
    dispatch({ runId: 'r-deadend', phase: 'health-amend-a', dbPath, outputDir: tmp });
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    collect({
      runId: 'r-deadend', dbPath,
      outputs: { 'domain-a': join(tmp, 'does-not-exist.json'), 'domain-b': outB },
    });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: status routes to redrive (pre-fix: INCOMPLETE → `swarm resume` wild-goose chase)', () => {
    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-deadend' ORDER BY wave_number DESC LIMIT 1").get();
    assert.equal(wave.status, 'failed', 'precondition: F-aba6fa9d fails the wave');

    const s = status({ runId: 'r-deadend', dbPath });
    assert.match(s.assessment.nextAction, /swarm redrive/,
      'pre-fix: nextAction said `swarm resume`, which redispatches but never unfails the wave');
    assert.match(s.assessment.nextAction, new RegExp(String(wave.id)),
      'the concrete wave id must be named so the verb is copy-pasteable');
    assert.ok(!/swarm resume/.test(s.assessment.nextAction),
      'resume must not be recommended — it leads to the collect/revalidate dead-end');
  });

  it('GATE RED: the receipt recommendation mirrors the routing (REDRIVE, not RESUME)', () => {
    const receipt = buildReceipt({ runId: 'r-deadend', dbPath });
    assert.equal(receipt.recommendation.action, 'REDRIVE',
      'pre-fix: computeRecommendation gave the same RESUME misdirection');
    assert.match(receipt.recommendation.reason, /redrive/);
  });
});

// ───────────────────────────────────────────────────────
// CP4-SCOPE-WIRING — full-coverage scope descriptor
// ───────────────────────────────────────────────────────

describe('CP4-SCOPE-WIRING — a full-coverage re-audit can classify absent priors as fixed', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-scope-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('GATE GREEN→fixed: a wave covering EVERY owned domain flips absent approved AND unverified priors to fixed', () => {
    const db = setupRun(dbPath, repoPath, 'r-full', { findings: false });
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES ('r-full', 'F-P-APPR', 'fp-appr-1', 'HIGH', 'bug', 'packages/a/x.js', 'approved defect', 'approved')`).run();
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES ('r-full', 'F-P-UNV', 'fp-unv-1', 'MEDIUM', 'bug', 'packages/b/y.js', 'unverified defect', 'unverified')`).run();

    dispatch({ runId: 'r-full', phase: 'health-audit-a', dbPath, outputDir: tmp });
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    // `confirmed` is the agents' declaration of which priors they actually
    // checked. It is REQUIRED for a close as of the lens-blindness fix: full
    // coverage proves the wave read the files, never that it looked for a given
    // defect — a stage-d-audit agent hunting typography "covers" every file a
    // defensive-coding finding lives in. This test's PURPOSE is unchanged and
    // is still scope WIRING (its own message: "pre-fix ... scope was never
    // passed"); what changed is that the descriptor now carries a second, finer
    // field, so the fixture declares it the way a real agent does.
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a', stage: 'A', summary: 'clean', findings: [], confirmed: ['F-P-APPR'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b', stage: 'A', summary: 'clean', findings: [], confirmed: ['F-P-UNV'],
    }));
    const report = collect({ runId: 'r-full', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    assert.equal(report.findings.fixed, 2,
      'pre-fix: a full-coverage re-audit could NEVER mark anything fixed (scope was never passed)');
    assert.equal(report.findings.unverified, 0);
    const statuses = db.prepare("SELECT finding_id, status FROM findings WHERE run_id = 'r-full'").all();
    for (const row of statuses) {
      assert.equal(row.status, 'fixed', `${row.finding_id} must flip to fixed under full coverage`);
    }
  });

  it('GATE RED: full coverage WITHOUT a declaration closes nothing — silence is not evidence', () => {
    // The other half of the wiring, which the assertion above cannot see on its
    // own: it would pass identically if `confirmed` were ignored entirely. This
    // is the lens-blindness case in miniature — two agents that covered every
    // owned domain and said nothing about the priors. Pre-fix that closed both;
    // now it closes neither, because coverage is not a claim about THIS defect.
    const db = setupRun(dbPath, repoPath, 'r-silent', { findings: false });
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES ('r-silent', 'F-S-APPR', 'fp-sil-1', 'HIGH', 'bug', 'packages/a/x.js', 'approved defect', 'approved')`).run();

    dispatch({ runId: 'r-silent', phase: 'health-audit-a', dbPath, outputDir: tmp });
    const outA = join(tmp, 'sa.json');
    const outB = join(tmp, 'sb.json');
    // Byte-identical to the fixture above except for the missing declaration.
    writeFileSync(outA, JSON.stringify({ domain: 'domain-a', stage: 'A', summary: 'clean', findings: [] }));
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
    const report = collect({ runId: 'r-silent', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    assert.equal(report.findings.fixed, 0,
      'an undeclared prior must NOT close on silence, even under full coverage');
    assert.equal(report.findings.unverified, 1);
    assert.equal(
      db.prepare("SELECT status FROM findings WHERE run_id = 'r-silent'").get().status,
      'unverified',
      'the honest state is "we do not know whether it was fixed or simply not looked at" — open, re-asked next wave',
    );
  });

  it('safe default: a PARTIAL-coverage wave still classifies absent priors as unverified', () => {
    const db = setupRun(dbPath, repoPath, 'r-part', { findings: false });
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES ('r-part', 'F-P-1', 'fp-part-1', 'HIGH', 'bug', 'packages/b/y.js', 'defect', 'approved')`).run();

    // Manually seed a wave whose agent set covers ONLY domain-a (partial).
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r-part', 'health-audit-a', 1, 'dispatched')"
    ).run();
    const waveId = Number(wave.lastInsertRowid);
    const domA = db.prepare("SELECT id FROM domains WHERE run_id = 'r-part' AND name = 'domain-a'").get();
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')")
      .run(waveId, domA.id);

    const outA = join(tmp, 'a.json');
    writeFileSync(outA, JSON.stringify({ domain: 'domain-a', stage: 'A', summary: 'clean', findings: [] }));
    const report = collect({ runId: 'r-part', dbPath, outputs: { 'domain-a': outA } });

    assert.equal(report.findings.fixed, 0,
      'partial coverage must NOT invent a fixed verdict');
    assert.equal(report.findings.unverified, 1);
    const f = db.prepare("SELECT status FROM findings WHERE run_id = 'r-part'").get();
    assert.equal(f.status, 'unverified');
  });

  it('classifyFindings unit: scope.full=true covers even file-less priors; null scope stays safe', () => {
    const prior = new Map([
      ['fp-nofile', { id: 1, fingerprint: 'fp-nofile', status: 'approved', file_path: null, description: 'repo-level' }],
    ]);
    const full = classifyFindings([], prior, { full: true });
    assert.equal(full.fixed.length, 1, 'full scope covers findings with no file path');
    assert.equal(full.unverified.length, 0);

    const none = classifyFindings([], prior);
    assert.equal(none.fixed.length, 0, 'no scope info → safe unverified default unchanged');
    assert.equal(none.unverified.length, 1);
  });
});

// ───────────────────────────────────────────────────────
// F-c5eb20ef — honest degraded-probe wording
// ───────────────────────────────────────────────────────

describe('F-c5eb20ef — the non-isolated degraded-probe note states the true property', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-degrade-word-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-word');
    dispatch({ runId: 'r-word', phase: 'health-amend-a', dbPath, outputDir: tmp });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('the note says enforcement rests on self-report, not "restricted" partial coverage', () => {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    const { events } = captureStderr(() =>
      collect({ runId: 'r-word', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } }));

    // Re-read the report from the DB-side agents via a fresh collect return is
    // not possible (wave consumed) — assert on the NDJSON event + note text
    // captured during the collect above.
    const ev = events.find(e => e.stage === 'ownership_probe_degraded');
    assert.ok(ev, 'the degradation event must still be emitted');
    assert.equal(ev.reason, 'self_report_only_cross_domain',
      'pre-fix reason code implied partial coverage; the true property is zero independent cross-domain coverage');
    assert.equal(ev.remediation, '--isolate');
  });

  it('the per-agent note carries the honest wording (and still names --isolate)', () => {
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outA, 'domain-a', 'F-A-001');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    const report = collect({ runId: 'r-word', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
    const aReport = report.agents.find(a => a.domain === 'domain-a');
    assert.ok(aReport.ownership_probe_degraded, 'note still present');
    assert.match(aReport.ownership_probe_degraded.reason, /cannot .*catch|cannot independently/i,
      'the note must say the probe cannot catch ANY cross-domain edit');
    assert.match(aReport.ownership_probe_degraded.reason, /self-report/i,
      'the note must say enforcement rests entirely on files_changed self-report');
    assert.match(aReport.ownership_probe_degraded.reason, /--isolate/,
      'the remediation pointer must survive the rewording (verification-discipline pin relies on it)');
  });
});

// ───────────────────────────────────────────────────────
// F-7e2dbf43 — runShortOf keeps the full random suffix
// ───────────────────────────────────────────────────────

describe('F-7e2dbf43 — same-second runs cannot collide on the run-short slug', () => {
  it('GATE RED: the full 4-hex random suffix survives the slug', () => {
    const slug = runShortOf('swarm-1783007856-9fdb');
    assert.ok(slug.endsWith('9fdb'),
      `pre-fix slice(0,12) kept only ONE hex char (got "${slug}") — 1/16 collision for same-second inits`);
    assert.ok(slug.length <= 15, 'slug stays short enough for branch/dir names');
  });

  it('two runs initialized in the same second get distinct slugs', () => {
    const a = runShortOf('swarm-1783007856-9fdb');
    const b = runShortOf('swarm-1783007856-af01');
    assert.notEqual(a, b,
      'pre-fix: 1/16 of same-second run pairs shared a slug — worktree dirs and branch prefixes collided');
  });
});

// ───────────────────────────────────────────────────────
// F-f35352cb — revalidate refusal names redrive for the failed tail
// ───────────────────────────────────────────────────────

describe('F-f35352cb — revalidate refusal for a failed agent names the correct verb', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-refusal-verb-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-refusal');
    dispatch({ runId: 'r-refusal', phase: 'health-amend-a', dbPath, outputDir: tmp });
    const outB = join(tmp, 'b.json');
    writeAmendOutput(outB, 'domain-b', 'F-B-001');
    collect({
      runId: 'r-refusal', dbPath,
      outputs: { 'domain-a': join(tmp, 'does-not-exist.json'), 'domain-b': outB },
    });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('the refusal for a status=failed agent_run appends the redrive verb', () => {
    const corrected = join(tmp, 'a-late.json');
    writeAmendOutput(corrected, 'domain-a', 'F-A-001');
    const report = revalidate({
      runId: 'r-refusal', dbPath, reason: 'late output arrived',
      outputs: { 'domain-a': corrected },
    });
    assert.equal(report.refusals.length, 1);
    assert.match(report.refusals[0].reason, /swarm redrive/,
      'pre-fix: the refusal named only what revalidate repairs, not the verb that DOES apply');
    assert.match(report.refusals[0].reason, /--apply/);
  });
});

// ───────────────────────────────────────────────────────
// F-197de6dd — domain dir without output.json is pipeline_broken
// ───────────────────────────────────────────────────────

describe('F-197de6dd — a domain dir whose agent crashed before writing output.json is loud', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'w4-digest-missing-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('GATE RED: the wave classifies pipeline_broken (exit 2), not clean (exit 0)', () => {
    const waveDir = join(tmp, 'wave-1');
    mkdirSync(join(waveDir, 'backend'), { recursive: true });
    writeFileSync(join(waveDir, 'backend', 'output.json'),
      JSON.stringify({ domain: 'backend', summary: 'ok', findings: [] }));
    // docs agent created its dir but crashed before writing output.json.
    mkdirSync(join(waveDir, 'docs'));

    const outputs = loadDomainOutputs(waveDir);
    const docs = outputs.find(o => o.domain === 'docs');
    assert.ok(docs, 'pre-fix: the docs dir was silently skipped — fewer totalDomains, wave read clean');
    assert.match(docs.parseError, /output\.json missing/);

    const { status: digestStatus, exitCode } = renderWithStatus('r-x', 1, outputs);
    assert.equal(digestStatus, 'pipeline_broken');
    assert.equal(exitCode, 2, 'CI must see the missing domain output as a pipeline failure');
  });

  it('healthy path: every domain dir carrying output.json still renders normally', () => {
    const waveDir = join(tmp, 'wave-2');
    mkdirSync(join(waveDir, 'backend'), { recursive: true });
    writeFileSync(join(waveDir, 'backend', 'output.json'),
      JSON.stringify({ domain: 'backend', summary: 'ok', findings: [] }));
    const outputs = loadDomainOutputs(waveDir);
    const { status: digestStatus, exitCode } = renderWithStatus('r-x', 2, outputs);
    assert.equal(digestStatus, 'clean');
    assert.equal(exitCode, 0);
  });
});

// ───────────────────────────────────────────────────────
// F-7970a30b — dispatch warns when it closes the revalidate window
// ───────────────────────────────────────────────────────

describe('F-7970a30b — dispatching over a failed wave with blocked agents warns loudly', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-window-close-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-window', { findings: false });
    dispatch({ runId: 'r-window', phase: 'health-audit-a', dbPath, outputDir: tmp });
    // domain-a blocks as invalid_output; domain-b is clean → wave fails.
    const outA = join(tmp, 'a.json');
    const outB = join(tmp, 'b.json');
    writeFileSync(outA, 'NOT JSON {{{');
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
    collect({ runId: 'r-window', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('the new dispatch carries a warning naming the failed wave and the redrive fallback', () => {
    const db = openDb(dbPath);
    const failedWave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-window' ORDER BY wave_number DESC LIMIT 1").get();
    assert.equal(failedWave.status, 'failed', 'precondition: wave 1 failed with a blocked agent');

    const { events } = captureStderr(() =>
      dispatch({ runId: 'r-window', phase: 'health-audit-a', dbPath, outputDir: tmp }));

    const db2 = openDb(dbPath);
    const waveCount = db2.prepare("SELECT COUNT(*) AS n FROM waves WHERE run_id = 'r-window'").get().n;
    assert.equal(waveCount, 2, 'abandon-and-retry stays a legitimate choice — dispatch is not blocked');

    const ev = events.find(e => e.stage === 'dispatch_supersedes_failed_wave');
    assert.ok(ev, 'pre-fix: nothing warned that the revalidate window was closing');
    assert.equal(ev.failedWaveId, failedWave.id);
    assert.ok(ev.blockedAgents >= 1);
  });

  it('the returned report carries the warning for the CLI surface', () => {
    const db = openDb(dbPath);
    const failedWave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-window' ORDER BY wave_number DESC LIMIT 1").get();

    let result;
    captureStderr(() => {
      result = dispatch({ runId: 'r-window', phase: 'health-audit-a', dbPath, outputDir: tmp });
    });
    assert.ok(result.supersededFailedWave, 'the report must carry the warning');
    assert.equal(result.supersededFailedWave.waveId, failedWave.id);
    assert.match(result.supersededFailedWave.message, /swarm redrive/,
      'the message must name the surviving recovery verb');
    assert.match(result.supersededFailedWave.message, /revalidate/,
      'the message must say WHICH window is closing');
  });

  it('healthy path: a normal dispatch after a collected wave carries no warning', () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'w4-window-ok-'));
    const dbPath2 = join(tmp2, 'control-plane.db');
    const repo2 = join(tmp2, 'repo');
    try {
      initGitRepo(repo2);
      setupRun(dbPath2, repo2, 'r-ok', { findings: false });
      dispatch({ runId: 'r-ok', phase: 'health-audit-a', dbPath: dbPath2, outputDir: tmp2 });
      const outA = join(tmp2, 'a.json');
      const outB = join(tmp2, 'b.json');
      writeFileSync(outA, JSON.stringify({ domain: 'domain-a', stage: 'A', summary: 'clean', findings: [] }));
      writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
      collect({ runId: 'r-ok', dbPath: dbPath2, outputs: { 'domain-a': outA, 'domain-b': outB } });
      const result = dispatch({ runId: 'r-ok', phase: 'health-audit-b', dbPath: dbPath2, outputDir: tmp2 });
      assert.equal(result.supersededFailedWave ?? null, null);
    } finally {
      closeDb(dbPath2);
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
