/**
 * a3-roadmap-envelope-conformance.test.js
 *
 * docs/trajectory-and-closure.dispatch.md, "Amendment 3" (wave 42) —
 * swarm-cp-verbs' half of the wave-43 conformance work: commands/roadmap.js
 * emits the schema's required sections, sourced from
 * `compileRoadmapSections`'s (lib/roadmap/compile.js, swarm-cp-core) output
 * VERBATIM, "no intermediate vocabulary" (A3.1).
 *
 * SEAM DISCLOSURE (verified by direct execution, not assumed): this
 * worktree's copy of lib/roadmap/compile.js still has the PRE-A3 shape (no
 * `open_summary`/`compiled_from`/`grandfathered_drain`, a differently-shaped
 * `attention`/`drain_queue`) — swarm-cp-core lands A3's reshape in ITS OWN
 * worktree this same wave (commands/roadmap.js's own header, "SEAM (wave 43
 * — Amendment 3)"). Running `swarm roadmap compile` end-to-end here does
 * NOT crash (buildRoadmapArtifact's whitelist reads simply come back
 * `undefined` for the four missing sections, and JSON.stringify drops
 * `undefined`-valued keys) — it exits 0 and writes an artifact SILENTLY
 * MISSING those four required A3 fields, which is arguably a worse failure
 * mode than a crash precisely because it doesn't announce itself. Unlike
 * f-feeaef78-roadmap-compile-determinism.test.js (whose two assertions —
 * cross-process byte-identity and a static ORDER BY scan — are provably
 * orthogonal to A3's field vocabulary and pass regardless of compile.js's
 * shape), this file does NOT attempt a real end-to-end `swarm roadmap
 * compile` assertion at all: proving "the artifact is missing 4 fields
 * today" would be a transient, throwaway assertion (true only until core's
 * edit lands, then simply deleted, not evolved into a permanent contract)
 * rather than a lasting pin. Instead it tests the two things fully within
 * this domain's own control, independent of compile.js's current shape:
 *
 *   1. `buildRoadmapArtifact(sections, extras)` — the pure, exported
 *      field-mapping function this fix extracted specifically so A3.1's
 *      contract ("no intermediate vocabulary") is unit-testable against a
 *      HAND-BUILT `sections` fixture matching A3's TARGET shape, regardless
 *      of what compile.js currently returns in this worktree.
 *   2. `showRoadmap()`'s A3.5 residuals + the "not yet compiled" report
 *      shape — fully real and seam-independent (loadRoadmapArtifact
 *      legitimately returns null for an uncompiled run; the three residual
 *      producers, lib/roadmap/drain.js, have never been behind the
 *      compiler.js seam) — AND the "already compiled" merge path, tested by
 *      fabricating an A3-shaped artifact file + ledger row DIRECTLY
 *      (recordRoadmapArtifact, a real, unseamed lib/roadmap/artifacts.js
 *      export) rather than by running a real `swarm roadmap compile`.
 *
 * If core's actual A3 edit lands with different field names than this
 * file's own reading of Amendment 3's text, reconciling BOTH this test and
 * commands/roadmap.js itself is the merge follow-up — the same posture
 * commands/roadmap.js's own header already discloses.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { recordRoadmapArtifact } from './lib/roadmap/artifacts.js';
import {
  buildRoadmapArtifact,
  showRoadmap,
  formatRoadmapShow,
  formatRoadmapCompile,
} from './commands/roadmap.js';

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/** A hand-built `sections` fixture matching A3.1's TARGET compile.js shape. */
const A3_SECTIONS_FIXTURE = {
  run_id: 'roadmap-a3-r1',
  repo: 'dogfood-lab/testing-os',
  compiled_from: { commit_sha: 'a'.repeat(40) },
  open_summary: { open: 2, deferred: 1, approved: 3, fixed: 0, rejected: 0, recurring: 1 },
  grandfathered_drain: { frozen_total: 256, drained: 4, outstanding: [] },
  recurrence_stats: { top_recurring: [] },
  attention: {
    advisory: true,
    items: [
      { file: 'packages/a/src/foo.js', score: 0.8, components: { churn: 0.5, recency: 0.9, fragmentation: 1 } },
    ],
  },
  // compile.js's own operator_notes is ALWAYS EMPTY on the CLI callpath
  // (opts.operatorNotes defaults to []) — buildRoadmapArtifact must never
  // read it; the REAL notes source is the `extras` param.
  operator_notes: { active: [], expired: [], dropped_invalid: [] },
  run_anchored_at: '2026-07-17T12:00:00.000Z',
};

