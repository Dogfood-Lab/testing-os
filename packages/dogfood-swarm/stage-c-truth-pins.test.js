/**
 * stage-c-truth-pins.test.js — Stage C truth-surface regression pins.
 *
 * Six targeted tests for the failure-path truth surfaces Stage C added in
 * commit 623db0a + follow-up amend. Each test names the specific failure
 * mode it pins so future regressions surface as named test red rather than
 * silent drift back to the wrong-shape default.
 *
 *   serial_verify_required is set on wave when any agent skipped verify
 *     Pins TRUTH-001 / TRUTH-003 — DB write path
 *     Would fail without the fix at: packages/dogfood-swarm/commands/collect.js
 *
 *   computeAssessment returns VERIFY REQUIRED, not READY TO ADVANCE,
 *   when serial-verify is required and no passing verification exists
 *     Pins TRUTH-001 — assessment-state branch
 *     Would fail without the fix at: packages/dogfood-swarm/commands/status.js
 *
 *   formatStatus renders Save point: <tag> line and omits it when null
 *     Pins C-FAIL-005 / OPF-2 — save-point surface rendering
 *     Would fail without the fix at: packages/dogfood-swarm/commands/status.js
 *
 *   revalidate --apply summary states ALL-agents recovery contract
 *     Pins TRUTH-002 — partial-repair contract prose
 *     Would fail without the fix at: packages/dogfood-swarm/commands/revalidate.js
 *
 *   collect buildSummary surfaces Wave status: dispatched → failed line
 *     Pins OPF-3 — wave-status transition surfacing in buildSummary
 *     Would fail without the fix at: packages/dogfood-swarm/commands/collect.js
 *
 *   receipt JSON and Markdown include serial_verify_required and
 *   per-agent verification_skipped
 *     Pins TRUTH-003 — receipt-surface persistence + render
 *     Would fail without the fix at: packages/dogfood-swarm/commands/receipt.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { revalidate } from './commands/revalidate.js';
import { status, formatStatus } from './commands/status.js';
import { buildReceipt, exportReceipt } from './commands/receipt.js';

const RUN_ID = 'test-stage-c-truth-pins';

function setupRunWithAmendWave(dbPath, repoPath) {
  const db = openDb(dbPath);

  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, save_point_tag)
    VALUES (?, ?, ?, ?, 'main', 'pending', NULL)`)
    .run(RUN_ID, 'org/repo', repoPath, 'a'.repeat(40));

  saveDomainDraft(db, RUN_ID, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);

  // Approved findings give the amend agents real work to claim a fix against.
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

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });
}

// ───────────────────────────────────────────────────────
// Test 1: TRUTH-001 / TRUTH-003 DB write path
// ───────────────────────────────────────────────────────

describe('serial_verify_required is set on wave when any agent skipped verify', () => {
  // Pins TRUTH-001 / TRUTH-003 — DB write path.
  // The wave-level column must reflect verification_skipped from any agent
  // output, AND the per-agent agent_runs.verification_skipped column must
  // record forensic identity (which agent skipped).
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stage-c-pin1-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    setupRunWithAmendWave(dbPath, repoPath);
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

  it('writes 1 to waves.serial_verify_required and agent_runs.verification_skipped', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'skipped per discipline',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [],
      verification_skipped: true,
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'ran locally',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const db = openDb(dbPath);
    const waveRow = db.prepare(
      'SELECT id, serial_verify_required FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
    ).get(RUN_ID);
    assert.equal(waveRow.serial_verify_required, 1,
      'waves.serial_verify_required must be 1 when any agent had verification_skipped:true');

    const arARow = db.prepare(`
      SELECT ar.verification_skipped FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ? AND d.name = 'domain-a'
    `).get(waveRow.id);
    const arBRow = db.prepare(`
      SELECT ar.verification_skipped FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ? AND d.name = 'domain-b'
    `).get(waveRow.id);

    assert.equal(arARow.verification_skipped, 1,
      'agent_runs.verification_skipped must be 1 for the agent that skipped');
    assert.equal(arBRow.verification_skipped, 0,
      'agent_runs.verification_skipped must stay 0 for the agent that did not skip');
  });
});

// ───────────────────────────────────────────────────────
// Test 2: TRUTH-001 VERIFY REQUIRED branch
// ───────────────────────────────────────────────────────

describe('computeAssessment returns VERIFY REQUIRED, not READY TO ADVANCE, when serial-verify is required', () => {
  // Pins TRUTH-001 — the wave status check in computeAssessment must branch
  // to VERIFY REQUIRED before falling through to READY TO ADVANCE when
  // wave.serial_verify_required && no passing verification_receipts row.
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stage-c-pin2-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    setupRunWithAmendWave(dbPath, repoPath);
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

  it('returns VERIFY REQUIRED state and the npm run verify next action', () => {
    // Both agents skip verify, so collect should set serial_verify_required.
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

    collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const s = status({ runId: RUN_ID, dbPath });
    assert.equal(s.assessment.state, 'VERIFY REQUIRED',
      'assessment must refuse READY TO ADVANCE while serial-verify is pending');
    assert.match(s.assessment.nextAction, /npm run verify/,
      'next action must name `npm run verify` against the cumulative tree');
    assert.match(s.assessment.nextAction, /serial/i,
      'next action must reference the serial-verify discipline');
  });
});

// ───────────────────────────────────────────────────────
// Test 3: C-FAIL-005 / OPF-2 Save point rendering
// ───────────────────────────────────────────────────────

describe('formatStatus renders Save point: <tag> line and omits when null', () => {
  // Pins C-FAIL-005 / OPF-2 — the save-point surface rendering.
  // The literal `Save point: ${tag}  (rollback: git reset --hard ${tag})`
  // must appear when run.save_point_tag is set; the line must NOT appear
  // (NOT as `Save point: undefined`) when the column is null.
  it('emits Save point: <tag> line when savePointTag is present', () => {
    const s = {
      run: {
        id: 'r1', repo: 'org/r', status: 'health-audit-a',
        branch: 'main', commitSha: 'abcdef0123',
        savePointTag: 'swarm-save-1234567890',
        timeoutPolicy: '1800s',
      },
      domains: [],
      waves: { total: 0, current: null },
      agents: [],
      agentSummary: { total: 0, complete: 0, inFlight: 0, blocked: 0 },
      findings: {
        total: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byStatus: {},
        open: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        thisWave: { new: 0, recurring: 0, fixed: 0 },
      },
      violations: 0,
      lastVerification: null,
      waveReceipt: null,
      assessment: { state: 'NO WAVE', blockers: [], nextAction: 'Run dispatch' },
    };

    const out = formatStatus(s);
    assert.match(out, /Save point: swarm-save-1234567890  \(rollback: git reset --hard swarm-save-1234567890\)/,
      'Save point line must render verbatim with rollback hint');
    assert.doesNotMatch(out, /Save point: undefined/,
      'Save point line must never render undefined');
  });

  it('omits Save point line when savePointTag is null', () => {
    const s = {
      run: {
        id: 'r1', repo: 'org/r', status: 'health-audit-a',
        branch: 'main', commitSha: 'abcdef0123',
        savePointTag: null,
        timeoutPolicy: '1800s',
      },
      domains: [],
      waves: { total: 0, current: null },
      agents: [],
      agentSummary: { total: 0, complete: 0, inFlight: 0, blocked: 0 },
      findings: {
        total: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byStatus: {},
        open: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        thisWave: { new: 0, recurring: 0, fixed: 0 },
      },
      violations: 0,
      lastVerification: null,
      waveReceipt: null,
      assessment: { state: 'NO WAVE', blockers: [], nextAction: 'Run dispatch' },
    };

    const out = formatStatus(s);
    assert.doesNotMatch(out, /Save point:/,
      'Save point line must be omitted entirely when tag is null (not rendered as undefined)');
  });
});

// ───────────────────────────────────────────────────────
// Test 4: TRUTH-002 partial-repair ALL-agents contract
// ───────────────────────────────────────────────────────

describe('revalidate --apply summary states ALL-agents recovery contract', () => {
  // Pins TRUTH-002 — partial-repair contract.
  // When the wave stays `failed` post-apply (not every blocked agent_run was
  // repaired), the summary must include the `Wave NOT recovered: N
  // agent_run(s) remain blocked` clause that names the
  // every-latest-must-be-complete contract.
  let tmpDir, dbPath, outputDir;
  const REVAL_RUN_ID = 'test-stage-c-truth-reval';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stage-c-pin4-'));
    dbPath = join(tmpDir, 'control-plane.db');
    outputDir = join(tmpDir, 'outputs');
    mkdirSync(outputDir, { recursive: true });

    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(REVAL_RUN_ID, 'org/r', tmpDir, 'a'.repeat(40));

    saveDomainDraft(db, REVAL_RUN_ID, [
      { name: 'backend',    globs: ['packages/**'], ownership_class: 'owned' },
      { name: 'ci-tooling', globs: ['.github/**'],  ownership_class: 'owned' },
      { name: 'docs',       globs: ['*.md'],        ownership_class: 'owned' },
      { name: 'tests',      globs: ['**/*.test.*'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, REVAL_RUN_ID);

    // Wave 2 (amend) in 'failed' status with 4 blocked agent_runs.
    db.prepare(`
      INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES (1, ?, 'health-amend-a', 2, 'failed', 'snap-test')
    `).run(REVAL_RUN_ID);

    const domains = db.prepare(
      'SELECT * FROM domains WHERE run_id = ? AND ownership_class != ? ORDER BY name'
    ).all(REVAL_RUN_ID, 'shared');
    for (const d of domains) {
      db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status, error_message, started_at)
        VALUES (1, ?, 'invalid_output', 'old schema rejection', ?)
      `).run(d.id, new Date('2026-05-14T00:00:00Z').toISOString());
    }
    db.close();
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAmendOutput(domain) {
    const outputPath = join(outputDir, `${domain}.json`);
    writeFileSync(outputPath, JSON.stringify({
      domain,
      summary: `${domain} amend output (test fixture)`,
      fixes: [{ finding_id: `F-${domain}`, description: `${domain} fix` }],
      files_changed: [],
    }, null, 2), 'utf-8');
    return outputPath;
  }

  it('emits Wave NOT recovered: N agent_run(s) remain blocked clause when only some agents repaired', () => {
    // Repair only 1 of 4 — wave should stay failed; the operator-visible
    // recovery clause must surface the gap.
    const outputs = { backend: writeAmendOutput('backend') };

    const result = revalidate({
      runId: REVAL_RUN_ID, dbPath, outputs, reason: 'partial repair probe', apply: true,
    });

    assert.match(result.summary, /Wave NOT recovered: 3 agent_run\(s\) remain blocked/,
      'partial-repair clause must name the blocked-count explicitly');
    assert.match(result.summary, /Wave flips to collected only when every latest agent_run is complete/,
      'partial-repair clause must name the ALL-agents recovery contract');
    assert.match(result.summary, /3 blocked agent_run\(s\) were not in the --domain set/,
      'partial-repair clause must surface the unaddressed bucket count');
  });
});

// ───────────────────────────────────────────────────────
// Test 5: OPF-3 collect Wave status: dispatched → failed line
// ───────────────────────────────────────────────────────

describe('collect buildSummary surfaces Wave status: dispatched → failed line', () => {
  // Pins OPF-3 — when a wave flips to failed, the summary must name the
  // transition explicitly + name `swarm revalidate` as the recovery path
  // so the operator does not have to infer it from a subsequent `No
  // dispatched wave found` error.
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stage-c-pin5-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    setupRunWithAmendWave(dbPath, repoPath);
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

  it('emits Wave status: dispatched → failed and the swarm revalidate recovery hint', () => {
    // Malformed output triggers validation_errors → wave flips to failed.
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({ wrong_shape: true }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'fine',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.equal(report.waveStatusBefore, 'dispatched');
    assert.equal(report.waveStatusAfter, 'failed');
    assert.match(report.summary, /Wave status: dispatched → failed/,
      'buildSummary must surface the wave-status transition explicitly');
    assert.match(report.summary, /Recovery: `swarm revalidate /,
      'buildSummary must name `swarm revalidate` as recovery on failed transition');
  });
});

// ───────────────────────────────────────────────────────
// Test 6: TRUTH-003 receipt JSON + Markdown render
// ───────────────────────────────────────────────────────

describe('receipt JSON and Markdown include serial_verify_required and per-agent verification_skipped', () => {
  // Pins TRUTH-003 — receipt-surface persistence + render.
  // The wave receipt is the operator's primary persisted artifact for a
  // wave; the discipline signal must not collapse here.
  let tmpDir, dbPath, repoPath, receiptDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stage-c-pin6-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    receiptDir = join(tmpDir, 'receipts');
    initGitRepo(repoPath);
    setupRunWithAmendWave(dbPath, repoPath);
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

  it('surfaces wave.serial_verify_required and per-agent verification_skipped in JSON + MD', () => {
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
      summary: 'ran',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const receipt = buildReceipt({ runId: RUN_ID, dbPath });
    assert.equal(receipt.wave.serial_verify_required, true,
      'receipt.wave.serial_verify_required must reflect the persisted DB column');

    const aReceipt = receipt.agents.find(a => a.domain === 'domain-a');
    const bReceipt = receipt.agents.find(a => a.domain === 'domain-b');
    assert.equal(aReceipt.verification_skipped, true,
      'receipt.agents[domain-a].verification_skipped must be true');
    assert.equal(bReceipt.verification_skipped, false,
      'receipt.agents[domain-b].verification_skipped must be false');

    const { mdPath } = exportReceipt(receipt, receiptDir);
    const md = readFileSync(mdPath, 'utf-8');
    assert.match(md, /\*\*Serial verify required:\*\* yes/,
      'receipt MD must surface wave-level Serial verify required line');
    assert.match(md, /\| Verify skipped \|/,
      'receipt MD agents table must include Verify skipped column header');
    // domain-a row marks yes; domain-b row marks no.
    assert.match(md, /\| domain-a \| owned \| complete \| yes \|/,
      'receipt MD must mark domain-a (skipped) as yes in the agents table');
    assert.match(md, /\| domain-b \| owned \| complete \| no \|/,
      'receipt MD must mark domain-b (did not skip) as no in the agents table');
  });
});
