/**
 * case-file-adjudicate-cmd.test.js — the `swarm adjudicate` handler core.
 *
 * runAdjudicate is the testable seam behind the CLI wrapper: load a case-file,
 * dispatch to the jury (INJECTED — mock here, live local-Ollama in production),
 * write the receipt artifact, and persist the gate-readable adjudication row.
 * The live path is the manual on-rig smoke; this pins the wiring without Ollama
 * or disk (both the jury and the receipt writer are injected).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { getLatestAdjudication } from './lib/adjudication-store.js';
import { CaseFileNeutralityError } from './lib/case-file/handoff.js';
import { runAdjudicate, formatAdjudication } from './commands/adjudicate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'case-files');
const loadFixture = rel => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf-8'));

function setupRun(db, runId = 'r1') {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);
  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
  ).run(runId);
  return { runId, waveId: Number(wave.lastInsertRowid) };
}

// A mock jury: every seat passes every criterion (or fails, per `verdict`).
const mockJury = (verdict = 'pass') => (spec) =>
  spec.seats.map(s => ({
    seat: s.family,
    criteria: Object.fromEntries(spec.payload.rubric.acceptance_criteria.map(c => [c.id, verdict])),
    out_of_brief: [],
  }));

const SEATS = [{ family: 'mistral', model: 'mistral-small:24b' }, { family: 'qwen', model: 'qwen2.5:7b' }];

describe('runAdjudicate — the swarm adjudicate core', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('adjudicates a clean case-file, writes a receipt, and persists a gate-readable row', async () => {
    const { runId, waveId } = setupRun(db);
    const receipts = [];
    const out = await runAdjudicate(db, {
      runId,
      caseFile: loadFixture('valid/well-formed-auth-fix.json'),
      runJury: mockJury('pass'),
      seats: SEATS,
      swarmDir: '/virtual/swarms/r1',
      writeReceipt: (path, content) => receipts.push({ path, content }),
    });

    assert.equal(out.result.overall, 'corroborate');
    assert.equal(out.result.authority, 'advisory');
    assert.ok(out.adjudicationId > 0);

    // the row the checkAdjudication gate reads
    const row = getLatestAdjudication(db, waveId);
    assert.equal(row.overall, 'corroborate');
    assert.equal(row.case_file_ref, 'packages/auth/refresh.js@a1b2c3d');
    assert.match(row.receipt_hash, /^[0-9a-f]{64}$/);

    // the receipt artifact was written (injected writer captured it)
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].path, /adjudications[\\/]wave-1-[0-9a-f]{8}\.json$/);
    assert.match(receipts[0].content, /"overall": "corroborate"/);
  });

  it('records a non-corroborate verdict (the gate will then require disposition)', async () => {
    const { runId, waveId } = setupRun(db);
    const out = await runAdjudicate(db, {
      runId,
      caseFile: loadFixture('valid/well-formed-auth-fix.json'),
      runJury: mockJury('fail'),
      seats: SEATS,
      writeReceipt: () => {},
    });
    assert.equal(out.result.overall, 'refute');
    assert.equal(getLatestAdjudication(db, waveId).overall, 'refute');
  });

  it('REFUSES a biasing case-file before the jury runs — nothing is persisted', async () => {
    const { runId, waveId } = setupRun(db);
    let juryCalled = false;
    await assert.rejects(
      () => runAdjudicate(db, {
        runId,
        caseFile: loadFixture('lint/verdict-leak-in-criterion.json'),
        runJury: () => { juryCalled = true; return []; },
        seats: SEATS,
        writeReceipt: () => {},
      }),
      CaseFileNeutralityError,
    );
    assert.equal(juryCalled, false, 'the jury must never see a biasing case-file');
    assert.equal(getLatestAdjudication(db, waveId), undefined, 'nothing persisted on refusal');
  });

  it('throws a clear error when the run has no wave', async () => {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('empty', 'org/r', '/tmp/r', 'a'.repeat(40));
    await assert.rejects(
      () => runAdjudicate(db, {
        runId: 'empty',
        caseFile: loadFixture('valid/well-formed-auth-fix.json'),
        runJury: mockJury('pass'),
        seats: SEATS,
        writeReceipt: () => {},
      }),
      /No waves found/,
    );
  });
});

describe('formatAdjudication', () => {
  it('renders the verdict, panel, criteria, and a next-step hint', () => {
    const out = {
      adjudicationId: 7,
      receiptPath: 'swarms/r1/adjudications/wave-1-abcd1234.json',
      result: {
        overall: 'corroborate',
        authority: 'advisory',
        seats: ['mistral', 'qwen'],
        criteria: [{ id: 'AC-1', verdict: 'pass', counts: { pass: 2, fail: 0, insufficient_context: 0 } }],
        out_of_brief: [],
      },
    };
    const text = formatAdjudication(out);
    assert.match(text, /Adjudication: CORROBORATE/);
    assert.match(text, /advisory — the deterministic floor is law/);
    assert.match(text, /AC-1/);
    assert.match(text, /Recorded adjudication #7/);
    assert.match(text, /swarm advance/);
  });

  it('points a non-corroborate verdict at the override disposition path', () => {
    const text = formatAdjudication({
      adjudicationId: 8, receiptPath: null,
      result: { overall: 'contested', authority: 'advisory', seats: ['mistral'], criteria: [], out_of_brief: [] },
    });
    assert.match(text, /--override --reason/);
  });
});
