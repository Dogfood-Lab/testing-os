/**
 * wave10-docs-identity-drift.test.js — Wave-10 backend regression receipts.
 *
 *   F-375053-002  collect.js read ALL agent_runs for a wave with no
 *                 latest-per-domain filter. After `swarm resume` redispatched
 *                 a failed agent, the OLD failed row was still iterated, the
 *                 stale 'failed' → 'failed' transition was attempted (illegal),
 *                 the error was swallowed by a bare catch, and the wave was
 *                 marked 'failed' even when every redispatched agent
 *                 succeeded. Mirrors the wave-9 fix in resume.js.
 *
 *   F-178610-005  Five `try { transitionAgent(...) } catch { /* * / }` blocks
 *                 in collect.js silently swallowed every state-machine error.
 *                 Real regressions (illegal transitions, FK errors, prepared-
 *                 statement crashes) were indistinguishable from the expected
 *                 already-in-target no-op. tryTransition() now distinguishes
 *                 the no-op explicitly and surfaces every other error to
 *                 stderr with full context.
 *
 *   F-375053-005  schema.js STATUS.run enum was missing the v1.1.0 phases
 *                 'stage-d-audit' and 'stage-d-amend'. dispatch.js writes the
 *                 phase string directly to runs.status, so the documented
 *                 enum drifted from runtime values.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { resume } from './commands/resume.js';
import { collect } from './commands/collect.js';
import { transitionAgent } from './lib/state-machine.js';
import { STATUS } from './db/schema.js';

// ═══════════════════════════════════════════
// COORDINATED — F-375053-002 + F-178610-005 together
// (resume → collect must single-process AND log any swallowed transition)
// ═══════════════════════════════════════════

describe('collect — wave-10 coordinated: latest-per-domain + observable transitions', () => {
  let tmp;
  let dbPath;
  const RUN_ID = 'r-w10-coord';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w10-coord-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));

    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('after resume → collect, processes the single latest row AND silent-no-ops are not noisy, but a real illegal transition WOULD be surfaced', () => {
    // 1. Initial dispatch — agent_run #1 ('dispatched').
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });

    const db = openDb(dbPath);

    // 2. Force agent_run #1 into 'failed' so resume sees it as redispatchable.
    const ar1 = db.prepare("SELECT id FROM agent_runs WHERE wave_id = 1").get();
    transitionAgent(db, ar1.id, 'failed', 'simulated failure');

    // 3. Resume — creates agent_run #2 in 'dispatched'.
    const r1 = resume({ runId: RUN_ID, dbPath, outputDir: tmp });
    assert.equal(r1.redispatch.length, 1, 'resume must redispatch the failed agent');

    // 4. Write a valid audit output for backend at the redispatched path.
    const outputPath = join(tmp, 'backend-resume.json');
    writeFileSync(outputPath, JSON.stringify({
      domain: 'backend',
      stage: 'A',
      findings: [
        {
          id: 'F-W10-001',
          severity: 'LOW',
          category: 'docs',
          file: 'packages/backend/x.js',
          line: 1,
          description: 'sample finding from a clean resume',
        },
      ],
      summary: 'one finding from the clean redispatch',
    }), 'utf-8');

    // 5. Capture stderr from collect.
    const origWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => warnCalls.push(args.join(' '));

    let report;
    try {
      report = collect({
        runId: RUN_ID,
        dbPath,
        outputs: { backend: outputPath },
      });
    } finally {
      console.warn = origWarn;
    }

    // ─ Angle A (F-375053-002) ────────────────────────────────────
    // Exactly ONE agent processed (the latest), not two.
    assert.equal(report.agents.length, 1,
      'collect must process exactly one agent_run per domain (latest), not the stale failed row');
    assert.equal(report.agents[0].domain, 'backend');
    assert.equal(report.agents[0].status, 'complete',
      'the redispatched agent must be marked complete, not failed');

    // Wave status must be 'collected' (clean), not 'failed' from the stale row.
    const wave = db.prepare("SELECT status FROM waves WHERE id = 1").get();
    assert.equal(wave.status, 'collected',
      'wave must be collected — the stale failed row must not flip it');

    // Findings deduped from the redispatched output, not double-counted.
    assert.equal(report.findings.new, 1,
      'findings must come from the latest agent only — no double counting');

    // No new agent_runs were inserted by collect (it must read, not write rows).
    const total = db.prepare("SELECT COUNT(*) as n FROM agent_runs WHERE wave_id = 1").get();
    assert.equal(total.n, 2,
      'collect must not have inserted additional agent_runs (still 2: original + redispatch)');

    // ─ Angle B (F-178610-005) ────────────────────────────────────
    // Stale 'failed' row was NOT touched at all (filter excluded it). So no
    // illegal-transition warnings were emitted in the happy path. The
    // observability test below proves the warning path WORKS when triggered.
    const transitionWarns = warnCalls.filter(s =>
      s.includes('state-machine rejected transition') ||
      s.includes('transitionAgent threw'));
    assert.equal(transitionWarns.length, 0,
      'happy path: no state-machine warnings expected (latest filter excluded stale row)');
  });

  it('observability: when a transition IS illegal, collect surfaces it to stderr (no silent swallow)', () => {
    // Synthesize the bug-shape directly: an agent_run in a terminal state
    // before collect tries to transition it. The latest-per-domain filter
    // would normally skip it, but if the filter ever regresses OR a future
    // code path attempts an illegal transition, the wrapper MUST log.
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });
    const db = openDb(dbPath);

    // Directly drive the latest agent_run to 'complete' (terminal) so the
    // next attempt to transition it is illegal.
    const ar = db.prepare("SELECT id FROM agent_runs WHERE wave_id = 1").get();
    transitionAgent(db, ar.id, 'complete', 'simulated terminal state');

    // Now intentionally call collect WITHOUT the output file. collect's
    // "Output file not found" branch will try to transition complete → failed,
    // which is illegal (complete is terminal). Pre-fix: silent swallow.
    // Post-fix (wave-10): stderr warning with full context.
    // Post-fix (D3B-011 Wave A2 Stage C): structured NDJSON logStage event
    // on stderr via console.error with stage='transition_skipped' and
    // reason='state_machine_rejected'. Test asserts the new shape; the
    // legacy console.warn path is now silent.
    const origErr = console.error;
    const errCalls = [];
    console.error = (...args) => errCalls.push(args.map(String).join(' '));
    try {
      collect({
        runId: RUN_ID,
        dbPath,
        outputs: {}, // no outputs → "file not found" branch fires
      });
    } finally {
      console.error = origErr;
    }

    // Parse structured NDJSON lines emitted by logStage.
    const ndjson = [];
    for (const ln of errCalls) {
      if (!ln.startsWith('{')) continue;
      try { ndjson.push(JSON.parse(ln)); } catch { /* not ndjson */ }
    }
    const matched = ndjson.find(o =>
      o.stage === 'transition_skipped' &&
      o.reason === 'state_machine_rejected' &&
      (o.domain === 'backend' || o.agent_run_id === ar.id) &&
      o.from_status === 'complete' &&
      o.attempted_status === 'failed'
    );
    assert.ok(matched,
      `expected stage=transition_skipped reason=state_machine_rejected with from_status=complete attempted_status=failed; got:\n${errCalls.join('\n')}`);
  });
});

