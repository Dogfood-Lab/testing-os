/**
 * wave2-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 2 of run swarm-1784091637-5127 (health-amend-a).
 *
 * NAMING NOTE: an earlier run already used the bare `wave2-swarm-cp-pins.test.js`
 * name for an unrelated wave's pins (different run, different findings, same
 * numeric wave-in-run coincidence). This file is disambiguated by the run's
 * epoch-derived slug (matches the worktree/swarms/ dir naming this run
 * already uses) so it cannot collide with or be confused for that file.
 *
 * CROSS-DOMAIN NOTE (see this agent's output.json cross_domain_notes): the
 * frozen map for this wave splits `packages/dogfood-swarm/commands/**` +
 * `cli.js` (this domain, swarm-cp-verbs) from `packages/dogfood-swarm/*.test.js`
 * (swarm-cp-tests). Every discoverable test location for this package
 * (`node --test "*.test.js" "lib/*.test.js"` per package.json) is therefore
 * outside this domain's nominal glob. The Coordinator's explicit ruling
 * (this wave, in-session): write the tests anyway at package root — a test
 * placed under commands/ would be silently orphaned (never discovered),
 * which is the exact vacuous-test disease this wave exists to cure. This
 * file is declared in files_changed and the ownership gap is named in
 * cross_domain_notes so collect-time checkOwnership() sees it coming.
 *
 * One describe block per finding, written test-first against the pre-fix
 * behavior (each verified RED against the unmodified commands/*.js before
 * the corresponding production fix; F-a5f6b585/F-ad3004f4 have their own,
 * more extensive suite in redrive.test.js — not duplicated here).
 *
 *   COORD-002  resume redispatch refuses to force-destroy a dirty/unmerged
 *              --isolate worktree without --force
 *   COORD-003  status computes agent staleness read-only (no mutation)
 *   F-6d0e966c resume redispatch prompts carry ownershipClass + domainSnapshotId
 *   F-16bab049 collect refuses an unknown --domain=<name>:<path> key
 *   F-18a5579c adjudicate writes receipts under the run-scoped swarms/<run>/ dir
 *   F-5dabf101 the six JSON-purity verbs never process.exit() past a pending write
 *   F-fa047531 adjudicate gets --dry-run and the deleteAdjudication compensator (--undo)
 *   F-a7eb2d09 adjudicate validates every flag before any work runs
 *   F-21240958 persist's ingest shell-out uses the argv-array form, never a shell string
 *   F-d2025a4d clean refuses an in-flight wave and gates dirty/unmerged worktrees behind --force
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb, openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { transitionAgent } from './lib/state-machine.js';
import { transitionWave } from './lib/wave-state-machine.js';
import { dispatch } from './commands/dispatch.js';
import { resume } from './commands/resume.js';
import { status } from './commands/status.js';
import { collect } from './commands/collect.js';
import { clean } from './commands/clean.js';
import { previewAdjudicate, undoAdjudication } from './commands/adjudicate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = readFileSync(join(__dirname, 'cli.js'), 'utf-8');
const PERSIST_SRC = readFileSync(join(__dirname, 'commands', 'persist.js'), 'utf-8');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t.t']);
  git(repoPath, ['config', 'user.name', 't']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoPath, '.gitignore'), '.swarm/\n');
  writeFileSync(join(repoPath, 'README.md'), 'seed\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'seed']);
  return git(repoPath, ['rev-parse', 'HEAD']).trim();
}

/**
 * Windows-tolerant teardown (mirrors redrive.test.js / clean-worktree-
 * lifecycle.test.js): openDb() pools ONE connection per path, shared by
 * this file's own DB reads AND every internal openDb(dbPath) call the
 * functions under test make — a single closeDb releases it for everyone.
 * better-sqlite3's native handle release can lag the JS call by a beat on
 * Windows, so rmSync is still wrapped defensively (best-effort; a leaked
 * mkdtemp dir in the OS temp root is harmless).
 */
/**
 * Strip block + line comments so a source-text scan does not false-positive
 * on prose that happens to mention the pattern it is checking for (this
 * file's own fix comments explain the process.exit() -> process.exitCode
 * migration BY NAME, which would otherwise self-trigger the F-5dabf101
 * scan below). Mirrors redrive.test.js#stripCommentsForGrep.
 */
