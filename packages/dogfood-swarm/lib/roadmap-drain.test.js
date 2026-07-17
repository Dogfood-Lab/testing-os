/**
 * roadmap-drain.test.js — F-6c807f60 / F-1cd5de59 (T6,
 * docs/trajectory-and-closure.dispatch.md): drain-queue compilation, both
 * halves.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openMemoryDb } from '../db/connection.js';
import {
  compileGrandfatheredManifestDrain,
  compileDeferredFindingsDrain,
  compileDrainQueue,
  DEFAULT_STALE_WAVE_THRESHOLD,
} from './roadmap/drain.js';

function withRepoRoot(allowlistBody, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'roadmap-drain-'));
  try {
    if (allowlistBody !== null) {
      mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts', 'regression-pin-allowlist.json'), JSON.stringify(allowlistBody));
    }
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** @pins F-6c807f60 */
describe('compileGrandfatheredManifestDrain — F-6c807f60 grandfathered-manifest half', () => {
  it('projects an entry PAST its revalidate_by date as overdue, shaped like a real allowlist entry', () => {
    // Field shapes pulled from the real scripts/regression-pin-allowlist.json
    // convention (reason/file/owner/revalidate_by), per F-1cd5de59's own
    // non-vacuity instruction.
    const allowlist = {
      allow: {
        'F-f0d874a7': {
          reason: 'Cross-reference, not a fix pin.',
          file: 'packages/dogfood-swarm/lib/wave-state-machine.js',
          owner: 'coordinator',
          revalidate_by: '2026-01-01',
        },
      },
    };
    withRepoRoot(allowlist, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      assert.equal(result.available, true);
      assert.equal(result.overdue.length, 1);
      assert.equal(result.overdue[0].finding_id, 'F-f0d874a7');
      assert.equal(result.overdue[0].owner, 'coordinator');
    });
  });

  it('an entry whose revalidate_by is TODAY (exactly at the boundary) is overdue — inclusive per this file\'s own date convention', () => {
    const allowlist = { allow: { 'F-1': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2026-07-17' } } };
    withRepoRoot(allowlist, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      assert.equal(result.overdue.length, 1, 'a revalidate_by of TODAY must already be overdue, not "due tomorrow"');
    });
  });

  it('an entry whose revalidate_by is in the FUTURE is not overdue', () => {
    const allowlist = { allow: { 'F-1': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2027-01-01' } } };
    withRepoRoot(allowlist, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      assert.equal(result.overdue.length, 0);
    });
  });

  it('degrades to available:false (never throws) when the allowlist file is absent', () => {
    withRepoRoot(null, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot);
      assert.equal(result.available, false);
      assert.deepEqual(result.overdue, []);
    });
  });

  it('degrades to available:false (never throws) when repoRoot is omitted entirely — self-caught by compile.js\'s own suite: join(undefined, ...) previously threw a raw TypeError instead of this documented degraded shape', () => {
    assert.doesNotThrow(() => {
      const result = compileGrandfatheredManifestDrain(undefined);
      assert.equal(result.available, false);
    });
  });

  it('degrades to available:false (never throws) on malformed JSON', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'roadmap-drain-bad-'));
    try {
      mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts', 'regression-pin-allowlist.json'), '{ not valid json');
      const result = compileGrandfatheredManifestDrain(repoRoot);
      assert.equal(result.available, false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('orders overdue entries by revalidate_by ASC (most overdue first), then finding_id ASC', () => {
    const allowlist = {
      allow: {
        'F-z': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2026-02-01' },
        'F-a': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2026-02-01' },
        'F-b': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2026-01-01' },
      },
    };
    withRepoRoot(allowlist, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      assert.deepEqual(result.overdue.map((e) => e.finding_id), ['F-b', 'F-a', 'F-z']);
    });
  });
});

