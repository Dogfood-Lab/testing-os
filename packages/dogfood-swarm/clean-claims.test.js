/**
 * clean-claims.test.js — `swarm clean-claims <run-id>` coverage.
 *
 * The phantom-claims recovery verb: violation=1 file_claims rows stranded on
 * TERMINAL waves (the live 2026-07-15 incident: 346 rows on run
 * swarm-1784091637-5127's advanced waves 2+4 that collect / revalidate /
 * redrive could all lawfully refuse to touch). Dry-run by default, --apply
 * --reason to delete, count-guarded tx, domain_events audit row, scope
 * invariants (violation=0 rows + other runs' rows untouched, the
 * agent_state_events trail untouched).
 *
 * NON-NEGOTIABLE CORDONED-TEST DISCIPLINE (mirrors redrive.test.js /
 * clean-worktree-lifecycle.test.js): every test seeds a fresh fixture
 * control-plane.db via mkdtempSync — never the live shared control-plane.db.
 * afterEach closes + rmSync's the fixture (Windows-tolerant).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { cleanClaims, formatCleanClaims } from './commands/clean-claims.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

// ──────────────────────────────────────────────────────────────
// F-c653f331 mutation-proof helpers — load a MODIFIED COPY of
// clean-claims.js so the two in-tx safety nets (CLEAN_CLAIMS_COUNT_MISMATCH
// / CLEAN_CLAIMS_SCOPE_VIOLATION) can be forced to fire for real. Mirrors
// redrive.test.js's receipt-byte-identity proof-gate technique (the house
// pattern for this class of guard): relative imports are rewritten to
// absolute file:// URLs pointing at the REAL sibling modules, so the mutant
// exercises the real DB layer / state machine / logStage — only the patched
// text differs from production.
// ──────────────────────────────────────────────────────────────
const CLEAN_CLAIMS_PATH = join(__dirname, 'commands', 'clean-claims.js');
const CLEAN_CLAIMS_SRC = readFileSync(CLEAN_CLAIMS_PATH, 'utf-8');
const CLEAN_CLAIMS_DIR = dirname(CLEAN_CLAIMS_PATH);

function rewriteRelativeImportsToAbsolute(src, fromDir) {
  return src.replace(/from '(\.\.?\/[^']+)'/g, (_m, spec) => {
    return `from '${pathToFileURL(resolvePath(fromDir, spec)).href}'`;
  });
}

async function loadCleanClaimsMutant(mutatedSrc, tag) {
  const mutantDir = mkdtempSync(join(tmpdir(), `clean-claims-mutant-${tag}-`));
  const mutantPath = join(mutantDir, `clean-claims-mutant-${tag}.mjs`);
  writeFileSync(mutantPath, mutatedSrc, 'utf-8');
  try {
    return await import(pathToFileURL(mutantPath).href);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

/**
 * Load clean-claims.js with an extra DELETE injected right after `claimIds`
 * is computed — simulating "a concurrent writer moved the rows between the
 * planning pass and this tx" (the count-guard's own doc comment,
 * clean-claims.js:348-351). Throws if the anchor literal isn't found, so a
 * future refactor of this line cannot silently turn this into a no-op
 * mutant that always "passes".
 */
async function importCleanClaimsWithSimulatedConcurrentDelete() {
  const marker = 'const claimIds = eligible.flatMap(g => g.claims.map(c => c.id));';
  assert.ok(CLEAN_CLAIMS_SRC.includes(marker), 'claimIds literal not found — mutant patch is stale, update it');
  const injected = marker + `
    db.prepare('DELETE FROM file_claims WHERE id = ?').run(claimIds[0]);`;
  const mutatedSrc = rewriteRelativeImportsToAbsolute(CLEAN_CLAIMS_SRC.replace(marker, injected), CLEAN_CLAIMS_DIR);
  assert.notEqual(mutatedSrc, CLEAN_CLAIMS_SRC, 'mutant source must differ from the real module');
  return loadCleanClaimsMutant(mutatedSrc, 'count-mismatch');
}

/**
 * Load clean-claims.js with the sweep query's `AND fc.violation = 1` filter
 * removed, widening eligibility to violation=0 rows. This is the wave-7
 * auditor's own validated technique for tripping
 * CLEAN_CLAIMS_SCOPE_VIOLATION for real (not just neutering the guard) — see
 * finding F-c653f331's text for the exact thrown message this reproduces.
 */
