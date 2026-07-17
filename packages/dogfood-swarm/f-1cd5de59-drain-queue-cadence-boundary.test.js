/**
 * f-1cd5de59-drain-queue-cadence-boundary.test.js
 *
 * F-1cd5de59 [MEDIUM] — T6 (docs/trajectory-and-closure.dispatch.md) requires
 * the drain queue's cadence-overdue entries to surface at the top of the
 * NEXT run's digest. The interesting bug surface is the BOUNDARY: an entry
 * exactly AT its cadence (e.g. reviewed 5 runs ago, cadence=5) is ambiguous
 * between "due now" and "due next time" unless the comparison operator is
 * pinned by a test — and this exact off-by-one is where the dispatch's own
 * cited failure mode (Chromium's "no forcing function" lesson) tends to live
 * in practice.
 *
 * PINNED INTERPRETATION (this test's decision, since no code exists yet to
 * consult): overdue <=> runsSinceReview > cadence (STRICTLY greater). An
 * entry exactly at cadence is NOT YET overdue; cadence+1 IS. This matches the
 * finding's own recommendation text verbatim ("asserting only the LATTER
 * surfaces... and is tagged distinguishably").
 *
 * STATUS: RED IN ISOLATION, with TWO layered assumptions beyond the sibling
 * roadmap-compile tests in this same wave (documented there):
 *
 *   1. Cadence tracking needs a literal notion of "runs ago", which needs a
 *      run ORDINAL. This test manufactures that ordinal the only way
 *      available without inventing a bookkeeping mechanism: it seeds N real
 *      `runs` rows for the SAME repo, strictly ordered by created_at, and
 *      compiles against the LAST of the N — so "runs since review" for an
 *      entry whose `last_reviewed_run_ordinal` is 1 is exactly N-1 by
 *      construction. Whatever mechanism swarm-cp-core actually implements for
 *      counting "runs ago" for a real repo, this fixture's N-run history
 *      gives it unambiguous, real data to count.
 *   2. Drain-queue entries are authored at `<runs.local_path>/dogfood/
 *      roadmap-drain-state.json`, shape `{ "entries": [ { "id", "kind":
 *      "grandfathered"|"deferred", "owner", "last_reviewed_run_ordinal",
 *      "cadence_runs" } ] }`, and the compiled artifact's `drain_queue`
 *      section has shape `{ entries: [ { id, owner, cadence_runs,
 *      runs_since_review, overdue }, ... ], overdue_ids: [...] }`. The
 *      BOUNDARY property under test (>, not >=) is what's load-bearing, not
 *      these exact key names.
 *
 * A3 UPDATE (docs/trajectory-and-closure.dispatch.md, Amendment 3, wave 42):
 * A3.2(a) supersedes T6's original speculative single `$defs/drainEntry` —
 * the artifact-level path for this section is `drain_queue.{entries,
 * overdue_ids}` (renamed from the flat `drain.{entries, overdue_ids}` this
 * file originally pinned), sourced from lib/roadmap/drain.js's
 * `compileAuthoredDrainState`, whose shipped entry shape `{id, owner,
 * cadence_runs, runs_since_review, overdue}` A3.2(a) explicitly keeps
 * as-built ("T6's cadence in runs holds here as built") — only the
 * TOP-LEVEL artifact path changed, never the per-entry fields, so the
 * distinct overdue_ids listing assertion below is unchanged in shape, only
 * in path prefix. This is a CONTRACT PIN — see the `drain_queue` renames
 * below.
 *
 * The fixture entry mirrors a REAL grandfathered-manifest row — id
 * 'F-002109-003' and owner 'coordinator' are copied verbatim from this
 * repo's own scripts/grandfathered-pins.json (read before writing this
 * file), not invented — matching this package's own documented near-miss on
 * vacuous corpora (never test a shape the real data doesn't have).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/**
 * Seeds `numRuns` runs for the SAME repo (increasing created_at, one per
 * day, so ordering is unambiguous under any created_at-based ranking), plants
 * the drain-state fixture (the REAL F-002109-003 / 'coordinator' shape) at
 * the shared local_path, and returns { runId (the LAST/current run), repoDir,
 * dbPath, compile() }. `cadenceRuns` and a single entry's
 * `last_reviewed_run_ordinal` are fixed at 5 / 1 respectively — the caller
 * only varies `numRuns` (6 for "at cadence", 7 for "cadence+1").
 */
