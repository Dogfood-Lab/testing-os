/**
 * amend1-state-machine-tx.test.js
 *
 * Wave A1 D3 — H9 invariant test.
 *
 * The state machine's `executeTransition` updates `agent_runs.status` then
 * inserts an audit row into `agent_state_events`. Pre-fix these two writes
 * happened OUTSIDE a `db.transaction()` wrapper, so a crash between the two
 * left the wave row updated with no corresponding audit row — silently
 * breaking the auditability the state machine exists to provide (Stripe
 * Ledger pattern: state + audit land together or not at all).
 *
 * The sibling `wave-state-machine.js executeTransition` (line 245-264) was
 * already correctly wrapped in `db.transaction()`. H9 brings agent-side
 * state changes into the same discipline.
 *
 * The H9 sibling at `applyTimeoutPolicy` (lib/state-machine.js:184) loops
 * over in-flight agents and calls `transitionAgent` per agent — each call
 * is now atomic (because `executeTransition` self-wraps). This test
 * verifies BOTH the function-body invariant (the helper text contains
 * `db.transaction(`) AND a behavioural probe (a transition emits exactly
 * one event row OR rolls back cleanly).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { transitionAgent, applyTimeoutPolicy } from './lib/state-machine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_MACHINE_SRC = readFileSync(
  join(__dirname, 'lib/state-machine.js'),
  'utf-8'
);

function seedWave(db) {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status)
    VALUES ('r1', 'org/x', '/tmp/x', ?, 'health-audit-a')`).run('a'.repeat(40));
  // Two owned domains with DISJOINT globs. (Pre sm-002 this seed used `['**']`
  // for both, but freezeDomains now rejects overlapping owned globs because two
  // exclusive owners claiming the same file breaches per-domain isolation. The
  // glob values are irrelevant to this file's agent-state-machine atomicity
  // probes — they only need two distinct domains — so disjoint globs keep the
  // intent and satisfy the freeze guard.)
  saveDomainDraft(db, 'r1', [
    { name: 'd1', globs: ['src/**'], ownership_class: 'owned' },
    { name: 'd2', globs: ['tests/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, 'r1');
  db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status)
    VALUES ('r1', 'health-audit-a', 1, 'dispatched')`).run();
  const domains = db.prepare("SELECT * FROM domains WHERE run_id = 'r1'").all();
  const ids = [];
  for (const d of domains) {
    const r = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status)
      VALUES (1, ?, 'dispatched')`).run(d.id);
    ids.push(Number(r.lastInsertRowid));
  }
  // Backdate started_at so applyTimeoutPolicy sees them as overdue.
  for (const id of ids) {
    db.prepare(
      "UPDATE agent_runs SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(id);
  }
  return { ids, domains };
}

describe('H9 — executeTransition + applyTimeoutPolicy atomicity', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('executeTransition body contains db.transaction( wrapper (source probe)', () => {
    // Anchor invariant — the helper text must use the Stripe Ledger pattern.
    // This is the same shape wave-state-machine.js:248 already uses.
    // F-H9 (Wave A1 D3): the executeTransition function specifically must
    // wrap its UPDATE + INSERT in a transaction. The check is scoped to the
    // function body so a `db.transaction(` reference elsewhere in the file
    // (e.g. a future utility) doesn't satisfy the gate.
    const fnMatch = STATE_MACHINE_SRC.match(
      /function executeTransition\([^)]*\) \{([\s\S]*?)\n\}/
    );
    assert.ok(fnMatch, 'executeTransition function must be defined');
    const body = fnMatch[1];
    assert.ok(body.includes('db.transaction('),
      'executeTransition body must wrap UPDATE + INSERT in db.transaction()');
  });

  it('applyTimeoutPolicy loop calls transitionAgent (each transition self-atomic)', () => {
    // Per the kickoff H9 sibling: applyTimeoutPolicy's loop iterates and
    // performs UPDATE+INSERT per timed-out agent. The fix shape is "make
    // executeTransition self-wrap so the per-agent pair is atomic" — we
    // assert applyTimeoutPolicy still routes through transitionAgent so it
    // inherits the atomicity for free, instead of doing raw SQL.
    //
    // The behavioural probe: drive the loop and assert each agent's
    // post-state agrees with the audit-row count (no torn rows).
    const { ids } = seedWave(db);
    const beforeEvents = db.prepare(
      'SELECT COUNT(*) as n FROM agent_state_events'
    ).get().n;
    const result = applyTimeoutPolicy(db, 1, 60000, Date.parse('2026-06-01'));
    assert.equal(result.length, ids.length, 'all dispatched agents timed out');

    // Each timed-out agent has status=timed_out AND a dispatched→timed_out
    // audit row in agent_state_events. The count must match exactly — a
    // missing audit row would mean the UPDATE+INSERT pair was torn.
    const afterEvents = db.prepare(
      'SELECT COUNT(*) as n FROM agent_state_events'
    ).get().n;
    assert.equal(afterEvents - beforeEvents, ids.length,
      'every UPDATE must have a paired INSERT (atomic transitions)');

    for (const id of ids) {
      const ar = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(id);
      assert.equal(ar.status, 'timed_out');
      const evRow = db.prepare(`
        SELECT to_status FROM agent_state_events
        WHERE agent_run_id = ? ORDER BY id DESC LIMIT 1
      `).get(id);
      assert.equal(evRow.to_status, 'timed_out',
        `audit row for agent ${id} must match the new status`);
    }
  });

  it('transitionAgent rolls back both writes when the INSERT fails (atomicity)', () => {
    // The strongest probe: induce an INSERT failure mid-transaction and
    // confirm the UPDATE is rolled back too. We trigger the INSERT failure
    // by dropping the agent_state_events table mid-test, then attempting a
    // transition. better-sqlite3's db.transaction() throws and rolls back
    // the surrounding tx.
    seedWave(db);
    const agentId = db.prepare(
      "SELECT id FROM agent_runs WHERE wave_id = 1 LIMIT 1"
    ).get().id;
    const statusBefore = db.prepare(
      'SELECT status FROM agent_runs WHERE id = ?'
    ).get(agentId).status;
    assert.equal(statusBefore, 'dispatched');

    db.prepare('DROP TABLE agent_state_events').run();

    let threw = null;
    try {
      transitionAgent(db, agentId, 'complete', 'test-tx-rollback');
    } catch (e) {
      threw = e;
    }

    assert.ok(threw, 'transitionAgent must throw when agent_state_events INSERT fails');

    // The UPDATE must be rolled back — agent status must still be
    // 'dispatched' (not 'complete'). If the pre-fix shape persists, the
    // UPDATE would have committed before the INSERT failed and this would
    // read 'complete'.
    const statusAfter = db.prepare(
      'SELECT status FROM agent_runs WHERE id = ?'
    ).get(agentId).status;
    assert.equal(statusAfter, 'dispatched',
      'UPDATE must roll back when INSERT fails (Stripe Ledger atomicity)');
  });
});

/**
 * F-20b5987a: isolate the ACTUAL callback body passed to `db.transaction(`
 * by brace-depth matching from its own opening `{` to its own closing `}`,
 * rather than comparing string-index ORDERING against where
 * `db.transaction(` happens to start. Ordering only proves "appears
 * somewhere after the substring `db.transaction(`", which is satisfied by
 * code shaped as
 *   db.transaction(() => { unrelated })();
 *   db.prepare('UPDATE agent_runs...').run();
 *   db.prepare('INSERT INTO agent_state_events...').run();
 * — both writes sit textually after `txStart` while living completely
 * OUTSIDE any transaction. True containment requires the writes to be
 * inside the isolated callback substring, not merely after its start index.
 */