const A3_EXTRAS_FIXTURE = {
  activeNotes: [{ kind: 'theme', text: 'keep it simple', expires: 5 }],
  expiredNotes: [{ kind: 'open-question', text: 'stale note', expires: '2020-01-01' }],
  drainQueue: { entries: [{ id: 'F-1', owner: 'coordinator', cadence_runs: 5, runs_since_review: 6, overdue: true }], overdue_ids: ['F-1'] },
  notesPath: 'dogfood/roadmap-notes.json',
};

/** @pins A3.1 A3.3 A3.4 */
describe('A3.1 — buildRoadmapArtifact: schema-named envelope, no intermediate vocabulary', () => {
  it('passes every named section through from `sections` verbatim, under its OWN schema name', () => {
    const artifact = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);

    assert.equal(artifact.run_id, 'roadmap-a3-r1');
    assert.equal(artifact.repo, 'dogfood-lab/testing-os');
    assert.deepEqual(artifact.compiled_from, { commit_sha: 'a'.repeat(40) });
    assert.deepEqual(artifact.open_summary, A3_SECTIONS_FIXTURE.open_summary);
    assert.deepEqual(artifact.grandfathered_drain, A3_SECTIONS_FIXTURE.grandfathered_drain);
    assert.deepEqual(artifact.recurrence_stats, A3_SECTIONS_FIXTURE.recurrence_stats);
    assert.deepEqual(artifact.attention, A3_SECTIONS_FIXTURE.attention);
  });

  it('A3.3: compiled_at is a REAL READ-THROUGH of run_anchored_at, not an independent recomputation', () => {
    const artifact = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);
    assert.equal(artifact.compiled_at, A3_SECTIONS_FIXTURE.run_anchored_at);

    // Proof that it is a READ-THROUGH, not a coincidental match: changing
    // ONLY run_anchored_at on the input must change compiled_at identically,
    // with no other section affected.
    const shifted = buildRoadmapArtifact(
      { ...A3_SECTIONS_FIXTURE, run_anchored_at: '2030-01-01T00:00:00.000Z' },
      A3_EXTRAS_FIXTURE,
    );
    assert.equal(shifted.compiled_at, '2030-01-01T00:00:00.000Z');
    assert.equal(shifted.run_id, artifact.run_id, 'only compiled_at should track the shifted input');
  });

  it('A3.1: compile.js\'s own always-empty operator_notes is IGNORED — the real notes source is extras', () => {
    const artifact = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);
    assert.deepEqual(artifact.operator_notes, A3_EXTRAS_FIXTURE.activeNotes);
    assert.notDeepEqual(artifact.operator_notes, A3_SECTIONS_FIXTURE.operator_notes.active);
  });

  it('A3.4: expired_notes (renamed from `expired`) carries extras.expiredNotes, required-empty-allowed', () => {
    const artifact = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);
    assert.deepEqual(artifact.expired_notes, A3_EXTRAS_FIXTURE.expiredNotes);

    const emptyExpired = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, { ...A3_EXTRAS_FIXTURE, expiredNotes: [] });
    assert.deepEqual(emptyExpired.expired_notes, [], 'empty-allowed: [] must round-trip, not be dropped/undefined');
  });

  it('A3.2(a): drain_queue carries extras.drainQueue\'s {entries, overdue_ids} shape verbatim', () => {
    const artifact = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);
    assert.deepEqual(artifact.drain_queue, A3_EXTRAS_FIXTURE.drainQueue);
  });

  it('drops every pre-A3 flat key — no runId/notes/expired/drain/sections leak into the artifact', () => {
    const artifact = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);
    assert.equal('runId' in artifact, false, 'camelCase runId must be dropped in favor of run_id');
    assert.equal('notes' in artifact, false, 'flat notes must be dropped in favor of operator_notes');
    assert.equal('expired' in artifact, false, 'flat expired must be dropped in favor of expired_notes');
    assert.equal('drain' in artifact, false, 'flat drain must be dropped in favor of drain_queue');
    assert.equal('sections' in artifact, false, 'the raw sections object must never be persisted verbatim');
  });

  it('an extra/leftover key on `sections` (e.g. a transitional pre-A3 `findings` array) is NOT smuggled through', () => {
    const artifact = buildRoadmapArtifact({ ...A3_SECTIONS_FIXTURE, findings: { open: [{ finding_id: 'F-1' }] } }, A3_EXTRAS_FIXTURE);
    assert.equal('findings' in artifact, false,
      'buildRoadmapArtifact whitelists named schema keys — an unexpected extra key on sections must never reach the artifact');
  });
});

