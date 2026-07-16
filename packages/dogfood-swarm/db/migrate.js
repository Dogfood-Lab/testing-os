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

/**
 * PH-DS-03: fail-closed integrity gate on the migration manifest vs the build
 * SCHEMA_VERSION. The runner stamps the KV schema_version to SCHEMA_VERSION at
 * the end of every real run (migrateDb below); if a future edit appends a
 * migration with a higher target_version but forgets to bump SCHEMA_VERSION,
 * the DB would be marked at the stale build version while the manifest claims a
 * newer one — a silent skew the downstream openDb schema-too-new guard cannot
 * catch (it only protects against a DB newer than the build, never a build whose
 * own manifest out-runs its declared version). The reverse — SCHEMA_VERSION
 * bumped but no matching migration — is just as wrong (a phantom version). We
 * fail closed on BOTH directions, mirroring openDb's fail-closed posture, with
 * an error naming both numbers and the recovery action.
 *
 * Exported so the regression test can pin both branches with injected values.
 *
 * @param {Array<{target_version:number}>} manifest
 * @param {number} schemaVersion
 */
export function assertManifestVersionInvariant(manifest, schemaVersion) {
  const max = manifest.length === 0
    ? 0
    : Math.max(...manifest.map((m) => m.target_version));
  if (max !== schemaVersion) {
    throw new Error(
      `db/migrate: manifest max target_version ${max} != build SCHEMA_VERSION ${schemaVersion}. ` +
      (max > schemaVersion
        ? `bump SCHEMA_VERSION to ${max} in db/schema.js so the migration that reaches v${max} is reflected in the version the runner stamps.`
        : `a SCHEMA_VERSION of ${schemaVersion} has no migration that reaches it — add the missing migration to MIGRATIONS_MANIFEST (target_version ${schemaVersion}) or lower SCHEMA_VERSION to ${max}.`),
    );
  }
}

