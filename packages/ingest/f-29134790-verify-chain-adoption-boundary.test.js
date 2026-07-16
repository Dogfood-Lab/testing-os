/**
 * f-29134790-verify-chain-adoption-boundary.test.js
 *
 * F-29134790 (wave 12, HIGH). collectOrphanRecords' path-identity membership
 * check (hardened by F-d4bcf5d0, wave 10 — see
 * ingest-proact-001-004-verify-chain-reconcile-allbreaks.test.js) is correct
 * for records the chain COULD have ledgered, but on its own it has no
 * ADOPTION BOUNDARY: every un-ledgered record file reads identically,
 * whether it is a genuine crash-window torn write or a record that predates
 * the integrity chain's existence entirely.
 *
 * Proven live against the real repo (see verify-chain.js's F-29134790 doc
 * comment): 53 pre-chain records — every one written before persist.js
 * gained its integrity-stamping logic (f4ca987, 2026-06-21) — were reported
 * as indistinguishable "torn persist" orphans by
 * `verifyChain(repoRoot, { collectOrphans: true })`, a 53:0
 * signal-to-noise ratio against zero genuine torn writes.
 *
 * The fix: persist.js's writeRecord stamps `record.integrity` UNCONDITIONALLY
 * in memory BEFORE it writes the record file, so a genuine post-adoption torn
 * write is guaranteed to carry a fully-formed integrity block on disk even
 * though its ledger line is missing. A record with NO integrity block at all
 * can only predate that stamping logic. collectOrphanRecords now buckets
 * such records into `preAdoption` (visible, does not fail `ok`) instead of
 * `orphans` (fails `ok`).
 *
 * This file exercises the fixture PIN directly (no dependency on this repo's
 * own historical records/ state, so it stays meaningful regardless of how
 * that tree grows): a corpus with pre-chain records AND one genuine
 * post-chain torn write must report ONLY the torn write as an orphan; a fully
 * clean post-chain corpus (with pre-chain history present) must report ok:true.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord, computeRecordPath } from './persist.js';
import { verifyChain, formatChainResult } from './verify-chain.js';
import { chainManifestPath } from './lib/chain-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__f_29134790_test__');

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0', policy_version: '1.0.0', run_id: 'adopt-001',
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

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * Write a record file the way PRE-adoption persist.js would have: the same
 * path-sharding computeRecordPath produces today, but with NO `integrity`
 * block and NO chain.jsonl append — because that logic did not exist yet.
 * Reuses computeRecordPath (not a reimplementation) so the fixture's path
 * shape cannot drift from what the real pre-chain records on disk actually
 * look like.
 */
