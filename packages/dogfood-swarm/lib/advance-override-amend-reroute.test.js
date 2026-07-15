/**
 * advance-override-amend-reroute.test.js — F-f33081a2: advance()'s override
 * branch computed `toPhase` from `PHASE_MAP[wave.phase]?.next` UNCONDITIONALLY,
 * never consulting `gateResult.nextPhase` — so an `--override --reason` issued
 * while an AMEND verdict was live (open HIGH/CRITICAL findings on a
 * finding-gated phase) rerouted PAST the amend phase whenever some OTHER
 * overridable gate (adjudication, ownership) also happened to be failing at
 * the same time, even when the operator's stated reason targeted only that
 * OTHER gate. A single boolean `opts.override` + one reason string cannot
 * express "I consent to disposing gate X only" — it silently consented to and
 * rerouted past EVERY currently-failing overridable gate.
 *
 * LIVE-REPRODUCED SHAPE (HANDOFF.md line 403, promotion #8): a finding-gated
 * audit phase with 3 open HIGH findings (AMEND verdict, nextPhase =
 * 'health-amend-a') PLUS a non-corroborate adjudication verdict (a SEPARATE
 * overridable gate) failing at the same time. `advance(db, runId,
 * {override:true, overrideReason:'...disposing the insufficient_context jury
 * verdict...'})` — an action whose stated intent targets ONLY the jury's
 * advisory concern — produced `toPhase:'health-audit-b'`, skipping
 * health-amend-a entirely, with all 3 open HIGH findings left untouched in the
 * DB and no distinguishable record of which gate the reason was actually
 * about.
 *
 * THE FIX. `toPhase` now routes along `gateResult.nextPhase` (the amend edge)
 * whenever the AMEND verdict is live AND `finding_severity` is NOT the ONLY
 * failing gate — refusing to consent to skipping open findings by mere
 * implication. `finding_severity` itself is excluded from the set of gates
 * this override actually masks (`gatesChecked`/`promotions.overrides`): the
 * wave lands on the amend phase because findings are STILL open, not because
 * they were waived. This is the "route to the amend edge, other gates masked"
 * half of the fix the finding asked for; true per-gate `--override=<names>`
 * consent needs a new cli.js flag and is out of this domain's scope (recorded
 * in this wave's output notes).
 *
 * PRESERVED ON PURPOSE (not re-litigated here — already pinned by
 * advance.test.js's F-5a251061 coverage, 'allows override for AMEND with
 * reason' / 'records override in promotion'): when `finding_severity` is the
 * ONLY failing gate, the operator's entire override intent IS the findings,
 * and routing to `next` (skipping the amend loop) remains correct.
 *
 * Both non-single-gate directions are pinned below, per this package's gate
 * non-vacuity convention:
 *   1. the AMEND-reroute case (promotion #8's shape) must now route along the
 *      amend edge, not `next`.
 *   2. a pure-BLOCK override with NO amend verdict live (only the advisory
 *      adjudication gate failing, findingGate passing) must be UNAFFECTED —
 *      still promotes along `next`, exactly as before this fix.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { advance, getPromotions } from './advance.js';
import { persistAdjudication } from './adjudication-store.js';

/** Mirrors advance.test.js's setupRun (root, out of this domain — duplicated, not imported). */
function setupRun(db, opts = {}) {
  const runId = opts.runId || 'r1';
  const phase = opts.phase || 'health-audit-a';
  const waveStatus = opts.waveStatus || 'collected';

  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);

  const wave = db.prepare(
    'INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, 1, ?)'
  ).run(runId, phase, waveStatus);
  const waveId = Number(wave.lastInsertRowid);

  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? AND ownership_class != ?')
    .all(runId, 'shared');
  for (const d of domains) {
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(waveId, d.id);
  }

  return { runId, waveId };
}

