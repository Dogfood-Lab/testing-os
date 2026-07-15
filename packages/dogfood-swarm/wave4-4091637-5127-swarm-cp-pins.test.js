/**
 * wave4-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 4 (health-amend-a) of run swarm-1784091637-5127.
 *
 * NAMING NOTE: `wave4-swarm-cp-pins.test.js` already exists at this path from
 * an unrelated earlier run (different findings; the wave number is an
 * in-repo coincidence). Disambiguated with the run's epoch-derived slug,
 * mirroring wave2-4091637-5127-swarm-cp-pins.test.js's naming from wave 2 of
 * this same run.
 *
 * TEST PLACEMENT: this domain (swarm-cp-verbs) owns
 * packages/dogfood-swarm/commands/** + cli.js; package-root *.test.js belongs
 * to swarm-cp-tests. That domain is ownership_class `bridge`
 * (globs: packages/dogfood-swarm/*.test.js), and lib/domains.js#checkOwnership
 * admits a file with no exclusive `owned` claimant that matches a bridge glob
 * as valid — `bridge via swarm-cp-tests`. Writing regression pins here is
 * therefore lawful by the frozen map's own design, not an exception: it is
 * what `bridge` (coordinator-approved) exists for. Verified, not assumed —
 * a live checkOwnership probe against this wave returns zero violations for
 * this file. It also has to be here: every discoverable test location for
 * this package is `node --test "*.test.js" "lib/*.test.js"` (package.json),
 * so a test placed under commands/ would never be collected — the vacuous-
 * test disease this wave exists to cure.
 *
 * The first two blocks close the SAME class of gap: a library function
 * correctly implements `opts.force`, and its own thrown error message
 * advertises a way to pass it — but the CLI verb that prints that message
 * never parses `--force`, so the escape hatch it names is unreachable. The
 * PRE-EXISTING coverage for both call sites (COORD-002's "--force overrides
 * the refusal" test in wave2-4091637-5127-swarm-cp-pins.test.js:166, and
 * f-60309675-unfreeze-failed-wave.test.js's "documented force escape hatch"
 * test) calls the JS function directly with `{ force: true }` — proving the
 * LIBRARY honors force, not that the CLI wires it. A regression that deletes
 * `--force` parsing from cli.js keeps every one of those tests green. These
 * tests instead drive `node cli.js` as a real subprocess (runCli, mirroring
 * stageC-swarm-cli-operator-signal.test.js's harness) so that exact
 * regression fails loud here.
 *
 * The third block is the same disease in a different organ — a recorded
 * fact (waves.dispatch_sha) that the isolated code path re-derives instead
 * of reading. See its own header for the fixture trap.
 *
 *   F-058f4d54  `swarm resume <run-id> --force` threads force through to
 *               resume()'s COORD-002 guard (resume.js:204)
 *   F-b66306c5  `swarm domains <run-id> --unfreeze --reason "." --force`
 *               threads force through to unfreezeDomains() (lib/domains.js:723)
 *   F-COORD-DIFFBASE  collect + revalidate prefer waves.dispatch_sha as the
 *               committed-delta base on the ISOLATED path too, instead of
 *               re-deriving it via merge-base against run.branch
 */

import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { transitionAgent } from './lib/state-machine.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { revalidate } from './commands/revalidate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath, ...extraEnv },
  });
}

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

// Windows-tolerant teardown (mirrors wave2-4091637-5127-swarm-cp-pins.test.js):
// better-sqlite3's native handle release can lag the JS call by a beat, so
// rmSync stays best-effort.
function teardown(dbPath, tmp) {
  try { closeDb(dbPath); } catch { /* best-effort */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows file-lock lag */ }
}

// ──────────────────────────────────────────────────────────────
// F-058f4d54 — `swarm resume --force` actually reaches resume()'s guard
// ──────────────────────────────────────────────────────────────

