/**
 * adjudicate-explicit-wave.test.js — `swarm adjudicate --wave <n>`.
 *
 * THE DEFECT (run swarm-1788481819-3690, 2026-09-04). runAdjudicate and
 * previewAdjudicate bound every verdict to the run's LATEST wave
 * (`ORDER BY wave_number DESC LIMIT 1`). The coordinator dispatched the amend
 * wave (6) before the audit wave's (5) jury ran, so the audit verdict would
 * have been persisted on wave 6 — where checkAdjudication (lib/advance.js)
 * reads the latest adjudication row for the wave — and an audit-quality
 * verdict could have cleared the amend wave's advance gate. The dry-run
 * header ("wave 6") exposed it; the workaround was a one-off script that
 * mirrored runAdjudicate with the wave selected by number.
 *
 * What would this look like if the code were wrong in the specific way this
 * check exists to catch? Two waves seeded, the OLDER one named explicitly:
 * a latest-wave implementation persists the row on the newer wave's id and
 * names the newer wave in the receipt filename. Both assertions below go red
 * on that implementation (measured red-first against the pre-fix module by
 * passing waveNumber through an implementation that ignored it).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { getLatestAdjudication } from './lib/adjudication-store.js';
import {
  runAdjudicate,
  previewAdjudicate,
  resolveAdjudicationWave,
  formatAdjudicationPreview,
} from './commands/adjudicate.js';
import { CLI_WAVE_NOT_FOUND, CLI_NO_WAVES } from './commands/lib/run-lookup-error.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'case-files');
const loadFixture = rel => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf-8'));

/** Seed a run with two waves: 1 (audit, collected) and 2 (amend, dispatched). */
function setupTwoWaves(db, runId = 'r1') {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);
  const w1 = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
  ).run(runId);
  const w2 = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 2, 'dispatched')"
  ).run(runId);
  return { runId, wave1Id: Number(w1.lastInsertRowid), wave2Id: Number(w2.lastInsertRowid) };
}

const mockJury = (verdict = 'pass') => (spec) =>
  spec.seats.map(s => ({
    seat: s.family,
    criteria: Object.fromEntries(spec.payload.rubric.acceptance_criteria.map(c => [c.id, verdict])),
    out_of_brief: [],
  }));

const SEATS = [{ family: 'mistral', model: 'mistral-small:24b' }, { family: 'qwen', model: 'qwen2.5:7b' }];
const CASE_FILE = () => loadFixture('valid/well-formed-auth-fix.json');

describe('resolveAdjudicationWave', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('defaults to the latest wave (the original behaviour)', () => {
    const { runId, wave2Id } = setupTwoWaves(db);
    const wave = resolveAdjudicationWave(db, runId, undefined);
    assert.equal(wave.id, wave2Id);
    assert.equal(wave.wave_number, 2);
  });

  it('selects an explicit wave by number', () => {
    const { runId, wave1Id } = setupTwoWaves(db);
    const wave = resolveAdjudicationWave(db, runId, 1);
    assert.equal(wave.id, wave1Id);
    assert.equal(wave.wave_number, 1);
  });

  it('refuses a wave the run does not have with a typed CLI_WAVE_NOT_FOUND', () => {
    const { runId } = setupTwoWaves(db);
    assert.throws(
      () => resolveAdjudicationWave(db, runId, 7),
      (e) => e.code === CLI_WAVE_NOT_FOUND && e.waveNumber === 7 && e.runId === runId && /Wave 7 not found/.test(e.message) && typeof e.hint === 'string',
    );
  });

  it('a run with no waves still refuses with CLI_NO_WAVES on the default path', () => {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('empty', 'org/r', '/tmp/r', 'a'.repeat(40));
    assert.throws(() => resolveAdjudicationWave(db, 'empty', undefined), (e) => e.code === CLI_NO_WAVES);
    assert.throws(() => resolveAdjudicationWave(db, 'empty', 1), (e) => e.code === CLI_WAVE_NOT_FOUND);
  });
});

