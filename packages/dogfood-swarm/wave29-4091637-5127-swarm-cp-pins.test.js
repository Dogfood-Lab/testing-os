/**
 * wave29-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 29 (health-amend-b, Stage C) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — the same rationale wave14's
 * and wave18's pin files already documented for this identical situation. No
 * OWNED domain's globs match `packages/dogfood-swarm/*.test.js` (swarm-cp-verbs
 * owns only `commands/**` + `cli.js`), so resolveExclusiveOwner returns null
 * and checkOwnership's bridge fallback (lib/domains.js:829-836) grants ANY
 * calling domain a valid claim. Verified for THIS wave by calling the real
 * checkOwnership against the real frozen map read-only, rather than trusting
 * the prose: this file resolves to `bridge via swarm-cp-tests` for the
 * swarm-cp-verbs agent, while `lib/domains.js` correctly resolves to a
 * violation. Correcting the record: this wave's own first-pass output.json
 * claimed these four findings could not be pinned from this domain at all.
 * That claim was wrong — it reasoned from classifyFile() (which is only about
 * which files the gate SCANS) and never checked the ownership gate that
 * actually decides what this agent may WRITE. Waves 14 and 18 of this same run
 * had already refuted it.
 *
 * Every pin here drives `node cli.js` as a REAL SUBPROCESS rather than calling
 * the underlying function. That is deliberate and is wave4's lesson in this
 * same run: its header records that the pre-existing `--force` coverage called
 * the JS API directly with `{ force: true }`, proving the LIBRARY honored the
 * flag while a regression deleting the CLI's flag parsing kept every test
 * green. Three of the four fixes below ARE the CLI/wiring layer (doctor's
 * --format plumbing, main()'s dispatch guard) or an observability side effect
 * that only exists on the real stderr stream — so the operator's actual
 * surface is the only honest vantage point.
 *
 * RED PROOF (all four): each block below was run against pre-fix HEAD by
 * stashing this wave's tracked source edits while leaving this untracked file
 * in place, then re-run after restoring them. Per-block red evidence:
 *
 *   F-c1a49594  pre-fix `doctor --format=json` printed the ASCII frame, so
 *               JSON.parse(stdout) threw; `--format=bogus` exited 0 silently.
 *   F-554bcd68  pre-fix `--help`/`-h`/`help` each exited 1; a typo'd verb
 *               printed all 238 reference lines with no "Unknown command"
 *               text anywhere in stdout+stderr.
 *   F-78a13f53  pre-fix a `--apply --force` destroy of a DIRTY worktree
 *               emitted 0 bytes on stderr — no structured event at all.
 *   F-2f10ff78  pre-fix the v2→v1 clobber of one delta path emitted only the
 *               normal start/complete pair, with no overwrite event.
 *
 * Assertions that are PRECISION GUARDS rather than red proofs (they hold both
 * before and after the fix, and exist to stop an over-correction) are marked
 * inline as such. They are deliberately not counted as this wave's evidence.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { createWorktree } from './lib/worktree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

// Never let a CLI child inherit the repo-default control-plane.db (the
// package-wide SWARM_DB pin enforced by meta-wal-sidecar-teardown-guard.test.js).
// DOGFOOD_LOG_HUMAN=0 pins the NDJSON contract regardless of ambient env: the
// human companion banner is not JSON, and a juror reading these assertions
// should not have to reason about whether stderr happened to be a TTY.
function runCli(args, dbPath, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: cwd || __dirname,
    env: { ...process.env, SWARM_DB: dbPath, DOGFOOD_LOG_HUMAN: '0' },
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Windows-tolerant teardown: a just-exited CLI child can still hold an
// OS-level lock on the sqlite -wal/-shm sidecars for a beat.
const FIXTURES = [];
function track(dir) { FIXTURES.push(dir); return dir; }
after(() => {
  for (const dir of FIXTURES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/** Parse the JSON lines out of a captured stderr stream, ignoring any non-JSON. */
