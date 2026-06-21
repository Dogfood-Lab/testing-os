/**
 * post-anchor tests — all run WITHOUT xrpl installed.
 *
 * Pure / offline coverage:
 *   - buildAnchorMemo shape: MemoType self-identifies, algo self-described,
 *     fields hex-encoded, round-trips through a decode.
 *   - validateSeedShape: empty / wrong-prefix / bad-charset / good.
 *   - extractCloseTime / extractLedgerIndex from a submitAndWait-shaped result.
 *   - loadXrpl throws the structured install hint (xrpl is not installed).
 *   - postAnchor refuses without XRPL_SEED.
 *   - postAnchor drives the FULL submit path via an injected stub xrpl (no real
 *     xrpl, no network) and records the on-chain facts back via recordPost.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord } from './persist.js';
import {
  buildAnchorMemo,
  validateSeedShape,
  extractCloseTime,
  extractLedgerIndex,
  loadXrpl,
  postAnchor,
  ANCHOR_MEMO_TYPE,
  XrplDependencyError,
} from './anchor/post-anchor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__post_anchor_test__');
const GOOD_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2'; // shape-valid ed25519-style seed

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

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function hexToString(hex) { return Buffer.from(hex, 'hex').toString('utf8'); }

describe('buildAnchorMemo', () => {
  const args = {
    anchorSeq: 0, network: 'testnet', rootHex: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64), count: 5, prev: null, range: [0, 4], algo: 'sha256-merkle-v2',
  };

  it('MemoType self-identifies and the dataObj round-trips', () => {
    const { Memo } = buildAnchorMemo(args);
    assert.equal(hexToString(Memo.MemoType), ANCHOR_MEMO_TYPE);
    assert.equal(hexToString(Memo.MemoFormat), 'application/json');
    const data = JSON.parse(hexToString(Memo.MemoData));
    assert.equal(data.r, 'a'.repeat(64));
    assert.equal(data.h, 'b'.repeat(64));
    assert.equal(data.c, 5);
    assert.equal(data.s, 0);
    assert.equal(data.rg, '0..4');
    assert.equal(data.pv, '0', 'genesis prev encodes as "0"');
    assert.equal(data.algo, 'sha256-merkle-v2', 'memo self-describes the algo');
  });

  it('carries a non-genesis prev root', () => {
    const { Memo } = buildAnchorMemo({ ...args, prev: 'c'.repeat(64) });
    const data = JSON.parse(hexToString(Memo.MemoData));
    assert.equal(data.pv, 'c'.repeat(64));
  });

  it('throws when the memo data would exceed the size cap', () => {
    assert.throws(() => buildAnchorMemo({ ...args, rootHex: 'a'.repeat(2000) }), /too large/i);
  });
});

describe('validateSeedShape', () => {
  it('rejects empty / unset', () => {
    assert.equal(validateSeedShape('').ok, false);
    assert.equal(validateSeedShape(undefined).ok, false);
  });
  it("rejects a seed that does not start with 's' (e.g. a pasted r-address)", () => {
    const r = validateSeedShape('rJmh6kBzcaAPdiQNMCxS3i548fn95ByN8W');
    assert.equal(r.ok, false);
    assert.match(r.reason, /begin with 's'|ADDRESS/i);
  });
  it('rejects characters outside base58', () => {
    assert.equal(validateSeedShape('sABC0OIl1111111111111111111').ok, false);
  });
  it('accepts a shape-valid seed', () => {
    assert.equal(validateSeedShape(GOOD_SEED).ok, true);
  });
});

describe('extractCloseTime / extractLedgerIndex', () => {
  it('converts a Ripple-epoch date to ISO', () => {
    // Ripple epoch 0 = 2000-01-01T00:00:00Z.
    assert.equal(extractCloseTime({ result: { date: 0 } }), '2000-01-01T00:00:00.000Z');
  });
  it('returns null when date/ledger_index absent', () => {
    assert.equal(extractCloseTime({ result: {} }), null);
    assert.equal(extractLedgerIndex({ result: {} }), null);
  });
  it('reads the validating ledger index', () => {
    assert.equal(extractLedgerIndex({ result: { ledger_index: 987 } }), 987);
  });
});

describe('loadXrpl — optional dependency', () => {
  it('throws the structured install hint when xrpl is not installed', async () => {
    await assert.rejects(loadXrpl(), (err) => {
      assert.ok(err instanceof XrplDependencyError);
      assert.equal(err.code, 'XRPL_NOT_INSTALLED');
      assert.match(err.message, /npm install xrpl/);
      return true;
    });
  });
});

describe('postAnchor', () => {
  it('refuses to post without a valid XRPL_SEED', async () => {
    setup();
    writeN(2);
    await assert.rejects(
      postAnchor(TEST_ROOT, { seed: '' }),
      (err) => { assert.equal(err.code, 'XRPL_SEED_INVALID'); return true; }
    );
  });

  it('drives the full submit path via an injected stub xrpl (no real xrpl, no network)', async () => {
    setup();
    writeN(3);

    const submitted = [];
    const recorded = [];
    const stubXrpl = {
      Client: class {
        constructor(url) { this.url = url; }
        async connect() {}
        async disconnect() {}
        async submitAndWait(tx) {
          submitted.push(tx);
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

    const receipt = await postAnchor(TEST_ROOT, {
      seed: GOOD_SEED,
      deps: {
        xrpl: stubXrpl,
        recordPost: (seq, facts) => recorded.push({ seq, facts }),
      },
    });

    assert.equal(receipt.ok, true);
    assert.equal(receipt.tx_hash, 'ABCDEF0123456789');
    assert.equal(receipt.ledger_index, 42);
    assert.equal(receipt.close_time_iso, '2000-01-01T00:00:00.000Z');
    assert.equal(receipt.leaf_count, 3);
    assert.deepEqual(receipt.seq_range, [0, 2]);

    // The AccountSet tx carried exactly one anchor memo.
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].TransactionType, 'AccountSet');
    assert.equal(submitted[0].Memos.length, 1);
    assert.equal(hexToString(submitted[0].Memos[0].Memo.MemoType), ANCHOR_MEMO_TYPE);

    // The on-chain facts were recorded back.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].seq, 0);
    assert.equal(recorded[0].facts.tx_hash, 'ABCDEF0123456789');
  });
});
