/**
 * roadmap-compile.test.js — F-874c0683 (T1, docs/trajectory-and-closure
 * .dispatch.md): compileRoadmap composes findings/recurrence/attention/
 * drain/notes into one artifact object. Mirrors w3-cross-run-analytics.test
 * .js's seeding pattern (root-level file; this domain's own established
 * precedent for cross-run-analytics.js's siblings) rather than inventing a
 * new one, per F-874c0683's own test-strategy recommendation.
 *
 * DETERMINISM SCOPE NOTE (disclosed, not overclaimed): this file proves
 * same-PROCESS stability (the artifact is a pure function of its inputs,
 * with a fixed key order). F-feeaef78 (swarm-cp-tests' own approved finding)
 * is the STRONGER cross-PROCESS proof this repo's own research grounding
 * says is required ("a same-process double-call proves nothing... the test
 * has to force two SEPARATE processes") — that proof belongs to the lane
 * that owns it, not duplicated weaker here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openMemoryDb } from '../db/connection.js';
import { compileRoadmap } from './roadmap/compile.js';

function seedBasicRun(db, runId = 'run-compile') {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`)
    .run(runId, 'a'.repeat(40));
  const w1 = Number(db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', 1, 'collected')`).run(runId).lastInsertRowid);
  return { runId, w1 };
}

function seedFinding(db, runId, { id, fp, status, file = 'lib/x.js', wave }) {
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
     VALUES (?, ?, ?, 'HIGH', 'bug', ?, 'd', ?, ?, ?)`
  ).run(runId, id, fp, file, status, wave, wave);
}

/** @pins F-874c0683 */
describe('compileRoadmap — T1 composed artifact (F-874c0683)', () => {
  it('throws loudly for a nonexistent run_id rather than returning an empty-but-plausible artifact', () => {
    const db = openMemoryDb();
    assert.throws(() => compileRoadmap(db, 'no-such-run'), /no run found/);
  });

  it('buckets findings into open/deferred/approved correctly, sorted by finding_id', () => {
    const db = openMemoryDb();
    const { runId, w1 } = seedBasicRun(db);
    seedFinding(db, runId, { id: 'F-b-new', fp: 'fp-1', status: 'new', wave: w1 });
    seedFinding(db, runId, { id: 'F-a-recurring', fp: 'fp-2', status: 'recurring', wave: w1 });
    seedFinding(db, runId, { id: 'F-c-unverified', fp: 'fp-3', status: 'unverified', wave: w1 });
    seedFinding(db, runId, { id: 'F-deferred', fp: 'fp-4', status: 'deferred', wave: w1 });
    seedFinding(db, runId, { id: 'F-approved', fp: 'fp-5', status: 'approved', wave: w1 });
    seedFinding(db, runId, { id: 'F-fixed', fp: 'fp-6', status: 'fixed', wave: w1 });
    seedFinding(db, runId, { id: 'F-rejected', fp: 'fp-7', status: 'rejected', wave: w1 });

    const artifact = compileRoadmap(db, runId, { now: new Date('2026-07-17T00:00:00Z') });

    assert.deepEqual(
      artifact.findings.open.map((f) => f.finding_id),
      ['F-a-recurring', 'F-b-new', 'F-c-unverified'],
      'open bucket = new+recurring+unverified, sorted by finding_id ASC',
    );
    assert.deepEqual(artifact.findings.deferred.map((f) => f.finding_id), ['F-deferred']);
    assert.deepEqual(artifact.findings.approved.map((f) => f.finding_id), ['F-approved']);
    // fixed/rejected must appear in NEITHER bucket.
    const allBucketed = [...artifact.findings.open, ...artifact.findings.deferred, ...artifact.findings.approved].map((f) => f.finding_id);
    assert.ok(!allBucketed.includes('F-fixed'));
    assert.ok(!allBucketed.includes('F-rejected'));
  });

  it('every section of the artifact is present with the documented shape', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    const artifact = compileRoadmap(db, runId, { now: new Date('2026-07-17T00:00:00Z') });

    assert.equal(artifact.run_id, runId);
    assert.equal(artifact.repo, 'org/repo');
    assert.equal(artifact.generated_at, '2026-07-17T00:00:00.000Z');
    assert.ok(Array.isArray(artifact.findings.open));
    assert.ok(Array.isArray(artifact.findings.deferred));
    assert.ok(Array.isArray(artifact.findings.approved));
    assert.ok(Array.isArray(artifact.recurrence.recurring_findings));
    assert.equal(typeof artifact.recurrence.recurrence_rate, 'object');
    assert.equal(artifact.attention.advisory, true);
    assert.ok('grandfathered_manifest' in artifact.drain_queue);
    assert.ok('deferred_findings' in artifact.drain_queue);
    assert.ok(Array.isArray(artifact.operator_notes.active));
    assert.ok(Array.isArray(artifact.operator_notes.expired));
    assert.ok(Array.isArray(artifact.operator_notes.dropped_invalid));
  });

  it('threads operatorNotes through to validateOperatorNotes — accepted/expired/dropped land in the right buckets', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'roadmap-compile-notes-'));
    try {
      const db = openMemoryDb();
      const { runId } = seedBasicRun(db);
      const now = new Date('2026-07-17T00:00:00Z');

      const artifact = compileRoadmap(db, runId, {
        repoRoot,
        now,
        operatorNotes: [
          { kind: 'theme', text: 'still relevant', expires: '2027-01-01' },
          { kind: 'theme', text: 'stale', expires: '2026-01-01' },
          { kind: 'invariant', text: 'no enforced_by' },
        ],
      });

      assert.deepEqual(artifact.operator_notes.active.map((n) => n.text), ['still relevant']);
      assert.deepEqual(artifact.operator_notes.expired.map((n) => n.text), ['stale']);
      assert.equal(artifact.operator_notes.dropped_invalid.length, 1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('propagates the 7-note cap violation as a thrown error (not silently truncated)', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    const notes = Array.from({ length: 8 }, (_, i) => ({ kind: 'theme', text: `note ${i}` }));
    assert.throws(() => compileRoadmap(db, runId, { operatorNotes: notes }), /exceeds the max of 7/);
  });

  it('recurrence stats reflect a fingerprint shared across two runs (queryRecurringFindings, no new SQL)', () => {
    const db = openMemoryDb();
    const { runId: runA, w1 } = seedBasicRun(db, 'run-recur-a');
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES ('run-recur-b', 'org/repo', '/tmp/r', ?, 'feature-audit')`).run('b'.repeat(40));
    const wB = Number(db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-recur-b', 'feature-audit', 1, 'collected')`).run().lastInsertRowid);

    seedFinding(db, runA, { id: 'F-shared', fp: 'fp-shared', status: 'new', wave: w1 });
    seedFinding(db, 'run-recur-b', { id: 'F-shared', fp: 'fp-shared', status: 'new', wave: wB });

    const artifact = compileRoadmap(db, runA, {});
    const shared = artifact.recurrence.recurring_findings.find((r) => r.fingerprint === 'fp-shared');
    assert.ok(shared, 'a fingerprint present in 2 runs must appear in recurring_findings');
    assert.equal(shared.run_count, 2);
  });

  it('is a pure function of its inputs — repeated same-process calls with fixed `now` produce byte-identical JSON (same-process stability; the stronger cross-process proof is F-feeaef78)', () => {
    const db = openMemoryDb();
    const { runId, w1 } = seedBasicRun(db);
    seedFinding(db, runId, { id: 'F-1', fp: 'fp-1', status: 'new', wave: w1 });
    const now = new Date('2026-07-17T00:00:00Z');

    const first = JSON.stringify(compileRoadmap(db, runId, { now }));
    const second = JSON.stringify(compileRoadmap(db, runId, { now }));
    assert.equal(first, second);
  });
});