function seedCadenceFixture(numRuns) {
  const dbDir = makeTmpDir('cadence-db-');
  const dbPath = join(dbDir, 'control-plane.db');
  const repoDir = makeTmpDir('cadence-repo-');

  const db = openDb(dbPath);
  const insRun = db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let currentRunId;
  for (let i = 1; i <= numRuns; i++) {
    const runId = `cadence-repo-run-${i}`;
    const createdAt = `2026-01-${String(i).padStart(2, '0')} 00:00:00`;
    insRun.run(runId, 'org/cadence-repo', repoDir, String(i).repeat(40).slice(0, 40), 'main',
      i === numRuns ? 'health-audit-a' : 'complete', createdAt);
    currentRunId = runId;
  }
  closeDb(dbPath);

  mkdirSync(join(repoDir, 'dogfood'), { recursive: true });
  writeFileSync(join(repoDir, 'dogfood', 'roadmap-drain-state.json'), JSON.stringify({
    entries: [{
      id: 'F-002109-003',
      kind: 'grandfathered',
      owner: 'coordinator',
      last_reviewed_run_ordinal: 1,
      cadence_runs: 5,
    }],
  }, null, 2));

  function compile() {
    return spawnSync(process.execPath, [CLI_PATH, 'roadmap', 'compile', currentRunId], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  return { runId: currentRunId, repoDir, dbPath, compile };
}

function readArtifact(repoDir, runId) {
  const p = join(repoDir, 'dogfood', 'roadmap', `${runId}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

/** @pins F-1cd5de59 */
describe('F-1cd5de59 — drain-queue cadence boundary', () => {
  it('an entry reviewed exactly `cadence` runs ago (5 runs ago, cadence=5) is NOT YET overdue', () => {
    const { repoDir, runId, compile } = seedCadenceFixture(6); // runs 1..6; entry reviewed at ordinal 1 => 5 elapsed
    const r = compile();
    if (r.status !== 0) {
      assert.fail(
        `swarm roadmap compile is not implemented yet (awaiting swarm-cp-core's T1/T6) — exited ` +
        `${r.status}. stderr:\n${r.stderr}`
      );
    }
    const artifact = readArtifact(repoDir, runId);
    // A3 contract pin — goes green at wave-43 merge (A3.2(a): drain_queue
    // supersedes the flat `drain` this test originally pinned; the entry
    // shape and the distinct overdue_ids listing are unchanged, only the
    // top-level path is).
    assert.ok(artifact?.drain_queue?.entries, `expected artifact.drain_queue.entries; got: ${JSON.stringify(artifact)}`);

    const entry = artifact.drain_queue.entries.find(e => e.id === 'F-002109-003');
    assert.ok(entry, `expected the seeded drain entry F-002109-003 in the compiled artifact`);
    assert.equal(entry.runs_since_review, 5, 'fixture precondition: exactly 5 runs must have elapsed');
    assert.equal(entry.overdue, false,
      `an entry AT exactly its cadence (5 runs since review, cadence=5) must NOT be overdue yet — ` +
      `got overdue=${entry.overdue}. Pinned rule: overdue <=> runsSinceReview > cadence (strict).`);
    assert.ok(!(artifact.drain_queue.overdue_ids || []).includes('F-002109-003'),
      'an at-cadence (not-yet-overdue) entry must not appear in the overdue_ids surfacing list');
  });

  it('an entry reviewed `cadence + 1` runs ago (6 runs ago, cadence=5) IS overdue and surfaces distinctly', () => {
    const { repoDir, runId, compile } = seedCadenceFixture(7); // runs 1..7; entry reviewed at ordinal 1 => 6 elapsed
    const r = compile();
    if (r.status !== 0) {
      assert.fail(
        `swarm roadmap compile is not implemented yet (awaiting swarm-cp-core's T1/T6) — exited ` +
        `${r.status}. stderr:\n${r.stderr}`
      );
    }
    const artifact = readArtifact(repoDir, runId);
    // A3 contract pin — goes green at wave-43 merge (see the sibling test
    // above for the A3.2(a) rationale).
    assert.ok(artifact?.drain_queue?.entries, `expected artifact.drain_queue.entries; got: ${JSON.stringify(artifact)}`);

    const entry = artifact.drain_queue.entries.find(e => e.id === 'F-002109-003');
    assert.ok(entry, `expected the seeded drain entry F-002109-003 in the compiled artifact`);
    assert.equal(entry.runs_since_review, 6, 'fixture precondition: exactly 6 runs must have elapsed');
    assert.equal(entry.overdue, true,
      `an entry PAST its cadence (6 runs since review, cadence=5) must be overdue — got ` +
      `overdue=${entry.overdue}. A cadence that silently tolerates one extra run of slack before ` +
      `firing is indistinguishable from no cadence at all once it happens twice (the dispatch's own ` +
      `cited Chromium "no forcing function" lesson).`);
    assert.ok((artifact.drain_queue.overdue_ids || []).includes('F-002109-003'),
      'an overdue entry must be surfaced in the distinctly-tagged overdue_ids listing, ' +
      'not merely carry a per-entry flag nothing else reads');
  });
});
