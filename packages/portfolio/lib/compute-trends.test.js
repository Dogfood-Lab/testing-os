/**
 * compute-trends — F3-001 (corpus trend / regression surface).
 *
 * computeTrends(repoRoot, options) scans records/ DIRECTLY (not the
 * latest-by-repo.json index, which only carries the single newest run per
 * repo+surface and therefore cannot express a trend) and produces, per
 * repo+surface, an ordered run history plus regression/recovery flags and a
 * windowed pass-rate.
 *
 * These tests use TEMP DIRS only — they NEVER touch the real records/ or
 * indexes/ tree. Each builds a multi-run fixture where a surface's verdict
 * changes across dated run files, then asserts the trend shape.
 *
 * Pins the design's load-bearing hazards:
 *   - mixed-precision ISO lex-compare hazard (rebuild-indexes.js documents it):
 *     history MUST be ordered by Date.parse(finished_at), not string compare,
 *     so `...Z` and `....500Z` sort chronologically.
 *   - SEED-1 posix lesson: any stored relative path is forward-slash only.
 *   - _rejected/ records are excluded (mirrors rebuildIndexes).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeTrends } from './compute-trends.js';

/**
 * Write a single record file into a temp records/ tree at the dated path the
 * real pipeline uses: records/<org>/<repo>/YYYY/MM/DD/run-<id>.json.
 */
function writeRecord(repoRoot, { repo, runId, surface, verified, finishedAt, rejected = false, status = 'accepted' }) {
  const [, ...rest] = repo.split('/');
  const date = new Date(finishedAt);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const base = rejected
    ? join(repoRoot, 'records', '_rejected', repo, yyyy, mm, dd)
    : join(repoRoot, 'records', repo, yyyy, mm, dd);
  mkdirSync(base, { recursive: true });
  const record = {
    schema_version: '1.2.0',
    repo,
    run_id: runId,
    verification: { status },
    overall_verdict: { proposed: verified, verified, downgraded: false },
    timing: { finished_at: finishedAt },
    scenario_results: [{ product_surface: surface, scenario_id: 'x', verdict: verified }],
  };
  writeFileSync(join(base, `run-${runId}.json`), JSON.stringify(record, null, 2));
}

/**
 * Write a record whose scenario_results carries N entries for the SAME surface.
 * The submission schema permits this (scenario_results has minItems:1, no
 * maxItems, no per-surface uniqueness), and one such run must contribute ONE
 * run to a surface's trend, not N duplicate rows.
 */
function writeMultiScenarioRecord(repoRoot, { repo, runId, surface, verified, finishedAt, count }) {
  const date = new Date(finishedAt);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const base = join(repoRoot, 'records', repo, yyyy, mm, dd);
  mkdirSync(base, { recursive: true });
  const scenario_results = Array.from({ length: count }, (_, i) => ({
    product_surface: surface,
    scenario_id: `s-${i}`,
    verdict: verified,
  }));
  const record = {
    schema_version: '1.2.0',
    repo,
    run_id: runId,
    verification: { status: 'accepted' },
    overall_verdict: { proposed: verified, verified, downgraded: false },
    timing: { finished_at: finishedAt },
    scenario_results,
  };
  writeFileSync(join(base, `run-${runId}.json`), JSON.stringify(record, null, 2));
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'portfolio-trends-'));
}

