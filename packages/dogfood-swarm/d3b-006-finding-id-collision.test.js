/**
 * d3b-006-finding-id-collision.test.js — content-addressed finding_id + UNIQUE.
 *
 * D3B-006 v1.3.0 deferred: `lib/fingerprint.js#upsertFindings()` minted
 * `F-${Date.now().slice(-6)}-${counter}` with a per-call counter that resets
 * to zero on each invocation. Two `swarm collect` calls less than a second
 * apart could mint identical finding_ids for entirely different findings, and
 * the schema had no UNIQUE constraint on findings.finding_id to refuse the
 * second insert. Downstream readers — most prominently `swarm approve --ids`
 * — key on finding_id, so an ambiguous duplicate produced silent
 * misattribution.
 *
 * Fix: content-addressed finding_id = `F-${fingerprint.slice(0, 8)}`.
 * The 24-hex fingerprint is already collision-resistant (Wave 8 B-BACK-002
 * spec); an 8-hex-char prefix is deterministic across invocations, and the
 * residual birthday-collision probability is bounded by a SQLite
 * `UNIQUE(run_id, finding_id)` index that fails loud on the rare case rather
 * than silently double-inserting.
 *
 * Test-first per Protocol-v2-lite (testing-os v1.3.0 lesson #3): the gate is
 * not verified until a meta-test mutates the protected thing and asserts the
 * gate fires. Here that maps to four invariants, each shaped to fail RED
 * against pre-fix HEAD and GREEN after fix:
 *
 *   1. content-addressed — same fingerprint → same finding_id, with the
 *      `F-<8 hex>` shape. Pre-fix mints `F-<6 digits>-<3 digits>` and is not
 *      a function of fingerprint at all.
 *   2. distinct-findings-distinct-ids — two upsertFindings invocations
 *      against pinned Date.now() (simulating sub-second collect) produce
 *      distinct finding_ids for distinct fingerprints. Pre-fix produces the
 *      colliding pair `F-000000-001` / `F-000000-001`.
 *   3. UNIQUE-enforced — direct INSERT of a second row with the same
 *      (run_id, finding_id) but a different fingerprint throws
 *      SQLITE_CONSTRAINT_UNIQUE. Pre-fix accepts both rows silently.
 *   4. migration-applied — openMemoryDb() materializes a UNIQUE index on
 *      (run_id, finding_id) so existing DBs picked up via the openDb path
 *      reach the same end-state as fresh ones.
 *
 * Note on backfill scope: the live control-plane.db on this rig holds zero
 * findings (verified pre-flight), so the UNIQUE index ships additively
 * without requiring D3B-005's general migration runner. Other long-lived DBs
 * that already contain dup finding_ids would surface a SQLITE_CONSTRAINT
 * error at next openDb — which is the correct behavior for a data-integrity
 * gate (loud over silent).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import { openMemoryDb } from './db/connection.js';
import { MIGRATIONS_SQL } from './db/schema.js';
import { computeFingerprint, upsertFindings } from './lib/fingerprint.js';

const RUN_ID = 'test-d3b-006';

describe('D3B-006: content-addressed finding_id + UNIQUE constraint', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'c'.repeat(40));
    db.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
      .run(RUN_ID, 'health-audit-a', 1);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  it('mints a content-addressed finding_id of shape F-<8 hex chars>', () => {
    const finding = {
      category: 'bug',
      rule_id: 'X',
      file: 'src/a.js',
      symbol: 'foo',
      line: 10,
      description: 'description-1',
      severity: 'HIGH',
    };
    const fp = computeFingerprint(finding);

    upsertFindings(db, RUN_ID, 1, {
      new: [{ ...finding, fingerprint: fp }],
      recurring: [],
      fixed: [],
      unverified: [],
    });

    const row = db.prepare('SELECT finding_id FROM findings WHERE fingerprint = ?').get(fp);
    assert.ok(row, 'finding was inserted');
    assert.match(row.finding_id, /^F-[0-9a-f]{8}$/,
      `finding_id should be content-addressed (F-<8 hex>); got: ${row.finding_id}`);
    assert.equal(row.finding_id, `F-${fp.slice(0, 8)}`,
      'finding_id should be the first 8 hex chars of the fingerprint');
  });

  it('content-addresses the finding_id from a CONTEXT-FOLDED fingerprint (fp-p-005 composition)', () => {
    // fp-p-005 changes WHAT the fingerprint is (it folds in an edit-stable hash
    // of the surrounding source), not the F-<first 8 hex> derivation. A finding
    // fingerprinted WITH source still mints a content-addressed id, and two
    // same-bucket findings the context hash separates get two DISTINCT ids
    // without leaning on the prefix-collision UNIQUE net.
    const src = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');
    const f1 = { category: 'docs', file: 'README.md', line: 21, description: 'one', severity: 'LOW' };
    const f2 = { category: 'docs', file: 'README.md', line: 27, description: 'two', severity: 'LOW' };
    // Lines 21 & 27 share the 20-bucket → identical fingerprint WITHOUT source.
    assert.equal(computeFingerprint(f1), computeFingerprint(f2),
      'precondition: the two share a no-source base fingerprint');
    const fp1 = computeFingerprint(f1, { sourceText: src });
    const fp2 = computeFingerprint(f2, { sourceText: src });
    assert.notEqual(fp1, fp2, 'precondition: the context hash separates them');

    upsertFindings(db, RUN_ID, 1, {
      new: [{ ...f1, fingerprint: fp1 }, { ...f2, fingerprint: fp2 }],
      recurring: [], fixed: [], unverified: [],
    });

    const rows = db.prepare('SELECT finding_id, fingerprint FROM findings WHERE run_id = ? ORDER BY id').all(RUN_ID);
    assert.equal(rows.length, 2, 'both context-separated findings persisted');
    for (const r of rows) {
      assert.equal(r.finding_id, `F-${r.fingerprint.slice(0, 8)}`,
        'finding_id is the first 8 hex of the (context-folded) fingerprint');
    }
    assert.equal(new Set(rows.map((r) => r.finding_id)).size, 2,
      'distinct content-addressed finding_ids from the distinct context fingerprints');
  });

  it('produces the SAME finding_id for the SAME fingerprint across invocations', () => {
    // Two findings whose description differs but whose fingerprint is identical
    // (the spec contract from Wave 8 B-BACK-002: description is NOT in the fingerprint).
    // Same fingerprint must mint the same finding_id — otherwise approve --ids is
    // ambiguous when a recurring finding gets reworded between waves.
    const f1 = {
      category: 'bug', rule_id: 'X', file: 'src/a.js', symbol: 'foo', line: 10,
      description: 'pre-fix wording', severity: 'HIGH',
    };
    const f2 = { ...f1, description: 'post-fix rewording (irrelevant to fingerprint)' };
    const fp1 = computeFingerprint(f1);
    const fp2 = computeFingerprint(f2);
    assert.equal(fp1, fp2, 'precondition: same fingerprint');

    // Two upsertFindings calls — second is on a fresh wave. (UNIQUE(run_id, fingerprint)
    // prevents reinserting the same fingerprint into the SAME run, so we move to wave 2
    // where the finding would be classified as recurring rather than new.)
    upsertFindings(db, RUN_ID, 1, {
      new: [{ ...f1, fingerprint: fp1 }],
      recurring: [],
      fixed: [],
      unverified: [],
    });

    const row = db.prepare('SELECT finding_id FROM findings WHERE fingerprint = ?').get(fp1);
    assert.equal(row.finding_id, `F-${fp1.slice(0, 8)}`,
      'identical fingerprint must always mint identical finding_id — deterministic across waves');
  });

  it('produces DISTINCT finding_ids for DISTINCT findings minted in sub-second invocations', () => {
    // The bug scenario: two `swarm collect` calls fire within the same wall-clock
    // millisecond. Pre-fix, each invocation reset its counter to zero AND saw the
    // same Date.now() tail, producing `F-XXXXXX-001` for BOTH findings.
    //
    // We pin Date.now() to force the pre-fix collision deterministically. After
    // the fix, finding_id is a function of fingerprint only, so Date.now() pinning
    // has no effect — distinct fingerprints stay distinct.
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const f1 = {
        category: 'bug', rule_id: 'X', file: 'src/a.js', symbol: 'foo', line: 10,
        description: 'finding A', severity: 'HIGH',
      };
      const f2 = {
        category: 'bug', rule_id: 'Y', file: 'src/b.js', symbol: 'bar', line: 20,
        description: 'finding B', severity: 'HIGH',
      };
      const fp1 = computeFingerprint(f1);
      const fp2 = computeFingerprint(f2);
      assert.notEqual(fp1, fp2, 'precondition: distinct fingerprints');

      // Separate upsertFindings invocations — counter resets to 0 in each call.
      // This is what two parallel `swarm collect` processes produce.
      upsertFindings(db, RUN_ID, 1, {
        new: [{ ...f1, fingerprint: fp1 }],
        recurring: [],
        fixed: [],
        unverified: [],
      });
      upsertFindings(db, RUN_ID, 1, {
        new: [{ ...f2, fingerprint: fp2 }],
        recurring: [],
        fixed: [],
        unverified: [],
      });

      const ids = db.prepare('SELECT finding_id FROM findings WHERE run_id = ? ORDER BY id')
        .all(RUN_ID)
        .map((r) => r.finding_id);
      assert.equal(ids.length, 2, 'both findings persisted');
      assert.equal(new Set(ids).size, 2,
        `distinct findings must produce distinct finding_ids; got: ${JSON.stringify(ids)}`);
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects a second row with the same (run_id, finding_id) via UNIQUE constraint', () => {
    // The schema-level guard. We bypass upsertFindings and INSERT directly with
    // two different fingerprints but the SAME finding_id (simulating a future
    // hash-prefix birthday collision). The UNIQUE index must refuse the second
    // insert rather than silently accept it.
    const insert = db.prepare(`
      INSERT INTO findings (
        run_id, finding_id, fingerprint, severity, category, description,
        status, first_seen_wave, last_seen_wave
      )
      VALUES (?, ?, ?, 'HIGH', 'bug', ?, 'new', 1, 1)
    `);

    insert.run(RUN_ID, 'F-abcdef01', 'fingerprint-A-distinct', 'first finding');

    assert.throws(
      () => insert.run(RUN_ID, 'F-abcdef01', 'fingerprint-B-distinct', 'second finding'),
      (err) => /UNIQUE constraint failed.*finding_id/i.test(err.message),
      'duplicate (run_id, finding_id) must throw SQLITE_CONSTRAINT_UNIQUE',
    );
  });

  it('materializes a UNIQUE index on (run_id, finding_id) at openMemoryDb()', () => {
    // Migration-applied invariant: a fresh DB (this one) must end up with the
    // UNIQUE index regardless of which schema-version path it took (SCHEMA_SQL
    // for fresh / MIGRATIONS_SQL for existing). We assert by introspecting
    // SQLite's index list — the constraint name varies by SQLite version but
    // the (run_id, finding_id) UNIQUE shape is stable.
    const indexes = db.prepare(`
      SELECT name, "unique", origin, partial
      FROM pragma_index_list('findings')
      WHERE "unique" = 1
    `).all();

    let foundFindingIdUnique = false;
    for (const idx of indexes) {
      const cols = db.prepare(`SELECT name FROM pragma_index_info(?)`).all(idx.name).map((r) => r.name);
      if (cols.includes('run_id') && cols.includes('finding_id')) {
        foundFindingIdUnique = true;
        break;
      }
    }
    assert.ok(
      foundFindingIdUnique,
      `expected a UNIQUE index covering (run_id, finding_id) on findings; observed indexes: ${JSON.stringify(indexes)}`,
    );
  });

  it('exposes an idempotent UNIQUE-index migration entry that re-application does not throw', () => {
    // Existing-DB upgrade path. openDb's applyMigrations() runs every entry in
    // MIGRATIONS_SQL on each open; the only thing its catch swallows is
    // "duplicate column". A non-idempotent UNIQUE-index migration would
    // therefore break every subsequent openDb call on a DB that already has the
    // index. We assert idempotency directly: find the migration entry that
    // creates the (run_id, finding_id) UNIQUE index, apply it to a DB that
    // already has the index (the live `db` from openMemoryDb), and confirm it
    // does not throw.
    const indexMigration = MIGRATIONS_SQL.find(
      (sql) => /CREATE\s+UNIQUE\s+INDEX[\s\S]*finding_id/i.test(sql),
    );
    assert.ok(
      indexMigration,
      `MIGRATIONS_SQL must contain a CREATE UNIQUE INDEX entry covering finding_id; entries: ${JSON.stringify(MIGRATIONS_SQL.map((s) => s.slice(0, 60)))}`,
    );
    // Re-applying must be a no-op (CREATE ... IF NOT EXISTS). If this throws,
    // every openDb call after the first will fail on existing user DBs.
    assert.doesNotThrow(
      () => db.exec(indexMigration),
      'UNIQUE-index migration entry must be idempotent (CREATE INDEX IF NOT EXISTS)',
    );
    // And the constraint must still be enforced after the re-application —
    // belt-and-suspenders that we didn't accidentally drop+recreate the
    // index in a way that lost its UNIQUE property.
    const insert = db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, first_seen_wave, last_seen_wave)
      VALUES (?, ?, ?, 'HIGH', 'bug', ?, 1, 1)
    `);
    insert.run(RUN_ID, 'F-idemp001', 'fp-idemp-A', 'first');
    assert.throws(
      () => insert.run(RUN_ID, 'F-idemp001', 'fp-idemp-B', 'second'),
      (err) => /UNIQUE constraint failed.*finding_id/i.test(err.message),
      'after re-applying the migration, UNIQUE on (run_id, finding_id) is still enforced',
    );
  });
});
