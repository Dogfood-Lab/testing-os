/**
 * revalidate-terminal-preservation.test.js — the envelope-repair path must
 * neither resurrect closed findings nor drop feature rows (observed in run
 * swarm-1784601601-bd4a, gaps 1b + 2).
 *
 * Two live defects from that run, both in revalidate's F-8efffdd1
 * collect-parity ingestion:
 *
 *   RESURRECTION (gap 1b): the point-repair upsert applied classified.recurring
 *   verbatim. classifyFindings deliberately routes a fingerprint match against
 *   a 'fixed' prior into `recurring` — the regression-reopen path, correct for
 *   a LIVE re-audit (collect: an agent just looked and the defect is back).
 *   A corrected envelope is NOT live evidence: it repairs output authored
 *   before the repair — and before any closure that landed in between — so
 *   re-upserting it silently overwrote 'fixed' back to 'recurring' on stale
 *   observations. Terminal statuses (fixed/deferred/rejected) must survive the
 *   repair; the skip is logged, never silent.
 *
 *   FEATURE DROP (gap 2): the staging loop had no SCHEMA-A-001 severity
 *   normalization (features carry `priority`), so every feature ingested
 *   through the repair path reached INSERT OR IGNORE with severity NULL,
 *   violated findings.severity NOT NULL, and was SILENTLY skipped (changes=0)
 *   — proven at pass scale in the live run: wave-4's 24 and wave-10's 27
 *   corrected features all vanished; only the 12 that entered through
 *   collect() (which has the normalization) ever became rows. The sibling
 *   `findings || features` truthy-[] short-circuit dropped features whenever
 *   a corrected envelope carried both keys. With zero rows, swarm
 *   approve/defer had nothing to dispose — the coordinator hand-edited the DB.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { computeFingerprint } from './lib/fingerprint.js';
import { revalidate } from './commands/revalidate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function setupRun(dbPath, tempDir, runId, phase) {
  const db = openDb(dbPath);
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', tempDir, 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['packages/**'], ownership_class: 'owned' },
    { name: 'docs',    globs: ['*.md'],        ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);
  db.prepare(`
    INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES (1, ?, ?, 1, 'failed', 'snap-test')
  `).run(runId, phase);
  for (const d of db.prepare('SELECT * FROM domains WHERE run_id = ?').all(runId)) {
    db.prepare(`
      INSERT INTO agent_runs (wave_id, domain_id, status, error_message)
      VALUES (1, ?, 'invalid_output', 'envelope rejected')
    `).run(d.id);
  }
  return db;
}

describe('revalidate — terminal statuses survive a corrected-envelope re-upsert', () => {
  let tempDir, dbPath, outputDir;
  const RUN_ID = 'test-reval-terminal';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'reval-terminal-'));
    dbPath = join(tempDir, 'control-plane.db');
    outputDir = join(tempDir, 'outputs');
    mkdirSync(outputDir, { recursive: true });

    const db = setupRun(dbPath, tempDir, RUN_ID, 'health-audit-a');

    // Closed rows whose fingerprints a corrected envelope will re-report.
    // File-less on purpose: the file-less fingerprint folds category +
    // normalized description, so the fixture reproduces the exact fingerprint
    // the ingestion will compute — a deterministic match with no source file.
    const fixedFp = computeFingerprint({ category: 'quality', description: 'stale evidence resurrection target' });
    const defFp = computeFingerprint({ category: 'quality', description: 'deferred decision target' });
    const insert = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, description, status)
      VALUES (?, ?, ?, ?, 'quality', ?, ?)`);
    insert.run(RUN_ID, 'F-DONE', fixedFp, 'MEDIUM', 'stale evidence resurrection target', 'fixed');
    insert.run(RUN_ID, 'F-DEF', defFp, 'LOW', 'deferred decision target', 'deferred');
    db.close();
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a corrected envelope re-reporting a fixed finding does NOT resurrect it (skip is reported)', () => {
    const outputPath = join(outputDir, 'backend.json');
    writeFileSync(outputPath, JSON.stringify({
      domain: 'backend',
      stage: 'A',
      summary: 'corrected envelope, authored before the closures landed',
      findings: [
        { id: 'x1', severity: 'HIGH', category: 'quality', description: 'stale evidence resurrection target' },
        { id: 'x2', severity: 'LOW',  category: 'quality', description: 'deferred decision target' },
      ],
    }), 'utf-8');
    // docs stays blocked deliberately: this is a POINT repair, not a wave
    // recovery, so only the ingestion path is under test.

    const result = revalidate({
      runId: RUN_ID, dbPath, outputs: { backend: outputPath },
      reason: 'corrected envelope', apply: true,
    });

    const db = openDb(dbPath);
    const done = db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-DONE');
    assert.equal(done.status, 'fixed',
      'a corrected envelope must never resurrect a closed finding — the repaired output is stale evidence, not a live re-audit');
    const def = db.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, 'F-DEF');
    assert.equal(def.status, 'deferred', 'deferred stays deferred through the repair');

    // No 'recurred' event may record the phantom rediscovery as if it were live.
    const recurred = db.prepare(`
      SELECT COUNT(*) AS n FROM finding_events fe JOIN findings f ON f.id = fe.finding_id
      WHERE f.run_id = ? AND f.finding_id = 'F-DONE' AND fe.event_type = 'recurred'
    `).get(RUN_ID);
    assert.equal(recurred.n, 0, 'no recurred event from the repair path');
    db.close();

    assert.equal(result.findings?.resurrections_skipped, 1,
      'the skipped resurrection is a reported fact, not a silent drop');
  });
});

describe('revalidate — corrected feature envelopes become disposable findings rows', () => {
  let tempDir, dbPath, outputDir;
  const RUN_ID = 'test-reval-features';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'reval-features-'));
    dbPath = join(tempDir, 'control-plane.db');
    outputDir = join(tempDir, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const db = setupRun(dbPath, tempDir, RUN_ID, 'feature-audit');
    db.close();
  });

  afterEach(() => {
    closeDb(dbPath);
    // The approve test spawns the CLI as a real subprocess; its OS-level lock
    // on the -wal/-shm sidecars can outlive the child on Windows.
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('ingests features[] with priority normalized to severity, and both-keys envelopes keep their features', () => {
    // backend: features-only envelope — the severity-normalization case.
    const backendOut = join(outputDir, 'backend.json');
    writeFileSync(backendOut, JSON.stringify({
      domain: 'backend',
      summary: 'feature audit, corrected envelope',
      features: [
        { id: 'F-FEAT-1', priority: 'HIGH', category: 'missing-feature', description: 'players cannot save mid-run' },
      ],
    }), 'utf-8');

    // docs: canonicalized envelope carrying BOTH findings: [] and features —
    // the exact ci-tooling wave-4 shape whose truthy-[] short-circuit
    // (`findings || features`) dropped every feature.
    const docsOut = join(outputDir, 'docs.json');
    writeFileSync(docsOut, JSON.stringify({
      domain: 'docs',
      summary: 'feature audit, corrected envelope with both keys',
      findings: [],
      features: [
        { id: 'F-FEAT-2', priority: 'LOW', category: 'ux', description: 'help text lacks worked examples' },
      ],
    }), 'utf-8');

    revalidate({
      runId: RUN_ID, dbPath, outputs: { backend: backendOut, docs: docsOut },
      reason: 'feature envelopes corrected', apply: true,
    });

    const db = openDb(dbPath);
    const rows = db.prepare(
      "SELECT finding_id, severity, category, status, last_seen_wave, filed_by_domain FROM findings WHERE run_id = ? ORDER BY finding_id"
    ).all(RUN_ID);
    assert.equal(rows.length, 2,
      'both features become findings rows — 0 rows was the live-run outcome (severity NULL silently skipped by INSERT OR IGNORE)');

    const bySeverity = Object.fromEntries(rows.map(r => [r.severity, r]));
    assert.ok(bySeverity.HIGH, 'priority HIGH normalized into severity');
    assert.ok(bySeverity.LOW, 'the both-keys envelope\'s feature survived the selection');
    for (const r of rows) {
      assert.equal(r.status, 'new', `${r.finding_id}: ingested as an open, disposable row`);
      assert.equal(r.last_seen_wave, 1, `${r.finding_id}: stamped with the feature wave`);
      assert.ok(['missing-feature', 'ux'].includes(r.category), `${r.finding_id}: feature category is the kind marker`);
      assert.ok(r.filed_by_domain, `${r.finding_id}: filing domain stamped for file-less routing`);
    }
    db.close();
  });

  it('swarm approve --ids then disposes an ingested feature (no more hand-edited DB)', () => {
    const backendOut = join(outputDir, 'backend.json');
    writeFileSync(backendOut, JSON.stringify({
      domain: 'backend',
      summary: 'feature audit, corrected envelope',
      features: [
        { id: 'F-FEAT-1', priority: 'HIGH', category: 'missing-feature', description: 'players cannot save mid-run' },
      ],
    }), 'utf-8');

    revalidate({
      runId: RUN_ID, dbPath, outputs: { backend: backendOut },
      reason: 'feature envelope corrected', apply: true,
    });

    const db = openDb(dbPath);
    const row = db.prepare('SELECT finding_id FROM findings WHERE run_id = ?').get(RUN_ID);
    db.close();
    assert.ok(row, 'the feature row exists to be disposed');

    // Dispose through the real verb, as a subprocess — the disposal surface
    // the live-run coordinator could not use because the rows did not exist.
    const res = spawnSync(process.execPath, [CLI_PATH, 'approve', RUN_ID, '--ids', row.finding_id], {
      encoding: 'utf-8',
      env: { ...process.env, SWARM_DB: dbPath },
    });
    assert.equal(res.status, 0, `approve must exit 0, got ${res.status}: ${res.stderr}`);

    closeDb(dbPath); // reopen after the subprocess wrote
    const db2 = openDb(dbPath);
    const after = db2.prepare('SELECT status FROM findings WHERE run_id = ? AND finding_id = ?').get(RUN_ID, row.finding_id);
    assert.equal(after.status, 'approved', 'swarm approve disposes the ingested feature');
    db2.close();
  });
});
