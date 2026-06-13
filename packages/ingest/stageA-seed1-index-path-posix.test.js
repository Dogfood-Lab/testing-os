/**
 * stageA-seed1-index-path-posix — SEED-1 (d3-ingest-001 / d3-ingest-004).
 *
 * Invariant under test: the SERIALIZED index `path` field is forward-slash
 * only, regardless of host OS. The committed indexes (latest-by-repo.json,
 * failing.json, stale.json) are read by downstream consumers as
 * raw.githubusercontent.com URL fragments (docs/policy-contract.md Gate F),
 * so a backslash separator is a broken URL.
 *
 * Root cause this guards: rebuildIndexes() composed `record._path` with
 * `relative(repoRoot, f)`, which returns OS-native separators (backslashes on
 * win32). That value flowed verbatim into all three serialized `path` fields.
 * Before the posixify-at-boundary fix (rebuild-indexes.js, after the
 * `relative()` call) this test goes RED on Windows: the serialized output
 * carries `records\\org\\repo\\...` backslash paths.
 *
 * Why this lives in its own test (not folded into ingest.test.js's
 * computeRecordPath assertions): computeRecordPath legitimately returns an
 * ABSOLUTE OS-native fs path used for real filesystem ops — asserting
 * forward-slash on THAT would be wrong. The invariant that actually matters is
 * on the SERIALIZED index output, which is what this file pins.
 *
 * Cross-platform doctrine: the fix is posixify-at-the-serialization-boundary
 * (`relPath.split(sep).join('/')`), mirroring the canonical transform already
 * proven in packages/portfolio/lib/parse-regression-pins.js:75 — NEVER a
 * win32-skip.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rebuildIndexes } from './rebuild-indexes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Distinct sandbox dir name so this never collides with ingest.test.js's
// __test_root__ when both files run under one `node --test` invocation.
const TEST_ROOT = resolve(__dirname, '__test_root_stageA_seed1__');

/**
 * Plant a record file in the sandbox under its canonical shard. `finishedAt`
 * controls accepted/failing/stale bucketing.
 */
function plantRecord(repo, runId, { verified = 'pass', finishedAt }) {
  const [org, name] = repo.split('/');
  const path = resolve(TEST_ROOT, 'records', org, name, '2026/03/19', `run-${runId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const record = {
    schema_version: '1.0.0',
    run_id: runId,
    repo,
    timing: { finished_at: finishedAt },
    verification: { status: 'accepted' },
    overall_verdict: { proposed: verified, verified },
    scenario_results: [{ scenario_id: 's', product_surface: 'cli', verdict: verified }],
  };
  writeFileSync(path, JSON.stringify(record));
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('SEED-1 serialized index path is forward-slash only (d3-ingest-001/004)', () => {
  it('latest-by-repo, failing, and stale path fields contain no backslash', () => {
    mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
    mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });

    // (a) A fresh accepted+pass record → populates latest-by-repo (and, being
    //     well within the stale window relative to 2026, populates stale too
    //     because the cutoff is Date.now()-30d and the record is dated 2026-03).
    plantRecord('mcp-tool-shop-org/seed1-pass', 'pass-001', {
      verified: 'pass',
      finishedAt: '2026-03-19T15:45:12Z',
    });
    // (b) A fail record → populates failing.json (and latest-by-repo + stale).
    plantRecord('mcp-tool-shop-org/seed1-fail', 'fail-001', {
      verified: 'fail',
      finishedAt: '2026-03-19T15:45:12Z',
    });

    const result = rebuildIndexes(TEST_ROOT);

    // Sanity: all three index surfaces actually carry path-bearing entries so
    // the no-backslash assertion is non-vacuous.
    assert.ok(
      Object.keys(result.latestByRepo).length >= 2,
      `latest-by-repo must have entries to make this assertion meaningful, got ${JSON.stringify(result.latestByRepo)}`,
    );
    assert.ok(result.failing.length >= 1, 'failing.json must carry at least one entry');
    assert.ok(result.stale.length >= 1, 'stale.json must carry at least one entry');

    // Every entry must actually expose a `path` (else the no-backslash check
    // would pass vacuously on a path-less shape).
    for (const surfaces of Object.values(result.latestByRepo)) {
      for (const entry of Object.values(surfaces)) {
        assert.equal(typeof entry.path, 'string', 'latest entry must carry a string path');
      }
    }
    for (const entry of result.failing) {
      assert.equal(typeof entry.path, 'string', 'failing entry must carry a string path');
    }
    for (const entry of result.stale) {
      assert.equal(typeof entry.path, 'string', 'stale entry must carry a string path');
    }

    // The invariant: serialized index output is forward-slash only. On the
    // pre-fix code this goes RED on Windows because relative() backslashes leak.
    const latestJson = JSON.stringify(result.latestByRepo);
    const failingJson = JSON.stringify(result.failing);
    const staleJson = JSON.stringify(result.stale);

    assert.ok(
      !latestJson.includes('\\'),
      `latest-by-repo serialized output must not contain a backslash, got: ${latestJson}`,
    );
    assert.ok(
      !failingJson.includes('\\'),
      `failing.json serialized output must not contain a backslash, got: ${failingJson}`,
    );
    assert.ok(
      !staleJson.includes('\\'),
      `stale.json serialized output must not contain a backslash, got: ${staleJson}`,
    );

    // Positive shape: at least one path is the expected posix shard form.
    assert.ok(
      latestJson.includes('records/mcp-tool-shop-org/seed1-pass/2026/03/19/run-pass-001.json'),
      `expected a posix shard path in latest-by-repo, got: ${latestJson}`,
    );
  });

  it('rejected records also serialize forward-slash paths', () => {
    mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
    mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });

    // A rejected record lands under records/_rejected/… — its relPath crosses
    // the same relative()-on-win32 boundary, so confirm it too is posixified
    // wherever it surfaces (corrupted/skipped report arrays carry relPath).
    const [org, name] = 'mcp-tool-shop-org/seed1-rej'.split('/');
    const path = resolve(TEST_ROOT, 'records', '_rejected', org, name, '2026/03/19', 'run-rej-001.json');
    mkdirSync(dirname(path), { recursive: true });
    // Missing run_id → goes into the `skipped` report array with its relPath.
    writeFileSync(path, JSON.stringify({ schema_version: '1.0.0', repo: 'mcp-tool-shop-org/seed1-rej', timing: { finished_at: '2026-03-19T15:45:12Z' } }));

    const result = rebuildIndexes(TEST_ROOT);
    assert.equal(result.skipped.length, 1, 'one skipped record expected');
    assert.ok(
      !result.skipped[0].path.includes('\\'),
      `skipped report path must be forward-slash only, got: ${result.skipped[0].path}`,
    );
    assert.ok(
      result.skipped[0].path.includes('records/_rejected/mcp-tool-shop-org/seed1-rej/'),
      `expected posix _rejected shard path, got: ${result.skipped[0].path}`,
    );
  });
});
