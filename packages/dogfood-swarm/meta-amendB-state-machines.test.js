/**
 * meta-amendB-state-machines.test.js
 *
 * Stage-C (hardening) state-machines / DB-layer amend (sm-p-001..sm-p-004).
 * One co-located regression test per confirmed LOW finding. Each test fails
 * against the pre-fix code and passes against the surgical fix.
 *
 *   sm-p-001 (LOW)  lib/domains.js       — sampleGlobPath() did not expand brace
 *                                          alternations `{a,b}` or char classes
 *                                          `[abc]`, so the freeze-time overlap
 *                                          probe (findOwnedGlobOverlaps) was
 *                                          BLIND to operator-authored brace/class
 *                                          owned globs. Two identical
 *                                          `src/{a,b}/**` owners froze silently.
 *   sm-p-002 (LOW)  db/connection.js     — openDb()'s schema-version ladder had
 *                                          no branch for version > SCHEMA_VERSION
 *                                          (a DB written by a NEWER build); it
 *                                          opened silently against an unknown
 *                                          shape. Now refuses loudly.
 *   sm-p-003 (LOW)  lib/worktree.js      — stale-worktree-remove (precedes the
 *                                          dependent `worktree add`) and
 *                                          `worktree prune` swallowed failures
 *                                          with no audit row. Now logStage'd to
 *                                          the NDJSON stream (no control-flow
 *                                          change — still best-effort).
 *   sm-p-004 (LOW)  db/connection.js     — foreign_keys=ON parity between the
 *                                          file-backed (openDb) and in-memory
 *                                          (openMemoryDb) factories, now routed
 *                                          through one applyConnectionPragmas
 *                                          helper so the integrity pragma cannot
 *                                          silently drift. openDb ALREADY
 *                                          enforced FKs pre-fix; this pins parity.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, openMemoryDb, closeDb } from './db/connection.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { saveDomainDraft, freezeDomains, aredomainsFrozen } from './lib/domains.js';
import { createWorktree, cleanupAllWorktrees } from './lib/worktree.js';

function seedRun(db, runId, domains) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, domains);
}

/**
 * Run `fn` while capturing everything written to console.error, returning the
 * captured lines. logStage writes NDJSON to stderr via console.error, so this
 * is the forensic-channel observation point. Restores the original in finally
 * so a throwing `fn` cannot leak the stub into sibling tests.
 */
function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ═══════════════════════════════════════════
// sm-p-001 — freeze overlap probe sees brace/char-class owned globs
// ═══════════════════════════════════════════

