/**
 * amend1-tx-discipline.test.js
 *
 * Wave A1 D3 — mechanical completeness gate for the executeTransition
 * atomicity invariant (H9).
 *
 * The rule. Any source site under `packages/dogfood-swarm/**` that performs
 * an `UPDATE agent_runs` statement IN PROXIMITY to an `INSERT INTO
 * agent_state_events` MUST live inside a `db.transaction(` block (either
 * directly or transitively through a helper that wraps).
 *
 * Approach. The wave-9 fix uses the executeTransition wrapper, so the
 * canonical pair lives ONLY in lib/state-machine.js. The guard:
 *
 *   1. Asserts that BOTH `UPDATE agent_runs` and `INSERT INTO
 *      agent_state_events` appearing in the SAME source file requires that
 *      file to contain `db.transaction(`.
 *
 *   2. Asserts that `executeTransition` and `applyTimeoutPolicy` function
 *      bodies in lib/state-machine.js are tx-aware (self-wraps the pair, or
 *      routes through transitionAgent which wraps).
 *
 * Allowlist mechanism preserved for any future site (tests, dev-mode tools,
 * raw migration scripts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

const TEST_FILE_PATTERN = /\.test\.(js|mjs)$/;

// Files allowed to UPDATE agent_runs OR INSERT agent_state_events without
// requiring a co-located db.transaction. Each entry must list a reason.
const ALLOWLIST = [
  // Sites that legitimately do a bare UPDATE on a non-status column.
  {
    file: 'commands/collect.js',
    reason: 'sets error_message on already-failed agents (no status change, no audit row needed).',
  },
  // applyTimeoutPolicy routes through transitionAgent which goes through
  // executeTransition (self-wrapping). The file legitimately mentions
  // UPDATE agent_runs only via the executeTransition path (no raw UPDATE).
  //
  // D3B-013 (Wave A2 Stage C): redrive.js has a same-status branch
  // (dispatched → dispatched) that records the operator's intent via a
  // raw `INSERT INTO agent_state_events`. canTransition rejects self-
  // loops in TRANSITIONS so we cannot route the no-op through the state
  // machine. The raw INSERT lives INSIDE the outer apply db.transaction()
  // so atomicity is preserved at the SQLite level; the file-level guard
  // above (text.includes('db.transaction(')) already accepts it. This
  // entry documents the special case so a future scan understands the
  // intent and a stricter line-level guard
  // (amend2-d3b-013-redrive-tx.test.js) pins the INSERT-inside-tx
  // structural invariant.
  {
    file: 'commands/redrive.js',
    reason: 'same-status (dispatched → dispatched) redrive intentionally uses a raw INSERT INTO agent_state_events because canTransition rejects self-loops. Raw INSERT lives inside the outer apply db.transaction() — pinned by amend2-d3b-013-redrive-tx.test.js.',
  },
];

function walkSync(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) walkSync(p, files);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
  return files;
}

function relativeFromPkg(absPath) {
  return absPath.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some(entry => entry.file === relPath);
}

describe('Tx discipline — UPDATE agent_runs + INSERT agent_state_events co-occurrence (H9)', () => {
  it('any file containing BOTH writes wraps them in db.transaction (executeTransition pattern)', () => {
    const all = walkSync(PKG_ROOT).filter(p => !TEST_FILE_PATTERN.test(relativeFromPkg(p)));

    const offenders = [];
    for (const f of all) {
      const rel = relativeFromPkg(f);
      const text = readFileSync(f, 'utf-8');
      const hasUpdate = /UPDATE\s+agent_runs/.test(text);
      const hasInsertEvent = /INSERT\s+INTO\s+agent_state_events/.test(text);
      if (!hasUpdate || !hasInsertEvent) continue;
      if (text.includes('db.transaction(')) continue;
      if (isAllowlisted(rel)) continue;
      offenders.push(rel);
    }

    assert.deepEqual(offenders, [],
      `H9 tx discipline violation — file has both UPDATE agent_runs AND ` +
      `INSERT INTO agent_state_events but no db.transaction() wrapper:\n  ${offenders.join('\n  ')}\n` +
      `Route through transitionAgent (which goes through executeTransition in ` +
      `lib/state-machine.js, the self-wrapping helper), or wrap the pair in ` +
      `db.transaction() at the call site.`);
  });

  it('lib/state-machine.js executeTransition body contains db.transaction(', () => {
    const text = readFileSync(join(PKG_ROOT, 'lib/state-machine.js'), 'utf-8');
    const fnMatch = text.match(/function executeTransition\([^)]*\) \{([\s\S]*?)\n\}/);
    assert.ok(fnMatch, 'executeTransition function must be defined');
    assert.ok(fnMatch[1].includes('db.transaction('),
      'executeTransition body must wrap in db.transaction()');
  });

  it('lib/state-machine.js applyTimeoutPolicy routes through transitionAgent (no raw SQL)', () => {
    const text = readFileSync(join(PKG_ROOT, 'lib/state-machine.js'), 'utf-8');
    const fnMatch = text.match(/export function applyTimeoutPolicy\([^)]*\) \{([\s\S]*?)\nexport /);
    assert.ok(fnMatch, 'applyTimeoutPolicy function must be defined and findable');
    const body = fnMatch[1];

    // applyTimeoutPolicy must NOT contain raw UPDATE agent_runs (the per-agent
    // transition must go through transitionAgent, which wraps).
    assert.ok(!body.match(/UPDATE\s+agent_runs/),
      'applyTimeoutPolicy must NOT contain raw UPDATE agent_runs — route ' +
      'through transitionAgent so executeTransition wraps the UPDATE+INSERT pair.');
    assert.ok(body.includes('transitionAgent('),
      'applyTimeoutPolicy must call transitionAgent so each iteration is atomic.');
  });
});