async function importCleanClaimsWithWidenedSweep() {
  const marker = '      AND fc.violation = 1\n';
  assert.ok(CLEAN_CLAIMS_SRC.includes(marker), 'violation=1 sweep filter not found — mutant patch is stale, update it');
  const mutatedSrc = rewriteRelativeImportsToAbsolute(CLEAN_CLAIMS_SRC.replace(marker, ''), CLEAN_CLAIMS_DIR);
  assert.notEqual(mutatedSrc, CLEAN_CLAIMS_SRC, 'mutant source must differ from the real module');
  return loadCleanClaimsMutant(mutatedSrc, 'scope-violation');
}

const RUN_A = 'swarm-ccfix-aaa-01';
const RUN_B = 'swarm-ccfix-bbb-02';

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

/**
 * Seed a control-plane DB exercising every jurisdiction branch:
 *
 *   RUN_A
 *     wave 1 'advanced'  (terminal)         — a1 backend 'complete': 3×violation=1 + 2×violation=0  → ELIGIBLE
 *                                             a2 tests   'complete': 2×violation=1                  → ELIGIBLE
 *     wave 2 'dispatched' (non-terminal)    — a3 backend 'complete': 2×violation=1                  → REFUSED (collect)
 *     wave 3 'aborted_for_rewind' (terminal)— a4 tests   'aborted_for_rewind': 1×violation=1        → ELIGIBLE
 *                                             a6 backend 'complete': 1×violation=0 only             → absent everywhere
 *     wave 4 'advanced'  (terminal, LATEST) — a5 backend 'ownership_violation' (latest-per-domain):
 *                                             1×violation=1                                         → REFUSED (revalidate)
 *   RUN_B
 *     wave 1 'advanced'  (terminal)         — b1 backend 'complete': 2×violation=1 → other-run rows, never touched
 *
 * a1 carries a 2-row agent_state_events chain whose tail is the revalidate
 * override — the superseding evidence the dry-run must surface.
 */