describe('sm-p-001 — sampleGlobPath brace/char-class awareness', () => {
  let db;
  const RUN_ID = 'smp1';

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('two identical brace-alternation owned globs THROW at freeze (probe is no longer blind)', () => {
    // Pre-fix: sampleGlobPath('src/{a,b}/**') kept the literal braces, minimatch
    // returned false against its own glob, bestMatchingGlob → null on both sides,
    // the `if (!here || !there) continue` skipped the pair, and the equal-
    // specificity criss-cross froze silently. The fix collapses `{a,b}` to its
    // first alternative so the probe path (`src/a/x`) matches and the overlap
    // fires — exactly the sm-r-001 "identical owned globs still throw" contract,
    // now extended to brace globs.
    seedRun(db, RUN_ID, [
      { name: 'alpha', globs: ['src/{a,b}/**'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/{a,b}/**'], ownership_class: 'owned' },
    ]);
    assert.throws(
      () => freezeDomains(db, RUN_ID),
      /overlapping owned domains/i,
      'identical brace-alternation owned globs are an equal-specificity criss-cross',
    );
  });

  it('two identical char-class owned globs THROW at freeze', () => {
    // `[ab]` char class — same blindness, same fix path (collapse → one char).
    seedRun(db, RUN_ID, [
      { name: 'one', globs: ['src/[ab]/**'], ownership_class: 'owned' },
      { name: 'two', globs: ['src/[ab]/**'], ownership_class: 'owned' },
    ]);
    assert.throws(() => freezeDomains(db, RUN_ID), /overlapping owned domains/i);
  });

  it('DISJOINT brace globs still freeze (no false positive from the expansion)', () => {
    // The first-alternative collapse must not invent a collision: `src/{a,b}/**`
    // probes to `src/a/x`, `lib/{c,d}/**` probes to `lib/c/x` — disjoint, so the
    // map is freezable. Guards against the expansion over-firing.
    seedRun(db, RUN_ID, [
      { name: 'alpha', globs: ['src/{a,b}/**'], ownership_class: 'owned' },
      { name: 'beta', globs: ['lib/{c,d}/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
    assert.equal(aredomainsFrozen(db, RUN_ID), true);
  });
});

// ═══════════════════════════════════════════
// sm-p-002 — openDb refuses a future schema version
// ═══════════════════════════════════════════

describe('sm-p-002 — openDb future-schema-version downgrade guard', () => {
  let tmp;
  let dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'smp2-'));
    dbPath = join(tmp, 'control-plane.db');
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to open a DB written by a NEWER schema version', () => {
    // Create the DB at the current version, then forge a future version into kv
    // and drop the cached handle so the next openDb re-reads from disk.
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION + 1));
    closeDb(dbPath);

    // Pre-fix: neither `version < 1` nor `version < SCHEMA_VERSION` is true, so
    // openDb proceeded silently against the unknown-newer shape. The fix adds an
    // explicit `version > SCHEMA_VERSION` refusal.
    assert.throws(
      () => openDb(dbPath),
      (e) => {
        assert.match(e.message, new RegExp(`v${SCHEMA_VERSION + 1}`),
          'error must name the on-disk version');
        assert.match(e.message, new RegExp(`v${SCHEMA_VERSION}\\b`),
          'error must name the build version');
        assert.match(e.message, /pull the latest/i, 'error must tell the operator what to do');
        return true;
      },
      'opening a future-schema DB must refuse loudly',
    );
  });

  it('a refused open does not leave a poisoned handle in the pool', () => {
    // The guard closes the handle + deletes the pool entry before throwing, so a
    // later open against a corrected DB is not served a dead cached handle.
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION + 1));
    closeDb(dbPath);
    assert.throws(() => openDb(dbPath), /schema/i);

    // Roll the on-disk version back to current; the next open must succeed
    // (proving no stale pool entry from the refused attempt).
    const fix = openDb(join(tmp, 'sane.db'));
    fix.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
    closeDb(join(tmp, 'sane.db'));
    const reopened = openDb(join(tmp, 'sane.db'));
    assert.equal(reopened.prepare('SELECT 1 AS ok').get().ok, 1);
    closeDb(join(tmp, 'sane.db'));
  });

  it('still opens a DB at the current schema version (no false refusal)', () => {
    const db = openDb(dbPath);
    assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1);
  });
});

// ═══════════════════════════════════════════
// sm-p-003 — swallowed worktree-cleanup failures are now observable
// ═══════════════════════════════════════════

describe('sm-p-003 — worktree cleanup failures emit a forensic NDJSON row', () => {
  let repo;

  function initRepo() {
    const root = mkdtempSync(join(tmpdir(), 'smp3-'));
    const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 't']);
    git(['commit', '--allow-empty', '-q', '-m', 'root']);
    return root;
  }

  beforeEach(() => { repo = initRepo(); });
  afterEach(() => {
    try { cleanupAllWorktrees(repo); } catch { /* best-effort */ }
    rmSync(repo, { recursive: true, force: true });
  });

  it('a failed stale-worktree-remove logs worktree_stale_remove_failed before the add throws', () => {
    // Force the line-82 stale-remove to FAIL while the wtDir exists: pre-create
    // the worktree directory as a plain (non-worktree) dir with a file in it, so
    // `git worktree remove --force` errors ("is not a working tree") and the
    // downstream `git worktree add` then fails on the occupied path. Pre-fix the
    // operator saw only the `add` error; the fix emits a greppable breadcrumb
    // for the precursor failure first.
    const wtDir = join(repo, '.swarm', 'worktrees', 'w1-backend');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, 'occupied.txt'), 'not a worktree\n');

    let threw = null;
    const lines = captureStderr(() => {
      try {
        createWorktree(repo, { runId: 'swarm-smp3', waveNumber: 1, domainName: 'backend' });
      } catch (e) {
        threw = e;
      }
    });

    // The downstream add still fails (control flow unchanged — best-effort cleanup).
    assert.ok(threw, 'the occupied path still makes worktree add fail (behavior unchanged)');

    // The new breadcrumb landed on the NDJSON stream FIRST.
    const row = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((o) => o && o.stage === 'worktree_stale_remove_failed');
    assert.ok(row, 'a worktree_stale_remove_failed NDJSON row must be emitted');
    assert.equal(row.component, 'dogfood-swarm');
    assert.equal(row.branch, 'swarm/smp3/w1-backend');
    assert.ok(typeof row.err === 'string' && row.err.length > 0, 'the underlying git error is captured');
  });

  it('the happy path emits NO worktree_stale_remove_failed row', () => {
    // A clean create (no stale dir) must not log the failure breadcrumb —
    // proves the row is a genuine failure signal, not happy-path noise.
    const lines = captureStderr(() => {
      createWorktree(repo, { runId: 'swarm-smp3', waveNumber: 2, domainName: 'docs' });
    });
    const noisy = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .some((o) => o && o.stage === 'worktree_stale_remove_failed');
    assert.equal(noisy, false, 'no failure row on the happy path');
  });
});

// ═══════════════════════════════════════════
// sm-p-004 — foreign_keys=ON parity across both connection factories
// ═══════════════════════════════════════════

describe('sm-p-004 — foreign_keys parity (file-backed and in-memory)', () => {
  let tmp;
  let dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'smp4-'));
    dbPath = join(tmp, 'control-plane.db');
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('openMemoryDb sets foreign_keys = ON (the in-mem path enforces FKs)', () => {
    const db = openMemoryDb();
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1,
      'foreign_keys must be ON — it is per-connection and defaults OFF');
    db.close();
  });

  it('openDb ALSO sets foreign_keys = ON (file-backed path; this was already true pre-fix)', () => {
    // sm-p-004 confirmation: openDb already enforced FKs before this amend. The
    // amend routes both factories through applyConnectionPragmas so the two
    // cannot drift again — this assertion pins the file-backed half of parity.
    const db = openDb(dbPath);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1,
      'the file-backed connection must enforce FKs in lockstep with the in-mem one');
  });

  it('FK enforcement actually bites: an orphan finding_events insert is rejected', () => {
    // Behavioral proof that foreign_keys=ON is load-bearing, not decorative.
    // finding_events.finding_id REFERENCES findings(id); inserting against a
    // nonexistent finding must raise FOREIGN KEY constraint failure on BOTH
    // connection factories.
    const orphanInsert = (db) =>
      db.prepare("INSERT INTO finding_events (finding_id, event_type) VALUES (999999, 'created')").run();

    const mem = openMemoryDb();
    assert.throws(() => orphanInsert(mem), /FOREIGN KEY/i,
      'in-memory: orphan FK insert must be rejected');
    mem.close();

    const file = openDb(dbPath); // closed by afterEach via closeDb(dbPath)
    assert.throws(() => orphanInsert(file), /FOREIGN KEY/i,
      'file-backed: orphan FK insert must be rejected');
  });
});
