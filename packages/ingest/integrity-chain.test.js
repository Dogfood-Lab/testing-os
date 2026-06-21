/**
 * Integrity chain integration tests — persist + verify-chain end to end.
 *
 * Covers the LOCKED CONTRACT's load-bearing behaviors:
 *   - persist stamps record.integrity and prev-links sequential records
 *     (record[1].prev_digest === record[0].submission_digest, seq 0 then 1)
 *     and appends one chain.jsonl line per write.
 *   - verify-chain accepts a clean chain and exits 0.
 *   - verify-chain DETECTS tampering: mutate a record on disk → the gate goes RED
 *     at the tampered seq (the load-bearing test).
 *   - verify-chain detects a broken prev-link.
 *   - Both accepted AND rejected records are appended to the chain (full
 *     tamper-evidence over everything persist writes).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord } from './persist.js';
import { GENESIS_DIGEST, submissionDigest } from './lib/integrity.js';
import { readChainManifest, CHAIN_MANIFEST_REL } from './lib/chain-manifest.js';
import { verifyChain } from './verify-chain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__integrity_test_root__');

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'chain-001',
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

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('persist integration: chain stamping', () => {
  it('stamps integrity on the persisted record and prev-links sequential records', () => {
    setup();
    const r0 = buildRecord({ run_id: 'chain-a' });
    const r1 = buildRecord({ run_id: 'chain-b' });

    const { path: p0 } = writeRecord(r0, TEST_ROOT);
    const { path: p1 } = writeRecord(r1, TEST_ROOT);

    const persisted0 = JSON.parse(readFileSync(p0, 'utf-8'));
    const persisted1 = JSON.parse(readFileSync(p1, 'utf-8'));

    // Genesis entry.
    assert.equal(persisted0.integrity.seq, 0);
    assert.equal(persisted0.integrity.prev_digest, GENESIS_DIGEST);
    assert.match(persisted0.integrity.submission_digest, /^[0-9a-f]{64}$/);

    // Second entry links to the first.
    assert.equal(persisted1.integrity.seq, 1);
    assert.equal(persisted1.integrity.prev_digest, persisted0.integrity.submission_digest);

    // The stamped digest equals a fresh recompute over the record-without-integrity.
    assert.equal(persisted0.integrity.submission_digest, submissionDigest(persisted0));
    assert.equal(persisted1.integrity.submission_digest, submissionDigest(persisted1));
  });

  it('appends one prev-linked chain.jsonl line per persisted record', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'chain-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'chain-b' }), TEST_ROOT);

    const manifestPath = join(TEST_ROOT, CHAIN_MANIFEST_REL);
    assert.ok(existsSync(manifestPath), 'chain.jsonl must exist');

    const entries = readChainManifest(TEST_ROOT);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].seq, 0);
    assert.equal(entries[0].prev_digest, GENESIS_DIGEST);
    assert.equal(entries[1].seq, 1);
    assert.equal(entries[1].prev_digest, entries[0].submission_digest);
    // Path is repo-relative, forward-slashed.
    assert.ok(!entries[0].path.includes('\\'), 'manifest path must be forward-slashed');
    assert.match(entries[0].path, /^records\//);
    assert.equal(entries[0].status, 'accepted');
    assert.equal(entries[0].run_id, 'chain-a');
  });

  it('appends rejected records to the chain too (full tamper-evidence)', () => {
    setup();
    const rejected = buildRecord({
      run_id: 'chain-rej',
      overall_verdict: { proposed: 'pass', verified: 'fail', downgraded: true },
      verification: {
        status: 'rejected',
        verified_at: '2026-03-19T15:45:13Z',
        provenance_confirmed: false,
        schema_valid: true,
        policy_valid: false,
        rejection_reasons: ['provenance not confirmed'],
      },
    });
    writeRecord(rejected, TEST_ROOT);

    const entries = readChainManifest(TEST_ROOT);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'rejected');
    assert.match(entries[0].path, /^records\/_rejected\//);
  });

  it('does NOT append to the chain when a record is a duplicate (no write occurred)', () => {
    setup();
    const r = buildRecord({ run_id: 'chain-dup' });
    const first = writeRecord(r, TEST_ROOT);
    assert.ok(first.written);

    const second = writeRecord(buildRecord({ run_id: 'chain-dup' }), TEST_ROOT);
    assert.equal(second.written, false);

    const entries = readChainManifest(TEST_ROOT);
    assert.equal(entries.length, 1, 'duplicate must not add a second chain line');
  });
});

describe('verify-chain', () => {
  it('verifies a clean 3-record chain OK', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'clean-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'clean-b' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'clean-c' }), TEST_ROOT);

    const result = verifyChain(TEST_ROOT);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.count, 3);
    assert.match(result.head_digest, /^[0-9a-f]{64}$/);
    assert.equal(result.break, null);
  });

  it('verifies OK when there is no manifest yet (empty chain is trivially valid)', () => {
    setup();
    const result = verifyChain(TEST_ROOT);
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.equal(result.head_digest, GENESIS_DIGEST);
  });

  it('FAILS at the tampered seq when a record is mutated on disk (load-bearing)', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'tamper-a' }), TEST_ROOT);
    const { path: p1 } = writeRecord(buildRecord({ run_id: 'tamper-b' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'tamper-c' }), TEST_ROOT);

    // Clean chain verifies first — proves the gate is GREEN before the tamper.
    assert.equal(verifyChain(TEST_ROOT).ok, true);

    // TAMPER: mutate the record content WITHOUT updating its stamped digest or
    // the manifest line. This is exactly the out-of-band edit the chain detects.
    const tampered = JSON.parse(readFileSync(p1, 'utf-8'));
    tampered.notes = 'this line was injected after persist';
    writeFileSync(p1, JSON.stringify(tampered, null, 2) + '\n', 'utf-8');

    const result = verifyChain(TEST_ROOT);
    assert.equal(result.ok, false, 'tampered chain MUST fail');
    assert.equal(result.break.seq, 1, 'break is at the tampered seq');
    assert.equal(result.break.run_id, 'tamper-b');
    assert.match(result.break.reason, /digest mismatch|recomputed/i);
  });

  it('FAILS on a broken prev-link (manifest entry rewired)', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'link-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'link-b' }), TEST_ROOT);

    // Corrupt the second entry's prev_digest in the manifest so it no longer
    // points at the first entry's digest.
    const manifestPath = join(TEST_ROOT, CHAIN_MANIFEST_REL);
    const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n');
    const second = JSON.parse(lines[1]);
    second.prev_digest = 'b'.repeat(64);
    lines[1] = JSON.stringify(second);
    writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf-8');

    const result = verifyChain(TEST_ROOT);
    assert.equal(result.ok, false);
    assert.equal(result.break.seq, 1);
    assert.match(result.break.reason, /prev[_-]?digest|link/i);
  });

  it('FAILS on a non-monotonic seq', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'seq-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'seq-b' }), TEST_ROOT);

    const manifestPath = join(TEST_ROOT, CHAIN_MANIFEST_REL);
    const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n');
    const second = JSON.parse(lines[1]);
    second.seq = 5; // should be 1
    lines[1] = JSON.stringify(second);
    writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf-8');

    const result = verifyChain(TEST_ROOT);
    assert.equal(result.ok, false);
    assert.match(result.break.reason, /seq|monotonic/i);
  });

  it('FAILS when a manifest-referenced record file is missing', () => {
    setup();
    const { path: p0 } = writeRecord(buildRecord({ run_id: 'gone-a' }), TEST_ROOT);
    rmSync(p0, { force: true });

    const result = verifyChain(TEST_ROOT);
    assert.equal(result.ok, false);
    assert.equal(result.break.seq, 0);
    assert.match(result.break.reason, /missing|not found|read/i);
  });
});
