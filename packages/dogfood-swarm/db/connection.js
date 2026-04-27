/**
 * connection.js — SQLite connection manager for the swarm control plane.
 *
 * Uses better-sqlite3 for synchronous, reliable access.
 * DB file lives at: <swarm-dir>/control-plane.db
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS_SQL } from './schema.js';

/** @type {Map<string, Database.Database>} */
const pool = new Map();

/**
 * Default busy-wait window for SQLite writers. Two parallel `swarm`
 * invocations against the same control-plane.db will hit SQLITE_BUSY on
 * writer-vs-writer contention; without a busy_timeout the second writer
 * fails loudly instead of waiting briefly. 5s is generous for the small
 * transactions the swarm runs (most under 50ms) without masking real
 * deadlocks.
 *
 * Parallel-invocation contract:
 *   - Multiple `swarm status` / read-only readers: safe (WAL).
 *   - One writer + N readers: safe (WAL).
 *   - Two concurrent writers (e.g. `swarm collect` while another process
 *     runs `swarm advance`): each writer briefly waits up to BUSY_TIMEOUT_MS
 *     for the other to release its transaction. If you regularly contend
 *     for >5s, raise this value rather than serialise externally.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Open (or reuse) a control-plane database at the given path.
 * Creates the file + schema if it doesn't exist.
 *
 * Cached handles are sentinel-checked on reuse — if the underlying file was
 * removed/replaced/restored from backup mid-process, the cached handle is
 * dropped and a fresh one is opened. This avoids the POSIX-stale-inode and
 * Windows-opaque-failure cases where a long-lived handle keeps pointing at
 * the old file.
 *
 * @param {string} dbPath — absolute path to the .db file
 * @returns {Database.Database}
 */
export function openDb(dbPath) {
  const cached = pool.get(dbPath);
  if (cached) {
    try {
      cached.prepare('SELECT 1').get();
      return cached;
    } catch {
      // Handle is dead (DB file removed/replaced underneath us). Drop and
      // re-open below. close() may itself throw on a dead handle — tolerate.
      try { cached.close(); } catch { /* */ }
      pool.delete(dbPath);
    }
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // WAL for better concurrent read perf
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Give concurrent writers a brief grace window instead of failing loudly
  // on the first SQLITE_BUSY. See BUSY_TIMEOUT_MS doc above.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  // Apply schema idempotently
  const version = getSchemaVersion(db);
  if (version < 1) {
    db.exec(SCHEMA_SQL);
    applyMigrations(db); // safe: catches duplicate columns
    setSchemaVersion(db, SCHEMA_VERSION);
  } else if (version < SCHEMA_VERSION) {
    // Apply new tables from SCHEMA_SQL (CREATE IF NOT EXISTS is safe)
    db.exec(SCHEMA_SQL);
    // Apply ALTER TABLE migrations (catch duplicates)
    applyMigrations(db);
    setSchemaVersion(db, SCHEMA_VERSION);
  }

  pool.set(dbPath, db);
  return db;
}

export { BUSY_TIMEOUT_MS };

/**
 * Close a specific DB (or all if no path).
 */
export function closeDb(dbPath) {
  if (dbPath) {
    const db = pool.get(dbPath);
    if (db) { db.close(); pool.delete(dbPath); }
  } else {
    for (const [p, db] of pool) { db.close(); pool.delete(p); }
  }
}

/**
 * Get an in-memory DB for testing.
 */
export function openMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  setSchemaVersion(db, SCHEMA_VERSION);
  return db;
}

/**
 * Apply ALTER TABLE migrations. Catches "duplicate column" errors.
 */
function applyMigrations(db) {
  for (const sql of MIGRATIONS_SQL) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
}

// --- Internal helpers ---

function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0; // kv table doesn't exist yet
  }
}

function setSchemaVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(String(version));
}
