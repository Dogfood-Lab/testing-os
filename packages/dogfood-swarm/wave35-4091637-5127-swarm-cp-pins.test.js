/**
 * wave35-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 35 (stage-d-amend) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — no OWNED domain's globs match
 * `packages/dogfood-swarm/*.test.js` (swarm-cp-verbs owns only `commands/**`
 * + `cli.js`), so resolveExclusiveOwner returns null and checkOwnership's
 * bridge fallback grants ANY calling domain a valid claim — the same
 * rationale wave2/4/6/8/10/12/14/18/29/31's own pin files already
 * established for this identical situation.
 *
 * Three findings, one shared mechanism for two of them:
 *
 *   F-e164337b (LOW, cli.js:2460 + siblings) — "${count} noun" rendered
 *     unconditionally plural with no singular guard. The finding named 9
 *     sites across cli.js + 4 commands/*.js files; an independent sweep of
 *     every `${var} noun` shape in cli.js + every commands *.js file (grep
 *     for the established noun vocabulary this package already pluralizes correctly
 *     elsewhere — agent(s)/run(s)/finding(s)/wave(s)/test(s)/gate(s)/
 *     agent_run(s)/day(s) — then a second, vocabulary-free single-word pass)
 *     found 13 MORE unguarded sites the finding did not enumerate: cli.js
 *     419 (matched_files trailer), 650/661 (dispatch agent counts), 1829
 *     (promote --history gates ratio), 2006/2188 (approve/defer/reject),
 *     2551 (recurring-branch run_count — invariant-guaranteed >= 2 today,
 *     hardened anyway), 2581 (recurrence window_days); collect.js:1080
 *     (upsertFindings failure message); receipt.js:437 (mirrors the named
 *     status.js:396 site exactly — same v.test_count shape, different
 *     surface); redrive.js:622/623/624 (mirrors the named rewind.js:557
 *     site's "agent_runs" phrasing). 22 sites total, all fixed with one
 *     shared helper (commands/lib/pluralize.js) rather than 22 hand edits —
 *     the `noun(s)` suffix / ternary this package already uses at 60+ OTHER
 *     sites was the model; pluralize()/pluralizeWord() make that reusable.
 *
 *   F-94175151 (LOW, status.js:382) — the Findings block's `Open:` line ends
 *     with an unlabeled `(${f.total} total)` sitting directly after the four
 *     open-severity counts, reading as their sum when it is actually
 *     allFindings.length (the run's lifetime count). Fixed by relabeling to
 *     "total ever filed", disambiguating at the point of reading.
 *
 *   F-4e4b88f7 (LOW, history.js:118) — `pad(s, w)` returned a status name
 *     UNPADDED and UNTRUNCATED when its length >= the column width, silently
 *     breaking the "plain-ASCII fixed-column table" contract the file's own
 *     header documents. `aborted_for_rewind` (19 chars) is a real, reachable
 *     wave_state_events.to_status value (rewind.js's REWIND_TARGET_STATUS)
 *     that exceeded the old FROM_W/TO_W=12. Fixed two ways: FROM_W/TO_W
 *     widened to 19 (fits every status wave-state-machine.js's transitionWave
 *     writes today, with zero truncation), AND pad() given a truncate-with-
 *     ellipsis fallback symmetric with the REASON column's existing
 *     truncate() call — so a still-longer FUTURE status name degrades
 *     safely instead of re-earning this same finding.
 *
 * RED PROOF (all three, plus the pluralization siblings): each fix was
 * proven against this wave's pre-fix production code by `git stash push --
 * packages/dogfood-swarm/cli.js packages/dogfood-swarm/commands/collect.js
 * packages/dogfood-swarm/commands/receipt.js packages/dogfood-swarm/commands/
 * redrive.js packages/dogfood-swarm/commands/resume.js packages/dogfood-swarm/
 * commands/rewind.js packages/dogfood-swarm/commands/status.js packages/
 * dogfood-swarm/commands/history.js` (stashing ONLY the 8 production files
 * this wave touched, leaving this test file and the 5 pre-existing test
 * files whose assertions were updated to match the fix untouched in the
 * working tree) — every block below, plus the 5 updated pre-existing files
 * (redrive.test.js, rewind.test.js, wave12-swarm-cp-pins.test.js,
 * wave8-4091637-5127-swarm-cp-pins.test.js, wave12-observability.test.js),
 * failed against the stashed (pre-fix) code; `git stash pop` restored the
 * fix and every one of those same assertions passed.
 *
 * Assertions marked PRECISION GUARD hold both before and after the fix and
 * exist to stop an over-correction; they are not counted as red-proof
 * evidence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluralize, pluralizeWord } from './commands/lib/pluralize.js';
import { openDb, closeDb, openMemoryDb } from './db/connection.js';
import { buildSummary } from './commands/collect.js';
import { formatReceiptMarkdown } from './commands/receipt.js';
import { formatStatus } from './commands/status.js';
import { formatHistory } from './commands/history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');
const CLI_SRC = readFileSync(CLI_PATH, 'utf-8');

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

// ──────────────────────────────────────────────────────────────
// F-e164337b — shared pluralize()/pluralizeWord() helper (unit)
// ──────────────────────────────────────────────────────────────

/** @pins F-e164337b */
describe('F-e164337b — commands/lib/pluralize.js: pluralize()/pluralizeWord() singular/plural agreement', () => {
  it('pluralize(1, singular) renders the singular form with the count', () => {
    assert.equal(pluralize(1, 'wave'), '1 wave');
    assert.equal(pluralize(1, 'finding'), '1 finding');
  });

  it('pluralize(0 | N>1, singular) renders the regular-plural (default `${singular}s`) form', () => {
    assert.equal(pluralize(0, 'wave'), '0 waves');
    assert.equal(pluralize(2, 'wave'), '2 waves');
    assert.equal(pluralize(11, 'finding'), '11 findings');
  });

  it('an explicit irregular plural overrides the default `${singular}s`', () => {
    assert.equal(pluralize(1, 'criterion', 'criteria'), '1 criterion');
    assert.equal(pluralize(3, 'criterion', 'criteria'), '3 criteria');
  });

  it('pluralizeWord returns the bare noun (no count) — for ratio shapes like "3/5 gates" where the count is rendered separately', () => {
    assert.equal(pluralizeWord(1, 'gate'), 'gate');
    assert.equal(pluralizeWord(5, 'gate'), 'gates');
    assert.equal(pluralizeWord(0, 'gate'), 'gates');
  });
});

