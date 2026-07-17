/**
 * roadmap-drain.test.js — F-6c807f60 / F-1cd5de59 (T6,
 * docs/trajectory-and-closure.dispatch.md): drain-queue compilation.
 *
 * Amendment 3 (wave 42/43) additions covered below:
 *   - compileAuthoredDrainState (A3.2a): previously exercised ONLY through
 *     the root-level, out-of-this-domain F-1cd5de59 CLI end-to-end test —
 *     zero direct unit coverage existed. Added here alongside the fail-closed
 *     missing-owner skip and the optional `reason` field.
 *   - compileGrandfatherManifestDrainState (A3.2b, NEW this wave): the
 *     256-entry FROZEN manifest half — do not confuse with
 *     compileGrandfatheredManifestDrain above, which reads the DIFFERENT
 *     36-entry allowlist (see drain.js's own module header, "TWO
 *     SUPPRESSION-REGISTRY FILES, NOT INTERCHANGEABLE").
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
  compileUnroutableApprovedDrain,
  compileAuthoredDrainState,
  compileGrandfatherManifestDrainState,
  FROZEN_GRANDFATHER_MANIFEST_TOTAL,
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

/**
 * Same shape as withRepoRoot but plants the DIFFERENT, 256-entry-style
 * manifest file (`scripts/grandfathered-pins.json`) rather than the
 * 36-entry allowlist. `manifestBody` is the FULL parsed-JSON shape
 * (`{ $comment?, frozen_at_commit?, frozen_at_date?, grandfathered }`), not
 * just the inner map, so a test can also exercise header-field variation.
 */
