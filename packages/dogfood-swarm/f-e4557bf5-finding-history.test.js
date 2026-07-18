/**
 * f-e4557bf5-finding-history.test.js
 *
 * F-e4557bf5 [MEDIUM] — no verb rendered a single finding's own event history
 * (finding_events): `swarm history <wave-id>` (commands/history.js) was
 * WAVE-scoped only (wave_state_events), and `swarm findings <run-id> [wave]`
 * renders a wave's raw audit-artifact digest, not a finding's live lifecycle.
 * Once C1/C2 added `reopened`/`operator_closed` event types, there was zero
 * read surface for "why was F-xxx reopened, by what evidence, how many
 * times" short of raw SQL.
 *
 * Fix: `swarm history <id>` now dispatches on the SHAPE of its one
 * positional argument. A bare positive integer is UNCHANGED (today's
 * wave_state_events transition chain). An `F-`-prefixed id renders that
 * finding's finding_events lifecycle via the new findingHistory()/
 * formatFindingHistory() (commands/history.js), chronological, with a
 * DERIVED from -> to status per event (finding_events has no from_status/
 * to_status column, unlike wave_state_events — see commands/history.js's
 * EVENT_RESULT_STATUS/RECURRENCE_PRESERVES_STATUS for exactly which write
 * site each mapping is transcribed from).
 *
 * RED PROOF: every `it()` below that exercises the finding-id path, plus the
 * wave-id byte-identical proof, was run against this wave's pre-fix
 * commands/history.js + cli.js (`git stash push -- packages/dogfood-swarm/
 * cli.js packages/dogfood-swarm/commands/history.js`, this test file left in
 * the working tree, `git stash pop` after) and failed as follows:
 *   - Importing `findingHistory`/`formatFindingHistory` from
 *     ./commands/history.js threw `SyntaxError: The requested module
 *     './commands/history.js' does not provide an export named
 *     'findingHistory'` — the whole file failed to load, so every test in it
 *     reported failed.
 *   - `swarm history F-<id>` (subprocess) fell through to the pre-fix
 *     wave-id-only path: `Number('F-aaaaaaaa')` is `NaN`, so it exited 1
 *     with "history: wave id must be a positive integer (got
 *     \"F-aaaaaaaa\")" instead of rendering any finding lifecycle.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { transitionWave } from './lib/wave-state-machine.js';
import { findingHistory, formatFindingHistory, pad, truncate } from './commands/history.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');
const CLI_SRC = stripComments(readFileSync(CLI_PATH, 'utf-8'));

const RUN_ID = 'finding-history-run';

let dbDir, dbPath;
beforeEach(() => {
  // Fresh per-test temp dir, removed by this SAME test's own afterEach below
  // (not a suite-wide after() pool) — dbDir never outlives the test that
  // created it, so there is nothing for a separate tmpRoots array to track.
  dbDir = mkdtempSync(join(tmpdir(), 'finding-history-db-'));
  dbPath = join(dbDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', dbDir, 'a'.repeat(40), 'main', 'health-audit-a');
  closeDb(dbPath);
});
afterEach(() => {
  try { closeDb(dbPath); } catch { /* already closed */ }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
});

function runHistory(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, 'history', ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath, ...extraEnv },
  });
}

/**
 * Seeds one finding plus a realistic finding_events sequence directly
 * (mirrors the exact call shapes lib/fingerprint.js#upsertFindings and
 * cli.js's transitionFindings/disposeFindings actually use, per this
 * finding's own instruction to "check how finding_events rows are actually
 * shaped ... before designing the render" — the same shapes are re-used
 * here so the test fixture is not a fiction of its own).
 */
