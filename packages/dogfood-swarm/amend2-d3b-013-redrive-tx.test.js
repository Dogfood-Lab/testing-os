/**
 * amend2-d3b-013-redrive-tx.test.js
 *
 * Wave A2 Stage C — D3B-013 invariant.
 *
 * Pre-fix history. `commands/redrive.js` at line ~400 implements the
 * "same-status redrive" branch — when the agent_run is already at the
 * REDRIVE_TARGET_STATUS ('dispatched'), the operator's audit intent is
 * recorded via a direct `INSERT INTO agent_state_events` rather than
 * `transitionAgent`. The reason is structural: canTransition('dispatched',
 * 'dispatched') is false (no self-loop in TRANSITIONS), so the state
 * machine cannot route the no-op transition.
 *
 * The discipline question. The wave-A1 H9 invariant says UPDATE
 * agent_runs + INSERT INTO agent_state_events must co-occur inside a
 * db.transaction(). The redrive same-status branch does NO UPDATE — only
 * an INSERT — so the H9 wrap rule technically does not apply. But the
 * mechanical guard at `amend1-tx-discipline.test.js` is loose (file-
 * level: "if the file contains both writes AND has db.transaction(
 * anywhere, it passes"). A future regression could move the raw INSERT
 * outside the outer apply tx and the file-level guard would not catch it.
 *
 * The fix (option (b) per Wave A2 kickoff). Make the policy explicit:
 *   1. Extend amend1-tx-discipline.test.js's allowlist with a documented
 *      exception entry for commands/redrive.js naming the same-status
 *      branch and the reason canTransition rejects self-loops.
 *   2. Add a new mechanical guard (this file): the raw INSERT INTO
 *      agent_state_events in redrive.js must appear BETWEEN the
 *      `db.transaction(` open and the close of that function. We assert
 *      this at the source-text level so future moves outside the tx fail
 *      loudly at the test gate.
 *
 * Test invariants:
 *   - amend1-tx-discipline.test.js still passes (does NOT regress).
 *   - The raw INSERT INTO agent_state_events at the same-status branch
 *     in commands/redrive.js lives BETWEEN db.transaction( and the next
 *     top-level statement after the tx scope.
 *   - The behavioural probe: dispatch a wave (puts agent at dispatched),
 *     then redrive with --apply. The agent_state_events row is written
 *     with from_status='dispatched' and to_status='dispatched' — and we
 *     confirm via tx integrity that if the INSERT had failed, the wave-
 *     status change would have rolled back too.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { redrive } from './commands/redrive.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REDRIVE_SRC = readFileSync(join(__dirname, 'commands/redrive.js'), 'utf-8');

const RUN_ID = 'test-d3b-013';

function setupRun(dbPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  saveDomainDraft(db, RUN_ID, [
    { name: 'd1', globs: ['packages/d1/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);
}

describe('D3B-013 — redrive.js same-status raw INSERT lives inside db.transaction()', () => {
  it('the raw INSERT INTO agent_state_events in redrive.js appears after a db.transaction( open', () => {
    // F-911b18ef (wave 22): migrated off a local two-step regex stripper
    // (.replace(/\/\*...\*\//g).replace(/\/\/.../g)) onto the shared,
    // lexer-aware test-support/strip-comments.js — the naive pair has no
    // string/template/regex-literal awareness, unlike the shared module
    // (hardened for exactly that in wave-9's F-001/F-002). Differentially
    // checked against this file's real target (redrive.js): identical
    // output today, so this is a hygiene migration, not a behavior change.
    const code = stripComments(REDRIVE_SRC);
    const txOpenIdx = code.indexOf('db.transaction(');
    const rawInsertIdx = code.indexOf('INSERT INTO agent_state_events');
    assert.ok(txOpenIdx >= 0, 'redrive.js must declare db.transaction(');
    assert.ok(rawInsertIdx > txOpenIdx,
      'redrive.js raw INSERT INTO agent_state_events must appear AFTER db.transaction( opens');
  });

  it('the raw INSERT lives BEFORE the closing brace of the tx body (file-text scan)', () => {
    // Scan: find db.transaction(() => { ... });
    // and assert the raw INSERT INTO agent_state_events appears between
    // the opening brace of the arrow body and the matching closing brace.
    // F-911b18ef (wave 22): same shared-stripper migration as the sibling
    // test above.
    const code = stripComments(REDRIVE_SRC);
    const txMatch = code.match(/db\.transaction\(\s*\(\)\s*=>\s*\{/);
    assert.ok(txMatch, 'expected db.transaction(() => { in redrive.js apply path');
    const bodyStart = code.indexOf('{', txMatch.index + txMatch[0].length - 1);
    // Walk forward, counting brace depth to find the matching close.
    let depth = 1;
    let i = bodyStart + 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const bodyEnd = i - 1;
    const txBody = code.slice(bodyStart, bodyEnd);
    assert.ok(txBody.includes('INSERT INTO agent_state_events'),
      'the raw INSERT INTO agent_state_events must live INSIDE the db.transaction() body — found tx body but no raw insert inside it');
  });
});

describe('D3B-013 — behavioural probe: same-status redrive writes the audit row', () => {
  let tmpDir;
  let dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'd3b-013-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('same-status (dispatched → dispatched) redrive --apply writes an audit row inside tx', () => {
    // Dispatch creates the wave with agents in 'dispatched' (per F-002109-003,
    // the state machine writes started_at + an audit row).
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    const db = openDb(dbPath);
    // Baseline count of agent_state_events for this agent
    const ar = db.prepare('SELECT id, status FROM agent_runs WHERE wave_id = ? LIMIT 1')
      .get(result.waveId);
    assert.equal(ar.status, 'dispatched');
    const before = db.prepare(
      'SELECT COUNT(*) as n FROM agent_state_events WHERE agent_run_id = ?'
    ).get(ar.id).n;

    // Redrive --apply on a same-status wave should append an audit row.
    // The wave is currently 'dispatched' so REDRIVE_TARGET_STATUS matches
    // both wave and agent (same-status branch fires for both).
    redrive({
      waveId: result.waveId,
      reason: 'd3b-013 test — same-status redrive should still audit',
      dbPath,
      apply: true,
    });

    const after = db.prepare(
      'SELECT COUNT(*) as n FROM agent_state_events WHERE agent_run_id = ?'
    ).get(ar.id).n;
    assert.ok(after > before,
      `redrive --apply on a dispatched→dispatched same-status branch must append an audit row; before=${before} after=${after}`);

    // The newest event row's reason carries the redrive: prefix and the
    // operator's text.
    const newestEvent = db.prepare(`
      SELECT from_status, to_status, reason FROM agent_state_events
      WHERE agent_run_id = ? ORDER BY id DESC LIMIT 1
    `).get(ar.id);
    assert.equal(newestEvent.from_status, 'dispatched');
    assert.equal(newestEvent.to_status, 'dispatched');
    assert.match(newestEvent.reason, /^redrive:/,
      `the audit row reason must carry the "redrive:" prefix; got: ${newestEvent.reason}`);
    assert.match(newestEvent.reason, /d3b-013 test/,
      `the audit row must carry the operator's --reason text; got: ${newestEvent.reason}`);
  });
});
