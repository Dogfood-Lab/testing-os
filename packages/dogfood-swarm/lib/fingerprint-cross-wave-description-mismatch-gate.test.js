/**
 * fingerprint-cross-wave-description-mismatch-gate.test.js — F-f0c537bf:
 * this class's 4th pass (fp-002 -> F-a8c0cf04 -> F-20bde286 -> F-f0c537bf;
 * see git log). F-20bde286's shouldSaltCrossWaveCollision (fingerprint.js)
 * widened the cross-wave case-collision safety net to every prior status,
 * but gated the widening on the incoming severity being STRICTLY HIGHER
 * than the prior's — closing the case where a HIGHER-severity distinct bug
 * hides behind a lower-severity open row and defeats
 * lib/advance.js#checkFindingSeverity's numeric gate. It left the
 * EQUAL-or-LOWER-severity boundary open: a genuinely DIFFERENT bug — not a
 * re-audit of the same defect, a materially different description — that
 * coincidentally shares the coarse fingerprint key via the same case-fold
 * mechanism F-c63da27b/F-a8c0cf04 established, and happens to be reported
 * at the SAME (or a lower) severity tier as the open/deferred prior, still
 * silently merged into the prior's row exactly as before wave-10, discarding
 * the new finding's description/recommendation with no separate finding_id.
 * Not HIGH: this does NOT defeat checkFindingSeverity's numeric gate (the
 * companion maxSeverity fix in upsertFindings still bumps the surviving
 * row's severity to max(prior, incoming) on every ordinary recurrence), it
 * only hides that a SECOND, distinct bug exists under the first one's row.
 *
 * THE FIX (see fingerprint.js's shouldSaltCrossWaveCollision for the full
 * case-by-case header): for the equal-or-lower-severity case (status in
 * {new, recurring, unverified, deferred}), the discriminator now ALSO
 * compares the incoming finding's description against the prior row's,
 * using the SAME normalizeDescription()-based exact-match chooseBareKeeper
 * already uses to pick a same-wave collision's rightful keeper. A
 * description that does NOT match (post-normalization) is now treated as
 * proof this is a coincidental collision between two unrelated bugs and is
 * salted (kept as its own row); a MATCHING description is still treated as
 * the same bug re-audited under different path casing and collapses exactly
 * as before this fix. 'fixed' remains completely unconditional — no
 * severity OR description check, unchanged since F-a8c0cf04.
 *
 * ENUMERATION. This file's job is to pin the load-bearing cells of
 * severity {lower, equal, higher} x file-identity {same, case-variant} x
 * prior-status {new, recurring, unverified, deferred, rejected, fixed} that
 * F-f0c537bf's fix touches or must not regress:
 *
 *   - equal/lower severity, case-variant file, DIFFERENT description,
 *     status in {new, recurring, unverified}: kept distinct (NEW behavior;
 *     first describe block below, parametrized).
 *   - equal/lower severity, case-variant file, DIFFERENT description,
 *     status = deferred: kept distinct, NOT absorbed into
 *     recurred_while_closed (NEW behavior; second describe block).
 *   - case-variant file, SAME description, status = new: still collapses
 *     (fills a gap in fingerprint-cross-wave-open-prior-severity-gate.
 *     test.js, whose "equal-or-lower still collapses" block covers
 *     recurring/unverified/deferred but never 'new').
 *   - SAME raw file spelling (no case difference at all), DIFFERENT
 *     description: still collapses via the ordinary path — proves
 *     shouldSaltCrossWaveCollision's rawFileIdentityDiffers precondition,
 *     and therefore the description check gated behind it, never fires when
 *     there is no spelling mismatch to begin with.
 *   - status = fixed, case-variant file, SAME description: still salts
 *     UNCONDITIONALLY — proves the new description check is scoped to the
 *     {new,recurring,unverified,deferred} branch and never rescues a
 *     raw-mismatch against closed material.
 *   - status = rejected (constructed directly, bypassing buildPriorMap's
 *     real-flow exclusion): left un-special-cased, falls through unsalted
 *     even at higher severity + a wholly different description — matches
 *     fingerprint.js's own documented residual for a future change to that
 *     exclusion.
 *   - description differing only by case/whitespace: still collapses — the
 *     comparison is normalizeDescription-based, not raw string equality.
 *
 * higher-severity-always-salts and same-description-always-collapses (the
 * ORIGINAL F-20bde286 cells) are already pinned by
 * fingerprint-cross-wave-open-prior-severity-gate.test.js and are not
 * re-proven here except where this file fills a genuine gap (status=new).
 *
 * PROOF METHOD. Mirrors the sibling wave-10/wave-8/wave-9 fingerprint test
 * files: direct execution against the real, unmodified classifyFindings /
 * buildPriorMap / upsertFindings via openMemoryDb (in-memory, no repo
 * writes). shouldSaltCrossWaveCollision itself is module-private by design
 * and is exercised only through this public surface, except for the
 * 'rejected' cell, which constructs a priorFingerprints Map by hand (a
 * documented, deliberate use of classifyFindings' pure-function contract —
 * see that test's own comment) since buildPriorMap can never produce one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings } from './fingerprint.js';

/** Mirrors fingerprint-cross-wave-open-prior-severity-gate.test.js's setupRun. */
function setupRun(db, opts = {}) {
  const runId = opts.runId || 'r1';
  const phase = opts.phase || 'health-audit-a';
  const waveNumber = opts.waveNumber || 1;

  if (!opts.reuseRun) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['packages/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
  }

  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, 'collected')"
  ).run(runId, phase, waveNumber);

  return { runId, waveId: Number(wave.lastInsertRowid) };
}

