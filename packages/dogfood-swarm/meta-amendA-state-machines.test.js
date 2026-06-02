/**
 * meta-amendA-state-machines.test.js
 *
 * Wave-1 state-machines amend (sm-001..sm-004). One co-located regression test
 * per confirmed finding. Each test fails against the pre-fix code and passes
 * against the surgical fix.
 *
 *   sm-001 (HIGH)  lib/domains.js   — unfreezeDomains had no in-flight-wave
 *                                     guard, so globs could drift between
 *                                     dispatch and collect and the captured
 *                                     domain_snapshot_id was decorative.
 *   sm-002 (HIGH)  lib/domains.js   — checkOwnership tested an agent's globs in
 *                                     isolation, so two OWNED domains with
 *                                     overlapping globs both "owned" the same
 *                                     file with zero violation. Fixed at the
 *                                     freeze boundary (reject) + a runtime
 *                                     first-match-wins guard.
 *   sm-003 (MED)   lib/advance.js   — recordPromotion ran three durable writes
 *                                     unwrapped; a mid-sequence throw left an
 *                                     orphan promotion row.
 *   sm-004 (LOW)   lib/worktree.js  — getWorktreeDiff / getWorktreeChanges were
 *                                     dead exports carrying a latent HEAD~1..HEAD
 *                                     mis-attribution bug; removed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openMemoryDb } from './db/connection.js';
import {
  saveDomainDraft, freezeDomains, unfreezeDomains, aredomainsFrozen,
  checkOwnership, hasActiveWave,
} from './lib/domains.js';
import { recordPromotion, getPromotions } from './lib/advance.js';
import * as worktree from './lib/worktree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function seedRun(db, runId, domains) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, domains);
}

// ═══════════════════════════════════════════
// sm-001 — unfreeze refused while a wave is in flight
// ═══════════════════════════════════════════

describe('sm-001 — unfreezeDomains in-flight-wave guard', () => {
  let db;
  const RUN_ID = 'sm1';

  beforeEach(() => {
    db = openMemoryDb();
    seedRun(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
  });

  afterEach(() => { db.close(); });

  it('refuses to unfreeze while a wave is dispatched (drift window stays closed)', () => {
    db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'dispatched')"
    ).run(RUN_ID);

    assert.equal(hasActiveWave(db, RUN_ID), true);
    assert.throws(
      () => unfreezeDomains(db, RUN_ID, 'broaden globs mid-run'),
      /wave is in flight/i,
      'unfreeze must be refused while a wave is dispatched',
    );
    // Still frozen — the bad state was prevented, not merely reported.
    assert.equal(aredomainsFrozen(db, RUN_ID), true);
  });

  it('allows unfreeze when no wave is in flight', () => {
    // No wave at all → no drift window.
    assert.equal(hasActiveWave(db, RUN_ID), false);
    unfreezeDomains(db, RUN_ID, 'pre-dispatch domain edit');
    assert.equal(aredomainsFrozen(db, RUN_ID), false);
  });

  it('allows unfreeze once the wave has left flight (collected)', () => {
    db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(RUN_ID);
    assert.equal(hasActiveWave(db, RUN_ID), false);
    unfreezeDomains(db, RUN_ID, 'edit after collect');
    assert.equal(aredomainsFrozen(db, RUN_ID), false);
  });

  it('force escape hatch bypasses the guard (still requires a reason)', () => {
    db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'dispatched')"
    ).run(RUN_ID);
    assert.throws(() => unfreezeDomains(db, RUN_ID, '', { force: true }), /requires a reason/);
    unfreezeDomains(db, RUN_ID, 'coordinator halted the wave by hand', { force: true });
    assert.equal(aredomainsFrozen(db, RUN_ID), false);
  });
});

// ═══════════════════════════════════════════
// sm-002 — overlapping OWNED globs rejected / arbitrated
// ═══════════════════════════════════════════

describe('sm-002 — overlapping owned globs', () => {
  let db;
  const RUN_ID = 'sm2';

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('rejects freezing two owned domains whose globs overlap', () => {
    // frontend's `src/**/*.tsx` is a strict subset of backend's `src/**` — the
    // exact DEFAULT_BUCKETS overlap the finding proves end-to-end.
    seedRun(db, RUN_ID, [
      { name: 'frontend', globs: ['src/**/*.tsx'], ownership_class: 'owned' },
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    assert.throws(
      () => freezeDomains(db, RUN_ID),
      /overlapping owned domains/i,
      'freeze must reject overlapping exclusive owners',
    );
    // Naming the conflict is part of the contract (operator must know which).
    try {
      freezeDomains(db, RUN_ID);
    } catch (e) {
      assert.match(e.message, /frontend/);
      assert.match(e.message, /backend/);
    }
  });

  it('still freezes disjoint owned globs (no false positive)', () => {
    seedRun(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
      { name: 'docs', globs: ['*.md', 'docs/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID); // must not throw
    assert.equal(aredomainsFrozen(db, RUN_ID), true);
  });

  it('owned glob overlapping only a SHARED/BRIDGE domain is allowed', () => {
    // The exclusive-ownership invariant is owned-vs-owned; shared/bridge are
    // deliberate escape hatches and must not trip the freeze guard.
    seedRun(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'types', globs: ['src/types/**'], ownership_class: 'bridge' },
      { name: 'config', globs: ['*.json'], ownership_class: 'shared' },
    ]);
    freezeDomains(db, RUN_ID); // must not throw
    assert.equal(aredomainsFrozen(db, RUN_ID), true);
  });

  it('runtime checkOwnership gives a file exactly ONE owned owner (first-match-wins)', () => {
    // Defense-in-depth: even on a hand-built map that still has the overlap
    // (freeze would reject it, so we exercise the unfrozen draft directly),
    // the two owned agents must NOT both pass for the same file. Exactly one
    // resolves as owner; the other gets a violation. Pre-fix BOTH returned
    // valid.length=1 / violations.length=0.
    seedRun(db, RUN_ID, [
      { name: 'frontend', globs: ['src/**/*.tsx'], ownership_class: 'owned' },
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    const file = 'src/app/Foo.tsx';

    const fe = checkOwnership(db, RUN_ID, 'frontend', [file]);
    const be = checkOwnership(db, RUN_ID, 'backend', [file]);

    const feOwns = fe.valid.length === 1 && fe.violations.length === 0;
    const beOwns = be.valid.length === 1 && be.violations.length === 0;

    // Exactly one of the two owns it — the silent double-ownership is gone.
    assert.ok(feOwns !== beOwns,
      'exactly one owned domain may claim a file; both-pass is the sm-002 bug');
    // The non-owner is flagged, and the violation names the resolved owner.
    const loser = feOwns ? be : fe;
    assert.equal(loser.valid.length, 0);
    assert.equal(loser.violations.length, 1);
    assert.ok(['frontend', 'backend'].includes(loser.violations[0].actual_owner));
  });

  it('non-overlapping ownership is unchanged (own file valid, cross-domain file a violation)', () => {
    // Regression guard for the existing control-plane semantics.
    seedRun(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);
    const own = checkOwnership(db, RUN_ID, 'backend', ['src/server.js']);
    assert.equal(own.valid.length, 1);
    assert.equal(own.violations.length, 0);

    const cross = checkOwnership(db, RUN_ID, 'backend', ['tests/t.js']);
    assert.equal(cross.valid.length, 0);
    assert.equal(cross.violations.length, 1);
    assert.equal(cross.violations[0].actual_owner, 'tests');
  });
});

// ═══════════════════════════════════════════
// sm-003 — recordPromotion atomicity
// ═══════════════════════════════════════════

describe('sm-003 — recordPromotion is atomic', () => {
  let db;
  const RUN_ID = 'sm3';

  function seedAdvanceable(db) {
    seedRun(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(RUN_ID);
    return Number(wave.lastInsertRowid);
  }

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('a mid-sequence throw rolls back ALL three writes (no orphan promotion row)', () => {
    const waveId = seedAdvanceable(db);

    // Force the SECOND mutation (transitionWave → INSERT wave_state_events) to
    // throw by dropping its audit table. better-sqlite3's outer transaction
    // must then roll back the promotions INSERT and leave runs.status intact.
    db.prepare('DROP TABLE wave_state_events').run();

    const statusBefore = db.prepare('SELECT status FROM runs WHERE id = ?').get(RUN_ID).status;
    const waveStatusBefore = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId).status;

    let threw = null;
    try {
      recordPromotion(db, RUN_ID, waveId, 'health-audit-a', 'health-audit-b', { gates: [] });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'recordPromotion must throw when transitionWave fails');

    // (1) no orphan promotion row
    const promos = db.prepare('SELECT COUNT(*) as n FROM promotions WHERE run_id = ?').get(RUN_ID).n;
    assert.equal(promos, 0, 'promotion INSERT must roll back when the wave transition fails');

    // (2) wave status untouched
    const waveStatusAfter = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId).status;
    assert.equal(waveStatusAfter, waveStatusBefore, 'wave status must be unchanged after rollback');

    // (3) run status untouched
    const statusAfter = db.prepare('SELECT status FROM runs WHERE id = ?').get(RUN_ID).status;
    assert.equal(statusAfter, statusBefore, 'run status must be unchanged after rollback');
  });

  it('the happy path still records all three writes together', () => {
    const waveId = seedAdvanceable(db);
    const promotionId = recordPromotion(
      db, RUN_ID, waveId, 'health-audit-a', 'health-audit-b', { gates: [] }
    );

    assert.ok(promotionId > 0);
    const promos = getPromotions(db, RUN_ID);
    assert.equal(promos.length, 1);
    assert.equal(promos[0].to_phase, 'health-audit-b');

    // wave advanced + audit row written
    assert.equal(db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId).status, 'advanced');
    const evt = db.prepare(
      "SELECT to_status, reason FROM wave_state_events WHERE wave_id = ? ORDER BY id DESC LIMIT 1"
    ).get(waveId);
    assert.equal(evt.to_status, 'advanced');
    assert.match(evt.reason, new RegExp(`promotion #${promotionId}`));

    // run status moved to the next phase
    assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(RUN_ID).status, 'health-audit-b');
  });
});