function seedFindingWithEvents(db, findingId, events, { severity = 'MEDIUM', category = 'quality', filePath = 'packages/a/src/x.js' } = {}) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
      file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(RUN_ID, findingId, `fp-${findingId.toLowerCase()}`, severity, category, filePath, 1, `${findingId} description`, null, 'new');
  const rowId = db.prepare(`SELECT id FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, findingId).id;

  const insEvt = db.prepare(`INSERT INTO finding_events (finding_id, event_type, wave_id, notes, actor) VALUES (?, ?, ?, ?, ?)`);
  for (const e of events) {
    insEvt.run(rowId, e.event_type, e.wave_id ?? null, e.notes ?? null, e.actor ?? null);
  }
  // The LAST event's real-world status effect must already be reflected in
  // findings.status by the caller (mirrors production: upsertFindings/
  // transitionFindings always update `status` in the SAME transaction as the
  // finding_events insert) — set explicitly so this fixture cannot silently
  // drift from what a real wave would have written.
  return rowId;
}

/** @pins F-e4557bf5 */
describe('F-e4557bf5 — swarm history <finding-id> renders finding_events lifecycle', () => {
  it('reported -> recurred (severity escalation, OPEN) -> fixed: TO column matches findings.status at every step, including the final one', () => {
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-LIFECYC1', [
      { event_type: 'reported', wave_id: null, notes: null },
      { event_type: 'recurred', wave_id: null, notes: 'severity escalated MEDIUM -> HIGH on recurrence' },
      { event_type: 'fixed', wave_id: null, notes: 'closed by absence — not rediscovered in full-coverage re-audit' },
    ], { severity: 'HIGH' });
    db.prepare(`UPDATE findings SET status = 'fixed' WHERE run_id = ? AND finding_id = ?`).run(RUN_ID, 'F-LIFECYC1');
    closeDb(dbPath);

    const report = findingHistory({ findingId: 'F-LIFECYC1', dbPath });
    assert.equal(report.events.length, 3);
    assert.equal(report.events[0].event_type, 'reported');
    assert.equal(report.events[0].statusFrom, undefined, 'the very first event has no prior status');
    assert.equal(report.events[0].statusTo, 'new');
    assert.equal(report.events[1].event_type, 'recurred');
    assert.equal(report.events[1].statusFrom, 'new');
    assert.equal(report.events[1].statusTo, 'recurring', 'an open recurrence resets status to recurring');
    assert.equal(report.events[2].event_type, 'fixed');
    assert.equal(report.events[2].statusFrom, 'recurring');
    assert.equal(report.events[2].statusTo, 'fixed');
    // Cross-check against the REAL findings.status column — this is the
    // oracle: if EVENT_RESULT_STATUS/RECURRENCE_PRESERVES_STATUS were wrong,
    // this specific assertion is the one that would catch it, because it
    // compares the DERIVED final status against ACTUAL persisted state, not
    // against another derivation.
    assert.equal(report.events[report.events.length - 1].statusTo, report.finding.status);
  });

  it('recurred-while-deferred PRESERVES status — the one case a static event_type->status table cannot express', () => {
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-PRESERVE1', [
      { event_type: 'reported', wave_id: null, notes: null },
      { event_type: 'deferred', wave_id: null, notes: 'punting to next quarter' },
      { event_type: 'recurred', wave_id: null, notes: 'recurred-while-deferred: rediscovered by this wave; deferred status preserved' },
    ]);
    db.prepare(`UPDATE findings SET status = 'deferred' WHERE run_id = ? AND finding_id = ?`).run(RUN_ID, 'F-PRESERVE1');
    closeDb(dbPath);

    const report = findingHistory({ findingId: 'F-PRESERVE1', dbPath });
    assert.equal(report.events[1].statusTo, 'deferred');
    assert.equal(report.events[2].event_type, 'recurred');
    assert.equal(report.events[2].statusFrom, 'deferred');
    assert.equal(report.events[2].statusTo, 'deferred', 'recurring while deferred must NOT flip status to recurring');
    assert.equal(report.events[2].statusTo, report.finding.status, 'derived final status must match the real column');
  });

  it("reopened's event_type and its resulting status are DIFFERENT LITERALS — the exact gap this finding names", () => {
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-REOPEN01', [
      { event_type: 'reported', wave_id: null, notes: null },
      { event_type: 'fixed', wave_id: null, notes: 'original fix landed' },
      { event_type: 'reopened', wave_id: null, notes: 'reason: regressed | evidence: repro attached', actor: 'operator' },
    ]);
    db.prepare(`UPDATE findings SET status = 'recurring' WHERE run_id = ? AND finding_id = ?`).run(RUN_ID, 'F-REOPEN01');
    closeDb(dbPath);

    const report = findingHistory({ findingId: 'F-REOPEN01', dbPath });
    const reopenEvent = report.events[2];
    assert.equal(reopenEvent.event_type, 'reopened');
    assert.equal(reopenEvent.statusTo, 'recurring', 'reopened must resolve to status recurring, NOT the literal "reopened"');
    assert.notEqual(reopenEvent.statusTo, reopenEvent.event_type, 'event_type and resulting status are deliberately different literals');
  });

  it('formatFindingHistory renders WAVE/EVENT/FROM/TO/WHEN/REASON columns, escapes notes, and shows "(none)" for a null wave/notes', () => {
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-RENDER001', [
      { event_type: 'reported', wave_id: null, notes: null },
    ]);
    closeDb(dbPath);

    const report = findingHistory({ findingId: 'F-RENDER001', dbPath });
    const text = formatFindingHistory(report);
    assert.match(text, /WAVE\s+EVENT\s+FROM\s+TO\s+WHEN\s+REASON/);
    assert.match(text, /\(none\)\s+reported\s+\(none\)\s+new/);
    assert.match(text, /\(1 event\)/);
  });

  it('an unknown finding id fails LOUD, naming the run-resolution attempted (searched across all runs)', () => {
    const r = runHistory(['F-deadbeef']);
    assert.equal(r.status, 1, `stdout:\n${r.stdout}`);
    assert.match(r.stderr, /finding not found/);
    assert.match(r.stderr, /F-deadbeef/);
    assert.match(r.stderr, /searched across all runs/i, 'must name the resolution mechanism attempted, not just say "not found"');
  });

  it('a finding id colliding across TWO runs is ambiguous by default, and --run disambiguates', () => {
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-COLLIDE1', [{ event_type: 'reported', wave_id: null, notes: null }]);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('finding-history-run-2', 'org/repo2', dbDir, 'b'.repeat(40), 'main', 'health-audit-a');
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES ('finding-history-run-2', 'F-COLLIDE1', 'fp-collide-2', 'LOW', 'docs', 'second run collision', 'new', NULL, NULL)
    `).run();
    const otherRowId = db.prepare(`SELECT id FROM findings WHERE run_id = 'finding-history-run-2' AND finding_id = 'F-COLLIDE1'`).get().id;
    db.prepare(`INSERT INTO finding_events (finding_id, event_type, notes) VALUES (?, 'reported', NULL)`).run(otherRowId);
    closeDb(dbPath);

    const ambiguous = runHistory(['F-COLLIDE1']);
    assert.equal(ambiguous.status, 1, `stdout:\n${ambiguous.stdout}`);
    assert.match(ambiguous.stderr, /2 runs/);
    assert.match(ambiguous.stderr, new RegExp(RUN_ID));
    assert.match(ambiguous.stderr, /finding-history-run-2/);
    assert.match(ambiguous.stderr, /--run/, 'the ambiguous error must name the --run escape hatch');

    const disambiguated = runHistory(['F-COLLIDE1', '--run', 'finding-history-run-2']);
    assert.equal(disambiguated.status, 0, `stderr:\n${disambiguated.stderr}`);
    assert.match(disambiguated.stdout, /finding-history-run-2/);
  });

  it('finding-id matching is CASE-INSENSITIVE (lowercase f- resolves the same row)', () => {
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-CASEFOLD', [{ event_type: 'reported', wave_id: null, notes: null }]);
    closeDb(dbPath);

    const r = runHistory(['f-casefold']);
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /F-CASEFOLD/);
  });

  it('--format=json emits the report LOSSLESSLY (raw notes) while text mode escapes the same field', () => {
    const RAW_NEWLINE_NOTES = 'legit reason\n(9001 runs) F-000000 FORGED entirely fake event';
    const db = openDb(dbPath);
    seedFindingWithEvents(db, 'F-ESCAPE02', [
      { event_type: 'reported', wave_id: null, notes: null },
      { event_type: 'deferred', wave_id: null, notes: RAW_NEWLINE_NOTES },
    ]);
    db.prepare(`UPDATE findings SET status = 'deferred' WHERE run_id = ? AND finding_id = ?`).run(RUN_ID, 'F-ESCAPE02');
    closeDb(dbPath);

    const jsonResult = runHistory(['F-ESCAPE02', '--format=json']);
    assert.equal(jsonResult.status, 0, `stderr:\n${jsonResult.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(jsonResult.stdout); },
      `--format=json must emit parseable JSON; got:\n${jsonResult.stdout}`);
    const deferredEvent = parsed.events.find((e) => e.event_type === 'deferred');
    assert.equal(deferredEvent.notes, RAW_NEWLINE_NOTES, 'JSON path must carry notes LOSSLESSLY, raw newline included');

    const textResult = runHistory(['F-ESCAPE02']);
    assert.equal(textResult.status, 0, `stderr:\n${textResult.stderr}`);
    assert.match(textResult.stdout, /\\n/, 'text mode must render the escaped \\n marker, not a raw newline');
    const forgedLine = textResult.stdout.split('\n').find((l) => l.includes('FORGED entirely fake event') && !l.includes('legit reason'));
    assert.equal(forgedLine, undefined, 'the injected text must never appear as its own unescaped line');
  });

  it('--help documents both the wave-id and finding-id invocation forms', () => {
    const r = runHistory(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /<wave-id>/);
    assert.match(r.stdout, /<finding-id>/);
    assert.match(r.stdout, /--run/);
  });
});

describe('F-e4557bf5 — no-flag `swarm history <wave-id>` stays byte-identical to before this feature', () => {
  it('STRUCTURAL: the F- shape check is the FIRST branch in cmdHistory, before the wave-id history() call', () => {
    const shapeCheckAnchor = CLI_SRC.indexOf("if (/^F-/i.test(idArg)) {");
    const legacyCallAnchor = CLI_SRC.indexOf('const report = history({ waveId: idArg, dbPath: getDbPath() });');
    assert.ok(shapeCheckAnchor > 0, 'the F- shape-dispatch check must exist in cli.js');
    assert.ok(legacyCallAnchor > 0, 'the pre-existing history() call must still exist, unmoved');
    assert.ok(shapeCheckAnchor < legacyCallAnchor,
      'the finding-id shape check must be evaluated (and return) BEFORE the wave-id history() call, ' +
      'so a bare positive integer can never be misrouted to the finding-id path');
  });

  it('LIVE: a real numeric wave id renders the SAME wave_state_events transition chain as before (zero regression)', () => {
    const db = openDb(dbPath);
    const waveId = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, ?, ?)`
    ).run(RUN_ID, 'health-audit-a', 1, 'dispatched').lastInsertRowid;
    closeDb(dbPath);

    const dbForTransition = openDb(dbPath);
    transitionWave(dbForTransition, waveId, 'failed', 'agent timed out');
    closeDb(dbPath);

    const r = runHistory([String(waveId)]);
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, new RegExp(`Wave ${waveId} \\(run ${RUN_ID}`), 'must render the wave-scoped header, not a finding header');
    assert.match(r.stdout, /FROM\s+TO\s+WHEN\s+REASON/, 'must render the ORIGINAL wave-scoped column set, not the finding-scoped one');
    assert.match(r.stdout, /dispatched/);
    assert.match(r.stdout, /failed/);
    assert.match(r.stdout, /agent timed out/);
  });

  it('LIVE: a non-numeric, non-F-prefixed argument still produces the EXACT original "wave id must be a positive integer" error', () => {
    const r = runHistory(['abc']);
    assert.equal(r.status, 1, `stdout:\n${r.stdout}`);
    assert.match(r.stderr, /wave id must be a positive integer \(got "abc"\)/);
  });

  it('LIVE: an unknown wave id still produces the EXACT original WAVE_NOT_FOUND error, not a finding-not-found error', () => {
    const r = runHistory(['999999']);
    assert.equal(r.status, 1, `stdout:\n${r.stdout}`);
    assert.match(r.stderr, /history: wave not found: 999999/);
    assert.doesNotMatch(r.stderr, /finding not found/);
  });
});