// ═══════════════════════════════════════════
// F-375053-005 — STATUS.run enum cross-doc consistency
// ═══════════════════════════════════════════

describe('schema.js STATUS.run — wave-10 enum coverage', () => {
  it('includes the v1.1.0 stage-d phases that dispatch.js can write to runs.status', async () => {
    // Cross-doc consistency: dispatch.js sets runs.status = opts.phase
    // directly, so STATUS.run MUST be a superset of dispatch.js's
    // AUDIT_PHASES + AMEND_PHASES + the fixed lifecycle states.
    //
    // dispatch.js sets runs.status = opts.phase directly, so STATUS.run MUST be
    // a superset of the phase vocabulary. As of the wave-10 refactor the phase
    // lists are EXPORTED from the shared lib/phases.js (dispatch.js imports them
    // from there — the fourth private copy this module used to guard against is
    // gone). Import the exported constants from that single source of truth so a
    // future phase addition that forgets schema.js fails HERE, not in production.
    // (The test author invited exactly this: "A future refactor that exports
    // them is welcome.")
    const { AUDIT_PHASES, AMEND_PHASES } = await import('./lib/phases.js');

    for (const phase of [...AUDIT_PHASES, ...AMEND_PHASES]) {
      assert.ok(
        STATUS.run.includes(phase),
        `STATUS.run must include "${phase}" (dispatch.js writes it directly to runs.status)`
      );
    }
  });

  it('explicitly lists the wave-10 stage-d additions', () => {
    // Belt-and-suspenders: even if the cross-doc extractor regresses, this
    // direct check documents the wave-10 fix line.
    assert.ok(STATUS.run.includes('stage-d-audit'),
      'STATUS.run must include stage-d-audit (added in v1.1.0)');
    assert.ok(STATUS.run.includes('stage-d-amend'),
      'STATUS.run must include stage-d-amend (added in v1.1.0)');
  });
});
