/**
 * f-ingest-001-post-anchor-v1-algo.test.js
 *
 * F-INGEST-001 — re-posting a non-default (v1) anchor must post the v1 root,
 * not be misreported as an append-only conflict.
 *
 * The bug: `postAnchor` re-ran `computeAnchor(repoRoot, { mode, network })`
 * WITHOUT threading the manifest's stored algo. compute defaults to the v2
 * algo (DEFAULT_ALGO = sha256-merkle-v2), so for a chain previously anchored
 * with sha256-merkle-v1 (historical reproduction) the recompute produced a v2
 * root that did not byte-match the on-disk v1 manifest. compute then threw
 * ANCHOR_MANIFEST_CONFLICT ("append-only"), which is a MISLEADING error — the
 * operator was simply re-posting a valid v1 anchor, not mutating it.
 *
 * Invariant (both halves):
 *   - a v1-algo anchor that already exists on disk re-posts SUCCESSFULLY, and
 *     the memo + receipt carry the v1 root/algo (not a freshly-recomputed v2
 *     root) — no ANCHOR_MANIFEST_CONFLICT.
 *   - the v2 default path is unchanged: a fresh post with no pre-existing
 *     manifest still computes + posts a v2 anchor.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord } from './persist.js';
import { computeAnchor } from './anchor/compute-root.js';
import { postAnchor } from './anchor/post-anchor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__post_anchor_v1_test__');
const GOOD_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0', policy_version: '1.0.0', run_id: 'pa-001',
    repo: 'dogfood-lab/testing-os', ref: { commit_sha: 'a'.repeat(40) },
    source: {
      provider: 'github', workflow: 'dogfood.yml', provider_run_id: '12345',
      run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
    },
    timing: { started_at: '2026-03-19T15:45:00Z', finished_at: '2026-03-19T15:45:12Z' },
    scenario_results: [{
      scenario_id: 'sanity', product_surface: 'cli', execution_mode: 'bot',
      verdict: 'pass', step_results: [{ step_id: 'one', status: 'pass' }],
    }],
    overall_verdict: { proposed: 'pass', verified: 'pass' },
    verification: {
      status: 'accepted', verified_at: '2026-03-19T15:45:13Z',
      provenance_confirmed: true, schema_valid: true, policy_valid: true,
    },
    ...overrides,
  };
}

function setup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
}

function writeN(n) {
  for (let i = 0; i < n; i++) writeRecord(buildRecord({ run_id: `pa-${i}` }), TEST_ROOT);
}

function hexToString(hex) { return Buffer.from(hex, 'hex').toString('utf8'); }

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function stubXrpl(sink) {
  return {
    Client: class {
      async connect() {}
      async disconnect() {}
      async submitAndWait(tx) {
        sink.submitted.push(tx);
        return {
          result: {
            hash: 'ABCDEF0123456789',
            meta: { TransactionResult: 'tesSUCCESS' },
            date: 0,
            ledger_index: 42,
          },
        };
      }
    },
    Wallet: { fromSeed: () => ({ address: 'rJmh6kBzcaAPdiQNMCxS3i548fn95ByN8W' }) },
  };
}

describe('F-INGEST-001 — postAnchor threads the existing manifest algo', () => {
  it('re-posts a v1 anchor binding the v1 root, not a recomputed v2 root', async () => {
    setup();
    writeN(3);

    // Operator computed a v1 (historical-reproduction) genesis anchor first.
    const computed = computeAnchor(TEST_ROOT, { mode: 'all', algo: 'sha256-merkle-v1' });
    assert.equal(computed.empty, false);
    const v1Root = computed.manifest.root;
    assert.equal(computed.manifest.algo, 'sha256-merkle-v1');

    const sink = { submitted: [] };
    const recorded = [];

    // Re-post the same genesis snapshot. Pre-fix postAnchor recomputed with the
    // v2 DEFAULT algo, binding a divergent v2 root (and silently appending a v2
    // duplicate); the operator's v1 root never reached the chain.
    const receipt = await postAnchor(TEST_ROOT, {
      mode: 'all',
      seed: GOOD_SEED,
      deps: {
        xrpl: stubXrpl(sink),
        recordPost: (seq, facts) => recorded.push({ seq, facts }),
      },
    });

    assert.equal(receipt.ok, true, 'post must succeed');
    assert.equal(receipt.root, v1Root, 'receipt must carry the v1 root, not a recomputed v2 root');

    const memoData = JSON.parse(hexToString(sink.submitted[0].Memos[0].Memo.MemoData));
    assert.equal(memoData.r, v1Root, 'memo must bind the v1 root');
    assert.equal(memoData.algo, 'sha256-merkle-v1', 'memo must self-describe the v1 algo');

    assert.equal(recorded.length, 1);
  });

  it('the v2 default path is unchanged: a fresh post computes + posts a v2 anchor', async () => {
    setup();
    writeN(2);

    const sink = { submitted: [] };
    const receipt = await postAnchor(TEST_ROOT, {
      seed: GOOD_SEED,
      deps: { xrpl: stubXrpl(sink), recordPost: () => {} },
    });

    assert.equal(receipt.ok, true);
    const memoData = JSON.parse(hexToString(sink.submitted[0].Memos[0].Memo.MemoData));
    assert.equal(memoData.algo, 'sha256-merkle-v2', 'fresh post defaults to the v2 algo');
  });
});