describe('A3.5 — swarm roadmap show: residuals surface, seam-independent (not-yet-compiled path)', () => {
  it('surfaces allowlist_overdue / unroutable_approved / deferred_stale even with nothing compiled yet', () => {
    const dbDir = makeTmpDir('a3-show-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('a3-show-repo-');
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });

    const RUN_ID = 'roadmap-a3-show-r1';
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(RUN_ID, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'health-audit-a');
    db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, ?, ?, ?, ?)`)
      .run(RUN_ID, 'domain-a', JSON.stringify(['packages/a/**']), 'owned', 1);

    // Allowlist-overdue fixture: a REAL-shaped entry, revalidate_by in the past.
    writeFileSync(join(repoDir, 'scripts', 'regression-pin-allowlist.json'), JSON.stringify({
      allow: { 'F-OLD-0001': { reason: 'legacy', file: 'packages/a/src/x.js', owner: 'coordinator', revalidate_by: '2020-01-01' } },
    }, null, 2));

    // Unroutable-approved fixture: approved, file-less, no filed_by_domain.
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, recommendation, status, filed_by_domain)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'approved', NULL)
    `).run(RUN_ID, 'F-UNROUTABLE-0001', 'fp-unroutable-1', 'HIGH', 'quality', 'unroutable finding', 'fix it');

    // Deferred-stale fixture: needs several waves so waves_behind exceeds the default threshold (3).
    const insWave = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES (?, ?, ?, ?, ?)`);
    const wave1 = Number(insWave.run(RUN_ID, 'health-audit-a', 1, 'collected', 'snap1').lastInsertRowid);
    for (let i = 2; i <= 6; i++) insWave.run(RUN_ID, 'health-audit-a', i, 'collected', 'snap1');
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, recommendation, status, last_seen_wave)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deferred', ?)
    `).run(RUN_ID, 'F-STALE-0001', 'fp-stale-1', 'LOW', 'quality', 'packages/a/src/stale.js', 'gone stale', 'fix it', wave1);

    closeDb(dbPath);

    const report = showRoadmap({ runId: RUN_ID, dbPath });
    assert.equal(report.compiled, false, 'nothing was compiled in this fixture');

    assert.equal(report.allowlist_overdue.available, true);
    assert.equal(report.allowlist_overdue.overdue.length, 1);
    assert.equal(report.allowlist_overdue.overdue[0].finding_id, 'F-OLD-0001');

    assert.equal(report.unroutable_approved.count, 1);
    assert.equal(report.unroutable_approved.findings[0].finding_id, 'F-UNROUTABLE-0001');

    assert.equal(report.deferred_stale.stale.length, 1);
    assert.equal(report.deferred_stale.stale[0].finding_id, 'F-STALE-0001');
    assert.ok(report.deferred_stale.stale[0].waves_behind > 3, 'must be past the default stale-wave threshold');

    // Text rendering: "NOT persisted" must be unmissable, and the not-yet-
    // compiled banner must still lead the output (residuals are advisory
    // ADDITIONS, not a replacement for the compile prompt).
    const text = formatRoadmapShow(report);
    assert.match(text, /No roadmap compiled yet/);
    assert.match(text, /Allowlist overdue \(advisory, NOT persisted/);
    assert.match(text, /F-OLD-0001/);
    assert.match(text, /Unroutable approved findings \(advisory, NOT persisted/);
    assert.match(text, /F-UNROUTABLE-0001/);
    assert.match(text, /Deferred findings gone stale \(advisory, NOT persisted/);
    assert.match(text, /F-STALE-0001/);
  });

  it('residuals are all EMPTY-but-present for a run with none of the three conditions (never silently omitted as keys)', () => {
    const dbDir = makeTmpDir('a3-show-empty-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('a3-show-empty-repo-');
    mkdirSync(repoDir, { recursive: true });

    const RUN_ID = 'roadmap-a3-show-empty-r1';
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(RUN_ID, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'health-audit-a');
    closeDb(dbPath);

    const report = showRoadmap({ runId: RUN_ID, dbPath });
    assert.equal(report.allowlist_overdue.available, false, 'no scripts/regression-pin-allowlist.json in this fixture');
    assert.deepEqual(report.allowlist_overdue.overdue, []);
    assert.equal(report.unroutable_approved.count, 0);
    assert.deepEqual(report.deferred_stale.stale, []);

    const text = formatRoadmapShow(report);
    assert.doesNotMatch(text, /Allowlist overdue/, 'an unavailable/empty residual must not render a section header');
    assert.doesNotMatch(text, /Unroutable approved/);
    assert.doesNotMatch(text, /gone stale/);
  });
});

