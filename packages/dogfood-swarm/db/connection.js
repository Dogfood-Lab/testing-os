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
import { migrateDb } from './migrate.js';
import { ControlPlaneSchemaTooNewError, ControlPlaneSchemaCorruptError } from '../lib/errors.js';

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

  applyConnectionPragmas(db, { inMemory: false });

  // Apply schema idempotently.
  //
  // F-9587adda: getSchemaVersion now throws ControlPlaneSchemaCorruptError
  // (fail-loud) instead of silently returning NaN for a corrupted kv.value —
  // NaN made BOTH the too-new refusal below (`version > SCHEMA_VERSION`) and
  // the bootstrap gate (`version < SCHEMA_VERSION`) false, so a corrupted
  // schema_version silently skipped both checks. Same fail-closed cleanup as
  // the too-new branch immediately below: close the handle and drop any pool
  // entry before propagating, so a caller never gets back a handle attached
  // to a DB this function refused to trust.
  let version;
  try {
    version = getSchemaVersion(db, dbPath);
  } catch (e) {
    db.close();
    pool.delete(dbPath);
    throw e;
  }
  if (version > SCHEMA_VERSION) {
    // sm-p-002: the on-disk DB was written by a NEWER build than this one.
    // Neither the create (version < 1) nor the upgrade/bootstrap path below
    // is safe, so without this refusal openDb would proceed against an
    // unknown-newer shape. The shared swarms/control-plane.db is committed
    // back to main by ingest.yml; an operator on an older checkout (or a stale
    // CI cache) can hit a DB a newer main already migrated. A newer schema may
    // rename/repurpose a column or add a NOT NULL column this writer won't
    // populate — silent data corruption. Refuse loudly (F4-CP-03: typed,
    // fail-closed), same fail-loud-not-silent discipline as the dead-handle
    // sentinel and busy_timeout above.
    db.close();
    pool.delete(dbPath);
    throw new ControlPlaneSchemaTooNewError(
      `control-plane.db at ${dbPath} is schema v${version} but this ` +
      `@dogfood-lab/dogfood-swarm build only understands v${SCHEMA_VERSION}. ` +
      `Pull the latest @dogfood-lab/dogfood-swarm before opening this DB.`,
      { onDiskVersion: version, buildVersion: SCHEMA_VERSION, dbPath }
    );
  }

  // version < 1 (fresh): SCHEMA_SQL creates all tables.
  // 1 <= version < SCHEMA_VERSION (upgrade): SCHEMA_SQL adds any new tables
  //   (CREATE IF NOT EXISTS is safe).
  // version === SCHEMA_VERSION (current, possibly pre-ledger): SCHEMA_SQL is a
  //   structural no-op; we still run migrateDb so a DB that predates the
  //   migrations_ledger gets its ledger retroactively bootstrapped.
  if (version < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
  }
  // F4-CP-04: ordered, ledger-recorded runner replaces the flat
  // applyMigrations sweep. Fresh DB → runs every manifest migration in order;
  // pre-existing DB (current or partially upgraded, ledger empty/absent) →
  // retroactively seeds the ledger for migrations whose column/index already
  // exists WITHOUT re-running, and applies only the genuinely missing ones.
  // schema_version bump is folded into migrateDb. Idempotent on a current DB.
  // F-1de6e6ca: `version` is passed for signature compatibility with every
  // other caller (see migrateDb's JSDoc) but is not actually consulted —
  // the function decides fresh-vs-upgrade per-migration via the ledger +
  // artifactExists().
  migrateDb(db, version);

  pool.set(dbPath, db);
  return db;
}

/**
 * Apply the per-connection pragmas shared by the file-backed (openDb) and
 * in-memory (openMemoryDb) connection factories.
 *
 * sm-p-004: `foreign_keys` is per-connection and SQLite defaults it OFF, so
 * setting it ON is load-bearing for the declared REFERENCES in schema.js — it
 * is the one integrity-relevant pragma BOTH factories must apply, and routing
 * both through here keeps them from drifting apart again (openDb gained the
 * WAL + busy_timeout block historically; openMemoryDb did not follow). The
 * file-only pragmas (WAL journal mode + busy_timeout) are gated on !inMemory:
 * for a `:memory:` DB there is no file and no cross-process writer contention,
 * so WAL is a no-op and a busy_timeout has nothing to wait on.
 *
 * @param {Database.Database} db
 * @param {{ inMemory: boolean }} opts
 */
function applyConnectionPragmas(db, { inMemory }) {
  // Integrity pragma — applied to EVERY connection regardless of backing.
  db.pragma('foreign_keys = ON');

  if (!inMemory) {
    // WAL for better concurrent read perf.
    db.pragma('journal_mode = WAL');
    // Give concurrent writers a brief grace window instead of failing loudly
    // on the first SQLITE_BUSY. See BUSY_TIMEOUT_MS doc above.
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
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
  applyConnectionPragmas(db, { inMemory: true });
  db.exec(SCHEMA_SQL);
  // F4-CP-04: route the in-memory factory through the same ordered,
  // ledger-recorded runner as openDb so test DBs match production shape
  // (full migrations_ledger). migrateDb also folds in the schema_version bump.
  migrateDb(db, 0);
  return db;
}

/**
 * Apply ALTER TABLE migrations. Catches "duplicate column" errors.
 *
 * F4-CP-04 retained as a belt-and-braces safety net: the ledger-aware
 * migrateDb runner is now the live path (openDb / openMemoryDb), but the flat
 * duplicate-column-tolerant sweep stays available for any legacy caller and as
 * documentation of the pre-ledger behaviour. New code should NOT call this —
 * use migrateDb (db/migrate.js), which records what it did.
 */
// eslint-disable-next-line no-unused-vars
function applyMigrations(db) {
  for (const sql of MIGRATIONS_SQL) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
}

// --- Internal helpers ---

/**
 * @param {Database.Database} db
 * @param {string} [dbPath] — for the thrown error's context only (log correlation)
 * @returns {number}
 * @throws {ControlPlaneSchemaCorruptError} F-9587adda: kv.schema_version exists
 *   but is not a finite number (hand-edited or otherwise corrupted). Fails
 *   loud rather than silently returning NaN — see that error class's doc for
 *   why NaN is worse here than in most places: it makes BOTH of openDb's
 *   version comparisons false, silently skipping the too-new refusal AND the
 *   schema-bootstrap gate at once.
 */
function getSchemaVersion(db, dbPath) {
  let row;
  try {
    row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
  } catch {
    return 0; // kv table doesn't exist yet — genuinely fresh DB, not corruption
  }
  if (!row) return 0;
  const n = Number(row.value);
  if (!Number.isFinite(n)) {
    throw new ControlPlaneSchemaCorruptError(
      `control-plane.db at ${dbPath} has a corrupted kv.schema_version value: ` +
      `${JSON.stringify(row.value)} — expected a finite number.`,
      { rawValue: row.value, dbPath },
    );
  }
  return n;
}

// F4-CP-04: the schema_version KV bump is now folded into migrateDb (db/
// migrate.js). Retained as the legacy companion to applyMigrations above for
// any out-of-band caller; the live openDb / openMemoryDb paths no longer call
// it directly.
// eslint-disable-next-line no-unused-vars
function setSchemaVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(String(version));
}
