/**
 * cli-smoke.test.js — parser-load + invoke-as-subprocess regression for cli.js.
 *
 * Why this test exists
 *
 *   The Stage D CLI Help auditor (CHR-1) surfaced that `node packages/
 *   dogfood-swarm/cli.js` was failing at parse time with `SyntaxError:
 *   missing ) after argument list at cli.js:784` for three commits worth of
 *   wave receipts (965/965/0 cumulative gate). The 965 production tests all
 *   passed because NO test in the package invokes the CLI as a subprocess —
 *   the tests that touch cli.js read it as text and grep for patterns.
 *   `package.json` declares `bin: { swarm: ./cli.js }`, which means the
 *   moment any operator runs `swarm <anything>`, they hit the parse error.
 *
 *   This file closes that vantage-point gap: every assertion here invokes
 *   the CLI the way an operator does — `node cli.js [args...]` as a child
 *   process — and grades the captured stdout/stderr against the contract
 *   the help text + per-command Usage error lines are supposed to honor.
 *
 *   Pattern #10 (FAILS-then-PASSES proof gate) from this repo's swarm-
 *   evidence catalog was applied when this file was added: the test was
 *   written and run against the broken cli.js FIRST, asserted to fail with
 *   SyntaxError, then the cli.js fix was applied and the same test was re-
 *   run to confirm pass. The hotfix dispatch JSON at
 *   `swarms/swarm-1778729265-8a9f/stage-d/hotfix/cli-smoke.json` captures
 *   the before/after stderr for audit.
 *
 *   Going forward, this test runs in `npm test` and `npm run verify`, so
 *   any future unescaped backtick (or other parser-load defect) in the
 *   help-text template literal will be caught at CI time rather than at
 *   the operator's first `swarm` invocation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { formatStatus } from './commands/status.js';
import { openDb, closeDb } from './db/connection.js';
import { transitionWave } from './lib/wave-state-machine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

function stubStatus(assessmentState, nextAction = 'noop') {
  return {
    run: {
      id: 'r1', repo: 'org/r', status: 'health-audit-a',
      branch: 'main', commitSha: 'abcdef0123',
      savePointTag: null,
      timeoutPolicy: '1800s',
    },
    domains: [],
    waves: { total: 0, current: null },
    agents: [],
    agentSummary: { total: 0, complete: 0, inFlight: 0, blocked: 0 },
    findings: {
      total: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      byStatus: {},
      open: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      thisWave: { new: 0, recurring: 0, fixed: 0 },
    },
    violations: 0,
    lastVerification: null,
    waveReceipt: null,
    assessment: { state: assessmentState, blockers: [], nextAction },
  };
}

function runCli(args = []) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    // Inherit env so node modules resolve; bound stdio so we capture both
    // streams without parser-load output sneaking past.
  });
}

describe('cli.js parser-load (Pattern #10 regression gate)', () => {
  it('node cli.js (no args) does not produce a SyntaxError', () => {
    const r = runCli([]);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr || '', /missing \) after argument list/,
      `cli.js has an unclosed call:\n${r.stderr}`);
  });

  it('node cli.js (no args) prints the help text on stdout and exits cleanly', () => {
    const r = runCli([]);
    // No-args is treated as orientation surface, not an error — cli.js:868
    // exits with code 0 when no command was provided.
    assert.equal(r.status, 0,
      `no-args invocation should exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /swarm — Truthful swarm control plane for repo work/,
      'help banner missing from stdout');
    assert.match(r.stdout, /Commands:/,
      'help "Commands:" section header missing from stdout');
    assert.match(r.stdout, /Phases:/,
      'help "Phases:" footer missing from stdout');
  });

  it('node cli.js revalidate (no args) prints the Usage error and exits 1', () => {
    const r = runCli(['revalidate']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `revalidate-with-no-args should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    // cmdRevalidate prints its Usage error via console.error to stderr.
    assert.match(r.stderr, /Usage: swarm revalidate/,
      'revalidate Usage line missing from stderr');
  });

  it('node cli.js status (no args) prints the Usage error and exits 1', () => {
    const r = runCli(['status']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `status-with-no-args should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /Usage: swarm status/,
      'status Usage line missing from stderr');
  });

  it('node cli.js dispatch (no args) prints the Usage error and exits 1', () => {
    // Belt-and-suspenders: dispatch's Usage error short-form is the
    // operator's most-frequent contact when they typo a wave-launch
    // invocation. CHR-3 noted the Usage line itself drifts from the
    // no-args help block; this test only asserts parse + Usage emission,
    // not the flag-listing completeness (that's a Stage D MEDIUM, deferred).
    const r = runCli(['dispatch']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `dispatch-with-no-args should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /Usage: swarm dispatch/,
      'dispatch Usage line missing from stderr');
  });
});

/**
 * D-STRUCT-001 — distinct visual frames per assessment class.
 *
 * Pattern #10 proof gate: before the fix, FAILED-class states (WAVE FAILED,
 * VERIFY REQUIRED, AMEND NEEDED, BLOCKED) and READY-class states (READY TO
 * ADVANCE, READY TO COLLECT) all rendered as identical `--- LABEL ---`
 * frames. An operator scanning past a long status output cannot pre-
 * attentively distinguish a red-state from a green-state. The fix gives
 * each class a distinct ASCII frame so the visual SHAPE carries the same
 * information as the LABEL text — robust against CI plaintext logs,
 * screen-readers, and Markdown rendering that may drop ANSI colors.
 *
 * Asserts each class' frame carries a marker character absent from the
 * other classes. Pure-source asserts (no color/emoji) so the test is
 * meaningful under every capture pipeline.
 */
