/**
 * wave-state-machine.test.js — Phase 5A wave-state-machine coverage.
 *
 * Three concerns:
 *   1. Transition rules — every TRANSITIONS edge is reachable; every
 *      non-edge is rejected with StateMachineRejectionError; override path
 *      requires reason; the audit row lands in wave_state_events.
 *   2. Schema migration — wave_state_events table applies cleanly on a
 *      fresh DB AND on a DB pre-existing at the old SCHEMA_VERSION.
 *   3. Pattern #10 guard — a STATIC scan of the dogfood-swarm package
 *      asserts that the only file mutating waves.status via raw SQL is the
 *      approved lib/wave-state-machine.js helper itself. The test was
 *      written before the conversion; it fails today against the existing
 *      raw writers and passes after the wave lands. It STAYS in the suite
 *      permanently as an invariant — a future commit re-introducing a raw
 *      `UPDATE waves SET status = ...` outside the helper breaks the build.
 *      More durable than a one-shot pre/post comparison.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';

import { openMemoryDb } from './db/connection.js';
import {
  transitionWave,
  canTransition,
  getWaveTransitionHistory,
  TRANSITIONS,
  BLOCKED_STATUSES,
  TERMINAL_STATUSES,
  isBlocked,
  isTerminal,
} from './lib/wave-state-machine.js';
import { SCHEMA_SQL } from './db/schema.js';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function seedWave(db, status = 'dispatched') {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
  const r = db.prepare(`
    INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES ('r1', 'health-audit-a', 1, ?, 'snap1')
  `).run(status);
  return Number(r.lastInsertRowid);
}

// ──────────────────────────────────────────────────────────────
// 1. Transition rules
// ──────────────────────────────────────────────────────────────

describe('wave-state-machine — transition table shape', () => {
  it('exposes the expected source statuses', () => {
    assert.deepEqual(
      Object.keys(TRANSITIONS).sort(),
      ['advanced', 'collected', 'collecting', 'dispatched', 'failed', 'pending', 'verified'].sort()
    );
  });

  it('blocks "failed" without override', () => {
    assert.ok(BLOCKED_STATUSES.has('failed'));
    assert.ok(isBlocked('failed'));
  });

  it('marks "advanced" as terminal', () => {
    assert.ok(TERMINAL_STATUSES.has('advanced'));
    assert.ok(isTerminal('advanced'));
  });

  it('legacy "pending" + "collecting" have no outbound edges', () => {
    assert.deepEqual(TRANSITIONS.pending, []);
    assert.deepEqual(TRANSITIONS.collecting, []);
  });
});

describe('wave-state-machine — canTransition', () => {
  it('allows the canonical dispatched → collected edge', () => {
    assert.deepEqual(canTransition('dispatched', 'collected'), { allowed: true });
  });
  it('allows the canonical dispatched → failed edge', () => {
    assert.deepEqual(canTransition('dispatched', 'failed'), { allowed: true });
  });
  it('allows the canonical collected → verified edge', () => {
    assert.deepEqual(canTransition('collected', 'verified'), { allowed: true });
  });
  it('allows the canonical collected → advanced edge', () => {
    assert.deepEqual(canTransition('collected', 'advanced'), { allowed: true });
  });
  it('allows the canonical verified → advanced edge', () => {
    assert.deepEqual(canTransition('verified', 'advanced'), { allowed: true });
  });
  it('rejects dispatched → verified (no edge)', () => {
    const r = canTransition('dispatched', 'verified');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /not allowed/);
  });
  it('rejects collected → dispatched (no edge)', () => {
    const r = canTransition('collected', 'dispatched');
    assert.equal(r.allowed, false);
  });
  it('rejects "advanced" outbound (terminal)', () => {
    const r = canTransition('advanced', 'collected');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /terminal/);
  });
  it('rejects "failed" outbound without override (blocked)', () => {
    const r = canTransition('failed', 'collected');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /blocked/);
  });
  it('rejects unknown source', () => {
    const r = canTransition('zorblax', 'collected');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /Unknown wave status/);
  });
});

describe('wave-state-machine — transitionWave happy paths', () => {
  let db, waveId;
  beforeEach(() => {
    db = openMemoryDb();
    waveId = seedWave(db, 'dispatched');
  });

  it('dispatched → collected writes audit row and sets completed_at', () => {
    const r = transitionWave(db, waveId, 'collected', 'normal collect path');
    assert.equal(r.from, 'dispatched');
    assert.equal(r.to, 'collected');
    assert.ok(r.eventId > 0);

    const w = db.prepare('SELECT status, completed_at FROM waves WHERE id = ?').get(waveId);
    assert.equal(w.status, 'collected');
    assert.ok(w.completed_at, 'completed_at must be set on dispatched → collected');

    const events = getWaveTransitionHistory(db, waveId);
    assert.equal(events.length, 1);
    assert.equal(events[0].from_status, 'dispatched');
    assert.equal(events[0].to_status, 'collected');
    assert.equal(events[0].reason, 'normal collect path');
  });

  it('dispatched → failed writes audit row and sets completed_at', () => {
    const r = transitionWave(db, waveId, 'failed', 'validation_errors > 0');
    assert.equal(r.to, 'failed');

    const w = db.prepare('SELECT status, completed_at FROM waves WHERE id = ?').get(waveId);
    assert.equal(w.status, 'failed');
    assert.ok(w.completed_at);
  });

  it('collected → verified leaves completed_at (already set)', () => {
    transitionWave(db, waveId, 'collected', 'pass 1');
    const before = db.prepare('SELECT completed_at FROM waves WHERE id = ?').get(waveId).completed_at;
    transitionWave(db, waveId, 'verified', 'verification passed');
    const after = db.prepare('SELECT completed_at FROM waves WHERE id = ?').get(waveId).completed_at;
    assert.equal(after, before, 'verified transition must not touch completed_at');
  });

  it('collected → advanced leaves completed_at (already set)', () => {
    transitionWave(db, waveId, 'collected', 'pass');
    const before = db.prepare('SELECT completed_at FROM waves WHERE id = ?').get(waveId).completed_at;
    transitionWave(db, waveId, 'advanced', 'promotion');
    const after = db.prepare('SELECT completed_at FROM waves WHERE id = ?').get(waveId).completed_at;
    assert.equal(after, before);
  });

  it('records reason=null when caller omits reason', () => {
    transitionWave(db, waveId, 'collected');
    const events = getWaveTransitionHistory(db, waveId);
    assert.equal(events[0].reason, null);
  });

  it('full chain dispatched → collected → verified → advanced produces 3 audit rows', () => {
    transitionWave(db, waveId, 'collected', 'pass');
    transitionWave(db, waveId, 'verified', 'verified');
    transitionWave(db, waveId, 'advanced', 'promotion');
    const events = getWaveTransitionHistory(db, waveId);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.to_status), ['collected', 'verified', 'advanced']);
  });
});

describe('wave-state-machine — rejection paths', () => {
  let db, waveId;
  beforeEach(() => {
    db = openMemoryDb();
    waveId = seedWave(db, 'dispatched');
  });

  it('throws StateMachineRejectionError on invalid edge', () => {
    assert.throws(
      () => transitionWave(db, waveId, 'verified', 'skipping the line'),
      (err) => err.code === 'STATE_MACHINE_INVALID' && err.from === 'dispatched' && err.to === 'verified'
    );
  });

  it('throws on terminal source', () => {
    transitionWave(db, waveId, 'collected', 'pass');
    transitionWave(db, waveId, 'advanced', 'promotion');
    assert.throws(
      () => transitionWave(db, waveId, 'collected', 'reopen'),
      (err) => err.code === 'STATE_MACHINE_TERMINAL' && /terminal/.test(err.message)
    );
  });

  it('throws on blocked source without override', () => {
    transitionWave(db, waveId, 'failed', 'agent crashed');
    assert.throws(
      () => transitionWave(db, waveId, 'collected', 'patched the output'),
      (err) => err.code === 'STATE_MACHINE_BLOCKED' && /blocked/.test(err.message)
    );
  });

  it('throws when wave id is unknown', () => {
    assert.throws(
      () => transitionWave(db, 9999, 'collected', 'whatever'),
      /Wave not found/
    );
  });

  it('does NOT write an audit row when the transition is rejected', () => {
    try { transitionWave(db, waveId, 'verified', 'skipping the line'); } catch { /* expected */ }
    const events = getWaveTransitionHistory(db, waveId);
    assert.equal(events.length, 0);
  });
});