describe('runAdjudicate --wave', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('binds the adjudications row AND the receipt filename to the explicit (older) wave, not the latest', async () => {
    const { runId, wave1Id, wave2Id } = setupTwoWaves(db);
    const receipts = [];
    const out = await runAdjudicate(db, {
      runId,
      waveNumber: 1,
      caseFile: CASE_FILE(),
      runJury: mockJury('pass'),
      seats: SEATS,
      swarmDir: '/virtual/swarms/r1',
      writeReceipt: (path, content) => receipts.push({ path, content }),
    });

    assert.equal(out.wave.id, wave1Id);
    assert.equal(out.wave.wave_number, 1);

    // The gate-readable row sits on wave 1 — and wave 2 (the latest) has NONE,
    // so checkAdjudication on the amend wave cannot read this verdict.
    const onWave1 = getLatestAdjudication(db, wave1Id);
    assert.ok(onWave1, 'row persisted on the explicit wave');
    assert.equal(onWave1.id, out.adjudicationId);
    assert.equal(getLatestAdjudication(db, wave2Id), undefined, 'the latest wave must not receive the verdict');

    // The receipt names the explicit wave.
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].path, /adjudications[\\/]wave-1-[0-9a-f]{8}\.json$/);
    assert.match(receipts[0].content, /"wave": 1,/);
  });

  it('without --wave the default path is unchanged: latest wave', async () => {
    const { runId, wave1Id, wave2Id } = setupTwoWaves(db);
    const receipts = [];
    const out = await runAdjudicate(db, {
      runId,
      caseFile: CASE_FILE(),
      runJury: mockJury('pass'),
      seats: SEATS,
      swarmDir: '/virtual/swarms/r1',
      writeReceipt: (path, content) => receipts.push({ path, content }),
    });
    assert.equal(out.wave.id, wave2Id);
    assert.ok(getLatestAdjudication(db, wave2Id));
    assert.equal(getLatestAdjudication(db, wave1Id), undefined);
    assert.match(receipts[0].path, /wave-2-[0-9a-f]{8}\.json$/);
  });

  it('a missing wave refuses before the jury runs and persists nothing', async () => {
    const { runId, wave1Id, wave2Id } = setupTwoWaves(db);
    let juryCalled = false;
    const receipts = [];
    await assert.rejects(
      () => runAdjudicate(db, {
        runId,
        waveNumber: 9,
        caseFile: CASE_FILE(),
        runJury: () => { juryCalled = true; return []; },
        seats: SEATS,
        swarmDir: '/virtual/swarms/r1',
        writeReceipt: (path, content) => receipts.push({ path, content }),
      }),
      (e) => e.code === CLI_WAVE_NOT_FOUND,
    );
    assert.equal(juryCalled, false, 'the jury must not be dispatched for a wave that does not exist');
    assert.equal(receipts.length, 0, 'no receipt written');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adjudications').get().n, 0, 'no row persisted');
    assert.equal(getLatestAdjudication(db, wave1Id), undefined);
    assert.equal(getLatestAdjudication(db, wave2Id), undefined);
  });
});

describe('previewAdjudicate --wave (dry-run)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });

  it('resolves the explicit wave and the header says so', () => {
    const { runId, wave1Id } = setupTwoWaves(db);
    const preview = previewAdjudicate(db, { runId, waveNumber: 1, caseFile: CASE_FILE(), seats: SEATS, tier: 'local' });
    assert.equal(preview.waveId, wave1Id);
    assert.equal(preview.waveNumber, 1);
    assert.equal(preview.waveSelection, 'explicit');
    const text = formatAdjudicationPreview(preview);
    assert.match(text, /wave 1 \(--wave, explicit\)/);
  });

  it('defaults to the latest wave and the header says so', () => {
    const { runId, wave2Id } = setupTwoWaves(db);
    const preview = previewAdjudicate(db, { runId, caseFile: CASE_FILE(), seats: SEATS, tier: 'local' });
    assert.equal(preview.waveId, wave2Id);
    assert.equal(preview.waveSelection, 'latest');
    assert.match(formatAdjudicationPreview(preview), /wave 2 \(latest\)/);
  });

  it('refuses a missing wave in dry-run too, with the same typed error', () => {
    const { runId } = setupTwoWaves(db);
    assert.throws(
      () => previewAdjudicate(db, { runId, waveNumber: 3, caseFile: CASE_FILE(), seats: SEATS, tier: 'local' }),
      (e) => e.code === CLI_WAVE_NOT_FOUND,
    );
  });
});
