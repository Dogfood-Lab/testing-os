/**
 * wave31-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 31 (health-amend-b) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — no OWNED domain's globs match
 * `packages/dogfood-swarm/*.test.js` (swarm-cp-verbs owns only `commands/**`
 * + `cli.js`), so resolveExclusiveOwner returns null and checkOwnership's
 * bridge fallback grants ANY calling domain a valid claim — the same
 * rationale wave2/4/6/8/10/12/14/18/29's own pin files already established
 * for this identical situation (see wave29-4091637-5127-swarm-cp-pins.test.js
 * for the fullest statement of it, including the live-call verification of
 * checkOwnership rather than trusting the prose).
 *
 * F-1a877be1 (test coverage for dispatch.js's real prior-routing pipeline) is
 * pinned in open-prior-confirmation-brief.test.js instead — its own docstring
 * explains why that file, not this one, is the natural home (it already owns
 * the `sections()` slicing helper this exact routing invariant needs).
 *
 * RED PROOF (all three below): each block was run against this wave's
 * pre-fix production code by `git stash push -- packages/dogfood-swarm/cli.js
 * packages/dogfood-swarm/commands/receipt.js
 * packages/dogfood-swarm/commands/adjudicate.js` — stashing ONLY the three
 * production files this wave touched, leaving this test file (untracked) and
 * open-prior-confirmation-brief.test.js's new block untouched in the working
 * tree — then `git stash pop` to restore. Per-block red evidence:
 *
 *   F-264ab3aa  pre-fix, `commands`/`USAGE` were not exported from cli.js at
 *               all — importing this file threw `SyntaxError: The requested
 *               module './cli.js' does not provide an export named 'USAGE'`
 *               before a single test could even run; `swarm status --help`
 *               printed `ERROR: Run not found: --help` and exited 1; `swarm
 *               doctor --help` silently ran the real doctor check and
 *               printed a full pass/warn/fail report instead of any help
 *               text.
 *   F-9acd2df3  pre-fix formatAdjudication's output for a result carrying
 *               seats_errored contained zero occurrences of "Seats errored",
 *               "granite:30b" (outside the Panel line), or "ECONNREFUSED" —
 *               and the errored criterion's line was byte-identical to a
 *               healthy one.
 *   F-dd3e6587  pre-fix storeReceipt(db, waveId, jsonPath, mdPath) (the old
 *               4-arg signature) emitted 0 bytes of stderr on either of two
 *               consecutive calls for the same wave_id, though the second
 *               call's row churn (id incremented, created_at reset) still
 *               happened identically to today.
 *
 * Assertions marked PRECISION GUARD hold both before and after the fix and
 * exist to stop an over-correction; they are not counted as red-proof
 * evidence.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openMemoryDb } from './db/connection.js';
import { commands, USAGE } from './cli.js';
import { storeReceipt } from './commands/receipt.js';
import { formatAdjudication } from './commands/adjudicate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

/**
 * Spawn the real CLI as a subprocess — same pattern as cli-smoke.test.js /
 * rewind.test.js / redrive.test.js. `SWARM_DB` points at a path inside a
 * fresh temp dir that is never actually created as a real sqlite file: the
 * centralized --help intercept in main() runs BEFORE any verb's cmd*
 * function (and therefore before any DB access), so a --help invocation
 * never touches it. The temp dir still exists (mkdtempSync) so `cwd` and
 * `SWARM_DB` both resolve to a real, writable, per-test-isolated location —
 * belt-and-suspenders in case a future refactor ever moves DB access ahead
 * of the --help check.
 */
function runCliHelp(verb, args = []) {
  const tempDir = mkdtempSync(join(tmpdir(), `w31-help-${verb.replace(/[^a-z-]/gi, '')}-`));
  try {
    return spawnSync(process.execPath, [CLI_PATH, verb, ...args, '--help'], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: join(tempDir, 'control-plane.db') },
    });
  } finally {
    // The spawned CLI's SQLite handle can outlive the process exit on Windows,
    // so the -wal/-shm sidecars stay locked for a beat after we return here and
    // an unguarded rmSync throws EBUSY — failing the test for the teardown
    // rather than the assertion. The package-wide guard
    // (meta-wal-sidecar-teardown-guard.test.js) caught this one on the wave-31
    // merge; it is the F-8ad2d58d / F-60942f46 / F-f8798fd7 class.
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
}

// ──────────────────────────────────────────────────────────────
// F-264ab3aa — centralized per-verb --help/-h
// ──────────────────────────────────────────────────────────────