describe('cross-wave case collision vs an OPEN prior — EQUAL/LOWER severity but a genuinely DIFFERENT description is now kept distinct (F-f0c537bf)', () => {
  for (const status of ['new', 'recurring', 'unverified']) {
    for (const severityDir of ['equal', 'lower']) {
      it(`status='${status}', incoming severity ${severityDir === 'equal' ? 'EQUAL to' : 'LOWER than'} the prior: a genuinely different description is inserted as NEW, not merged`, () => {
        const db = openMemoryDb();
        const { runId, waveId: wave1Id } = setupRun(db, { runId: `dm-${status}-${severityDir}`, waveNumber: 1 });

        const oldFp = computeFingerprint({
          category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
          file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
        });
        const priorSeverity = 'HIGH';
        db.prepare(`
          INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
          VALUES (?, 'F-old', ?, ?, 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'a null-check gap', ?, ?, ?)
        `).run(runId, oldFp, priorSeverity, status, wave1Id, wave1Id);

        const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
        const priorMap = buildPriorMap(db, runId);

        // HIGH ranks equal to HIGH; MEDIUM ranks strictly lower (less severe)
        // than HIGH — both fall through the severity check into the NEW
        // description check this fix adds.
        const incomingSeverity = severityDir === 'equal' ? 'HIGH' : 'MEDIUM';
        const newFinding = {
          category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
          file: 'packages/dogfood-swarm/lib/legacy/domains.js', // the REAL, correctly-cased path
          severity: incomingSeverity, description: 'an unbounded recursive call with no depth guard',
        };
        assert.equal(computeFingerprint(newFinding), oldFp,
          'fixture sanity: differently-cased path spellings must still fold to the same base fingerprint');

        const classified = classifyFindings([newFinding], priorMap);
        assert.equal(classified.new.length, 1,
          `a genuinely different description at ${severityDir} severity must classify as NEW, not merged into the ${status} row`);
        assert.equal(classified.recurring.length, 0);
        assert.equal(classified.recurred_while_closed.length, 0);

        const stats = upsertFindings(db, runId, wave2Id, classified);
        assert.equal(stats.inserted, 1, 'the new finding must actually be inserted as its own row');

        const all = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId);
        assert.equal(all.length, 2, 'both the old row AND the new row must exist — nothing swallowed');

        const oldRow = all.find((f) => f.finding_id === 'F-old');
        assert.equal(oldRow.severity, priorSeverity, "the old row's severity must not be touched by the unrelated collision");
        assert.equal(oldRow.description, 'a null-check gap', "the old row's description must not be touched by the unrelated collision");

        const newRow = all.find((f) => f.finding_id !== 'F-old');
        assert.equal(newRow.severity, incomingSeverity, "the new finding's real severity must survive, not be discarded");
        assert.equal(newRow.description, 'an unbounded recursive call with no depth guard');
        assert.equal(newRow.status, 'new');
        db.close();
      });
    }
  }
});

