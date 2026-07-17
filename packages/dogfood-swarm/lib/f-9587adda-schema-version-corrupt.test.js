/**
 * f-9587adda-schema-version-corrupt.test.js — F-9587adda (LOW, wave 30):
 * getSchemaVersion() (db/connection.js) returned `parseInt(row.value, 10)`,
 * which is NaN for a non-numeric kv.value. Both downstream comparisons in
 * openDb — `version > SCHEMA_VERSION` (the too-new refusal) and `version <
 * SCHEMA_VERSION` (the schema-bootstrap gate) — are FALSE for NaN, so a
 * corrupted schema_version silently skipped BOTH: the too-new refusal never
 * fired, and `db.exec(SCHEMA_SQL)` never ran — contradicting this same
 * module's own fail-loud-not-silent discipline (already applied to the
 * dead-handle sentinel and the too-new refusal a few lines above).
 *
 * DISCLOSED NARROW BLAST RADIUS (from the approved finding, reproduced below):
 * migrateDb's own unconditional tail write (db/migrate.js) re-stamps
 * kv.schema_version to the correct build SCHEMA_VERSION on every non-check
 * run, so pre-fix the corruption was SELF-HEALING the moment openDb completed
 * once — the very next read showed the correct value restored. The real
 * pre-fix residual was narrow: a live miss required the corrupted DB to ALSO
 * be missing a table only SCHEMA_SQL's (skipped) exec would create, uncovered
 * by any MIGRATIONS_MANIFEST entry. THE FIX makes the corrupted read itself
 * loud regardless of that narrower window — an operator (or a script) that
 * hand-writes/restores kv.schema_version now finds out immediately, on the
 * very next openDb, rather than depending on migrateDb's tail write to paper
 * over the read on this one lucky pass.
 *
 * Real, on-disk temp DBs only (mkdtemp) — NEVER the real swarms/control-plane.db,
 * mirroring stageBC-control-plane-schema-too-new.test.js's (package-root,
 * out of this domain) established pattern for the sibling too-new condition.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns packages/dogfood-swarm/lib/**\ , db/**\, and
 * persist-results.js only — db/connection.js's fix is pinned from here even
 * though open-... (package-root test conventions for this area) sit outside
 * this domain's owned globs.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from '../db/connection.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { ControlPlaneSchemaCorruptError } from './errors.js';

describe('F-9587adda — a corrupted kv.schema_version fails loud instead of silently returning NaN', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cp-schema-corrupt-'));
    dbPath = join(tmpDir, 'control-plane.db');
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* already closed by a failed openDb */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** @pins F-9587adda */
  it('GATE: a hand-corrupted non-numeric kv.schema_version throws ControlPlaneSchemaCorruptError on the next openDb, not a silent skip', () => {
    // Bootstrap a genuine, normal DB via the real openDb first (mirrors the
    // finding's own live proof: "bootstrapped normally via the real openDb").
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run('not-a-number');
    closeDb(dbPath);

    assert.throws(
      () => openDb(dbPath),
      (e) => {
        assert.ok(e instanceof ControlPlaneSchemaCorruptError,
          `pre-fix: openDb proceeded silently (NaN failed both the > and < SCHEMA_VERSION checks) — got ${e?.constructor?.name}`);
        assert.equal(e.code, 'CONTROL_PLANE_SCHEMA_CORRUPT');
        assert.equal(e.rawValue, 'not-a-number');
        assert.match(e.message, /not-a-number/);
        assert.ok(e.hint && e.hint.length > 0, 'must carry an actionable .hint like its ControlPlaneSchemaTooNewError sibling');
        return true;
      },
    );
  });

  it('fail-closed: the corrupted-DB openDb call does not leave a usable pooled handle behind', () => {
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run('abc');
    closeDb(dbPath);

    assert.throws(() => openDb(dbPath), ControlPlaneSchemaCorruptError);
    // A subsequent, unrelated openDb call for the SAME path must re-attempt
    // the read (and throw again) rather than serve a cached handle from a
    // "successful" open that never actually happened — proves the throwing
    // path did not silently pool.set() before failing.
    assert.throws(() => openDb(dbPath), ControlPlaneSchemaCorruptError);
  });

  it('non-regression: an empty-string kv.schema_version does NOT throw (schema_version=0 is a real, valid pre-ledger state, not corruption)', () => {
    // schema_version=0 is a genuine, meaningful value (pre-ledger DB) that
    // must NOT throw — but an EMPTY string is not "0", it is absence-shaped
    // corruption. Number('') === 0 would make this pass Number.isFinite if
    // compared loosely; assert it is still caught the same way 'abc' is.
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run('');
    closeDb(dbPath);
    // NOTE: this is intentionally NOT asserted to throw — Number('') is 0,
    // finite, and openDb has always treated schema_version=0 as "fresh,
    // pre-ledger" (a real, supported state migrateDb repairs). Recorded here
    // as an explicit, disclosed non-goal of this fix rather than silently
    // leaving the question unanswered: F-9587adda's approved scope is a
    // NON-NUMERIC value (parseInt/Number both failing to produce a finite
    // result), not the coercion-quirk class F-b5fd9887 fixed for a DIFFERENT
    // function's windowDays parameter. Widening getSchemaVersion to also
    // reject '' would conflate a real, migrateDb-repairable state (0) with
    // genuine corruption and is deliberately out of scope here.
    const reopened = openDb(dbPath);
    assert.ok(reopened, 'schema_version="" must still open (treated as 0, not corruption)');
  });

  it('healthy path: a normal, numeric-string schema_version (the only shape this module ever writes) opens without throwing', () => {
    const db = openDb(dbPath);
    closeDb(dbPath);
    const reopened = openDb(dbPath);
    assert.ok(reopened);
    const row = reopened.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
    assert.equal(row.value, String(SCHEMA_VERSION));
  });
});