// Module-load fail-closed check: importing the runner against a skewed
// manifest/version pair is itself a defect — surface it the instant the module
// is loaded rather than at the first migrateDb call deep in a dispatch.
assertManifestVersionInvariant(MIGRATIONS_MANIFEST, SCHEMA_VERSION);

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
 * Returns null if the shape is unrecognized. F-a4ced329: a null here used to
 * be silently read by artifactExists() as "not detectable as pre-applied,
 * fall through to running it" — an assumption (the SQL is unconditionally
 * idempotent) that was never actually checked. assertManifestShapesRecognized()
 * below now refuses to let this module import at all if MIGRATIONS_MANIFEST
 * contains an entry parseArtifact() cannot classify, so in production this
 * function only ever returns null for SQL that has already been vetted safe
 * to fall through — see that function's doc for the failure mode it closes.
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
 * F-a4ced329: fail-closed sweep over the manifest for DDL shapes
 * parseArtifact() cannot classify — the SAME class of defect
 * assertManifestVersionInvariant (above) catches for version skew, applied to
 * shape recognizability instead.
 *
 * Why this matters: artifactExists() silently returns `false` for an
 * unrecognized shape (its own comment there calls this "let the (idempotent)
 * SQL run"), which is only actually safe when the SQL is unconditionally
 * idempotent (IF NOT EXISTS / duplicate-tolerant). A migration author who
 * ships a NON-idempotent unrecognized shape — e.g. `CREATE TRIGGER foo ...`
 * with no `IF NOT EXISTS` (SQLite supports the clause on CREATE TRIGGER, but
 * nothing forces an author to remember it — a plausible shape for a future
 * auto-timestamp migration) — would silently pass artifactExists() as "not
 * yet applied" even against a legacy DB that already has the trigger via an
 * out-of-band path. migrateDb would then run the SQL inside a transaction
 * (see below), which throws `trigger foo already exists`; because the throw
 * happens BEFORE insertLedger.run(), the migration is never recorded, so
 * EVERY subsequent openDb() against that DB file re-attempts and re-throws
 * identically — a permanent block with no operator recourse short of
 * hand-editing the ledger or the DB.
 *
 * Stop the author before the migration ships, not the operator against a
 * real legacy DB in production: this runs at MODULE LOAD (mirroring
 * assertManifestVersionInvariant immediately above), so a future manifest
 * entry with an unrecognized shape fails the instant db/migrate.js is
 * imported — long before migrateDb ever touches a real DB.
 *
 * Exported so the regression test can pin this branch with injected values,
 * the same reason assertManifestVersionInvariant is exported.
 *
 * @param {Array<{id:string, sql:string}>} manifest
 */
export function assertManifestShapesRecognized(manifest) {
  for (const m of manifest) {
    if (parseArtifact(m.sql) === null) {
      throw new Error(
        `db/migrate: migration '${m.id}' uses an SQL shape parseArtifact()/artifactExists() cannot ` +
        `recognize (recognized shapes: ALTER TABLE ... ADD COLUMN, CREATE [UNIQUE] INDEX, CREATE TABLE). ` +
        `artifactExists() would silently report "not yet applied" for this shape even on a legacy DB that ` +
        `already has the artifact, and a non-idempotent statement (no IF NOT EXISTS) would then throw ` +
        `mid-migration with the ledger row never recorded, permanently blocking openDb() for that DB file. ` +
        `Either add an IF NOT EXISTS / duplicate-tolerant guard so the SQL is unconditionally safe to re-run, ` +
        `or extend parseArtifact() in db/migrate.js to recognize this shape.`
      );
    }
  }
}

// Module-load fail-closed check (second sweep, complementing
// assertManifestVersionInvariant above): a manifest entry whose SQL shape
// artifactExists() cannot classify is caught the instant db/migrate.js is
// imported, not the first time migrateDb runs against a real legacy DB.
assertManifestShapesRecognized(MIGRATIONS_MANIFEST);

/**
 * Does the artifact this migration adds already exist in the DB?
 * Used to detect already-applied migrations on a pre-existing (legacy,
 * ledger-less) DB so we can seed the ledger WITHOUT re-running.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} sql
 * @returns {boolean}
 */
export function artifactExists(db, sql) {
  const art = parseArtifact(sql);
  // F-a4ced329: this branch is unreachable for any migration that ships in
  // MIGRATIONS_MANIFEST — assertManifestShapesRecognized() (module-load,
  // above) already refuses to let db/migrate.js import successfully if any
  // manifest entry's SQL shape parseArtifact() cannot classify. Kept as an
  // honest fallback, not a silent assumption, for a caller that ever invokes
  // artifactExists() directly with SQL that bypassed the manifest sweep.
  if (!art) return false;
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
 * @param {number} currentVersion — schema_version read from the DB (0 = fresh).
 *   F-1de6e6ca: accepted but NOT consulted below — grepping this file, the
 *   only two occurrences of the identifier are this JSDoc line and the
 *   signature itself. The fresh-vs-upgrade decision is made entirely
 *   per-migration via the migrations_ledger table plus artifactExists()
 *   (PRAGMA table_info / sqlite_master introspection), independent of
 *   whatever value is passed here — both call sites (db/connection.js
 *   openDb/openMemoryDb) would produce byte-identical results with any
 *   value swapped in for this argument. Kept in the signature rather than
 *   removed: db/connection.js is this domain, but
 *   stageBC-control-plane-migration-runner.test.js (package root, a
 *   different domain) calls this function ~15 times at the OLD
 *   `migrateDb(db, currentVersion, opts)` 3-arg shape, including one
 *   `{ check: true }` dry-run call at the third position — removing this
 *   parameter would silently shift that opts object out of position
 *   (destructuring `{check} = <a number>` does not throw; it just silently
 *   defaults `check` to `false`), turning a dry-run test into a real
 *   mutation with no error to signal it. Fixing that test file is out of
 *   this domain's owned glob, so the honest fix here is documentation, not
 *   a signature change that breaks a test this agent cannot repair.
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
