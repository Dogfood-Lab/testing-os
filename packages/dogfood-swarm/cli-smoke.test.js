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

import { describe, it, after } from 'node:test';
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

// Every CLI child below pins SWARM_DB off the live repo control-plane.db
// (task_6026249b): cmdHistory opens the DB BEFORE validating its wave-id arg,
// so even a "pure usage-error" spawn (`swarm history abc`) opened the
// operational DB mid-suite — the WAL sidecar churn that flaked
// stageD-output-dir-tracks-db.test.js under full-suite concurrency. The
// live-DB isolation sweep in meta-wal-sidecar-teardown-guard.test.js enforces
// this pin at every CLI-spawn site package-wide.
const SAFE_DB_DIR = mkdtempSync(join(tmpdir(), 'cli-smoke-safe-db-'));
after(() => { try { rmSync(SAFE_DB_DIR, { recursive: true, force: true }); } catch { /* Windows lock lag */ } });

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
    env: { ...process.env, SWARM_DB: join(SAFE_DB_DIR, 'control-plane.db') },
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
 *   5. Known wave-id with three transitions (dispatched -> failed, then
 *      override failed -> collected, then collected -> aborted_for_rewind)
 *      renders the full audit chain with the operator's --reason text in
 *      each row, AND every row's WHEN/REASON columns start at the same
 *      character offset as the header -- including the third row, whose
 *      TO value ('aborted_for_rewind', 18 chars) overflows history.js's
 *      fixed 12-char TO column budget (F-cb350c90). Content presence and
 *      column alignment are asserted as two SEPARATE properties so a
 *      content match can never stand in for an alignment check again.
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
    // F-cb350c90: a third, NORMAL-path transition (collected ->
    // aborted_for_rewind is a direct, non-blocked entry in
    // lib/wave-state-machine.js's TRANSITIONS table -- no override needed).
    // 'aborted_for_rewind' is the one reachable wave-status value (18
    // chars, the real target commands/rewind.js writes) that overflows
    // history.js's fixed 12-char TO column; before this fix no fixture in
    // the suite ever drove a wave through it, so the render's column-
    // overflow path had zero test coverage anywhere in the package.
    transitionWave(db, waveId, 'aborted_for_rewind', 'rewind: operator requested rollback to save point');

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
      env: { ...process.env, SWARM_DB: join(SAFE_DB_DIR, 'control-plane.db'), ...extraEnv },
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
      // F-8ad2d58d: matches teardownFixtureDb() above — the CLI subprocess
      // just spawned can still hold the WAL sidecar lock for a beat after it
      // exits, so rmSync (the call that actually raises EBUSY) must be
      // guarded too, not just closeDb.
      try { rmSync(emptyTempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
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

  it('`swarm history <known-wave-id>` renders the full transition chain with columns aligned to the header, including the overflow row', () => {
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
      const lines = r.stdout.split('\n');
      const headerLine = lines.find(l => /^FROM\s+TO\s+WHEN\s+REASON/.test(l));
      assert.ok(headerLine, `output must include the column header row; got:\n${r.stdout}`);

      // CONTENT presence — each fixture transition appears with the
      // operator's reason text. The override row carries the `revalidate:`
      // prefix (commands/revalidate.js:326); the rewind row carries the
      // `rewind:` prefix (commands/rewind.js:272). The TO token on the
      // third row is matched as `\S+` rather than the literal
      // 'aborted_for_rewind' string because F-4e4b88f7's companion fix
      // (swarm-cp-verbs' domain, same wave) may render it either widened-
      // and-intact or truncated-with-ellipsis — both are valid remediations
      // and neither should make this content check flap.
      //
      // Content presence is deliberately a SEPARATE assertion from column
      // alignment below: F-cb350c90 is precisely that the old version of
      // this test conflated the two — a flexible ' +' regex is satisfied by
      // a misaligned table exactly as readily as a correctly aligned one.
      assert.match(r.stdout, /^dispatched\s+failed\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+collect rejected all 4 outputs$/m,
        `output must include the dispatched->failed row; got:\n${r.stdout}`);
      assert.match(r.stdout, /^failed\s+collected\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+revalidate: wave-2 schema mismatch corrected$/m,
        `output must include the failed->collected override row with revalidate: prefix; got:\n${r.stdout}`);
      assert.match(r.stdout, /^collected\s+\S+\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+rewind: operator requested rollback to save point$/m,
        `output must include the collected->aborted_for_rewind row with rewind: prefix; got:\n${r.stdout}`);

      // ALIGNMENT — the property F-cb350c90 found completely unchecked.
      // Every row's WHEN column must start at the SAME character offset as
      // the header's WHEN label, and every row's REASON text must start at
      // the SAME character offset as the header's REASON label. A regex
      // like /dispatched +failed +.../ is satisfied by ANY amount of
      // whitespace between fields, so a ragged table (one row's columns
      // drifted right because a status name overflowed its fixed column
      // budget) passes it exactly as readily as a correctly aligned one —
      // comparing character offsets directly catches that drift.
      const whenOffset = headerLine.indexOf('WHEN');
      const reasonOffset = headerLine.indexOf('REASON');
      assert.ok(whenOffset > 0 && reasonOffset > whenOffset,
        `could not locate WHEN/REASON column offsets in header: ${JSON.stringify(headerLine)}`);

      const dataRows = lines.filter(l => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l));
      assert.equal(dataRows.length, 3,
        `expected exactly 3 transition rows; got ${dataRows.length}:\n${r.stdout}`);
      for (const row of dataRows) {
        const ts = row.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)[0];
        const tsOffset = row.indexOf(ts);
        assert.equal(tsOffset, whenOffset,
          `row's WHEN column must start at the same offset (${whenOffset}) as the header's — ` +
          `got offset ${tsOffset} in row: ${JSON.stringify(row)}`);
        const afterTs = tsOffset + ts.length;
        const reasonStart = afterTs + row.slice(afterTs).search(/\S/);
        assert.equal(reasonStart, reasonOffset,
          `row's REASON column must start at the same offset (${reasonOffset}) as the header's — ` +
          `got offset ${reasonStart} in row: ${JSON.stringify(row)}`);
      }

      // Summary line counts all three transitions.
      assert.match(r.stdout, /\(3 transitions\)/,
        `output must summarize "(3 transitions)"; got:\n${r.stdout}`);

      // F-eb26c327: pin "no ANSI escapes" precisely as the CSI introducer
      // ESC+[ — written with the visible \x1b escape, not a raw ESC byte
      // (invisible control bytes in source survive neither editors nor
      // reviews). A bare /\[/ would forbid ANY literal bracket (an operator
      // --reason containing '[' or the package's own [!] marker).
      assert.doesNotMatch(r.stdout, /\x1b\[/,
        'output must contain no ANSI escape sequences');
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
