/**
 * migrate-current-version-unused.test.js — F-1de6e6ca: migrateDb's
 * `currentVersion` parameter has NO effect on behavior.
 *
 * `db/migrate.js`'s JSDoc documented `currentVersion` as a meaningful input
 * ("schema_version read from the DB (0 = fresh)"), but the parameter is
 * never read anywhere in the function body — the fresh-vs-upgrade decision
 * is made entirely per-migration via the migrations_ledger table plus
 * artifactExists() (PRAGMA table_info / sqlite_master introspection),
 * independent of whatever value is passed for `currentVersion`.
 *
 * This is NOT a correctness bug — the ledger+introspection mechanism is
 * self-sufficient and arguably more robust than trusting a possibly-stale
 * version number — but the signature and docstring imply a load-bearing
 * input that has zero effect on behavior, which is exactly the kind of
 * thing that misleads a future debugger. This file proves the claim
 * empirically (not just by grep) across BOTH scenarios the module's own
 * header documents: a FRESH db (SCHEMA_SQL just applied, no ledger yet) and
 * a RETROACTIVE BOOTSTRAP (artifacts already exist, ledger empty) — for
 * both, the resulting plan and DB state are byte-identical regardless of
 * what `currentVersion` value is passed.
 *
 * WHY THE PARAMETER WAS KEPT, NOT REMOVED (see migrateDb's JSDoc in
 * db/migrate.js for the full reasoning): removing it would have silently
 * broken stageBC-control-plane-migration-runner.test.js (package root, a
 * different domain, ~15 call sites at the OLD 3-arg shape including one
 * `{ check: true }` dry-run whose opts object would have silently shifted
 * out of position). This file documents and proves the SAME fact the
 * finding raised, without the signature change that would have broken a
 * test this agent cannot repair.
 *
 * WHY THIS FILE, NOT db/*.test.js. db/migrate.js and db/connection.js ARE
 * this domain's owned glob (packages/dogfood-swarm/db/**\), but
 * package.json's test script is `node --test "*.test.js" "lib/*.test.js"`
 * — there is no `"db/*.test.js"` glob, so a test placed under db/ would be
 * silently undiscovered (confirmed: zero db/*.test.js files exist anywhere
 * in this package today). This file lives flat in lib/ instead — inside
 * the owned glob AND inside the discovery glob — and imports migrateDb via
 * a relative path, the same pattern used for git-touched-files.test.js and
 * fingerprint-recurred-while-closed-last-seen.test.js elsewhere in this wave.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL, SCHEMA_VERSION } from '../db/schema.js';
import { migrateDb } from '../db/migrate.js';

/** A fresh in-memory DB with SCHEMA_SQL applied but migrateDb never yet run. */
function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function ledgerRows(db) {
  return db.prepare('SELECT migration_id, target_version, status FROM migrations_ledger ORDER BY migration_id').all();
}

function schemaVersionKv(db) {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
  return row ? row.value : null;
}

describe('migrateDb — currentVersion has no effect on the resulting plan or DB state (F-1de6e6ca)', () => {
  it('a FRESH db produces an identical plan regardless of currentVersion (0, a stale number, SCHEMA_VERSION, undefined)', () => {
    const probeValues = [0, 3, SCHEMA_VERSION, 999, undefined];
    const plans = probeValues.map((v) => {
      const db = freshDb();
      const plan = migrateDb(db, v);
      db.close();
      return plan;
    });

    const baseline = JSON.stringify(plans[0]);
    for (let i = 1; i < plans.length; i++) {
      assert.equal(
        JSON.stringify(plans[i]), baseline,
        `currentVersion=${JSON.stringify(probeValues[i])} produced a different plan than currentVersion=${JSON.stringify(probeValues[0])} — ` +
          'the parameter is documented as meaningful but must have zero effect on a fresh db',
      );
    }
  });

  it('a FRESH db reaches identical migrations_ledger + kv.schema_version state regardless of currentVersion', () => {
    const probeValues = [0, 5, SCHEMA_VERSION];
    const states = probeValues.map((v) => {
      const db = freshDb();
      migrateDb(db, v);
      const state = { ledger: ledgerRows(db), schemaVersion: schemaVersionKv(db) };
      db.close();
      return state;
    });

    const baseline = JSON.stringify(states[0]);
    for (let i = 1; i < states.length; i++) {
      assert.equal(JSON.stringify(states[i]), baseline, `DB state diverged for currentVersion=${probeValues[i]}`);
    }
    assert.equal(states[0].schemaVersion, String(SCHEMA_VERSION), 'sanity: a real run must still stamp schema_version to the build version');
  });

  it('a RETROACTIVE BOOTSTRAP (artifacts pre-exist, ledger empty) produces an identical plan regardless of currentVersion', () => {
    // Mirrors the module header's second documented path: an existing v-N db
    // whose columns/indexes already exist but whose ledger is empty/absent.
    // Simulated here by running migrateDb ONCE (real run) to create every
    // artifact, wiping the ledger back to empty, then re-running with
    // different currentVersion values — each re-run should bootstrap
    // (seed the ledger without re-executing SQL) identically regardless of
    // the probe value.
    const probeValues = [0, 4, SCHEMA_VERSION];
    const plans = probeValues.map((v) => {
      const db = freshDb();
      migrateDb(db, 0); // real run: creates every artifact + ledger row
      db.exec('DELETE FROM migrations_ledger'); // simulate a pre-ledger existing db
      const plan = migrateDb(db, v); // bootstrap path
      db.close();
      return plan;
    });

    const baseline = JSON.stringify(plans[0]);
    assert.ok(plans[0].bootstrapped.length > 0, 'sanity: this scenario must actually exercise the bootstrap branch or it proves nothing');
    for (let i = 1; i < plans.length; i++) {
      assert.equal(JSON.stringify(plans[i]), baseline, `bootstrap plan diverged for currentVersion=${probeValues[i]}`);
    }
  });

  it('check-mode (dry run) produces an identical plan regardless of currentVersion, and still mutates nothing', () => {
    const probeValues = [0, SCHEMA_VERSION];
    const plans = probeValues.map((v) => {
      const db = freshDb();
      const plan = migrateDb(db, v, { check: true });
      const ledgerAfter = ledgerRows(db);
      db.close();
      return { plan, ledgerAfter };
    });

    assert.deepEqual(plans[0].ledgerAfter, [], 'check mode must not write the ledger');
    assert.equal(
      JSON.stringify(plans[0].plan), JSON.stringify(plans[1].plan),
      'currentVersion must not affect the dry-run plan either',
    );
  });
});