describe('D-STRUCT-001: formatStatus renders distinct frames per assessment class', () => {
  it('FAILED-class WAVE FAILED frame is distinct from READY TO ADVANCE', () => {
    const failedOut = formatStatus(stubStatus('WAVE FAILED'));
    const readyOut = formatStatus(stubStatus('READY TO ADVANCE'));

    // Extract the assessment line from each — the line containing the
    // assessment state label.
    const failedLine = failedOut.split('\n').find(l => l.includes('WAVE FAILED')) || '';
    const readyLine = readyOut.split('\n').find(l => l.includes('READY TO ADVANCE')) || '';

    assert.ok(failedLine.length > 0, 'WAVE FAILED line must be present');
    assert.ok(readyLine.length > 0, 'READY TO ADVANCE line must be present');

    // Pattern #10 substance: the two frames must differ in non-trivial
    // ways. Strip the label words and compare the surrounding frame
    // characters — they must NOT be identical.
    const failedFrame = failedLine.replace(/WAVE FAILED/g, '').trim();
    const readyFrame = readyLine.replace(/READY TO ADVANCE/g, '').trim();
    assert.notEqual(failedFrame, readyFrame,
      'frame characters around WAVE FAILED and READY TO ADVANCE must differ ' +
      `(both are: "${failedFrame}" vs "${readyFrame}")`);
  });

  it('VERIFY REQUIRED frame carries the FAILED-class obligation marker', () => {
    const out = formatStatus(stubStatus('VERIFY REQUIRED'));
    const line = out.split('\n').find(l => l.includes('VERIFY REQUIRED')) || '';
    assert.ok(line.length > 0, 'VERIFY REQUIRED line must be present');
    // Obligation marker `[!]` (ASCII, screen-reader-safe, distinct from
    // neutral `---` frame). The READY-class frame does NOT carry `[!]`.
    assert.match(line, /\[!\]/,
      `VERIFY REQUIRED must carry FAILED-class marker [!]; got "${line}"`);
    const readyLine = formatStatus(stubStatus('READY TO ADVANCE'))
      .split('\n').find(l => l.includes('READY TO ADVANCE')) || '';
    assert.doesNotMatch(readyLine, /\[!\]/,
      `READY TO ADVANCE must NOT carry the [!] obligation marker; got "${readyLine}"`);
  });

  it('AMEND NEEDED frame carries the FAILED-class obligation marker', () => {
    const out = formatStatus(stubStatus('AMEND NEEDED'));
    const line = out.split('\n').find(l => l.includes('AMEND NEEDED')) || '';
    assert.match(line, /\[!\]/,
      `AMEND NEEDED must carry FAILED-class marker [!]; got "${line}"`);
  });

  it('READY TO ADVANCE frame is distinct from neutral IN PROGRESS frame', () => {
    const readyOut = formatStatus(stubStatus('READY TO ADVANCE'));
    const progOut = formatStatus(stubStatus('IN PROGRESS'));
    const readyLine = readyOut.split('\n').find(l => l.includes('READY TO ADVANCE')) || '';
    const progLine = progOut.split('\n').find(l => l.includes('IN PROGRESS')) || '';
    const readyFrame = readyLine.replace(/READY TO ADVANCE/g, '').trim();
    const progFrame = progLine.replace(/IN PROGRESS/g, '').trim();
    assert.notEqual(readyFrame, progFrame,
      'READY-class frame must differ from neutral IN-PROGRESS frame');
  });
});

