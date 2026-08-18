/**
 * resume-collect-recovery-loop.test.js — F-resume-wave-status
 *
 * The defect: `swarm resume` redispatched agents on a `failed` wave but never
 * moved the WAVE row, so the documented recovery loop could not close.
 * Observed live on run `swarm-1787033129-beab` (2026-08-18):
 *
 *   resume     → "[MUTATED] Redispatched 2 agent(s) ... then swarm collect <run>"
 *   collect    → "No dispatched wave found. The most recent wave (1,
 *                 health-audit-a) is in 'failed'." → steers to `swarm revalidate`
 *   revalidate → "agent_run is in 'dispatched' (not blocked) — revalidate only
 *                 repairs invalid_output / ownership_violation"
 *
 * Three verbs, each pointing at the next, none of which accepts the state. The
 * agents had already re-run and written schema-valid output; the work was
 * stranded behind a wave row that no longer described reality.
 *
 * The fix: resume is a state-CHANGING verb (it creates `agent_runs`, recreates
 * `--isolate` worktrees, and announces `[MUTATED]`). When it puts agents back
 * in flight it must put the WAVE back in flight too, through the lawful
 * `transitionWave` override path with a `resume:` audit reason — the same shape
 * `redrive:` / `rewind:` / `revalidate:` already use. This upholds PROTOCOL.md's
 * stated recovery contract from the other direction: a partial write must not
 * leave agents in flight while the wave stays `failed`.
 *
 * Why here and not in collect: making collect accept a `failed` wave would
 * require it to perform the `failed` → `collected` transition, which is BLOCKED
 * and belongs to `swarm revalidate` as the audited, operator-reasoned override.
 * Moving the wave at the moment work is redispatched keeps collect's
 * precondition (`dispatched`) and its own transitions untouched.
 *
 * Prior art, and why this file exists anyway: F-15fc601e patched the ROUTER
 * (`swarm status` now names `swarm redrive` for a failed wave with a failure
 * tail — commands/status.js:606). That fixed the instance an operator reaches
 * via status; it left the class open, because `swarm resume` is itself a door
 * into the dead end and operators reach for it directly. This file pins the
 * class: the loop closes from resume, whatever routed them there.
 *
 * Coverage:
 *   (a) the full resume → run agents → collect loop completes on a failed wave
 *   (b) the wave move is audited (`wave_state_events`, `resume:` reason)
 *   (c) resume does NOT move a wave it did not put back into flight
 *   (d) the routine mid-wave redispatch (wave already `dispatched`) is unchanged
 *   (e) `--dry-run` still writes nothing — the new write must not leak into the
 *       read-only liveness path (F-liveness-probe's purity contract)
 *   (f) a wave that cannot reach `dispatched` is refused BEFORE any mutation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { resume } from './commands/resume.js';
import { collect } from './commands/collect.js';
import { transitionAgent } from './lib/state-machine.js';

const RUN_ID = 'r-resume-loop';

let tmp, dbPath;

/** A schema-valid audit output for one domain. */
function writeOutput(domain, id) {
  const path = join(tmp, `${domain}-${id}.json`);
  writeFileSync(path, JSON.stringify({
    domain,
    stage: 'A',
    findings: [{
      id,
      severity: 'LOW',
      category: 'docs',
      file: `packages/${domain}/x.js`,
      line: 1,
      description: 'a finding produced by the redispatched agent',
    }],
    summary: 'one finding',
  }), 'utf-8');
  return path;
}

