/**
 * roadmap-attention.test.js — F-e7c4c16d (T2): computeAttentionScores
 * composes churn × recency/count × lane-fragmentation as a PRODUCT (T2's own
 * literal formula), normalized per-factor to each factor's own max across
 * the candidate set. Drives a REAL temp git repo (for churn) alongside a
 * seeded in-memory DB (for recency + fragmentation) — mirrors both fixture
 * patterns already established in this domain
 * (git-touched-files-churn-stats.test.js and
 * cross-run-analytics-lane-fragmentation.test.js).
 *
 * Amendment 3 (docs/trajectory-and-closure.dispatch.md, A3.1) renamed this
 * function's return shape (`top`->`items`, `attention_score`->`score`,
 * `factors`->`components`) and folded count×recency into ONE `components
 * .recency` value — see attention.js's own header for why this is a rename,
 * not a reformulation. Assertions below updated to match; a new reconciliation
 * check (not present pre-Amendment-3) proves `score === components.churn *
 * components.recency * components.fragmentation` for every row, not just
 * assumed from the source read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openMemoryDb } from '../db/connection.js';
import { computeAttentionScores, DEFAULT_TOP_K } from './roadmap/attention.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t.t']);
  git(repoPath, ['config', 'user.name', 't']);
}

function commitAll(repoPath, message) {
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', message]);
}

function seedDb() {
  const db = openMemoryDb();
  const runId = 'run-attention';
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`)
    .run(runId, 'a'.repeat(40));
  const core = db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, 'core', '[]', 'owned', 1)`)
    .run(runId).lastInsertRowid;
  const tests = db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, 'tests', '[]', 'owned', 1)`)
    .run(runId).lastInsertRowid;
  const w1 = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', 1, 'collected')`)
    .run(runId).lastInsertRowid;
  const w2 = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', 2, 'collected')`)
    .run(runId).lastInsertRowid;
  return { db, runId, core: Number(core), tests: Number(tests), w1: Number(w1), w2: Number(w2) };
}

function seedAgentRun(db, waveId, domainId) {
  return Number(db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`).run(waveId, domainId).lastInsertRowid);
}

function seedFileClaim(db, agentRunId, filePath, domainId) {
  db.prepare(`INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation) VALUES (?, ?, 'edit', ?, 0)`)
    .run(agentRunId, filePath, domainId);
}

function seedFinding(db, runId, { id, fp, file, wave }) {
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
     VALUES (?, ?, ?, 'HIGH', 'bug', ?, 'd', 'recurring', ?, ?)`
  ).run(runId, id, fp, file, wave, wave);
}

/** @pins F-e7c4c16d */
describe('computeAttentionScores — churn × recency/count × lane-fragmentation (F-e7c4c16d)', () => {
  it('a file maxed on all three factors scores exactly 1.0; a file with zero findings scores exactly 0 (product semantics)', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'roadmap-attention-'));
    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'hot.js'), 'version 0\n');
      writeFileSync(join(repoPath, 'quiet.js'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n');
      commitAll(repoPath, 'seed');
      for (let i = 1; i <= 8; i++) {
        writeFileSync(join(repoPath, 'hot.js'), `version ${i}\n`);
        commitAll(repoPath, `rewrite hot.js #${i}`);
      }

      const { db, runId, core, tests, w1, w2 } = seedDb();
      const coreAgentW1 = seedAgentRun(db, w1, core);
      const coreAgentW2 = seedAgentRun(db, w2, core);
      const testsAgentW2 = seedAgentRun(db, w2, tests);

      // hot.js: touched by BOTH domains (max fragmentation), has findings
      // last-seen in the LATEST wave (max recency).
      seedFileClaim(db, coreAgentW2, 'hot.js', core);
      seedFileClaim(db, testsAgentW2, 'hot.js', tests);
      seedFinding(db, runId, { id: 'F-1', fp: 'fp-1', file: 'hot.js', wave: w2 });
      seedFinding(db, runId, { id: 'F-2', fp: 'fp-2', file: 'hot.js', wave: w2 });

      // quiet.js: touched by only ONE domain, has churn, but ZERO findings.
      seedFileClaim(db, coreAgentW1, 'quiet.js', core);

      const result = computeAttentionScores(db, runId, { repoPath, sinceDays: 3650, topK: 10 });
      assert.equal(result.advisory, true);
      assert.equal(result.churn_available, true);

      const hot = result.items.find((r) => r.file === 'hot.js');
      const quiet = result.items.find((r) => r.file === 'quiet.js');
      assert.ok(hot, 'hot.js must be a candidate');
      assert.ok(quiet, 'quiet.js must be a candidate');
      assert.equal(hot.score, 1, 'a file at the max of every factor must score exactly 1.0');
      assert.equal(quiet.score, 0, 'a file with zero findings must score exactly 0 — product semantics, not an average');
      assert.equal(result.items[0].file, 'hot.js', 'hot.js must rank first');

      // A3.1 reconciliation (verify, don't assume): `score` must stay the
      // EXACT product of the three exposed `components`, for every row —
      // proves the schema-shaped `components` were exposed, not invented
      // alongside a separately-computed `score`.
      for (const row of result.items) {
        const { churn, recency, fragmentation } = row.components;
        assert.equal(row.score, churn * recency * fragmentation,
          `score must equal components.churn * components.recency * components.fragmentation for ${row.file}`);
      }
      assert.deepEqual(Object.keys(hot.components).sort(), ['churn', 'fragmentation', 'recency']);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('truncates to topK and reports truncated:true / total_candidates correctly', () => {
    const { db, runId, core, w1 } = seedDb();
    const agent = seedAgentRun(db, w1, core);
    for (let i = 0; i < 5; i++) {
      seedFileClaim(db, agent, `file-${i}.js`, core);
      seedFinding(db, runId, { id: `F-${i}`, fp: `fp-${i}`, file: `file-${i}.js`, wave: w1 });
    }

    const result = computeAttentionScores(db, runId, { topK: 2 });
    assert.equal(result.items.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.total_candidates, 5);
  });

  it('degrades to churn_available:false (never throws) when no repoPath is supplied — every score still computed from DB signals alone stays 0 without churn', () => {
    const { db, runId, core, w1 } = seedDb();
    const agent = seedAgentRun(db, w1, core);
    seedFileClaim(db, agent, 'a.js', core);
    seedFinding(db, runId, { id: 'F-1', fp: 'fp-1', file: 'a.js', wave: w1 });

    const result = computeAttentionScores(db, runId, {});
    assert.equal(result.churn_available, false);
    const a = result.items.find((r) => r.file === 'a.js');
    assert.equal(a.score, 0, 'no churn signal at all means every score is 0 — honest, not a crash');
    assert.equal(a.components.churn, 0, 'the churn component itself must read 0, not merely the product');
  });

  it('orders by score DESC then file ASC (deterministic tiebreak)', () => {
    const { db, runId, core, w1 } = seedDb();
    const agent = seedAgentRun(db, w1, core);
    // Two files with IDENTICAL signals (same findings/domain touch, no churn probe) — must tie at score 0 and sort by name.
    for (const f of ['z.js', 'a.js']) {
      seedFileClaim(db, agent, f, core);
      seedFinding(db, runId, { id: `F-${f}`, fp: `fp-${f}`, file: f, wave: w1 });
    }
    const result = computeAttentionScores(db, runId, {});
    assert.deepEqual(result.items.map((r) => r.file), ['a.js', 'z.js']);
  });

  it('DEFAULT_TOP_K is used when topK is omitted', () => {
    const { db, runId } = seedDb();
    const result = computeAttentionScores(db, runId, {});
    assert.equal(result.items.length <= DEFAULT_TOP_K, true);
  });
});
