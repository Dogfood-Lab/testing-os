/**
 * f-64e6da30-fixes-skipped-surfaces.test.js — GitHub #65 / F-64e6da30
 *
 * applyDeclaredFixes already skips unknown_id (and siblings) onto the
 * ephemeral collect report. Until this fix, status/receipt never read that
 * signal, so a wave whose declarations evaporated still looked clean
 * (world-forge swarm-1785831762-2a42: 26/57 unknown ids; status showed open
 * HIGH while several were already fixed in tree).
 *
 * Pins:
 *   1. collect persists a wave-level fixes_skipped rollup (kv)
 *   2. swarm status exposes counts-by-reason + capped id sample + blocker
 *      when unknown_id > 0 (not READY TO ADVANCE)
 *   3. swarm receipt JSON + markdown surface the same rollup
 *   4. isAgentBearingDomain skips coordinator as well as shared (verbs half
 *      of F-2710aadf / #67)
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
import { status, formatStatus } from './commands/status.js';
import { buildReceipt, formatReceiptMarkdown } from './commands/receipt.js';
import { readWaveFixesSkipped } from './commands/lib/fixes-skipped.js';
import { isAgentBearingDomain } from './commands/lib/agent-bearing.js';

const RUN_ID = 'test-f-64e6da30';

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
  return db;
}

function amendOutput(domain, fixes) {
  return JSON.stringify({
    domain,
    summary: `${domain} amend output (F-64e6da30 fixture)`,
    fixes,
    files_changed: [],
    verification_skipped: true,
  });
}

/** @pins F-64e6da30 */
describe('F-64e6da30 — fixes_skipped reaches status/receipt (GitHub #65)', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'f-64e6da30-'));
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

  it('persists a wave rollup and surfaces unknown_id on status + receipt (not silent READY TO ADVANCE)', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, amendOutput('domain-a', [
      { finding_id: 'F-A-001', description: 'real close' },
      { finding_id: 'F-NOPE-99', description: 'hallucinated wave-local id' },
      { finding_id: 'F-001', description: 'taught-by-brief bad id' },
    ]));
    writeFileSync(outB, amendOutput('domain-b', [
      { finding_id: 'F-B-001', description: 'real close' },
    ]));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.ok(report.fixes_skipped, 'collect report carries wave-level fixes_skipped');
    assert.equal(report.fixes_skipped.total, 2);
    assert.equal(report.fixes_skipped.by_reason.unknown_id, 2);
    assert.ok(report.fixes_skipped.sample_ids.includes('F-NOPE-99'));
    assert.ok(report.fixes_skipped.sample_ids.includes('F-001'));

    const dbPersist = openDb(dbPath);
    const persisted = readWaveFixesSkipped(dbPersist, report.waveId);
    dbPersist.close();
    assert.ok(persisted, 'rollup must outlive collect stdout (kv persistence)');
    assert.equal(persisted.by_reason.unknown_id, 2);

    const s = status({ runId: RUN_ID, dbPath });
    assert.ok(s.findings.fixesSkipped, 'status findings block exposes fixesSkipped');
    assert.equal(s.findings.fixesSkipped.by_reason.unknown_id, 2);
    assert.ok(
      s.assessment.blockers.some(b => /unknown_id|fixes\[\]|declaration/i.test(b)),
      `unknown_id must land in assessment blockers, got: ${JSON.stringify(s.assessment.blockers)}`,
    );
    assert.notEqual(
      s.assessment.state,
      'READY TO ADVANCE',
      'a wave that evaporated declarations must not look ready to advance',
    );

    const text = formatStatus(s);
    assert.match(text, /fixes_skipped|unknown_id|F-NOPE-99|F-001/i);

    const receipt = buildReceipt({ runId: RUN_ID, dbPath });
    assert.ok(receipt.fixes_skipped, 'receipt JSON carries fixes_skipped');
    assert.equal(receipt.fixes_skipped.by_reason.unknown_id, 2);
    const agentA = receipt.agents.find(a => a.domain === 'domain-a');
    assert.ok(Array.isArray(agentA.fixes_skipped), 'per-agent receipt row carries skipped sample');
    assert.equal(agentA.fixes_skipped.length, 2);

    const md = formatReceiptMarkdown(receipt);
    assert.match(md, /fixes.?skipped|unknown_id|F-NOPE-99/i);
  });

  it('isAgentBearingDomain skips coordinator as well as shared (verbs half of #67)', () => {
    assert.equal(isAgentBearingDomain({ ownership_class: 'owned' }), true);
    assert.equal(isAgentBearingDomain({ ownership_class: 'bridge' }), true);
    assert.equal(isAgentBearingDomain({ ownership_class: 'shared' }), false);
    assert.equal(isAgentBearingDomain({ ownership_class: 'coordinator' }), false);
  });
});
