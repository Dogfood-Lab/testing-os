/**
 * cross-run-analytics-lane-fragmentation.test.js — F-e7c4c16d / F-swarmcpcore-004
 * (T2, docs/trajectory-and-closure.dispatch.md): pins queryLaneFragmentation
 * and queryFindingRecencyByFile, the two non-git attention-score factors
 * added to lib/queries/cross-run-analytics.js.
 *
 * WHY THIS FILE, NOT AN EXTENSION OF w3-cross-run-analytics.test.js. That
 * root-level file already covers this same module's pre-existing exports and
 * mirrors its seeding pattern (seedTwoRunsSharingFingerprint) closely here —
 * but it lives at the package ROOT (packages/dogfood-swarm/*.test.js), one
 * level outside this domain's owned globs (packages/dogfood-swarm/lib/**\,
 * db/**\, persist-results.js). Placed flat in lib/ instead — inside the
 * owned glob AND inside package.json's test-discovery glob
 * ("*.test.js" "lib/*.test.js", which does NOT reach lib/queries/*.test.js
 * two levels deep) — the same reasoning lib/migrate-current-version-unused
 * .test.js's own header documents for db/migrate.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { queryLaneFragmentation, queryFindingRecencyByFile } from './queries/cross-run-analytics.js';

function seedRun(db, runId) {
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`
  ).run(runId, 'a'.repeat(40));
}

function seedDomain(db, runId, name) {
  const r = db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, ?, '[]', 'owned', 1)`
  ).run(runId, name);
  return Number(r.lastInsertRowid);
}

function seedWave(db, runId, waveNumber, phase = 'feature-audit') {
  const r = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, 'collected')`
  ).run(runId, phase, waveNumber);
  return Number(r.lastInsertRowid);
}

function seedAgentRun(db, waveId, domainId) {
  const r = db.prepare(
    `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`
  ).run(waveId, domainId);
  return Number(r.lastInsertRowid);
}

function seedFileClaim(db, agentRunId, filePath, domainId) {
  db.prepare(
    `INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation) VALUES (?, ?, 'edit', ?, 0)`
  ).run(agentRunId, filePath, domainId);
}

describe('queryLaneFragmentation — distinct-domain-touch count per file (F-e7c4c16d)', () => {
  it('counts a file touched by two domains as domain_count=2, a single-domain file as domain_count=1', () => {
    const db = openMemoryDb();
    const runId = 'run-lf';
    seedRun(db, runId);
    const core = seedDomain(db, runId, 'swarm-cp-core');
    const tests = seedDomain(db, runId, 'swarm-cp-tests');
    const wave = seedWave(db, runId, 1);
    const coreAgent = seedAgentRun(db, wave, core);
    const testsAgent = seedAgentRun(db, wave, tests);

    seedFileClaim(db, coreAgent, 'shared.js', core);
    seedFileClaim(db, testsAgent, 'shared.js', tests);
    seedFileClaim(db, coreAgent, 'core-only.js', core);

    const rows = queryLaneFragmentation(db, runId);
    const shared = rows.find(r => r.file_path === 'shared.js');
    const coreOnly = rows.find(r => r.file_path === 'core-only.js');
    assert.equal(shared.domain_count, 2);
    assert.equal(coreOnly.domain_count, 1);
  });

  it('orders by domain_count DESC, then file_path ASC (deterministic tiebreak)', () => {
    const db = openMemoryDb();
    const runId = 'run-lf-order';
    seedRun(db, runId);
    const core = seedDomain(db, runId, 'swarm-cp-core');
    const tests = seedDomain(db, runId, 'swarm-cp-tests');
    const wave = seedWave(db, runId, 1);
    const coreAgent = seedAgentRun(db, wave, core);
    const testsAgent = seedAgentRun(db, wave, tests);

    // Two files tie at domain_count=1 ('z.js', 'a.js') — file_path ASC breaks
    // the tie. One file at domain_count=2 ('shared.js') sorts first.
    seedFileClaim(db, coreAgent, 'z.js', core);
    seedFileClaim(db, coreAgent, 'a.js', core);
    seedFileClaim(db, coreAgent, 'shared.js', core);
    seedFileClaim(db, testsAgent, 'shared.js', tests);

    const rows = queryLaneFragmentation(db, runId);
    assert.deepEqual(rows.map(r => r.file_path), ['shared.js', 'a.js', 'z.js']);
  });

  it('scopes strictly to the given run_id — a second run\'s claims never leak in', () => {
    const db = openMemoryDb();
    seedRun(db, 'run-a');
    seedRun(db, 'run-b');
    const domainA = seedDomain(db, 'run-a', 'core');
    const domainB = seedDomain(db, 'run-b', 'core');
    const waveA = seedWave(db, 'run-a', 1);
    const waveB = seedWave(db, 'run-b', 1);
    seedFileClaim(db, seedAgentRun(db, waveA, domainA), 'only-in-a.js', domainA);
    seedFileClaim(db, seedAgentRun(db, waveB, domainB), 'only-in-b.js', domainB);

    const rowsA = queryLaneFragmentation(db, 'run-a');
    assert.deepEqual(rowsA.map(r => r.file_path), ['only-in-a.js']);
  });
});

describe('queryFindingRecencyByFile — per-file finding count + most recent wave (F-e7c4c16d)', () => {
  it('reports finding_count and MAX(last_seen_wave) per file, scoped to the run', () => {
    const db = openMemoryDb();
    const runId = 'run-recency';
    seedRun(db, runId);
    const w1 = seedWave(db, runId, 1);
    const w2 = seedWave(db, runId, 2);

    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-1', 'fp-1', 'HIGH', 'bug', 'hot.js', 'd1', 'recurring', ?, ?)`
    ).run(runId, w1, w2);
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-2', 'fp-2', 'MEDIUM', 'bug', 'hot.js', 'd2', 'new', ?, ?)`
    ).run(runId, w2, w2);
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-3', 'fp-3', 'LOW', 'bug', 'cold.js', 'd3', 'new', ?, ?)`
    ).run(runId, w1, w1);

    const rows = queryFindingRecencyByFile(db, runId);
    const hot = rows.find(r => r.file_path === 'hot.js');
    const cold = rows.find(r => r.file_path === 'cold.js');
    assert.equal(hot.finding_count, 2);
    assert.equal(hot.most_recent_wave, w2);
    assert.equal(cold.finding_count, 1);
    assert.equal(cold.most_recent_wave, w1);

    // Ordering: most_recent_wave DESC puts hot.js (wave 2) before cold.js (wave 1).
    assert.deepEqual(rows.map(r => r.file_path), ['hot.js', 'cold.js']);
  });

  it('excludes file-less findings (file_path IS NULL) — routed by filed_by_domain instead, not this query', () => {
    const db = openMemoryDb();
    const runId = 'run-recency-fileless';
    seedRun(db, runId);
    const w1 = seedWave(db, runId, 1);
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-1', 'fp-1', 'HIGH', 'missing-feature', NULL, 'file-less feature finding', 'new', ?, ?)`
    ).run(runId, w1, w1);

    const rows = queryFindingRecencyByFile(db, runId);
    assert.equal(rows.length, 0, 'a NULL file_path finding must not appear in a per-FILE query');
  });
});
