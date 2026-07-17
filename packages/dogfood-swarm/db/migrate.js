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
 * Does `sql` contain exactly one statement? Splits on `;` and requires
 * exactly one non-empty segment after trimming — a trailing terminator
 * (`"...);"`) collapses to a single segment; two real statements joined by
 * `;` (`"CREATE TABLE foo (...); CREATE INDEX idx_foo ON foo(x);"`) does not.
 *
 * F-318bdd79: parseArtifact()'s three regexes are all anchored at `^` but
 * never checked there was only ONE statement to anchor against — a
 * two-statement entry (e.g. a table plus its own index, joined by `;`
 * instead of authored as two separate manifest entries, the way every other
 * table/index pair in this manifest already is) matched only the FIRST
 * statement and was silently treated as a single recognized artifact. On a
 * FRESH db this was harmless (migrateDb's `db.exec(mig.sql)` below runs every
 * statement in the string regardless of what parseArtifact saw). The gap is
 * the RETROACTIVE-BOOTSTRAP path: artifactExists() below checks only the
 * FIRST parsed artifact, so a legacy DB with the table but genuinely missing
 * the index would have the WHOLE migration wrongly marked already-applied —
 * the ledger row gets seeded, migrateDb never runs the SQL, and the index is
 * never created, permanently (a ledger-recorded migration id is never
 * re-attempted).
 *
 * Naive on purpose — no string-literal-aware SQL tokenizer, so a
 * hypothetical embedded `;` inside a quoted DEFAULT value would also trip
 * this check. Over-strict-but-safe (the same posture
 * assertManifestShapesRecognized documents for "unrecognized ⇒ fail loud at
 * import time" generally): the real MIGRATIONS_MANIFEST has zero entries
 * with an embedded semicolon in a string literal today, and a false rejection
 * fails LOUD at module load, in the author's own change, long before any
 * operator sees a real DB — never a silent bypass.
 *
 * @param {string} sql
 * @returns {boolean}
 */
function isSingleStatement(sql) {
  const segments = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  return segments.length === 1;
}

/**
 * Test `s` (already trimmed) against the three recognized DDL shapes ONLY —
 * no isSingleStatement gate. Factored out of parseArtifact() (F-feea1982,
 * wave 24) so assertManifestShapesRecognized()'s diagnostic below can ask
 * "would the FIRST segment alone have matched?" independent of the
 * single-statement check, to distinguish a genuinely unrecognized shape from
 * a recognized one that isSingleStatement merely split on an embedded `;`.
 *
 * @param {string} s
 * @returns {{kind:'column'|'index'|'table', table?:string, name:string}|null}
 */
function matchArtifactShape(s) {
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
 * Parse the artifact a migration SQL statement creates, so we can detect
 * whether a pre-existing DB already has it (the retroactive-bootstrap signal).
 *
 * Handles the three statement shapes present in MIGRATIONS_SQL:
 *   - `ALTER TABLE <t> ADD COLUMN <col> ...`           → { kind:'column', table, name }
 *   - `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <idx> ...` → { kind:'index', name }
 *   - `CREATE TABLE [IF NOT EXISTS] <t> ...`            → { kind:'table', name }
 *
 * Returns null if the shape is unrecognized, OR (F-318bdd79) if `sql` is not
 * exactly one statement — a multi-statement entry is unrecognized-BY-POLICY
 * even when its first statement alone would match one of the three shapes,
 * because artifactExists() below has no way to confirm every statement's
 * artifact exists, only the first's. F-a4ced329: a null here used to be
 * silently read by artifactExists() as "not detectable as pre-applied, fall
 * through to running it" — an assumption (the SQL is unconditionally
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
  if (!isSingleStatement(s)) return null;
  return matchArtifactShape(s);
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
 * F-feea1982 (LOW, wave 24): the thrown message below reads exactly like
 * "your statement TYPE is unsupported" (it names the three recognized DDL
 * shapes and nothing else), which is the wrong diagnosis for one specific
 * false-rejection: a genuinely single, RECOGNIZED-shape statement whose SQL
 * happens to contain a `;` inside a string literal (e.g.
 * `ALTER TABLE foo ADD COLUMN note TEXT DEFAULT 'a;b'`) — isSingleStatement's
 * naive `.split(';')` (this file has no string-literal-aware tokenizer, by
 * documented design) splits that into two segments and parseArtifact()
 * refuses it the identical way it refuses a genuinely unrecognized shape or a
 * genuine two-statement entry, but the generic message never mentions
 * semicolons, string literals, or the single-statement precondition at all —
 * a future author hitting this at import time has no pointer from the thrown
 * message itself to the real mechanism (only this doc comment states it).
 * Distinguish the two causes: when the FIRST `;`-delimited segment alone
 * already matches one of the three shapes, the entry is either a genuine
 * multi-statement manifest entry OR a single statement with an embedded `;`
 * inside a string/comment/DEFAULT value — this naive splitter cannot tell
 * which, so the message below names BOTH possibilities and the remediation
 * for each, rather than the generic "unsupported shape" text (still used,
 * unchanged, for a SQL shape that genuinely matches none of the three
 * regexes at all — see the two GATE tests in
 * lib/migrate-unrecognized-shape-fails-loud.test.js for the case split).
 *
 * @param {Array<{id:string, sql:string}>} manifest
 */
export function assertManifestShapesRecognized(manifest) {
  for (const m of manifest) {
    if (parseArtifact(m.sql) === null) {
      const segments = m.sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
      const firstSegmentRecognized = segments.length > 1 && matchArtifactShape(segments[0]) !== null;

      if (firstSegmentRecognized) {
        throw new Error(
          `db/migrate: migration '${m.id}' splits into ${segments.length} statements after naively ` +
          `splitting its SQL on ';', and the FIRST segment alone already matches a recognized shape ` +
          `(ALTER TABLE ... ADD COLUMN, CREATE [UNIQUE] INDEX, CREATE TABLE) — this naive splitter has no ` +
          `string-literal-aware tokenizer, so it cannot tell apart two different causes: (a) a genuine ` +
          `multi-statement entry (e.g. a table plus its own index joined by ';' instead of two separate ` +
          `manifest entries, as every other table/index pair in this manifest is authored) — split it into ` +
          `${segments.length} manifest entries; or (b) one real, single statement with a ';' inside a ` +
          `string literal, comment, or DEFAULT value. If (b), rephrase the statement to avoid the embedded ` +
          `';' (e.g. move the value out of the DEFAULT clause) so isSingleStatement() sees exactly one segment.`
        );
      }

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