describe('wave-state-machine — override path', () => {
  let db, waveId;
  beforeEach(() => {
    db = openMemoryDb();
    waveId = seedWave(db, 'dispatched');
    transitionWave(db, waveId, 'failed', 'validation_errors > 0');
  });

  it('failed → collected requires override=true', () => {
    assert.throws(
      () => transitionWave(db, waveId, 'collected', 'patched output'),
      (err) => err.code === 'STATE_MACHINE_BLOCKED'
    );
  });

  it('failed → collected succeeds with override=true + reason', () => {
    const r = transitionWave(db, waveId, 'collected', 'operator patched all 3 outputs', true);
    assert.equal(r.from, 'failed');
    assert.equal(r.to, 'collected');

    const w = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
    assert.equal(w.status, 'collected');
  });

  it('override path writes the audit row with the operator reason', () => {
    transitionWave(db, waveId, 'collected', 'operator patched all 3 outputs', true);
    const events = getWaveTransitionHistory(db, waveId);
    // events: [dispatched→failed, failed→collected (override)]
    assert.equal(events.length, 2);
    assert.equal(events[1].from_status, 'failed');
    assert.equal(events[1].to_status, 'collected');
    assert.equal(events[1].reason, 'operator patched all 3 outputs');
  });

  it('override requires non-empty reason', () => {
    assert.throws(
      () => transitionWave(db, waveId, 'collected', null, true),
      /requires a reason/
    );
    assert.throws(
      () => transitionWave(db, waveId, 'collected', '', true),
      /requires a reason/
    );
  });

  it('override on non-blocked source is a no-op fallback to normal path', () => {
    // Reset: fresh dispatched wave
    const db2 = openMemoryDb();
    const w2 = seedWave(db2, 'dispatched');
    // override=true on a non-blocked source falls through to the normal
    // canTransition path. dispatched → collected is legal, so it succeeds.
    const r = transitionWave(db2, w2, 'collected', 'override but legal anyway', true);
    assert.equal(r.to, 'collected');
  });
});

