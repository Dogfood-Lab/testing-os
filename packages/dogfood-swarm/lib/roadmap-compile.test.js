/**
 * roadmap-compile.test.js — F-874c0683 (T1, docs/trajectory-and-closure
 * .dispatch.md): compileRoadmap composes open_summary/compiled_from/
 * recurrence_stats/attention/grandfathered_drain/drain_queue into one
 * schema-conformant artifact object. Mirrors w3-cross-run-analytics.test
 * .js's seeding pattern (root-level file; this domain's own established
 * precedent for cross-run-analytics.js's siblings) rather than inventing a
 * new one, per F-874c0683's own test-strategy recommendation.
 *
 * WAVE-43 REWRITE (Amendment 3, docs/trajectory-and-closure.dispatch.md;
 * coordinator relay, precision pass): this file previously asserted
 * `artifact.findings.{open,deferred,approved}` (raw arrays),
 * `artifact.recurrence.recurring_findings`, and
 * `artifact.operator_notes.{active,expired,dropped_invalid}` — ALL
 * superseded. compileRoadmap no longer VALIDATES operator notes (A3.4:
 * commands/lib/roadmap-notes.js#readOperatorNotes is the ONE surviving,
 * live, fail-closed validator — out of this domain's globs) but DOES still
 * accept an already-validated `operatorNotes` array and split it into
 * `operator_notes`/`expired_notes` (T3's compile-time obligation). The
 * old full-validation tests (bad kind, missing enforced_by, >7-note throw)
 * are REMOVED — that capability moved to commands/lib/roadmap-notes.js and
 * is that domain's to test; the tests below cover the THIN split this
 * function still performs on pre-validated input.
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

  it('A3.1: open_summary counts findings into open/deferred/approved correctly (fixed/rejected excluded)', () => {
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

    assert.deepEqual(artifact.open_summary, { open: 3, deferred: 1, approved: 1 },
      'open = new+recurring+unverified (3); deferred/approved are their own single-status counts; ' +
      'fixed/rejected are excluded from every bucket (2 seeded, 0 counted anywhere)');
  });

  it('every schema-required section is present with the A3.1/A3.2 shape', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    const artifact = compileRoadmap(db, runId, { now: new Date('2026-07-17T00:00:00Z') });

    assert.equal(artifact.run_id, runId);
    assert.equal(artifact.repo, 'org/repo');
    assert.equal(artifact.run_anchored_at, '2026-07-17T00:00:00.000Z');
    assert.deepEqual(artifact.compiled_from, { commit_sha: 'a'.repeat(40) });
    assert.deepEqual(artifact.open_summary, { open: 0, deferred: 0, approved: 0 });
    assert.ok(Array.isArray(artifact.recurrence_stats.top_recurring));
    assert.equal(typeof artifact.recurrence_stats.recurrence_rate, 'object');
    assert.equal(artifact.attention.advisory, true);
    assert.ok(Array.isArray(artifact.attention.items));
    assert.deepEqual(Object.keys(artifact.attention).sort(), ['advisory', 'items'],
      'the persisted attention section must be schema-exact — no churn_available/truncated/total_candidates leakage');
    assert.equal(typeof artifact.grandfathered_drain.frozen_total, 'number');
    assert.equal(typeof artifact.grandfathered_drain.drained, 'number');
    assert.ok(Array.isArray(artifact.grandfathered_drain.outstanding));
    assert.ok(Array.isArray(artifact.drain_queue.entries));
    assert.ok(Array.isArray(artifact.drain_queue.overdue_ids));
    // A3.4: operator_notes is the active list DIRECTLY (schema shape: an
    // array of note objects, not a wrapper); expired_notes is its required,
    // empty-allowed sibling — both present even with zero notes supplied.
    assert.deepEqual(artifact.operator_notes, []);
    assert.deepEqual(artifact.expired_notes, []);
    // Pre-Amendment-3 vocabulary must not linger alongside the new names.
    assert.equal(Object.hasOwn(artifact, 'findings'), false);
    assert.equal(Object.hasOwn(artifact, 'recurrence'), false);
  });

  it('A3.4: operator_notes/expired_notes split ALREADY-VALIDATED notes by expiry, loudly — no re-validation of kind/enforced_by', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    const now = new Date('2026-07-17T00:00:00Z');

    const artifact = compileRoadmap(db, runId, {
      now,
      operatorNotes: [
        { kind: 'theme', text: 'still relevant', expires: '2027-01-01' },
        { kind: 'theme', text: 'stale', expires: '2026-01-01' },
        { kind: 'theme', text: 'expires exactly today', expires: '2026-07-17' },
        { kind: 'theme', text: 'evergreen, no expires at all' },
      ],
    });

    assert.deepEqual(artifact.operator_notes.map((n) => n.text), ['still relevant', 'evergreen, no expires at all']);
    assert.deepEqual(artifact.expired_notes.map((n) => n.text), ['stale', 'expires exactly today'],
      'an expires date of exactly today is already expired — inclusive boundary, matching commands/lib/roadmap-notes.js#splitExpiredNotes verbatim');
  });

  it('A3.4: does NOT re-validate kind/enforced_by — an already-malformed note (never reachable through the real CLI path) passes through as active rather than throwing', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    // This shape would have been REFUSED by commands/lib/roadmap-notes.js's
    // readOperatorNotes before ever reaching here (unrecognized kind, no
    // enforced_by check performed at all) — proving compile.js genuinely
    // does not re-implement that validation, matching A3.4's "one module"
    // ruling: full validation lives in exactly one place.
    const artifact = compileRoadmap(db, runId, {
      operatorNotes: [{ kind: 'not-a-real-kind', text: 'never validated here' }],
    });
    assert.deepEqual(artifact.operator_notes.map((n) => n.text), ['never validated here']);
  });

  it('A3.1: compiled_from.commit_sha is runs.commit_sha verbatim, sourced from the SAME row already fetched for run_id/repo (one SELECT)', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    const artifact = compileRoadmap(db, runId, {});
    assert.equal(artifact.compiled_from.commit_sha, 'a'.repeat(40));
    assert.match(artifact.compiled_from.commit_sha, /^[0-9a-f]{40}$/, 'must match the schema pattern for a full commit sha');
  });

  it('recurrence_stats.top_recurring reflects a fingerprint shared across two runs (queryRecurringFindings, no new SQL) — renamed from recurrence.recurring_findings', () => {
    const db = openMemoryDb();
    const { runId: runA, w1 } = seedBasicRun(db, 'run-recur-a');
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES ('run-recur-b', 'org/repo', '/tmp/r', ?, 'feature-audit')`).run('b'.repeat(40));
    const wB = Number(db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-recur-b', 'feature-audit', 1, 'collected')`).run().lastInsertRowid);

    seedFinding(db, runA, { id: 'F-shared', fp: 'fp-shared', status: 'new', wave: w1 });
    seedFinding(db, 'run-recur-b', { id: 'F-shared', fp: 'fp-shared', status: 'new', wave: wB });

    const artifact = compileRoadmap(db, runA, {});
    const shared = artifact.recurrence_stats.top_recurring.find((r) => r.fingerprint === 'fp-shared');
    assert.ok(shared, 'a fingerprint present in 2 runs must appear in recurrence_stats.top_recurring');
    assert.equal(shared.run_count, 2);
  });

  it('recurrence_stats.top_recurring first_seen/last_seen are RFC 3339 UTC, not SQLite datetime', () => {
    const db = openMemoryDb();
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status, created_at) VALUES ('run-iso-a', 'org/repo', '/tmp/r', ?, 'feature-audit', '2026-06-01 00:00:00')`).run('c'.repeat(40));
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status, created_at) VALUES ('run-iso-b', 'org/repo', '/tmp/r', ?, 'feature-audit', '2026-06-05 00:00:00')`).run('d'.repeat(40));
    const wA = Number(db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-iso-a', 'feature-audit', 1, 'collected')`).run().lastInsertRowid);
    const wB = Number(db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-iso-b', 'feature-audit', 1, 'collected')`).run().lastInsertRowid);
    seedFinding(db, 'run-iso-a', { id: 'F-iso', fp: 'fp-iso', status: 'new', wave: wA });
    seedFinding(db, 'run-iso-b', { id: 'F-iso', fp: 'fp-iso', status: 'new', wave: wB });

    const artifact = compileRoadmap(db, 'run-iso-a', {});
    const shared = artifact.recurrence_stats.top_recurring.find((r) => r.fingerprint === 'fp-iso');
    assert.ok(shared, 'shared fingerprint must appear in top_recurring');
    assert.equal(shared.first_seen, '2026-06-01T00:00:00Z');
    assert.equal(shared.last_seen, '2026-06-05T00:00:00Z');
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

  /** @pins F-fdcf6c9b */
  it('run_anchored_at is exactly `now` verbatim, not a second, independently-computed timestamp (naming-honesty fix — the field never claimed to be wall-clock compile time in the first place)', () => {
    const db = openMemoryDb();
    const { runId } = seedBasicRun(db);
    const now = new Date('2026-03-01T12:34:56.000Z');

    const artifact = compileRoadmap(db, runId, { now });
    assert.equal(artifact.run_anchored_at, now.toISOString());
    assert.equal(Object.hasOwn(artifact, 'generated_at'), false, 'the old, dishonestly-named key must not linger alongside the new one');
  });
});
