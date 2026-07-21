/**
 * persist-ingest-timestamp-rfc3339.test.js
 *
 * Observed in run swarm-1784601601-bd4a (ai-rpg-engine): `swarm persist
 * --ingest` wrote a dogfood-submission.json whose timing block was
 *
 *   {"started_at": "2026-07-21 02:40:01",
 *    "finished_at": "2026-07-21 02:40:01",
 *    "duration_ms": 0}
 *
 * Two defects in one block:
 *
 *   1. FORMAT — buildRunExport passed runs/waves/promotions timestamps
 *      through verbatim, and those columns default to SQLite
 *      datetime('now'): space-separated, timezone-unmarked. The submission
 *      and record schemas constrain timing to JSON-Schema
 *      format:"date-time" (RFC 3339), so the repo's OWN ingest bounced the
 *      repo's OWN bridge — record_schema_invalid_from_submission on
 *      /timing/started_at and /timing/finished_at — and the run's evidence
 *      never landed. Never caught here because every prior fixture inserted
 *      already-ISO strings; production relies on the column DEFAULT.
 *
 *   2. VALUES — the run was still OPEN (runs.completed_at NULL), so the
 *      fp-p-003 fallback `finished_at = run.completed || run.created`
 *      reused the start timestamp: started_at == finished_at, duration_ms
 *      0, against ~52 minutes of recorded wave activity (wave completed
 *      03:18:31, promotion 03:32:33).
 *
 * The fix converts at the READ boundary (lib/persist/sqlite-datetime.js in
 * buildRunExport) so every artifact inherits RFC 3339 UTC, and derives an
 * honest finished_at from the run's latest TERMINAL event
 * (run.last_terminal_event_at) — DB truth, not the export wall clock, so
 * fp-p-003's dedup-key stability survives.
 *
 * Validation here goes through the repo's own canonical validator
 * (validatePayload from @dogfood-lab/schemas) — the exact seam
 * packages/verify's submission gate and packages/ingest's validateRecord
 * both delegate to (H3), i.e. the gates that rejected the live artifact.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { validatePayload } from '@dogfood-lab/schemas';
import { precheckSubmission } from '@dogfood-lab/report/build-submission.js';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { buildRunExport } from './lib/persist/export.js';
import { buildDogfoodSubmission } from './lib/persist/dogfood-bridge.js';
import { buildAuditPayload } from './lib/persist/repoknowledge-bridge.js';
import { toRfc3339Utc } from './lib/persist/sqlite-datetime.js';

const SHA = 'a'.repeat(40);

// The live run's timeline, in the exact stored shapes production writes:
// SQLite datetime('now') rows (space-separated, unmarked UTC) for
// runs/waves/receipts/promotions, Date#toISOString() rows for agent_runs
// (lib/state-machine.js). The promotion is the LATEST terminal event and
// deliberately sits in a SQLite-shaped row while an EARLIER agent event is
// ISO-shaped — a lexicographic max across the raw strings would pick the
// 'T'-separated 03:10 over the space-separated 03:32 ('T' > ' ').
const RUN_CREATED_SQLITE = '2026-07-21 02:40:01';
const WAVE_CREATED_SQLITE = '2026-07-21 02:47:53';
const AGENT_COMPLETED_ISO = '2026-07-21T03:10:00.000Z';
const WAVE_COMPLETED_SQLITE = '2026-07-21 03:18:31';
const PROMOTION_SQLITE = '2026-07-21 03:32:33';

/** Seed the live run's shape: OPEN run (completed_at NULL) with real activity. */
function seedOpenRunWithActivity(db, runId = 'swarm-1784601601-bd4a') {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at, completed_at)
    VALUES (?, 'mcp-tool-shop-org/ai-rpg-engine', '/tmp/ai-rpg-engine', ?, 'main', 'feature-audit', ?, NULL)`)
    .run(runId, SHA, RUN_CREATED_SQLITE);

  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id, created_at, completed_at)
    VALUES (?, 'feature-execute', 1, 'advanced', 'snap1', ?, ?)`)
    .run(runId, WAVE_CREATED_SQLITE, WAVE_COMPLETED_SQLITE);

  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ?').all(runId);
  for (const d of domains) {
    db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status, completed_at)
      VALUES (1, ?, 'complete', ?)`).run(d.id, AGENT_COMPLETED_ISO);
  }

  db.prepare(`INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count, created_at)
    VALUES (1, 'node', '["npm test"]', 0, 1, 4303, ?)`).run(WAVE_COMPLETED_SQLITE);

  db.prepare(`INSERT INTO promotions (wave_id, run_id, from_phase, to_phase, authorized_by, gates_checked, created_at)
    VALUES (1, ?, 'feature-execute', 'feature-audit', 'coordinator', '[]', ?)`)
    .run(runId, PROMOTION_SQLITE);

  return runId;
}

/** Every string in `value` that still carries the SQLite datetime shape. */
function collectSqliteShaped(value, path = '$', out = []) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
    out.push(`${path} = ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectSqliteShaped(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectSqliteShaped(v, `${path}.${k}`, out);
  }
  return out;
}

