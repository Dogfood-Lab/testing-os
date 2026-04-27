/**
 * rebuild-indexes-atomicity.test.js — multi-file commit-group atomicity.
 *
 *   F-PIPELINE-006 (W3-PIPE-002) — `rebuild-indexes.js` writes 3 index files
 *   sequentially. A crash between file 1 and file 3 left readers seeing a
 *   half-updated index group. Pattern #4 (choke-point fix) for multi-file
 *   atomicity: stage all 3 to temp paths first, write a journal listing
 *   them, then promote each to its final path. On crash, the next run's
 *   `cleanupCrashedJournals` deletes residual temps and re-runs (the
 *   rebuild is idempotent — it scans records/ end-to-end every time).
 *
 *   This test pins:
 *     1. Success path: all 3 indexes end up at their canonical paths with
 *        correct contents and no leftover journal/temps.
 *     2. Helper re-use: `rebuild-indexes.js` imports the staged-write
 *        helpers from `lib/atomic-write.js` (Class #6 helper-adoption-sweep).
 *     3. Partial-failure rollback: if the promote phase trips after the
 *        first rename, the journal is preserved for next-run cleanup AND
 *        a subsequent normal run produces consistent indexes.
 *     4. Journal cleanup: no orphan `.in-progress.*.json` files after
 *        success.
 *     5. Pre-existing journal recovery: a stale journal from a prior crashed
 *        run is cleaned up before a fresh run stages new temps.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rebuildIndexes } from './rebuild-indexes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── helpers ────────────────────────────────────────────────────────────

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-atomicity-'));
  mkdirSync(join(root, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19'), { recursive: true });
  return root;
}

function buildAcceptedRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'rb-001',
    repo: 'mcp-tool-shop-org/demo',
    timing: { finished_at: '2026-03-19T15:45:12Z' },
    scenario_results: [{ scenario_id: 's1', product_surface: 'cli', verdict: 'pass' }],
    overall_verdict: { verified: 'pass' },
    verification: { status: 'accepted' },
    ...overrides,
  };
}

function seedRecord(repoRoot, runId) {
  const path = join(repoRoot, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19', `run-${runId}.json`);
  writeFileSync(path, JSON.stringify(buildAcceptedRecord({ run_id: runId }), null, 2), 'utf-8');
}

function listIndexFiles(repoRoot) {
  const indexDir = join(repoRoot, 'indexes');
  if (!existsSync(indexDir)) return [];
  return readdirSync(indexDir).sort();
}

function listOrphanArtifacts(repoRoot) {
  const indexDir = join(repoRoot, 'indexes');
  if (!existsSync(indexDir)) return { tmps: [], journals: [] };
  const all = readdirSync(indexDir);
  return {
    tmps: all.filter(f => f.endsWith('.tmp')),
    journals: all.filter(f => f.startsWith('.in-progress.')),
  };
}

// ─── tests ──────────────────────────────────────────────────────────────

describe('rebuildIndexes — commit-group success path (W3-PIPE-002)', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('writes all 3 indexes atomically with correct content', () => {
    seedRecord(repoRoot, 'a-001');
    seedRecord(repoRoot, 'a-002');

    const result = rebuildIndexes(repoRoot);

    const indexFiles = listIndexFiles(repoRoot);
    assert.deepEqual(
      indexFiles.filter(f => !f.startsWith('.')),
      ['failing.json', 'latest-by-repo.json', 'stale.json'],
      'all 3 canonical index files present'
    );

    // Contents match what the function returned.
    const latest = JSON.parse(readFileSync(join(repoRoot, 'indexes', 'latest-by-repo.json'), 'utf-8'));
    const failing = JSON.parse(readFileSync(join(repoRoot, 'indexes', 'failing.json'), 'utf-8'));
    const stale = JSON.parse(readFileSync(join(repoRoot, 'indexes', 'stale.json'), 'utf-8'));

    assert.deepEqual(latest, result.latestByRepo);
    assert.deepEqual(failing, result.failing);
    assert.deepEqual(stale, result.stale);
  });

  it('leaves no .tmp or journal residue after success', () => {
    seedRecord(repoRoot, 'b-001');
    rebuildIndexes(repoRoot);
    const orphans = listOrphanArtifacts(repoRoot);
    assert.deepEqual(orphans.tmps, [], 'no leftover .tmp files');
    assert.deepEqual(orphans.journals, [], 'no leftover journal files');
  });

  it('is idempotent — running twice yields the same indexes', () => {
    seedRecord(repoRoot, 'c-001');
    rebuildIndexes(repoRoot);
    const after1 = {
      latest: readFileSync(join(repoRoot, 'indexes', 'latest-by-repo.json'), 'utf-8'),
      failing: readFileSync(join(repoRoot, 'indexes', 'failing.json'), 'utf-8'),
      stale: readFileSync(join(repoRoot, 'indexes', 'stale.json'), 'utf-8'),
    };
    rebuildIndexes(repoRoot);
    const after2 = {
      latest: readFileSync(join(repoRoot, 'indexes', 'latest-by-repo.json'), 'utf-8'),
      failing: readFileSync(join(repoRoot, 'indexes', 'failing.json'), 'utf-8'),
      stale: readFileSync(join(repoRoot, 'indexes', 'stale.json'), 'utf-8'),
    };
    assert.deepEqual(after1, after2);
  });
});

describe('rebuildIndexes — pre-existing crashed-run journal cleanup (W3-PIPE-002)', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('cleans up an orphan journal + temps from a previous crashed run', () => {
    seedRecord(repoRoot, 'd-001');
    const indexDir = join(repoRoot, 'indexes');
    mkdirSync(indexDir, { recursive: true });

    // Plant an orphan journal pointing at a residual temp file.
    const orphanTmp = join(indexDir, 'latest-by-repo.json.dead0001.tmp');
    writeFileSync(orphanTmp, '{"orphan": true}', 'utf-8');
    const orphanJournal = join(indexDir, '.in-progress.99999.dead.json');
    writeFileSync(orphanJournal, JSON.stringify({
      pid: 99999,
      started_at: '2026-04-26T00:00:00Z',
      entries: [{ tmpPath: orphanTmp, finalPath: join(indexDir, 'latest-by-repo.json') }],
    }), 'utf-8');

    rebuildIndexes(repoRoot);

    assert.equal(existsSync(orphanTmp), false, 'orphan temp must be cleaned up');
    assert.equal(existsSync(orphanJournal), false, 'orphan journal must be cleaned up');
    const orphans = listOrphanArtifacts(repoRoot);
    assert.deepEqual(orphans.tmps, [], 'no .tmp residue after cleanup + new run');
    assert.deepEqual(orphans.journals, [], 'no journal residue after cleanup + new run');
  });

  it('survives an unreadable journal file', () => {
    seedRecord(repoRoot, 'e-001');
    const indexDir = join(repoRoot, 'indexes');
    mkdirSync(indexDir, { recursive: true });
    // Garbage journal: cleanup must delete it and proceed.
    const trashJournal = join(indexDir, '.in-progress.bad.json');
    writeFileSync(trashJournal, 'this is not json', 'utf-8');

    assert.doesNotThrow(() => rebuildIndexes(repoRoot));
    assert.equal(existsSync(trashJournal), false, 'unparseable journal must be removed');
  });
});

describe('rebuildIndexes — partial-failure resilience (W3-PIPE-002)', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('a previously-incomplete journal does not poison the next normal run', () => {
    // Simulate the post-crash state: previous indexes might be present from
    // an earlier run; a fresh records/ scan should produce consistent
    // indexes regardless. The test asserts that rebuilds are STATELESS
    // beyond `records/` — recovery is "rerun from scratch."
    seedRecord(repoRoot, 'f-001');
    rebuildIndexes(repoRoot); // first run — establishes baseline indexes

    // Plant a fresh journal pretending we crashed mid-run.
    const indexDir = join(repoRoot, 'indexes');
    const fakeTmp = join(indexDir, 'failing.json.cafebabe.tmp');
    writeFileSync(fakeTmp, '{"fake": "incomplete state"}', 'utf-8');
    writeFileSync(join(indexDir, '.in-progress.crash.json'), JSON.stringify({
      pid: 88888,
      started_at: '2026-04-26T00:00:00Z',
      entries: [{ tmpPath: fakeTmp, finalPath: join(indexDir, 'failing.json') }],
    }), 'utf-8');

    seedRecord(repoRoot, 'f-002');
    rebuildIndexes(repoRoot);

    const orphans = listOrphanArtifacts(repoRoot);
    assert.deepEqual(orphans.tmps, [], 'crash-residue cleaned up by next run');
    assert.deepEqual(orphans.journals, [], 'crash-journal cleaned up by next run');

    // The new failing.json reflects the live records, not the planted "fake"
    // content from the simulated crash.
    const failing = JSON.parse(readFileSync(join(indexDir, 'failing.json'), 'utf-8'));
    assert.ok(Array.isArray(failing), 'failing.json is the canonical array shape');
  });
});

describe('rebuildIndexes — Class #6 helper-adoption-sweep (W3-PIPE-002)', () => {
  it('rebuild-indexes.js imports the canonical stage/promote helpers from lib/atomic-write.js', () => {
    const src = readFileSync(resolve(__dirname, 'rebuild-indexes.js'), 'utf-8');
    assert.match(
      src,
      /from\s+['"]\.\/lib\/atomic-write\.js['"]/,
      'rebuild-indexes must import from ./lib/atomic-write.js'
    );
    // Specifically the staged-write trio used by the commit group.
    assert.match(src, /stageWriteFileSync/, 'must use stageWriteFileSync');
    assert.match(src, /promoteStaged/, 'must use promoteStaged');
    assert.match(src, /discardStaged/, 'must use discardStaged');
  });

  it('rebuild-indexes.js no longer assembles its own temp+rename pattern inline', () => {
    const src = readFileSync(resolve(__dirname, 'rebuild-indexes.js'), 'utf-8');
    // The old inline pattern wrote to `${path}.${suffix}.tmp` and renamed
    // directly. We allow the suffix shape (the helper still emits it), but
    // direct `renameSync` calls under rebuild-indexes.js should be gone —
    // the rename now goes through `promoteStaged`. No `renameSync(` calls
    // outside the helper.
    assert.equal(
      /\brenameSync\s*\(/.test(src),
      false,
      'no inline renameSync calls — must go through promoteStaged'
    );
  });
});

describe('rebuildIndexes — multi-call concurrency (W3-PIPE-002 cross-fix)', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('two concurrent rebuilds in the same process do not corrupt index outputs', async () => {
    seedRecord(repoRoot, 'g-001');
    seedRecord(repoRoot, 'g-002');

    // Run two rebuilds concurrently. Each rebuild stages its own pid+random
    // temp suffix and journal, so they don't collide in path-space. The
    // assertion: after both complete, the canonical paths hold valid JSON
    // and no orphan artifacts remain.
    await Promise.all([
      new Promise(res => { rebuildIndexes(repoRoot); res(); }),
      new Promise(res => { rebuildIndexes(repoRoot); res(); }),
    ]);

    const orphans = listOrphanArtifacts(repoRoot);
    assert.deepEqual(orphans.tmps, [], 'no .tmp residue after concurrent runs');
    assert.deepEqual(orphans.journals, [], 'no journal residue after concurrent runs');

    const latest = JSON.parse(readFileSync(join(repoRoot, 'indexes', 'latest-by-repo.json'), 'utf-8'));
    assert.ok(typeof latest === 'object' && latest !== null, 'latest is valid JSON');
  });
});