describe('F-058f4d54 — `swarm resume <run-id> --force` is wired through the CLI, not just the JS API', () => {
  let tmp, dbPath, repoPath;
  const RUN_ID = 'r-f058f4d54';

  afterEach(() => { teardown(dbPath, tmp); });

  function seedDirtyIsolatedWave() {
    tmp = mkdtempSync(join(tmpdir(), 'f058f4d54-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    const sha = initGitRepo(repoPath);

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', repoPath, sha);
    saveDomainDraft(db, RUN_ID, [
      { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
    closeDb(dbPath);

    dispatch({ runId: RUN_ID, phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

    // Force the freshly-dispatched agent into a redispatchable state without
    // depending on real wall-clock timeout expiry — mirrors the pattern
    // stageC-swarm-cli-operator-signal.test.js and the wave2 pins file both
    // use to reach resume's classify-and-redispatch path deterministically.
    const db2 = openDb(dbPath);
    const ar = db2.prepare('SELECT * FROM agent_runs LIMIT 1').get();
    transitionAgent(db2, ar.id, 'failed', 'test: force redispatchable');
    closeDb(dbPath);

    // Dirty the isolated worktree — the exact state createWorktree's
    // force-remove would destroy on redispatch.
    writeFileSync(join(ar.worktree_path, 'uncommitted-agent-work.js'), '// not yet committed\n');
    return ar;
  }

  it('REFUSES over the CLI (no --force): non-zero exit, RESUME_WORKTREE_AT_RISK on stderr, file survives', () => {
    const ar = seedDirtyIsolatedWave();

    const r = runCli(['resume', RUN_ID], dbPath);

    assert.notEqual(r.status, 0,
      'a dirty --isolate worktree must make `swarm resume` exit non-zero, not silently proceed');
    assert.match(r.stderr, /RESUME_WORKTREE_AT_RISK/,
      'the refusal must surface the typed error code on stderr');
    assert.match(r.stderr, /uncommitted or unmerged/);
    assert.ok(existsSync(join(ar.worktree_path, 'uncommitted-agent-work.js')),
      'the uncommitted file must survive the refused CLI resume');

    const db = openDb(dbPath);
    const agentCount = db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n;
    closeDb(dbPath);
    assert.equal(agentCount, 1, 'no new agent_run row — the refused CLI resume touched nothing');
  });

  it('GATE: `swarm resume <run-id> --force` proceeds — this is the CLI-subprocess proof the JS-API-only test cannot give', () => {
    const ar = seedDirtyIsolatedWave();

    // Precondition, driven through the SAME CLI seam: without --force this
    // exact fixture refuses. This is not asserted again above only to keep
    // each `it` independent (fresh tmp/db per seed call).
    const refused = runCli(['resume', RUN_ID], dbPath);
    assert.notEqual(refused.status, 0, 'precondition: the undirtied-by-force fixture must refuse first');

    const forced = runCli(['resume', RUN_ID, '--force'], dbPath);

    assert.doesNotMatch(forced.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${forced.stderr}`);
    // F-058f4d54 regression: pre-fix, cmdResume read only args[0] and never
    // parsed --force, so this second call was IDENTICAL to the first —
    // same refusal, same exit code, --force silently discarded.
    assert.equal(forced.status, 0,
      `F-058f4d54 regression: --force must reach resume()'s COORD-002 guard and let redispatch proceed; ` +
      `got exit ${forced.status}\nstdout:\n${forced.stdout}\nstderr:\n${forced.stderr}`);
    assert.match(forced.stdout, /Action: redispatched/,
      'a successful --force resume must report the redispatched action');

    const db = openDb(dbPath);
    const agentCount = db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n;
    closeDb(dbPath);
    assert.equal(agentCount, 2,
      '--force must insert a new agent_run row for the redispatched candidate');
  });
});

// ──────────────────────────────────────────────────────────────
// F-b66306c5 — `swarm domains --unfreeze --force` actually reaches
// unfreezeDomains()'s guard
// ──────────────────────────────────────────────────────────────

describe('F-b66306c5 — `swarm domains <run-id> --unfreeze --reason "." --force` is wired through the CLI', () => {
  let tmp, dbPath;
  const RUN_ID = 'r-fb66306c5';

  afterEach(() => { teardown(dbPath, tmp); });

  function seedInFlightWave(waveStatus) {
    tmp = mkdtempSync(join(tmpdir(), 'fb66306c5-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, ?)")
      .run(RUN_ID, waveStatus);
    closeDb(dbPath);
  }

  it('REFUSES over the CLI (no --force): non-zero exit, "in flight" on stderr', () => {
    seedInFlightWave('failed');

    const r = runCli(['domains', RUN_ID, '--unfreeze', '--reason', 'operator reason'], dbPath);

    assert.notEqual(r.status, 0,
      'unfreezing a run whose latest wave is "failed" must refuse without --force');
    assert.match(r.stderr, /in flight/i);
  });

  it('GATE: `--unfreeze --reason "." --force` proceeds — the CLI-subprocess proof the JS-API-only test cannot give', () => {
    seedInFlightWave('failed');

    const refused = runCli(['domains', RUN_ID, '--unfreeze', '--reason', 'operator reason'], dbPath);
    assert.notEqual(refused.status, 0, 'precondition: without --force this fixture must refuse first');

    const forced = runCli(
      ['domains', RUN_ID, '--unfreeze', '--reason', 'operator halted by hand', '--force'],
      dbPath,
    );

    assert.doesNotMatch(forced.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${forced.stderr}`);
    // F-b66306c5 regression: pre-fix, cmdDomains's --unfreeze branch called
    // unfreezeDomains(db, runId, reason) with exactly three arguments — no
    // opts object, so --force had nowhere to go and this call was IDENTICAL
    // to the refused one above.
    assert.equal(forced.status, 0,
      `F-b66306c5 regression: --force must reach unfreezeDomains()'s in-flight guard and let unfreeze proceed; ` +
      `got exit ${forced.status}\nstdout:\n${forced.stdout}\nstderr:\n${forced.stderr}`);
    assert.match(forced.stdout, /unfrozen/i);
  });

  it('control: unfreezing a run with NO in-flight wave still needs no --force (not regressed)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'fb66306c5-control-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
    closeDb(dbPath);

    const r = runCli(['domains', RUN_ID, '--unfreeze', '--reason', 'no wave in flight'], dbPath);
    assert.equal(r.status, 0, `unfreezing with no in-flight wave must not require --force; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /unfrozen/i);
  });
});

// ──────────────────────────────────────────────────────────────
// F-COORD-DIFFBASE — the ISOLATED committed-delta probe prefers the
// recorded waves.dispatch_sha over re-deriving a base via merge-base
// ──────────────────────────────────────────────────────────────
//
// THE FIXTURE TRAP (this is why the pre-existing coverage let it ship):
// resolveWorktreeBaseRef is `git merge-base <run.branch> HEAD`, which equals
// the dispatch-time HEAD ONLY IF the worktrees forked from run.branch's tip.
// A fixture that dispatches while `main` IS at HEAD therefore cannot fail —
// merge-base and dispatch_sha agree and the test is green against broken and
// fixed code alike. wave4-swarm-cp-pins.test.js's own F-0e55b5ca block is
// exactly that shape twice over: both its tests call dispatch() with NO
// `isolate: true`, so the fix that ADDED the dispatch_sha column tested only
// the non-isolated branch and never probed the isolated one.
//
// These fixtures instead reproduce the real failure observed on run
// swarm-1784091637-5127 wave 4: `main` stays pinned at the seed commit while
// the wave's work is committed to a FEATURE BRANCH, so HEAD is somewhere
// run.branch does not point. merge-base(worktree, main) then silently returns
// where the feature branch diverged (the stale seed), and the committed-delta
// diff attributes every prior wave's landed file to whichever agent is being
// collected — 335 phantom ownership violations across 6 agents, for edits
// none of them made (measured: backend diffed to 114 files against the
// merge-base vs 6 against dispatch_sha).
describe('F-COORD-DIFFBASE — isolated collect uses waves.dispatch_sha, not merge-base(run.branch, HEAD)', () => {
  let tmp, dbPath, repoPath, seedSha;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'coord-diffbase-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    // The domain files must be TRACKED in the seed commit. `git status
    // --porcelain` collapses an untracked directory to a single `?? packages/`
    // entry rather than listing files under it — a fixture that creates
    // packages/ fresh therefore reports the bare directory (out of every
    // domain's globs) and manufactures a phantom violation that has nothing
    // to do with the diff base. The real repo has packages/ tracked, so the
    // probe sees ` M packages/a/src/foo.js`. Seed to match.
    mkdirSync(join(repoPath, 'packages', 'a', 'src'), { recursive: true });
    mkdirSync(join(repoPath, 'packages', 'b', 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'packages', 'a', 'src', 'foo.js'), 'seed a\n');
    writeFileSync(join(repoPath, 'packages', 'b', 'src', 'bar.js'), 'seed b\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-q', '-m', 'seed domain files']);
    seedSha = git(repoPath, ['rev-parse', 'HEAD']).trim();
  });
  afterEach(() => { teardown(dbPath, tmp); });

  function setupRun(runId, { commitSha } = {}) {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(runId, 'org/repo', repoPath, commitSha || seedSha);
    saveDomainDraft(db, runId, [
      { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, runId);
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
       description, recommendation, status)
      VALUES (?, 'F-A-001', 'fp-a-1', 'HIGH', 'quality', 'packages/a/src/foo.js', 10, 'A finding', 'fix A1', 'approved')`)
      .run(runId);
    closeDb(dbPath);
  }

  function writeAmendOutput(path, domain, filesChanged) {
    writeFileSync(path, JSON.stringify({
      domain,
      summary: 'done',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: filesChanged,
    }));
  }

  /**
   * Land a prior wave's commit on a FEATURE BRANCH, leaving `main` pinned at
   * the seed. Returns the feature-branch HEAD — the sha a subsequent dispatch
   * records as dispatch_sha and forks its worktrees from.
   */
  function landPriorWaveOnFeatureBranch() {
    git(repoPath, ['checkout', '-q', '-b', 'swarm/health-amend-a-1784091637']);
    // Out-of-domain files, exactly the shape backend was falsely flagged for.
    mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repoPath, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    writeFileSync(join(repoPath, 'README.md'), 'wave-2 edited this\n');
    writeFileSync(join(repoPath, 'HANDOFF.md'), 'wave-2 wrote this\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-q', '-m', 'wave-2 health amend']);
    return git(repoPath, ['rev-parse', 'HEAD']).trim();
  }

  it('GATE: an isolated agent is NOT charged with a prior wave\'s files when HEAD is off run.branch', () => {
    setupRun('r-diffbase', { commitSha: seedSha });
    const featureHead = landPriorWaveOnFeatureBranch();

    dispatch({ runId: 'r-diffbase', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-diffbase' ORDER BY wave_number DESC LIMIT 1").get();
    const ar = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').get(wave.id);
    closeDb(dbPath);

    // Preconditions — these are what make the fixture non-vacuous. If any of
    // them stops holding, merge-base and dispatch_sha would agree and this
    // test would go permanently, silently green.
    assert.equal(wave.dispatch_sha, featureHead,
      'precondition: the wave must record the feature-branch HEAD as its dispatch base');
    assert.notEqual(wave.dispatch_sha, seedSha,
      'precondition: dispatch_sha must differ from the stale init-time commit_sha');
    const mergeBase = git(ar.worktree_path, ['merge-base', 'main', 'HEAD']).trim();
    assert.equal(mergeBase, seedSha,
      'precondition (THE BUG): merge-base(main, HEAD) returns the STALE seed, not the dispatch point — ' +
      'this is the value the pre-fix isolated path used as its diff base');

    // The agent edits ONLY its own in-domain file, and reports it honestly.
    writeFileSync(join(ar.worktree_path, 'packages', 'a', 'src', 'foo.js'), 'the agent\'s only edit\n');

    const outA = join(tmp, 'a.json');
    writeAmendOutput(outA, 'domain-a', ['packages/a/src/foo.js']);
    const report = collect({ runId: 'r-diffbase', dbPath, outputs: { 'domain-a': outA } });

    // F-COORD-DIFFBASE regression: pre-fix, baseRef = merge-base = seedSha, so
    // the committed-delta diff picked up .github/workflows/ci.yml, README.md
    // and HANDOFF.md — the PRIOR wave's commit — and charged them to this
    // agent as out-of-domain edits.
    assert.deepEqual(report.violations, [],
      `F-COORD-DIFFBASE regression: the prior wave's committed files were attributed to this agent as ` +
      `ownership violations. Got: ${JSON.stringify(report.violations)}`);

    const agentReport = report.agents.find(a => a.domain === 'domain-a');
    assert.notEqual(agentReport.status, 'ownership_violation',
      'the agent must not be transitioned to ownership_violation for edits it never made');

    const db2 = openDb(dbPath);
    const claims = db2.prepare(`
      SELECT fc.file_path, fc.violation FROM file_claims fc
      JOIN agent_runs ar ON fc.agent_run_id = ar.id
      WHERE ar.wave_id = ?
    `).all(wave.id);
    closeDb(dbPath);
    assert.deepEqual(claims.map(c => c.file_path).sort(), ['packages/a/src/foo.js'],
      'only the agent\'s OWN edit may be claimed — the prior wave\'s files must not be INSERTed under this agent\'s identity');
  });

  it('control: a same-branch wave (main IS the dispatch point) still attributes correctly', () => {
    // The shape the pre-existing tests used — merge-base and dispatch_sha
    // agree here, so this passes before AND after the fix. Its job is to
    // prove the fix did not break the ordinary case, not to catch the bug.
    setupRun('r-samebranch', { commitSha: seedSha });
    dispatch({ runId: 'r-samebranch', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-samebranch' ORDER BY wave_number DESC LIMIT 1").get();
    const ar = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').get(wave.id);
    closeDb(dbPath);

    writeFileSync(join(ar.worktree_path, 'packages', 'a', 'src', 'foo.js'), 'in-domain edit\n');

    const outA = join(tmp, 'a.json');
    writeAmendOutput(outA, 'domain-a', ['packages/a/src/foo.js']);
    const report = collect({ runId: 'r-samebranch', dbPath, outputs: { 'domain-a': outA } });

    assert.deepEqual(report.violations, [], 'an ordinary same-branch isolated wave must still collect clean');
  });

  it('control: an out-of-domain edit IS still caught under the dispatch_sha base (the gate did not go vacuous)', () => {
    // Anti-vacuity: preferring dispatch_sha must not blind the probe. Same
    // off-branch fixture as the GATE test, but the agent genuinely writes
    // outside its domain — that MUST still be a violation.
    setupRun('r-realviol', { commitSha: seedSha });
    landPriorWaveOnFeatureBranch();
    dispatch({ runId: 'r-realviol', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-realviol' ORDER BY wave_number DESC LIMIT 1").get();
    const ar = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').get(wave.id);
    closeDb(dbPath);

    writeFileSync(join(ar.worktree_path, 'packages', 'b', 'src', 'bar.js'), 'domain-a trespassing on domain-b\n');

    const outA = join(tmp, 'a.json');
    writeAmendOutput(outA, 'domain-a', ['packages/b/src/bar.js']);
    const report = collect({ runId: 'r-realviol', dbPath, outputs: { 'domain-a': outA } });

    assert.ok(report.violations.some(v => v.file === 'packages/b/src/bar.js'),
      'a REAL out-of-domain edit must still be caught — the dispatch_sha base must not make the gate vacuous');
  });

  it('control: a legacy wave with dispatch_sha NULL still falls back to the merge-base derivation', () => {
    // Back-compat: waves dispatched before the v8 column exists carry a NULL
    // dispatch_sha. Those must keep the historical behavior rather than
    // crashing or diffing against undefined.
    setupRun('r-legacy', { commitSha: seedSha });
    dispatch({ runId: 'r-legacy', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-legacy' ORDER BY wave_number DESC LIMIT 1").get();
    db.prepare('UPDATE waves SET dispatch_sha = NULL WHERE id = ?').run(wave.id);
    const ar = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').get(wave.id);
    closeDb(dbPath);

    writeFileSync(join(ar.worktree_path, 'packages', 'a', 'src', 'foo.js'), 'in-domain edit\n');

    const outA = join(tmp, 'a.json');
    writeAmendOutput(outA, 'domain-a', ['packages/a/src/foo.js']);
    const report = collect({ runId: 'r-legacy', dbPath, outputs: { 'domain-a': outA } });

    assert.deepEqual(report.violations, [],
      'a legacy NULL-dispatch_sha wave must still collect via the merge-base fallback');
  });

  // revalidate is the operator's recovery verb for an agent collect blocked as
  // ownership_violation. It re-runs the SAME probe against the SAME base, so it
  // carried the identical stale-base defect — meaning the documented recovery
  // path reproduced the very phantom violations it exists to clear, and the
  // operator had no lawful way forward. Fixing collect alone would leave that
  // dead end intact, so the mirror fix gets its own probe rather than riding on
  // collect's (the untested-sibling-path pattern is what produced this finding).
  it('GATE: revalidate\'s re-probe also uses dispatch_sha — the recovery verb clears a phantom block instead of re-refusing', () => {
    setupRun('r-reval', { commitSha: seedSha });
    landPriorWaveOnFeatureBranch();
    dispatch({ runId: 'r-reval', phase: 'health-amend-a', dbPath, outputDir: tmp, isolate: true });

    const db = openDb(dbPath);
    const wave = db.prepare("SELECT * FROM waves WHERE run_id = 'r-reval' ORDER BY wave_number DESC LIMIT 1").get();
    const ar = db.prepare('SELECT * FROM agent_runs WHERE wave_id = ?').get(wave.id);
    // Stand the agent in the state collect's phantom violations put it in.
    transitionAgent(db, ar.id, 'ownership_violation', 'fixture: blocked by the phantom stale-base violations');
    closeDb(dbPath);

    writeFileSync(join(ar.worktree_path, 'packages', 'a', 'src', 'foo.js'), 'the agent\'s only edit\n');

    const outA = join(tmp, 'a.json');
    writeAmendOutput(outA, 'domain-a', ['packages/a/src/foo.js']);
    const report = revalidate({
      runId: 'r-reval', dbPath, outputs: { 'domain-a': outA },
      reason: 'clearing the phantom stale-base violations', apply: false,
    });

    assert.deepEqual(report.refusals, [],
      `F-COORD-DIFFBASE regression (revalidate): the recovery verb re-derived the same stale base and ` +
      `refused on the prior wave's files, leaving the operator no lawful path forward. ` +
      `Got: ${JSON.stringify(report.refusals)}`);
    assert.ok(report.repairs.some(r => r.domain === 'domain-a'),
      'the honest agent must be repairable to complete');
  });
});