function writePreChainRecord(repoRoot, overrides = {}) {
  const record = buildRecord(overrides);
  assert.equal(record.integrity, undefined, 'a pre-chain fixture record must not carry an integrity block');
  const path = computeRecordPath(record, repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return { path, record };
}

/** Drop the ledger line for `path` (a repo-relative path) without touching the record file. */
function dropLedgerLineFor(repoRoot, relPath) {
  const manifestPath = chainManifestPath(repoRoot);
  const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n');
  const kept = lines.filter((line) => JSON.parse(line).path !== relPath);
  assert.equal(kept.length, lines.length - 1, `expected to drop exactly one ledger line for ${relPath}`);
  writeFileSync(manifestPath, kept.join('\n') + '\n', 'utf-8');
}

describe('F-29134790 — adoption boundary for pre-chain records', () => {
  it('CORE PIN: pre-chain records + one genuine torn write — only the torn write is an orphan', () => {
    setup();

    // Two pre-chain records: on disk, no integrity block, never ledgered.
    const { path: preA } = writePreChainRecord(TEST_ROOT, { run_id: 'pre-chain-a' });
    const { path: preB } = writePreChainRecord(TEST_ROOT, { run_id: 'pre-chain-b', verification: { status: 'rejected', verified_at: '2026-03-19T15:45:13Z', provenance_confirmed: false, schema_valid: true, policy_valid: false, rejection_reasons: ['policy: forbidden tag "wip"'] } });

    // Two genuine post-chain records, fully ledgered (clean).
    writeRecord(buildRecord({ run_id: 'post-chain-clean-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'post-chain-clean-b' }), TEST_ROOT);

    // One genuine post-chain record whose ledger line is torn off — the
    // crash-window shape this reconciliation pass exists to catch.
    const { path: tornPath } = writeRecord(buildRecord({ run_id: 'post-chain-torn' }), TEST_ROOT);
    const tornRel = relative(TEST_ROOT, tornPath).split(sep).join('/');
    dropLedgerLineFor(TEST_ROOT, tornRel);

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false, 'a genuine torn write must still fail ok');
    assert.ok(Array.isArray(result.orphans), 'orphans must be an array');
    assert.equal(result.orphans.length, 1, `expected exactly one genuine orphan, got ${JSON.stringify(result.orphans)}`);
    assert.equal(result.orphans[0].run_id, 'post-chain-torn');
    assert.equal(result.orphans[0].path, tornRel);

    assert.ok(Array.isArray(result.pre_adoption), 'pre_adoption must be an array');
    assert.equal(result.pre_adoption.length, 2, `expected exactly two pre-adoption records, got ${JSON.stringify(result.pre_adoption)}`);
    const preAdoptionRunIds = result.pre_adoption.map((p) => p.run_id).sort();
    assert.deepEqual(preAdoptionRunIds, ['pre-chain-a', 'pre-chain-b']);

    // Neither pre-chain record leaked into orphans under any identity.
    assert.ok(!result.orphans.some((o) => o.run_id === 'pre-chain-a' || o.run_id === 'pre-chain-b'),
      'pre-chain records must never appear in orphans');
    void preA; void preB;
  });

  it('CORE PIN: a fully-clean post-chain corpus reports ok:true even with pre-chain history present', () => {
    setup();

    writePreChainRecord(TEST_ROOT, { run_id: 'pre-chain-only-a' });
    writePreChainRecord(TEST_ROOT, { run_id: 'pre-chain-only-b' });
    writePreChainRecord(TEST_ROOT, { run_id: 'pre-chain-only-c' });
    writeRecord(buildRecord({ run_id: 'post-chain-only-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'post-chain-only-b' }), TEST_ROOT);

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, true, 'pre-chain history alone must not fail ok');
    assert.equal(result.orphans.length, 0, 'zero genuine orphans');
    assert.equal(result.pre_adoption.length, 3, 'all three pre-chain records are bucketed, not silently dropped');
  });

  it('a corpus with zero pre-chain records behaves exactly as before (pre_adoption is present but empty)', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'no-history-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'no-history-b' }), TEST_ROOT);

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(result.ok, true);
    assert.equal(result.orphans.length, 0);
    assert.ok(Array.isArray(result.pre_adoption));
    assert.equal(result.pre_adoption.length, 0);
  });

  it('a degenerate on-disk value (valid JSON, not an object) is NOT excused as pre-adoption — it fails loud as a genuine orphan', () => {
    setup();
    // Not reachable through any real persist path, but collectOrphanRecords
    // must not crash on it, and must not silently wave it through as
    // "historical" just because it also lacks an integrity block.
    const degenPath = resolve(TEST_ROOT, 'records', 'dogfood-lab', 'testing-os', '2026', '01', '01', 'run-degenerate.json');
    mkdirSync(dirname(degenPath), { recursive: true });
    writeFileSync(degenPath, 'null\n', 'utf-8');

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(result.ok, false);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.pre_adoption.length, 0);
    assert.ok(existsSync(degenPath));
  });

  it('formatChainResult surfaces the pre-adoption count without reporting BROKEN when ok', () => {
    setup();
    writePreChainRecord(TEST_ROOT, { run_id: 'fmt-pre-a' });
    writeRecord(buildRecord({ run_id: 'fmt-post-a' }), TEST_ROOT);

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(result.ok, true);
    const lines = formatChainResult(result);
    assert.ok(lines.some((l) => l.includes('integrity chain OK')), `expected an OK line, got ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => /BROKEN/.test(l)), 'must not report BROKEN when ok');
    assert.ok(lines.some((l) => /1 pre-chain record/.test(l)),
      `expected a pre-chain count line, got ${JSON.stringify(lines)}`);
  });

  it('formatChainResult names the pre-adoption count separately from the orphan count when NOT ok', () => {
    setup();
    writePreChainRecord(TEST_ROOT, { run_id: 'fmt-notok-pre-a' });
    writePreChainRecord(TEST_ROOT, { run_id: 'fmt-notok-pre-b' });
    const { path: tornPath } = writeRecord(buildRecord({ run_id: 'fmt-notok-torn' }), TEST_ROOT);
    const tornRel = relative(TEST_ROOT, tornPath).split(sep).join('/');
    dropLedgerLineFor(TEST_ROOT, tornRel);

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(result.ok, false);
    const lines = formatChainResult(result);
    assert.ok(lines.some((l) => /1 orphan record/.test(l)), `expected exactly one orphan line, got ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => /2 pre-chain record/.test(l)), `expected a two-pre-chain-record line, got ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes('fmt-notok-torn')), 'the genuine orphan must still be named');
  });
});
