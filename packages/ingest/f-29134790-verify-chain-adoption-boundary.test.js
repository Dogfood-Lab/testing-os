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
 *
 * F-1907b2bc (wave 14, MEDIUM) hardens the SAME adoption boundary one step
 * further. F-29134790 above treats "no integrity block" as sufficient proof a
 * record predates the chain, but that only holds for records that actually
 * went through writeRecord() — a record dropped directly onto disk (no
 * writeRecord call at all) also has no integrity block, and was silently
 * absorbed into `preAdoption` with a "predates the chain" reason string that
 * is provably false whenever the dropped record's OWN claimed
 * timing.finished_at/verification.verified_at is on or after
 * CHAIN_ADOPTION_DATE. The fix cross-checks that claimed timestamp before
 * accepting the pre-adoption narrative; see the 'F-1907b2bc' describe block
 * below and verify-chain.js's matching doc paragraphs.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord, computeRecordPath } from './persist.js';
import { verifyChain, formatChainResult, CHAIN_ADOPTION_DATE } from './verify-chain.js';
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

describe('F-1907b2bc — a no-integrity record must also pass a timestamp plausibility check before pre_adoption', () => {
  it('CORE PIN: a no-integrity record whose OWN timestamp is AFTER the adoption date is a genuine orphan, not pre_adoption', () => {
    setup();
    // The exact live repro from the finding: a record dropped at the sharded
    // path a real record would occupy, with no integrity block, claiming a
    // timestamp well after persist.js gained unconditional integrity-stamping.
    const afterCutoff = new Date(CHAIN_ADOPTION_DATE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const { path } = writePreChainRecord(TEST_ROOT, {
      run_id: 'forged-recent-001',
      timing: { started_at: afterCutoff, finished_at: afterCutoff },
      verification: {
        status: 'accepted', verified_at: afterCutoff,
        provenance_confirmed: true, schema_valid: true, policy_valid: true,
      },
    });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false, 'a record claiming a post-adoption date must fail ok, not be excused as historical');
    assert.equal(result.pre_adoption.length, 0, 'must NOT be silently absorbed into pre_adoption');
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].run_id, 'forged-recent-001');
    assert.ok(!/predates the integrity chain/.test(result.orphans[0].reason),
      `the reason must not repeat the false "predates the chain" claim, got: ${result.orphans[0].reason}`);
    assert.ok(existsSync(path));
  });

  it('the boundary is inclusive: a record dated exactly AT CHAIN_ADOPTION_DATE is a genuine orphan; one millisecond before is pre_adoption', () => {
    setup();
    const atCutoff = CHAIN_ADOPTION_DATE.toISOString();
    const justBefore = new Date(CHAIN_ADOPTION_DATE.getTime() - 1).toISOString();

    writePreChainRecord(TEST_ROOT, {
      run_id: 'boundary-at-cutoff',
      timing: { started_at: atCutoff, finished_at: atCutoff },
      verification: {
        status: 'accepted', verified_at: atCutoff,
        provenance_confirmed: true, schema_valid: true, policy_valid: true,
      },
    });
    writePreChainRecord(TEST_ROOT, {
      run_id: 'boundary-just-before',
      timing: { started_at: justBefore, finished_at: justBefore },
      verification: {
        status: 'accepted', verified_at: justBefore,
        provenance_confirmed: true, schema_valid: true, policy_valid: true,
      },
    });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.orphans.length, 1, `expected exactly the at-cutoff record as orphan, got ${JSON.stringify(result.orphans)}`);
    assert.equal(result.orphans[0].run_id, 'boundary-at-cutoff');
    assert.equal(result.pre_adoption.length, 1, `expected exactly the just-before record as pre_adoption, got ${JSON.stringify(result.pre_adoption)}`);
    assert.equal(result.pre_adoption[0].run_id, 'boundary-just-before');
  });

  it('a no-integrity record with no readable timing/verification timestamp at all is a genuine orphan, not silently excused', () => {
    setup();
    // Not reachable through any real persist path (computeRecordPath itself
    // requires timing.finished_at to shard the file), but collectOrphanRecords
    // must not treat "no timestamp to check" as "check passed" — the burden is
    // on the record to support the pre-adoption claim, not the other way round.
    const path = resolve(TEST_ROOT, 'records', 'dogfood-lab', 'testing-os', '2026', '01', '01', 'run-no-timestamp.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ run_id: 'no-timestamp-001', repo: 'dogfood-lab/testing-os' }) + '\n', 'utf-8');

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.ok, false);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].run_id, 'no-timestamp-001');
    assert.equal(result.pre_adoption.length, 0);
    assert.ok(existsSync(path));
  });

  it('both self-reported fields are consulted: a stale timing.finished_at cannot mask a post-adoption verification.verified_at', () => {
    setup();
    const afterCutoff = new Date(CHAIN_ADOPTION_DATE.getTime() + 1000).toISOString();
    // timing.finished_at is left at buildRecord's default (2026-03-19, safely
    // pre-cutoff) — only verification.verified_at is forged forward.
    writePreChainRecord(TEST_ROOT, {
      run_id: 'mixed-timestamps-001',
      verification: {
        status: 'accepted', verified_at: afterCutoff,
        provenance_confirmed: true, schema_valid: true, policy_valid: true,
      },
    });

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });

    assert.equal(result.orphans.length, 1, `expected the mixed-timestamp record to be a genuine orphan, got ${JSON.stringify(result)}`);
    assert.equal(result.orphans[0].run_id, 'mixed-timestamps-001');
    assert.equal(result.pre_adoption.length, 0);
  });

  it('the real 53 historical pre-chain records are all dated more than a month before CHAIN_ADOPTION_DATE (documents the fixed margin the constant relies on)', () => {
    // This is a sanity check on the CONSTANT, not on collectOrphanRecords —
    // it pins that CHAIN_ADOPTION_DATE (2026-06-21) sits safely after every
    // real pre-chain record's own timestamp, so the cross-check added by this
    // fix cannot flip any of the real repo's 53 genuine historical records
    // into orphans. See this test file's own manual real-repo verification in
    // the wave-14 amend output for the live verifyChain(realRepoRoot) count.
    const lastKnownRealPreChainRecordDate = new Date('2026-05-26T04:47:25Z');
    assert.ok(
      lastKnownRealPreChainRecordDate.getTime() < CHAIN_ADOPTION_DATE.getTime(),
      'CHAIN_ADOPTION_DATE must stay after the latest real pre-chain record or this fix would start failing real history'
    );
  });
});