describe('compileDeferredFindingsDrain — F-6c807f60 deferred-findings half (disclosed-weaker)', () => {
  function seedRunWithWaves(waveCount) {
    const db = openMemoryDb();
    const runId = 'run-drain';
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`)
      .run(runId, 'a'.repeat(40));
    const waveIds = [];
    for (let n = 1; n <= waveCount; n++) {
      waveIds.push(Number(db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', ?, 'collected')`).run(runId, n).lastInsertRowid));
    }
    return { db, runId, waveIds };
  }

  function seedDeferred(db, runId, findingId, lastSeenWaveId) {
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, ?, ?, 'MEDIUM', 'bug', 'f.js', 'd', 'deferred', ?, ?)`
    ).run(runId, findingId, `fp-${findingId}`, lastSeenWaveId, lastSeenWaveId);
  }

  it('boundary pair (F-1cd5de59, pinned verbatim): exactly AT the threshold is NOT stale; threshold+1 IS stale', () => {
    // 8 waves total (1..8). Threshold = DEFAULT (3).
    const { db, runId, waveIds } = seedRunWithWaves(8);
    // "reviewed 5 runs ago, cadence=5" generalized: last seen at wave 5 of 8
    // -> wavesBehind = 3 = threshold EXACTLY -> not yet stale.
    seedDeferred(db, runId, 'F-at-threshold', waveIds[4]); // wave_number 5, wavesBehind = 8-5=3
    // last seen at wave 4 -> wavesBehind = 4 = threshold+1 -> stale.
    seedDeferred(db, runId, 'F-past-threshold', waveIds[3]); // wave_number 4, wavesBehind = 8-4=4

    const result = compileDeferredFindingsDrain(db, runId, { staleWaveThreshold: DEFAULT_STALE_WAVE_THRESHOLD });
    const ids = result.stale.map((s) => s.finding_id);
    assert.ok(!ids.includes('F-at-threshold'), 'exactly-at-threshold must NOT be flagged stale yet');
    assert.ok(ids.includes('F-past-threshold'), 'threshold+1 must be flagged stale');
  });

  it('only status=deferred findings are considered — approved/new/fixed rows never appear', () => {
    const { db, runId, waveIds } = seedRunWithWaves(10);
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-approved', 'fp-approved', 'HIGH', 'bug', 'f.js', 'd', 'approved', ?, ?)`
    ).run(runId, waveIds[0], waveIds[0]);
    seedDeferred(db, runId, 'F-deferred-stale', waveIds[0]);

    const result = compileDeferredFindingsDrain(db, runId, { staleWaveThreshold: 1 });
    assert.deepEqual(result.stale.map((s) => s.finding_id), ['F-deferred-stale']);
  });

  it('orders by waves_behind DESC, then finding_id ASC', () => {
    const { db, runId, waveIds } = seedRunWithWaves(10);
    seedDeferred(db, runId, 'F-z', waveIds[0]); // very stale
    seedDeferred(db, runId, 'F-a', waveIds[0]); // same staleness, tiebreak by id
    seedDeferred(db, runId, 'F-recent', waveIds[8]); // barely stale

    const result = compileDeferredFindingsDrain(db, runId, { staleWaveThreshold: 0 });
    assert.deepEqual(result.stale.map((s) => s.finding_id), ['F-a', 'F-z', 'F-recent']);
  });
});

describe('compileDrainQueue — composes both halves and discloses the scope narrowing', () => {
  it('returns both halves plus an explicit scope-note string', () => {
    withRepoRoot({ allow: {} }, (repoRoot) => {
      const db = openMemoryDb();
      db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES ('run-x', 'org/repo', '/tmp/r', ?, 'feature-audit')`).run('a'.repeat(40));
      db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-x', 'feature-audit', 1, 'collected')`).run();

      const result = compileDrainQueue(db, 'run-x', { repoRoot });
      assert.ok('grandfathered_manifest' in result);
      assert.ok('deferred_findings' in result);
      assert.equal(typeof result.deferred_findings_scope_note, 'string');
      assert.match(result.deferred_findings_scope_note, /last_seen_wave-based staleness only/);
    });
  });
});
