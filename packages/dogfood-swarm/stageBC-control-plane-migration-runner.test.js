/**
 * stageBC-control-plane-migration-runner.test.js
 *
 * Wave 2 Agent B+C — Part C: ordered/versioned control-plane migration-runner
 * (F4-CP-04).
 *
 * Pre-fix: db/connection.js looped over a FLAT MIGRATIONS_SQL array
 * (db/schema.js), re-applying all 14 idempotent ADD-COLUMN / CREATE-IF-NOT-
 * EXISTS statements WHOLESALE on every openDb and swallowing "duplicate
 * column" errors. There was a single KV schema_version row but NO ordered,
 * per-version, recorded migration ledger — so the control plane had no record
 * of which migrations had run, only an aggregate version number.
 *
 * The fix introduces:
 *   - a migrations_ledger table (migration_id PK, target_version, applied_at,
 *     status) in the SCHEMA_SQL,
 *   - an ordered MIGRATIONS_MANIFEST ([{ id, target_version, sql }]) mirroring
 *     each existing flat migration, tagged with the SCHEMA_VERSION it belongs
 *     to (exact SQL preserved for back-compat),
 *   - migrateDb(db, currentVersion, { check }) in db/migrate.js, mirroring the
 *     proven apply-finding-migration.mjs pattern: transaction-wrapped per
 *     migration, --check dry-run, idempotent, atomic, ledger-recorded.
 *
 * Load-bearing back-compat: an EXISTING v6 DB has all columns but an
 * empty/absent ledger. First run against it must DETECT already-applied
 * migrations (via PRAGMA table_info / index_list — the column/index each
 * migration adds already exists) and SEED the ledger as status:'applied'
 * WITHOUT re-running. A fresh DB runs them in order.
 *
 * Test invariants (RED→GREEN):
 *   1. migrations_ledger exists in a freshly created DB.
 *   2. Fresh DB → every manifest entry recorded in the ledger as 'applied',
 *      and the columns/indexes those migrations add are present.
 *   3. Pre-existing v6 DB with NO ledger → retroactive bootstrap: every
 *      already-applied migration seeded into the ledger, ZERO re-runs, no
 *      duplicate-column error, columns still present.
 *   4. --check dry-run reports the plan but mutates NOTHING (no ledger rows,
 *      no version bump on a fresh-but-unmigrated handle).
 *   5. KV schema_version is bumped to SCHEMA_VERSION at the end of a real run.
 *   6. Re-running migrateDb is a no-op (idempotent — ledger already full).
 *
 * Temp DB paths / in-memory only — NEVER the real swarms/control-plane.db.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS_SQL, MIGRATIONS_MANIFEST } from './db/schema.js';
import { migrateDb } from './db/migrate.js';
import { openDb, closeDb, openMemoryDb } from './db/connection.js';

function ledgerRows(db) {
  return db.prepare('SELECT migration_id, target_version, status FROM migrations_ledger ORDER BY migration_id').all();
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe('F4-CP-04 — ordered/versioned control-plane migration-runner', () => {
  describe('manifest shape', () => {
    it('MIGRATIONS_MANIFEST mirrors every flat MIGRATIONS_SQL entry, in order, with stable ids + target_version', () => {
      assert.ok(Array.isArray(MIGRATIONS_MANIFEST), 'MIGRATIONS_MANIFEST must be exported as an array');
      assert.equal(MIGRATIONS_MANIFEST.length, MIGRATIONS_SQL.length,
        'one manifest entry per existing flat migration (back-compat 1:1)');
      const ids = new Set();
      MIGRATIONS_MANIFEST.forEach((m, i) => {
        assert.ok(m.id && typeof m.id === 'string', `entry ${i} needs a string id`);
        assert.ok(!ids.has(m.id), `entry ${i} id '${m.id}' must be unique`);
        ids.add(m.id);
        assert.equal(typeof m.target_version, 'number', `entry ${i} needs a numeric target_version`);
        assert.ok(m.target_version >= 1 && m.target_version <= SCHEMA_VERSION,
          `entry ${i} target_version ${m.target_version} must be within 1..${SCHEMA_VERSION}`);
        // Exact SQL preserved from the flat array (back-compat).
        assert.equal(m.sql, MIGRATIONS_SQL[i], `entry ${i} must preserve the exact flat SQL`);
      });
    });
  });

  describe('fresh DB', () => {
    let tmpDir;
    let dbPath;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cp-migrate-fresh-'));
      dbPath = join(tmpDir, 'control-plane.db');
    });

    afterEach(() => {
      closeDb(dbPath);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('a freshly created DB has the migrations_ledger table', () => {
      const db = openDb(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      assert.ok(tables.includes('migrations_ledger'), 'migrations_ledger must exist after openDb');
      closeDb(dbPath);
    });

    it('runs every manifest migration in order on a bare DB and records each in the ledger', () => {
      // Build a bare DB WITHOUT the convenience openMemoryDb (which already
      // applies SCHEMA_SQL + migrations). We want to exercise migrateDb from
      // the create path: SCHEMA_SQL only, then migrate.
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);

      const plan = migrateDb(db, 0);

      const rows = ledgerRows(db);
      assert.equal(rows.length, MIGRATIONS_MANIFEST.length,
        'every manifest migration must be recorded in the ledger');
      for (const r of rows) {
        assert.equal(r.status, 'applied', `${r.migration_id} must be status=applied`);
      }
      // The plan reports them as applied (not skipped) on a fresh DB.
      assert.equal(plan.applied.length + plan.bootstrapped.length, MIGRATIONS_MANIFEST.length);
      // A representative column each migration adds is present.
      assert.ok(tableColumns(db, 'agent_runs').includes('worktree_path'));
      assert.ok(tableColumns(db, 'findings').includes('cross_ref'));
      assert.ok(tableColumns(db, 'waves').includes('serial_verify_required'));
      db.close();
    });

    it('bumps the KV schema_version to SCHEMA_VERSION after a real run', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      migrateDb(db, 0);
      const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
      assert.equal(row.value, String(SCHEMA_VERSION));
      db.close();
    });

    it('is idempotent — a second migrateDb run records nothing new and does not throw', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      migrateDb(db, 0);
      const before = ledgerRows(db).length;
      const plan2 = migrateDb(db, SCHEMA_VERSION);
      assert.equal(ledgerRows(db).length, before, 'no new ledger rows on a re-run');
      assert.equal(plan2.applied.length, 0, 'nothing re-applied on an already-migrated DB');
      db.close();
    });
  });

  describe('pre-existing v6 DB with NO ledger (retroactive bootstrap)', () => {
    it('seeds the ledger for already-applied migrations WITHOUT re-running them and without error', () => {
      // Simulate a current-shape DB written by an OLDER build that had no
      // ledger concept: apply SCHEMA_SQL + the flat migrations directly, set
      // schema_version=SCHEMA_VERSION, then DROP the ledger so it is absent.
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      // Apply the flat migrations the old way (tolerating duplicate column).
      for (const sql of MIGRATIONS_SQL) {
        try { db.exec(sql); } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }
      db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      // Remove the ledger to mimic a DB that predates it.
      db.exec('DROP TABLE IF EXISTS migrations_ledger');
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations_ledger'").get(),
        undefined,
        'precondition: ledger must be absent for the bootstrap path',
      );

      // First run against this legacy DB.
      const plan = migrateDb(db, SCHEMA_VERSION);

      // The ledger now exists and is fully seeded.
      const rows = ledgerRows(db);
      assert.equal(rows.length, MIGRATIONS_MANIFEST.length,
        'retroactive bootstrap must seed every already-applied migration');
      for (const r of rows) {
        assert.equal(r.status, 'applied', `${r.migration_id} must be seeded as applied`);
      }
      // Crucially: bootstrapped, NOT re-applied.
      assert.equal(plan.applied.length, 0,
        'nothing should be RE-RUN against a current-shape DB');
      assert.equal(plan.bootstrapped.length, MIGRATIONS_MANIFEST.length,
        'every migration should be detected-as-applied and bootstrapped');
      // Columns are still present (nothing was dropped / corrupted).
      assert.ok(tableColumns(db, 'agent_runs').includes('worktree_path'));
      assert.ok(tableColumns(db, 'findings').includes('verified_via_evidence'));
      db.close();
    });

    it('a SECOND run after bootstrap is a pure no-op', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      for (const sql of MIGRATIONS_SQL) {
        try { db.exec(sql); } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }
      db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      db.exec('DROP TABLE IF EXISTS migrations_ledger');
      migrateDb(db, SCHEMA_VERSION); // bootstrap
      const plan2 = migrateDb(db, SCHEMA_VERSION);
      assert.equal(plan2.applied.length, 0);
      assert.equal(plan2.bootstrapped.length, 0, 'nothing left to bootstrap on the 2nd run');
      db.close();
    });
  });

  describe('--check dry-run', () => {
    it('reports the plan without mutating: no ledger rows, no version bump', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);

      const plan = migrateDb(db, 0, { check: true });

      // The plan enumerates what WOULD run.
      assert.ok(plan.applied.length > 0 || plan.bootstrapped.length > 0,
        'check mode must still report a non-empty plan on a bare DB');
      // But nothing was written.
      const rows = ledgerRows(db);
      assert.equal(rows.length, 0, 'check mode must NOT write ledger rows');
      const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
      // Bare DB after SCHEMA_SQL only: schema_version may be unset; if present
      // it must NOT have been bumped to SCHEMA_VERSION by a check run.
      if (row) {
        assert.notEqual(row.value, String(SCHEMA_VERSION),
          'check mode must NOT bump schema_version');
      }
      db.close();
    });
  });

  describe('openMemoryDb / openDb continue to produce a fully-migrated DB', () => {
    it('openMemoryDb has all migrated columns + a full ledger', () => {
      const db = openMemoryDb();
      assert.ok(tableColumns(db, 'agent_runs').includes('worktree_branch'));
      const rows = ledgerRows(db);
      assert.equal(rows.length, MIGRATIONS_MANIFEST.length,
        'openMemoryDb must route through migrateDb and fully seed the ledger');
      db.close();
    });
  });
});