function withGrandfatherManifest(manifestBody, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'roadmap-drain-gf-'));
  try {
    if (manifestBody !== null) {
      mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts', 'grandfathered-pins.json'), JSON.stringify(manifestBody));
    }
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function seedDrainStateRun(db, runId, repoDir, { numRuns = 1 } = {}) {
  const insRun = db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let currentId;
  for (let i = 1; i <= numRuns; i++) {
    const id = i === numRuns ? runId : `${runId}-prior-${i}`;
    const createdAt = `2026-01-${String(i).padStart(2, '0')} 00:00:00`;
    insRun.run(id, 'org/drain-state-repo', repoDir, String(i).repeat(40).slice(0, 40), 'main',
      i === numRuns ? 'feature-audit' : 'complete', createdAt);
    currentId = id;
  }
  return currentId;
}

function writeDrainStateFile(repoDir, entries) {
  mkdirSync(join(repoDir, 'dogfood'), { recursive: true });
  writeFileSync(join(repoDir, 'dogfood', 'roadmap-drain-state.json'), JSON.stringify({ entries }, null, 2));
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

  /**
   * @pins F-2f7dd0ce
   * F-2f7dd0ce's fix was a DOCSTRING correction (drain.js's own header
   * wrongly described this boundary as INCLUSIVE while the code below —
   * unchanged by that fix — was always EXCLUSIVE); there is no behavior
   * change to pin, since the bug never reached runtime. This test is the
   * closest available regression pin: it proves the BEHAVIORAL CLAIM the
   * corrected header now accurately describes, matching the two named
   * precedents for this exact "drift inside a comment" class
   * (F-017409f3, F-c4d70660), both of which also had no behavior-level pin
   * available and were left to the grandfathered bucket for the identical
   * reason. A future re-introduction of the wrong INCLUSIVE claim in prose
   * would not be caught here (no test can assert on a comment's content) —
   * an honest limitation, disclosed rather than pretended away.
   */
  it('an entry whose revalidate_by is TODAY (exactly at the boundary) is NOT yet overdue — exclusive per the shared revalidation-cadence convention (F-780490da)', () => {
    const allowlist = { allow: { 'F-1': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2026-07-17' } } };
    withRepoRoot(allowlist, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      assert.equal(result.overdue.length, 0,
        'revalidate_by === today must NOT be overdue — the boundary is exclusive (revalidate_by < today), ' +
        'matching scripts/lib/revalidation-cadence.mjs so one definition of overdue exists');
    });
  });

  it('an entry whose revalidate_by was YESTERDAY is overdue (exclusive boundary, one day past)', () => {
    const allowlist = { allow: { 'F-1': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2026-07-16' } } };
    withRepoRoot(allowlist, (repoRoot) => {
      const result = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      assert.equal(result.overdue.length, 1);
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
  it('returns both halves plus an explicit scope-note string, plus the unroutable-approved advisory (F-32e2ed6f)', () => {
    withRepoRoot({ allow: {} }, (repoRoot) => {
      const db = openMemoryDb();
      db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES ('run-x', 'org/repo', '/tmp/r', ?, 'feature-audit')`).run('a'.repeat(40));
      db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-x', 'feature-audit', 1, 'collected')`).run();

      const result = compileDrainQueue(db, 'run-x', { repoRoot });
      assert.ok('grandfathered_manifest' in result);
      assert.ok('deferred_findings' in result);
      assert.equal(typeof result.deferred_findings_scope_note, 'string');
      assert.match(result.deferred_findings_scope_note, /last_seen_wave-based staleness only/);
      assert.ok('unroutable_approved' in result);
      assert.equal(result.unroutable_approved.count, 0);
    });
  });
});

/**
 * F-32e2ed6f: the drain queue was blind to approved findings that are
 * structurally unroutable by ANY mechanism this pass ships — no file_path
 * to glob-match, and either no filed_by_domain to fall back to, or a
 * filed_by_domain naming a domain that is not live in this run's CURRENT
 * frozen map. This proves the section this repo's own drain-visibility
 * promise (T6: "entries past cadence surface at the top of the next run's
 * digest") now covers that exact shape.
 */
function seedDomain(db, runId, name) {
  db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, ?, '[]', 'owned', 1)`)
    .run(runId, name);
}

function seedApproved(db, runId, findingId, { filePath = null, filedByDomain = null } = {}) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, filed_by_domain)
    VALUES (?, ?, ?, 'HIGH', 'quality', ?, 'd', 'approved', ?)
  `).run(runId, findingId, `fp-${findingId}`, filePath, filedByDomain);
}

/** @pins F-32e2ed6f */
describe('compileUnroutableApprovedDrain — approved + file-less + unroutable filed_by_domain (F-32e2ed6f)', () => {
  function seedRun(db, runId = 'run-unroutable') {
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`)
      .run(runId, 'a'.repeat(40));
    return runId;
  }

  it('surfaces an approved, file-less finding with filed_by_domain NULL (pre-attribution history)', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedApproved(db, runId, 'F-null-domain');

    const result = compileUnroutableApprovedDrain(db, runId);
    assert.equal(result.count, 1);
    assert.deepEqual(result.findings, [{ finding_id: 'F-null-domain', filed_by_domain: null }]);
  });

  it('surfaces an approved, file-less finding whose filed_by_domain names a domain that is NOT live in this run', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'docs');
    seedApproved(db, runId, 'F-dead-domain', { filedByDomain: 'a-domain-that-no-longer-exists' });

    const result = compileUnroutableApprovedDrain(db, runId);
    assert.equal(result.count, 1);
    assert.equal(result.findings[0].finding_id, 'F-dead-domain');
  });

  it('does NOT surface an approved, file-less finding whose filed_by_domain names a LIVE domain — it is routable', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedDomain(db, runId, 'docs');
    seedApproved(db, runId, 'F-routable', { filedByDomain: 'docs' });

    const result = compileUnroutableApprovedDrain(db, runId);
    assert.equal(result.count, 0);
    assert.deepEqual(result.findings, []);
  });

  it('does NOT surface an approved finding that HAS a file_path — glob-routable regardless of filed_by_domain', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedApproved(db, runId, 'F-has-file', { filePath: 'lib/x.js' });

    const result = compileUnroutableApprovedDrain(db, runId);
    assert.equal(result.count, 0);
  });

  it('does NOT surface a file-less finding in a NON-approved status, even with no filed_by_domain', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, filed_by_domain)
      VALUES (?, 'F-new', 'fp-new', 'HIGH', 'quality', NULL, 'd', 'new', NULL)
    `).run(runId);

    const result = compileUnroutableApprovedDrain(db, runId);
    assert.equal(result.count, 0);
  });

  it('orders findings by finding_id ASC, deterministically', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedApproved(db, runId, 'F-zzz');
    seedApproved(db, runId, 'F-aaa');

    const result = compileUnroutableApprovedDrain(db, runId);
    assert.deepEqual(result.findings.map((f) => f.finding_id), ['F-aaa', 'F-zzz']);
  });
});

/** @pins F-1cd5de59 */
describe('compileAuthoredDrainState — A3.2a (previously CLI-only coverage; direct unit tests added wave 43)', () => {
  it('a valid entry produces {id, owner, cadence_runs, runs_since_review, overdue} with no reason key when the seed omits one', () => {
    const db = openMemoryDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'roadmap-drain-authored-'));
    try {
      const runId = seedDrainStateRun(db, 'run-authored-1', repoDir, { numRuns: 6 });
      writeDrainStateFile(repoDir, [{ id: 'F-x', owner: 'coordinator', last_reviewed_run_ordinal: 1, cadence_runs: 5 }]);

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      const result = compileAuthoredDrainState(db, run);

      assert.equal(result.available, true);
      assert.deepEqual(result.entries, [{
        id: 'F-x', owner: 'coordinator', cadence_runs: 5, runs_since_review: 5, overdue: false,
      }]);
      assert.equal(Object.hasOwn(result.entries[0], 'reason'), false);
      assert.deepEqual(result.overdue_ids, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('carries an optional, non-empty reason through to the output entry', () => {
    const db = openMemoryDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'roadmap-drain-authored-'));
    try {
      const runId = seedDrainStateRun(db, 'run-authored-2', repoDir, { numRuns: 1 });
      writeDrainStateFile(repoDir, [{
        id: 'F-y', owner: 'coordinator', last_reviewed_run_ordinal: 1, cadence_runs: 5, reason: 'awaiting upstream fix',
      }]);

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      const result = compileAuthoredDrainState(db, run);
      assert.equal(result.entries[0].reason, 'awaiting upstream fix');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('a present-but-empty/whitespace-only reason is treated as absent, not passed through', () => {
    const db = openMemoryDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'roadmap-drain-authored-'));
    try {
      const runId = seedDrainStateRun(db, 'run-authored-3', repoDir, { numRuns: 1 });
      writeDrainStateFile(repoDir, [{
        id: 'F-z', owner: 'coordinator', last_reviewed_run_ordinal: 1, cadence_runs: 5, reason: '   ',
      }]);

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      const result = compileAuthoredDrainState(db, run);
      assert.equal(Object.hasOwn(result.entries[0], 'reason'), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('coordinator-relay fix: an entry with a missing/empty owner is SKIPPED, never emitted with owner:"" (schema minLength:1)', () => {
    const db = openMemoryDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'roadmap-drain-authored-'));
    try {
      const runId = seedDrainStateRun(db, 'run-authored-4', repoDir, { numRuns: 1 });
      writeDrainStateFile(repoDir, [
        { id: 'F-no-owner', last_reviewed_run_ordinal: 1, cadence_runs: 5 },
        { id: 'F-empty-owner', owner: '', last_reviewed_run_ordinal: 1, cadence_runs: 5 },
        { id: 'F-has-owner', owner: 'coordinator', last_reviewed_run_ordinal: 1, cadence_runs: 5 },
      ]);

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      const result = compileAuthoredDrainState(db, run);

      assert.deepEqual(result.entries.map((e) => e.id), ['F-has-owner'],
        'both the missing-owner and empty-owner entries must be excluded, never emitted with owner:""');
      assert.ok(result.entries.every((e) => typeof e.owner === 'string' && e.owner.length > 0),
        'every emitted entry must have a non-empty owner — the schema-invalid shape must never escape this producer');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('degrades to available:false (never throws) when the drain-state file is absent', () => {
    const db = openMemoryDb();
    const repoDir = mkdtempSync(join(tmpdir(), 'roadmap-drain-authored-'));
    try {
      const runId = seedDrainStateRun(db, 'run-authored-5', repoDir, { numRuns: 1 });
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      const result = compileAuthoredDrainState(db, run);
      assert.equal(result.available, false);
      assert.deepEqual(result.entries, []);
      assert.deepEqual(result.overdue_ids, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('degrades to available:false (never throws) when `run` is omitted or has no local_path', () => {
    const db = openMemoryDb();
    assert.doesNotThrow(() => {
      assert.equal(compileAuthoredDrainState(db, null).available, false);
      assert.equal(compileAuthoredDrainState(db, {}).available, false);
    });
  });
});

// No `@pins` tag here by design: A3.2b (docs/trajectory-and-closure
// .dispatch.md, Amendment 3) is a dispatch-section reference, not a filed
// F-id — check-finding-regression-pins.mjs's dangling-id check requires a
// real F-id both a test tag AND a source-side mention can agree on, and
// "A3.2b" is not F-id-shaped (F_ID_PATTERN would flag it, and every word in
// a parenthetical after it, as bad-shape — verified live against the real
// gate this wave). Referenced in prose only, matching this package's
// established convention for coordinator/dispatch-sourced work with no
// minted id (see lib/fingerprint-fileless-discrimination.test.js's header,
// pre-F-52e61f49, for the identical situation and its own resolution once a
// real id existed to tag).
describe('compileGrandfatherManifestDrainState — A3.2b, the 256-entry FROZEN manifest half (NOT the 36-entry allowlist above)', () => {
  it('emits ALL remaining entries (not just overdue ones), shaped {id, owner, revalidate_by}, id ASC', () => {
    withGrandfatherManifest({
      frozen_at_commit: '132dc18',
      frozen_at_date: '2026-07-16',
      grandfathered: {
        'F-zzz': { owner: 'coordinator', revalidate_by: '2099-01-01' }, // far future — still "outstanding"
        'F-aaa': { owner: 'coordinator', revalidate_by: '2020-01-01' }, // long past — also "outstanding"
      },
    }, (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(result.available, true);
      assert.deepEqual(result.outstanding, [
        { id: 'F-aaa', owner: 'coordinator', revalidate_by: '2020-01-01' },
        { id: 'F-zzz', owner: 'coordinator', revalidate_by: '2099-01-01' },
      ], 'both entries surface regardless of revalidate_by — A3.2b: "emit ALL remaining entries," never filtered to overdue-only');
    });
  });

  it('frozen_total is the DOCUMENTED CONSTANT, never Object.keys(...).length — drained = frozen_total - live count', () => {
    withGrandfatherManifest({
      grandfathered: { 'F-1': { owner: 'coordinator', revalidate_by: '2099-01-01' } },
    }, (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(result.frozen_total, FROZEN_GRANDFATHER_MANIFEST_TOTAL);
      assert.equal(result.drained, FROZEN_GRANDFATHER_MANIFEST_TOTAL - 1,
        'drained must be computed against the FROZEN constant, not a live re-derived total — a live-derived ' +
        'total would silently report drained:0 regardless of how many entries had actually migrated out');
    });
  });

  it('carries an optional per-entry reason through unchanged when the manifest genuinely has one (never invented when absent)', () => {
    withGrandfatherManifest({
      grandfathered: {
        'F-1': { owner: 'coordinator', revalidate_by: '2099-01-01', reason: 'still under investigation' },
        'F-2': { owner: 'coordinator', revalidate_by: '2099-01-01' },
      },
    }, (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      const withReason = result.outstanding.find((e) => e.id === 'F-1');
      const withoutReason = result.outstanding.find((e) => e.id === 'F-2');
      assert.equal(withReason.reason, 'still under investigation');
      assert.equal(Object.hasOwn(withoutReason, 'reason'), false, 'a reason must never be invented for an entry that has none');
    });
  });

  it('degrades to available:false with frozen_total:0/drained:0/outstanding:[] (never throws) when the manifest is absent — the honest "not applicable" shape for a foreign audited repo', () => {
    withGrandfatherManifest(null, (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.deepEqual(result, { available: false, frozen_total: 0, drained: 0, outstanding: [] });
    });
  });

  it('degrades to available:false (never throws) when repoRoot is omitted entirely', () => {
    assert.doesNotThrow(() => {
      const result = compileGrandfatherManifestDrainState(undefined);
      assert.equal(result.available, false);
    });
  });

  it('degrades to available:false (never throws) on malformed JSON', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'roadmap-drain-gf-bad-'));
    try {
      mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
      writeFileSync(join(repoRoot, 'scripts', 'grandfathered-pins.json'), '{ not valid json');
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(result.available, false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('skips a malformed individual entry (missing owner or revalidate_by) rather than throwing — an advisory reader, not the CI gate', () => {
    withGrandfatherManifest({
      grandfathered: {
        'F-good': { owner: 'coordinator', revalidate_by: '2099-01-01' },
        'F-no-owner': { revalidate_by: '2099-01-01' },
        'F-no-date': { owner: 'coordinator' },
      },
    }, (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.deepEqual(result.outstanding.map((e) => e.id), ['F-good']);
    });
  });

  it('reads the 256-entry MANIFEST path, not the 36-entry ALLOWLIST path — the two files are never conflated', () => {
    // Plant ONLY the allowlist (compileGrandfatheredManifestDrain's file);
    // the manifest path must be independently absent -> unavailable.
    withRepoRoot({ allow: { 'F-1': { reason: 'r', file: 'f', owner: 'o', revalidate_by: '2020-01-01' } } }, (repoRoot) => {
      const allowlistResult = compileGrandfatheredManifestDrain(repoRoot, new Date('2026-07-17T00:00:00Z'));
      const manifestResult = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(allowlistResult.available, true, 'the allowlist reader must see the allowlist file');
      assert.equal(manifestResult.available, false, 'the manifest reader must NOT see the allowlist file at its own different path');
    });
  });
});