function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'clean-claims-'));
  const dbPath = join(root, 'control-plane.db');
  const db = openDb(dbPath);

  const insRun = db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)');
  insRun.run(RUN_A, 'org/repo-a', root, 'a'.repeat(40));
  insRun.run(RUN_B, 'org/repo-b', root, 'b'.repeat(40));

  const insDomain = db.prepare("INSERT INTO domains (run_id, name, globs) VALUES (?, ?, ?)");
  const dBackendA = insDomain.run(RUN_A, 'backend', '["packages/backend/**"]').lastInsertRowid;
  const dTestsA = insDomain.run(RUN_A, 'tests', '["packages/tests/**"]').lastInsertRowid;
  const dBackendB = insDomain.run(RUN_B, 'backend', '["packages/backend/**"]').lastInsertRowid;

  const insWave = db.prepare('INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, ?)');
  const w1 = insWave.run(RUN_A, 'health-amend-a', 1, 'advanced').lastInsertRowid;
  const w2 = insWave.run(RUN_A, 'health-amend-b', 2, 'dispatched').lastInsertRowid;
  const w3 = insWave.run(RUN_A, 'health-amend-c', 3, 'aborted_for_rewind').lastInsertRowid;
  const w4 = insWave.run(RUN_A, 'stage-d-amend', 4, 'advanced').lastInsertRowid;
  const wB1 = insWave.run(RUN_B, 'health-amend-a', 1, 'advanced').lastInsertRowid;

  const insAgent = db.prepare('INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, ?)');
  const a1 = insAgent.run(w1, dBackendA, 'complete').lastInsertRowid;
  const a2 = insAgent.run(w1, dTestsA, 'complete').lastInsertRowid;
  const a3 = insAgent.run(w2, dBackendA, 'complete').lastInsertRowid;
  const a4 = insAgent.run(w3, dTestsA, 'aborted_for_rewind').lastInsertRowid;
  const a6 = insAgent.run(w3, dBackendA, 'complete').lastInsertRowid;
  const a5 = insAgent.run(w4, dBackendA, 'ownership_violation').lastInsertRowid;
  const b1 = insAgent.run(wB1, dBackendB, 'complete').lastInsertRowid;

  const insClaim = db.prepare(
    "INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation) VALUES (?, ?, 'edit', ?, ?)"
  );
  // a1: the wave-2-incident shape — violation rows a revalidate repair superseded
  insClaim.run(a1, 'packages/tests/phantom-1.js', dBackendA, 1);
  insClaim.run(a1, 'packages/tests/phantom-2.js', dBackendA, 1);
  insClaim.run(a1, 'packages/tests/phantom-3.js', dBackendA, 1);
  insClaim.run(a1, 'packages/backend/real-1.js', dBackendA, 0);
  insClaim.run(a1, 'packages/backend/real-2.js', dBackendA, 0);
  // a2: eligible sibling on the same terminal wave, different domain
  insClaim.run(a2, 'packages/backend/phantom-4.js', dTestsA, 1);
  insClaim.run(a2, 'packages/backend/phantom-5.js', dTestsA, 1);
  // a3: non-terminal wave — collect's jurisdiction
  insClaim.run(a3, 'packages/tests/inflight-1.js', dBackendA, 1);
  insClaim.run(a3, 'packages/tests/inflight-2.js', dBackendA, 1);
  // a4: aborted_for_rewind wave — terminal, eligible
  insClaim.run(a4, 'packages/backend/aborted-1.js', dTestsA, 1);
  // a6: violation=0 only — must appear nowhere
  insClaim.run(a6, 'packages/backend/clean-1.js', dBackendA, 0);
  // a5: blocked agent, latest-per-domain, on the run's LATEST wave — revalidate's reach
  insClaim.run(a5, 'packages/tests/blocked-1.js', dBackendA, 1);
  // b1: sibling run — isolation watch-set
  insClaim.run(b1, 'packages/backend/other-run-1.js', dBackendB, 1);
  insClaim.run(b1, 'packages/backend/other-run-2.js', dBackendB, 1);

  const insEvent = db.prepare(
    'INSERT INTO agent_state_events (agent_run_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)'
  );
  insEvent.run(a1, 'dispatched', 'ownership_violation', 'Out-of-domain edits: packages/tests/phantom-1.js');
  insEvent.run(a1, 'ownership_violation', 'complete', 'revalidate: corrected domain map — coordinator-authorized cross-domain test writes');

  return {
    root, dbPath,
    domains: { dBackendA, dTestsA, dBackendB },
    waves: { w1, w2, w3, w4, wB1 },
    agents: { a1, a2, a3, a4, a5, a6, b1 },
  };
}

function countClaims(db, where = '1=1', ...params) {
  return db.prepare(`SELECT COUNT(*) AS n FROM file_claims WHERE ${where}`).get(...params).n;
}