/** @pins F-264ab3aa */
describe('F-264ab3aa — every registered verb answers --help/-h, from one mechanism', () => {
  it('STRUCTURAL: every key in `commands` has a matching USAGE entry — a future verb cannot ship without one', () => {
    const verbs = Object.keys(commands);
    // Non-vacuity: this run's fixture sanity floor. If `commands` were ever
    // accidentally emptied (e.g. a bad merge), this must fail loudly rather
    // than the loop below passing by iterating zero times.
    assert.ok(verbs.length >= 28, `fixture sanity: expected at least 28 registered verbs, found ${verbs.length}`);
    for (const verb of verbs) {
      assert.equal(typeof USAGE[verb], 'string', `commands.${verb} has no USAGE entry in the table main() consults`);
      assert.match(USAGE[verb], /^Usage: swarm /, `USAGE.${JSON.stringify(verb)} must open with "Usage: swarm "`);
    }
  });

  // Previously-broken verbs spanning the three distinct failure modes the
  // finding documented: a false "not found" error (status/persist/advance),
  // a misread filesystem path (findings), and a silently-executed real
  // action instead of help text (doctor/domains/runs). No run-id is passed
  // for any of them — the centralized check fires on '--help' alone,
  // BEFORE any per-verb argument parsing, exactly reproducing the documented
  // pre-fix bug shape (`swarm status --help` with no run-id at all).
  for (const verb of ['status', 'persist', 'advance', 'findings', 'domains', 'doctor', 'runs', 'approve', 'receipt', 'verify', 'trends']) {
    it(`\`swarm ${verb} --help\` exits 0 and prints its Usage line instead of misreading '--help' as an argument`, () => {
      const r = runCliHelp(verb);
      assert.equal(r.status, 0, `--help must exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`Usage: swarm ${verb}`), `${verb} --help must print its Usage line on stdout`);
    });
  }

  it('`swarm clean --help` (previously untested by any file) still exits 0 and prints its full rich Usage text unchanged', () => {
    const r = runCliHelp('clean');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: swarm clean <run-id>/);
    assert.match(r.stdout, /Reclaim the stranded --isolate worktrees/,
      'the rich detail cmdClean used to print inline must survive the move into USAGE.clean verbatim');
  });

  it('a --help token anywhere in the args (not just the last one) still triggers help, matching the convention the 5 pre-existing per-verb handlers already used', () => {
    const r = runCliHelp('rewind', ['sometag', '--reason']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: swarm rewind <save-point-tag>/);
  });

  it('an unregistered verb name still gets the pre-existing "Unknown command" treatment, not a USAGE lookup', () => {
    // Guards the ordering in main(): the unknown-command check runs BEFORE
    // the centralized --help check, so a typo'd verb is still named as
    // unknown rather than silently falling through to the USAGE fallback
    // text (which would misdirect the operator toward a verb that doesn't
    // exist rather than telling them they mistyped it).
    const r = runCliHelp('dispach');
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /Unknown command: 'dispach'/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-9acd2df3 — formatAdjudication surfaces seats_errored + per-criterion errors
// ──────────────────────────────────────────────────────────────

/** @pins F-9acd2df3 */
describe('F-9acd2df3 — formatAdjudication renders a dead jury seat instead of hiding it', () => {
  it('a result with seats_errored renders a "Seats errored" line naming the seat + its error text', () => {
    const text = formatAdjudication({
      adjudicationId: 42,
      receiptPath: null,
      result: {
        overall: 'contested',
        authority: 'advisory',
        seats: ['mistral:24b', 'granite:30b'],
        seats_errored: [{ seat: 'granite:30b', error: 'ECONNREFUSED: Ollama not running on localhost:11434' }],
        criteria: [{
          id: 'AC-1',
          verdict: 'insufficient_context',
          counts: { pass: 1, fail: 0, insufficient_context: 1 },
          errors: [{ seat: 'granite:30b', error: 'ECONNREFUSED: Ollama not running on localhost:11434' }],
        }],
        out_of_brief: [],
      },
    });

    // Pre-fix: the dead seat's name appeared ONLY in the Panel line, reading
    // as an ordinary healthy panelist, and the text contained zero
    // occurrences of "Seats errored" / "ECONNREFUSED" anywhere.
    assert.match(text, /Seats errored/, 'a dead seat must be named on the default text surface');
    assert.match(text, /granite:30b/, 'the errored seat name must appear (it already does, in Panel — this proves the DEDICATED line too)');
    assert.match(text, /ECONNREFUSED/, 'the actual error text must reach the operator, not just the seat name');
  });

  it('a criterion with a non-empty errors[] is annotated inline so a live/dead split does not read as an ordinary vote split', () => {
    const text = formatAdjudication({
      adjudicationId: 42,
      receiptPath: null,
      result: {
        overall: 'contested',
        authority: 'advisory',
        seats: ['mistral:24b', 'granite:30b'],
        seats_errored: [{ seat: 'granite:30b', error: 'HTTP 404: model not pulled' }],
        criteria: [{
          id: 'AC-1',
          verdict: 'insufficient_context',
          counts: { pass: 1, fail: 0, insufficient_context: 1 },
          errors: [{ seat: 'granite:30b', error: 'HTTP 404: model not pulled' }],
        }],
        out_of_brief: [],
      },
    });
    const criterionLine = text.split('\n').find(l => l.includes('AC-1'));
    assert.ok(criterionLine, 'expected a rendered line for criterion AC-1');
    assert.match(criterionLine, /errored/i, `the AC-1 line must flag its errored seat(s) inline: "${criterionLine}"`);
  });

  it('PRECISION GUARD: a healthy result with no seats_errored key at all renders exactly as before — no regression on the golden path', () => {
    // The EXACT shape case-file-adjudicate-cmd.test.js's own pre-existing
    // fixtures use (no seats_errored, no per-criterion errors key at all,
    // not even an empty array) — the new guard must not throw or print a
    // spurious "Seats errored" line when the field is simply absent.
    const text = formatAdjudication({
      adjudicationId: 7,
      receiptPath: 'swarms/r1/adjudications/wave-1-abcd1234.json',
      result: {
        overall: 'corroborate',
        authority: 'advisory',
        seats: ['mistral', 'qwen'],
        criteria: [{ id: 'AC-1', verdict: 'pass', counts: { pass: 2, fail: 0, insufficient_context: 0 } }],
        out_of_brief: [],
      },
    });
    assert.doesNotMatch(text, /Seats errored/);
    assert.doesNotMatch(text, /errored\]/i);
    assert.match(text, /Adjudication: CORROBORATE/);
    assert.match(text, /Recorded adjudication #7/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-dd3e6587 — storeReceipt's silent INSERT OR REPLACE clobber becomes greppable
// ──────────────────────────────────────────────────────────────

/** Capture every line written to console.error during a function call, then restore. */
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

/** Only the NDJSON lines (the logStage contract) — filters the TTY companion banner. */
function ndjsonLines(lines) {
  const out = [];
  for (const ln of lines) {
    if (!ln.startsWith('{')) continue;
    try {
      const obj = JSON.parse(ln);
      if (obj && typeof obj === 'object' && obj.stage) out.push(obj);
    } catch { /* not NDJSON */ }
  }
  return out;
}

/** @pins F-dd3e6587 */
describe('F-dd3e6587 — a re-exported wave receipt is greppable instead of silently clobbered', () => {
  let db;
  let runId;
  let waveId;

  beforeEach(() => {
    db = openMemoryDb();
    runId = 'w31-receipt-test';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    const wave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-b', 1, 'collected')`
    ).run(runId);
    waveId = Number(wave.lastInsertRowid);
  });

  it('the FIRST export for a wave logs receipt_stored with replaced: false', () => {
    const lines = captureStderr(() => {
      storeReceipt(db, runId, waveId, '/tmp/wave-1-receipt.json', '/tmp/wave-1-receipt.md');
    });
    const events = ndjsonLines(lines).filter(e => e.stage === 'receipt_stored');
    assert.equal(events.length, 1, 'storeReceipt must emit exactly one receipt_stored event');
    assert.equal(events[0].waveId, waveId);
    assert.equal(events[0].runId, runId);
    assert.equal(events[0].replaced, false, "a wave's first receipt export is not a replace");
  });

  it('a SECOND export for the SAME wave logs receipt_stored with replaced: true — the pre-fix silent clobber, now signaled', () => {
    storeReceipt(db, runId, waveId, '/tmp/wave-1-receipt.json', '/tmp/wave-1-receipt.md');
    const before = db.prepare('SELECT id FROM wave_receipts WHERE wave_id = ?').get(waveId);

    const lines = captureStderr(() => {
      storeReceipt(db, runId, waveId, '/tmp/wave-1-receipt-v2.json', '/tmp/wave-1-receipt-v2.md');
    });
    const events = ndjsonLines(lines).filter(e => e.stage === 'receipt_stored');

    // Pre-fix: storeReceipt emitted 0 bytes of stderr on EITHER call — the
    // INSERT OR REPLACE clobbered the row (id churned, created_at reset)
    // with no signal anywhere, and stdout was byte-identical between runs.
    assert.equal(events.length, 1);
    assert.equal(events[0].replaced, true, 'a second export for the same wave_id must be flagged as a replace');

    // The underlying clobber itself is UNCHANGED by this fix (still
    // INSERT OR REPLACE — genuine append-only needs a db/schema.js edit
    // outside this domain's owned globs) — confirm the row really did churn,
    // so the logStage signal describes something real, not a no-op.
    const after = db.prepare('SELECT id, json_path FROM wave_receipts WHERE wave_id = ?').get(waveId);
    assert.notEqual(after.id, before.id, 'sanity: the underlying churn this fix makes visible is still really happening');
    assert.match(after.json_path, /v2\.json$/);
  });

  it('PRECISION GUARD: wave_receipts still holds exactly one row per wave_id — this fix adds observability only', () => {
    storeReceipt(db, runId, waveId, '/tmp/a.json', '/tmp/a.md');
    storeReceipt(db, runId, waveId, '/tmp/b.json', '/tmp/b.md');
    const rows = db.prepare('SELECT * FROM wave_receipts WHERE wave_id = ?').all(waveId);
    assert.equal(rows.length, 1, 'this fix must not change wave_receipts into an append-only table — that needs a db/schema.js change out of domain');
  });
});
