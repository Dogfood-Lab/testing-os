/**
 * advance-violation-gate-run-wide.test.js — F-4fa7e644: checkGates()'s
 * ownership-violation gate must see violations from ANY wave of the run, not
 * just the CURRENT/LATEST wave.
 *
 * THE BUG. checkViolations(db, waveId, agents) scoped its COUNT(*) to
 * `agent_run_id IN (<current-wave's latest-per-domain agent_runs>)`. Once a
 * run's latest wave changes — the normal, EXPECTED sequence: an AMEND verdict
 * names nextPhase and the coordinator dispatches exactly that wave — a
 * violation recorded against the SUPERSEDED wave becomes permanently
 * invisible to checkGates()/advance(), with no override, no conscious
 * decision, no log entry marking the loss. Reproduced here exactly as the
 * finding's own two-wave probe did: wave 1 (finding-gated phase) picks up a
 * real ownership violation; wave 2 (the amend phase, not finding-gated) has a
 * clean agent_run of its own but the wave-1 violation row is left UNTOUCHED
 * in the DB. Pre-fix, checkGates() on wave 2 reports the ownership gate as
 * PASSED — a false statement; the violation is still there, just out of the
 * current wave's field of view.
 *
 * THE FIX. checkViolations now takes runId instead of (waveId, agents) and
 * queries file_claims joined through agent_runs/waves scoped to the WHOLE
 * run — mirroring commands/status.js's existing cross-wave violations
 * aggregator (the one place that already got this right, but only for
 * display, never for the gate). Uses the shared LATEST_AGENT_RUN_PER_DOMAIN
 * fragment so a stale failed/timed_out agent_run from a `swarm resume`
 * redispatch still cannot double-count or resurrect a superseded row's
 * violation (amend1-wave9-filter-discipline.test.js enforces every
 * `FROM agent_runs` site — including this new one — uses the shared
 * fragment).
 *
 * Both directions, per the gate non-vacuity rule: the stale-violation
 * scenario must FIRE (BLOCK), and an equivalent clean two-wave run must stay
 * quiet (ADVANCE). A same-wave violation (the case the pre-fix code already
 * caught) must keep firing too — run-wide is a strict superset of
 * current-wave, never a narrowing.
 *
 * This test builds its own scratch in-memory DB state (openMemoryDb) and
 * does not depend on the sibling swarm-cp-verbs domain's F-67ddcd02 fix
 * (collect.js's file_claims write-invalidation for superseded collect
 * attempts) — see this wave's coordination note: the contract this gate
 * relies on is "a row with violation=1 is a LIVE violation", which is
 * exactly what is synthesized directly here via INSERT, independent of how
 * collect.js produces such rows in production.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { checkGates } from './advance.js';

describe('checkGates — ownership-violation gate is run-wide (F-4fa7e644)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  /**
   * Seeds a run with domain `backend` and returns helpers to add waves. Mirrors
   * advance.test.js's setupRun shape but lets each wave choose its own phase /
   * violation state, since this finding is specifically about a wave BOUNDARY.
   */
  function seedRun(runId) {
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    return db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId).id;
  }

  /** Adds a wave with one complete agent_run for `domainId`, returns { waveId, agentRunId }. */
  function addWave(runId, domainId, waveNumber, phase, status = 'collected') {
    const wave = db.prepare(
      'INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, ?)'
    ).run(runId, phase, waveNumber, status);
    const waveId = Number(wave.lastInsertRowid);
    const ar = db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, domainId);
    return { waveId, agentRunId: Number(ar.lastInsertRowid) };
  }

  function recordViolation(agentRunId, domainId, filePath = 'other/out-of-domain.js') {
    db.prepare(`
      INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
      VALUES (?, ?, 'edit', ?, 1)
    `).run(agentRunId, filePath, domainId);
  }

  it('FIRES: a wave-1 violation stays visible to checkGates() once wave 2 is latest (the proven defect)', () => {
    const runId = 'r-stale-violation';
    const domainId = seedRun(runId);

    // Wave 1 — finding-gated phase, picks up a real ownership violation.
    const w1 = addWave(runId, domainId, 1, 'health-audit-a');
    recordViolation(w1.agentRunId, domainId);

    // Wave 2 — the amend phase (NOT finding-gated), clean agent_run of its own.
    // The wave-1 violation row is left untouched — this is the exact
    // "AMEND verdict names nextPhase, coordinator dispatches exactly that
    // wave" sequence the finding describes as the normal, expected path.
    addWave(runId, domainId, 2, 'health-amend-a');

    const result = checkGates(db, runId);
    const violationGate = result.gates.find(g => g.name === 'ownership');

    assert.equal(violationGate.passed, false,
      'a violation recorded against a superseded wave must still block — run-wide, not wave-scoped');
    assert.match(violationGate.reason, /1 ownership violation/);
    assert.equal(result.verdict, 'BLOCK');
    assert.equal(result.overridable, true, 'ownership violations remain overridable, same as pre-fix');
  });

  it('STAYS QUIET: an equivalent two-wave run with NO violations anywhere still ADVANCEs', () => {
    const runId = 'r-clean-two-wave';
    const domainId = seedRun(runId);

    addWave(runId, domainId, 1, 'health-audit-a'); // clean, no violation
    addWave(runId, domainId, 2, 'health-amend-a'); // clean, no violation

    const result = checkGates(db, runId);
    const violationGate = result.gates.find(g => g.name === 'ownership');

    assert.equal(violationGate.passed, true, 'no violations anywhere in the run must pass the gate');
    assert.equal(violationGate.reason, 'No ownership violations');
    assert.equal(result.verdict, 'ADVANCE');
  });

  it('a violation on the CURRENT (latest) wave still fires — run-wide is a superset, never a narrowing', () => {
    const runId = 'r-current-wave-violation';
    const domainId = seedRun(runId);

    addWave(runId, domainId, 1, 'health-audit-a'); // clean
    const w2 = addWave(runId, domainId, 2, 'health-amend-a');
    recordViolation(w2.agentRunId, domainId);

    const result = checkGates(db, runId);
    const violationGate = result.gates.find(g => g.name === 'ownership');

    assert.equal(violationGate.passed, false, 'a same-wave violation (the pre-fix-covered case) must still fire');
    assert.equal(result.verdict, 'BLOCK');
  });

  it('violations accumulate ACROSS more than two waves (three-wave run, wave-1 AND wave-2 violations both still visible at wave 3)', () => {
    const runId = 'r-three-wave-accumulate';
    const domainId = seedRun(runId);

    const w1 = addWave(runId, domainId, 1, 'health-audit-a');
    recordViolation(w1.agentRunId, domainId, 'other/first-offender.js');
    const w2 = addWave(runId, domainId, 2, 'health-amend-a');
    recordViolation(w2.agentRunId, domainId, 'other/second-offender.js');
    addWave(runId, domainId, 3, 'health-audit-a'); // clean re-audit wave

    const result = checkGates(db, runId);
    const violationGate = result.gates.find(g => g.name === 'ownership');

    assert.equal(violationGate.passed, false);
    assert.match(violationGate.reason, /2 ownership violation/, 'both prior-wave violations must be counted, not just the most recent');
  });

  it('a stale (superseded) agent_run from `swarm resume` does not double-count or resurrect a violation the surviving row does not have', () => {
    // Mirrors the wave-9 filter scenario amend1-wave9-integration.test.js
    // proves for export.js: a FAILED first-attempt agent_run carries a
    // violation; the SUCCEEDED redispatched row is clean. The wave-9 latest-
    // per-domain filter must select only the surviving row.
    const runId = 'r-resume-stale-row';
    const domainId = seedRun(runId);

    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'collected')"
    ).run(runId);
    const waveId = Number(wave.lastInsertRowid);

    const failedRow = db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'failed')")
      .run(waveId, domainId);
    recordViolation(Number(failedRow.lastInsertRowid), domainId, 'other/stale-attempt.js');

    const survivingRow = db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, domainId);
    db.prepare(`
      INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
      VALUES (?, 'src/clean.js', 'edit', ?, 0)
    `).run(Number(survivingRow.lastInsertRowid), domainId);

    const result = checkGates(db, runId);
    const violationGate = result.gates.find(g => g.name === 'ownership');

    assert.equal(violationGate.passed, true,
      'the stale failed row belongs to a superseded agent_run for the same (wave, domain) — the wave-9 filter must exclude it');
  });
});