function insertFinding(db, runId, waveId, { findingId, severity = 'HIGH' }) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, 'bug', 'needs fix', 'new', ?, ?)
  `).run(runId, findingId, `fp-${findingId}`, severity, waveId, waveId);
}

describe('advance() override — AMEND reroute honors gateResult.nextPhase when findingGate is not the only failure (F-f33081a2)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('PROMOTION #8 SHAPE: 3 open HIGH findings (AMEND) + a failing adjudication gate — override routes to the amend edge, not past it', () => {
    const { runId, waveId } = setupRun(db, { phase: 'health-audit-a' });
    insertFinding(db, runId, waveId, { findingId: 'F-1' });
    insertFinding(db, runId, waveId, { findingId: 'F-2' });
    insertFinding(db, runId, waveId, { findingId: 'F-3' });
    persistAdjudication(db, {
      waveId, runId,
      result: { overall: 'insufficient_context', panel_size: 5, seats: [] },
    });

    const result = advance(db, runId, {
      override: true,
      overrideReason: 'Disposing the insufficient_context jury verdict — the case-file had a coverage gap, now filled',
    });

    assert.ok(result.promoted, 'the adjudication gate alone is overridable, so the wave must still advance somewhere');
    assert.ok(result.verdict.includes('override'));
    assert.equal(result.fromPhase, 'health-audit-a');
    assert.equal(result.toPhase, 'health-amend-a',
      'must route along the amend edge (gateResult.nextPhase) — NOT skip to health-audit-b — because the reason never named the findings');

    // The findings must still be open — this override never touched them.
    const findings = db.prepare('SELECT status FROM findings WHERE run_id = ?').all(runId);
    assert.equal(findings.length, 3);
    assert.ok(findings.every(f => f.status === 'new'), 'the 3 open HIGH findings must remain untouched, exactly as HANDOFF.md documents the live defect leaving them');

    // finding_severity must NOT be marked overridden — the wave is landing on
    // the amend phase BECAUSE it is still failing, not because it was waived.
    const findingGate = result.gates.find(g => g.name === 'finding_severity');
    assert.equal(findingGate.passed, false);
    assert.ok(!findingGate.overridden, 'finding_severity must not be marked overridden when routed to the amend edge');

    // adjudication IS the gate this override actually disposed of.
    const adjudicationGate = result.gates.find(g => g.name === 'adjudication');
    assert.equal(adjudicationGate.passed, false);
    assert.equal(adjudicationGate.overridden, true, 'adjudication is the gate the operator\'s reason actually targeted');

    // The promotion row's overrides array must name adjudication only — a
    // human reading it afterward can tell which gate the reason was about.
    const promotions = getPromotions(db, runId);
    assert.equal(promotions.length, 1);
    assert.equal(promotions[0].to_phase, 'health-amend-a');
    assert.equal(promotions[0].overrides.length, 1,
      'only ONE gate (adjudication) was actually consented to — finding_severity must not silently ride along');
    assert.equal(promotions[0].overrides[0].gate, 'adjudication');
  });

  it('a pure-BLOCK override (only the advisory adjudication gate failing, no open findings) is unaffected — still promotes along `next`', () => {
    const { runId, waveId } = setupRun(db, { phase: 'health-audit-a' });
    // No findings inserted — findingGate passes cleanly.
    persistAdjudication(db, {
      waveId, runId,
      result: { overall: 'refute', panel_size: 5, seats: [] },
    });

    const result = advance(db, runId, {
      override: true,
      overrideReason: 'Disposing the refute verdict — reviewed and accepted the risk',
    });

    assert.ok(result.promoted);
    assert.ok(result.verdict.includes('override'));
    assert.equal(result.fromPhase, 'health-audit-a');
    assert.equal(result.toPhase, 'health-audit-b',
      'no AMEND verdict is in play (findingGate passes), so toPhase must still resolve via the ordinary `next` edge — unaffected by the amend-reroute fix');

    const adjudicationGate = result.gates.find(g => g.name === 'adjudication');
    assert.equal(adjudicationGate.overridden, true);

    const promotions = getPromotions(db, runId);
    assert.equal(promotions[0].to_phase, 'health-audit-b');
    assert.equal(promotions[0].overrides.length, 1);
    assert.equal(promotions[0].overrides[0].gate, 'adjudication');
  });

  it('multiple non-finding gates failing alongside AMEND all get masked, finding_severity still excluded', () => {
    // Ownership violation + open finding + adjudication, all failing together.
    const { runId, waveId } = setupRun(db, { phase: 'health-audit-a' });
    insertFinding(db, runId, waveId, { findingId: 'F-1' });
    persistAdjudication(db, { waveId, runId, result: { overall: 'contested', panel_size: 5, seats: [] } });

    const domainId = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId).id;
    const agentRunId = db.prepare('SELECT id FROM agent_runs WHERE wave_id = ?').get(waveId).id;
    db.prepare(`
      INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
      VALUES (?, 'other/out-of-domain.js', 'edit', ?, 1)
    `).run(agentRunId, domainId);

    const result = advance(db, runId, { override: true, overrideReason: 'Disposing ownership + jury concerns' });

    assert.ok(result.promoted);
    assert.equal(result.toPhase, 'health-amend-a', 'AMEND is live and findingGate is not alone — routes to the amend edge');

    const byName = Object.fromEntries(result.gates.map(g => [g.name, g]));
    assert.ok(!byName.finding_severity.overridden, 'finding_severity stays un-overridden');
    assert.equal(byName.ownership.overridden, true);
    assert.equal(byName.adjudication.overridden, true);

    const promotions = getPromotions(db, runId);
    const overriddenGateNames = promotions[0].overrides.map(o => o.gate).sort();
    assert.deepEqual(overriddenGateNames, ['adjudication', 'ownership']);
  });
});
