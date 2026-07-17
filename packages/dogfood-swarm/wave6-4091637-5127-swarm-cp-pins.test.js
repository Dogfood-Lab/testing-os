/**
 * wave6-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 6 (health-amend-a) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: this domain (swarm-cp-verbs) owns
 * packages/dogfood-swarm/commands/** + cli.js; package-root *.test.js belongs
 * to swarm-cp-tests. That domain is ownership_class `bridge`
 * (globs: packages/dogfood-swarm/*.test.js), and lib/domains.js#checkOwnership
 * admits a file with no exclusive `owned` claimant that matches a bridge glob
 * as valid — `bridge via swarm-cp-tests`. Writing regression pins here is
 * therefore lawful by the frozen map's own design, not an exception — see
 * wave4-4091637-5127-swarm-cp-pins.test.js's header for the fuller citation.
 * It also has to be here: every discoverable test location for this package
 * is `node --test "*.test.js" "lib/*.test.js"` (package.json), so a test
 * placed under commands/ would never be collected.
 *
 *   F-67ddcd02 (HIGH) — collect.js's (and revalidate.js's) file_claims write
 *     path was add/upsert-ONLY: a row for a file a LATER pass no longer even
 *     examines (corrected diff base via `swarm redrive`, a narrower domain
 *     recomputation, or a revalidate() repair) was never revisited, so a
 *     stale violation=1 row survived forever — corrupting `swarm status`'s
 *     violation count and any exported `swarm receipt`. Fixed by
 *     reconcileFileClaims(): before writing the current pass's claims for an
 *     agent_run_id, DELETE any existing row for that agent_run_id whose
 *     file_path is not in the current pass's file set. Applied identically
 *     in collect.js and revalidate.js's mutation pass.
 *
 *   F-482629a9 — `swarm adjudicate <run-id> --undo <id>` required and parsed
 *     <run-id> but never forwarded it into undoAdjudication(), which looked
 *     the row up by global id with no run-scope check — naming run A while
 *     targeting run B's adjudication silently deleted B's row on --apply.
 *     Fixed by threading runId through and refusing row.run_id !== runId
 *     with a structured ADJUDICATION_RUN_MISMATCH error, before either the
 *     dry-run preview or the --apply mutation.
 *
 *   F-59f22202 — the exit_code persisted to verification_receipts derived
 *     purely from `.find(s => !s.passed && !s.optional)?.exit_code ?? 0`, so
 *     a non-'pass' verdict with zero failing required steps (no_tests /
 *     unmeasured_tests) fell back to exit_code=0 — indistinguishable from a
 *     real passing step, so the receipt persisted the self-contradictory
 *     pair exit_code=0/passed=0, rendered by receipt.js as e.g.
 *     "FAIL (node, exit 0)". Fixed by persisting a documented sentinel
 *     (-1) instead of 0 for that case, plus a receipt.js render-layer fix
 *     (formatExitClause) so both historical (0) and new (-1) rows render
 *     coherently.
 *
 *   F-1997e7c8 — commands/verify.js's verify() dropped lib/verify/runner.js's
 *     output_exceeded/timed_out fields (top-level aggregate AND per-step) on
 *     the way to its return object, even though registry.js's
 *     runVerification() forwards them unchanged. Fixed by forwarding both,
 *     mirroring how reason/no_tests/test_count are already forwarded.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { collect } from './commands/collect.js';
import { revalidate } from './commands/revalidate.js';
import { status } from './commands/status.js';
import { buildReceipt, formatReceiptMarkdown, computeRecommendation } from './commands/receipt.js';
import { checkGates } from './lib/advance.js';
import { verify as runVerify } from './commands/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function teardown(...dirs) {
  for (const d of dirs) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

// ══════════════════════════════════════════════════════════════════════
// F-67ddcd02 — collect() reconciles stale file_claims across re-collects
// ══════════════════════════════════════════════════════════════════════

describe('F-67ddcd02: collect() reconciles file_claims to the CURRENT pass, not just adds to it', () => {
  const RID = 'r-f67ddcd02-collect';
  const ROGUE = 'packages/rogue/x.js';
  const GOOD = 'packages/backend/good.js';
  let tmp, dbPath;

  // No git repo at tmp: getActualTouchedFiles is unavailable, so ownership
  // enforcement falls back to the agent's self-reported files_changed (same
  // fixture shape as the DS-MUT-001 precedent in stageA-ds-commands-amend.test.js).
  function seedRun() {
    tmp = mkdtempSync(join(tmpdir(), 'f67ddcd02-collect-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'dispatched')"
    ).run(RID);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(RID);
    db.prepare(
      "INSERT INTO agent_runs (wave_id, domain_id, status, started_at) VALUES (?, ?, 'dispatched', datetime('now'))"
    ).run(Number(wave.lastInsertRowid), dom.id);
    closeDb(dbPath);
  }

  function writeOutput(path, filesChanged, note) {
    writeFileSync(path, JSON.stringify({
      domain: 'backend',
      summary: note,
      fixes: [{ finding_id: 'F-1', description: note }],
      files_changed: filesChanged,
    }));
  }

  function redrive() {
    // Simulates `swarm redrive`: the blocked agent stays put, its schema-valid
    // output.json stays on disk, and the wave flips back to 'dispatched' so
    // the next collect() re-enumerates the same agent_run row.
    const db = openDb(dbPath);
    db.prepare("UPDATE waves SET status = 'dispatched' WHERE run_id = ?").run(RID);
  }

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  it('LENS (unchanged direction): a real violation still writes, persists, and blocks the ownership gate', () => {
    seedRun();
    const outPath = join(tmp, 'attempt1.json');
    writeOutput(outPath, [ROGUE], 'broken diff base — out-of-domain edit');

    const r1 = collect({ runId: RID, dbPath, outputs: { backend: outPath } });
    const a1 = r1.agents.find(a => a.domain === 'backend');
    assert.equal(a1.status, 'ownership_violation');
    assert.ok(r1.violations.some(v => v.file === ROGUE));

    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    const claim = db.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, ROGUE);
    assert.ok(claim, 'the violation claim must still be written');
    assert.equal(claim.violation, 1);

    // Do NOT weaken the gate: a real violation must still BLOCK.
    const gates = checkGates(db, RID);
    const ownershipGate = gates.gates.find(g => g.name === 'ownership');
    assert.equal(ownershipGate.passed, false, 'a real violation must still block the advance gate');
  });

  it('NEW invariant: three successive re-collects (redrive) reconcile file_claims at every step', () => {
    seedRun();
    const out1 = join(tmp, 'attempt1.json');
    const out2 = join(tmp, 'attempt2-corrected.json');
    const out3 = join(tmp, 'attempt3-reverted.json');
    writeOutput(out1, [ROGUE], 'attempt 1 — broken diff base');
    writeOutput(out2, [GOOD], 'attempt 2 — corrected diff base');
    writeOutput(out3, [], 'attempt 3 — every edit reverted');

    // Pass 1: broken diff base. Violation recorded, wave -> failed.
    const r1 = collect({ runId: RID, dbPath, outputs: { backend: out1 } });
    assert.equal(r1.agents.find(a => a.domain === 'backend').status, 'ownership_violation');
    let db = openDb(dbPath);
    assert.equal(db.prepare('SELECT status FROM waves WHERE run_id = ?').get(RID).status, 'failed');
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();

    // Pass 2 (redrive): corrected diff base — rogue file gone, legit in-domain
    // edit instead. THE FIX: the stale rogue row must be superseded, not just
    // left alongside a new one.
    redrive();
    const r2 = collect({ runId: RID, dbPath, outputs: { backend: out2 } });
    const a2 = r2.agents.find(a => a.domain === 'backend');
    assert.equal(a2.status, 'complete', 'the corrected pass has no violations');
    assert.equal(r2.violations.length, 0);

    db = openDb(dbPath);
    const rogueAfterPass2 = db.prepare(
      'SELECT * FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, ROGUE);
    assert.equal(rogueAfterPass2, undefined,
      'F-67ddcd02 regression: a file no longer in the current pass file set must not survive as a stale claim');
    const goodAfterPass2 = db.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, GOOD);
    assert.ok(goodAfterPass2, 'the current pass legitimate claim must be recorded');
    assert.equal(goodAfterPass2.violation, 0);
    let allClaims = db.prepare('SELECT file_path FROM file_claims WHERE agent_run_id = ?').all(ar.id);
    assert.equal(allClaims.length, 1, `exactly one reconciled claim after pass 2; got ${JSON.stringify(allClaims)}`);

    // Pass 3 (redrive again): every edit reverted — files_changed is now
    // empty. THE FIX (empty-keep-set branch): ALL claims for this agent_run
    // must be cleared, not just left at whatever pass 2 wrote.
    redrive();
    const r3 = collect({ runId: RID, dbPath, outputs: { backend: out3 } });
    assert.equal(r3.agents.find(a => a.domain === 'backend').status, 'complete');

    db = openDb(dbPath);
    allClaims = db.prepare('SELECT file_path FROM file_claims WHERE agent_run_id = ?').all(ar.id);
    assert.equal(allClaims.length, 0,
      `a fully-reverted pass must clear every claim for this agent_run; got ${JSON.stringify(allClaims)}`);
  });
});

describe('F-67ddcd02: reconciliation is honored by every consumer path (status, receipt, advance gate)', () => {
  const RID = 'r-f67ddcd02-consumers';
  const ROGUE = 'packages/rogue/x.js';
  const GOOD = 'packages/backend/good.js';
  let tmp, dbPath;

  // Drives the SAME broken-then-corrected two-pass scenario as the write-path
  // describe block above; each `it` below re-runs it fresh so a failure in
  // one consumer path is independently diagnosable, per the wave-6 brief's
  // "enumerate every consumer and add a test per path" instruction.
  function driveReconciledScenario() {
    tmp = mkdtempSync(join(tmpdir(), 'f67ddcd02-consumers-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'dispatched')"
    ).run(RID);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(RID);
    db.prepare(
      "INSERT INTO agent_runs (wave_id, domain_id, status, started_at) VALUES (?, ?, 'dispatched', datetime('now'))"
    ).run(Number(wave.lastInsertRowid), dom.id);
    closeDb(dbPath);

    const out1 = join(tmp, 'attempt1.json');
    const out2 = join(tmp, 'attempt2.json');
    writeFileSync(out1, JSON.stringify({
      domain: 'backend', summary: 'broken diff base',
      fixes: [{ finding_id: 'F-1', description: 'x' }], files_changed: [ROGUE],
    }));
    writeFileSync(out2, JSON.stringify({
      domain: 'backend', summary: 'corrected diff base',
      fixes: [{ finding_id: 'F-1', description: 'x, corrected' }], files_changed: [GOOD],
    }));

    collect({ runId: RID, dbPath, outputs: { backend: out1 } });
    openDb(dbPath).prepare("UPDATE waves SET status = 'dispatched' WHERE run_id = ?").run(RID);
    const r2 = collect({ runId: RID, dbPath, outputs: { backend: out2 } });
    assert.equal(r2.violations.length, 0, 'precondition: the corrected pass must be clean');
  }

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  it('consumer 1 — status(): the violation count drops to 0 after reconciliation', () => {
    driveReconciledScenario();
    const s = status({ runId: RID, dbPath });
    assert.equal(s.violations, 0,
      'status() must not keep counting a violation reconciliation superseded');
  });

  it('consumer 2 — buildReceipt(): the SAME wave (1) no longer exports the stale violation', () => {
    driveReconciledScenario();
    // This is exactly the corruption named in F-67ddcd02: `swarm receipt` for
    // the wave that originally recorded the violation must not keep exporting
    // it once a later pass superseded it.
    const receipt = buildReceipt({ runId: RID, waveNumber: 1, dbPath });
    assert.equal(receipt.ownership_violations.length, 0,
      `wave 1's receipt must not export a superseded violation; got ${JSON.stringify(receipt.ownership_violations)}`);
  });

  it('consumer 3 — checkGates(): the advance-gate ownership check is not blocked by the superseded violation', () => {
    driveReconciledScenario();
    const db = openDb(dbPath);
    const gates = checkGates(db, RID);
    const ownershipGate = gates.gates.find(g => g.name === 'ownership');
    assert.equal(ownershipGate.passed, true,
      'the ownership gate must not block on a violation the current pass superseded');
  });
});

describe('F-67ddcd02: revalidate() mutation pass reconciles file_claims too (the identical fix, second write path)', () => {
  const RID = 'r-f67ddcd02-revalidate';
  const ROGUE = 'packages/rogue/x.js';
  const GOOD = 'packages/backend/good.js';
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'f67ddcd02-revalidate-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'dispatched')"
    ).run(RID);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(RID);
    db.prepare(
      "INSERT INTO agent_runs (wave_id, domain_id, status, started_at) VALUES (?, ?, 'dispatched', datetime('now'))"
    ).run(Number(wave.lastInsertRowid), dom.id);
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  it('a revalidate() repair with a corrected output supersedes the stale violation claim from the original collect()', () => {
    const outPath1 = join(tmp, 'attempt1.json');
    const outPath2 = join(tmp, 'corrected.json');
    writeFileSync(outPath1, JSON.stringify({
      domain: 'backend', summary: 'rogue edit',
      fixes: [{ finding_id: 'F-1', description: 'x' }], files_changed: [ROGUE],
    }));
    writeFileSync(outPath2, JSON.stringify({
      domain: 'backend', summary: 'corrected edit',
      fixes: [{ finding_id: 'F-1', description: 'x, corrected' }], files_changed: [GOOD],
    }));

    // Original collect: rogue file -> ownership_violation, wave -> failed.
    const r1 = collect({ runId: RID, dbPath, outputs: { backend: outPath1 } });
    assert.equal(r1.agents.find(a => a.domain === 'backend').status, 'ownership_violation');

    const dbCheck = openDb(dbPath);
    const ar = dbCheck.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    const rogueClaimBefore = dbCheck.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, ROGUE);
    assert.ok(rogueClaimBefore, 'precondition: the violation claim exists before the repair');
    assert.equal(rogueClaimBefore.violation, 1);

    // revalidate() with the corrected output — the lawful recovery path,
    // NOT another collect().
    const rr = revalidate({
      runId: RID, dbPath, reason: 'corrected the out-of-domain edit',
      outputs: { backend: outPath2 }, apply: true,
    });
    assert.equal(rr.repairs.filter(r => r.applied).length, 1,
      `repair must apply cleanly: ${JSON.stringify(rr.refusals)}`);
    assert.equal(rr.waveStatusAfter, 'collected');

    const db = openDb(dbPath);
    // THE FIX: the stale ROGUE row must be gone.
    const rogueClaimAfter = db.prepare(
      'SELECT * FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, ROGUE);
    assert.equal(rogueClaimAfter, undefined,
      'F-67ddcd02 regression: revalidate() must supersede the collect()-written stale claim too, not only collect() itself');

    // The corrected claim IS present.
    const goodClaim = db.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, GOOD);
    assert.ok(goodClaim);
    assert.equal(goodClaim.violation, 0);

    // Consumer path: the repaired wave's receipt reports zero violations.
    const receipt = buildReceipt({ runId: RID, waveNumber: 1, dbPath });
    assert.equal(receipt.ownership_violations.length, 0,
      'the receipt for the repaired wave must not export the stale violation revalidate() just superseded');
  });

  // F-3ee5d050: the mutation-pass reconcileFileClaims call (line 415, pre-fix)
  // was nested inside `if (isAmend && r.ownership && Array.isArray(r.ownership.valid))`.
  // r.ownership is only assigned truthy in the validation pass when
  // filesForOwnership.length > 0 (revalidate.js:316) — the UNION of the
  // corrected output's files_changed and the independently-observed touched
  // set. A repair whose corrected output reports files_changed: [] (a full
  // revert: the agent's entire contribution WAS the out-of-domain edit, so
  // the lawful fix is to remove it, not replace it) against a worktree with
  // no independently-observable touches (no git repo at `tmp`, mirroring the
  // "getActualTouchedFiles is unavailable" fixture shape used throughout this
  // file) leaves filesForOwnership empty too — so pre-fix, r.ownership stayed
  // null and reconcileFileClaims was skipped entirely for this repair, even
  // though the agent_run genuinely transitioned to 'complete'. THE FIX: hoist
  // the call so it runs whenever isAmend is true, with keep=[] for this case
  // (reconcileFileClaims's own empty-array branch already clears every row).
  it('F-3ee5d050: a revalidate() repair with corrected files_changed: [] (full revert) still clears the stale violation claim', () => {
    const outPath1 = join(tmp, 'attempt1.json');
    const outPath2 = join(tmp, 'reverted.json');
    writeFileSync(outPath1, JSON.stringify({
      domain: 'backend', summary: 'rogue edit',
      fixes: [{ finding_id: 'F-1', description: 'x' }], files_changed: [ROGUE],
    }));
    writeFileSync(outPath2, JSON.stringify({
      domain: 'backend', summary: 'reverted the out-of-domain edit entirely — nothing left to claim',
      fixes: [{ finding_id: 'F-1', description: 'reverted, no replacement edit' }], files_changed: [],
    }));

    // Original collect: rogue file -> ownership_violation, wave -> failed.
    const r1 = collect({ runId: RID, dbPath, outputs: { backend: outPath1 } });
    assert.equal(r1.agents.find(a => a.domain === 'backend').status, 'ownership_violation');

    const dbCheck = openDb(dbPath);
    const ar = dbCheck.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    const rogueClaimBefore = dbCheck.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, ROGUE);
    assert.ok(rogueClaimBefore, 'precondition: the violation claim exists before the repair');
    assert.equal(rogueClaimBefore.violation, 1);

    // revalidate() with files_changed: [] — pre-fix, this is the ONE
    // asymmetric branch: filesForOwnership ends up empty (no reported files,
    // no independently-observed touches), r.ownership stays null, and the
    // reconcile call never runs.
    const rr = revalidate({
      runId: RID, dbPath, reason: 'reverted the out-of-domain edit',
      outputs: { backend: outPath2 }, apply: true,
    });
    assert.equal(rr.repairs.filter(r => r.applied).length, 1,
      `repair must apply cleanly: ${JSON.stringify(rr.refusals)}`);
    assert.equal(rr.repairs[0].ownership, null,
      'precondition: an empty union set leaves ownership null in the validation pass (the branch the pre-fix code missed)');
    assert.equal(rr.waveStatusAfter, 'collected');

    const db = openDb(dbPath);
    // THE FIX: the stale ROGUE row must be gone even though ownership was
    // never re-checked (nothing to check — the keep-set is legitimately []).
    const rogueClaimAfter = db.prepare(
      'SELECT * FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, ROGUE);
    assert.equal(rogueClaimAfter, undefined,
      'F-3ee5d050 regression: an empty-files_changed repair must still supersede the stale violation claim');
    const allClaimsAfter = db.prepare('SELECT file_path FROM file_claims WHERE agent_run_id = ?').all(ar.id);
    assert.equal(allClaimsAfter.length, 0,
      `a fully-reverted repair must clear every claim for this agent_run; got ${JSON.stringify(allClaimsAfter)}`);

    // Consumer path 1: the repaired wave's receipt reports zero violations.
    const receipt = buildReceipt({ runId: RID, waveNumber: 1, dbPath });
    assert.equal(receipt.ownership_violations.length, 0,
      'the receipt for the repaired wave must not export the stale violation the empty-revert repair just superseded');

    // Consumer path 2: status()'s run-wide violation count reads 0.
    const s = status({ runId: RID, dbPath });
    assert.equal(s.violations, 0,
      'status() must not keep counting a violation an empty-files_changed repair superseded');

    // Consumer path 3: the run-wide advance gate reads clean (do not weaken
    // it — this is the same "verify the gate actually reads 0" requirement
    // as the sibling describe block above, applied to the empty-revert path).
    const gates = checkGates(db, RID);
    const ownershipGate = gates.gates.find(g => g.name === 'ownership');
    assert.equal(ownershipGate.passed, true,
      'the ownership gate must not block on a violation an empty-files_changed repair superseded');
  });

  // Both directions, in one place: a repair that DOES have real files must
  // still write its claims — the empty-keep-set branch above must not have
  // become the ONLY path that runs. (The sibling test above this one already
  // proves this independently with files_changed: [GOOD]; this asserts it
  // again explicitly alongside the empty-revert pin so the two directions are
  // visibly paired, per the wave-8 brief's "lens both directions" note.)
  it('F-3ee5d050 lens: a repair with real (non-empty) files_changed still writes its valid claims, not just clears stale ones', () => {
    const outPath1 = join(tmp, 'attempt1.json');
    const outPath2 = join(tmp, 'corrected-real-file.json');
    writeFileSync(outPath1, JSON.stringify({
      domain: 'backend', summary: 'rogue edit',
      fixes: [{ finding_id: 'F-1', description: 'x' }], files_changed: [ROGUE],
    }));
    writeFileSync(outPath2, JSON.stringify({
      domain: 'backend', summary: 'corrected to a real in-domain edit',
      fixes: [{ finding_id: 'F-1', description: 'x, corrected' }], files_changed: [GOOD],
    }));

    collect({ runId: RID, dbPath, outputs: { backend: outPath1 } });
    const rr = revalidate({
      runId: RID, dbPath, reason: 'corrected to a real edit',
      outputs: { backend: outPath2 }, apply: true,
    });
    assert.equal(rr.repairs.filter(r => r.applied).length, 1, `repair must apply: ${JSON.stringify(rr.refusals)}`);
    assert.ok(rr.repairs[0].ownership && Array.isArray(rr.repairs[0].ownership.valid),
      'precondition: a non-empty files_changed DOES populate ownership.valid (the branch that already worked pre-fix)');

    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    const goodClaim = db.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).get(ar.id, GOOD);
    assert.ok(goodClaim, 'a repair with a real file must still write its valid claim');
    assert.equal(goodClaim.violation, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// F-482629a9 — adjudicate --undo refuses a cross-run mismatch
// ══════════════════════════════════════════════════════════════════════

describe('F-482629a9: adjudicate --undo refuses a cross-run mismatch (CLI subprocess)', () => {
  let tmp, dbPath;

  function seedTwoRuns() {
    tmp = mkdtempSync(join(tmpdir(), 'f482629a9-cli-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    for (const runId of ['run-a', 'run-b']) {
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run(runId, 'org/r', tmp, 'a'.repeat(40));
    }
    const waveB = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('run-b', 'health-audit-a', 1, 'collected')"
    ).run();
    const adjudication = db.prepare(`
      INSERT INTO adjudications (wave_id, run_id, overall, authority, panel_size, seats)
      VALUES (?, 'run-b', 'corroborate', 'advisory', 1, '["qwen"]')
    `).run(Number(waveB.lastInsertRowid));
    closeDb(dbPath);
    return Number(adjudication.lastInsertRowid);
  }

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  function runCli(args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  it('PROVEN END-TO-END (dry-run): naming the WRONG run refuses the undo and does not delete the row', () => {
    const id = seedTwoRuns();
    const r = runCli(['adjudicate', 'run-a', '--undo', String(id)]);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
    assert.notEqual(r.status, 0,
      `a cross-run undo must be refused; got exit ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /ERROR \[ADJUDICATION_RUN_MISMATCH\]/);
    assert.match(r.stderr, /belongs to run "run-b"/);

    const db = openDb(dbPath);
    const stillThere = db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE id = ?').get(id).n;
    assert.equal(stillThere, 1, 'the row must survive a refused dry-run undo');
  });

  it('PROVEN END-TO-END (--apply): naming the WRONG run refuses the mutation too — the row is never deleted', () => {
    const id = seedTwoRuns();
    const r = runCli(['adjudicate', 'run-a', '--undo', String(id), '--apply']);
    assert.notEqual(r.status, 0, `a cross-run --apply undo must be refused; got exit ${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /ERROR \[ADJUDICATION_RUN_MISMATCH\]/);

    const db = openDb(dbPath);
    const stillThere = db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE id = ?').get(id).n;
    assert.equal(stillThere, 1,
      'F-482629a9 regression: naming a different run must never delete a run it does not own');
  });

  it('LENS (unchanged direction): naming the CORRECT (owning) run still works — same-run undo is not broken by the fix', () => {
    const id = seedTwoRuns();
    const r = runCli(['adjudicate', 'run-b', '--undo', String(id), '--apply']);
    assert.equal(r.status, 0, `same-run undo must still succeed; got exit ${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stdout, /Removed: yes/);

    const db = openDb(dbPath);
    const gone = db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE id = ?').get(id).n;
    assert.equal(gone, 0, 'the correct-run undo must still actually remove the row');
  });
});

// ══════════════════════════════════════════════════════════════════════
// F-59f22202 — persisted exit_code is coherent with the verdict
// ══════════════════════════════════════════════════════════════════════

describe('F-59f22202: verify() persists a coherent exit_code for a no-failing-step non-pass verdict', () => {
  // Overrides the three OPTIONAL node-adapter steps with trivial in-process
  // no-ops (mirrors meta-amendB-operator-output.test.js's
  // SAFE_OPTIONAL_OVERRIDES) so the test never shells out to npx/tsc.
  const SAFE_OPTIONAL_OVERRIDES = {
    // NOTE: `cmd: 'node'` (bare, PATH-resolved) — NOT process.execPath. With
    // shell:true (runStep's invocation shape), a process.execPath containing
    // a space (e.g. Windows' default "C:\Program Files\nodejs\node.exe")
    // gets split by the shell at the space and misreports tool_missing;
    // bare 'node' matches the proven-working pattern already used by
    // verify.test.js's runStep tests and lib/verify-runner-output-exceeded.test.js.
    // The inner quotes are that same rule carried to `args`, which this NOTE
    // originally stopped short of: an unquoted `(` reaches /bin/sh as a subshell
    // metachar and the step dies POSIX-only (cmd.exe tolerates it). Optional
    // steps swallow the failure, so it was silent on both platforms.
    lint: { name: 'lint', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
    typecheck: { name: 'typecheck', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
    build: { name: 'build', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
  };

  let fixtureRoot, repoPath, dbPath;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'f59f22202-'));
    repoPath = join(fixtureRoot, 'repo');
    mkdirSync(repoPath, { recursive: true });
    // A Node repo with NO `test` script: the node adapter scores it but
    // evidence.hasTest === false, so the default `npm test --if-present`
    // step runs nothing and the runner assigns verdict no_tests.
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ name: 'fixture-no-test', version: '0.0.0', scripts: { lint: 'true' } }, null, 2)
    );

    dbPath = join(fixtureRoot, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', repoPath, 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'collected')")
      .run();
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(fixtureRoot);
  });

  it('a no_tests verdict persists the documented sentinel, not a false 0', () => {
    const result = runVerify({ runId: 'r1', dbPath, commandOverrides: SAFE_OPTIONAL_OVERRIDES });
    assert.equal(result.verdict, 'no_tests');

    const db = openDb(dbPath);
    const receipt = db.prepare('SELECT * FROM verification_receipts WHERE id = ?').get(result.receiptId);
    assert.equal(receipt.passed, 0);
    assert.notEqual(receipt.exit_code, 0,
      'pre-fix: a no_tests verdict (zero failing required steps) fell back to exit_code=0 — ' +
      'indistinguishable from a real passing step');
    assert.equal(receipt.exit_code, -1, 'the documented NO_FAILING_STEP_EXIT_CODE sentinel (commands/verify.js)');
  });

  it('LENS (unchanged direction): a real failing required step still persists ITS real exit code', () => {
    const result = runVerify({
      runId: 'r1',
      dbPath,
      commandOverrides: {
        ...SAFE_OPTIONAL_OVERRIDES,
        // Quoted: unquoted, /bin/sh rejects `(` as a syntax error and returns
        // exit 2 — so this test asserted exit 1 against the SHELL's failure, not
        // the authored process.exit(1). It measured nothing it claimed to.
        test: { name: 'test', cmd: 'node', args: ['-e', '"process.exit(1)"'] },
      },
    });
    assert.equal(result.verdict, 'fail');

    const db = openDb(dbPath);
    const receipt = db.prepare('SELECT * FROM verification_receipts WHERE id = ?').get(result.receiptId);
    assert.equal(receipt.passed, 0);
    assert.equal(receipt.exit_code, 1,
      'a genuine failing step must keep its real exit code, not the F-59f22202 sentinel');
  });

  it('LENS (unchanged direction): a genuine pass still persists exit_code 0', () => {
    const result = runVerify({
      runId: 'r1',
      dbPath,
      commandOverrides: {
        ...SAFE_OPTIONAL_OVERRIDES,
        // Prints a recognizable node --test TAP summary line so the runner
        // measures a positive test_count (tests_ran=true) and assigns a
        // genuine 'pass' verdict rather than downgrading to no_tests. The
        // whole -e payload is wrapped in literal double quotes — under
        // shell:true (runStep's invocation shape) on Windows, an unwrapped
        // payload containing a single-quoted string gets mis-split by the
        // shell (proven empirically); the literal-double-quote wrap is the
        // same convention verify.test.js's own runStep tests already use.
        test: { name: 'test', cmd: 'node', args: ['-e', "\"console.log('# tests 1'); process.exit(0);\""] },
      },
    });
    assert.equal(result.verdict, 'pass');

    const db = openDb(dbPath);
    const receipt = db.prepare('SELECT * FROM verification_receipts WHERE id = ?').get(result.receiptId);
    assert.equal(receipt.passed, 1);
    assert.equal(receipt.exit_code, 0,
      'a genuine pass must still persist exit_code 0 — F-59f22202 must not touch this path');
  });
});

describe('F-59f22202: receipt.js renders exit_code=0/-1 with passed=false as "no required step failed"', () => {
  function minimalReceipt(verification) {
    return {
      wave: {
        number: 1, phase: 'health-audit-a', status: 'collected',
        domain_snapshot_id: 'snap1', serial_verify_required: false, ownership_probe_degraded: false,
      },
      run: { id: 'r1', repo: 'org/r', branch: 'main', commit_sha: 'a'.repeat(40) },
      generated_at: new Date().toISOString(),
      agents: [],
      state_transitions: [],
      artifacts: [],
      ownership_violations: [],
      findings: {
        total: 0, by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        by_status: {}, this_wave: { new: 0, recurring: 0, fixed: 0 },
      },
      verification,
      recommendation: { action: 'ADVANCE', reason: 'test' },
    };
  }

  it('a HISTORICAL no_tests-shaped row (exit_code=0, passed=false) renders coherently, not "exit 0"', () => {
    const md = formatReceiptMarkdown(minimalReceipt({ passed: false, repo_type: 'node', test_count: 0, exit_code: 0 }));
    assert.match(md, /FAIL \(node, no required step failed\)/);
    assert.doesNotMatch(md, /exit 0\)/, 'pre-fix: this rendered the self-contradictory "FAIL (node, exit 0)"');
  });

  it('a POST-FIX no_tests-shaped row (exit_code=-1, passed=false) renders coherently, not "exit -1"', () => {
    const md = formatReceiptMarkdown(minimalReceipt({ passed: false, repo_type: 'node', test_count: 0, exit_code: -1 }));
    assert.match(md, /FAIL \(node, no required step failed\)/);
    assert.doesNotMatch(md, /exit -1\)/);
  });

  it('LENS (unchanged direction): a genuine failure (real nonzero exit_code) still renders "exit N"', () => {
    const md = formatReceiptMarkdown(minimalReceipt({ passed: false, repo_type: 'node', test_count: 3, exit_code: 1 }));
    assert.match(md, /FAIL \(node, 3 tests, exit 1\)/);
  });

  it('LENS (unchanged direction): a genuine pass renders "exit 0" unchanged', () => {
    const md = formatReceiptMarkdown(minimalReceipt({ passed: true, repo_type: 'node', test_count: 3, exit_code: 0 }));
    assert.match(md, /PASS \(node, 3 tests, exit 0\)/);
  });
});

describe('F-59f22202: computeRecommendation reason string is coherent for a no-failing-step non-pass verdict', () => {
  const wave = { phase: 'health-amend-a', serial_verify_required: 1 };
  const agentRuns = [{ status: 'complete' }];
  const openBySeverity = { CRITICAL: 0, HIGH: 0 };
  const waveDelta = { waveNew: 0, waveNewCrit: 0, waveNewHigh: 0, totalFixed: 0 };

  it('a HISTORICAL no_tests-shaped receipt (exit_code=0) reads "no required step failed", not "exit 0"', () => {
    const rec = computeRecommendation(wave, agentRuns, openBySeverity, waveDelta,
      { passed: 0, repo_type: 'node', exit_code: 0 });
    assert.equal(rec.action, 'VERIFY');
    assert.match(rec.reason, /no required step failed/);
    assert.doesNotMatch(rec.reason, /exit 0/);
  });

  it('LENS (unchanged direction): a genuine failure still names its real exit code', () => {
    const rec = computeRecommendation(wave, agentRuns, openBySeverity, waveDelta,
      { passed: 0, repo_type: 'node', exit_code: 1 });
    assert.match(rec.reason, /exit 1/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// F-1997e7c8 — verify() forwards output_exceeded/timed_out
// ══════════════════════════════════════════════════════════════════════

describe('F-1997e7c8: verify() forwards output_exceeded/timed_out (top level AND per step)', () => {
  const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // mirrors lib/verify/runner.js

  const SAFE_OPTIONAL_OVERRIDES = {
    // NOTE: `cmd: 'node'` (bare, PATH-resolved) — NOT process.execPath. With
    // shell:true (runStep's invocation shape), a process.execPath containing
    // a space (e.g. Windows' default "C:\Program Files\nodejs\node.exe")
    // gets split by the shell at the space and misreports tool_missing;
    // bare 'node' matches the proven-working pattern already used by
    // verify.test.js's runStep tests and lib/verify-runner-output-exceeded.test.js.
    // The inner quotes are that same rule carried to `args`, which this NOTE
    // originally stopped short of: an unquoted `(` reaches /bin/sh as a subshell
    // metachar and the step dies POSIX-only (cmd.exe tolerates it). Optional
    // steps swallow the failure, so it was silent on both platforms.
    lint: { name: 'lint', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
    typecheck: { name: 'typecheck', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
    build: { name: 'build', cmd: 'node', args: ['-e', '"process.exit(0)"'], optional: true },
  };

  let fixtureRoot, repoPath, dbPath;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'f1997e7c8-'));
    repoPath = join(fixtureRoot, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));

    dbPath = join(fixtureRoot, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', repoPath, 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'collected')")
      .run();
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(fixtureRoot);
  });

  // Real subprocess fixtures (CLAUDE.md rule #6 — real fixtures, not mocks),
  // mirroring lib/verify-runner-output-exceeded.test.js's own builders.
  function bigOutputStep(name, bytes) {
    const dir = mkdtempSync(join(tmpdir(), 'f1997e7c8-overflow-'));
    const emitFile = join(dir, 'emit.cjs').replace(/\\/g, '/');
    writeFileSync(
      emitFile,
      `const chunk = 'x'.repeat(1024 * 1024);\n` +
        `let remaining = ${bytes};\n` +
        `while (remaining > 0) {\n` +
        `  const n = Math.min(remaining, chunk.length);\n` +
        `  process.stdout.write(chunk.slice(0, n));\n` +
        `  remaining -= n;\n` +
        `}\n`,
      'utf-8',
    );
    return { name, cmd: 'node', args: [emitFile] };
  }

  function sleepStep(name, ms) {
    const dir = mkdtempSync(join(tmpdir(), 'f1997e7c8-sleep-'));
    const emitFile = join(dir, 'sleep.cjs').replace(/\\/g, '/');
    writeFileSync(emitFile, `setTimeout(() => process.stdout.write('done\\n'), ${ms});`, 'utf-8');
    return { name, cmd: 'node', args: [emitFile] };
  }

  it('a step that overflows MAX_BUFFER_BYTES surfaces output_exceeded at BOTH the top level and the per-step entry', () => {
    const result = runVerify({
      runId: 'r1',
      dbPath,
      commandOverrides: {
        ...SAFE_OPTIONAL_OVERRIDES,
        test: bigOutputStep('test', MAX_BUFFER_BYTES + 5 * 1024 * 1024),
      },
    });
    assert.equal(result.output_exceeded, true,
      'pre-fix: the top-level aggregate was dropped by commands/verify.js');
    assert.equal(result.timed_out, false);

    const testStep = result.steps.find(s => s.name === 'test');
    assert.ok(testStep, 'the test step must be present in the returned steps array');
    assert.equal(testStep.output_exceeded, true,
      'pre-fix: per-step output_exceeded was dropped by the steps.map() in commands/verify.js');
    assert.equal(testStep.timed_out, false);
  });

  it('a step that genuinely times out surfaces timed_out at BOTH the top level and the per-step entry, NOT output_exceeded', () => {
    const result = runVerify({
      runId: 'r1',
      dbPath,
      commandOverrides: {
        ...SAFE_OPTIONAL_OVERRIDES,
        test: { ...sleepStep('test', 3000), timeoutMs: 200 },
      },
    });
    assert.equal(result.timed_out, true,
      'pre-fix: the top-level aggregate was dropped by commands/verify.js');
    assert.equal(result.output_exceeded, false);

    const testStep = result.steps.find(s => s.name === 'test');
    assert.equal(testStep.timed_out, true,
      'pre-fix: per-step timed_out was dropped by the steps.map() in commands/verify.js');
    assert.equal(testStep.output_exceeded, false);
  });
});