function extractTransactionCallbackBody(fnBody) {
  const openParenIdx = fnBody.indexOf('db.transaction(');
  if (openParenIdx === -1) return null;
  const openBraceIdx = fnBody.indexOf('{', openParenIdx + 'db.transaction('.length);
  if (openBraceIdx === -1) return null;
  let depth = 0, i = openBraceIdx;
  for (; i < fnBody.length; i++) {
    if (fnBody[i] === '{') depth++;
    else if (fnBody[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null; // unbalanced — extraction failed, caller must treat as not-found
  return fnBody.slice(openBraceIdx, i + 1);
}

describe('H9 — tx discipline mechanical guard', () => {
  it('executeTransition wraps both writes inside ONE db.transaction', () => {
    // Source-level guard. Walk the file, find executeTransition body, and
    // assert:
    //   - exactly one `db.transaction(` opens
    //   - both an `UPDATE agent_runs` and an `INSERT INTO agent_state_events`
    //     appear INSIDE that transaction's own callback body (containment,
    //     not textual ordering — see extractTransactionCallbackBody above)
    //   - neither appears a second time outside the callback in the function
    const fnMatch = STATE_MACHINE_SRC.match(
      /function executeTransition\([^)]*\) \{([\s\S]*?)\n\}/
    );
    assert.ok(fnMatch);
    const body = fnMatch[1];

    assert.equal((body.match(/db\.transaction\(/g) || []).length, 1,
      'executeTransition must open db.transaction( exactly once');

    const txBody = extractTransactionCallbackBody(body);
    assert.ok(txBody, 'must be able to isolate the db.transaction( callback body');

    assert.ok(/UPDATE\s+agent_runs/.test(txBody),
      'UPDATE agent_runs must appear INSIDE the db.transaction() callback body — ' +
      'appearing merely after db.transaction( opens is not sufficient');
    assert.ok(/INSERT\s+INTO\s+agent_state_events/.test(txBody),
      'INSERT INTO agent_state_events must appear INSIDE the db.transaction() callback body — ' +
      'appearing merely after db.transaction( opens is not sufficient');

    // Containment, not just presence: neither write may ALSO occur a second
    // time outside the callback (e.g. a stray raw UPDATE once the
    // transaction has already closed) — the callback-scoped occurrence
    // count must equal the whole-function occurrence count.
    assert.equal(
      (body.match(/UPDATE\s+agent_runs/g) || []).length,
      (txBody.match(/UPDATE\s+agent_runs/g) || []).length,
      'UPDATE agent_runs must not appear anywhere in executeTransition OUTSIDE the transaction callback');
    assert.equal(
      (body.match(/INSERT\s+INTO\s+agent_state_events/g) || []).length,
      (txBody.match(/INSERT\s+INTO\s+agent_state_events/g) || []).length,
      'INSERT INTO agent_state_events must not appear anywhere in executeTransition OUTSIDE the transaction callback');
  });
});