// ═══════════════════════════════════════════
// The shared helper — string surgery, never local-time Date parsing
// ═══════════════════════════════════════════

describe('toRfc3339Utc — SQLite datetime → RFC 3339 UTC at the read boundary', () => {
  it('rewrites the SQLite shape by string surgery (immune to the host timezone)', () => {
    // Pure string replacement — no Date round-trip anywhere in the helper —
    // so unlike the pre-F-5cfa163c `new Date('YYYY-MM-DD HH:MM:SS')` local
    // parse, the output cannot vary with TZ.
    assert.equal(toRfc3339Utc('2026-07-21 02:40:01'), '2026-07-21T02:40:01Z');
    assert.equal(toRfc3339Utc('2026-07-21 02:40:01.500'), '2026-07-21T02:40:01.500Z');
  });

  it('trusts already-timezone-marked values as-is (state-machine ISO rows, test fixtures)', () => {
    assert.equal(toRfc3339Utc('2026-07-21T03:10:00.000Z'), '2026-07-21T03:10:00.000Z');
    assert.equal(toRfc3339Utc('2026-04-11T10:00:00Z'), '2026-04-11T10:00:00Z');
    assert.equal(toRfc3339Utc('2026-07-21T05:40:01+03:00'), '2026-07-21T05:40:01+03:00');
  });

  it('passes NULL columns through as null', () => {
    assert.equal(toRfc3339Utc(null), null);
    assert.equal(toRfc3339Utc(undefined), null);
  });
});

// ═══════════════════════════════════════════
// RED — the gate fires against the defect it guards
// ═══════════════════════════════════════════

describe('red-proof: the OLD SQLite-shaped timing is rejected by the ingest contract', () => {
  it('a pre-fix-shaped export produces the exact live artifact timing and fails format:date-time', () => {
    // Byte-shape the PRE-FIX buildRunExport handed the bridge for the live
    // run: raw SQLite strings, completed NULL, no last_terminal_event_at.
    const preFixExport = {
      run: {
        id: 'swarm-1784601601-bd4a',
        repo: 'mcp-tool-shop-org/ai-rpg-engine',
        branch: 'main',
        commit_sha: SHA,
        created: RUN_CREATED_SQLITE,
        completed: null,
      },
      waves: [{
        number: 1,
        phase: 'feature-execute',
        status: 'advanced',
        agents: [{ domain: 'backend', status: 'complete' }],
        verification: { passed: true, adapter: 'node', test_count: 4303 },
        violations: [],
      }],
      verification: [{ wave: 1, phase: 'feature-execute', passed: true, test_count: 4303 }],
      findings: { summary: { total: 0, by_severity: {} }, items: [] },
      promotions: [],
    };

    const submission = buildDogfoodSubmission(preFixExport, 'pass');

    // The exact broken block observed in the live artifact — including
    // duration_ms 0, which `new Date()` local-parses its way into because
    // both malformed strings parse identically.
    assert.deepEqual(submission.timing, {
      started_at: '2026-07-21 02:40:01',
      finished_at: '2026-07-21 02:40:01',
      duration_ms: 0,
    });

    const result = validatePayload('recordSubmission', submission);
    assert.equal(result.valid, false,
      'the ingest contract must reject SQLite-shaped timing — if this ever passes, the gate is gone');
    for (const path of ['/timing/started_at', '/timing/finished_at']) {
      assert.ok(
        result.errors.some(e => e.path === path && e.keyword === 'format'),
        `expected a format error at ${path}; got: ${JSON.stringify(result.errors)}`);
    }
  });
});

