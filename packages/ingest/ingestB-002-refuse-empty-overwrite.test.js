/**
 * ingestB-002-refuse-empty-overwrite.test.js
 *
 * Stage C (humanization) — ingest-B-002 (jury ESCALATED LOW -> MEDIUM).
 *
 * The bug: if the TOP-LEVEL records/ directory is transiently unreadable
 * (EACCES / Windows lock / ENOTDIR), findJsonFiles degrades to [] after a
 * single low `dir_unreadable` warn. rebuildIndexes then proceeds to
 * commit-group-OVERWRITE all three indexes (latest-by-repo / failing / stale)
 * with EMPTY content — wiping the prior good indexes. The commit group
 * succeeds, so there is no error event, only the low warn, and readers in the
 * heal window see an empty portfolio.
 *
 * The fix: treat a root-level corpus-invisible scan as a REFUSE-TO-OVERWRITE
 * condition. Distinguish:
 *   (a) records/ ROOT itself unreadable -> records_root_unreadable, OR
 *   (b) zero accepted files scanned while the PRIOR latest-by-repo.json had
 *       content -> empty_scan_with_prior_index
 * In either case the commit group is SKIPPED and a structured
 * `logStage('error'/'warn', { kind: 'index_rebuild_skipped', ... })` fires
 * instead of clobbering good indexes with empty ones.
 *
 * The guard must NOT regress a LEGITIMATELY empty corpus: a first run with no
 * records and no prior index must still write empty indexes.
 *
 * Lens: fail loud where silence misleads — an invisible corpus must NOT
 * masquerade as an empty one and erase the operator's portfolio.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rebuildIndexes } from './rebuild-indexes.js';

// ─── helpers ────────────────────────────────────────────────────────────

function captureStderr(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(chunk.toString());
    return true;
  };
  try {
    return { result: fn(), captured };
  } finally {
    process.stderr.write = orig;
  }
}

function parseStageEvents(captured) {
  const events = [];
  for (const chunk of captured) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.stage) events.push(parsed);
      } catch { /* skip non-JSON */ }
    }
  }
  return events;
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
  const dir = join(repoRoot, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${runId}.json`), JSON.stringify(buildAcceptedRecord({ run_id: runId }), null, 2), 'utf-8');
}

function readIndexes(repoRoot) {
  const indexDir = join(repoRoot, 'indexes');
  return {
    latest: JSON.parse(readFileSync(join(indexDir, 'latest-by-repo.json'), 'utf-8')),
    failing: JSON.parse(readFileSync(join(indexDir, 'failing.json'), 'utf-8')),
    stale: JSON.parse(readFileSync(join(indexDir, 'stale.json'), 'utf-8')),
  };
}

// ─── tests ──────────────────────────────────────────────────────────────

describe('rebuildIndexes — refuse-to-overwrite on invisible corpus (ingest-B-002)', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = mkdtempSync(join(tmpdir(), 'ingestB-002-')); });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('(a) root records/ unreadable with prior NON-EMPTY indexes -> indexes NOT overwritten + skip event', () => {
    // First, a healthy run establishes good indexes.
    seedRecord(repoRoot, 'a-001');
    rebuildIndexes(repoRoot);
    const before = readIndexes(repoRoot);
    assert.ok(Object.keys(before.latest).length > 0, 'precondition: prior latest-by-repo is non-empty');

    // Now make records/ unreadable at the ROOT. Replacing the directory with a
    // FILE makes readdirSync throw ENOTDIR cross-platform — the same IO-error
    // class (EACCES / Windows lock / ENOTDIR) the transient-lock scenario hits.
    rmSync(join(repoRoot, 'records'), { recursive: true, force: true });
    writeFileSync(join(repoRoot, 'records'), 'not a directory', 'utf-8');

    const { captured } = captureStderr(() => rebuildIndexes(repoRoot));

    // The prior good indexes must SURVIVE — not be clobbered with empty content.
    const after = readIndexes(repoRoot);
    assert.deepEqual(after.latest, before.latest,
      'prior latest-by-repo must be preserved, not overwritten with {}');
    assert.deepEqual(after.failing, before.failing, 'prior failing must be preserved');
    assert.deepEqual(after.stale, before.stale, 'prior stale must be preserved');

    // The refusal must be loud: a structured index_rebuild_skipped event.
    const events = parseStageEvents(captured);
    const skip = events.find(e => e.kind === 'index_rebuild_skipped');
    assert.ok(skip,
      `expected an index_rebuild_skipped event; got ` +
      `${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind })))}`);
    assert.equal(skip.reason, 'records_root_unreadable',
      'root-level failure must be distinguished from a single locked leaf');
  });

  it('(b) genuinely empty corpus with NO prior index -> still writes empty indexes (no regression)', () => {
    // No records seeded, no prior indexes. This is a first run on an empty
    // corpus — the guard must NOT refuse here.
    const { captured } = captureStderr(() => rebuildIndexes(repoRoot));

    assert.ok(existsSync(join(repoRoot, 'indexes', 'latest-by-repo.json')),
      'first run on an empty corpus must still write latest-by-repo.json');
    const after = readIndexes(repoRoot);
    assert.deepEqual(after.latest, {}, 'empty corpus -> empty latest-by-repo');
    assert.deepEqual(after.failing, [], 'empty corpus -> empty failing');
    assert.deepEqual(after.stale, [], 'empty corpus -> empty stale');

    const events = parseStageEvents(captured);
    const skip = events.find(e => e.kind === 'index_rebuild_skipped');
    assert.ok(!skip, 'a legitimately empty first-run corpus must NOT trip the refuse guard');
  });

  it('(b2) zero accepted scanned while prior index NON-EMPTY -> refuse + empty_scan_with_prior_index', () => {
    // Establish good indexes, then remove every record so the next scan finds
    // nothing — but the root records/ dir is perfectly readable (just empty).
    // This is the "all records vanished" variant: prior index had content, so
    // an empty scan is suspicious and must NOT clobber.
    seedRecord(repoRoot, 'b-001');
    rebuildIndexes(repoRoot);
    const before = readIndexes(repoRoot);
    assert.ok(Object.keys(before.latest).length > 0, 'precondition: prior index non-empty');

    // Wipe records but keep the (now empty) records/ dir readable.
    rmSync(join(repoRoot, 'records'), { recursive: true, force: true });
    mkdirSync(join(repoRoot, 'records'), { recursive: true });

    const { captured } = captureStderr(() => rebuildIndexes(repoRoot));

    const after = readIndexes(repoRoot);
    assert.deepEqual(after.latest, before.latest,
      'an empty scan against a non-empty prior index must NOT clobber latest-by-repo');

    const events = parseStageEvents(captured);
    const skip = events.find(e => e.kind === 'index_rebuild_skipped');
    assert.ok(skip, 'expected an index_rebuild_skipped event for the empty-scan case');
    assert.equal(skip.reason, 'empty_scan_with_prior_index',
      'an empty scan over a readable root must be distinguished from a root IO failure');
  });

  it('(c) a normal rebuild with records present is unaffected by the guard', () => {
    seedRecord(repoRoot, 'c-001');
    seedRecord(repoRoot, 'c-002');

    const { result, captured } = captureStderr(() => rebuildIndexes(repoRoot));

    assert.equal(result.accepted, 2, 'both accepted records scanned');
    const after = readIndexes(repoRoot);
    assert.ok(Object.keys(after.latest).length > 0, 'normal rebuild writes a populated index');

    const events = parseStageEvents(captured);
    const skip = events.find(e => e.kind === 'index_rebuild_skipped');
    assert.ok(!skip, 'a normal populated rebuild must never trip the refuse guard');
  });
});
