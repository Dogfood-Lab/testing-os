/**
 * advance-six-gates-count.test.js — F-efe53969 (site 2 of 2): lib/advance.js
 * had TWO stale "evaluate ALL five gates" comments (lines 106 and 337-338)
 * left over from before the v9 adjudication gate was added — the `gates`
 * array assembled in checkGates() has SIX entries (wave, agent, ownership,
 * verify, finding_severity, adjudication), not five, confirmed by direct
 * count. Comment/config drift of the same shape this wave's docs audit
 * exists to catch, just inside .js source rather than a doc file.
 *
 * This pins the BEHAVIORAL fact the comments describe (six gates, always
 * evaluated, never truncated) so a future stale-comment drift of this exact
 * shape has a red test, not just a corrected comment.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { checkGates } from './advance.js';

describe('checkGates — always evaluates and returns all six gates (F-efe53969)', () => {
  let db;
  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('a clean ADVANCE-verdict wave still carries all six gate results, in the documented order', () => {
    const runId = 'r-six-gates';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
    saveDomainDraft(db, runId, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, runId);
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'test', 1, 'collected')"
    ).run(runId);
    const domId = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(runId).id;
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(Number(wave.lastInsertRowid), domId);

    const result = checkGates(db, runId);

    assert.equal(result.gates.length, 6,
      'checkGates must evaluate and return exactly six gates — the array assembled at the ' +
      '`gates = [waveGate, agentGate, violationGate, verifyGate, findingGate, adjudicationGate]` site');
    assert.deepEqual(
      result.gates.map(g => g.name),
      ['wave_status', 'agent_completion', 'ownership', 'verification', 'finding_severity', 'adjudication'],
    );
  });
});
