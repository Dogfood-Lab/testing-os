/**
 * filed-by-domain-backfill.test.js — F-e71f9e7a: the archival, evidence-
 * bearing, dry-run-first backfill for stranded-NULL filed_by_domain rows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { backfillFiledByDomain } from './filed-by-domain-backfill.js';

function seedRun(db, runId = 'run-backfill') {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`)
    .run(runId, 'a'.repeat(40));
  return runId;
}

function seedDomain(db, runId, name) {
  db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, ?, '[]', 'owned', 1)`)
    .run(runId, name);
}

function seedFinding(db, runId, findingId, { filedByDomain = null, status = 'approved' } = {}) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, filed_by_domain)
    VALUES (?, ?, ?, 'HIGH', 'missing-feature', NULL, 'd', ?, ?)
  `).run(runId, findingId, `fp-${findingId}`, status, filedByDomain);
}

/** @pins F-e71f9e7a */
describe('backfillFiledByDomain — dry-run-first (F-e71f9e7a)', () => {
  it('defaults to dry-run: reports what WOULD be applied but writes nothing', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');
    seedFinding(db, runId, 'F-stranded-1');

    const report = backfillFiledByDomain(db, runId, {
      'F-stranded-1': { domain: 'backend', evidence: 'swarms/run/wave-38/backend/output.json fixes[] lists F-stranded-1' },
    });

    assert.equal(report.apply, false);
    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0].domain, 'backend');
    const row = db.prepare('SELECT filed_by_domain FROM findings WHERE finding_id = ?').get('F-stranded-1');
    assert.equal(row.filed_by_domain, null, 'a dry-run call must make ZERO writes');
  });

  it('with apply:true, actually writes the backfilled domain and logs evidence', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');
    seedFinding(db, runId, 'F-stranded-2');

    const report = backfillFiledByDomain(db, runId, {
      'F-stranded-2': { domain: 'backend', evidence: 'wave-38 output.json' },
    }, { apply: true });

    assert.equal(report.applied.length, 1);
    const row = db.prepare('SELECT filed_by_domain FROM findings WHERE finding_id = ?').get('F-stranded-2');
    assert.equal(row.filed_by_domain, 'backend');
  });
});

describe('backfillFiledByDomain — lawful refusals (never guesses, never overwrites, F-e71f9e7a)', () => {
  it('skips (never applies) a mapping entry missing evidence', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');
    seedFinding(db, runId, 'F-no-evidence');

    const report = backfillFiledByDomain(db, runId, { 'F-no-evidence': { domain: 'backend' } }, { apply: true });
    assert.equal(report.applied.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /missing evidence/);
    assert.equal(db.prepare('SELECT filed_by_domain FROM findings WHERE finding_id = ?').get('F-no-evidence').filed_by_domain, null);
  });

  it('skips a mapping entry naming a domain that is not live in this run', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');
    seedFinding(db, runId, 'F-dead-domain');

    const report = backfillFiledByDomain(db, runId, {
      'F-dead-domain': { domain: 'a-retired-domain-name', evidence: 'wave-38 output.json' },
    }, { apply: true });

    assert.equal(report.applied.length, 0);
    assert.match(report.skipped[0].reason, /not a live domain/);
  });

  it('NEVER overwrites a filed_by_domain that is already set, even with apply:true', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');
    seedDomain(db, runId, 'docs');
    seedFinding(db, runId, 'F-already-attributed', { filedByDomain: 'docs' });

    const report = backfillFiledByDomain(db, runId, {
      'F-already-attributed': { domain: 'backend', evidence: 'a mistaken re-attribution attempt' },
    }, { apply: true });

    assert.equal(report.applied.length, 0);
    assert.match(report.skipped[0].reason, /already/);
    assert.equal(db.prepare('SELECT filed_by_domain FROM findings WHERE finding_id = ?').get('F-already-attributed').filed_by_domain, 'docs');
  });

  it('skips a finding_id with no matching row in this run', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');

    const report = backfillFiledByDomain(db, runId, {
      'F-does-not-exist': { domain: 'backend', evidence: 'wave-38 output.json' },
    }, { apply: true });

    assert.equal(report.applied.length, 0);
    assert.match(report.skipped[0].reason, /no finding row exists/);
  });

  it('a mixed mapping applies the lawful entries and skips the rest independently, in the same call', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'backend');
    seedFinding(db, runId, 'F-good');
    seedFinding(db, runId, 'F-bad-domain');

    const report = backfillFiledByDomain(db, runId, {
      'F-good': { domain: 'backend', evidence: 'wave-38 output.json' },
      'F-bad-domain': { domain: 'nonexistent', evidence: 'wave-38 output.json' },
    }, { apply: true });

    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0].finding_id, 'F-good');
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].finding_id, 'F-bad-domain');
    assert.equal(db.prepare('SELECT filed_by_domain FROM findings WHERE finding_id = ?').get('F-good').filed_by_domain, 'backend');
  });
});