describe('F-e4557bf5 — pad/truncate are shared verbatim between the wave-scoped and finding-scoped renderers', () => {
  it('pad/truncate are exported from commands/history.js and behave identically to their pre-fix private forms', () => {
    assert.equal(typeof pad, 'function');
    assert.equal(typeof truncate, 'function');
    assert.equal(pad('x', 5), 'x    ');
    assert.equal(pad('toolongvalue', 5), 'to...');
    assert.equal(truncate('hello world', 5), 'he...');
    assert.equal(truncate('hi', 5), 'hi');
  });
});

/**
 * SIBLING SWEEP (per swarms/PROTOCOL.md's "fixing a class, not an instance"):
 * is there another verb taking a single positional id argument that could
 * benefit from the same shape-based dispatch (a dual id-namespace the way
 * wave-id / finding-id is)? Grepped every `/^\d+$/`-or-similar shape check
 * against a first positional in cli.js this pass: `receipt <run-id>
 * [wave-number]` takes an always-string run-id PLUS an optional numeric
 * wave-number — not a single ambiguous positional. `redrive <wave-id>`,
 * `resume <run-id>`, `domains <run-id>`, `rewind <save-point-tag>` each have
 * exactly one id NAMESPACE, so there is nothing to disambiguate. No sibling
 * opportunity found.
 */
describe('F-e4557bf5 — sibling sweep: no other verb shares the wave-id/finding-id dual-namespace shape', () => {
  it('the /^F-/i shape-dispatch check exists at exactly one call site in cli.js (cmdHistory)', () => {
    const occurrences = CLI_SRC.split('/^F-/i.test(').length - 1;
    assert.equal(occurrences, 1,
      `expected exactly one /^F-/i.test( shape-dispatch site (cmdHistory); found ${occurrences} — ` +
      `a second site would mean another verb grew the same dual-namespace shape this sweep did not account for`);
  });
});
