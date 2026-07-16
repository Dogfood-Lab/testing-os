/**
 * migrate-unrecognized-shape-fails-loud.test.js — F-a4ced329: db/migrate.js's
 * parseArtifact()/artifactExists() recognize exactly three DDL shapes (ALTER
 * TABLE ADD COLUMN / CREATE [UNIQUE] INDEX / CREATE TABLE); any OTHER shape
 * silently fell through to "assume safe to re-run" — artifactExists()
 * returned `false` unconditionally, with a comment asserting an invariant
 * (the SQL is always idempotent) that was never actually checked for
 * anything but those three shapes.
 *
 * PROVEN LIVE (direct construction, mirrors the finding's own proof): a
 * `CREATE TRIGGER ... AFTER UPDATE ...` migration (no `IF NOT EXISTS` — a
 * plausible shape for a future auto-timestamp migration) does not match any
 * of the three recognized regexes. Against a DB that already has the trigger
 * (simulating a legacy DB where it arrived via an out-of-band path),
 * artifactExists() reports `false` — "not yet applied" — even though it
 * demonstrably already is. Inside migrateDb's real control flow this means
 * the ELSE branch runs `db.exec(mig.sql)` inside a transaction; SQLite
 * throws "already exists" before insertLedger.run() ever records the
 * migration, so EVERY subsequent openDb() against that DB file re-attempts
 * and re-throws identically — a PERMANENT block with no operator recourse
 * short of hand-editing the ledger or the DB.
 *
 * NOT reachable today: all 18 real entries in MIGRATIONS_MANIFEST use only
 * the three recognized shapes (first test below proves this directly, not
 * just by absence of a thrown error at import time).
 *
 * THE FIX. assertManifestShapesRecognized() (db/migrate.js, mirroring the
 * existing assertManifestVersionInvariant module-load sweep immediately
 * above it) walks MIGRATIONS_MANIFEST at db/migrate.js's IMPORT time and
 * throws if any entry's SQL shape parseArtifact() cannot classify — stopping
 * a future migration author before their change ever ships, not an operator
 * discovering the gap against a real legacy DB in production. This fixes the
 * CLASS (any future unrecognized shape) rather than special-casing CREATE
 * TRIGGER as a fourth recognized shape, per this domain's repeated
 * "defensive-completeness" calibration for exactly this failure pattern.
 *
 * WHY THIS FILE, NOT db/*.test.js. db/migrate.js IS this domain's owned glob
 * (packages/dogfood-swarm/db/**\), but package.json's test script is
 * `node --test "*.test.js" "lib/*.test.js"` — there is no "db/*.test.js"
 * glob, so a test placed under db/ would be silently undiscovered. This file
 * lives flat in lib/ instead, the same reasoning as the sibling
 * lib/migrate-current-version-unused.test.js (which documents this exact
 * discovery-glob constraint in full).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL, MIGRATIONS_MANIFEST } from '../db/schema.js';
import { assertManifestShapesRecognized, artifactExists } from '../db/migrate.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/** @pins F-a4ced329 */
describe('assertManifestShapesRecognized — module-load fail-closed sweep (F-a4ced329)', () => {
  it('sanity: the REAL MIGRATIONS_MANIFEST passes today — all entries use a recognized DDL shape', () => {
    // Importing db/migrate.js at all already proves this (the module-load
    // call would have thrown otherwise) — asserted explicitly here so the
    // claim is pinned by a test, not just by the absence of an import crash.
    assert.doesNotThrow(() => assertManifestShapesRecognized(MIGRATIONS_MANIFEST));
    assert.ok(MIGRATIONS_MANIFEST.length >= 18, 'sanity: the real manifest has grown, not shrunk');
  });

  it('GATE: an unrecognized DDL shape (CREATE TRIGGER) is refused loudly, not silently accepted', () => {
    const syntheticManifest = [{
      id: 'synthetic-trigger-mig',
      target_version: 999,
      sql: `CREATE TRIGGER stamp_updated_at AFTER UPDATE ON runs BEGIN SELECT 1; END`,
    }];
    assert.throws(
      () => assertManifestShapesRecognized(syntheticManifest),
      (err) => /synthetic-trigger-mig/.test(err.message) && /cannot\s+recognize/i.test(err.message),
      'an unrecognized DDL shape must fail loud at author time (module-load), not silently fall through to artifactExists() returning false',
    );
  });

  it('the three currently-recognized shapes all pass assertManifestShapesRecognized individually', () => {
    assert.doesNotThrow(() => assertManifestShapesRecognized([
      { id: 'a', target_version: 1, sql: 'ALTER TABLE runs ADD COLUMN synthetic_col TEXT' },
      { id: 'b', target_version: 1, sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_synthetic ON runs(id)' },
      { id: 'c', target_version: 1, sql: 'CREATE TABLE IF NOT EXISTS synthetic_table (id INTEGER)' },
    ]));
  });

  it('an empty manifest trivially passes (no entries to reject)', () => {
    assert.doesNotThrow(() => assertManifestShapesRecognized([]));
  });
});

describe('artifactExists — the hazard the gate above closes (F-a4ced329 direct-construction proof)', () => {
  it('RED (the underlying mechanism, independent of the gate): an unrecognized shape reports false even when the artifact already exists, then throws on blind re-run', () => {
    const db = freshDb();
    const triggerSql = `CREATE TRIGGER stamp_updated_at AFTER UPDATE ON runs BEGIN SELECT 1; END`;
    db.exec(triggerSql); // the artifact already exists (e.g. a legacy/out-of-band DB)

    // This is exactly what let a non-idempotent migration re-run against a DB
    // that already had the artifact: artifactExists() cannot tell the
    // trigger is already there, so migrateDb's loop would treat it as "not
    // yet applied" and re-run the CREATE TRIGGER — which throws because the
    // trigger already exists (no IF NOT EXISTS on this SQL).
    // assertManifestShapesRecognized() (describe block above) now prevents
    // this SQL from ever reaching migrateDb's loop in the first place; this
    // test pins the underlying mechanism directly so the "why" stays
    // provable independent of the gate.
    assert.equal(artifactExists(db, triggerSql), false,
      'an unrecognized shape must still report false today (the fallback is honest, not the fix) — the fix is that MIGRATIONS_MANIFEST can never contain this shape undetected');
    assert.throws(() => db.exec(triggerSql), /already exists/,
      'blindly re-running a non-idempotent unrecognized-shape migration throws — proving why "assume safe to re-run" was never a safe default');

    db.close();
  });

  it('recognized shapes still correctly detect a pre-existing artifact (non-regression: the fix must not weaken the three known shapes)', () => {
    const db = freshDb();
    db.exec('ALTER TABLE runs ADD COLUMN synthetic_col TEXT');
    assert.equal(artifactExists(db, 'ALTER TABLE runs ADD COLUMN synthetic_col TEXT'), true);
    assert.equal(artifactExists(db, 'ALTER TABLE runs ADD COLUMN never_added TEXT'), false);
    db.close();
  });
});