// ──────────────────────────────────────────────────────────────
// F-e164337b — primary named site: `swarm runs` (cli.js:2460)
// ──────────────────────────────────────────────────────────────

function seedSingleRunWaveFinding(dbPath) {
  const db = openDb(dbPath);
  const RUN_ID = 'w35-runs-singular';
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(RUN_ID, 'org/repo', dbPath, 'a'.repeat(40));
  db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')")
    .run(RUN_ID);
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description)
     VALUES (?, 'F-001', 'fp-1', 'LOW', 'bug', 'test finding')`
  ).run(RUN_ID);
  closeDb(dbPath);
  return RUN_ID;
}

describe('F-e164337b — `swarm runs` (primary named site, cli.js cmdRuns) singular agreement', () => {
  it('a run with exactly 1 wave and 1 finding renders "1 wave, 1 finding", not "1 waves, 1 findings"', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w35-runs-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const RUN_ID = seedSingleRunWaveFinding(dbPath);
      const r = runCli(['runs'], dbPath);
      assert.equal(r.status, 0, `swarm runs should succeed: ${r.stderr}`);
      assert.match(r.stdout, /1 wave,\s*1 finding\b/,
        `expected singular "1 wave, 1 finding" in:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /1 waves\b/, 'pre-fix: this rendered "1 waves"');
      assert.doesNotMatch(r.stdout, /1 findings\b/, 'pre-fix: this rendered "1 findings"');
      assert.match(r.stdout, new RegExp(RUN_ID));
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
  });
});

// ──────────────────────────────────────────────────────────────
// F-e164337b — named sibling: collect.js:1188 agentSummary (findings_count)
// ──────────────────────────────────────────────────────────────

