/**
 * wave12-swarm-cp-pins.test.js — Wave-12 (feature-execute) swarm-cp feature pins.
 *
 * Three features + one advisor item, each pinned test-first against the
 * pre-feature behavior:
 *
 *   F-SWARMCP-001  `swarm defer <run> --ids … --reason "<text>"` flips open
 *                  findings to `deferred`, writes a reason-bearing
 *                  finding_events row, and is idempotent over terminal rows.
 *   F-SWARMCP-002  `swarm reject …` — same shape, terminal status `rejected`.
 *                  --reason is REQUIRED for both; empty/missing → exit 1.
 *   F-SWARMCP-004  collect's buildSummary byStatus rollup is dynamic — it no
 *                  longer silently drops `unverified` / `rejected`.
 *   (advisor)      revalidate flips a repaired-to-`collected` FULL-coverage
 *                  audit wave through the SAME by-absence classification collect
 *                  uses, so priors not rediscovered anywhere in the wave are
 *                  closed as `fixed` — a PARTIAL repair leaves them OPEN.
 *
 * The anti-trap pin (F-SWARMCP-001) is the reason `defer` exists: a deferred
 * finding must SURVIVE a full-coverage re-classification un-flipped, so deferred
 * work stops being silently closed-unfixed by a later full-coverage audit.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { isOpenFinding } from './lib/finding-status.js';
import { classifyFindings } from './lib/fingerprint.js';
import { revalidate } from './commands/revalidate.js';
import { buildSummary } from './commands/collect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(verb, args, dbPath) {
  return execFileSync(process.execPath, [CLI_PATH, verb, ...args], {
    encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
  });
}

function spawnCli(verb, args, dbPath) {
  // execFileSync throws on non-zero exit; return a status/stderr shape instead.
  try {
    const stdout = runCli(verb, args, dbPath);
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

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

// ───────────────────────────────────────────────────────
// F-SWARMCP-001 / F-SWARMCP-002 — defer / reject verbs
// ───────────────────────────────────────────────────────

describe('F-SWARMCP-001/002 — swarm defer / reject terminal-disposition verbs', () => {
  let tmp, dbPath;
  const RUN = 'r-disp';

  function seedFindings() {
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN, 'org/r', tmp, 'a'.repeat(40));
    const w = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(RUN);
    const waveId = Number(w.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, ?, ?, ?, 'bug', ?, ?, ?, ?)`);
    ins.run(RUN, 'F-001', 'fp1', 'HIGH', 'first', 'new', waveId, waveId);
    ins.run(RUN, 'F-002', 'fp2', 'MEDIUM', 'second', 'recurring', waveId, waveId);
    ins.run(RUN, 'F-003', 'fp3', 'LOW', 'third', 'approved', waveId, waveId);
    closeDb(dbPath);
    return { waveId };
  }

  function findingStatus(id) {
    const db = openDb(dbPath);
    const row = db.prepare('SELECT id, status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN, id);
    closeDb(dbPath);
    return row;
  }

  function eventsFor(pk, type) {
    const db = openDb(dbPath);
    const rows = db.prepare(
      'SELECT event_type, notes FROM finding_events WHERE finding_id = ? AND event_type = ?'
    ).all(pk, type);
    closeDb(dbPath);
    return rows;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w12-disp-'));
    dbPath = join(tmp, 'control-plane.db');
    seedFindings();
  });
  // F-8ad2d58d/F-f8798fd7: 6 of this block's 7 it()s spawn the CLI via
  // spawnCli()/execFileSync against this real file-backed dbPath. closeDb only
  // releases THIS process's own pooled connection (db/connection.js) — it
  // cannot release the just-exited child process's OS-level lock on the
  // -wal/-shm sidecar files, so rmSync (the call that actually raises Windows
  // EBUSY/EPERM) must be guarded too, matching the sibling idiom established
  // package-wide for this exact race (meta-amendB-operator-output.test.js,
  // amend2-d3b-004-cli-globs.test.js, cli-smoke.test.js, et al.).
  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('defer flips status to deferred AND writes a reason-bearing finding_event', () => {
    const r = spawnCli('defer', [RUN, '--ids', 'F-001,F-002', '--reason', 'accepted for next stage'], dbPath);
    assert.equal(r.status, 0, `defer failed: ${r.stderr}`);
    assert.match(r.stdout, /Deferred 2 findings for r-disp/);

    const f1 = findingStatus('F-001');
    assert.equal(f1.status, 'deferred');
    const ev = eventsFor(f1.id, 'deferred');
    assert.equal(ev.length, 1, 'exactly one deferred event per flipped finding');
    assert.equal(ev[0].notes, 'accepted for next stage', 'the reason must land in finding_events.notes');
    assert.equal(findingStatus('F-002').status, 'deferred');
    assert.equal(findingStatus('F-003').status, 'approved', 'untargeted findings are untouched');
  });

  it('reject flips status to rejected AND writes a reason-bearing finding_event', () => {
    const r = spawnCli('reject', [RUN, '--ids', 'F-001', '--reason', 'not a defect'], dbPath);
    assert.equal(r.status, 0, `reject failed: ${r.stderr}`);
    assert.match(r.stdout, /Rejected 1 findings for r-disp/);

    const f1 = findingStatus('F-001');
    assert.equal(f1.status, 'rejected');
    const ev = eventsFor(f1.id, 'rejected');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].notes, 'not a defect');
  });

  it('defer/reject require a non-empty --reason (missing → exit 1, no mutation)', () => {
    const missing = spawnCli('defer', [RUN, '--ids', 'F-001'], dbPath);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--reason "<text>" is required/);
    assert.equal(findingStatus('F-001').status, 'new', 'no flip on a missing reason');

    // `--reason --ids` swallow guard: the following flag is NOT the reason.
    const swallowed = spawnCli('reject', [RUN, '--ids', 'F-001', '--reason', '--ids'], dbPath);
    assert.equal(swallowed.status, 1);
    assert.match(swallowed.stderr, /--reason "<text>" is required/);
    assert.equal(findingStatus('F-001').status, 'new');
  });

  it('defer/reject require --ids (no --all disposition path)', () => {
    const noIds = spawnCli('defer', [RUN, '--reason', 'x'], dbPath);
    assert.equal(noIds.status, 1);
    assert.match(noIds.stderr, /Specify --ids/);
  });

  it('defer is idempotent — a re-run over an already-deferred finding flips 0 and adds no event', () => {
    spawnCli('defer', [RUN, '--ids', 'F-001', '--reason', 'first'], dbPath);
    const pk = findingStatus('F-001').id;
    assert.equal(eventsFor(pk, 'deferred').length, 1);

    const again = spawnCli('defer', [RUN, '--ids', 'F-001', '--reason', 'second'], dbPath);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Deferred 0 findings for r-disp/);
    assert.equal(eventsFor(pk, 'deferred').length, 1,
      'a terminal-status finding is skipped — no duplicate deferred event');
  });

  it('gates treat both deferred and rejected as CLOSED (isOpenFinding false)', () => {
    assert.equal(isOpenFinding('deferred'), false);
    assert.equal(isOpenFinding('rejected'), false);
    assert.equal(isOpenFinding('new'), true);
  });

  // The anti-trap pin: deferred work must NOT be silently closed-unfixed by a
  // later full-coverage audit. classifyFindings skips terminal priors
  // (fingerprint.js:484), so a deferred prior NOT rediscovered stays deferred.
  it('a deferred finding SURVIVES a full-coverage classification un-flipped (not closed as fixed)', () => {
    spawnCli('defer', [RUN, '--ids', 'F-001', '--reason', 'accepted'], dbPath);

    const db = openDb(dbPath);
    const rows = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(RUN);
    closeDb(dbPath);
    const priorMap = new Map(rows.map(r => [r.fingerprint, r]));
    const deferred = rows.find(r => r.finding_id === 'F-001');
    assert.equal(deferred.status, 'deferred', 'precondition: F-001 is deferred');

    // Full coverage, F-001 NOT rediscovered this wave.
    const classified = classifyFindings([], priorMap, { full: true });
    const fixedFps = new Set(classified.fixed.map(f => f.fingerprint));
    assert.ok(!fixedFps.has(deferred.fingerprint),
      'a deferred prior must NOT be reclassified as fixed by a full-coverage audit');
  });
});

// ───────────────────────────────────────────────────────
// F-SWARMCP-004 — dynamic byStatus rollup in collect's summary
// ───────────────────────────────────────────────────────

describe('F-SWARMCP-004 — collect buildSummary byStatus is dynamic (no silent drops)', () => {
  let tmp, dbPath, repoPath;
  const RUN = 'r-rollup';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w12-rollup-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('a status not in the old hard-coded literal (unverified/rejected) is counted, not dropped', () => {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/r', ?, ?, 'main', 'health-audit-a')`).run(RUN, repoPath, 'a'.repeat(40));
    saveDomainDraft(db, RUN, [{ name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' }]);
    freezeDomains(db, RUN);
    const w = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(RUN);
    const waveId = Number(w.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, ?, ?, 'LOW', 'bug', 'd', ?, ?, ?)`);
    ins.run(RUN, 'F-U', 'fpu', 'unverified', waveId, waveId);
    ins.run(RUN, 'F-R', 'fpr', 'rejected', waveId, waveId);
    ins.run(RUN, 'F-D', 'fpd', 'deferred', waveId, waveId);
    const waveRow = db.prepare('SELECT * FROM waves WHERE id = ?').get(waveId);

    const report = { agents: [], violations: [], findings: { new: 0, recurring: 0, fixed: 0 } };
    const summary = buildSummary(db, RUN, waveRow, report);
    closeDb(dbPath);

    // Pre-fix, unverified + rejected were silently dropped by the hard-coded
    // { new, recurring, approved, fixed, deferred } literal + `!= null` guard.
    assert.match(summary, /unverified: 1/, 'the rollup must count unverified');
    assert.match(summary, /rejected: 1/, 'the rollup must count rejected');
    assert.match(summary, /deferred: 1/, 'the rollup must count deferred');
  });
});

// ───────────────────────────────────────────────────────
// Advisor — revalidate full-coverage reclassification
// ───────────────────────────────────────────────────────

describe('revalidate — a repaired-to-collected FULL-coverage audit wave closes absent priors', () => {
  let tmp, dbPath, repoPath;
  const RUN = 'r-reval-fc';

  function seed({ partial }) {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/r', ?, ?, 'main', 'feature-audit')`).run(RUN, repoPath, 'a'.repeat(40));
    saveDomainDraft(db, RUN, [
      { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
      { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN);

    // Wave 1 — the EARLIER wave where the prior finding was last seen.
    db.prepare(
      "INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id) VALUES (1, ?, 'feature-audit', 1, 'collected', 'snap')"
    ).run(RUN);
    // Wave 2 — the current feature-audit wave in 'failed' (post-collect-rejection
    // shape). revalidate targets the LATEST wave (wave 2).
    const w = db.prepare(
      "INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id) VALUES (2, ?, 'feature-audit', 2, 'failed', 'snap')"
    ).run(RUN);
    const waveId = Number(w.lastInsertRowid);

    const doms = db.prepare("SELECT id, name FROM domains WHERE run_id = ? ORDER BY name").all(RUN);
    const domA = doms.find(d => d.name === 'domain-a');
    const domB = doms.find(d => d.name === 'domain-b');

    // domain-a is blocked (invalid_output) — the one we will repair.
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, error_message) VALUES (?, ?, 'invalid_output', 'schema')")
      .run(waveId, domA.id);
    // domain-b: complete for the full-coverage case, still blocked for partial.
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, error_message) VALUES (?, ?, ?, ?)")
      .run(waveId, domB.id, partial ? 'invalid_output' : 'complete', partial ? 'schema' : null);

    // A prior OPEN finding last seen in wave 1 (the earlier wave), in scope, NOT
    // rediscovered in wave 2. last_seen_wave = 1 (NOT the current wave's id=2),
    // so it is a genuine earlier-wave prior — a current-wave row would appear in
    // classifyFindings' currentSet and be skipped, not closed by absence.
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-PRIOR', 'fp-prior', 'HIGH', 'bug', 'packages/b/y.js', 'earlier defect', 'approved', 1, 1)`).run(RUN);

    closeDb(dbPath);
    return { waveId };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w12-reval-fc-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  function writeAuditOutput(name, confirmed = []) {
    const p = join(tmp, `${name}.json`);
    // A clean feature-audit output rediscovers NOTHING. `confirmed` is the
    // agent's declaration of which open priors it actually checked and found
    // gone — required for a close since revalidate stopped reading coverage
    // alone as evidence (see the FULL-coverage test below).
    writeFileSync(p, JSON.stringify({ domain: name, summary: 'clean', features: [], confirmed }));
    return p;
  }

  it('FULL coverage: the repaired-to-collected wave closes the absent prior as fixed with a by-absence event', () => {
    seed({ partial: false });
    const report = revalidate({
      runId: RUN, dbPath,
      // The repaired agent DECLARES it checked F-PRIOR and found it gone.
      // Coverage alone no longer closes anything here: this branch is the
      // second classifyFindings caller, and it read "every domain completed" as
      // proof the wave looked for THIS defect — which coverage never says. The
      // lens is what decides that, and it changes between stages. Unchanged:
      // the property this pin exists for — a repaired-to-collected full-coverage
      // wave DOES run the reclassification and DOES leave a by-absence event.
      // The undeclared direction is pinned by the GATE RED test below.
      outputs: { 'domain-a': writeAuditOutput('domain-a', ['F-PRIOR']) },
      reason: 'repair domain-a',
      apply: true,
    });
    assert.equal(report.waveStatusAfter, 'collected', 'the wave must flip to collected');

    const db = openDb(dbPath);
    const prior = db.prepare("SELECT id, status FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR'").get(RUN);
    const closeEvents = db.prepare(
      "SELECT notes FROM finding_events WHERE finding_id = ? AND event_type = 'fixed'"
    ).all(prior.id);
    closeDb(dbPath);

    assert.equal(prior.status, 'fixed', 'a full-coverage repair must close the absent prior as fixed');
    assert.ok(closeEvents.some(e => /absence/i.test(e.notes || '')),
      'the closure must carry a "closed by absence" finding_event');
  });

  it('GATE RED: full coverage WITHOUT a declaration closes nothing here either', () => {
    // The sibling half of the collect-path gate (wave4-swarm-cp-pins.test.js's
    // own "GATE RED"). It exists because the collect fix MISSED this caller
    // entirely: `confirmed` was threaded through collect.js and not through
    // revalidate.js, so the same absence that was inert on one path still
    // closed a finding on the other — a fix applied to the instance and not the
    // class, found by swarm-cp-core's wave-31 audit. Byte-identical to the test
    // above except for the missing declaration.
    seed({ partial: false });
    const report = revalidate({
      runId: RUN, dbPath,
      outputs: { 'domain-a': writeAuditOutput('domain-a') },
      reason: 'repair domain-a',
      apply: true,
    });
    assert.equal(report.waveStatusAfter, 'collected', 'the wave still flips to collected');

    const db = openDb(dbPath);
    const prior = db.prepare("SELECT status FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR'").get(RUN);
    closeDb(dbPath);
    assert.notEqual(prior.status, 'fixed',
      'an undeclared prior must NOT close on silence, even when every domain completed');
    // It keeps its prior OPEN status ('approved') rather than flipping to
    // 'unverified': this block passes `unverified: []` to upsertFindings by
    // deliberate design (see revalidate.js's point-repair note — revalidate is
    // a repair, not a re-audit, and does not restate sibling agents' statuses).
    // The gate's contract is "silence does not CLOSE it"; which open status it
    // keeps is that older decision's business, not this one's.
    assert.ok(isOpenFinding(prior.status),
      `the prior must remain OPEN and re-askable next wave (got '${prior.status}')`);
  });

  it('PARTIAL repair: another agent still blocked → wave stays failed and the prior stays OPEN', () => {
    seed({ partial: true });
    const report = revalidate({
      runId: RUN, dbPath,
      outputs: { 'domain-a': writeAuditOutput('domain-a') },
      reason: 'repair domain-a only',
      apply: true,
    });
    assert.equal(report.waveStatusAfter, 'failed', 'a partial repair must NOT recover the wave');

    const db = openDb(dbPath);
    const prior = db.prepare("SELECT status FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR'").get(RUN);
    closeDb(dbPath);
    assert.equal(prior.status, 'approved', 'a partial repair must NOT close the prior by absence');
  });
});
