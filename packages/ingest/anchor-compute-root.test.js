/**
 * compute-root tests — anchor manifest generation over a real chain.jsonl.
 *
 * Builds a genuine integrity chain via writeRecord (so the Merkle leaves are
 * real submission_digest values), then asserts:
 *   - computeAnchor over an N-entry chain produces a manifest with the right
 *     leaf_count, seq_range, head_digest, and a stable RFC-6962 v2 root.
 *   - since-last only covers entries appended since the prior anchor.
 *   - the second anchor prev-links to the first anchor's root.
 *   - --all snapshots the whole chain.
 *   - selectPartition / buildAnchorManifest pure logic.
 *
 * No network, no xrpl.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord } from './persist.js';
import { readChainManifest } from './lib/chain-manifest.js';
import { merkleRootForAlgo } from './anchor/merkle.js';
import {
  computeAnchor,
  buildAnchorManifest,
  selectPartition,
  readAnchorManifests,
  DEFAULT_ALGO,
} from './anchor/compute-root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__compute_root_test__');

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'anchor-001',
    repo: 'dogfood-lab/testing-os',
    ref: { commit_sha: 'a'.repeat(40) },
    source: {
      provider: 'github',
      workflow: 'dogfood.yml',
      provider_run_id: '12345',
      run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
    },
    timing: {
      started_at: '2026-03-19T15:45:00Z',
      finished_at: '2026-03-19T15:45:12Z',
    },
    scenario_results: [{
      scenario_id: 'sanity',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'one', status: 'pass' }],
    }],
    overall_verdict: { proposed: 'pass', verified: 'pass' },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-19T15:45:13Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
    },
    ...overrides,
  };
}

function setup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
}

function writeN(n, prefix = 'rec') {
  for (let i = 0; i < n; i++) {
    writeRecord(buildRecord({ run_id: `${prefix}-${i}` }), TEST_ROOT);
  }
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('selectPartition (pure)', () => {
  const entries = [0, 1, 2, 3, 4].map((seq) => ({ seq, submission_digest: 'a'.repeat(64) }));

  it('genesis (no prev anchor) covers the whole chain', () => {
    assert.deepEqual(selectPartition(entries, null).map((e) => e.seq), [0, 1, 2, 3, 4]);
  });

  it('since-last covers only entries after the prior anchor seq_range[1]', () => {
    const prev = { seq_range: [0, 2] };
    assert.deepEqual(selectPartition(entries, prev).map((e) => e.seq), [3, 4]);
  });

  it('--all ignores the prior anchor and covers the whole chain', () => {
    const prev = { seq_range: [0, 2] };
    assert.deepEqual(selectPartition(entries, prev, { mode: 'all' }).map((e) => e.seq), [0, 1, 2, 3, 4]);
  });
});

describe('buildAnchorManifest (pure)', () => {
  it('produces leaf_count / seq_range / head_digest / v2 root', () => {
    const partition = [
      { seq: 3, submission_digest: 'a'.repeat(64) },
      { seq: 4, submission_digest: 'b'.repeat(64) },
      { seq: 5, submission_digest: 'c'.repeat(64) },
    ];
    const m = buildAnchorManifest({ anchorSeq: 1, partition, prevAnchor: { root: 'd'.repeat(64) } });
    assert.equal(m.leaf_count, 3);
    assert.deepEqual(m.seq_range, [3, 5]);
    assert.equal(m.head_digest, 'c'.repeat(64));
    assert.equal(m.algo, DEFAULT_ALGO);
    assert.equal(m.root, merkleRootForAlgo(partition.map((e) => e.submission_digest)));
    assert.equal(m.prev_anchor_root, 'd'.repeat(64));
    assert.match(m.manifest_hash, /^[0-9a-f]{64}$/);
  });

  it('throws on an empty partition', () => {
    assert.throws(() => buildAnchorManifest({ anchorSeq: 0, partition: [], prevAnchor: null }), /empty/);
  });

  it('throws on a malformed leaf digest', () => {
    assert.throws(
      () => buildAnchorManifest({ anchorSeq: 0, partition: [{ seq: 0, submission_digest: 'nope' }], prevAnchor: null }),
      /malformed submission_digest/
    );
  });
});

describe('computeAnchor over a real chain', () => {
  it('anchors all N entries with the right count, range, head, and a stable root', () => {
    setup();
    writeN(5);
    const entries = readChainManifest(TEST_ROOT);
    assert.equal(entries.length, 5);

    const result = computeAnchor(TEST_ROOT);
    assert.equal(result.empty, false);
    assert.equal(result.written, true);
    assert.equal(result.manifest.leaf_count, 5);
    assert.deepEqual(result.manifest.seq_range, [0, 4]);
    assert.equal(result.manifest.head_digest, entries[4].submission_digest);
    assert.equal(result.manifest.prev_anchor_root, null, 'genesis anchor has no prev');

    // Root is the RFC-6962 v2 root over the real leaves — deterministic.
    const expected = merkleRootForAlgo(entries.map((e) => e.submission_digest));
    assert.equal(result.manifest.root, expected);

    // It is persisted as an append-only manifest.
    const anchors = readAnchorManifests(TEST_ROOT);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].anchor_seq, 0);
  });

  it('since-last: a second anchor covers only the new entries and prev-links', () => {
    setup();
    writeN(3, 'first');
    const first = computeAnchor(TEST_ROOT);
    assert.deepEqual(first.manifest.seq_range, [0, 2]);

    // Append 2 more entries and anchor again.
    writeN(2, 'second');
    const second = computeAnchor(TEST_ROOT);
    assert.equal(second.empty, false);
    assert.equal(second.manifest.anchor_seq, 1);
    assert.equal(second.manifest.leaf_count, 2, 'since-last covers only the 2 new entries');
    assert.deepEqual(second.manifest.seq_range, [3, 4]);
    assert.equal(second.manifest.prev_anchor_root, first.manifest.root, 'second anchor prev-links to the first');

    const entries = readChainManifest(TEST_ROOT);
    const expectedSecond = merkleRootForAlgo([entries[3].submission_digest, entries[4].submission_digest]);
    assert.equal(second.manifest.root, expectedSecond);
  });

  it('re-running since-last with no new entries is empty (writes nothing)', () => {
    setup();
    writeN(2);
    computeAnchor(TEST_ROOT);
    const again = computeAnchor(TEST_ROOT);
    assert.equal(again.empty, true);
    assert.match(again.reason, /no chain entries since the last anchor|nothing new/i);
    assert.equal(readAnchorManifests(TEST_ROOT).length, 1);
  });

  it('--all snapshots the whole chain regardless of prior anchors', () => {
    setup();
    writeN(3, 'a');
    computeAnchor(TEST_ROOT); // anchor 0 covers [0,2]
    writeN(2, 'b');           // chain now [0,4]
    const all = computeAnchor(TEST_ROOT, { mode: 'all' });
    assert.equal(all.manifest.leaf_count, 5, '--all covers the whole chain');
    assert.deepEqual(all.manifest.seq_range, [0, 4]);
  });

  it('returns empty on an empty chain', () => {
    setup();
    const result = computeAnchor(TEST_ROOT);
    assert.equal(result.empty, true);
    assert.match(result.reason, /chain is empty/i);
  });

  it('rejects an unknown algo with a structured code', () => {
    setup();
    writeN(1);
    assert.throws(() => computeAnchor(TEST_ROOT, { algo: 'sha512-merkle' }), (err) => {
      assert.equal(err.code, 'ANCHOR_BAD_ALGO');
      return true;
    });
  });
});
