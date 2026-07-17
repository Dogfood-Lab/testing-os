/**
 * fingerprint-filed-by-domain-stamp.test.js — F-874c0683 (C3 amendment):
 * upsertFindings must stamp findings.filed_by_domain from the collect-time
 * `_declaringDomain` attribution when inserting a NEW finding, and must
 * leave it NULL (never guessed) when that attribution is absent — the
 * companion write-side half of findings-filter.js's read-side fallback
 * (see findings-filter-filed-by-domain-fallback.test.js).
 *
 * filed_by_domain is a FIRST-FILED fact, stamped once like first_seen_wave —
 * it is never overwritten on recurrence (unlike last_seen_wave), because it
 * answers "who filed this," not "who last touched it."
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { classifyFindings, upsertFindings } from './fingerprint.js';

function seedRunAndWaves(db, runId = 'run-fbd-stamp') {
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`
  ).run(runId, 'a'.repeat(40));
  const w1 = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', 1, 'collecting')`
  ).run(runId);
  const w2 = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', 2, 'collecting')`
  ).run(runId);
  return { runId, w1: Number(w1.lastInsertRowid), w2: Number(w2.lastInsertRowid) };
}

describe('upsertFindings — filed_by_domain stamped from _declaringDomain (F-874c0683)', () => {
  it('stamps filed_by_domain on a NEW finding when _declaringDomain is present', () => {
    const db = openMemoryDb();
    const { runId, w1 } = seedRunAndWaves(db);

    const finding = {
      id: 'F-001', category: 'missing-feature', severity: 'HIGH',
      description: 'a file-less feature finding', _declaringDomain: 'docs',
    };
    const classified = classifyFindings([finding], new Map());
    upsertFindings(db, runId, w1, classified);

    const row = db.prepare('SELECT filed_by_domain FROM findings WHERE run_id = ?').get(runId);
    assert.equal(row.filed_by_domain, 'docs');
  });

  it('leaves filed_by_domain NULL when _declaringDomain is absent — never guessed', () => {
    const db = openMemoryDb();
    const { runId, w1 } = seedRunAndWaves(db);

    const finding = { id: 'F-002', category: 'bug', severity: 'MEDIUM', description: 'no attribution here', file: 'lib/x.js' };
    const classified = classifyFindings([finding], new Map());
    upsertFindings(db, runId, w1, classified);

    const row = db.prepare('SELECT filed_by_domain FROM findings WHERE run_id = ?').get(runId);
    assert.equal(row.filed_by_domain, null);
  });

  it('does NOT overwrite filed_by_domain when the SAME finding recurs under a different declaring domain', () => {
    const db = openMemoryDb();
    const { runId, w1, w2 } = seedRunAndWaves(db);

    const finding = {
      id: 'F-003', category: 'missing-feature', severity: 'HIGH',
      description: 'stable content for fingerprint match', _declaringDomain: 'docs',
    };
    const first = classifyFindings([finding], new Map());
    upsertFindings(db, runId, w1, first);

    const priorMap = new Map();
    for (const row of db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId)) {
      priorMap.set(row.fingerprint, row);
    }
    // Same content (same fingerprint) re-reported by a DIFFERENT declaring
    // domain next wave — this is the recurring path, not the insert path.
    const recurring = classifyFindings(
      [{ ...finding, _declaringDomain: 'swarm-cp-tests' }],
      priorMap,
    );
    upsertFindings(db, runId, w2, recurring);

    const row = db.prepare('SELECT filed_by_domain, status FROM findings WHERE run_id = ?').get(runId);
    assert.equal(row.status, 'recurring');
    assert.equal(row.filed_by_domain, 'docs', 'filed_by_domain records who FIRST filed it, not who last re-reported it');
  });
});
