/**
 * migrate.js — ordered, versioned, ledger-recorded control-plane migrations.
 *
 * F4-CP-04. Replaces the flat "re-run all of MIGRATIONS_SQL on every openDb
 * and swallow duplicate-column errors" loop (db/connection.js#applyMigrations)
 * with an ordered runner that RECORDS what it did in the migrations_ledger
 * table, mirroring the proven scripts/apply-finding-migration.mjs pattern:
 * transaction-wrapped per migration, `--check` dry-run, atomic, idempotent.
 *
 * Two paths, both leaving the runner a no-op on a current DB:
 *
 *   1. FRESH DB — SCHEMA_SQL has just been applied (the new tables exist but
 *      no ADD-COLUMN migration has run). Each manifest migration whose
 *      artifact (column / index / table) is MISSING is run inside a
 *      transaction and recorded `status:'applied'`.
 *
 *   2. RETROACTIVE BOOTSTRAP (load-bearing back-compat) — an EXISTING v6 DB
 *      written by an older build has all the columns/indexes already but an
 *      empty/absent ledger. Each manifest migration whose artifact ALREADY
 *      EXISTS (detected via PRAGMA table_info / sqlite_master) is SEEDED into
 *      the ledger `status:'applied'` WITHOUT re-running the SQL — so the
 *      runner is a no-op on a current DB and never trips a duplicate-column
 *      error. The legacy duplicate-column tolerance in connection.js stays as
 *      a belt-and-braces safety net but the ledger makes it unnecessary.
 *
 * The migrations_ledger primary key is the manifest `id`; once a migration is
 * in the ledger it is never run or bootstrapped again (idempotent).
 *
 * @module db/migrate
 */

import { SCHEMA_VERSION, MIGRATIONS_MANIFEST } from './schema.js';

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS migrations_ledger (
    migration_id   TEXT    PRIMARY KEY,
    target_version INTEGER NOT NULL,
    applied_at     TEXT    NOT NULL,
    status         TEXT    NOT NULL
  )
`;

/**
 * Parse the artifact a migration SQL statement creates, so we can detect
 * whether a pre-existing DB already has it (the retroactive-bootstrap signal).
 *
 * Handles the three statement shapes present in MIGRATIONS_SQL:
 *   - `ALTER TABLE <t> ADD COLUMN <col> ...`           → { kind:'column', table, name }
 *   - `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <idx> ...` → { kind:'index', name }
 *   - `CREATE TABLE [IF NOT EXISTS] <t> ...`            → { kind:'table', name }
 *
 * Returns null if the shape is unrecognized — in which case we treat the
 * migration as "not detectable as pre-applied" and fall through to running it
 * (the SQL is idempotent: CREATE IF NOT EXISTS / duplicate-column tolerant).
 *
 * @param {string} sql
 * @returns {{kind:'column'|'index'|'table', table?:string, name:string}|null}
 */
function parseArtifact(sql) {
  const s = sql.trim();
  let m;
  if ((m = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(s))) {
    return { kind: 'column', table: m[1], name: m[2] };
  }
  if ((m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s))) {
    return { kind: 'index', name: m[1] };
  }
  if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s))) {
    return { kind: 'table', name: m[1] };
  }
  return null;
}

/**
 * Does the artifact this migration adds already exist in the DB?
 * Used to detect already-applied migrations on a pre-existing (legacy,
 * ledger-less) DB so we can seed the ledger WITHOUT re-running.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} sql
 * @returns {boolean}
 */
function artifactExists(db, sql) {
  const art = parseArtifact(sql);
  if (!art) return false; // unrecognized shape — let the (idempotent) SQL run
  if (art.kind === 'column') {
    try {
      const cols = db.prepare(`PRAGMA table_info(${art.table})`).all().map((c) => c.name);
      return cols.includes(art.name);
    } catch {
      return false; // table itself missing → column can't exist yet
    }
  }
  // index / table both live in sqlite_master keyed by name.
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('index','table') AND name = ?")
    .get(art.name);
  return !!row;
}

/**
 * Run the ordered control-plane migrations against `db`, recording each in the
 * migrations_ledger.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} currentVersion — schema_version read from the DB (0 = fresh)
 * @param {object} [opts]
 * @param {boolean} [opts.check=false] — dry-run: compute the plan, mutate nothing
 * @returns {{
 *   applied: Array<{id:string, target_version:number}>,
 *   bootstrapped: Array<{id:string, target_version:number}>,
 *   alreadyRecorded: Array<{id:string, target_version:number}>,
 *   check: boolean,
 *   targetVersion: number
 * }}
 */
export function migrateDb(db, currentVersion, opts = {}) {
  const { check = false } = opts;

  // Defensive: an EXISTING DB that predates the ledger won't have the table
  // yet (SCHEMA_SQL only creates it on a fresh DB). Create it before we read.
  // In check mode we still need to READ the ledger; CREATE IF NOT EXISTS is a
  // structural no-op on a DB that already has it, but to keep check mode
  // strictly non-mutating we only create when not checking and instead read
  // defensively below.
  if (!check) db.exec(LEDGER_DDL);

  const recorded = new Set();
  try {
    for (const r of db.prepare('SELECT migration_id FROM migrations_ledger').all()) {
      recorded.add(r.migration_id);
    }
  } catch {
    // Ledger table absent (check mode on a legacy DB): treat as empty.
  }

  const plan = {
    applied: [],
    bootstrapped: [],
    alreadyRecorded: [],
    check,
    targetVersion: SCHEMA_VERSION,
  };

  const insertLedger = check
    ? null
    : db.prepare(
        `INSERT OR IGNORE INTO migrations_ledger (migration_id, target_version, applied_at, status)
         VALUES (?, ?, ?, 'applied')`,
      );

  const now = new Date().toISOString();

  // Each migration runs in its own transaction (SQL + ledger write committed
  // atomically), mirroring apply-finding-migration.mjs's per-unit tx
  // discipline. A bootstrap (artifact already present) writes only the ledger
  // row; an apply runs the SQL then the ledger row.
  for (const mig of MIGRATIONS_MANIFEST) {
    if (recorded.has(mig.id)) {
      plan.alreadyRecorded.push({ id: mig.id, target_version: mig.target_version });
      continue;
    }
    const exists = artifactExists(db, mig.sql);
    if (exists) {
      // Retroactive bootstrap: the column/index/table is already here (legacy
      // DB). Seed the ledger; do NOT re-run the SQL.
      plan.bootstrapped.push({ id: mig.id, target_version: mig.target_version });
      if (!check) {
        insertLedger.run(mig.id, mig.target_version, now);
      }
    } else {
      plan.applied.push({ id: mig.id, target_version: mig.target_version });
      if (!check) {
        const tx = db.transaction(() => {
          db.exec(mig.sql);
          insertLedger.run(mig.id, mig.target_version, now);
        });
        tx();
      }
    }
  }

  // Bump the aggregate KV schema_version to match the build (real runs only).
  if (!check) {
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  return plan;
}