// ──────────────────────────────────────────────────────────────
// 2. Schema migration
// ──────────────────────────────────────────────────────────────

describe('wave-state-machine — schema migration', () => {
  it('wave_state_events table exists on a fresh DB', () => {
    const db = openMemoryDb();
    const cols = db.prepare("PRAGMA table_info('wave_state_events')").all();
    const names = cols.map(c => c.name);
    assert.ok(names.includes('id'));
    assert.ok(names.includes('wave_id'));
    assert.ok(names.includes('from_status'));
    assert.ok(names.includes('to_status'));
    assert.ok(names.includes('reason'));
    assert.ok(names.includes('created_at'));
  });

  it('applying the schema twice on the same DB is idempotent', () => {
    const db = openMemoryDb();
    // openMemoryDb already ran SCHEMA_SQL once. Run it again — IF NOT EXISTS
    // clauses make it a no-op.
    db.exec(SCHEMA_SQL);
    // Sanity: still queryable.
    const cols = db.prepare("PRAGMA table_info('wave_state_events')").all();
    assert.ok(cols.length > 0);
  });

  it('field shape mirrors agent_state_events (with wave_id swap)', () => {
    const db = openMemoryDb();
    const wse = db.prepare("PRAGMA table_info('wave_state_events')").all().map(c => c.name);
    const ase = db.prepare("PRAGMA table_info('agent_state_events')").all().map(c => c.name);
    // Replace agent_run_id with wave_id; the rest of the column set must match
    const expected = ase.map(n => n === 'agent_run_id' ? 'wave_id' : n);
    assert.deepEqual(wse.sort(), expected.sort());
  });
});

