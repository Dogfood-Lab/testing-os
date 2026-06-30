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

import { generateBadges, AGGREGATE_BADGE_FILENAME } from './lib/generate-badges.js';

// badge-serving-loop-incomplete — the served read-API artifacts
// (indexes/trends.json + indexes/badges/*.json) must regenerate DETERMINISTICALLY:
// an ingest-time regenerate+commit has to produce a minimal, stable diff, so
// running generate.js twice over identical input must yield byte-for-byte
// identical files. The risk is key ORDER — trends.json keys come from a
// readdirSync record-tree walk whose order is filesystem-dependent, so without
// a sort at the serialization boundary the same corpus can serialize its repo
// keys in different orders on different runs/machines and churn the diff.
//
// This test also pins the AGGREGATE badge: one org-wide rollup pill alongside
// the per-repo+surface pills, so a README can embed a single "is the fleet
// green" badge without enumerating every surface.

const GENERATE = resolve(import.meta.dirname, 'generate.js');

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

function writeRecord(root, record) {
  const finished = new Date(record.timing.finished_at);
  const yyyy = String(finished.getUTCFullYear());
  const mm = String(finished.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(finished.getUTCDate()).padStart(2, '0');
  const dir = join(root, 'records', record.repo, yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${record.run_id}.json`), JSON.stringify(record, null, 2) + '\n');
}

// A multi-repo, multi-surface corpus so key ordering is actually exercised. The
// repos are written in a NON-alphabetical insertion order so a deterministic
// output cannot simply be inheriting insertion order — it must be sorted.
function setupMultiRepoCorpus() {
  const root = mkdtempSync(join(tmpdir(), 'portfolio-determinism-'));
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const older = new Date(Date.now() - 5 * 86400000).toISOString();

  const seeds = [
    { repo: 'mcp-tool-shop-org/zebra', surface: 'cli', verified: 'pass' },
    { repo: 'mcp-tool-shop-org/alpha', surface: 'mcp', verified: 'fail' },
    { repo: 'dogfood-lab/middle', surface: 'cli', verified: 'pass' },
    { repo: 'mcp-tool-shop-org/alpha', surface: 'cli', verified: 'pass' },
  ];
  for (const { repo, surface, verified } of seeds) {
    writeRecord(root, makeRecord({ repo, runId: `${surface}-old`, verified, finishedAt: older, surface }));
    writeRecord(root, makeRecord({ repo, runId: `${surface}-new`, verified, finishedAt: recent, surface }));
  }

  const indexesDir = join(root, 'indexes');
  mkdirSync(indexesDir, { recursive: true });
  const index = {};
  for (const { repo, surface, verified } of seeds) {
    (index[repo] ??= {})[surface] = {
      run_id: `${surface}-new`,
      verified,
      verification_status: 'accepted',
      finished_at: recent,
      path: `records/${repo}/run-${surface}-new.json`,
    };
  }
  writeFileSync(join(indexesDir, 'latest-by-repo.json'), JSON.stringify(index, null, 2) + '\n');

  return { root };
}

function run(root) {
  execFileSync('node', [GENERATE], {
    env: { ...process.env, PORTFOLIO_REPO_ROOT: root },
    stdio: 'pipe',
  });
}

function readAllArtifacts(root) {
  const trends = readFileSync(join(root, 'indexes', 'trends.json'), 'utf-8');
  const badgesDir = join(root, 'indexes', 'badges');
  const badges = {};
  for (const f of readdirSync(badgesDir).filter((n) => n.endsWith('.json'))) {
    badges[f] = readFileSync(join(badgesDir, f), 'utf-8');
  }
  return { trends, badges };
}

describe('badge-serving-loop-incomplete — deterministic served artifacts', () => {
  it('running generate.js twice over identical input yields byte-identical artifacts', () => {
    const { root } = setupMultiRepoCorpus();
    try {
      run(root);
      const first = readAllArtifacts(root);
      run(root);
      const second = readAllArtifacts(root);

      assert.equal(second.trends, first.trends,
        'indexes/trends.json must be byte-identical across regenerations');
      assert.deepEqual(
        Object.keys(second.badges).sort(),
        Object.keys(first.badges).sort(),
        'the set of badge files must be identical across regenerations',
      );
      for (const name of Object.keys(first.badges)) {
        assert.equal(second.badges[name], first.badges[name],
          `badge ${name} must be byte-identical across regenerations`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('trends.json serializes repo and surface keys in sorted order', () => {
    const { root } = setupMultiRepoCorpus();
    try {
      run(root);
      const trends = JSON.parse(readFileSync(join(root, 'indexes', 'trends.json'), 'utf-8'));
      const repoKeys = Object.keys(trends);
      assert.deepEqual(repoKeys, [...repoKeys].sort(),
        'top-level repo keys must be sorted for a stable diff');
      for (const repo of repoKeys) {
        const surfaceKeys = Object.keys(trends[repo]);
        assert.deepEqual(surfaceKeys, [...surfaceKeys].sort(),
          `surface keys under ${repo} must be sorted for a stable diff`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits an aggregate shields.io badge rolling up the worst fleet status', () => {
    const { root } = setupMultiRepoCorpus();
    try {
      run(root);
      const aggPath = join(root, 'indexes', 'badges', AGGREGATE_BADGE_FILENAME);
      assert.ok(existsSync(aggPath), `aggregate badge ${AGGREGATE_BADGE_FILENAME} must be written`);
      const agg = JSON.parse(readFileSync(aggPath, 'utf-8'));
      assert.equal(agg.schemaVersion, 1);
      assert.equal(typeof agg.label, 'string');
      assert.ok(agg.label.length > 0);
      assert.equal(typeof agg.message, 'string');
      assert.ok(agg.message.length > 0);
      assert.equal(typeof agg.color, 'string');
      // The corpus contains a fail (alpha/mcp), so the fleet rollup is red.
      assert.equal(agg.color, 'red', 'any failing surface makes the aggregate red');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('generateBadges — aggregate rollup unit behavior', () => {
  const fresh = new Date(Date.now() - 1 * 86400000).toISOString();
  const stale = new Date(Date.now() - 99 * 86400000).toISOString();

  it('aggregate is brightgreen/pass when every surface is fresh and passing', () => {
    const badges = generateBadges({
      'org/a': { cli: { verified: 'pass', finished_at: fresh } },
      'org/b': { mcp: { verified: 'pass', finished_at: fresh } },
    });
    const agg = badges[AGGREGATE_BADGE_FILENAME];
    assert.ok(agg, 'aggregate badge must be present');
    assert.equal(agg.color, 'brightgreen');
    assert.equal(agg.message, 'pass');
  });

  it('aggregate is orange/stale when no fails but a stale surface exists', () => {
    const badges = generateBadges({
      'org/a': { cli: { verified: 'pass', finished_at: fresh } },
      'org/b': { mcp: { verified: 'pass', finished_at: stale } },
    });
    assert.equal(badges[AGGREGATE_BADGE_FILENAME].color, 'orange');
    assert.equal(badges[AGGREGATE_BADGE_FILENAME].message, 'stale');
  });

  it('aggregate is red/fail when any surface fails, even amid passes and stales', () => {
    const badges = generateBadges({
      'org/a': { cli: { verified: 'pass', finished_at: fresh } },
      'org/b': { mcp: { verified: 'fail', finished_at: fresh } },
      'org/c': { cli: { verified: 'pass', finished_at: stale } },
    });
    assert.equal(badges[AGGREGATE_BADGE_FILENAME].color, 'red');
    assert.equal(badges[AGGREGATE_BADGE_FILENAME].message, 'fail');
  });

  it('no aggregate badge for an empty index', () => {
    const badges = generateBadges({});
    assert.equal(badges[AGGREGATE_BADGE_FILENAME], undefined,
      'an empty fleet has no aggregate pill to serve');
  });
});
