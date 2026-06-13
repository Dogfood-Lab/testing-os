/**
 * stageC-swarm-cli-operator-signal.test.js — Stage C (humanization) amend pins
 * for the dogfood-swarm CLI operator-signal cluster.
 *
 * These are NOT bug fixes — every gate here was already SAFE. They close the
 * gap between the silent/observable surface an operator (or a scripted CI
 * chain) relies on and the structured channel the package uses everywhere
 * else. Each block names its finding id.
 *
 *   d5-swarm-cli-B001 (MED, defensive) — cmdCollect + cmdRevalidate silently
 *     DROPPED any `--domain=` token that failed the parse regex (missing colon,
 *     misspelled flag). The only guard fired on ZERO parsed, so a PARTIAL drop
 *     passed through and the unprovided domain's agent was later marked
 *     `failed` ('Output file not found') with no error pointing at the bad arg.
 *     Both sites now emit a structured stderr warning naming each unparseable
 *     `--domain=` token + the expected `--domain=name:path` shape. Non-fatal;
 *     exit code unchanged (observability, not a gate).
 *
 *   d5-swarm-cli-B002 (MED, degradation) — cmdResume always exited 0, even when
 *     resume() classified the wave `blocked` (agents in invalid_output /
 *     ownership_violation) or `unknown` — so a `swarm resume && swarm collect`
 *     chain advanced past a wave that cannot proceed. cmdResume now exits
 *     non-zero on `blocked`/`unknown`, leaving redispatched/waiting/
 *     all_complete/none at 0. Mirrors the verify/persist/findings machine-
 *     signal contract pinned by cli-p-002.
 *
 *   d5-swarm-cli-B003 (LOW, observability) — resume()'s `unknown` terminal
 *     ('Unexpected state — inspect manually') emitted NO structured event,
 *     unlike every sibling failure path (dispatch.js emitPreconditionFailed,
 *     collect.js transition_skipped / upsert_findings_failed). It now emits a
 *     logStage('resume_unknown_state', {...}) with a coord- correlation id so
 *     the dead-end is greppable in the NDJSON stream. Purely additive.
 *
 * Strategy: B001 + B002 are exercised at the CLI seam via spawnSync against a
 * fixture DB (the operator's real surface — stderr text + exit code). B003 is
 * driven in-process against resume() with console.error captured, because the
 * unknown branch is only reachable with a corrupted (non-canonical) agent_run
 * status that a subprocess cannot easily seed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { transitionAgent } from './lib/state-machine.js';
import { resume } from './commands/resume.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function teardown(...dirs) {
  for (const d of dirs) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

function runCli(args, dbPath, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath, ...extraEnv },
  });
}

/**
 * Seed a run with one frozen domain, no wave yet. Returns { tmp, dbPath }.
 */