describe('F-e164337b — named sibling: collect.js buildSummary agentSummary line', () => {
  it('an agent reporting exactly 1 finding renders "(1 finding)", not "(1 findings)"', () => {
    const db = openMemoryDb();
    const runId = 'w35-summary-singular';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    const wave = { wave_number: 1, phase: 'health-audit-a' };
    const report = {
      agents: [{ domain: 'backend', status: 'complete', findings_count: 1, errors: [] }],
      findings: { new: 1, recurring: 0, fixed: 0 },
      violations: [],
    };
    const summary = buildSummary(db, runId, wave, report);
    assert.match(summary, /backend: complete \(1 finding\)/, `expected "(1 finding)" in:\n${summary}`);
    assert.doesNotMatch(summary, /\(1 findings\)/, 'pre-fix: this rendered "(1 findings)"');
  });

  it('PRECISION GUARD: an agent reporting 3 findings still renders the regular plural', () => {
    const db = openMemoryDb();
    const runId = 'w35-summary-plural';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    const wave = { wave_number: 1, phase: 'health-audit-a' };
    const report = {
      agents: [{ domain: 'backend', status: 'complete', findings_count: 3, errors: [] }],
      findings: { new: 3, recurring: 0, fixed: 0 },
      violations: [],
    };
    const summary = buildSummary(db, runId, wave, report);
    assert.match(summary, /backend: complete \(3 findings\)/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-e164337b — additional sweep siblings (not named by the finding text):
// receipt.js:437 mirrors the named status.js:396 site; cli.js's promote
// --history gates ratio (1829) uses pluralizeWord directly (source pin,
// since driving it end-to-end needs a full promotions-table fixture the
// mechanical fix itself does not warrant).
// ──────────────────────────────────────────────────────────────

describe('F-e164337b — sweep sibling: receipt.js formatReceiptMarkdown test-count line', () => {
  function minimalReceipt(verification) {
    return {
      wave: { number: 1, phase: 'health-audit-a', status: 'collected', domain_snapshot_id: 'snap1', serial_verify_required: false, ownership_probe_degraded: false },
      run: { id: 'r1', repo: 'org/r', branch: 'main', commit_sha: 'a'.repeat(40) },
      generated_at: new Date().toISOString(),
      agents: [], state_transitions: [], artifacts: [], ownership_violations: [],
      findings: { total: 0, by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, by_status: {}, this_wave: { new: 0, recurring: 0, fixed: 0 } },
      verification,
      recommendation: { action: 'ADVANCE', reason: 'test' },
    };
  }

  it('test_count=1 renders "1 test", not "1 tests" (mirrors the named status.js:396 site exactly)', () => {
    const md = formatReceiptMarkdown(minimalReceipt({ passed: true, repo_type: 'node', test_count: 1, exit_code: 0 }));
    assert.match(md, /PASS \(node, 1 test,/, `expected "1 test" in:\n${md}`);
    assert.doesNotMatch(md, /1 tests\b/, 'pre-fix: this rendered "1 tests"');
  });
});

describe('F-e164337b — sweep sibling: status.js formatStatus test-count line', () => {
  function stubStatus(testCount) {
    return {
      run: { id: 'r1', repo: 'org/r', status: 'health-audit-a', branch: 'main', commitSha: 'abcdef0123', savePointTag: null, timeoutPolicy: '1800s' },
      domains: [],
      waves: { total: 0, current: null },
      agents: [],
      agentSummary: { total: 0, complete: 0, inFlight: 0, blocked: 0 },
      findings: { total: 0, bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, byStatus: {}, open: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, thisWave: { new: 0, recurring: 0, fixed: 0 } },
      violations: 0,
      lastVerification: { passed: true, repoType: 'node', testCount },
      waveReceipt: null,
      assessment: { state: 'noop', blockers: [], nextAction: 'noop' },
    };
  }

  it('testCount=1 renders "1 test", not "1 tests" (F-e164337b\'s own named site)', () => {
    const out = formatStatus(stubStatus(1));
    assert.match(out, /Verify: PASS \(node, 1 test\)/, `expected "1 test" in:\n${out}`);
    assert.doesNotMatch(out, /1 tests\b/, 'pre-fix: this rendered "1 tests"');
  });
});

describe('F-e164337b — sweep sibling: cli.js promote --history gates ratio uses pluralizeWord (source pin)', () => {
  it('the "gates" trailer in the --history table row is built via pluralizeWord(total, \'gate\'), not a bare template literal', () => {
    // Driving `swarm domains --history` end-to-end needs a full promotions-
    // table fixture (wave_id/run_id FKs + JSON gates_checked) that this
    // mechanical wording fix does not itself warrant — pluralizeWord's own
    // behavior is already unit-pinned above. This is a structural pin on the
    // call site instead, matching wave8-resume-next-verb.test.js's precedent
    // for pinning a non-exported cli.js branch by source text.
    const anchorIdx = CLI_SRC.indexOf("console.log('Promotion history:');");
    assert.ok(anchorIdx > -1, 'expected to find the promote --history header in cli.js');
    const nearby = CLI_SRC.slice(anchorIdx, anchorIdx + 700);
    assert.match(nearby, /\$\{gates\}\/\$\{total\}\s+\$\{pluralizeWord\(total, 'gate'\)\}/,
      `the --history row must build its gates trailer via pluralizeWord(total, 'gate'). Nearby source:\n${nearby}`);
  });
});

// ──────────────────────────────────────────────────────────────
// F-94175151 — status.js Open: line total-label disambiguation
// ──────────────────────────────────────────────────────────────

/** @pins F-94175151 */
describe('F-94175151 — `swarm status` Open: line disambiguates its trailing total', () => {
  function stubStatusWithFindings(open, total) {
    return {
      run: { id: 'r1', repo: 'org/r', status: 'health-audit-a', branch: 'main', commitSha: 'abcdef0123', savePointTag: null, timeoutPolicy: '1800s' },
      domains: [],
      waves: { total: 0, current: null },
      agents: [],
      agentSummary: { total: 0, complete: 0, inFlight: 0, blocked: 0 },
      findings: { total, bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, byStatus: {}, open, thisWave: { new: 0, recurring: 0, fixed: 0 } },
      violations: 0,
      lastVerification: null,
      waveReceipt: null,
      assessment: { state: 'noop', blockers: [], nextAction: 'noop' },
    };
  }

  it('the exact reproduction from the finding: open 0/0/11/16 (sums to 27) alongside f.total=367 reads unambiguously', () => {
    const out = formatStatus(stubStatusWithFindings({ CRITICAL: 0, HIGH: 0, MEDIUM: 11, LOW: 16 }, 367));
    const openLine = out.split('\n').find(l => l.includes('Open:'));
    assert.ok(openLine, 'expected an Open: line');
    assert.match(openLine, /\(367 total ever filed\)/,
      `pre-fix this rendered the unlabeled "(367 total)", reading as 0+0+11+16=27 at a glance: "${openLine}"`);
    // PRECISION GUARD: the four open counts themselves are untouched by this
    // fix — only the trailing parenthetical's label changed.
    assert.match(openLine, /CRIT 0\s+HIGH 0\s+MED 11\s+LOW 16/);
  });

  it('PRECISION GUARD: when open counts DO sum to the total (a fresh run, nothing yet disposed), the label still reads correctly', () => {
    const out = formatStatus(stubStatusWithFindings({ CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 }, 1));
    const openLine = out.split('\n').find(l => l.includes('Open:'));
    assert.match(openLine, /\(1 total ever filed\)/);
  });
});

// ──────────────────────────────────────────────────────────────
// F-4e4b88f7 — history.js pad() column-budget truncation
// ──────────────────────────────────────────────────────────────

/** @pins F-4e4b88f7 */
describe('F-4e4b88f7 — `swarm history` fixed-column contract holds for a long status name', () => {
  function stubWave() {
    return { id: 1, run_id: 'r1', wave_number: 1, phase: 'health-audit-a', status: 'aborted_for_rewind' };
  }

  it('a row whose to_status is \'aborted_for_rewind\' (19 chars, a real rewind.js REWIND_TARGET_STATUS value) keeps WHEN column-aligned with every other row and the header', () => {
    const events = [
      { from_status: 'dispatched', to_status: 'collected', created_at: '2026-07-17 05:00:00', reason: 'normal collect' },
      { from_status: 'collected', to_status: 'aborted_for_rewind', created_at: '2026-07-17 05:06:00', reason: 'rewind: operator requested rollback to save point' },
    ];
    const text = formatHistory({ wave: stubWave(), events });
    const lines = text.split('\n');
    const headerLine = lines.find(l => l.startsWith('FROM'));
    assert.ok(headerLine, 'expected a FROM/TO/WHEN/REASON header line');
    const whenColOffset = headerLine.indexOf('WHEN');
    assert.ok(whenColOffset > -1);

    for (const ts of ['2026-07-17 05:00:00', '2026-07-17 05:06:00']) {
      const rowLine = lines.find(l => l.includes(ts));
      assert.ok(rowLine, `expected a row containing timestamp ${ts}`);
      assert.equal(rowLine.indexOf(ts), whenColOffset,
        `pre-fix: the aborted_for_rewind row's TO column (19 chars, >= the old FROM_W/TO_W=12) was returned unpadded, desyncing WHEN from the header by 7 characters. Row: "${rowLine}"`);
    }
  });

  it('the long status name itself is NOT silently dropped or corrupted — it still appears in full (widened columns fit it with zero truncation)', () => {
    const events = [
      { from_status: 'collected', to_status: 'aborted_for_rewind', created_at: '2026-07-17 05:06:00', reason: 'rewind: operator requested rollback' },
    ];
    const text = formatHistory({ wave: stubWave(), events });
    assert.match(text, /\baborted_for_rewind\b/, `expected the full status name, not a truncated fragment:\n${text}`);
    assert.doesNotMatch(text, /aborted_for_re\.\.\./, 'FROM_W/TO_W=19 must fit this 19-char name with zero truncation');
  });

  it('pad()\'s truncate-with-ellipsis fallback protects a FUTURE status name longer than the widened columns, instead of silently breaking again', () => {
    // A synthetic 25-char status name — longer than the widened FROM_W/TO_W=19
    // — proves the class fix (truncate-with-ellipsis), not just today's widen.
    const events = [
      { from_status: 'dispatched', to_status: 'a_hypothetical_future_status', created_at: '2026-07-17 06:00:00', reason: 'ok' },
    ];
    const text = formatHistory({ wave: stubWave(), events });
    const lines = text.split('\n');
    const headerLine = lines.find(l => l.startsWith('FROM'));
    const whenColOffset = headerLine.indexOf('WHEN');
    const rowLine = lines.find(l => l.includes('2026-07-17 06:00:00'));
    assert.ok(rowLine, 'expected the synthetic-status row to render');
    assert.equal(rowLine.indexOf('2026-07-17 06:00:00'), whenColOffset,
      `a status name longer than the widened FROM_W/TO_W must still truncate-to-width, not break alignment: "${rowLine}"`);
    assert.match(rowLine, /a_hypothetical_f\.\.\./, 'expected the truncate()-with-ellipsis shape, symmetric with the REASON column');
  });

  it('PRECISION GUARD: ordinary short status names (the common case) still column-align, with plain-space padding and no truncation artifact', () => {
    const events = [
      { from_status: 'dispatched', to_status: 'collected', created_at: '2026-07-17 05:00:00', reason: 'normal collect' },
    ];
    const text = formatHistory({ wave: stubWave(), events });
    const lines = text.split('\n');
    const headerLine = lines.find(l => l.startsWith('FROM'));
    const toColOffset = headerLine.indexOf('TO');
    const whenColOffset = headerLine.indexOf('WHEN');
    const rowLine = lines.find(l => l.startsWith('dispatched'));
    assert.ok(rowLine, 'expected the dispatched->collected row to render');
    assert.equal(rowLine.indexOf('collected'), toColOffset, 'TO column must align with the header');
    assert.equal(rowLine.indexOf('2026-07-17 05:00:00'), whenColOffset, 'WHEN column must align with the header');
    assert.match(rowLine, /normal collect$/, 'REASON must render in full, uncorrupted');
    assert.doesNotMatch(rowLine, /\.\.\./, 'a short status name must never be truncated');
  });
});