// ──────────────────────────────────────────────────────────────
// 3. Pattern #10 guard — static-scan invariant
// ──────────────────────────────────────────────────────────────

/**
 * Walk the dogfood-swarm package recursively, return JS source files.
 * Skip node_modules, dist, swarms/, .git, and tests themselves (test files
 * legitimately raw-INSERT INTO waves for fixture setup; that is fixture
 * INSERT, not state-mutation UPDATE — but the regex below only matches
 * UPDATE so test fixtures are not false-positives anyway).
 */
function* walkJs(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'swarms') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkJs(full);
    } else if (st.isFile() && /\.(js|mjs|cjs)$/.test(entry)) {
      yield full;
    }
  }
}

describe('Pattern #10 invariant — raw waves.status writers', () => {
  it('no raw `UPDATE waves SET status` outside lib/wave-state-machine.js', () => {
    // The regex catches the empirical set of raw writers seen in the pre-5A
    // audit: collect.js, dispatch.js (INSERT — not matched here), advance.js,
    // verify.js, revalidate.js. Test/test-fixture code is allowed to use
    // raw INSERT INTO waves for setup; that is NOT a state-machine bypass.
    //
    // Matches both quoted and template literal forms:
    //   db.prepare("UPDATE waves SET status = 'verified' WHERE ...")
    //   db.prepare(`UPDATE waves SET status = 'collected' ...`)
    //   db.prepare('UPDATE waves SET status = ?, ...')
    const rawWriteRe = /UPDATE\s+waves\s+SET\s+[^;]*\bstatus\b/i;

    const pkgDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const helperPath = join(pkgDir, 'lib', 'wave-state-machine.js');
    const helperPathNorm = helperPath.replace(/\\/g, '/');

    const offenders = [];
    for (const file of walkJs(pkgDir)) {
      const fileNorm = file.replace(/\\/g, '/');
      // Skip the approved helper itself
      if (fileNorm === helperPathNorm) continue;
      // Skip test files — raw INSERT INTO waves for fixture setup is fine.
      // (UPDATE waves SET status inside a test is also fine — tests are
      // not production state-mutation paths; e.g. verify.test.js line 347
      // simulates what the production verify command does.) The Pattern #10
      // contract is "production writers go through the helper"; tests are
      // out of scope.
      if (/\.test\.(?:js|mjs|cjs)$/.test(fileNorm)) continue;
      // Skip this test file itself
      if (fileNorm.endsWith('/wave-state-machine.test.js')) continue;

      const content = readFileSync(file, 'utf-8');
      // Strip comments and string literals to avoid false-positives from
      // documentation comments mentioning the legacy pattern. Simplified
      // approach: scan line by line and skip lines that are clearly inside
      // a // or /* ... */ comment. Multi-line block-comment tracking.
      let inBlockComment = false;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (inBlockComment) {
          const end = line.indexOf('*/');
          if (end >= 0) {
            line = line.slice(end + 2);
            inBlockComment = false;
          } else {
            continue;
          }
        }
        // Strip inline /* ... */ first
        while (true) {
          const bStart = line.indexOf('/*');
          if (bStart < 0) break;
          const bEnd = line.indexOf('*/', bStart + 2);
          if (bEnd < 0) {
            line = line.slice(0, bStart);
            inBlockComment = true;
            break;
          }
          line = line.slice(0, bStart) + line.slice(bEnd + 2);
        }
        // Strip // comments
        const slashIdx = line.indexOf('//');
        if (slashIdx >= 0) line = line.slice(0, slashIdx);

        if (rawWriteRe.test(line)) {
          offenders.push(`${fileNorm}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Pattern #10 violation — raw \`UPDATE waves SET status\` outside lib/wave-state-machine.js:\n` +
        offenders.map(o => `  ${o}`).join('\n')
    );
  });
});
