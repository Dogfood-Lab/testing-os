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
 *
 * F-318bdd79 (wave 22, added to this same file): a SECOND, independent way
 * for parseArtifact()/artifactExists() to silently mis-recognize a manifest
 * entry — not an unrecognized DDL keyword this time, but a RECOGNIZED
 * keyword whose SQL string actually contains a SECOND statement after it
 * (`"CREATE TABLE foo (...); CREATE INDEX idx_foo ON foo(x);"`). parseArtifact
 * matched only the first statement and returned non-null, so
 * assertManifestShapesRecognized never caught it — a distinct gap from the
 * unrecognized-keyword case above, closed the same way (fail loud at
 * module-load import time, see the describe block near the bottom of this
 * file).
 *
 * F-feea1982 (LOW, wave 24, added to this same file): F-318bdd79's fix fails
 * loud correctly, but the message it throws for a MULTI-statement entry was
 * identical to the message for a genuinely UNRECOGNIZED DDL keyword — it
 * never named the real mechanism (naive `;`-splitting, no string-literal
 * awareness) or the false-rejection case F-318bdd79's own disclosure named
 * but never pinned: a genuinely single, RECOGNIZED-shape statement with a
 * `;` embedded inside a string literal (e.g. a `DEFAULT` value). db/migrate.js
 * now throws a DISTINCT, more actionable message whenever the first
 * `;`-delimited segment alone already matches a recognized shape — see the
 * "F-feea1982" describe block below for both the multi-statement message
 * update (this file's existing GATE test, updated in place) and the new
 * semicolon-in-string-literal proof.
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

/**
 * F-318bdd79: parseArtifact()'s three regexes anchor at `^` but never
 * checked the SQL was only ONE statement — a two-statement entry (table +
 * its own index joined by `;`) matched only the FIRST statement and was
 * silently treated as one recognized artifact. On a fresh DB this is
 * harmless (migrateDb's db.exec(mig.sql) runs every statement regardless).
 * The gap is retroactive-bootstrap: artifactExists() checked only the first
 * parsed artifact, so a legacy DB with the table but genuinely missing the
 * index would have the WHOLE migration wrongly marked already-applied — the
 * ledger seeds, the SQL never runs, and the index is never created,
 * permanently (a ledger-recorded id is never re-attempted).
 *
 * THE FIX. parseArtifact() now refuses (returns null) for any SQL that is
 * not exactly one statement (isSingleStatement(), db/migrate.js), so a
 * multi-statement entry is unrecognized-by-policy — assertManifestShapesRecognized()
 * (describe block above) refuses it at author time, the identical fail-loud
 * posture as the CREATE TRIGGER case.
 */
/** @pins F-318bdd79 */
describe('parseArtifact / assertManifestShapesRecognized — multi-statement SQL is not silently treated as one recognized artifact (F-318bdd79)', () => {
  it('sanity: the REAL MIGRATIONS_MANIFEST has zero multi-statement entries today', () => {
    const multiStatement = MIGRATIONS_MANIFEST.filter((m) => {
      const segments = m.sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
      return segments.length > 1;
    });
    assert.deepEqual(
      multiStatement.map((m) => m.id),
      [],
      'a real manifest entry now joins two DDL statements with `;` — split it into two manifest ' +
      'entries (table + index) instead, matching every other pair in this manifest',
    );
  });

  it('GATE: a two-statement manifest entry (table + its own index joined by `;`) is refused loudly, not silently recognized as one artifact', () => {
    const syntheticManifest = [{
      id: 'synthetic-multi-stmt-mig',
      target_version: 999,
      sql: 'CREATE TABLE foo (id INTEGER); CREATE INDEX idx_foo ON foo(id);',
    }];
    // F-feea1982 (wave 24): this SQL's first segment ("CREATE TABLE foo
    // (id INTEGER)") already matches a recognized shape, so db/migrate.js
    // now throws the MORE SPECIFIC multi-statement/semicolon-in-string
    // message (naming the real cause) rather than the generic "unrecognized
    // shape" text the CREATE-TRIGGER case below still gets (its first
    // segment matches none of the three shapes at all).
    assert.throws(
      () => assertManifestShapesRecognized(syntheticManifest),
      (err) => /synthetic-multi-stmt-mig/.test(err.message)
        && /splits into 2 statements/.test(err.message)
        && /string literal/i.test(err.message),
      'a multi-statement entry must fail loud at author time, naming the real cause — pre-fix, parseArtifact ' +
      'matched only the first statement (CREATE TABLE foo) and returned non-null, so this gate never saw it',
    );
  });

  it('the underlying mechanism, direct-construction proof: a two-statement SQL is never reported as an existing artifact from a partial (first-statement-only) match', () => {
    const db = freshDb();
    db.exec('CREATE TABLE foo (id INTEGER)'); // table exists; the index does NOT (simulates a legacy/out-of-band DB)
    const twoStatementSql = 'CREATE TABLE foo (id INTEGER); CREATE INDEX idx_foo ON foo(id);';

    // Post-fix: the whole entry is unrecognized (parseArtifact returns null
    // because it now checks statement count before even trying the three
    // shape regexes), so artifactExists reports false — the same
    // safe-direction fallback the CREATE TRIGGER case above uses.
    // assertManifestShapesRecognized (GATE test above) is what actually
    // prevents this shape from ever reaching migrateDb in production; this
    // test pins the mechanism directly, independent of the gate.
    assert.equal(
      artifactExists(db, twoStatementSql),
      false,
      'a multi-statement SQL string must never be reported as an existing artifact from a partial match',
    );
    assert.equal(
      db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='idx_foo'").get(),
      undefined,
      'sanity: idx_foo genuinely does not exist in this DB, confirming the false above is the safe answer, not a coincidence',
    );

    db.close();
  });

  it('non-regression: a normal single-statement entry with a trailing semicolon still parses and detects correctly', () => {
    assert.doesNotThrow(() => assertManifestShapesRecognized([
      { id: 'trailing-semi', target_version: 1, sql: 'CREATE TABLE IF NOT EXISTS synthetic_trailing (id INTEGER);' },
    ]));
    const db = freshDb();
    db.exec('CREATE TABLE synthetic_trailing (id INTEGER)');
    assert.equal(artifactExists(db, 'CREATE TABLE IF NOT EXISTS synthetic_trailing (id INTEGER);'), true);
    assert.equal(artifactExists(db, 'CREATE TABLE IF NOT EXISTS never_created (id INTEGER);'), false);
    db.close();
  });

  it('non-regression: whitespace-only segments (blank lines between statements) do not falsely count as multiple statements', () => {
    // A single statement with trailing blank lines / whitespace after the
    // terminator must still resolve to exactly one non-empty segment.
    assert.doesNotThrow(() => assertManifestShapesRecognized([
      { id: 'whitespace-tail', target_version: 1, sql: 'CREATE TABLE IF NOT EXISTS synthetic_ws (id INTEGER);   \n  \n' },
    ]));
  });
});

/**
 * F-feea1982 (LOW, wave 24): F-318bdd79's fix throws loud for a
 * multi-statement entry, but the message read identically to "your statement
 * TYPE is unsupported" (it names the three recognized shapes and nothing
 * else) whether the real cause was a genuine two-statement entry OR a
 * genuinely single, RECOGNIZED-shape statement whose SQL happens to contain
 * a `;` inside a string/DEFAULT literal — the exact false-rejection
 * F-318bdd79's own disclosure named ("a hypothetical embedded `;` inside a
 * quoted DEFAULT value would also trip this check") but never pinned with a
 * test. db/migrate.js now throws a DISTINCT message whenever the first
 * `;`-delimited segment alone already matches a recognized shape, naming
 * both candidate causes and the remediation for each.
 */
/** @pins F-feea1982 */
describe('assertManifestShapesRecognized — the thrown message names the semicolon-in-string-literal cause, not just "unsupported shape" (F-feea1982)', () => {
  it('a genuinely single ALTER TABLE statement with a `;` inside a DEFAULT string literal gets the ACTIONABLE message, not the generic "unrecognized shape" one', () => {
    // One real statement, entirely valid SQL, whose DEFAULT value happens to
    // contain a semicolon. isSingleStatement's naive splitter (no
    // string-literal awareness, by documented design) sees this as two
    // segments; the first segment alone ("ALTER TABLE foo ADD COLUMN note
    // TEXT DEFAULT 'a") already matches the ALTER TABLE shape — exactly the
    // condition the new, more specific message targets.
    const syntheticManifest = [{
      id: 'synthetic-semicolon-in-string',
      target_version: 999,
      sql: `ALTER TABLE foo ADD COLUMN note TEXT DEFAULT 'a;b'`,
    }];
    assert.throws(
      () => assertManifestShapesRecognized(syntheticManifest),
      (err) => {
        assert.match(err.message, /synthetic-semicolon-in-string/);
        assert.match(err.message, /splits into 2 statements/);
        assert.match(err.message, /string literal/i);
        assert.match(err.message, /multi-statement entry/i);
        // Must NOT read like the generic "your statement type is
        // unsupported" text — the statement type IS one of the three
        // recognized shapes; punctuation inside a string tripped the naive
        // splitter, which is a materially different diagnosis for an author
        // to act on.
        assert.doesNotMatch(err.message, /uses an SQL shape parseArtifact\(\)\/artifactExists\(\) cannot/);
        return true;
      },
      'a false-rejected single statement (semicolon inside a string literal) must get a message naming ' +
      'the real cause, not the generic unrecognized-DDL-keyword text',
    );
  });

  it('non-regression: a genuinely unrecognized shape (no segment matches any recognized DDL) still gets the generic message', () => {
    const syntheticManifest = [{
      id: 'synthetic-trigger-still-generic',
      target_version: 999,
      sql: `CREATE TRIGGER stamp_updated_at AFTER UPDATE ON runs BEGIN SELECT 1; END`,
    }];
    assert.throws(
      () => assertManifestShapesRecognized(syntheticManifest),
      (err) => /synthetic-trigger-still-generic/.test(err.message)
        && /cannot\s+recognize/i.test(err.message)
        && !/splits into \d+ statements/.test(err.message),
      'a shape matching none of the three regexes must keep the generic message — CREATE TRIGGER is not, ' +
      'itself, a recognized shape, regardless of the embedded semicolon before END',
    );
  });

  it('non-regression: the real MIGRATIONS_MANIFEST is unaffected (sanity, mirrors the describe block above)', () => {
    assert.doesNotThrow(() => assertManifestShapesRecognized(MIGRATIONS_MANIFEST));
  });
});