describe('cross-wave case collision vs a DEFERRED prior — EQUAL/LOWER severity but a genuinely DIFFERENT description is now kept distinct, not silently absorbed under the deferred banner (F-f0c537bf)', () => {
  for (const severityDir of ['equal', 'lower']) {
    it(`incoming severity ${severityDir === 'equal' ? 'EQUAL to' : 'LOWER than'} the deferred prior: a genuinely different description is inserted as NEW`, () => {
      const db = openMemoryDb();
      const { runId, waveId: wave1Id } = setupRun(db, { runId: `dm-deferred-${severityDir}`, waveNumber: 1 });

      const oldFp = computeFingerprint({
        category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
        file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
      });
      db.prepare(`
        INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
        VALUES (?, 'F-old', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'a specific, already-understood, accepted-risk defect', 'deferred', ?, ?)
      `).run(runId, oldFp, wave1Id, wave1Id);

      const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
      const priorMap = buildPriorMap(db, runId);

      const incomingSeverity = severityDir === 'equal' ? 'HIGH' : 'LOW';
      const newFinding = {
        category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
        file: 'packages/dogfood-swarm/lib/legacy/domains.js',
        severity: incomingSeverity, description: 'an unauthenticated write to a shared resource',
      };
      assert.equal(computeFingerprint(newFinding), oldFp, 'fixture sanity: same base-fp collapse');

      const classified = classifyFindings([newFinding], priorMap);
      assert.equal(classified.new.length, 1,
        "the unrelated defect must classify as NEW, not absorbed into the deferred row's recurred_while_closed bucket");
      assert.equal(classified.recurred_while_closed.length, 0);
      assert.equal(classified.recurring.length, 0);

      const stats = upsertFindings(db, runId, wave2Id, classified);
      assert.equal(stats.inserted, 1);
      assert.equal(stats.preserved, 0, 'nothing should route through the recurred_while_closed preserve path');

      const all = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId);
      assert.equal(all.length, 2);
      const oldRow = all.find((f) => f.finding_id === 'F-old');
      assert.equal(oldRow.status, 'deferred', "the coordinator's deferred decision on the ORIGINAL bug must be untouched");
      assert.equal(oldRow.severity, 'HIGH');
      assert.equal(oldRow.description, 'a specific, already-understood, accepted-risk defect');

      const newRow = all.find((f) => f.finding_id !== 'F-old');
      assert.equal(newRow.severity, incomingSeverity);
      assert.equal(newRow.status, 'new', 'the new, never-seen defect must surface on its own — not hidden behind the deferred banner');
      db.close();
    });
  }
});

describe('cross-wave case collision vs an OPEN prior — SAME description still collapses (F-f0c537bf does not regress F-20bde286/F-c63da27b)', () => {
  it("status='new': a re-audit re-casing the SAME live bug at an EQUAL severity still collapses to recurring (fills the status=new gap left by fingerprint-cross-wave-open-prior-severity-gate.test.js)", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'dm-new-collapse', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R2', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/Foo.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-open', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Foo.js', 10, 'doThing', 'still-open defect', 'new', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R2', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/foo.js', // different case, SAME real bug
      severity: 'HIGH', description: 'still-open defect',
    };
    assert.equal(computeFingerprint(rediscovered), fp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurring.length, 1, "status='new' with a MATCHING description must still collapse to recurring");
    assert.equal(classified.new.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.updated, 1);
    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    assert.equal(all.length, 1, 'must still be ONE row');
    assert.equal(all[0].status, 'recurring');
    db.close();
  });

  it('a description that differs only by case/whitespace (post-normalization equal) still collapses — the match is normalizeDescription-based, not raw string equality', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'dm-normalized-match', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R9', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/Norm.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-norm', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Norm.js', 10, 'doThing', 'still-open   defect', 'recurring', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R9', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/norm.js',
      severity: 'HIGH', description: 'Still-Open Defect', // same words, different case + whitespace run
    };
    assert.equal(computeFingerprint(rediscovered), fp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurring.length, 1,
      "a description differing only by case/whitespace must still collapse — the discriminator normalizes before comparing, mirroring chooseBareKeeper's own normalizeDescription() use");
    assert.equal(classified.new.length, 0);
    db.close();
  });

  it('a SAME-spelling recurrence (no case difference at all) still collapses even with a materially different description — shouldSaltCrossWaveCollision never runs when raw identity matches', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'dm-same-spelling', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R6', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/exact.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-exact', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/exact.js', 10, 'doThing', 'the original description', 'new', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R6', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/exact.js', // IDENTICAL raw spelling, not a case variant
      severity: 'HIGH', description: 'a completely different sentence describing something else entirely',
    };
    assert.equal(computeFingerprint(rediscovered), fp,
      'fixture sanity: identical inputs (including raw file spelling) always compute the identical fingerprint');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurring.length, 1,
      'an EXACT raw-spelling match must collapse via the ordinary path regardless of description content — the description-mismatch discriminator only ever runs inside the raw-mismatch branch');
    assert.equal(classified.new.length, 0);
    db.close();
  });
});