function ndjson(stderr) {
  return (stderr || '').split('\n').map(l => l.trim()).filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

function stagesIn(stderr, stage) {
  return ndjson(stderr).filter(e => e.stage === stage);
}

/**
 * A real git repo + a control-plane.db beside it + one registered run — the
 * cordoned-fixture discipline clean-worktree-lifecycle.test.js established.
 * Never process.cwd(), never the real repo, never the live control plane.
 */
function setupFixture(runId) {
  const repo = track(mkdtempSync(join(tmpdir(), 'w29-verbs-fixture-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.swarm/\n', 'utf-8');
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf-8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'root']);

  const dbPath = join(repo, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/fixture', repo, 'a'.repeat(40));
  closeDb(dbPath);

  return { repo, dbPath, runId };
}

// ──────────────────────────────────────────────────────────────
// F-c1a49594 — `swarm doctor` honors --format and enum-validates it
// ──────────────────────────────────────────────────────────────

/** @pins F-c1a49594 */
describe('F-c1a49594 — `swarm doctor --format=json` is wired through the CLI and the flag is enum-validated', () => {
  const { dbPath } = setupFixture('swarm-w29doctor01');

  it('--format=json emits the parseable {checks,overallStatus,exitCode} object, not the ASCII frame', () => {
    const r = runCli(['doctor', '--format=json'], dbPath);

    // Pre-fix this threw: cmdDoctor(_args) discarded every flag and printed
    // `swarm doctor — preflight checks ...` regardless of --format.
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(r.stdout); },
      `doctor --format=json must emit pure JSON on stdout; got:\n${r.stdout.slice(0, 200)}`,
    );
    assert.ok(Array.isArray(parsed.checks), 'the JSON payload carries the structured checks array');
    assert.ok(parsed.checks.length > 0, 'a real preflight runs at least one check');
    assert.ok(
      parsed.checks.every(c => typeof c.id === 'string' && typeof c.status === 'string'),
      'every check keeps its {id,status} record shape in the JSON projection',
    );
    assert.ok(['pass', 'warn', 'fail'].includes(parsed.overallStatus), 'overallStatus is the rolled-up verdict');
    assert.equal(typeof parsed.exitCode, 'number', 'exitCode is projected for a machine consumer');
    assert.doesNotMatch(r.stdout, /preflight checks/, 'the human frame must not bleed into the JSON surface');
  });

  it('--format=<bogus> fails loud with CLI_INVALID_FORMAT instead of silently ignoring the flag', () => {
    const r = runCli(['doctor', '--format=bogus'], dbPath);

    // Pre-fix: exit 0 and a byte-identical happy report — the malformed flag
    // vanished, in contrast to every sibling gate verb's fail-loud posture.
    assert.equal(r.status, 1, `a malformed --format must exit 1; got ${r.status}`);
    assert.match(r.stderr, /CLI_INVALID_FORMAT/, 'the shared coded error surfaces on stderr');
    assert.match(r.stderr, /text\|markdown\|json/, 'the error names the accepted enum');
  });

  it('PRECISION GUARD (holds pre- and post-fix): no --format still renders the human ASCII frame', () => {
    const r = runCli(['doctor'], dbPath);
    assert.equal(r.status, 0, 'a healthy environment exits 0');
    assert.match(r.stdout, /swarm doctor — preflight checks/, 'the default surface is unchanged');
  });
});

// ──────────────────────────────────────────────────────────────
// F-554bcd68 — the top-level guard separates help from an unknown verb
// ──────────────────────────────────────────────────────────────