// ═══════════════════════════════════════════
// sm-004 — dead worktree-diff exports removed
// ═══════════════════════════════════════════

describe('sm-004 — getWorktreeDiff / getWorktreeChanges removed', () => {
  it('the dead exports no longer exist on the module', () => {
    assert.equal(typeof worktree.getWorktreeDiff, 'undefined',
      'getWorktreeDiff was a dead export carrying a latent HEAD~1..HEAD bug — must be gone');
    assert.equal(typeof worktree.getWorktreeChanges, 'undefined',
      'getWorktreeChanges was a dead export — must be gone');
  });

  it('the live worktree surface still loads (no source references to the removed names)', () => {
    // The package still imports/loads, and the live exports remain.
    assert.equal(typeof worktree.createWorktree, 'function');
    assert.equal(typeof worktree.mergeWorktree, 'function');
    assert.equal(typeof worktree.removeWorktree, 'function');

    const src = readFileSync(join(__dirname, 'lib/worktree.js'), 'utf-8');
    assert.ok(!/HEAD~1\.\.HEAD/.test(src),
      'the latent HEAD~1..HEAD mis-attribution must be gone with the dead code');
    assert.ok(!/getWorktreeDiff|getWorktreeChanges/.test(src),
      'no lingering definitions of the removed exports');
  });
});