// F-eb35de79: `id` is AUTOINCREMENT (db/schema.js:116) so a re-inserted row
// never recovers its old id — the round-trip proof below compares this
// id-free shape, not the raw table rows.
function snapshotClaims(db, agentRunIds) {
  const placeholders = agentRunIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT agent_run_id, file_path, claim_type, domain_id, violation FROM file_claims ` +
    `WHERE agent_run_id IN (${placeholders}) ORDER BY agent_run_id, file_path`
  ).all(...agentRunIds);
}

let fixtures = [];
function teardownAll() {
  for (const fx of fixtures) {
    try { closeDb(fx.dbPath); } catch { /* best-effort */ }
    try { rmSync(fx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  fixtures = [];
}
function fixture() {
  const fx = setupFixture();
  fixtures.push(fx);
  return fx;
}

afterEach(teardownAll);

describe('clean-claims — required-parameter contract', () => {
  it('throws when run-id is missing', () => {
    assert.throws(() => cleanClaims({ dbPath: '/x.db' }), /run-id.*required/);
  });

  it('throws when dbPath is missing (no implicit default)', () => {
    assert.throws(() => cleanClaims({ runId: 'r1', dbPath: '' }), /dbPath.*required/);
  });

  it('throws RUN_NOT_FOUND for an unknown run', () => {
    const fx = fixture();
    assert.throws(
      () => cleanClaims({ runId: 'swarm-doesnotexist', dbPath: fx.dbPath }),
      (err) => err.code === 'RUN_NOT_FOUND',
    );
  });

  it('--apply without --reason throws and deletes nothing', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    const before = countClaims(db);
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true }),
      /--reason.*required with --apply/,
    );
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: '   ' }),
      /--reason.*required with --apply/,
    );
    assert.equal(countClaims(db), before, 'no row leaves disk without a reason');
  });

  it('rejects malformed --wave / --agent-run values', () => {
    const fx = fixture();
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, wave: 'two' }),
      /--wave must be a positive integer/,
    );
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, agentRun: '-3' }),
      /--agent-run must be a positive integer/,
    );
  });
});

describe('clean-claims — dry-run by default', () => {
  it('lists eligible + refused groups and deletes NOTHING', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    const before = countClaims(db);

    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });

    assert.equal(report.dryRun, true);
    assert.equal(report.apply, false);
    assert.equal(report.totals.deleted, 0);
    assert.equal(report.scope_invariants_verified, false, 'dry-run never claims a verified apply');

    // Eligible: a1 (3 rows, advanced wave), a2 (2 rows, advanced wave),
    // a4 (1 row, aborted_for_rewind wave).
    const eligibleIds = report.eligible.map(g => g.agent_run_id).sort((x, y) => x - y);
    assert.deepEqual(eligibleIds, [fx.agents.a1, fx.agents.a2, fx.agents.a4].sort((x, y) => x - y));
    assert.equal(report.totals.claims_eligible, 6);
    assert.ok(report.eligible.every(g => g.applied === false));

    assert.equal(countClaims(db), before, 'dry-run mutates nothing');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE event_type = 'file_claims_cleaned'").get().n,
      0,
      'dry-run writes no audit row',
    );
  });

  it('surfaces the superseding agent_state_events evidence per eligible group', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });

    const g1 = report.eligible.find(g => g.agent_run_id === fx.agents.a1);
    assert.equal(g1.evidence.event_count, 2);
    assert.equal(g1.evidence.last_event.to_status, 'complete');
    assert.match(g1.evidence.last_event.reason, /^revalidate:/,
      'the tail of the untouched audit chain is the evidence that supersedes the claims');

    const text = formatCleanClaims(report);
    assert.match(text, /\[would delete\]/);
    assert.match(text, /revalidate: corrected domain map/);
    assert.match(text, /packages\/tests\/phantom-1\.js/);
  });

  it('an agent_run with only violation=0 claims appears nowhere', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });
    const everywhere = [
      ...report.eligible.map(g => g.agent_run_id),
      ...report.refused.map(g => g.agent_run_id),
    ];
    assert.ok(!everywhere.includes(fx.agents.a6),
      'violation=0 rows are out of scope entirely — not even listed');
  });
});

describe('clean-claims — jurisdiction refusals', () => {
  it('refuses rows on a non-terminal wave, naming collect', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });

    const r3 = report.refused.find(r => r.agent_run_id === fx.agents.a3);
    assert.ok(r3, 'dispatched-wave rows are refused');
    assert.equal(r3.correct_verb, 'collect');
    assert.equal(r3.claim_count, 2);
    assert.match(r3.reason, /collect's jurisdiction/);
  });

  it('refuses a blocked agent on the run\'s latest terminal wave, naming revalidate', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });

    const r5 = report.refused.find(r => r.agent_run_id === fx.agents.a5);
    assert.ok(r5, 'blocked agent on the latest wave is refused');
    assert.equal(r5.correct_verb, 'revalidate');
    assert.match(r5.reason, /revalidate/);
  });

  it('refuses a failed wave, naming revalidate-or-redrive', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    db.prepare("UPDATE waves SET status = 'failed' WHERE id = ?").run(fx.waves.w2);

    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });
    const r3 = report.refused.find(r => r.agent_run_id === fx.agents.a3);
    assert.equal(r3.correct_verb, 'revalidate-or-redrive');
  });

  it('refuses a collected (non-terminal) wave, naming redrive', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    db.prepare("UPDATE waves SET status = 'collected' WHERE id = ?").run(fx.waves.w2);

    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath });
    const r3 = report.refused.find(r => r.agent_run_id === fx.agents.a3);
    assert.equal(r3.correct_verb, 'redrive');
  });

  it('refused rows survive an --apply untouched', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);

    cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'test sweep' });

    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a3), 2, 'collect-jurisdiction rows intact');
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a5), 1, 'revalidate-jurisdiction rows intact');
  });
});

describe('clean-claims — exact-count apply', () => {
  it('deletes exactly the eligible violation=1 rows, with a restorable audit record', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM agent_state_events').get().n;
    // F-eb35de79: captured BEFORE the apply so the round-trip proof below has
    // an authoritative pre-delete shape to compare against — not re-derived
    // from the deleted-rows payload itself (that would be a mirror test).
    const affectedAgentRunIds = [fx.agents.a1, fx.agents.a2, fx.agents.a4];
    const preDeleteSnapshot = snapshotClaims(db, affectedAgentRunIds);
    assert.equal(preDeleteSnapshot.length, 8, 'sanity: a1 (3×v1 + 2×v0) + a2 (2×v1) + a4 (1×v1)');

    const report = cleanClaims({
      runId: RUN_A, dbPath: fx.dbPath, apply: true,
      reason: 'phantom rows superseded by corrected passes (fixture)',
    });

    assert.equal(report.dryRun, false);
    assert.equal(report.totals.deleted, 6, 'exactly the 6 eligible rows');
    assert.equal(report.scope_invariants_verified, true);
    assert.ok(report.eligible.every(g => g.applied === true));
    assert.equal(report.reasonRecorded, 'clean-claims: phantom rows superseded by corrected passes (fixture)');

    // The eligible groups' rows are gone; everything else survives byte-for-byte.
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a1), 2, 'a1 keeps its violation=0 rows');
    assert.equal(countClaims(db, 'agent_run_id = ? AND violation = 1', fx.agents.a1), 0);
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a2), 0);
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a4), 0);
    assert.equal(countClaims(db, 'violation = 0'), 3, 'all violation=0 rows intact (a1×2 + a6×1)');
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.b1), 2, 'other run untouched');

    // agent_state_events is the audit trail — untouched by doctrine.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_state_events').get().n, eventsBefore);

    // One domain_events audit row per affected domain (backend: a1's 3;
    // tests: a2's 2 + a4's 1), restorable payload.
    const events = db.prepare(
      "SELECT * FROM domain_events WHERE event_type = 'file_claims_cleaned' ORDER BY domain_id"
    ).all();
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.reason === 'clean-claims: phantom rows superseded by corrected passes (fixture)'));
    const backendEvent = events.find(e => e.domain_id === Number(fx.domains.dBackendA));
    const payload = JSON.parse(backendEvent.old_value);
    assert.equal(payload.deleted_count, 3);
    assert.deepEqual(payload.agent_runs, [fx.agents.a1]);
    assert.deepEqual(payload.waves, [1]);
    assert.equal(payload.rows.length, 3);
    assert.ok(payload.rows.every(r =>
      r.agent_run_id === fx.agents.a1 && r.violation === 1 &&
      typeof r.file_path === 'string' && typeof r.domain_id === 'number'
    ), 'old_value carries the full deleted rows — re-insertable compensator');
    assert.deepEqual(JSON.parse(backendEvent.new_value), { violation_claims_remaining: 3 },
      'a3 (2, refused) + a5 (1, refused) still hold backend violation rows');

    // F-eb35de79: the assertion above only checks payload SHAPE. Actually
    // perform the round-trip the comment claims is possible — capture
    // old_value across BOTH domain_events rows (backend's 3 + tests' 3),
    // re-insert every row, and diff the restored table against the
    // pre-delete snapshot instead of re-deriving an expected value from the
    // payload itself.
    const testsEvent = events.find(e => e.domain_id === Number(fx.domains.dTestsA));
    const allDeletedRows = [...payload.rows, ...JSON.parse(testsEvent.old_value).rows];
    assert.equal(allDeletedRows.length, 6, 'sanity: every deleted row is captured across both domain_events rows');

    const insertRow = db.prepare(
      'INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation) VALUES (?, ?, ?, ?, ?)'
    );
    for (const r of allDeletedRows) {
      insertRow.run(r.agent_run_id, r.file_path, r.claim_type, r.domain_id, r.violation);
    }
    const restoredSnapshot = snapshotClaims(db, affectedAgentRunIds);
    assert.deepEqual(restoredSnapshot, preDeleteSnapshot,
      'old_value must be genuinely re-insertable — the restored set must match the pre-delete snapshot field-for-field, not just carry fields of the right shape');
  });

  it('is idempotent — a second apply finds nothing eligible and deletes 0', () => {
    const fx = fixture();
    cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'first pass' });
    const second = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'second pass' });

    assert.equal(second.totals.deleted, 0);
    assert.equal(second.eligible.length, 0);
    assert.equal(second.refused.length, 2, 'the refused groups are still there, still refused');
    assert.equal(second.scope_invariants_verified, false, 'no tx ran — no vacuous verified claim');
  });
});

describe('clean-claims — scope filters', () => {
  it('--wave narrows to that wave_number within the run', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, wave: '1' });

    assert.deepEqual(
      report.eligible.map(g => g.agent_run_id).sort((x, y) => x - y),
      [fx.agents.a1, fx.agents.a2].sort((x, y) => x - y),
    );
    assert.equal(report.refused.length, 0, 'wave 2/4 groups are outside the filter');
    assert.equal(report.filters.wave, 1);
  });

  it('--wave that does not exist in this run throws WAVE_NOT_FOUND', () => {
    const fx = fixture();
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, wave: 99 }),
      (err) => err.code === 'WAVE_NOT_FOUND',
    );
  });

  it('--agent-run narrows to one agent_run', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    const report = cleanClaims({
      runId: RUN_A, dbPath: fx.dbPath, agentRun: fx.agents.a1,
      apply: true, reason: 'surgical single-agent clean',
    });

    assert.equal(report.totals.deleted, 3);
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a2), 2, 'sibling eligible group untouched under the filter');
  });

  it('--agent-run addressing another run\'s agent throws AGENT_RUN_NOT_IN_RUN', () => {
    const fx = fixture();
    const db = openDb(fx.dbPath);
    const before = countClaims(db);
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, agentRun: fx.agents.b1, apply: true, reason: 'x' }),
      (err) => err.code === 'AGENT_RUN_NOT_IN_RUN',
    );
    assert.equal(countClaims(db), before, 'the loud refusal mutates nothing');
  });

  it('--agent-run that does not exist throws AGENT_RUN_NOT_FOUND', () => {
    const fx = fixture();
    assert.throws(
      () => cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, agentRun: 999999 }),
      (err) => err.code === 'AGENT_RUN_NOT_FOUND',
    );
  });
});

describe('clean-claims — CLI surface', () => {
  it('no args prints the Usage error and exits 1', () => {
    const fx = fixture();
    const r = runCli(['clean-claims'], fx.dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: swarm clean-claims/);
  });

  it('--apply without --reason exits 1 with the reason-required error', () => {
    const fx = fixture();
    const r = runCli(['clean-claims', RUN_A, '--apply'], fx.dbPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--reason.*required with --apply/);
  });

  it('dry-run via the CLI prints the preview and exits 0', () => {
    const fx = fixture();
    const r = runCli(['clean-claims', RUN_A], fx.dbPath);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Clean-claims \(DRY-RUN\)/);
    assert.match(r.stdout, /\[would delete\]/);
    assert.match(r.stdout, /Dry-run only — re-run with --apply --reason/);
  });

  it('--format=json emits the structured report', () => {
    const fx = fixture();
    const r = runCli(['clean-claims', RUN_A, '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.totals.claims_eligible, 6);
  });

  it('the top-level help routes and documents clean-claims', () => {
    const fx = fixture();
    const help = runCli([], fx.dbPath);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /clean-claims <run-id>/);

    const verbHelp = runCli(['clean-claims', '--help'], fx.dbPath);
    assert.equal(verbHelp.status, 0);
    assert.match(verbHelp.stdout, /Dry-run by default/);
    assert.match(verbHelp.stdout, /agent_state_events audit trail is NEVER touched/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-c653f331 — mutation proof: the two in-transaction safety nets
// (CLEAN_CLAIMS_COUNT_MISMATCH / CLEAN_CLAIMS_SCOPE_VIOLATION) actually fire
// and roll back. Before this describe block, neutering both guards left all
// other tests in this file green — the pin suite provided no independent
// signal that either guard exists or fires. Mirrors redrive.test.js's
// receipt-byte-identity proof-gate pattern (patch a copy of the real source,
// import it, show the guard trips where the real module stays silent).
// ──────────────────────────────────────────────────────────────

describe('clean-claims — F-c653f331: in-tx safety nets (mutation proof)', () => {
  it('CLEAN_CLAIMS_COUNT_MISMATCH: a row removed between the eligibility read and the apply tx throws and rolls back everything else', async () => {
    const mutant = await importCleanClaimsWithSimulatedConcurrentDelete();

    const fx = fixture();
    const db = openDb(fx.dbPath);
    const before = countClaims(db);

    assert.throws(
      () => mutant.cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'mutation proof' }),
      (err) => {
        assert.equal(err.code, 'CLEAN_CLAIMS_COUNT_MISMATCH');
        assert.match(err.message, /expected to delete 6 row\(s\), deleted 5/,
          'the guard must report the actual planned-vs-deleted counts, not a generic message');
        return true;
      },
      'F-c653f331: a row that disappears between the eligibility read and the apply tx must throw, never silently under-delete',
    );

    // Rollback proof: the tx's own attempted deletes (the other 5 planned
    // rows) must be undone. Only the simulated "concurrent" delete (one row,
    // executed OUTSIDE the tx on the same connection — exactly like a real
    // concurrent writer's already-committed change) stays gone; it was never
    // part of the transaction that rolled back.
    assert.equal(countClaims(db), before - 1,
      'the tx must roll back every row IT tried to delete; only the pre-tx simulated concurrent delete persists');
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a2), 2, 'a2 untouched — not the simulated victim');
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.a4), 1, 'a4 untouched — not the simulated victim');
    assert.equal(countClaims(db, 'violation = 0'), 3, 'violation=0 rows untouched — the tx never reached the audit-write stage');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE event_type = 'file_claims_cleaned'").get().n,
      0,
      'no audit row survives a rolled-back tx',
    );
  });

  it('control: the UNMODIFIED module does not throw for the same fixture (isolates the mutant above as the cause)', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'control' });
    assert.equal(report.totals.deleted, 6);
    assert.equal(report.scope_invariants_verified, true);
  });

  it('CLEAN_CLAIMS_SCOPE_VIOLATION: a widened eligibility sweep that reaches violation=0 rows throws and rolls back everything', async () => {
    const mutant = await importCleanClaimsWithWidenedSweep();

    const fx = fixture();
    const db = openDb(fx.dbPath);
    const before = countClaims(db);

    assert.throws(
      () => mutant.cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'mutation proof' }),
      (err) => {
        assert.equal(err.code, 'CLEAN_CLAIMS_SCOPE_VIOLATION');
        assert.ok(err.message.includes('violation=0 rows 3 → 0, other-run rows 2 → 2'),
          `the re-check must name both watch-sets with their actual before/after counts; got: ${err.message}`);
        return true;
      },
      'F-c653f331: a sweep query that widens past violation=1 must throw, never silently delete violation=0 rows',
    );

    // Rollback proof: the WHOLE tx rolls back, including the 6 legitimately
    // eligible rows the widened query also would have (correctly) deleted —
    // the guard is fail-closed: one violated watch-set voids the whole apply.
    assert.equal(countClaims(db), before, 'nothing was deleted — the scope-invariant re-check fires before commit');
    assert.equal(countClaims(db, 'violation = 0'), 3, 'a1 (2) + a6 (1) violation=0 rows untouched');
    assert.equal(countClaims(db, 'agent_run_id = ?', fx.agents.b1), 2, 'other-run rows untouched');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE event_type = 'file_claims_cleaned'").get().n,
      0,
      'no audit row survives a rolled-back tx',
    );
  });

  it('control: the UNMODIFIED module does not throw for the same fixture (isolates the mutant above as the cause)', () => {
    const fx = fixture();
    const report = cleanClaims({ runId: RUN_A, dbPath: fx.dbPath, apply: true, reason: 'control' });
    assert.equal(report.totals.deleted, 6);
    assert.equal(report.scope_invariants_verified, true);
  });
});
