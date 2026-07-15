/**
 * fingerprint-cross-wave-case-collision.test.js — F-a8c0cf04: normalizePath's
 * unconditional case-fold (path) and computeFingerprint's symbol case-fold
 * let a genuinely NEW, unrelated finding silently overwrite and discard an
 * EARLIER, already-CLOSED (status='fixed') finding across waves whenever the
 * only difference between them is letter-casing in the file path or symbol.
 *
 * THE BUG (two independent probes from the finding, both reproduced here
 * against the real, unmutated classifyFindings/upsertFindings via
 * openMemoryDb, mirroring fingerprint-recurred-while-closed-last-seen.test.js's
 * two-wave setupRun shape):
 *   1. PATH case only — a HIGH finding at 'lib/Legacy/Domains.js', fixed by a
 *      later wave, then an unrelated CRITICAL finding at the real spelling
 *      'lib/legacy/domains.js' (same category/rule_id/symbol/line) fingerprints
 *      IDENTICALLY and was silently folded into 'recurring' against the OLD
 *      row — never inserted, never its own finding_id, severity/description
 *      permanently discarded.
 *   2. SYMBOL case only — a HIGH finding about a `Runner` CLASS, fixed later,
 *      then an unrelated CRITICAL finding about a `runner` VARIABLE at the
 *      same line in the SAME file collided the same way.
 *
 * THE FIX, two parts (see fingerprint.js's computeFingerprint and
 * disambiguateFingerprints for the load-bearing comments):
 *   (a) computeFingerprint no longer folds `finding.symbol`'s case — two
 *       identifiers differing only by case are almost always two DIFFERENT
 *       things in JS/TS (a class vs. an instance), not spelling variants of
 *       one identifier the way a file path can be. This alone gives probe 2
 *       a distinct base fingerprint with nothing left to disambiguate.
 *   (b) disambiguateFingerprints' collision-safety-net now ALSO fires across
 *       the buildPriorMap cross-wave boundary: when a SIZE-1 current-wave
 *       group's base fingerprint matches a `fixed` prior row but the RAW
 *       (pre-normalizePath) file spelling differs, the member is salted (the
 *       same treatment a same-wave non-keeper gets) instead of automatically
 *       recurring against the unrelated old row. Path case-folding ITSELF is
 *       deliberately left in place — F-c63da27b's absorption of
 *       LLM-transcription slips for the SAME real file is still wanted — the
 *       fix only changes what happens when the matched prior is CLOSED
 *       (status='fixed') and the raw spelling doesn't actually agree.
 *
 * WHY 'fixed' SPECIFICALLY, NOT ANY PRIOR. An OPEN prior (new/recurring/
 * unverified) rediscovered with different letter-casing is the case-fold's
 * INTENDED job — the same live bug, re-audited by a different pass that
 * spelled the path differently, must still collapse to `recurring`. Gating
 * the new safety-net on status==='fixed' keeps that stability case (pinned in
 * the second describe block below) working exactly as before, and only
 * intervenes where the prior is CLOSED (so it can never appear as a same-wave
 * sibling to disambiguate against) and the case-fold is therefore the SOLE
 * reason for the fp match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings } from './fingerprint.js';

/** Mirrors fingerprint-recurred-while-closed-last-seen.test.js's setupRun. */
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