describe('A3.5 — swarm roadmap show: residuals compose with an already-compiled (A3-shaped) artifact', () => {
  it('merges residuals alongside a fabricated A3-shaped artifact without either clobbering the other', () => {
    const dbDir = makeTmpDir('a3-show-compiled-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('a3-show-compiled-repo-');
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });

    const RUN_ID = 'roadmap-a3-compiled-r1';
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(RUN_ID, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'health-audit-a');

    writeFileSync(join(repoDir, 'scripts', 'regression-pin-allowlist.json'), JSON.stringify({
      allow: { 'F-OLD-0002': { reason: 'legacy', file: 'x.js', owner: 'coordinator', revalidate_by: '2020-01-01' } },
    }, null, 2));

    // Fabricate an A3-shaped persisted artifact DIRECTLY (bypassing the
    // compile.js seam entirely) — buildRoadmapArtifact's own field mapping
    // proves the SHAPE this produces in production; this test proves
    // showRoadmap's merge behaves correctly once such a shape exists on
    // disk, regardless of how it got there.
    const fabricated = buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE);
    const body = { ...fabricated, sequence: 1 };
    const relPath = `dogfood/roadmap/${RUN_ID}.1.json`;
    writeFileSync(join(repoDir, relPath), JSON.stringify(body, null, 2));
    writeFileSync(join(repoDir, 'dogfood', 'roadmap', `${RUN_ID}.json`), JSON.stringify(body, null, 2));
    recordRoadmapArtifact(db, { runId: RUN_ID, path: relPath, contentHash: 'deadbeef' });
    closeDb(dbPath);

    const report = showRoadmap({ runId: RUN_ID, dbPath });
    assert.equal(report.compiled, true);
    // The artifact's own A3 fields survive the merge...
    assert.equal(report.run_id, A3_SECTIONS_FIXTURE.run_id);
    assert.equal(report.compiled_at, A3_SECTIONS_FIXTURE.run_anchored_at);
    assert.deepEqual(report.drain_queue, A3_EXTRAS_FIXTURE.drainQueue);
    // ...alongside the LIVE-computed residuals (never persisted, but present
    // in the SHOW report merged on top).
    assert.equal(report.allowlist_overdue.overdue.length, 1);
    assert.equal(report.allowlist_overdue.overdue[0].finding_id, 'F-OLD-0002');

    const text = formatRoadmapShow(report);
    assert.match(text, /Roadmap — run roadmap-a3-r1/);
    assert.match(text, /Drain queue \(advisory/);
    assert.match(text, /F-1.*OVERDUE/);
    assert.match(text, /Allowlist overdue \(advisory, NOT persisted/);
  });
});

describe('formatRoadmapCompile — renders the A3 field names', () => {
  it('reads run_id/operator_notes/expired_notes/attention.items/drain_queue, not the old flat shape', () => {
    const fakeCompileReport = {
      ...buildRoadmapArtifact(A3_SECTIONS_FIXTURE, A3_EXTRAS_FIXTURE),
      sequence: 3,
      path: '/abs/dogfood/roadmap/roadmap-a3-r1.3.json',
      latestPath: '/abs/dogfood/roadmap/latest.json',
      content_hash: 'abc123',
    };
    const text = formatRoadmapCompile(fakeCompileReport);
    assert.match(text, /Roadmap compiled — run roadmap-a3-r1 \(sequence 3\)/);
    assert.match(text, /keep it simple/, 'active operator note must render');
    assert.match(text, /stale note/, 'expired note must render under EXPIRED');
    assert.match(text, /packages\/a\/src\/foo\.js/, 'attention.items must render (not the old flattened shape)');
    assert.match(text, /F-1.*OVERDUE/, 'drain_queue entries must render');
  });
});