/**
 * CHR-2 — revalidate help block surfaces the load-bearing safety triplet
 * (--reason / --apply / --domain) as a scannable group, not as a side
 * clause in a 13-line prose wall.
 *
 * Wave-2 session anchor: operator derived --reason was REQUIRED (not
 * optional) by triggering an error. The help text technically contained
 * the truth but did not lead with it visually. The fix surfaces each
 * required-flag as a bulleted line under the Usage block so a scan-mode
 * reader cannot miss them.
 */
describe('CHR-2: revalidate help text surfaces required safety flags scannably', () => {
  it('no-args help block lists --reason / --apply / --domain as Required', () => {
    const r = runCli([]);
    assert.equal(r.status, 0, 'no-args help should exit 0');
    // Locate the revalidate block, slice it, then assert the three
    // Required-tagged flag bullets are present together.
    const help = r.stdout;
    const reIdx = help.indexOf('revalidate ');
    assert.ok(reIdx >= 0, 'revalidate command block must be present in help');
    const tail = help.slice(reIdx, reIdx + 800);
    assert.match(tail, /--reason "<text>"\s+Required/,
      '--reason flag must be tagged Required in the revalidate help block');
    assert.match(tail, /--domain=name:path\s+Required/,
      '--domain flag must be tagged Required in the revalidate help block');
    assert.match(tail, /--apply\s+Required/,
      '--apply flag must be tagged Required in the revalidate help block');
  });
});

/**
 * Phase 5B-0 — `swarm history <wave-id>` subprocess coverage.
 *
 * The verb's job is to render the wave_state_events audit chain so the
 * operator's --reason text on `swarm revalidate --apply` is reachable
 * without raw SQL. These tests invoke the CLI as a child process (same
 * pattern as the Pattern #10 regression gate above) so a future regression
 * in cli.js routing, the help block, or the formatHistory render contract
 * fails at CI time rather than at the operator's first `swarm history`
 * invocation.
 *
 * Coverage:
 *   1. `--help` exits 0 + emits the Usage line on stdout.
 *   2. No-args invocation exits 1 + emits the Usage error on stderr.
 *   3. Unknown wave-id against a fresh DB exits 1 with a clear error
 *      (no stack trace bleed-through).
 *   4. Non-integer wave-id exits 1 with the "must be a positive integer"
 *      message.
 *   5. Known wave-id with two transitions (dispatched -> failed then
 *      override failed -> collected) renders the full audit chain with
 *      the operator's --reason text in the second row.
 */
