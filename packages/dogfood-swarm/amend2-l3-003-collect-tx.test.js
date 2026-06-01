/**
 * amend2-l3-003-collect-tx.test.js
 *
 * Wave A2 Stage C — L3-003 (family seal of D3B-002).
 *
 * D3B-002 wrapped dispatch.js + resume.js wave-build/redispatch loops in
 * `db.transaction()`. collect.js is the unstated sibling: its per-agent
 * for-loop performs direct DB writes per iteration (tryTransition + UPDATE
 * agent_runs + INSERT INTO artifacts + INSERT INTO file_claims) with no
 * outer transaction. A mid-loop crash (agent A's artifacts committed,
 * agent B's readFileSync OOM-throws) leaves divergent per-agent state.
 *
 * This test pins the L3-003 fix: the entire per-agent collection loop now
 * runs inside `db.transaction(() => { … })`. better-sqlite3 nests the
 * inner executeTransition self-wrap (Wave-A1 H9) as a SAVEPOINT so
 * atomicity composes.
 *
 * Mechanical guard: collect.js must contain `db.transaction(` AND the
 * per-agent for-loop's prepared statements (`INSERT INTO artifacts`,
 * `UPDATE agent_runs SET error_message`) must appear inside that block.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECT_SRC = readFileSync(join(__dirname, 'commands/collect.js'), 'utf-8');

// Strip line comments first so substrings like `/**` inside a `//` comment
// (e.g. a `//` comment referencing `packages/dogfood-swarm/double-star`)
// are not parsed as the open of a JSDoc block-comment by the block-strip
// regex, which would swallow real code until the next close-block marker.
// Block comments are stripped second.
function stripComments(src) {
  let out = src.replace(/\/\/[^\n]*/g, '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  return out;
}

describe('L3-003 — collect.js per-agent loop atomicity (family seal of D3B-002)', () => {
  const collectCode = stripComments(COLLECT_SRC);

  it('collect.js contains db.transaction(', () => {
    assert.ok(collectCode.includes('db.transaction('),
      'collect.js must wrap its per-agent loop in db.transaction()');
  });

  it('per-agent for-loop (for (const ar of agentRuns)) appears inside db.transaction(', () => {
    const txOpenIdx = collectCode.indexOf('db.transaction(');
    const forLoopIdx = collectCode.search(/for\s*\(\s*const\s+ar\s+of\s+agentRuns\s*\)/);
    assert.ok(txOpenIdx >= 0, 'db.transaction( must exist in collect.js');
    assert.ok(forLoopIdx > txOpenIdx,
      'per-agent for-loop must appear AFTER db.transaction( opens (so its body runs inside the tx)');
  });

  it('INSERT INTO artifacts statement appears inside the db.transaction() block', () => {
    const txOpenIdx = collectCode.indexOf('db.transaction(');
    const insertArtifactsIdx = collectCode.search(/INSERT\s+INTO\s+artifacts/);
    assert.ok(txOpenIdx >= 0);
    assert.ok(insertArtifactsIdx > txOpenIdx,
      'INSERT INTO artifacts must appear inside the db.transaction() block');
  });

  it('UPDATE agent_runs SET error_message statement appears inside the db.transaction() block', () => {
    const txOpenIdx = collectCode.indexOf('db.transaction(');
    const updateErrorMsgIdx = collectCode.search(/UPDATE\s+agent_runs\s+SET\s+error_message/);
    assert.ok(txOpenIdx >= 0);
    assert.ok(updateErrorMsgIdx > txOpenIdx,
      'UPDATE agent_runs SET error_message must appear inside the db.transaction() block');
  });
});
