/**
 * amend1-wave9-integration.test.js
 *
 * Wave A1 D3 — H6/H7/H8 family invariant test.
 *
 * Scenario. Drive a 3-domain wave through:
 *   dispatch → 1 agent fails → resume (redispatch the failed domain) →
 *   2nd-attempt collect (new agent succeeds) → receipt + export + status
 *
 * After resume the wave has 4 agent_run rows:
 *   - domain `A`: complete (first attempt)
 *   - domain `B`: complete (first attempt)
 *   - domain `C`: failed (first attempt — the stale row)
 *   - domain `C`: complete (second attempt — the surviving latest row)
 *
 * The wave-9 latest-per-(wave, domain) filter must show ONE row per domain
 * (3 agents) — the surviving complete row, not 4. The H6/H7/H8 bug shape:
 * read-side queries that iterated ALL rows surfaced the stale `failed` row,
 * making the receipt show 4 agents instead of 3, flipping the audit-DB
 * export wave verdict (every-complete check) to non-pass, and showing the
 * stale failed agent in `swarm status`.
 *
 * The full invariant (both halves):
 *   - PRE-FIX: receipt.agents.length === 4, export.waves[0].agents shows
 *     domain C twice (failed + complete), so `every(a.status==='complete')`
 *     in dogfood-bridge fails → wave verdict is 'partial'/'fail' (not pass);
 *     status shows 4 agents.
 *   - POST-FIX: receipt.agents.length === 3, export.waves[0].agents has one
 *     row per domain (all complete), bridge verdict is 'pass', status shows
 *     3 agents.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { buildRunExport } from './lib/persist/export.js';
import { buildDogfoodSubmission } from './lib/persist/dogfood-bridge.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from './lib/queries/latest-agent-runs.js';

const RUN_ID = 'r-wave9-int';
const COMMIT = 'a'.repeat(40);

// We can't call commands directly because they open a path-keyed pool. The
// fastest way to drive the integration is to:
//  - build the in-memory DB with the 4-row situation
//  - call buildReceipt + status with a synthetic opts shape that swaps the
//    pool to the in-memory handle, OR
//  - call the internal SELECT-shape sites directly by importing the helper
//    and asserting the post-filter shape.
//
// We pick: build the DB, then call buildRunExport + buildDogfoodSubmission
// (which both take a db handle directly), and assert on the latest-per-domain
// shape. For receipt / status (path-keyed), we monkey-patch openDb via the
// pool: openDb is idempotent on cache hit, so we pre-populate the pool with
// our in-memory handle keyed at a synthetic path.

function seedRun(db) {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, 'mcp-tool-shop-org/wave9-int', '/tmp/wave9-int', ?, 'main', 'health-audit-a')`)
    .run(RUN_ID, COMMIT);

  saveDomainDraft(db, RUN_ID, [
    { name: 'a-domain', globs: ['a/**'], ownership_class: 'owned' },
    { name: 'b-domain', globs: ['b/**'], ownership_class: 'owned' },
    { name: 'c-domain', globs: ['c/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);

  db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES (?, 'health-audit-a', 1, 'collected', 'snap1')`).run(RUN_ID);

  const waveId = 1;
  const domains = db.prepare(
    'SELECT * FROM domains WHERE run_id = ? ORDER BY name'
  ).all(RUN_ID);

  // First attempt:
  //   a-domain: complete
  //   b-domain: complete
  //   c-domain: FAILED (the recovered domain)
  for (const d of domains) {
    const status = d.name === 'c-domain' ? 'failed' : 'complete';
    const completedAt = '2026-05-31T10:00:00Z';
    db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status, completed_at)
      VALUES (?, ?, ?, ?)`).run(waveId, d.id, status, completedAt);
  }

  // Second attempt (resume): only c-domain re-dispatched, succeeds.
  const cDomain = domains.find(d => d.name === 'c-domain');
  db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status, completed_at)
    VALUES (?, ?, 'complete', '2026-05-31T10:30:00Z')`).run(waveId, cDomain.id);

  return { waveId, domains };
}

describe('Wave-9 latest-per-domain integration (H6 / H7 / H8)', () => {
  let db;

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('export.js audit-DB ground truth shows ONE row per domain (3 agents, all complete)', () => {
    seedRun(db);
    const exp = buildRunExport(db, RUN_ID);

    assert.equal(exp.waves.length, 1);
    const wave = exp.waves[0];

    // The full invariant (the bug shape): a-domain + b-domain + c-domain
    // means exactly 3 agent rows after wave-9 filter, NOT 4.
    assert.equal(wave.agents.length, 3,
      `wave.agents.length must be 3 (one per domain), got ${wave.agents.length} ` +
      `(stale failed row surfaced — wave-9 filter missing in lib/persist/export.js)`);

    // Each domain appears exactly once.
    const byDomain = new Map();
    for (const a of wave.agents) {
      byDomain.set(a.domain, (byDomain.get(a.domain) || 0) + 1);
    }
    for (const [name, count] of byDomain) {
      assert.equal(count, 1, `domain ${name} appears ${count} times in export, expected 1`);
    }

    // All agents must be complete — this is the audit-DB ground truth the
    // dogfood-bridge consumes to decide the verdict.
    for (const a of wave.agents) {
      assert.equal(a.status, 'complete',
        `agent ${a.domain} in export shows status='${a.status}' — stale failed row leaked`);
    }
  });

  it('dogfood-bridge wave verdict flips to pass (every-complete check survives recovery)', () => {
    seedRun(db);
    const exp = buildRunExport(db, RUN_ID);
    const submission = buildDogfoodSubmission(exp, 'pass');

    assert.equal(submission.scenario_results.length, 1);
    const scenario = submission.scenario_results[0];

    // The every(complete) check at dogfood-bridge.js:43 must see all 3
    // domains complete (one row per domain via the wave-9 filter). With the
    // bug, the stale `failed` row was visible → allAgentsPass = false →
    // verdict downgraded to 'partial' or 'fail'.
    assert.equal(scenario.verdict, 'pass',
      `wave verdict must be 'pass' (every domain complete after recovery), got '${scenario.verdict}'`);
  });

  it('export.js violations subquery (advisor-surfaced sibling) does NOT double-count', () => {
    // Seed an ownership violation on the FAILED first-attempt row and the
    // SUCCEEDED second-attempt row. The wave-9 filter on the violations
    // subquery should pick only the surviving row's violation (if any),
    // not surface the stale row's.
    seedRun(db);
    // Find c-domain's first-attempt (failed) row and second-attempt (complete) row.
    const allCRows = db.prepare(`
      SELECT ar.id, ar.status FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE d.name = 'c-domain' ORDER BY ar.id
    `).all();
    assert.equal(allCRows.length, 2);
    const failedRowId = allCRows[0].id;
    const completeRowId = allCRows[1].id;
    const cDomainId = db.prepare(
      "SELECT id FROM domains WHERE run_id = ? AND name = 'c-domain'"
    ).get(RUN_ID).id;

    // Stale failed row has an ownership violation; surviving row does not.
    db.prepare(`INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
      VALUES (?, 'out-of-domain.js', 'edit', ?, 1)`).run(failedRowId, cDomainId);
    // The surviving (complete) row has a clean edit.
    db.prepare(`INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
      VALUES (?, 'c/clean.js', 'edit', ?, 0)`).run(completeRowId, cDomainId);

    const exp = buildRunExport(db, RUN_ID);
    const wave = exp.waves[0];

    // Wave-9 filter on the violations subquery means the failed-row violation
    // does NOT surface (it belongs to the stale row). With the bug, the
    // operator would see a recovered wave reporting an old violation.
    assert.equal(wave.violations.length, 0,
      `violations must NOT include the stale failed row's violation (wave-9 filter missing in export.js:47-53)`);
  });

  it('receipt.js shape: latest-per-domain filter yields 3 agent rows after recovery', () => {
    // receipt.buildReceipt takes a dbPath; for unit-integration we replicate
    // the exact SELECT shape it uses (the same agent_runs SQL fragment) and
    // assert on the post-filter row set. This makes the test a direct probe
    // of the SQL fragment the receipt depends on without spinning up the
    // command's path-keyed openDb pool.
    seedRun(db);
    const wave = db.prepare(
      "SELECT * FROM waves WHERE run_id = ? AND wave_number = 1"
    ).get(RUN_ID);

    const agentRuns = db.prepare(`
      SELECT ar.*, d.name as domain_name, d.ownership_class
      FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
      ORDER BY d.name
    `).all(wave.id);

    assert.equal(agentRuns.length, 3,
      `receipt must show 3 agents (one per domain), got ${agentRuns.length}`);
    const domainNames = agentRuns.map(a => a.domain_name).sort();
    assert.deepEqual(domainNames, ['a-domain', 'b-domain', 'c-domain']);
    for (const a of agentRuns) {
      assert.equal(a.status, 'complete', `${a.domain_name} should be complete`);
    }
  });
});