describe('swarm history <wave-id> — subprocess smoke (Phase 5B-0)', () => {
  let tempDir;
  let dbPath;

  function setupFixtureDb() {
    tempDir = mkdtempSync(join(tmpdir(), 'history-smoke-'));
    dbPath = join(tempDir, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tempDir, 'a'.repeat(40));
    const ins = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES ('r1', 'health-amend-a', 2, 'dispatched', 'snap1')
    `).run();
    const waveId = Number(ins.lastInsertRowid);

    transitionWave(db, waveId, 'failed', 'collect rejected all 4 outputs');
    transitionWave(db, waveId, 'collected', 'revalidate: wave-2 schema mismatch corrected', true);

    closeDb(dbPath);
    return waveId;
  }

  function teardownFixtureDb() {
    if (dbPath) closeDb(dbPath);
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
    }
    tempDir = undefined;
    dbPath = undefined;
  }

  function runHistoryCli(args, extraEnv = {}) {
    return spawnSync(process.execPath, [CLI_PATH, 'history', ...args], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, ...extraEnv },
    });
  }

  it('`swarm history --help` exits 0 and prints the Usage line', () => {
    const r = runHistoryCli(['--help']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 0,
      `--help should exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Usage: swarm history <wave-id>/,
      'history --help must print the Usage line on stdout');
  });

  it('`swarm history` (no args) exits 1 and prints Usage to stderr', () => {
    const r = runHistoryCli([]);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `no-args history should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /Usage: swarm history <wave-id>/,
      'history no-args must print Usage line on stderr');
  });

  it('`swarm history <unknown-wave-id>` exits 1 with a clear error, no stack trace', () => {
    // Point at a fresh-but-empty DB so the wave-not-found path executes
    // without any pre-existing rows colliding with the test fixture.
    const emptyTempDir = mkdtempSync(join(tmpdir(), 'history-smoke-empty-'));
    const emptyDbPath = join(emptyTempDir, 'control-plane.db');
    try {
      // openDb creates the schema; we never insert any waves here.
      const db = openDb(emptyDbPath);
      void db;
      closeDb(emptyDbPath);

      const r = runHistoryCli(['999999'], { SWARM_DB: emptyDbPath });
      assert.doesNotMatch(r.stderr || '', /SyntaxError/,
        `cli.js failed to parse:\n${r.stderr}`);
      assert.equal(r.status, 1,
        `unknown wave-id should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /wave not found: 999999/,
        'unknown wave-id must produce "wave not found" message');
      // No stack trace leakage — operator should not see an "at file:..."
      // frame for a known error path.
      assert.doesNotMatch(r.stderr, /^\s+at .+\(/m,
        `unknown wave-id error must NOT include a stack trace; got stderr:\n${r.stderr}`);
    } finally {
      try { closeDb(emptyDbPath); } catch { /* */ }
      rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });

  it('`swarm history <non-integer>` exits 1 with "must be a positive integer"', () => {
    const r = runHistoryCli(['abc']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `non-integer wave-id should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /wave id must be a positive integer/,
      'non-integer wave-id must produce a positive-integer error');
  });

  it('`swarm history <known-wave-id>` renders the full transition chain', () => {
    const waveId = setupFixtureDb();
    try {
      const r = runHistoryCli([String(waveId)], { SWARM_DB: dbPath });
      assert.doesNotMatch(r.stderr || '', /SyntaxError/,
        `cli.js failed to parse:\n${r.stderr}`);
      assert.equal(r.status, 0,
        `known wave-id should exit 0; got ${r.status}\nstderr: ${r.stderr}`);

      // Header banner names the wave so the operator orients quickly.
      assert.match(r.stdout, new RegExp(`Wave ${waveId}`),
        `output must name the wave; got:\n${r.stdout}`);

      // Plain-ASCII column header (no ANSI/emoji).
      assert.match(r.stdout, /FROM\s+TO\s+WHEN\s+REASON/,
        `output must include the column header row; got:\n${r.stdout}`);

      // Each fixture transition must appear as a row with the operator's
      // reason text. The override row carries `revalidate:` prefix which
      // mirrors the canonical write at commands/revalidate.js:326. The WHEN
      // column renders as ISO-like `YYYY-MM-DD HH:MM:SS` so the regex tolerates
      // an internal space (no \S match for the whole timestamp).
      assert.match(r.stdout, /dispatched +failed +\d{4}-\d{2}-\d{2} +\d{2}:\d{2}:\d{2} +collect rejected all 4 outputs/,
        `output must include the dispatched->failed row; got:\n${r.stdout}`);
      assert.match(r.stdout, /failed +collected +\d{4}-\d{2}-\d{2} +\d{2}:\d{2}:\d{2} +revalidate: wave-2 schema mismatch corrected/,
        `output must include the failed->collected override row with revalidate: prefix; got:\n${r.stdout}`);

      // Summary line counts both transitions.
      assert.match(r.stdout, /\(2 transitions\)/,
        `output must summarize "(2 transitions)"; got:\n${r.stdout}`);

      assert.doesNotMatch(r.stdout, /\[/,
        'output must be plain ASCII (no ANSI escapes)');
    } finally {
      teardownFixtureDb();
    }
  });

  it('`swarm history <fresh-wave-id>` renders "No transitions yet" cleanly', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'history-smoke-fresh-'));
    dbPath = join(tempDir, 'control-plane.db');
    try {
      const db = openDb(dbPath);
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run('r1', 'org/r', tempDir, 'a'.repeat(40));
      const ins = db.prepare(`
        INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
        VALUES ('r1', 'health-audit-a', 1, 'dispatched', 'snap1')
      `).run();
      const freshWaveId = Number(ins.lastInsertRowid);
      closeDb(dbPath);

      const r = runHistoryCli([String(freshWaveId)], { SWARM_DB: dbPath });
      assert.equal(r.status, 0,
        `fresh-wave history should exit 0; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /No transitions yet/,
        `fresh-wave history must say "No transitions yet"; got:\n${r.stdout}`);
    } finally {
      teardownFixtureDb();
    }
  });
});