describe("'fixed' status is NOT rescued by a matching description (F-f0c537bf does not weaken F-a8c0cf04's unconditional salt)", () => {
  it("a raw-mismatch against a 'fixed' prior salts even when the description ALSO matches verbatim — 'fixed' stays unconditional, immune to the new description check too", () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'dm-fixed-same-desc', waveNumber: 1 });

    const oldFp = computeFingerprint({
      category: 'bug', rule_id: 'R7', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-old', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'came back the same way', 'fixed', ?, ?)
    `).run(runId, oldFp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const newFinding = {
      category: 'bug', rule_id: 'R7', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/legacy/domains.js',
      severity: 'HIGH', description: 'came back the same way', // matches the fixed row's description verbatim
    };
    assert.equal(computeFingerprint(newFinding), oldFp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([newFinding], priorMap);
    assert.equal(classified.new.length, 1,
      "'fixed' + raw-mismatch must salt UNCONDITIONALLY even when the description also happens to match — the description check is scoped to the {new,recurring,unverified,deferred} branch and is never reached for 'fixed'");
    assert.equal(classified.recurring.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.inserted, 1);
    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    assert.equal(all.length, 2);
    const oldRow = all.find((f) => f.finding_id === 'F-old');
    assert.equal(oldRow.status, 'fixed', 'the fixed row must not be reopened/altered by the unrelated (if verbatim-matching) new finding');
    db.close();
  });
});

describe("'rejected' priors stay protected — left un-special-cased, never salted (F-f0c537bf does not regress the documented residual)", () => {
  it("a hypothetical 'rejected' prior (constructed directly — buildPriorMap excludes it from the real db-backed flow) is NOT salted even at higher severity and a wholly different description, and still routes to recurred_while_closed", () => {
    // buildPriorMap excludes 'rejected' rows in the real db-backed flow (see
    // fingerprint-recurred-while-closed-last-seen.test.js's own comment on
    // the SEPARATE F-6a8a98d6 insert-conflict path 'rejected' actually
    // takes), so shouldSaltCrossWaveCollision never observes status=
    // 'rejected' via buildPriorMap. classifyFindings is a pure function of
    // whatever Map it is handed, though, so this constructs one directly to
    // pin fingerprint.js's own documented fallback for a future change to
    // that exclusion: 'rejected' is left un-special-cased rather than
    // silently folded into the open-status branch, so it falls through
    // shouldSaltCrossWaveCollision's final `return false` — unsalted,
    // regardless of severity or description.
    const oldFp = computeFingerprint({
      category: 'bug', rule_id: 'R8', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
    });
    const priorRow = {
      id: 99, status: 'rejected', severity: 'HIGH', category: 'bug', rule_id: 'R8',
      file_path: 'packages/dogfood-swarm/lib/Legacy/Domains.js', symbol: 'doThing',
      description: 'not a real bug',
    };
    const priorMap = new Map([[oldFp, priorRow]]);

    const newFinding = {
      category: 'bug', rule_id: 'R8', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/legacy/domains.js', // case-variant, raw differs
      severity: 'CRITICAL', description: 'a wholly unrelated, more severe new defect',
    };
    assert.equal(computeFingerprint(newFinding), oldFp, 'fixture sanity: same base-fp collapse');

    const classified = classifyFindings([newFinding], priorMap);
    assert.equal(classified.new.length, 0,
      "a 'rejected' priorRow must never be salted — it falls through shouldSaltCrossWaveCollision's final `return false`, even at higher severity with a wholly different description");
    assert.equal(classified.recurred_while_closed.length, 1,
      'unsalted means the SAME fingerprint still matches the rejected prior, which classifyFindings routes to recurred_while_closed');
    assert.equal(classified.recurred_while_closed[0].priorStatus, 'rejected');
    assert.equal(classified.recurring.length, 0);
  });
});