import { stripComments } from './test-support/strip-comments.js';

function teardown(dbPath, tmp) {
  try { closeDb(dbPath); } catch { /* best-effort */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows file-lock lag */ }
}

function setupRun(dbPath, repoPath, runId, { commitSha, domains } = {}) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(runId, 'org/repo', repoPath, commitSha || 'a'.repeat(40));
  saveDomainDraft(db, runId, domains || [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);
  closeDb(dbPath);
}

// ──────────────────────────────────────────────────────────────
// COORD-002 — resume refuses to force-destroy a dirty/unmerged worktree
// ──────────────────────────────────────────────────────────────

describe('COORD-002 — resume redispatch refuses a dirty --isolate worktree without --force', () => {
  let tmp, dbPath, repoPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'coord002-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    const sha = initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-c002', { commitSha: sha });
    dispatch({ runId: 'r-c002', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });
  });
  afterEach(() => { teardown(dbPath, tmp); });

  it('REFUSES and mutates NOTHING when the predecessor worktree has uncommitted edits', () => {
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT * FROM agent_runs LIMIT 1').get();
    closeDb(dbPath);
    // Dirty the isolated worktree — the exact state createWorktree's force-
    // remove would destroy.
    writeFileSync(join(ar.worktree_path, 'uncommitted-agent-work.js'), '// not yet committed\n');

    assert.throws(
      () => resume({ runId: 'r-c002', dbPath, outputDir: tmp, nowMs: Date.now() + 24 * 60 * 60 * 1000 }),
      (err) => err.code === 'RESUME_WORKTREE_AT_RISK' && /uncommitted or unmerged/.test(err.message),
      'a dirty --isolate worktree must refuse the redispatch, not silently destroy it',
    );

    // Prevention, not detection: the file must still be there, and no new
    // agent_run row was inserted.
    assert.ok(existsSync(join(ar.worktree_path, 'uncommitted-agent-work.js')),
      'the uncommitted file must survive the refused resume');
    const db2 = openDb(dbPath);
    const agentCount = db2.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n;
    closeDb(dbPath);
    assert.equal(agentCount, 1, 'no new agent_run row — resume touched nothing on refusal');
  });

  it('--force overrides the refusal and proceeds (operator-accepted loss)', () => {
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT * FROM agent_runs LIMIT 1').get();
    closeDb(dbPath);
    writeFileSync(join(ar.worktree_path, 'uncommitted-agent-work.js'), '// not yet committed\n');

    const report = resume({
      runId: 'r-c002', dbPath, outputDir: tmp, force: true,
      nowMs: Date.now() + 24 * 60 * 60 * 1000,
    });
    assert.equal(report.action, 'redispatched');
  });

  it('control: a CLEAN --isolate worktree redispatches normally with no --force needed', () => {
    // Same fixture, but the worktree is never dirtied — isolates the guard
    // from the redispatch mechanism itself.
    const report = resume({
      runId: 'r-c002', dbPath, outputDir: tmp,
      nowMs: Date.now() + 24 * 60 * 60 * 1000,
    });
    assert.equal(report.action, 'redispatched');
    assert.ok(report.redispatch.length >= 1);
  });
});

// ──────────────────────────────────────────────────────────────
// COORD-003 — status computes agent staleness read-only
// ──────────────────────────────────────────────────────────────

