/**
 * ingest-proact-002-anchor-receipt-record-failure.test.js
 *
 * INGEST-PROACT-002 (Stage C humanization) — a landed anchor must NEVER be
 * reported as a failure.
 *
 * The hole: postAnchor() submits the AccountSet, gets `receipt.ok` (the anchor
 * LANDED on-chain — an irreversible, citable fact), then calls `recordPost(...)`
 * to persist the on-chain facts back into the local manifest. If recordPost
 * THROWS (disk full, EPERM, manifest deleted between compute and post), the
 * throw escaped postAnchor → handleAnchorPost's catch mapped it to exitCode 2
 * ("anchor-post failed"). That is a false failure: the anchor is on-chain, the
 * money was spent, the tx_hash exists — but the operator is told it failed and
 * may re-post, double-spending the fee against a divergent state.
 *
 * Fix: catch the recordPost failure INSIDE postAnchor. The anchor stays a
 * success (receipt.ok stays true), but the receipt carries a distinct
 * `record_failed` outcome naming tx_hash/ledger_index and a recovery action.
 * handleAnchorPost surfaces it as exit 0 (NOT exit 2) with a loud WARNING, and
 * the structured event carries the tx_hash so the on-chain fact survives in logs.
 *
 * Invariant:
 *   - a throwing recordPost AFTER a successful submit yields receipt.ok === true
 *     with receipt.record_failed describing the failure and carrying tx_hash.
 *   - handleAnchorPost returns exitCode 0 (NOT 2), prints a WARNING naming the
 *     tx_hash + recovery action, and the event carries tx_hash.
 *   - the on-chain landing is never reported as 'failed'.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord } from './persist.js';
import { postAnchor } from './anchor/post-anchor.js';
import { handleAnchorPost } from './anchor/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__proact_002_test__');
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

describe('INGEST-PROACT-002 — landed anchor + failing recordPost is a WARNING, not a failure', () => {
  it('postAnchor: a throwing recordPost AFTER landing keeps receipt.ok and surfaces tx_hash', async () => {
    setup();
    writeN(3);

    const sink = { submitted: [] };
    const receipt = await postAnchor(TEST_ROOT, {
      seed: GOOD_SEED,
      deps: {
        xrpl: stubXrpl(sink),
        recordPost: () => { throw new Error('ENOSPC: no space left on device, write manifest'); },
      },
    });

    // The anchor LANDED — never report it as failed.
    assert.equal(receipt.ok, true, 'a landed anchor must stay ok even when local recording fails');
    assert.equal(receipt.tx_hash, 'ABCDEF0123456789', 'the on-chain tx must survive on the receipt');
    assert.equal(receipt.ledger_index, 42);

    // The receipt carries a distinct, named record-failure outcome.
    assert.ok(receipt.record_failed, 'receipt must carry a record_failed outcome');
    assert.match(receipt.record_failed.error, /ENOSPC|no space/,
      'the underlying recordPost error must be named');
  });

  it('handleAnchorPost: maps the landed-but-unrecorded case to exit 0 + a loud WARNING (not exit 2)', async () => {
    setup();
    writeN(2);

    const sink = { submitted: [] };
    const result = await handleAnchorPost(TEST_ROOT, {
      seed: GOOD_SEED,
      deps: {
        xrpl: stubXrpl(sink),
        recordPost: () => { throw new Error('EPERM: operation not permitted'); },
      },
    });

    assert.equal(result.exitCode, 0,
      `a landed anchor must NOT exit 2; got exitCode ${result.exitCode}`);
    assert.equal(result.ok, true, 'the outcome is a success-with-warning, not a failure');

    const text = result.lines.join('\n');
    assert.match(text, /LANDED on-chain/i, 'must state the anchor landed on-chain');
    assert.match(text, /ABCDEF0123456789/, 'must name the tx_hash so the on-chain fact is recoverable');
    assert.match(text, /anchor-post|anchor-verify/i, 'must give a recovery action');
    assert.match(text, /EPERM/, 'must name the underlying recording error');

    // The structured event carries the tx_hash so the on-chain fact survives in logs.
    assert.equal(result.event.tx_hash, 'ABCDEF0123456789',
      'the event must carry tx_hash for log-grep recovery');
  });

  it('handleAnchorPost: a clean post (recordPost succeeds) is unchanged — exit 0, no WARNING', async () => {
    setup();
    writeN(2);

    const sink = { submitted: [] };
    const recorded = [];
    const result = await handleAnchorPost(TEST_ROOT, {
      seed: GOOD_SEED,
      deps: {
        xrpl: stubXrpl(sink),
        recordPost: (seq, facts) => recorded.push({ seq, facts }),
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(recorded.length, 1, 'the clean path still records the on-chain facts');
    const text = result.lines.join('\n');
    assert.doesNotMatch(text, /WARNING/i, 'the clean path must not print a record-failure warning');
  });
});