// ═══════════════════════════════════════════
// GREEN — real exporter → schema-clean submission with honest timing
// ═══════════════════════════════════════════

describe('real exporter → dogfood submission passes the ingest contract (swarm-1784601601-bd4a shape)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => db.close());

  it('submission validates clean against the submission schema and precheck', () => {
    const runId = seedOpenRunWithActivity(db);
    const exp = buildRunExport(db, runId);
    const submission = buildDogfoodSubmission(exp, 'pass');

    const result = validatePayload('recordSubmission', submission);
    if (!result.valid) {
      const lines = result.errors.map(e => `${e.path || '/'} ${e.message}`);
      assert.fail(`exporter-built submission failed schema validation:\n  ${lines.join('\n  ')}`);
    }

    const precheck = precheckSubmission(submission);
    assert.deepEqual(precheck.errors, []);
    assert.equal(precheck.valid, true);
  });

  it('timing carried verbatim into the persisted-record shape validates against the record schema', () => {
    // packages/ingest's validateRecord delegates to validatePayload('record')
    // — the outbound gate that threw RecordValidationError on the live run.
    // verify() copies timing verbatim from the submission, so wrap the real
    // submission with minimal verifier-owned fields and hold it to the full
    // record contract. (The end-to-end path — verify() + writeRecord — is
    // exercised by packages/ingest's own suite and the live repro.)
    const runId = seedOpenRunWithActivity(db);
    const submission = buildDogfoodSubmission(buildRunExport(db, runId), 'pass');
    const record = {
      ...submission,
      policy_version: '1.0.0',
      overall_verdict: { proposed: submission.overall_verdict, verified: submission.overall_verdict },
      verification: {
        status: 'accepted',
        verified_at: '2026-07-21T03:32:55Z',
        provenance_confirmed: true,
        schema_valid: true,
        policy_valid: true,
      },
    };

    const result = validatePayload('record', record);
    if (!result.valid) {
      const lines = result.errors.map(e => `${e.path || '/'} ${e.message}`);
      assert.fail(`record built from exporter timing failed the record schema:\n  ${lines.join('\n  ')}`);
    }
  });

  it('derives honest timing: start = runs.created_at, finish = latest TERMINAL event, duration = the difference', () => {
    const runId = seedOpenRunWithActivity(db);
    const exp = buildRunExport(db, runId);
    const submission = buildDogfoodSubmission(exp, 'pass');

    assert.equal(submission.timing.started_at, '2026-07-21T02:40:01Z');
    // Latest terminal event is the PROMOTION (03:32:33, SQLite-shaped row),
    // which must beat both the wave completion (03:18:31) and the ISO-shaped
    // agent completion (03:10) — normalized-then-numeric comparison, since a
    // lexicographic max across raw shapes would mis-pick the ISO 03:10 row.
    assert.equal(exp.run.last_terminal_event_at, '2026-07-21T03:32:33Z');
    assert.equal(submission.timing.finished_at, '2026-07-21T03:32:33Z');
    assert.notEqual(submission.timing.started_at, submission.timing.finished_at,
      'a run with recorded activity must never report zero elapsed time');
    assert.equal(
      submission.timing.duration_ms,
      Date.parse('2026-07-21T03:32:33Z') - Date.parse('2026-07-21T02:40:01Z'));
    assert.equal(submission.timing.duration_ms, 3_152_000);
  });

  it('finished_at stays deterministic for the SAME DB state (fp-p-003 dedup key survives)', () => {
    const runId = seedOpenRunWithActivity(db);
    const exp = buildRunExport(db, runId);
    const sub1 = buildDogfoodSubmission(exp, 'pass');
    const sub2 = buildDogfoodSubmission(buildRunExport(db, runId), 'pass');
    assert.equal(sub1.timing.finished_at, sub2.timing.finished_at,
      'same DB state must export the same finished_at — the ingest dedup probe depends on it');
  });

  it('a completed run keeps runs.completed_at as finished_at (terminal events do not override closure)', () => {
    const runId = seedOpenRunWithActivity(db, 'r-closed');
    db.prepare("UPDATE runs SET status = 'complete', completed_at = '2026-07-21 04:00:00' WHERE id = ?")
      .run(runId);
    const submission = buildDogfoodSubmission(buildRunExport(db, runId), 'pass');
    assert.equal(submission.timing.finished_at, '2026-07-21T04:00:00Z');
    assert.equal(submission.timing.duration_ms,
      Date.parse('2026-07-21T04:00:00Z') - Date.parse('2026-07-21T02:40:01Z'));
  });

  it('an open run with ZERO terminal events falls back to run.created (deterministic, honest zero)', () => {
    // Degenerate shape: run initialized, one wave dispatched, nothing has
    // finished. There is no evidence of any later instant, and the export
    // wall clock would re-break fp-p-003 — so finished_at = created is the
    // honest floor, and duration 0 is TRUE here (nothing terminal happened).
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at, completed_at)
      VALUES ('r-fresh', 'org/r', '/tmp/r', ?, 'main', 'health-audit-a', ?, NULL)`)
      .run(SHA, RUN_CREATED_SQLITE);
    db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, created_at)
      VALUES ('r-fresh', 'health-audit-a', 1, 'dispatched', ?)`).run(WAVE_CREATED_SQLITE);

    const exp = buildRunExport(db, 'r-fresh');
    assert.equal(exp.run.last_terminal_event_at, null,
      'creation/start timestamps are not terminal events');
    const submission = buildDogfoodSubmission(exp, 'partial');
    assert.equal(submission.timing.started_at, '2026-07-21T02:40:01Z');
    assert.equal(submission.timing.finished_at, '2026-07-21T02:40:01Z');
    assert.equal(submission.timing.duration_ms, 0);
  });
});