/** Every row the control plane could record — a read-only path must move none. */
function controlPlaneSnapshot(db) {
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return {
    agent_runs: count('agent_runs'),
    agent_state_events: count('agent_state_events'),
    wave_state_events: count('wave_state_events'),
    waveStatuses: db.prepare('SELECT id, status FROM waves ORDER BY id').all(),
    agentStatuses: db.prepare('SELECT id, status FROM agent_runs ORDER BY id').all(),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'resume-loop-'));
  dbPath = join(tmp, 'control-plane.db');

  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));

  saveDomainDraft(db, RUN_ID, [
    { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    { name: 'docs', globs: ['packages/docs/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);
});

afterEach(() => {
  closeDb(dbPath);
  // Windows: status()/resume()/collect() each openDb() without closing, so NTFS
  // may refuse the unlink. A cleanup concern, not a behaviour under test.
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EBUSY on win32 */ }
});

/**
 * Drive the live repro: dispatch two agents, collect with one output missing so
 * the wave lands `failed`, then resume.
 */
function failWaveThenResume() {
  dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });

  // `docs` never reports — collect's missing-output branch (F-aba6fa9d) fails
  // that agent AND the wave.
  const backendOut = writeOutput('backend', 'F-LOOP-BE1');
  const first = collect({ runId: RUN_ID, dbPath, outputs: { backend: backendOut } });
  assert.equal(first.waveStatusAfter, 'failed',
    'precondition: a missing output must fail the wave (F-aba6fa9d)');

  const r = resume({ runId: RUN_ID, dbPath, outputDir: tmp });
  return { r, backendOut };
}

describe('F-resume-wave-status — (a) the resume → run → collect loop closes on a failed wave', () => {
  it('collect accepts the wave after resume redispatches, and the redispatched agent completes', () => {
    const { r, backendOut } = failWaveThenResume();
    assert.equal(r.action, 'redispatched');
    assert.equal(r.redispatch.length, 1, 'only the non-reporting agent is redispatched');
    assert.equal(r.redispatch[0].domain, 'docs');

    const db = openDb(dbPath);
    assert.equal(db.prepare('SELECT status FROM waves WHERE id = 1').get().status, 'dispatched',
      'resume put agents back in flight — the wave must say so too');

    // The operator re-runs the redispatched agent and collects. Pre-fix this
    // threw "No dispatched wave found ... is in 'failed'".
    const docsOut = writeOutput('docs', 'F-LOOP-DOC1');
    const second = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { backend: backendOut, docs: docsOut },
    });

    assert.equal(second.waveStatusAfter, 'collected');
    assert.equal(second.agents.find(a => a.domain === 'docs').status, 'complete',
      'the redispatched agent must land complete');
    assert.equal(db.prepare('SELECT status FROM waves WHERE id = 1').get().status, 'collected');
  });

  it('the redispatched agent\'s findings reach the run — the work is not stranded', () => {
    const { backendOut } = failWaveThenResume();
    const docsOut = writeOutput('docs', 'F-LOOP-DOC1');
    collect({ runId: RUN_ID, dbPath, outputs: { backend: backendOut, docs: docsOut } });

    const db = openDb(dbPath);
    // Identified by file_path, not by the agent-supplied id: upsertFindings
    // re-mints `finding_id` from the content fingerprint, so the agent's own
    // string is not what lands in the row.
    const found = db.prepare('SELECT finding_id FROM findings WHERE run_id = ? AND file_path = ?')
      .get(RUN_ID, 'packages/docs/x.js');
    assert.ok(found, 'the redispatched agent\'s finding must be persisted, not lost behind the dead end');
  });
});

describe('F-resume-wave-status — (b) the wave move is audited, not silent', () => {
  it('writes one failed → dispatched wave_state_event carrying a resume: reason', () => {
    failWaveThenResume();
    const db = openDb(dbPath);
    const move = db.prepare(`
      SELECT from_status, to_status, reason FROM wave_state_events
      WHERE wave_id = 1 AND from_status = 'failed' AND to_status = 'dispatched'
      ORDER BY id
    `).all();

    assert.equal(move.length, 1, 'exactly one recovery transition, not zero and not a duplicate');
    assert.match(move[0].reason, /^resume:/,
      'the audit trail must be greppable by intent, like redrive: / rewind: / revalidate:');
    assert.match(move[0].reason, /1 agent\b/,
      'the reason must say how much work was put back in flight');
  });

  it('reports the wave move in the resume report', () => {
    const { r } = failWaveThenResume();
    assert.equal(r.waveStatusBefore, 'failed');
    assert.equal(r.waveStatusAfter, 'dispatched');
  });
});

