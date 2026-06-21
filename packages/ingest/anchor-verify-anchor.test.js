/**
 * verify-anchor tests.
 *
 * verifyAnchorTx (pure on-chain verification) — ported from repomesh's
 *   verify-anchor.test.mjs: a clean mock tx+memo binding the local root PASSES;
 *   wrong root / not-validated / untrusted account / wrong count FAIL.
 *
 * verifyChainAgainstAnchors (THE TRUNCATION DETECTOR) — the load-bearing test:
 *   anchor a 5-entry chain, truncate chain.jsonl to 3 entries, and assert the
 *   truncation check goes RED. This is the gap the offline tamper-evident chain
 *   could NOT catch (a shorter chain still verifies internally) and the reason
 *   the XRPL anchor upgrades it to tamper-PROOF below an anchored point.
 *
 * No network, no xrpl.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, readFileSync, writeFileSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { writeRecord } from './persist.js';
import { CHAIN_MANIFEST_REL } from './lib/chain-manifest.js';
import { merkleRootForAlgo, merkleRootHexV2 } from './anchor/merkle.js';
import { computeAnchor } from './anchor/compute-root.js';
import {
  verifyAnchorTx,
  verifyChainAgainstAnchors,
  verifyAnchorState,
  decodeAnchorMemo,
  recomputeLocalForAnchor,
} from './anchor/verify-anchor.js';
import { buildAnchorMemo } from './anchor/post-anchor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__verify_anchor_test__');
const TRUSTED = 'rJmh6kBzcaAPdiQNMCxS3i548fn95ByN8W';

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'va-001',
    repo: 'dogfood-lab/testing-os',
    ref: { commit_sha: 'a'.repeat(40) },
    source: {
      provider: 'github',
      workflow: 'dogfood.yml',
      provider_run_id: '12345',
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

function writeN(n, prefix = 'rec') {
  for (let i = 0; i < n; i++) writeRecord(buildRecord({ run_id: `${prefix}-${i}` }), TEST_ROOT);
}

/** Truncate chain.jsonl in place to its first `keep` lines. */
function truncateChain(keep) {
  const p = join(TEST_ROOT, CHAIN_MANIFEST_REL);
  const lines = readFileSync(p, 'utf-8').trim().split('\n');
  writeFileSync(p, lines.slice(0, keep).join('\n') + '\n', 'utf-8');
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── verifyAnchorTx — pure on-chain verification (ported from repomesh) ────────

const leafHex = (n) => crypto.createHash('sha256').update(`leaf-${n}`).digest('hex');
const fixtureLeaves = [leafHex(0), leafHex(1), leafHex(2)];

function v2Fixture() {
  const root = merkleRootHexV2(fixtureLeaves);
  const memo = { v: 1, s: 0, n: 'testnet', r: root, h: 'feedface'.repeat(8), c: fixtureLeaves.length, algo: 'sha256-merkle-v2' };
  return { memo, localRoot: root, localManifestHash: memo.h };
}

function mockTx(overrides = {}) {
  return { validated: true, Account: TRUSTED, meta: { TransactionResult: 'tesSUCCESS' }, ...overrides };
}

describe('verifyAnchorTx — clean anchor PASSES', () => {
  it('a fully-valid v2 anchor verifies ok', () => {
    const f = v2Fixture();
    const r = verifyAnchorTx({
      tx: mockTx(), memo: f.memo, localRoot: f.localRoot,
      localManifestHash: f.localManifestHash, leafCount: fixtureLeaves.length,
      trustedAnchorAccounts: [TRUSTED],
    });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  });
});

describe('verifyAnchorTx — tampered anchors FAIL', () => {
  it('FAILS when memo root does not match the local root', () => {
    const f = v2Fixture();
    const r = verifyAnchorTx({
      tx: mockTx(), memo: { ...f.memo, r: '0'.repeat(64) }, localRoot: f.localRoot,
      localManifestHash: f.localManifestHash, leafCount: fixtureLeaves.length, trustedAnchorAccounts: [TRUSTED],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /root/i);
  });

  it('FAILS when tx.validated !== true', () => {
    const f = v2Fixture();
    const r = verifyAnchorTx({
      tx: mockTx({ validated: false }), memo: f.memo, localRoot: f.localRoot,
      localManifestHash: f.localManifestHash, leafCount: fixtureLeaves.length, trustedAnchorAccounts: [TRUSTED],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /validat/i);
  });

  it('FAILS when meta.TransactionResult is not tesSUCCESS', () => {
    const f = v2Fixture();
    const r = verifyAnchorTx({
      tx: mockTx({ meta: { TransactionResult: 'tecPATH_DRY' } }), memo: f.memo, localRoot: f.localRoot,
      localManifestHash: f.localManifestHash, leafCount: fixtureLeaves.length, trustedAnchorAccounts: [TRUSTED],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /tessuccess|result|transaction/i);
  });

  it('FAILS when tx.Account is not in trustedAnchorAccounts', () => {
    const f = v2Fixture();
    const r = verifyAnchorTx({
      tx: mockTx({ Account: 'rROGUEwallet11111111111111111111' }), memo: f.memo, localRoot: f.localRoot,
      localManifestHash: f.localManifestHash, leafCount: fixtureLeaves.length, trustedAnchorAccounts: [TRUSTED],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /account|wallet|trust|allowlist/i);
  });

  it('FAILS when memo count does not match the local leaf count', () => {
    const f = v2Fixture();
    const r = verifyAnchorTx({
      tx: mockTx(), memo: { ...f.memo, c: 99 }, localRoot: f.localRoot,
      localManifestHash: f.localManifestHash, leafCount: fixtureLeaves.length, trustedAnchorAccounts: [TRUSTED],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /count/i);
  });
});

// ── verifyChainAgainstAnchors — THE TRUNCATION DETECTOR (load-bearing) ────────

describe('verifyChainAgainstAnchors — truncation detection', () => {
  it('PASSES a full chain that still reaches the anchored point', () => {
    setup();
    writeN(5);
    computeAnchor(TEST_ROOT); // anchors seq [0,4]
    const r = verifyChainAgainstAnchors(TEST_ROOT);
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.anchored_through_seq, 4);
    assert.equal(r.chain_head_seq, 4);
  });

  it('FAILS LOUD on a TAIL-TRUNCATED chain (the gap the offline floor cannot catch)', () => {
    setup();
    // Build a 5-entry chain and anchor it on-chain (locally: the manifest records
    // seq_range [0,4], leaf_count 5, head_digest of entry 4).
    writeN(5);
    const anchored = computeAnchor(TEST_ROOT);
    assert.equal(anchored.manifest.leaf_count, 5);
    assert.deepEqual(anchored.manifest.seq_range, [0, 4]);

    // GREEN before the truncation: the chain reaches the anchored point.
    assert.equal(verifyChainAgainstAnchors(TEST_ROOT).ok, true,
      'pre-truncation the anchor check must be GREEN');

    // TRUNCATE: drop the most-recent 2 entries (the exact attack the offline
    // tamper-evident chain CANNOT detect — a shorter chain still verifies clean).
    truncateChain(3);

    // The offline floor would still say OK here; the anchor closes the gap.
    const r = verifyChainAgainstAnchors(TEST_ROOT);
    assert.equal(r.ok, false, 'a tail-truncated chain MUST fail the anchor check');
    assert.equal(r.chain_head_seq, 2, 'chain head is now seq 2');
    assert.equal(r.anchored_through_seq, 4, 'anchors still certify through seq 4');
    assert.ok(r.failures.length > 0, 'at least one failure must be reported');
    assert.ok(
      r.failures.some((f) => f.kind === 'truncation' || f.kind === 'count-shortfall'),
      'failure must name truncation / count-shortfall'
    );
    assert.match(r.reason, /truncat/i);
  });

  it('FAILS when entries below an anchor are mutated (root no longer reproduces)', () => {
    setup();
    writeN(4);
    computeAnchor(TEST_ROOT); // anchors [0,3]
    assert.equal(verifyChainAgainstAnchors(TEST_ROOT).ok, true);

    // Mutate the submission_digest of an entry inside the anchored range. Head
    // seq stays 3 and count stays 4, so the truncation/count checks pass — but
    // the recomputed root drifts from the anchored root.
    const p = join(TEST_ROOT, CHAIN_MANIFEST_REL);
    const lines = readFileSync(p, 'utf-8').trim().split('\n');
    const e1 = JSON.parse(lines[1]);
    e1.submission_digest = 'f'.repeat(64);
    lines[1] = JSON.stringify(e1);
    writeFileSync(p, lines.join('\n') + '\n', 'utf-8');

    const r = verifyChainAgainstAnchors(TEST_ROOT);
    assert.equal(r.ok, false, 'a mutation below the anchor must fail the root-drift check');
    assert.ok(r.failures.some((f) => f.kind === 'root-drift'), 'root-drift must be reported');
  });

  it('is honest when there are no anchors: ok but flagged as not-anchored', () => {
    setup();
    writeN(3);
    const r = verifyChainAgainstAnchors(TEST_ROOT);
    assert.equal(r.ok, true);
    assert.equal(r.anchor_count, 0);
    assert.match(r.reason, /no anchors|tamper-evident/i);
  });

  it('recomputeLocalForAnchor reports truncation when the live chain cannot cover the range', () => {
    setup();
    writeN(5);
    const anchored = computeAnchor(TEST_ROOT);
    truncateChain(3);
    const local = recomputeLocalForAnchor(TEST_ROOT, anchored.manifest);
    assert.equal(local.ok, false);
    assert.match(local.reason, /shorter than the anchored point|truncation/i);
  });
});

// ── verifyAnchorState — offline-honest combined verification ──────────────────

describe('verifyAnchorState — offline-honest', () => {
  it('reports xrpl_verified:false (XRPL NOT verified) when no tx is supplied', () => {
    setup();
    writeN(3);
    computeAnchor(TEST_ROOT);
    const r = verifyAnchorState(TEST_ROOT);
    assert.equal(r.xrpl_verified, false);
    assert.match(r.note, /NOT verified/i);
    // The local truncation check still ran and passes for a full chain.
    assert.equal(r.truncation.ok, true);
    assert.equal(r.ok, true, 'offline with an intact chain is ok, but NOT xrpl-verified');
  });

  it('xrpl-verifies a well-formed fetched tx binding the anchored root', () => {
    setup();
    writeN(3);
    const anchored = computeAnchor(TEST_ROOT);
    const m = anchored.manifest;

    // Build the memo the post path would have written, then a mock validated tx
    // carrying it from the trusted account.
    const memoEnvelope = buildAnchorMemo({
      anchorSeq: m.anchor_seq, network: m.network, rootHex: m.root,
      manifestHash: m.manifest_hash, count: m.leaf_count, prev: m.prev_anchor_root,
      range: m.seq_range, algo: m.algo,
    });
    const tx = mockTx({ Memos: [memoEnvelope] });

    const r = verifyAnchorState(TEST_ROOT, { tx, trustedAnchorAccounts: [TRUSTED] });
    assert.equal(r.xrpl_verified, true, JSON.stringify(r, null, 2));
    assert.equal(r.ok, true);
    assert.match(r.note, /XRPL verified/i);

    // decodeAnchorMemo round-trips the memo the builder produced.
    const decoded = decodeAnchorMemo(tx);
    assert.equal(decoded.r, m.root);
  });

  it('does NOT pass when the tx is from an untrusted account', () => {
    setup();
    writeN(3);
    const anchored = computeAnchor(TEST_ROOT);
    const m = anchored.manifest;
    const memoEnvelope = buildAnchorMemo({
      anchorSeq: m.anchor_seq, network: m.network, rootHex: m.root,
      manifestHash: m.manifest_hash, count: m.leaf_count, prev: m.prev_anchor_root,
      range: m.seq_range, algo: m.algo,
    });
    const tx = mockTx({ Account: 'rROGUEwallet11111111111111111111', Memos: [memoEnvelope] });
    const r = verifyAnchorState(TEST_ROOT, { tx, trustedAnchorAccounts: [TRUSTED] });
    assert.equal(r.xrpl_verified, false);
    assert.equal(r.ok, false);
  });
});
