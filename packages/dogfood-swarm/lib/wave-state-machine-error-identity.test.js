/**
 * wave-state-machine-error-identity.test.js — F-f4a64538: all four
 * StateMachineRejectionError throw sites in wave-state-machine.js passed the
 * WAVE's own id through the `agentRunId` field (the class had no separate
 * `waveId` param), so error-render.js's dedicated identity line printed
 * "Agent run: N" for what is actually a wave id — proven live by seeding an
 * in-memory DB with a wave in a terminal status and calling transitionWave
 * directly. Wave ids and agent_run ids are separate AUTOINCREMENT sequences
 * in the same DB, both small integers, so the mislabel is not obviously
 * wrong on its face — an operator debugging the failure who greps
 * `swarm status` / the agent_runs table for "agent_run N" finds a real but
 * UNRELATED row, not the wave that actually failed.
 *
 * THE FIX. StateMachineRejectionError gained a `waveId` opt (mirroring
 * CollectUpsertError's existing `waveId` field, the sibling typed error in
 * the same file); wave-state-machine.js's four throw sites now pass `waveId`
 * instead of smuggling it through `agentRunId`. error-render.js already had
 * the correct `e.waveId` branch wired up (it already renders "Wave: N" for
 * CollectUpsertError) — no renderer change was needed, only the error
 * class's parameter surface.
 *
 * NON-REGRESSION NOTE: lib/state-machine.js's transitionAgent — the ORIGINAL
 * caller StateMachineRejectionError was written for — still legitimately uses
 * `agentRunId`; this file does not touch that call site, and
 * wave17-display-layer.test.js (package root, a different domain) keeps
 * pinning "Agent run: N" for THAT caller. Both fields can coexist on the
 * class; this fix only changes which one wave-state-machine.js populates.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns packages/dogfood-swarm/lib/**\ only —
 * wave-state-machine.test.js (root) is a different domain's file, the same
 * reasoning as wave-state-machine-header-drift.test.js in this directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { transitionWave } from './wave-state-machine.js';
import { renderTopLevelError } from './error-render.js';
import { StateMachineRejectionError } from './errors.js';

function seedWave(db, status = 'dispatched') {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run('r1', 'org/r', '/tmp/r', 'a'.repeat(40));
  const r = db.prepare(`
    INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES ('r1', 'health-audit-a', 1, ?, 'snap1')
  `).run(status);
  return Number(r.lastInsertRowid);
}

function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

/** @pins F-f4a64538 */
describe('wave-state-machine.js — StateMachineRejectionError carries waveId, not agentRunId (F-f4a64538)', () => {
  it('TERMINAL rejection: thrown error has .waveId set, .agentRunId NOT set', () => {
    const db = openMemoryDb();
    const waveId = seedWave(db, 'advanced'); // terminal — no outbound transitions

    let thrown;
    try {
      transitionWave(db, waveId, 'dispatched');
    } catch (e) { thrown = e; }

    assert.ok(thrown instanceof StateMachineRejectionError);
    assert.equal(thrown.code, 'STATE_MACHINE_TERMINAL');
    assert.equal(thrown.waveId, waveId);
    assert.equal(thrown.agentRunId, undefined,
      'the wave id must not be smuggled through agentRunId — that field belongs to transitionAgent, a different caller');
    db.close();
  });

  it('TERMINAL rejection through renderTopLevelError prints "Wave: N", never "Agent run: N"', () => {
    const db = openMemoryDb();
    const waveId = seedWave(db, 'advanced');

    let thrown;
    try {
      transitionWave(db, waveId, 'dispatched');
    } catch (e) { thrown = e; }

    const out = captureStderr(() => renderTopLevelError(thrown));
    const joined = out.join('\n');

    assert.match(joined, /ERROR \[STATE_MACHINE_TERMINAL\]/);
    assert.match(joined, new RegExp(`Wave: ${waveId}(?!\\d)`));
    assert.doesNotMatch(joined, /Agent run:/,
      'pre-fix this line printed "Agent run: N" for a WAVE id — the exact mislabel F-f4a64538 proved live');
    db.close();
  });

  it('BLOCKED rejection (failed status, no override): .waveId set, renders "Wave: N"', () => {
    const db = openMemoryDb();
    const waveId = seedWave(db, 'failed');

    let thrown;
    try {
      transitionWave(db, waveId, 'collected'); // no override → BLOCKED
    } catch (e) { thrown = e; }

    assert.ok(thrown instanceof StateMachineRejectionError);
    assert.equal(thrown.code, 'STATE_MACHINE_BLOCKED');
    assert.equal(thrown.waveId, waveId);
    assert.equal(thrown.agentRunId, undefined);

    const joined = captureStderr(() => renderTopLevelError(thrown)).join('\n');
    assert.match(joined, new RegExp(`Wave: ${waveId}(?!\\d)`));
    assert.doesNotMatch(joined, /Agent run:/);
    db.close();
  });

  it('INVALID rejection (no such edge): .waveId set, renders "Wave: N"', () => {
    const db = openMemoryDb();
    const waveId = seedWave(db, 'dispatched');

    let thrown;
    try {
      transitionWave(db, waveId, 'verified'); // dispatched -> verified is not a legal edge
    } catch (e) { thrown = e; }

    assert.ok(thrown instanceof StateMachineRejectionError);
    assert.equal(thrown.code, 'STATE_MACHINE_INVALID');
    assert.equal(thrown.waveId, waveId);
    assert.equal(thrown.agentRunId, undefined);

    const joined = captureStderr(() => renderTopLevelError(thrown)).join('\n');
    assert.match(joined, new RegExp(`Wave: ${waveId}(?!\\d)`));
    assert.doesNotMatch(joined, /Agent run:/);
    db.close();
  });

  it('override-path INVALID rejection (bad override target): .waveId set, renders "Wave: N"', () => {
    const db = openMemoryDb();
    const waveId = seedWave(db, 'failed');

    let thrown;
    try {
      transitionWave(db, waveId, 'not-a-real-status', 'testing bad override', true);
    } catch (e) { thrown = e; }

    assert.ok(thrown instanceof StateMachineRejectionError);
    assert.equal(thrown.code, 'STATE_MACHINE_INVALID');
    assert.equal(thrown.waveId, waveId);
    assert.equal(thrown.agentRunId, undefined);

    const joined = captureStderr(() => renderTopLevelError(thrown)).join('\n');
    assert.match(joined, new RegExp(`Wave: ${waveId}(?!\\d)`));
    assert.doesNotMatch(joined, /Agent run:/);
    db.close();
  });
});