describe('COORD-003 — status detects a past-timeout in-flight agent without mutating it', () => {
  function seedDispatchedAgent(dbPath, { startedAt, timeoutMs = 1800000 } = {}) {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, timeout_policy_ms)
      VALUES ('r-c003', 'org/r', '/tmp/x', ?, 'main', 'pending', ?)`).run('a'.repeat(40), timeoutMs);
    saveDomainDraft(db, 'r-c003', [{ name: 'domain-a', globs: ['a/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r-c003');
    const dom = db.prepare("SELECT id FROM domains WHERE run_id = 'r-c003'").get();
    const w = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES ('r-c003', 'health-audit-a', 1, 'dispatched', 'snap1')`).run();
    const waveId = Number(w.lastInsertRowid);
    const ar = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'pending')`)
      .run(waveId, dom.id);
    const agentRunId = Number(ar.lastInsertRowid);
    transitionAgent(db, agentRunId, 'dispatched', 'seed');
    if (startedAt) {
      db.prepare('UPDATE agent_runs SET started_at = ? WHERE id = ?').run(startedAt, agentRunId);
    }
    closeDb(dbPath);
    return { waveId, agentRunId };
  }

  let tmp, dbPath;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'coord003-'));
    dbPath = join(tmp, 'control-plane.db');
  });
  afterEach(() => { teardown(dbPath, tmp); });

  it('GATE: an agent dispatched well past the timeout policy is reported [stale] — RED against pre-fix status()', () => {
    const wellPast = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    seedDispatchedAgent(dbPath, { startedAt: wellPast, timeoutMs: 30 * 60 * 1000 }); // 30min timeout

    const s = status({ runId: 'r-c003', dbPath });

    assert.equal(s.agents.length, 1);
    assert.equal(s.agents[0].stale, true,
      'an agent started 2h ago against a 30min timeout policy must be reported stale — ' +
      'this is the exact subtraction pre-fix status() held both inputs for and never performed');
    assert.equal(s.agentSummary.stalePastTimeout, 1);
    assert.match(s.assessment.nextAction, /past the timeout policy/,
      'the IN PROGRESS nextAction must name the stale count, not just "run swarm resume to check timeouts"');
  });

  it('an agent well WITHIN the timeout policy is NOT reported stale', () => {
    const justNow = new Date(Date.now() - 60 * 1000).toISOString(); // 1min ago
    seedDispatchedAgent(dbPath, { startedAt: justNow, timeoutMs: 30 * 60 * 1000 });

    const s = status({ runId: 'r-c003', dbPath });
    assert.equal(s.agents[0].stale, false);
    assert.equal(s.agentSummary.stalePastTimeout, 0);
  });

  it('status() NEVER mutates the agent_run row — it is a pure read (unlike resume/applyTimeoutPolicy)', () => {
    const wellPast = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { agentRunId } = seedDispatchedAgent(dbPath, { startedAt: wellPast, timeoutMs: 30 * 60 * 1000 });

    status({ runId: 'r-c003', dbPath });

    const db = openDb(dbPath);
    const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunId);
    closeDb(dbPath);
    assert.equal(row.status, 'dispatched',
      'status() must never transition a stale agent to timed_out — that mutation belongs to resume alone');
  });
});

// ──────────────────────────────────────────────────────────────
// F-6d0e966c — resume redispatch prompts carry ownershipClass + domainSnapshotId
// ──────────────────────────────────────────────────────────────

describe('F-6d0e966c — resume redispatch prompt carries ownershipClass + domainSnapshotId', () => {
  it('the redispatched prompt names the ownership class and the frozen snapshot id (parity with dispatch)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'f6d0e966c-'));
    const dbPath = join(tmp, 'control-plane.db');
    const repoPath = join(tmp, 'repo');
    try {
      const sha = initGitRepo(repoPath);
      setupRun(dbPath, repoPath, 'r-6d0e', { commitSha: sha, domains: [
        { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
      ] });
      dispatch({ runId: 'r-6d0e', phase: 'health-amend-a', dbPath, outputDir: tmp });

      const report = resume({
        runId: 'r-6d0e', dbPath, outputDir: tmp,
        nowMs: Date.now() + 24 * 60 * 60 * 1000,
      });
      assert.equal(report.action, 'redispatched');
      assert.ok(report.redispatch.length >= 1);

      const prompt = readFileSync(report.redispatch[0].promptPath, 'utf-8');
      assert.match(prompt, /Ownership class: `owned`/,
        'F-6d0e966c: pre-fix the redispatch prompt silently dropped ownershipClass');
      assert.match(prompt, /Domain snapshot ID: `[a-f0-9-]+`/,
        'F-6d0e966c: pre-fix the prompt promised "the snapshot ID below is the audit anchor" with none below it');
    } finally {
      teardown(dbPath, tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// F-16bab049 — collect refuses an unknown --domain= key
// ──────────────────────────────────────────────────────────────

describe('F-16bab049 — collect refuses a --domain=<name>:<path> whose name matches no domain', () => {
  let tmp, dbPath, repoPath;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'f16bab049-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    const sha = initGitRepo(repoPath);
    setupRun(dbPath, repoPath, 'r-typo', { commitSha: sha, domains: [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ] });
    dispatch({ runId: 'r-typo', phase: 'health-amend-a', dbPath, outputDir: tmp });
  });
  afterEach(() => { teardown(dbPath, tmp); });

  it('GATE: a typo\'d domain name refuses loudly and mutates NOTHING (wave stays dispatched)', () => {
    const outPath = join(tmp, 'out.json');
    writeFileSync(outPath, JSON.stringify({ domain: 'backnd', summary: 'x', fixes: [], files_changed: [] }));

    assert.throws(
      () => collect({ runId: 'r-typo', dbPath, outputs: { backnd: outPath } }),
      (err) => err.code === 'COLLECT_UNKNOWN_DOMAIN' && /backnd/.test(err.message) && /backend/.test(err.message),
      'pre-fix: the typo silently vanished, the real "backend" agent was marked failed, and the wave flipped to failed',
    );

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT status FROM waves WHERE run_id = 'r-typo'").get();
    const agent = db.prepare("SELECT status FROM agent_runs").get();
    closeDb(dbPath);
    assert.equal(wave.status, 'dispatched', 'the wave must NOT flip to failed on a CLI typo — it is re-collectable immediately');
    assert.equal(agent.status, 'dispatched', 'the real agent must not be falsely marked failed for an unrelated typo');
  });

  it('control: the CORRECT domain name still collects normally', () => {
    const outPath = join(tmp, 'out.json');
    writeFileSync(outPath, JSON.stringify({ domain: 'backend', summary: 'x', fixes: [], files_changed: [] }));
    const report = collect({ runId: 'r-typo', dbPath, outputs: { backend: outPath } });
    assert.equal(report.waveStatusAfter, 'collected');
  });
});

// ──────────────────────────────────────────────────────────────
// F-18a5579c — adjudicate writes receipts under the run-scoped dir
// ──────────────────────────────────────────────────────────────

describe('F-18a5579c — cmdAdjudicate passes the run-scoped output dir, not the swarms/ root', () => {
  it('source scan: cmdAdjudicate builds swarmDir from getOutputDir(runId), not dirname(getDbPath())', () => {
    const cmdAdjudicateBody = CLI_SRC.slice(
      CLI_SRC.indexOf('async function cmdAdjudicate'),
      CLI_SRC.indexOf('\nfunction cmdAdvance'),
    );
    assert.match(cmdAdjudicateBody, /const swarmDir = getOutputDir\(runId\);/,
      'pre-fix: swarmDir = dirname(getDbPath()) wrote every run\'s receipts into one flat swarms/adjudications/ dir');
    assert.doesNotMatch(cmdAdjudicateBody, /const swarmDir = dirname\(getDbPath\(\)\);/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-5dabf101 — the six JSON-purity verbs never process.exit() past a pending write
// ──────────────────────────────────────────────────────────────

describe('F-5dabf101 — cmdVerify/cmdVerifyFixed/cmdVerifyRecurring/cmdVerifyUnverified/cmdVerifyApproved/cmdFindings use process.exitCode, not process.exit()', () => {
  it('GATE: none of the six functions calls process.exit() after their console.log(payload) line', () => {
    const sites = [
      ['cmdVerify', /function cmdVerify\(args\)/, /\nfunction cmdVerifyFixed/],
      ['cmdVerifyFixed', /function cmdVerifyFixed\(args\)/, /\nfunction cmdVerifyRecurring/],
      ['cmdVerifyRecurring', /function cmdVerifyRecurring\(args\)/, /\nfunction cmdVerifyUnverified/],
      ['cmdVerifyUnverified', /function cmdVerifyUnverified\(args\)/, /\nfunction cmdVerifyApproved/],
      ['cmdVerifyApproved', /function cmdVerifyApproved\(args\)/, /\nfunction cmdReceipt/],
      ['cmdFindings', /function cmdFindings\(args\)/, /\nfunction cmdRuns/],
    ];
    for (const [name, startRe, endRe] of sites) {
      const start = CLI_SRC.search(startRe);
      assert.ok(start >= 0, `could not locate ${name} — pin is stale`);
      const end = CLI_SRC.slice(start).search(endRe) + start;
      // Comments stripped BEFORE scanning — this file's own fix comments
      // narrate the process.exit() -> process.exitCode migration by name
      // ("NOT process.exit()"), which would otherwise false-positive the
      // very check those comments are explaining.
      const body = stripComments(CLI_SRC.slice(start, end > start ? end : undefined));
      // The Usage-error early exit (`if (!runId) { ...; process.exit(1); }`)
      // is fine — nothing has been written to stdout yet at that point. The
      // finding is specifically about exit() racing a PENDING payload
      // write, so the assertion targets the payload-bearing tail only.
      const usageGuard = 'process.exit(1);';
      const guardIdx = body.indexOf(usageGuard);
      assert.ok(guardIdx >= 0, `${name}: expected a Usage-guard process.exit(1); — pin is stale`);
      const afterUsageGuard = body.slice(guardIdx + usageGuard.length);
      assert.doesNotMatch(afterUsageGuard, /process\.exit\(/,
        `${name}: found a process.exit() call after the Usage guard — must be process.exitCode (+ implicit/explicit return) so pending stdout writes drain`);
      assert.match(body, /process\.exitCode\s*=/,
        `${name}: expected a process.exitCode assignment`);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// F-fa047531 — adjudicate --dry-run preview + --undo compensator
// ──────────────────────────────────────────────────────────────

// Real fixture, matching case-file-adjudicate-cmd.test.js's convention —
// fixtures/case-files/ is the canonical repo-root fixture dir; a hand-rolled
// stub case-file fails the real neutrality gate (assertCaseFileClean), which
// previewAdjudicate deliberately runs for real (see below).
const CASE_FILE_FIXTURES = join(__dirname, '..', '..', 'fixtures', 'case-files');
const VALID_CASE_FILE = JSON.parse(readFileSync(join(CASE_FILE_FIXTURES, 'valid', 'well-formed-auth-fix.json'), 'utf-8'));
const BIASING_CASE_FILE = JSON.parse(readFileSync(join(CASE_FILE_FIXTURES, 'lint', 'verdict-leak-in-criterion.json'), 'utf-8'));

function setupAdjudicateRun(db, runId = 'r1') {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);
  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
  ).run(runId);
  return { runId, waveId: Number(wave.lastInsertRowid) };
}

describe('F-fa047531 — adjudicate --dry-run preview (previewAdjudicate)', () => {
  it('resolves the wave, runs the REAL neutrality gate, and reports seats/tier WITHOUT persisting anything', () => {
    const db = openMemoryDb();
    const { runId } = setupAdjudicateRun(db);

    const preview = previewAdjudicate(db, {
      runId,
      caseFile: VALID_CASE_FILE,
      seats: [{ family: 'qwen', model: 'qwen3.6' }],
      tier: 'local',
      cloud: false,
    });

    assert.equal(preview.dryRun, true);
    assert.ok(preview.criteriaCount > 0);
    assert.equal(preview.seats.length, 1);
    assert.equal(preview.billed, false);

    const count = db.prepare('SELECT COUNT(*) AS n FROM adjudications').get().n;
    assert.equal(count, 0, '--dry-run must never write an adjudications row — the pre-fix verb had NO preview at all before spending (--cloud) and mutating');
  });

  it('a biasing case-file is refused by --dry-run too — the SAME fail-closed gate, before anything is spent', () => {
    const db = openMemoryDb();
    const { runId } = setupAdjudicateRun(db);

    assert.throws(
      () => previewAdjudicate(db, {
        runId,
        caseFile: BIASING_CASE_FILE,
        seats: [{ family: 'qwen', model: 'qwen3.6' }],
      }),
      (err) => err.name === 'CaseFileNeutralityError',
      'a case-file that leaks a verdict must be refused by the preview too, not just the apply path',
    );
  });
});

describe('F-fa047531 — adjudicate --undo compensator (undoAdjudication)', () => {
  function seedAdjudication(db) {
    const { waveId } = setupAdjudicateRun(db);
    const a = db.prepare(`INSERT INTO adjudications (wave_id, run_id, overall, authority, panel_size, seats)
      VALUES (?, 'r1', 'corroborate', 'advisory', 1, '["qwen"]')`).run(waveId);
    return { waveId, adjudicationId: Number(a.lastInsertRowid) };
  }

  it('GATE: pre-fix, this compensator was wired to NOTHING reachable from the CLI — now dry-run previews, --apply removes', () => {
    const db = openMemoryDb();
    const { adjudicationId } = seedAdjudication(db);

    // F-482629a9 (wave 6): undoAdjudication now REQUIRES and enforces runId —
    // seedAdjudication hardcodes the adjudication's run_id as 'r1' (matching
    // setupAdjudicateRun's default), so 'r1' here is the correct, same-run
    // scope, not a new behavior under test (that lives in
    // wave6-4091637-5127-swarm-cp-pins.test.js alongside the other wave-6 fixes).
    const dry = undoAdjudication(db, { adjudicationId, apply: false, runId: 'r1' });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.removed, false);
    const stillThere = db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE id = ?').get(adjudicationId).n;
    assert.equal(stillThere, 1, 'dry-run must not remove the row');

    const applied = undoAdjudication(db, { adjudicationId, apply: true, runId: 'r1' });
    assert.equal(applied.removed, true);
    const goneNow = db.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE id = ?').get(adjudicationId).n;
    assert.equal(goneNow, 0, '--apply must remove the row — the compensator lib/adjudication-store.js#deleteAdjudication documents');
  });

  it('throws ADJUDICATION_NOT_FOUND for an unknown id (no raw-SQL-surgery footgun)', () => {
    const db = openMemoryDb();
    seedAdjudication(db);
    // No runId needed here: the NOT_FOUND check (row lookup) runs BEFORE the
    // F-482629a9 run-scope check, so an unknown id is refused for the same
    // reason regardless of runId.
    assert.throws(
      () => undoAdjudication(db, { adjudicationId: 99999, apply: true }),
      (err) => err.code === 'ADJUDICATION_NOT_FOUND',
    );
  });
});

// ──────────────────────────────────────────────────────────────
// F-a7eb2d09 — adjudicate validates every flag before any work runs
// ──────────────────────────────────────────────────────────────

describe('F-a7eb2d09 — cmdAdjudicate parses --format before runAdjudicate, not after', () => {
  it('source order: parseFormatFlag(args) appears BEFORE the runAdjudicate( call, not after', () => {
    const cmdAdjudicateBody = CLI_SRC.slice(
      CLI_SRC.indexOf('async function cmdAdjudicate'),
      CLI_SRC.indexOf('\nfunction cmdAdvance'),
    );
    const formatIdx = cmdAdjudicateBody.indexOf('const format = parseFormatFlag(args);');
    const runAdjudicateCallIdx = cmdAdjudicateBody.indexOf('await runAdjudicate(');
    assert.ok(formatIdx >= 0, 'parseFormatFlag(args) call not found — pin is stale');
    assert.ok(runAdjudicateCallIdx >= 0, 'runAdjudicate( call not found — pin is stale');
    assert.ok(formatIdx < runAdjudicateCallIdx,
      'pre-fix: --format was validated AFTER runAdjudicate had already dispatched the (slow, possibly billed) jury and persisted a row');
  });
});

// ──────────────────────────────────────────────────────────────
// F-21240958 — persist's ingest shell-out uses the argv-array form
// ──────────────────────────────────────────────────────────────

describe('F-21240958 — persist.js ingest call never builds a shell command string', () => {
  it('GATE: no execSync( call in persist.js — execFileSync with an argv array only', () => {
    // Assert against CODE, not raw bytes. This gate scanned the whole file including
    // comments, so wave 20's correction of persist.js's own header prose — which names
    // `execSync(` while describing the discipline it documents — tripped it. That is the
    // false-grant class this repo spent waves 16-20 eliminating from the pin matcher
    // (prose in a non-code position read as code), living inside one of its own pins.
    const persistCode = stripComments(PERSIST_SRC);
    assert.doesNotMatch(persistCode, /execSync\(/,
      'pre-fix: execSync(`node "${ingestScript}" --provenance=stub --file "${submissionPath}"`) interpolated ' +
      'two attacker-adjacent values (SWARM_DB-derived outputDir, the run-id positional) into a shell command string');
    assert.match(persistCode, /execFileSync\('node', \[ingestScript, '--provenance=stub', '--file', submissionPath\]/,
      'expected the argv-array form used by every other subprocess call in this package (dispatch.js, lib/worktree.js)');
  });
});

// ──────────────────────────────────────────────────────────────
// F-d2025a4d — clean refuses in-flight waves and gates dirty worktrees on --force
// ──────────────────────────────────────────────────────────────

describe('F-d2025a4d(a) — clean --apply refuses while the run has an in-flight wave', () => {
  it('GATE: --apply on a dispatched wave throws CLEAN_WAVE_IN_FLIGHT and removes NOTHING', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fd2025a4d-inflight-'));
    const dbPath = join(tmp, 'control-plane.db');
    const repoPath = join(tmp, 'repo');
    try {
      const sha = initGitRepo(repoPath);
      setupRun(dbPath, repoPath, 'r-inflight', { commitSha: sha });
      dispatch({ runId: 'r-inflight', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

      assert.throws(
        () => clean({ runId: 'r-inflight', dbPath, apply: true }),
        (err) => err.code === 'CLEAN_WAVE_IN_FLIGHT',
        'pre-fix: clean --apply force-destroyed worktrees a live wave\'s agents may still be editing, with no gate at all',
      );

      const db = openDb(dbPath);
      const dom = db.prepare("SELECT worktree_path FROM agent_runs LIMIT 1").get();
      closeDb(dbPath);
      assert.ok(existsSync(dom.worktree_path), 'the in-flight wave\'s worktree must survive the refused clean');
    } finally {
      teardown(dbPath, tmp);
    }
  });

  it('control: dry-run preview still works on an in-flight wave (only --apply refuses)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fd2025a4d-inflight-dry-'));
    const dbPath = join(tmp, 'control-plane.db');
    const repoPath = join(tmp, 'repo');
    try {
      const sha = initGitRepo(repoPath);
      setupRun(dbPath, repoPath, 'r-inflight2', { commitSha: sha });
      dispatch({ runId: 'r-inflight2', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

      const report = clean({ runId: 'r-inflight2', dbPath });
      assert.equal(report.dryRun, true);
      assert.equal(report.total, 1);
    } finally {
      teardown(dbPath, tmp);
    }
  });
});

describe('F-d2025a4d(b) — clean --apply skips dirty/unmerged worktrees unless --force', () => {
  it('GATE: a DIRTY worktree is SKIPPED by --apply alone, removed only with --apply --force', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fd2025a4d-dirty-'));
    const dbPath = join(tmp, 'control-plane.db');
    const repoPath = join(tmp, 'repo');
    try {
      const sha = initGitRepo(repoPath);
      setupRun(dbPath, repoPath, 'r-dirty', { commitSha: sha });
      dispatch({ runId: 'r-dirty', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });
      const db = openDb(dbPath);
      const ar = db.prepare('SELECT worktree_path FROM agent_runs LIMIT 1').get();
      closeDb(dbPath);
      writeFileSync(join(ar.worktree_path, 'uncommitted.js'), '// dirty\n');
      // Wave must not be in-flight for clean's (a) gate to let us reach (b) —
      // collect it out of 'dispatched' first via a direct transition so this
      // test isolates the dirty-gate behavior from the in-flight gate above.
      const db2 = openDb(dbPath);
      const wave = db2.prepare("SELECT id FROM waves WHERE run_id = 'r-dirty'").get();
      transitionWave(db2, wave.id, 'collected', 'test: force past in-flight for isolation');
      closeDb(dbPath);

      const applyOnly = clean({ runId: 'r-dirty', dbPath, apply: true });
      assert.equal(applyOnly.removed, 0, '--apply alone must SKIP the dirty worktree, not destroy it');
      assert.equal(applyOnly.skippedAtRisk, 1);
      assert.ok(existsSync(join(ar.worktree_path, 'uncommitted.js')), 'the uncommitted file must survive --apply without --force');

      const applyForce = clean({ runId: 'r-dirty', dbPath, apply: true, force: true });
      assert.equal(applyForce.removed, 1, '--apply --force must remove the dirty worktree');
    } finally {
      teardown(dbPath, tmp);
    }
  });
});