describe('computeTrends — basic shape', () => {
  it('returns an ordered history per repo+surface keyed by repo then surface', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/a', runId: 'a-1', surface: 'cli', verified: 'pass', finishedAt: '2026-03-01T10:00:00Z' });
      writeRecord(root, { repo: 'org/a', runId: 'a-2', surface: 'cli', verified: 'pass', finishedAt: '2026-03-05T10:00:00Z' });

      const trends = computeTrends(root);
      assert.ok(trends['org/a'], 'repo key present');
      assert.ok(trends['org/a'].cli, 'surface key present');
      const surf = trends['org/a'].cli;
      assert.equal(surf.history.length, 2);
      // Ordered oldest -> newest by finished_at.
      assert.equal(surf.history[0].run_id, 'a-1');
      assert.equal(surf.history[1].run_id, 'a-2');
      // Each history entry exposes the design's tuple.
      assert.deepEqual(Object.keys(surf.history[0]).sort(), ['finished_at', 'run_id', 'verified']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders history by Date.parse, defeating the mixed-precision ISO lex-compare hazard', () => {
    const root = tmpRoot();
    try {
      // `...Z` lex-compares AFTER `....500Z` (Z 0x5A > . 0x2E) even though it is
      // chronologically EARLIER. A naive string sort would order these wrong.
      writeRecord(root, { repo: 'org/b', runId: 'earlier', surface: 'cli', verified: 'pass', finishedAt: '2026-03-19T15:45:12Z' });
      writeRecord(root, { repo: 'org/b', runId: 'later', surface: 'cli', verified: 'fail', finishedAt: '2026-03-19T15:45:12.500Z' });

      const surf = computeTrends(root)['org/b'].cli;
      assert.equal(surf.history[0].run_id, 'earlier', 'earlier ms must sort first');
      assert.equal(surf.history[1].run_id, 'later', 'later ms must sort last');
      assert.equal(surf.current.verified, 'fail');
      assert.equal(surf.previous.verified, 'pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computeTrends — regression / recovery flags', () => {
  it('flags regressed=true when a surface goes pass -> fail across dates', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/c', runId: 'c-1', surface: 'cli', verified: 'pass', finishedAt: '2026-03-01T10:00:00Z' });
      writeRecord(root, { repo: 'org/c', runId: 'c-2', surface: 'cli', verified: 'pass', finishedAt: '2026-03-02T10:00:00Z' });
      writeRecord(root, { repo: 'org/c', runId: 'c-3', surface: 'cli', verified: 'fail', finishedAt: '2026-03-03T10:00:00Z' });

      const surf = computeTrends(root)['org/c'].cli;
      assert.equal(surf.current.verified, 'fail');
      assert.equal(surf.previous.verified, 'pass');
      assert.equal(surf.regressed, true, 'pass -> fail must flag regressed');
      assert.equal(surf.recovered, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags recovered=true when a surface goes fail -> pass across dates', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/d', runId: 'd-1', surface: 'cli', verified: 'fail', finishedAt: '2026-03-01T10:00:00Z' });
      writeRecord(root, { repo: 'org/d', runId: 'd-2', surface: 'cli', verified: 'pass', finishedAt: '2026-03-02T10:00:00Z' });

      const surf = computeTrends(root)['org/d'].cli;
      assert.equal(surf.regressed, false);
      assert.equal(surf.recovered, true, 'fail -> pass must flag recovered');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a single-run history has no previous, so neither regressed nor recovered', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/e', runId: 'e-1', surface: 'cli', verified: 'fail', finishedAt: '2026-03-01T10:00:00Z' });
      const surf = computeTrends(root)['org/e'].cli;
      assert.equal(surf.previous, null);
      assert.equal(surf.regressed, false);
      assert.equal(surf.recovered, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computeTrends — windowed pass-rate', () => {
  it('computes pass-rate over the default 30-day window from now', () => {
    const root = tmpRoot();
    try {
      const now = Date.now();
      const daysAgo = (n) => new Date(now - n * 86400000).toISOString();
      // 4 runs inside the 30d window: 3 pass, 1 fail => 0.75
      writeRecord(root, { repo: 'org/f', runId: 'f-1', surface: 'cli', verified: 'pass', finishedAt: daysAgo(1) });
      writeRecord(root, { repo: 'org/f', runId: 'f-2', surface: 'cli', verified: 'pass', finishedAt: daysAgo(2) });
      writeRecord(root, { repo: 'org/f', runId: 'f-3', surface: 'cli', verified: 'fail', finishedAt: daysAgo(3) });
      writeRecord(root, { repo: 'org/f', runId: 'f-4', surface: 'cli', verified: 'pass', finishedAt: daysAgo(4) });

      const surf = computeTrends(root)['org/f'].cli;
      assert.equal(surf.pass_rate_window_days, 30);
      assert.equal(surf.pass_rate_sample, 4);
      assert.ok(Math.abs(surf.pass_rate - 0.75) < 1e-9, `expected 0.75, got ${surf.pass_rate}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes runs older than the window from the pass-rate sample', () => {
    const root = tmpRoot();
    try {
      const now = Date.now();
      const daysAgo = (n) => new Date(now - n * 86400000).toISOString();
      // 1 recent fail inside window; 2 old passes outside the 30d window.
      writeRecord(root, { repo: 'org/g', runId: 'g-recent', surface: 'cli', verified: 'fail', finishedAt: daysAgo(2) });
      writeRecord(root, { repo: 'org/g', runId: 'g-old-1', surface: 'cli', verified: 'pass', finishedAt: daysAgo(60) });
      writeRecord(root, { repo: 'org/g', runId: 'g-old-2', surface: 'cli', verified: 'pass', finishedAt: daysAgo(90) });

      const surf = computeTrends(root)['org/g'].cli;
      // Full history retains all 3 runs...
      assert.equal(surf.history.length, 3);
      // ...but the windowed pass-rate sees only the 1 recent fail => 0.0
      assert.equal(surf.pass_rate_sample, 1);
      assert.equal(surf.pass_rate, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors a custom windowDays option', () => {
    const root = tmpRoot();
    try {
      const now = Date.now();
      const daysAgo = (n) => new Date(now - n * 86400000).toISOString();
      writeRecord(root, { repo: 'org/h', runId: 'h-1', surface: 'cli', verified: 'pass', finishedAt: daysAgo(1) });
      writeRecord(root, { repo: 'org/h', runId: 'h-2', surface: 'cli', verified: 'fail', finishedAt: daysAgo(10) });

      const surf = computeTrends(root, { windowDays: 5 })['org/h'].cli;
      assert.equal(surf.pass_rate_window_days, 5);
      assert.equal(surf.pass_rate_sample, 1, 'only the 1-day-old run is inside a 5-day window');
      assert.equal(surf.pass_rate, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computeTrends — record selection', () => {
  it('excludes _rejected/ records (mirrors rebuildIndexes)', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/i', runId: 'i-good', surface: 'cli', verified: 'pass', finishedAt: '2026-03-02T10:00:00Z' });
      writeRecord(root, { repo: 'org/i', runId: 'i-rejected', surface: 'cli', verified: 'fail', finishedAt: '2026-03-03T10:00:00Z', rejected: true, status: 'rejected' });

      const surf = computeTrends(root)['org/i'].cli;
      assert.equal(surf.history.length, 1, 'rejected record must not enter the history');
      assert.equal(surf.history[0].run_id, 'i-good');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('collapses multiple same-surface scenario_results in one run to a single run-row', () => {
    const root = tmpRoot();
    try {
      // Run A passes (1 web scenario), then run B fails (2 web scenarios). With
      // no per-run dedup, B contributes TWO rows: sorted = [A, B, B], so
      // current=B and previous=B — the A->B pass->fail regression vanishes and
      // pass_rate reads 1/3 instead of 1/2.
      writeMultiScenarioRecord(root, { repo: 'org/multi', runId: 'A', surface: 'web', verified: 'pass', finishedAt: '2026-03-01T10:00:00Z', count: 1 });
      writeMultiScenarioRecord(root, { repo: 'org/multi', runId: 'B', surface: 'web', verified: 'fail', finishedAt: '2026-03-02T10:00:00Z', count: 2 });

      const surf = computeTrends(root, { now: Date.parse('2026-03-03T10:00:00Z') })['org/multi'].web;
      assert.equal(surf.history.length, 2, 'one row per RUN, not per scenario_result');
      assert.equal(surf.current.run_id, 'B');
      assert.equal(surf.previous.run_id, 'A', 'previous must be the prior RUN, not a duplicate of current');
      assert.equal(surf.regressed, true, 'A(pass) -> B(fail) is a regression that per-run dedup must reveal');
      assert.equal(surf.pass_rate_sample, 2, 'pass-rate sample counts runs, not scenario_results');
      assert.ok(Math.abs(surf.pass_rate - 0.5) < 1e-9, `expected 0.50, got ${surf.pass_rate}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('separates surfaces within the same repo', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/j', runId: 'j-cli', surface: 'cli', verified: 'pass', finishedAt: '2026-03-01T10:00:00Z' });
      writeRecord(root, { repo: 'org/j', runId: 'j-web', surface: 'web', verified: 'fail', finishedAt: '2026-03-01T10:00:00Z' });

      const trends = computeTrends(root)['org/j'];
      assert.equal(trends.cli.current.verified, 'pass');
      assert.equal(trends.web.current.verified, 'fail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty object when records/ is absent (no crash)', () => {
    const root = tmpRoot();
    try {
      const trends = computeTrends(root);
      assert.deepEqual(trends, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stored latest_path (when present) is forward-slash only (SEED-1 lesson)', () => {
    const root = tmpRoot();
    try {
      writeRecord(root, { repo: 'org/k', runId: 'k-1', surface: 'cli', verified: 'pass', finishedAt: '2026-03-01T10:00:00Z' });
      const surf = computeTrends(root)['org/k'].cli;
      assert.ok(typeof surf.latest_path === 'string' && surf.latest_path.length > 0, 'latest_path should be set');
      assert.ok(!surf.latest_path.includes('\\'),
        `latest_path must be forward-slash only, got: ${surf.latest_path}`);
      assert.ok(surf.latest_path.startsWith('records/'),
        `latest_path should be repo-root-relative, got: ${surf.latest_path}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