describe('cross-wave fingerprint collision — a fixed prior no longer swallows an unrelated new finding (F-a8c0cf04)', () => {
  it('PATH case only: a CRITICAL at the real spelling is inserted as NEW, not folded into a fixed HIGH at a differently-cased spelling', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { waveNumber: 1 });

    const oldFp = computeFingerprint({
      category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/Legacy/Domains.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-old', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Legacy/Domains.js', 42, 'doThing', 'the old, already-resolved defect', 'fixed', ?, ?)
    `).run(runId, oldFp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const newFinding = {
      category: 'bug', rule_id: 'R1', symbol: 'doThing', line: 42,
      file: 'packages/dogfood-swarm/lib/legacy/domains.js', // the REAL, correctly-cased path
      severity: 'CRITICAL', description: 'a wholly unrelated new defect',
    };
    // Fixture sanity: the two spellings really do fold to the identical base
    // fp — this is the collision the finding proved, not a fixture that
    // never actually meets the pre-fix failure condition.
    assert.equal(computeFingerprint(newFinding), oldFp,
      'fixture sanity: differently-cased path spellings must still fold to the same base fingerprint (F-c63da27b is still in effect)');

    const classified = classifyFindings([newFinding], priorMap);
    assert.equal(classified.new.length, 1,
      'the new CRITICAL finding must classify as NEW — it is not the same defect as the fixed HIGH row');
    assert.equal(classified.recurring.length, 0,
      'must NOT silently reopen the unrelated fixed row as "recurring"');

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.inserted, 1, 'the new finding must actually be inserted as its own row');

    const all = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId);
    assert.equal(all.length, 2, 'both the old fixed row AND the new row must exist — nothing discarded');

    const oldRow = all.find(f => f.finding_id === 'F-old');
    assert.equal(oldRow.status, 'fixed', 'the unrelated old row must stay untouched');
    assert.equal(oldRow.description, 'the old, already-resolved defect');

    const newRow = all.find(f => f.finding_id !== 'F-old');
    assert.equal(newRow.severity, 'CRITICAL', 'the new finding\'s real severity must survive');
    assert.equal(newRow.description, 'a wholly unrelated new defect');
    assert.equal(newRow.status, 'new');
    db.close();
  });

  it('SYMBOL case only: a CRITICAL about a lowercase `runner` variable is inserted as NEW, not folded into a fixed HIGH about the `Runner` class', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r2', waveNumber: 1 });

    const oldFp = computeFingerprint({
      category: 'quality', rule_id: 'R2', symbol: 'Runner', line: 100,
      file: 'packages/dogfood-swarm/lib/verify/runner.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-old2', ?, 'HIGH', 'quality', 'packages/dogfood-swarm/lib/verify/runner.js', 100, 'Runner', 'the old, already-resolved Runner class defect', 'fixed', ?, ?)
    `).run(runId, oldFp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const newFinding = {
      category: 'quality', rule_id: 'R2', symbol: 'runner', line: 100,
      file: 'packages/dogfood-swarm/lib/verify/runner.js',
      severity: 'CRITICAL', description: 'a wholly unrelated new runner-variable defect',
    };
    assert.notEqual(computeFingerprint(newFinding), oldFp,
      'symbol case is no longer folded — the fix gives these two distinct base fingerprints outright, nothing left to disambiguate');

    const classified = classifyFindings([newFinding], priorMap);
    assert.equal(classified.new.length, 1);
    assert.equal(classified.recurring.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.inserted, 1);

    const all = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY id').all(runId);
    assert.equal(all.length, 2);
    const newRow = all.find(f => f.finding_id !== 'F-old2');
    assert.equal(newRow.severity, 'CRITICAL');
    assert.equal(newRow.symbol, 'runner');
    db.close();
  });
});

describe('cross-wave PATH case-fold stability is preserved for a still-open prior (F-a8c0cf04)', () => {
  it('the SAME still-open bug, re-audited with different path letter-casing, still collapses to recurring', () => {
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r3', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R3', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/Foo.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-open', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/Foo.js', 10, 'doThing', 'still-open defect', 'new', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const rediscovered = {
      category: 'bug', rule_id: 'R3', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/foo.js', // different case, SAME real bug, re-audited
      severity: 'HIGH', description: 'still-open defect',
    };
    assert.equal(computeFingerprint(rediscovered), fp, 'fixture sanity: same collapse F-c63da27b relies on');

    const classified = classifyFindings([rediscovered], priorMap);
    assert.equal(classified.recurring.length, 1,
      'an OPEN prior rediscovered under different path casing must still collapse to recurring — the safety net only fires for a CLOSED (fixed) prior');
    assert.equal(classified.new.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.updated, 1);

    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    assert.equal(all.length, 1, 'must still be ONE row — the whole point of F-c63da27b path-spelling absorption');
    assert.equal(all[0].status, 'recurring');
    db.close();
  });

  it('a FIXED prior rediscovered under the EXACT SAME path spelling is still a genuine regression (recurring), not salted', () => {
    // The safety net must fire ONLY on a raw-spelling MISMATCH. A same-spelling
    // rediscovery of a fixed finding is a real regression and must reopen via
    // the ordinary recurring path exactly as fingerprint.js's own header
    // documents ("a fixed finding recurring IS new information").
    const db = openMemoryDb();
    const { runId, waveId: wave1Id } = setupRun(db, { runId: 'r4', waveNumber: 1 });

    const fp = computeFingerprint({
      category: 'bug', rule_id: 'R4', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/bar.js',
    });
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-regress', ?, 'HIGH', 'bug', 'packages/dogfood-swarm/lib/bar.js', 10, 'doThing', 'came back', 'fixed', ?, ?)
    `).run(runId, fp, wave1Id, wave1Id);

    const { waveId: wave2Id } = setupRun(db, { runId, waveNumber: 2, reuseRun: true });
    const priorMap = buildPriorMap(db, runId);

    const regressed = {
      category: 'bug', rule_id: 'R4', symbol: 'doThing', line: 10,
      file: 'packages/dogfood-swarm/lib/bar.js', // identical spelling
      severity: 'HIGH', description: 'came back',
    };

    const classified = classifyFindings([regressed], priorMap);
    assert.equal(classified.recurring.length, 1, 'an exact-spelling regression of a fixed finding must still reopen as recurring');
    assert.equal(classified.new.length, 0);

    const stats = upsertFindings(db, runId, wave2Id, classified);
    assert.equal(stats.updated, 1);
    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(runId);
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'recurring');
    db.close();
  });
});