/** @pins F-554bcd68 */
describe('F-554bcd68 — `swarm --help` exits 0 and an unknown verb is named rather than buried in the manual', () => {
  const { dbPath } = setupFixture('swarm-w29help001');

  for (const form of ['--help', '-h', 'help']) {
    it(`\`swarm ${form}\` exits 0 (GNU/POSIX convention) and prints the reference`, () => {
      const r = runCli([form], dbPath);

      // Pre-fix every one of these exited 1, because the guard derived its
      // exit code from Boolean(command) alone — so the conventional
      // `swarm --help >/dev/null && echo available` wrapper idiom reported
      // the tool broken.
      assert.equal(r.status, 0, `\`swarm ${form}\` must exit 0; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /swarm — Truthful swarm control plane for repo work/, 'the help banner still prints');
      assert.match(r.stdout, /Commands:/, 'the command reference still prints');
    });
  }

  it('an unknown verb exits 1, names itself, and suggests the nearest real verb', () => {
    const r = runCli(['dispach', 'some-run'], dbPath);

    assert.equal(r.status, 1, 'an unrecognized verb is still an error');
    const combined = r.stdout + r.stderr;
    // Pre-fix: 238 lines of reference and zero acknowledgment — grepping the
    // whole output for any unknown-command framing matched nothing.
    assert.match(combined, /Unknown command: 'dispach'/, 'the CLI must name the token it did not recognize');
    assert.match(combined, /Did you mean `dispatch`\?/, 'the nearest registered verb is offered');
    assert.match(combined, /swarm --help/, 'the operator is pointed at the full list');
  });

  it('an unknown verb does NOT dump the entire command reference', () => {
    const r = runCli(['dispach', 'some-run'], dbPath);
    const combined = r.stdout + r.stderr;

    // The defect was not the exit code (pre-fix this already exited 1) — it
    // was that a typo produced output indistinguishable from a successful
    // help request. Anchoring on the reference's own trailing section is
    // content-shaped rather than a magic line-count budget.
    assert.doesNotMatch(combined, /Phases:/, 'the full reference must not be dumped for a typo');
    assert.ok(
      combined.split('\n').filter(Boolean).length <= 5,
      `a typo should produce a short, scannable message; got ${combined.split('\n').filter(Boolean).length} lines`,
    );
  });

  it('an unknown verb resembling nothing registered still errors cleanly, with no bogus suggestion', () => {
    const r = runCli(['zzzzzzzzzzzz'], dbPath);
    const combined = r.stdout + r.stderr;

    assert.equal(r.status, 1, 'still an error');
    assert.match(combined, /Unknown command: 'zzzzzzzzzzzz'/, 'the token is still named');
    // The distance threshold exists so an unrelated string is not "corrected"
    // into a confidently wrong verb.
    assert.doesNotMatch(combined, /Did you mean/, 'no suggestion when nothing is plausibly near');
  });

  it('PRECISION GUARD (holds pre- and post-fix): bare `swarm` remains exit-0 orientation, not an error', () => {
    const r = runCli([], dbPath);
    assert.equal(r.status, 0, 'a bare invocation is orientation surface');
    assert.match(r.stdout, /Commands:/, 'and still prints the reference');
  });
});

// ──────────────────────────────────────────────────────────────
// F-78a13f53 — clean's force-destroy leaves a durable forensic record
// ──────────────────────────────────────────────────────────────

/** @pins F-78a13f53 */
describe('F-78a13f53 — `swarm clean --apply` emits a worktree_force_cleaned record for every worktree it destroys', () => {
  it('a --force destroy of a DIRTY worktree is recorded with its path, branch, and the overridden guard', () => {
    const RUN_ID = 'swarm-w29clean01';
    const fx = setupFixture(RUN_ID);
    const wt = createWorktree(fx.repo, { runId: RUN_ID, waveNumber: 1, domainName: 'backend' });

    // Uncommitted work is exactly what --force destroys unrecoverably — the
    // case with no compensator, and therefore the case that most needs a record.
    appendFileSync(join(wt.worktreePath, 'README.md'), 'uncommitted agent work\n', 'utf-8');

    const r = runCli(['clean', RUN_ID, '--apply', '--force'], fx.dbPath);
    assert.equal(r.status, 0, `clean --apply --force should succeed; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /\[REMOVED\]/, 'precondition: the worktree was actually destroyed');

    // Pre-fix: clean.js contained zero logStage calls, so stderr was empty.
    const events = stagesIn(r.stderr, 'worktree_force_cleaned');
    assert.equal(events.length, 1, `exactly one force-clean record for one destroyed worktree; stderr:\n${r.stderr}`);

    const e = events[0];
    assert.equal(e.component, 'dogfood-swarm', 'tagged to the component, so a cross-tool log grep resolves it');
    assert.equal(e.runId, RUN_ID, 'the record names the run');
    assert.equal(e.branch, wt.branch, 'the record names the branch whose work was destroyed');
    assert.equal(e.dirty, true, 'the record states that uncommitted work was present');
    assert.equal(e.force, true, 'the record states that --force overrode the at-risk guard');
    assert.ok(String(e.worktreePath).length > 0, 'the record names the destroyed path');
  });

  it('an ordinary --apply reclaim of a CLEAN worktree is recorded too, flagged as neither dirty nor forced', () => {
    const RUN_ID = 'swarm-w29clean02';
    const fx = setupFixture(RUN_ID);
    createWorktree(fx.repo, { runId: RUN_ID, waveNumber: 1, domainName: 'backend' });

    const r = runCli(['clean', RUN_ID, '--apply'], fx.dbPath);
    assert.equal(r.status, 0, `clean --apply should succeed; stderr:\n${r.stderr}`);

    // The fix records every removal, not only the forced ones — "did anyone
    // clean this run" must be answerable even on the benign path.
    const events = stagesIn(r.stderr, 'worktree_force_cleaned');
    assert.equal(events.length, 1, 'a clean worktree reclaim is still recorded');
    assert.equal(events[0].dirty, false, 'and is honestly flagged as carrying no uncommitted work');
    assert.equal(events[0].force, false, 'and as not having overridden any guard');
  });

  it('PRECISION GUARD (holds pre- and post-fix): the dry-run preview destroys nothing and records nothing', () => {
    const RUN_ID = 'swarm-w29clean03';
    const fx = setupFixture(RUN_ID);
    createWorktree(fx.repo, { runId: RUN_ID, waveNumber: 1, domainName: 'backend' });

    const r = runCli(['clean', RUN_ID], fx.dbPath);
    assert.match(r.stdout, /DRY-RUN/, 'precondition: this is the preview path');
    assert.equal(
      stagesIn(r.stderr, 'worktree_force_cleaned').length, 0,
      'a preview that destroyed nothing must not claim a destruction in the audit stream',
    );
  });
});

// ──────────────────────────────────────────────────────────────
// F-2f10ff78 — the v1/v2 delta clobber is no longer silent
// ──────────────────────────────────────────────────────────────

/** @pins F-2f10ff78 */
describe('F-2f10ff78 — `swarm verify-fixed` records when it overwrites a delta written under the other schema', () => {
  it('a --legacy-v1 run over a v2 delta at the same path emits verify_fixed_schema_overwrite naming both schemas', () => {
    const RUN_ID = 'swarm-w29vfix001';
    const fx = setupFixture(RUN_ID);

    const first = runCli(['verify-fixed', RUN_ID, '--format=json'], fx.dbPath);
    assert.equal(first.status, 0, `v2 default run should succeed; stderr:\n${first.stderr}`);
    // Pin the premise the finding rests on: both modes target ONE path.
    const firstComplete = stagesIn(first.stderr, 'verify_fixed_complete');
    assert.equal(firstComplete.length, 1, 'precondition: the v2 run wrote a delta');

    const second = runCli(['verify-fixed', RUN_ID, '--legacy-v1', '--format=json'], fx.dbPath);
    assert.equal(second.status, 0, `--legacy-v1 run should succeed; stderr:\n${second.stderr}`);
    const secondComplete = stagesIn(second.stderr, 'verify_fixed_complete');
    assert.equal(
      secondComplete[0].delta_path, firstComplete[0].delta_path,
      'precondition: the clobber is real — both schemas target the identical path',
    );

    // Pre-fix: only the start/complete pair, with nothing recording that a
    // differently-shaped artifact had just been replaced.
    const overwrites = stagesIn(second.stderr, 'verify_fixed_schema_overwrite');
    assert.equal(overwrites.length, 1, `the clobber must be recorded; stderr:\n${second.stderr}`);
    assert.equal(overwrites[0].priorSchema, 'verify-fixed-delta/v2', 'the record names the schema that was replaced');
    assert.equal(overwrites[0].newSchema, 'verify-fixed-delta/v1', 'the record names the schema that replaced it');
    assert.equal(overwrites[0].runId, RUN_ID, 'the record names the run');
    assert.equal(overwrites[0].component, 'dogfood-swarm', 'and is greppable by component');
  });

  it('PRECISION GUARD (holds pre- and post-fix): rewriting the SAME schema is not reported as an overwrite', () => {
    const RUN_ID = 'swarm-w29vfix002';
    const fx = setupFixture(RUN_ID);

    runCli(['verify-fixed', RUN_ID, '--legacy-v1', '--format=json'], fx.dbPath);
    const again = runCli(['verify-fixed', RUN_ID, '--legacy-v1', '--format=json'], fx.dbPath);

    // A check that fired on every write would be noise, and would make the
    // red proof above meaningless — it must key on an actual schema change.
    assert.equal(
      stagesIn(again.stderr, 'verify_fixed_schema_overwrite').length, 0,
      'an idempotent re-run of the same schema is not a clobber',
    );
  });

  it('PRECISION GUARD (holds pre- and post-fix): the first write, with no prior delta, is not reported', () => {
    const RUN_ID = 'swarm-w29vfix003';
    const fx = setupFixture(RUN_ID);

    const first = runCli(['verify-fixed', RUN_ID, '--format=json'], fx.dbPath);
    assert.equal(
      stagesIn(first.stderr, 'verify_fixed_schema_overwrite').length, 0,
      'there is nothing to overwrite on a fresh run',
    );
  });
});