function freshRunDb(runId, prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(runId, 'org/repo', tmp, 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);
  closeDb(dbPath);
  return { tmp, dbPath };
}

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-B001 — collect/revalidate warn on unparseable --domain=
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-B001: cmdCollect warns on an unparseable --domain= token', () => {
  // The warning fires in the CLI arg-parse loop BEFORE collect() runs, so we do
  // not need a dispatched wave — a missing-colon token is dropped, leaving zero
  // parsed, and the existing "No outputs provided" guard exits 1. The NEW
  // behaviour: the bad token is NAMED on stderr instead of vanishing silently.
  it('a missing-colon --domain= token is named on stderr (not silently dropped)', () => {
    const fx = freshRunDb('r1', 'stageC-collect-warn-');
    try {
      // `--domain=packages/backend/out.json` has no `name:` prefix colon-split
      // that the regex /^--domain=([^:]+):(.+)$/ accepts as name:path on a
      // Windows-style path... but to be unambiguous use a token with NO colon
      // at all so it definitively fails the regex on every platform.
      const r = runCli(['collect', 'r1', '--domain=backend-out.json'], fx.dbPath);
      // Zero valid tokens → existing guard still exits non-zero.
      assert.notEqual(r.status, 0,
        'zero parsed --domain= tokens must still hit the "No outputs provided" guard');
      // B001 regression: the bad token must be NAMED, not silently dropped.
      assert.match(r.stderr, /backend-out\.json/,
        'B001 regression: the unparseable --domain= token vanished with no diagnostic');
      assert.match(r.stderr, /--domain=name:path/,
        'the warning must teach the expected --domain=name:path shape');
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });

  it('a PARTIAL drop (one good, one malformed) still warns about the bad token', () => {
    // No dispatched wave exists, so collect() throws a clean "No dispatched
    // wave found" AFTER the parse-loop warning has already gone to stderr.
    // This proves the warning fires even when at least one token parses (the
    // zero-match guard would NOT fire here).
    const fx = freshRunDb('r1', 'stageC-collect-partial-');
    try {
      const r = runCli(
        ['collect', 'r1', '--domain=backend:out.json', '--domain=frontend-out.json'],
        fx.dbPath,
      );
      assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
      assert.match(r.stderr, /frontend-out\.json/,
        'B001 regression: a malformed token in a multi-domain collect was dropped silently');
      assert.match(r.stderr, /--domain=name:path/);
      // The good token must NOT be named as unparseable.
      assert.doesNotMatch(r.stderr, /could not parse[^\n]*backend:out\.json/i,
        'the well-formed --domain=backend:out.json must NOT be flagged as unparseable');
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });

  it('a clean multi-domain collect emits NO unparseable-token warning', () => {
    const fx = freshRunDb('r1', 'stageC-collect-clean-');
    try {
      const r = runCli(
        ['collect', 'r1', '--domain=backend:out.json', '--domain=frontend:out2.json'],
        fx.dbPath,
      );
      // collect() will still throw "No dispatched wave found" (no wave seeded),
      // but the parse-loop warning must NOT appear — every token was valid.
      assert.doesNotMatch(r.stderr || '', /could not parse|unparseable/i,
        'a fully well-formed --domain= set must not trigger the B001 warning');
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });
});

describe('d5-swarm-cli-B001: cmdRevalidate shares the same unparseable-token warning', () => {
  it('a missing-colon --domain= token is named on stderr for revalidate too', () => {
    const fx = freshRunDb('r1', 'stageC-reval-warn-');
    try {
      // revalidate requires --reason; provide it so the parse loop is reached
      // and the zero-valid-token guard ("at least one --domain=") is what exits.
      const r = runCli(
        ['revalidate', 'r1', '--reason', 'recover the wave', '--domain=backend-out.json'],
        fx.dbPath,
      );
      assert.notEqual(r.status, 0,
        'zero parsed --domain= tokens must still hit revalidate\'s "at least one" guard');
      assert.match(r.stderr, /backend-out\.json/,
        'B001 regression: cmdRevalidate dropped the malformed --domain= token silently');
      assert.match(r.stderr, /--domain=name:path/);
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-B002 — cmdResume exit code matches the human-readable verdict
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-B002: `swarm resume` exits non-zero on a blocked wave', () => {
  const RUN_ID = 'r-resume-exit';

  function seedWaveWithAgentStatus(targetStatus) {
    const tmp = mkdtempSync(join(tmpdir(), 'stageC-resume-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
    closeDb(dbPath);

    // dispatch creates wave 1 + agent_run #1 at status 'dispatched'.
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });

    const db2 = openDb(dbPath);
    const ar = db2.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    transitionAgent(db2, ar.id, targetStatus, `forced ${targetStatus} for B002 test`);
    closeDb(dbPath);
    return { tmp, dbPath };
  }

  it('an agent in invalid_output (→ action=blocked) makes resume exit non-zero', () => {
    const fx = seedWaveWithAgentStatus('invalid_output');
    try {
      const r = runCli(['resume', RUN_ID], fx.dbPath);
      assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
      // The human-readable BLOCKED verdict is still printed to stdout.
      assert.match(r.stdout, /Action: blocked/,
        'the human-readable blocked verdict must still print');
      // B002 regression: a CI step gating on $? must see the gate FAIL.
      assert.notEqual(r.status, 0,
        `B002 regression: a blocked wave must NOT exit 0 (a \`resume && collect\` chain would advance); got ${r.status}\nstdout:\n${r.stdout}`);
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });

  it('an all-complete wave (action=all_complete) keeps resume at exit 0', () => {
    const fx = seedWaveWithAgentStatus('complete');
    try {
      const r = runCli(['resume', RUN_ID], fx.dbPath);
      assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
      assert.match(r.stdout, /Action: all_complete/);
      assert.equal(r.status, 0,
        `a non-blocked, healthy wave must stay at exit 0; got ${r.status}\nstderr:\n${r.stderr}`);
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-B003 — resume() emits a structured event on the unknown dead-end
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-B003: resume() emits logStage on the unknown-state dead-end', () => {
  let tmp;
  let dbPath;
  const RUN_ID = 'r-resume-unknown';

  /**
   * Capture every console.error line produced during fn(), then restore.
   */
  function captureStderr(fn) {
    const orig = console.error;
    const lines = [];
    console.error = (...a) => { lines.push(a.map(String).join(' ')); };
    let result;
    try { result = fn(); } finally { console.error = orig; }
    return { result, lines };
  }

  function ndjson(lines) {
    const out = [];
    for (const ln of lines) {
      if (!ln.startsWith('{')) continue;
      try {
        const obj = JSON.parse(ln);
        if (obj && obj.stage) out.push(obj);
      } catch { /* not NDJSON */ }
    }
    return out;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stageC-resume-unknown-'));
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
    // dispatch creates wave 1 + agent_run #1.
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });
  });
  afterEach(() => {
    closeDb(dbPath);
    teardown(tmp);
  });

  it('a non-canonical agent_run status drives action=unknown AND emits resume_unknown_state', () => {
    const db = openDb(dbPath);
    // Force a status outside the 9 canonical values. isBlocked/isTerminal/
    // isInFlight/isRedispatchable all return false for it, so resume's
    // classifier falls through every branch into the `unknown` else — the
    // exact should-not-happen state the breadcrumb exists for. Direct SQL
    // bypasses the state machine (which would reject the illegal status).
    db.prepare("UPDATE agent_runs SET status = 'corrupted_status' WHERE wave_id = 1").run();
    closeDb(dbPath);

    const { result, lines } = captureStderr(() =>
      resume({ runId: RUN_ID, dbPath, outputDir: tmp }));

    assert.equal(result.action, 'unknown',
      'precondition: a non-canonical status must reach the unknown branch');

    const events = ndjson(lines).filter(e => e.stage === 'resume_unknown_state');
    assert.equal(events.length, 1,
      'B003 regression: the unknown dead-end emitted NO structured NDJSON event');
    const ev = events[0];
    // The breadcrumb must carry enough forensic identity to ground a follow-up.
    assert.ok(ev.correlation_id && /^coord-/.test(ev.correlation_id),
      'the event must carry a coord- correlation id like the sibling commands');
    assert.equal(ev.runId, RUN_ID, 'the event must name the run');
    assert.equal(ev.waveId, result.waveId, 'the event must name the wave id');
    assert.equal(ev.waveNumber, result.waveNumber, 'the event must name the wave number');
  });

  it('a healthy (redispatchable) wave does NOT emit resume_unknown_state', () => {
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    transitionAgent(db, ar.id, 'failed', 'forced failed → redispatchable, NOT unknown');
    closeDb(dbPath);

    const { result, lines } = captureStderr(() =>
      resume({ runId: RUN_ID, dbPath, outputDir: tmp }));

    assert.equal(result.action, 'redispatched',
      'precondition: a failed agent must classify as redispatched, not unknown');
    const events = ndjson(lines).filter(e => e.stage === 'resume_unknown_state');
    assert.equal(events.length, 0,
      'the unknown-state breadcrumb must NOT fire on a healthy redispatch');
  });
});
