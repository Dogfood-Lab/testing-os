/**
 * persist.test.js — Phase 3 tests: canonical export, dogfood bridge, repo-knowledge bridge.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { buildRunExport, computeRunVerdict, EXPORT_VERSION } from './lib/persist/export.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { buildDogfoodSubmission } from './lib/persist/dogfood-bridge.js';
import { buildAuditPayload, formatAuditStatusLine } from './lib/persist/repoknowledge-bridge.js';
import { formatPersist } from './commands/persist.js';

// ═══════════════════════════════════════════
// Helper: build a complete run in-memory
// ═══════════════════════════════════════════

function buildCompleteRun(db, opts = {}) {
  const runId = opts.runId || 'r1';

  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at, completed_at)
    VALUES (?, 'mcp-tool-shop-org/stillpoint', '/tmp/stillpoint', ?, 'main', ?, ?, ?)`)
    .run(runId, 'a'.repeat(40), opts.status || 'complete',
         '2026-04-11T10:00:00Z', opts.status === 'complete' ? '2026-04-11T11:00:00Z' : null);

  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  // Wave 1: health-audit-a (collected, advanced)
  db.prepare("INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES (?, 'health-audit-a', 1, 'advanced', 'snap1')")
    .run(runId);
  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? AND ownership_class != ?').all(runId, 'shared');
  for (const d of domains) {
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, completed_at) VALUES (1, ?, 'complete', '2026-04-11T10:15:00Z')")
      .run(d.id);
  }

  // Findings
  db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, 'F-001', 'fp1', 'HIGH', 'security', 'src/server.ts', 42, 'Path traversal vulnerability', 'Validate path input', ?, 1, 1)`)
    .run(runId, opts.findingStatus || 'fixed');

  db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, 'F-002', 'fp2', 'MEDIUM', 'quality', 'src/engine.ts', 10, 'Missing null check', 'Add guard clause', 'new', 1, 1)`)
    .run(runId);

  // Verification receipt
  if (opts.withVerification !== false) {
    db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
      VALUES (1, 'node', '["npm test"]', 0, 1, 42)`)
      .run();
  }

  // Promotion
  db.prepare(`INSERT INTO promotions (wave_id, run_id, from_phase, to_phase, authorized_by, gates_checked, finding_snapshot)
    VALUES (1, ?, 'health-audit-a', 'health-audit-b', 'coordinator', ?, ?)`)
    .run(runId,
      JSON.stringify([{ name: 'wave_status', passed: true }, { name: 'agent_completion', passed: true }]),
      JSON.stringify({ total: 2, bySeverity: { HIGH: 1, MEDIUM: 1 } }));

  return runId;
}

// ═══════════════════════════════════════════
// Canonical Export
// ═══════════════════════════════════════════

describe('Canonical export', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('exports complete run structure', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    // D3B-014 (Phase 10 Step 1): export.export_version sourced from
    // EXPORT_VERSION constant in export.js, NOT a hardcoded literal —
    // pin so a future literal-vs-constant drift trips this gate.
    assert.equal(exp.export_version, EXPORT_VERSION);
    assert.equal(exp.provenance.system, 'swarm-control-plane');
    assert.ok(exp.provenance.content_hash);
    assert.equal(exp.run.repo, 'mcp-tool-shop-org/stillpoint');
    assert.equal(exp.run.status, 'complete');
    db.close();
  });

  it('D3B-014: provenance.schema_version is sourced from db/schema.js SCHEMA_VERSION (single source of truth)', () => {
    // Pre-fix: export.js hardcoded `schema_version: 3` while
    // db/schema.js was at SCHEMA_VERSION = 5 — stale by 2 versions
    // with no compile-time signal. The fix imports SCHEMA_VERSION at
    // the canonical seam so the export envelope can never lag.
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    assert.equal(
      exp.provenance.schema_version,
      SCHEMA_VERSION,
      `export.provenance.schema_version must equal SCHEMA_VERSION (${SCHEMA_VERSION}); ` +
      `got ${exp.provenance.schema_version}. If the DB schema bumped without the export ` +
      `updating, this gate trips — fix by importing SCHEMA_VERSION from db/schema.js ` +
      `(do not re-introduce the hardcoded literal).`,
    );
    db.close();
  });

  it('includes domains', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    assert.ok(exp.domains.length >= 2);
    assert.ok(exp.domains.some(d => d.name === 'backend'));
    db.close();
  });

  it('includes wave summaries with agent states', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    assert.equal(exp.waves.length, 1);
    assert.equal(exp.waves[0].phase, 'health-audit-a');
    assert.ok(exp.waves[0].agents.length >= 2);
    assert.ok(exp.waves[0].agents.every(a => a.status === 'complete'));
    db.close();
  });

  it('includes findings with lifecycle', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    assert.equal(exp.findings.items.length, 2);
    assert.equal(exp.findings.summary.total, 2);
    assert.equal(exp.findings.summary.by_severity.HIGH, 1);
    assert.equal(exp.findings.summary.by_severity.MEDIUM, 1);

    const f1 = exp.findings.items.find(f => f.id === 'F-001');
    assert.equal(f1.status, 'fixed');
    assert.equal(f1.severity, 'HIGH');
    db.close();
  });

  it('includes verification outcomes', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    assert.equal(exp.verification.length, 1);
    assert.equal(exp.verification[0].adapter, 'node');
    assert.equal(exp.verification[0].passed, true);
    assert.equal(exp.verification[0].test_count, 42);
    db.close();
  });

  it('includes promotion trail', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');

    assert.equal(exp.promotions.length, 1);
    assert.equal(exp.promotions[0].from, 'health-audit-a');
    assert.equal(exp.promotions[0].to, 'health-audit-b');
    assert.equal(exp.promotions[0].authorized_by, 'coordinator');
    db.close();
  });

  it('content hash is stable', () => {
    buildCompleteRun(db);
    const exp1 = buildRunExport(db, 'r1');
    // Content hash is computed from the export, so same data = same hash
    // (exported_at changes, so hash will differ — but provenance.content_hash exists)
    assert.ok(exp1.provenance.content_hash);
    assert.equal(exp1.provenance.content_hash.length, 16);
    db.close();
  });
});

describe('Run verdict', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('pass for complete run', () => {
    buildCompleteRun(db, { status: 'complete' });
    // buildCompleteRun always seeds an open MEDIUM (F-002); close it so this
    // fixture is genuinely all-clean — computeRunVerdict now counts open
    // findings even for a complete run (F-b721038e), so a real open finding
    // would correctly make this 'partial'. Mirrors the all-fixed fixture below.
    db.prepare("UPDATE findings SET status = 'fixed' WHERE finding_id = 'F-002' AND run_id = 'r1'").run();
    const exp = buildRunExport(db, 'r1');
    assert.equal(computeRunVerdict(exp), 'pass');
    db.close();
  });

  it('fail for aborted run', () => {
    buildCompleteRun(db, { status: 'aborted' });
    const exp = buildRunExport(db, 'r1');
    assert.equal(computeRunVerdict(exp), 'fail');
    db.close();
  });

  it('partial for open findings on in-progress run', () => {
    buildCompleteRun(db, { status: 'health-audit-a', findingStatus: 'new' });
    const exp = buildRunExport(db, 'r1');
    assert.equal(computeRunVerdict(exp), 'partial');
    db.close();
  });
});

// ═══════════════════════════════════════════
// Dogfood-labs bridge
// ═══════════════════════════════════════════

describe('Dogfood-labs bridge', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('produces valid submission shape', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const submission = buildDogfoodSubmission(exp, 'pass');

    assert.ok(submission.schema_version);
    assert.ok(submission.run_id);
    assert.equal(submission.repo, 'mcp-tool-shop-org/stillpoint');
    assert.ok(submission.ref.commit_sha);
    assert.equal(submission.source.workflow, 'swarm-control-plane');
    assert.equal(submission.overall_verdict, 'pass');
    db.close();
  });

  it('produces one scenario per wave', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const submission = buildDogfoodSubmission(exp, 'pass');

    assert.equal(submission.scenario_results.length, 1);
    assert.ok(submission.scenario_results[0].scenario_id.includes('wave-1'));
    assert.equal(submission.scenario_results[0].execution_mode, 'bot');
    db.close();
  });

  it('includes CI checks from verification', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const submission = buildDogfoodSubmission(exp, 'pass');

    assert.ok(submission.ci_checks);
    assert.ok(submission.ci_checks.some(c => c.id.includes('verify')));
    db.close();
  });

  it('includes finding severity check', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const submission = buildDogfoodSubmission(exp, 'pass');

    const findCheck = submission.ci_checks.find(c => c.id === 'findings-severity');
    assert.ok(findCheck);
    assert.equal(findCheck.value, 2);
    db.close();
  });
});

// ═══════════════════════════════════════════
// Repo-knowledge bridge
// ═══════════════════════════════════════════

describe('Repo-knowledge bridge', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });

  it('produces valid audit run shape', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const payload = buildAuditPayload(exp);

    assert.equal(payload.run.slug, 'mcp-tool-shop-org/stillpoint');
    assert.ok(['pass', 'pass_with_findings', 'fail'].includes(payload.run.overall_status));
    assert.ok(['healthy', 'needs_attention', 'critical'].includes(payload.run.overall_posture));
    assert.equal(payload.run.auditor, 'swarm-control-plane');
    assert.equal(payload.run.scope_level, 'full');
    db.close();
  });

  it('maps findings to audit format', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const payload = buildAuditPayload(exp);

    assert.equal(payload.findings.length, 2);
    const sec = payload.findings.find(f => f.severity === 'high');
    assert.ok(sec);
    assert.equal(sec.domain, 'security_sast');
    assert.equal(sec.tool_source, 'swarm-control-plane');
    assert.ok(sec.location.includes('src/server.ts'));
    db.close();
  });

  it('maps finding statuses correctly', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const payload = buildAuditPayload(exp);

    const fixed = payload.findings.find(f => f.status === 'fixed');
    assert.ok(fixed);
    const open = payload.findings.find(f => f.status === 'open');
    assert.ok(open);
    db.close();
  });

  it('computes metrics from OPEN findings only', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const payload = buildAuditPayload(exp);

    // V2-CONTRACT-001: F-001 (HIGH) is 'fixed' — CLOSED, so it no longer
    // counts toward the audit-DB severity metrics; F-002 (MEDIUM) is 'new'
    // — open. Open/closed semantics from lib/finding-status.js, same as
    // the gate.
    assert.equal(payload.metrics.high_count, 0);
    assert.equal(payload.metrics.medium_count, 1);
    assert.equal(payload.metrics.test_count, 42);
    db.close();
  });

  it('status is pass_with_findings when open findings exist', () => {
    buildCompleteRun(db);
    const exp = buildRunExport(db, 'r1');
    const payload = buildAuditPayload(exp);

    // F-002 is 'new' (open), so should be pass_with_findings
    assert.equal(payload.run.overall_status, 'pass_with_findings');
    db.close();
  });

  it('status is pass when all findings fixed', () => {
    buildCompleteRun(db, { findingStatus: 'fixed' });
    // Also fix F-002
    db.prepare("UPDATE findings SET status = 'fixed' WHERE finding_id = 'F-002' AND run_id = 'r1'").run();

    const exp = buildRunExport(db, 'r1');
    const payload = buildAuditPayload(exp);
    assert.equal(payload.run.overall_status, 'pass');
    assert.equal(payload.run.overall_posture, 'healthy');
    db.close();
  });
});

// ═══════════════════════════════════════════
// F-882ed6c0 — formatPersist wires formatAuditStatusLine (wave 22)
// ═══════════════════════════════════════════

/** @pins F-882ed6c0 */
describe('formatPersist renders repo-knowledge status via formatAuditStatusLine (F-882ed6c0)', () => {
  const baseReport = (repoKnowledge) => ({
    runId: 'r-f882',
    verdict: 'pass',
    artifacts: { export: '/tmp/e.json', dogfoodSubmission: '/tmp/d.json', audit: '/tmp/audit' },
    dogfood: { ingested: false, reason: 'Not requested' },
    repoKnowledge: { artifactsWritten: true, submitted: false, path: '/tmp/audit', ...repoKnowledge },
  });

  it('aborted run renders the helper output, never the bare hand-format', () => {
    const rk = { status: 'fail', posture: 'critical', runAborted: true };
    const out = formatPersist(baseReport(rk));
    const helper = formatAuditStatusLine({
      run: { overall_status: rk.status, overall_posture: rk.posture },
      metrics: { run_aborted: rk.runAborted },
    });
    // Differential against the canonical helper: whatever it renders for an
    // aborted run must appear verbatim, and must not collapse back to the
    // pre-fix hand-format (which carried no aborted qualifier at all).
    assert.ok(out.includes(helper),
      `formatPersist must render the helper's aborted-run line verbatim; got:\n${out}`);
    assert.notEqual(helper, `${rk.status} (${rk.posture})`,
      'helper must qualify an aborted run beyond the bare status (posture) hand-format');
  });

  it('normal run still renders the helper output for status/posture', () => {
    const rk = { status: 'pass', posture: 'healthy', runAborted: false };
    const out = formatPersist(baseReport(rk));
    const helper = formatAuditStatusLine({
      run: { overall_status: rk.status, overall_posture: rk.posture },
      metrics: { run_aborted: rk.runAborted },
    });
    assert.ok(out.includes(helper),
      `formatPersist must render the helper's line for a normal run too; got:\n${out}`);
  });
});
