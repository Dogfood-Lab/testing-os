/**
 * stageBC-control-plane-schema-too-new.test.js
 *
 * Wave 2 Agent B+C — Part B: typed CONTROL_PLANE_SCHEMA_TOO_NEW (F4-CP-03 + F5-07).
 *
 * Pre-fix: db/connection.js threw a BARE `new Error(...)` in the
 * `version > SCHEMA_VERSION` branch — no `.code`, no `.hint`. error-render.js
 * flattened it to the untyped `ERROR: <msg>` line instead of the
 * `ERROR [<CODE>]:` structured envelope the rest of the error family gets, so
 * an operator on a stale checkout hitting a newer-than-build control-plane.db
 * lost the actionable "pull the latest build" hint that every sibling code
 * carries. error-codes.md already DOCUMENTED CONTROL_PLANE_SCHEMA_TOO_NEW but
 * flagged it as "plain Error (no .code field yet)" with a Follow-ups note.
 *
 * The fix adds ControlPlaneSchemaTooNewError (code:
 * 'CONTROL_PLANE_SCHEMA_TOO_NEW') in lib/errors.js, throws it from
 * connection.js, and adds the deriveHintForCode case in error-render.js.
 *
 * Test invariants (RED→GREEN):
 *   1. Opening a DB whose on-disk schema_version > the build SCHEMA_VERSION
 *      throws an error with `.code === 'CONTROL_PLANE_SCHEMA_TOO_NEW'`
 *      (NOT a bare untyped Error), carrying the on-disk + build versions and
 *      a `.hint`. The handle is closed + dropped (fail-closed; no mutation).
 *   2. renderTopLevelError renders it as `ERROR [CONTROL_PLANE_SCHEMA_TOO_NEW]:`
 *      with a `Next:` hint line (the structured envelope), NOT the flat
 *      `ERROR: <msg>` untyped shape.
 *   3. error-render's per-code hint fallback fires when the error carries no
 *      own `.hint` (a bare object literal with the code).
 *
 * Temp DB paths only (mkdtemp) — NEVER the real swarms/control-plane.db.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ControlPlaneSchemaTooNewError } from './lib/errors.js';
import { renderTopLevelError } from './lib/error-render.js';

describe('F4-CP-03/F5-07 — typed CONTROL_PLANE_SCHEMA_TOO_NEW', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cp-too-new-'));
    dbPath = join(tmpDir, 'control-plane.db');
    // Create a normal current-version DB, then forge its schema_version to a
    // value the build does NOT understand (build SCHEMA_VERSION + 1).
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION + 1));
    closeDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opening a too-new DB throws a TYPED error with code CONTROL_PLANE_SCHEMA_TOO_NEW (not a bare Error)', () => {
    let threw = null;
    try {
      openDb(dbPath);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'openDb must refuse a too-new DB');
    assert.equal(threw.code, 'CONTROL_PLANE_SCHEMA_TOO_NEW',
      'the refusal must be the typed code, not a bare untyped Error');
    assert.ok(threw instanceof ControlPlaneSchemaTooNewError,
      'must be an instance of the dedicated typed class');
    // Carries both versions for log correlation + a build-fix hint.
    assert.equal(threw.onDiskVersion, SCHEMA_VERSION + 1);
    assert.equal(threw.buildVersion, SCHEMA_VERSION);
    assert.ok(threw.hint && /pull the latest/i.test(threw.hint),
      'must carry an actionable build-upgrade hint');
    // Message still names the path + both versions (doc'd message shape).
    assert.match(threw.message, new RegExp(`v${SCHEMA_VERSION + 1}`));
    assert.match(threw.message, new RegExp(`v${SCHEMA_VERSION}`));
  });

  it('the refused DB handle is dropped from the pool (fail-closed, re-open re-throws)', () => {
    assert.throws(() => openDb(dbPath), /CONTROL_PLANE_SCHEMA_TOO_NEW|schema v/);
    // Second open must ALSO throw (handle was not cached as usable).
    assert.throws(() => openDb(dbPath), /CONTROL_PLANE_SCHEMA_TOO_NEW|schema v/);
  });

  it('renderTopLevelError renders the structured ERROR [CONTROL_PLANE_SCHEMA_TOO_NEW]: envelope', () => {
    const lines = [];
    const orig = console.error;
    console.error = (m) => lines.push(String(m));
    try {
      const err = new ControlPlaneSchemaTooNewError(
        'control-plane.db at /tmp/x is schema v99 but this build only understands v6.',
        { onDiskVersion: 99, buildVersion: 6 },
      );
      renderTopLevelError(err);
    } finally {
      console.error = orig;
    }
    const out = lines.join('\n');
    assert.match(out, /ERROR \[CONTROL_PLANE_SCHEMA_TOO_NEW\]:/,
      'must use the structured envelope, NOT the flat untyped ERROR: shape');
    assert.match(out, /Next:/, 'must surface an actionable Next: hint line');
  });

  it('error-render derives a per-code hint when the error carries no own .hint', () => {
    const lines = [];
    const orig = console.error;
    console.error = (m) => lines.push(String(m));
    try {
      // Bare object literal carrying only the code — exercises the
      // deriveHintForCode fallback path.
      renderTopLevelError({ code: 'CONTROL_PLANE_SCHEMA_TOO_NEW', message: 'too new' });
    } finally {
      console.error = orig;
    }
    const out = lines.join('\n');
    assert.match(out, /ERROR \[CONTROL_PLANE_SCHEMA_TOO_NEW\]: too new/);
    assert.match(out, /Next:.*pull the latest/i,
      'deriveHintForCode must provide the build-upgrade hint for this code');
  });
});
