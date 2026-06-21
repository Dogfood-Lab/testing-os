import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// FT-f — generate.js must WRITE the computed trend surface and the shields.io
// badge endpoints to the SERVED read-API location (indexes/trends.json +
// indexes/badges/<org>--<repo>--<surface>.json), not merely compute them. These
// indexes/ paths are part of the public API consumers read over
// raw.githubusercontent.com, so the test exercises the real CLI end-to-end
// against a real records/ corpus and a real latest-by-repo index — no mocks —
// then asserts both served artifacts exist and are well-formed.

const GENERATE = resolve(import.meta.dirname, 'generate.js');

// Build a record in the exact shape compute-trends.js + generate-badges.js read:
// verification.status, overall_verdict.verified, timing.finished_at, and a
// scenario_results entry carrying product_surface.
function makeRecord({ repo, runId, verified, finishedAt, surface }) {
  return {
    repo,
    run_id: runId,
    verification: { status: 'accepted', rejection_reasons: [] },
    overall_verdict: { proposed: verified, verified, downgraded: false },
    timing: { finished_at: finishedAt },
    scenario_results: [{ product_surface: surface }],
  };
}

// Lay a record file at records/<org>/<repo>/<YYYY>/<MM>/<DD>/run-<id>.json,
// mirroring the production records/ tree compute-trends walks.
function writeRecord(root, record) {
  const finished = new Date(record.timing.finished_at);
  const yyyy = String(finished.getUTCFullYear());
  const mm = String(finished.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(finished.getUTCDate()).padStart(2, '0');
  const dir = join(root, 'records', record.repo, yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${record.run_id}.json`), JSON.stringify(record, null, 2) + '\n');
}

function setupCorpus() {
  const root = mkdtempSync(join(tmpdir(), 'portfolio-serve-'));

  const repo = 'mcp-tool-shop-org/shipcheck';
  const surface = 'cli';
  const recentIso = new Date(Date.now() - 2 * 86400000).toISOString(); // fresh -> brightgreen
  const olderIso = new Date(Date.now() - 5 * 86400000).toISOString();

  // Two accepted runs for the same repo+surface so the trend has a real
  // current/previous pair (both pass -> not regressed, pass_rate 1.0).
  writeRecord(root, makeRecord({ repo, runId: 'shipcheck-1', verified: 'pass', finishedAt: olderIso, surface }));
  writeRecord(root, makeRecord({ repo, runId: 'shipcheck-2', verified: 'pass', finishedAt: recentIso, surface }));

  // The CLI's pre-flight requires indexes/latest-by-repo.json to exist; it is
  // the collapsed-latest surface generateBadges consumes.
  const indexesDir = join(root, 'indexes');
  mkdirSync(indexesDir, { recursive: true });
  const index = {
    [repo]: {
      [surface]: {
        run_id: 'shipcheck-2',
        verified: 'pass',
        verification_status: 'accepted',
        finished_at: recentIso,
        path: `records/${repo}/run-shipcheck-2.json`,
      },
    },
  };
  writeFileSync(join(indexesDir, 'latest-by-repo.json'), JSON.stringify(index, null, 2) + '\n');

  return { root, repo, surface };
}

describe('FT-f — generate serves trends.json + badges to indexes/', () => {
  it('writes a well-formed indexes/trends.json and valid shields.io badge JSON', () => {
    const { root, repo, surface } = setupCorpus();
    try {
      // Run the REAL CLI with PORTFOLIO_REPO_ROOT pointed at the sandbox so every
      // read/write is redirected into it — no real working-tree artifact is touched.
      execFileSync('node', [GENERATE], {
        env: { ...process.env, PORTFOLIO_REPO_ROOT: root },
        stdio: 'pipe',
      });

      // --- trends.json: served, parseable, and carries the expected surface trend ---
      const trendsPath = join(root, 'indexes', 'trends.json');
      assert.ok(existsSync(trendsPath), 'indexes/trends.json must be written to the served location');
      const trends = JSON.parse(readFileSync(trendsPath, 'utf-8'));
      assert.ok(trends[repo], `trends must include ${repo}`);
      const surfaceTrend = trends[repo][surface];
      assert.ok(surfaceTrend, `trends[${repo}] must include the ${surface} surface`);

      // Well-formedness: the trend surface keys the consumer read API depends on.
      assert.ok(Array.isArray(surfaceTrend.history), 'history must be an array');
      assert.equal(surfaceTrend.history.length, 2, 'both accepted runs land in history');
      assert.ok(surfaceTrend.current, 'current verdict present');
      assert.equal(surfaceTrend.current.run_id, 'shipcheck-2', 'current is the newest run');
      assert.equal(surfaceTrend.previous.run_id, 'shipcheck-1', 'previous is the older run');
      assert.equal(surfaceTrend.regressed, false);
      assert.equal(surfaceTrend.recovered, false);
      assert.equal(surfaceTrend.pass_rate, 1, 'both runs pass -> windowed pass_rate 1.0');

      // --- badges: at least one shields.io endpoint JSON, valid endpoint schema ---
      const badgesDir = join(root, 'indexes', 'badges');
      assert.ok(existsSync(badgesDir), 'indexes/badges/ must be created');
      const badgeFiles = readdirSync(badgesDir).filter((f) => f.endsWith('.json'));
      assert.ok(badgeFiles.length >= 1, 'at least one badge endpoint JSON must be served');

      const badge = JSON.parse(readFileSync(join(badgesDir, badgeFiles[0]), 'utf-8'));
      // shields.io endpoint contract: schemaVersion / label / message / color.
      assert.equal(badge.schemaVersion, 1, 'shields.io endpoint schemaVersion must be 1');
      assert.equal(typeof badge.label, 'string');
      assert.ok(badge.label.length > 0, 'label must be non-empty');
      assert.equal(typeof badge.message, 'string');
      assert.ok(badge.message.length > 0, 'message must be non-empty');
      assert.equal(typeof badge.color, 'string');
      assert.ok(badge.color.length > 0, 'color must be non-empty');
      // A fresh passing run renders the green pass pill.
      assert.equal(badge.message, 'pass');
      assert.equal(badge.color, 'brightgreen');

      // No temp residue from the atomic temp+rename write should survive.
      const stragglers = readdirSync(badgesDir).filter((f) => f.includes('.tmp'));
      assert.deepEqual(stragglers, [], 'atomic write must leave no .tmp files behind');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--no-trends / --no-badges suppress the served artifacts', () => {
    const { root } = setupCorpus();
    try {
      execFileSync('node', [GENERATE, '--no-trends', '--no-badges'], {
        env: { ...process.env, PORTFOLIO_REPO_ROOT: root },
        stdio: 'pipe',
      });
      assert.equal(existsSync(join(root, 'indexes', 'trends.json')), false,
        '--no-trends must skip the served trends.json');
      assert.equal(existsSync(join(root, 'indexes', 'badges')), false,
        '--no-badges must skip the served badges/ dir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