describe('F-resume-wave-status — (c) resume does not move a wave it did not put back into flight', () => {
  it('leaves a failed wave failed when nothing is redispatchable', () => {
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });
    const db = openDb(dbPath);

    // Both agents blocked (ownership_violation) → failed wave, zero redispatch
    // candidates. Un-failing this wave would launder a blocked state into a
    // collectable one behind the operator's back.
    for (const ar of db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').all()) {
      transitionAgent(db, ar.id, 'ownership_violation', 'simulated out-of-domain edit');
    }
    collect({ runId: RUN_ID, dbPath, outputs: {} });
    assert.equal(db.prepare('SELECT status FROM waves WHERE id = 1').get().status, 'failed');

    const r = resume({ runId: RUN_ID, dbPath, outputDir: tmp });
    assert.equal(r.action, 'blocked');
    assert.equal(r.redispatch.length, 0);
    assert.equal(db.prepare('SELECT status FROM waves WHERE id = 1').get().status, 'failed',
      'no redispatch → no wave move');
    assert.equal(r.waveStatusAfter, 'failed');
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM wave_state_events WHERE wave_id = 1 AND to_status = 'dispatched'").get().n,
      0, 'no audit row for a transition that must not have happened');
  });
});

describe('F-resume-wave-status — (d) the routine mid-wave redispatch is unchanged', () => {
  it('redispatches on an already-dispatched wave without writing a wave_state_event', () => {
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    transitionAgent(db, ar.id, 'failed', 'simulated crash mid-wave');

    const before = db.prepare('SELECT COUNT(*) n FROM wave_state_events WHERE wave_id = 1').get().n;
    const r = resume({ runId: RUN_ID, dbPath, outputDir: tmp });

    assert.equal(r.redispatch.length, 1);
    assert.equal(db.prepare('SELECT status FROM waves WHERE id = 1').get().status, 'dispatched');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM wave_state_events WHERE wave_id = 1').get().n, before,
      'the wave was already dispatched — a same-status audit row would be noise on the common path');
    assert.equal(r.waveStatusBefore, 'dispatched');
    assert.equal(r.waveStatusAfter, 'dispatched');
  });
});

describe('F-resume-wave-status — (e) --dry-run still writes nothing', () => {
  it('previews the wave move on a failed wave without performing it', () => {
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });
    const backendOut = writeOutput('backend', 'F-LOOP-BE1');
    collect({ runId: RUN_ID, dbPath, outputs: { backend: backendOut } });

    const db = openDb(dbPath);
    const before = controlPlaneSnapshot(db);

    const r = resume({ runId: RUN_ID, dbPath, outputDir: tmp, dryRun: true });

    assert.equal(r.action, 'dry-run');
    assert.equal(r.wouldRedispatch.length, 1);
    assert.deepEqual(r.wouldTransitionWave, { from: 'failed', to: 'dispatched' },
      'the preview must name the wave move the real run would make');
    assert.deepEqual(controlPlaneSnapshot(db), before,
      'the liveness probe stays pure — the new wave write must not leak into it');
  });
});

describe('F-resume-wave-status — (f) an unmovable wave is refused before anything mutates', () => {
  it('refuses rather than redispatching into a wave that could never be collected', () => {
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    transitionAgent(db, ar.id, 'failed', 'simulated crash');
    // Synthesized: `advanced` is terminal for waves, so it can never reach
    // `dispatched`. Reachable only through a caller bug — which is exactly why
    // the refusal must be checked up front: throwing mid-transaction would
    // leave recreated `--isolate` worktrees behind as FS orphans.
    db.prepare("UPDATE waves SET status = 'advanced' WHERE id = 1").run();

    const before = controlPlaneSnapshot(db);
    assert.throws(
      () => resume({ runId: RUN_ID, dbPath, outputDir: tmp }),
      (e) => e.code === 'RESUME_WAVE_UNMOVABLE' && /advanced/.test(e.message),
    );
    assert.deepEqual(controlPlaneSnapshot(db), before,
      'the refusal must be total: no agent_runs, no state events, nothing');

    // The preview must refuse identically. A `--dry-run` that reported "would
    // redispatch 1 agent" here would be predicting an outcome the real verb
    // rejects — the exact drift F-liveness-probe's shared-predicate rule exists
    // to prevent, one layer up.
    assert.throws(
      () => resume({ runId: RUN_ID, dbPath, outputDir: tmp, dryRun: true }),
      (e) => e.code === 'RESUME_WAVE_UNMOVABLE',
    );
  });
});