// ═══════════════════════════════════════════
// Family sweep — no SQLite-shaped string anywhere in ANY persist artifact
// ═══════════════════════════════════════════

describe('family sweep: every schema-constrained artifact is free of SQLite-shaped timestamps', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => db.close());

  it('the whole submission, the whole run export, and the audit payload carry none', () => {
    const runId = seedOpenRunWithActivity(db);
    const exp = buildRunExport(db, runId);
    const submission = buildDogfoodSubmission(exp, 'pass');
    const audit = buildAuditPayload(exp);

    // One sweep per artifact so a regression names the exact leaking field
    // (waves[].created/completed, promotions[].at, audit run.started_at, …)
    // instead of just "somewhere".
    assert.deepEqual(collectSqliteShaped(submission), [], 'dogfood-submission.json leaked SQLite shapes');
    assert.deepEqual(collectSqliteShaped(exp), [], 'run-export.json leaked SQLite shapes');
    assert.deepEqual(collectSqliteShaped(audit), [], 'audit payload leaked SQLite shapes');
  });

  it('read-boundary conversion covers run, waves, and promotions fields', () => {
    const runId = seedOpenRunWithActivity(db);
    const exp = buildRunExport(db, runId);

    assert.equal(exp.run.created, '2026-07-21T02:40:01Z');
    assert.equal(exp.run.completed, null);
    assert.equal(exp.waves[0].created, '2026-07-21T02:47:53Z');
    assert.equal(exp.waves[0].completed, '2026-07-21T03:18:31Z');
    assert.equal(exp.promotions[0].at, '2026-07-21T03:32:33Z');

    // repo-knowledge audit payload inherits the same boundary.
    const audit = buildAuditPayload(exp);
    assert.equal(audit.run.started_at, '2026-07-21T02:40:01Z');
    assert.equal(audit.run.completed_at, null);
  });
});
