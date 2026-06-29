/**
 * ph-ds-03-migration-manifest-version.test.js
 *
 * PROACTIVE-HEALTH PH-DS-03 (LOW, fail-closed integrity) —
 * the migration runner trusts that MIGRATIONS_MANIFEST and SCHEMA_VERSION
 * agree, but nothing enforced it. If a future edit appends a migration with
 * target_version 8 and forgets to bump SCHEMA_VERSION from 7, migrateDb would
 * still stamp the KV schema_version to the (stale) build SCHEMA_VERSION while
 * the highest migration declares it reached v8 — a silent version skew. The
 * downstream openDb schema-too-new guard (db/connection.js) only protects
 * against a DB NEWER than the build; it cannot catch a build whose OWN manifest
 * out-runs its declared version.
 *
 * The fix adds a fail-closed module-load assertion (mirroring openDb's
 * schema-too-new fail-closed posture): the max target_version across the
 * manifest MUST equal SCHEMA_VERSION, else throw a clear, actionable error
 * naming both numbers and the fix ("bump SCHEMA_VERSION").
 *
 * Test invariants (RED→GREEN):
 *   1. The exported assertManifestVersionInvariant throws a clear error when
 *      the manifest's max target_version != SCHEMA_VERSION (both the too-new
 *      and the too-old directions).
 *   2. The shipped MIGRATIONS_MANIFEST + SCHEMA_VERSION satisfy the invariant
 *      (the real values agree — guards against this pass shipping skewed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION, MIGRATIONS_MANIFEST } from './db/schema.js';
import { assertManifestVersionInvariant } from './db/migrate.js';

describe('PH-DS-03 — migration manifest / SCHEMA_VERSION invariant', () => {
  it('throws a clear error when max target_version EXCEEDS SCHEMA_VERSION', () => {
    const skewed = [
      { id: 'a', target_version: 1, sql: 'x' },
      { id: 'b', target_version: 9, sql: 'y' },
    ];
    assert.throws(
      () => assertManifestVersionInvariant(skewed, 7),
      (err) => {
        assert.match(err.message, /9/, 'names the offending manifest max target_version');
        assert.match(err.message, /7/, 'names the build SCHEMA_VERSION');
        assert.match(err.message, /bump SCHEMA_VERSION/i, 'gives the recovery action');
        return true;
      },
    );
  });

  it('throws a clear error when max target_version is BELOW SCHEMA_VERSION (stale manifest)', () => {
    const skewed = [
      { id: 'a', target_version: 1, sql: 'x' },
      { id: 'b', target_version: 5, sql: 'y' },
    ];
    assert.throws(
      () => assertManifestVersionInvariant(skewed, 7),
      (err) => {
        assert.match(err.message, /5/, 'names the manifest max');
        assert.match(err.message, /7/, 'names the build SCHEMA_VERSION');
        return true;
      },
    );
  });

  it('does NOT throw when the manifest max target_version equals SCHEMA_VERSION', () => {
    const ok = [
      { id: 'a', target_version: 1, sql: 'x' },
      { id: 'b', target_version: 7, sql: 'y' },
    ];
    assert.doesNotThrow(() => assertManifestVersionInvariant(ok, 7));
  });

  it('the shipped MIGRATIONS_MANIFEST agrees with SCHEMA_VERSION', () => {
    const max = Math.max(...MIGRATIONS_MANIFEST.map((m) => m.target_version));
    assert.equal(
      max,
      SCHEMA_VERSION,
      `shipped manifest max target_version (${max}) must equal SCHEMA_VERSION (${SCHEMA_VERSION})`,
    );
    // And the assertion the runner enforces at module load passes on the real values.
    assert.doesNotThrow(() => assertManifestVersionInvariant(MIGRATIONS_MANIFEST, SCHEMA_VERSION));
  });
});
