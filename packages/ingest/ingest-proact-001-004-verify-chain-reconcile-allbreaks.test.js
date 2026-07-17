/**
 * ingest-proact-001-004-verify-chain-reconcile-allbreaks.test.js
 *
 * Two Stage-C humanization hardenings of verifyChain, in the same file because
 * they touch the same module and the same agent integrates them:
 *
 * INGEST-PROACT-001 — orphan reconciliation (collectOrphans).
 *   The persist boundary (write record file → append ledger line) is not a
 *   single atomic step. A crash BETWEEN the two leaves an ORPHAN: a record file
 *   on disk whose seq/run_id never made it into the ledger. The plain chain-walk
 *   only verifies entries the ledger KNOWS about, so an orphan is invisible — the
 *   audit passes while a real record silently exists outside the tamper-evident
 *   chain. Fix: `verifyChain(root, { collectOrphans: true })` walks records/ and
 *   flags any record whose integrity.run_id/seq is absent from the ledger.
 *
 * INGEST-PROACT-004 — collect ALL independent breaks (collectAllBreaks).
 *   The default stops at the FIRST break (correct for the CI gate — fail fast).
 *   But an operator triaging corruption wants the FULL scope in one pass. For the
 *   per-record-independent break classes (digest-mismatch, missing-file) the
 *   walk can continue past a break and collect them all. Fix:
 *   `verifyChain(root, { collectAllBreaks: true })` returns a `breaks[]` array
 *   with every independent break; the default still returns the first in `break`.
 *
 * Invariants:
 *   - an orphan record (on disk, absent from the ledger) is reported by
 *     collectOrphans, where the plain chain-walk passes ok.
 *   - with two independent breaks (two tampered records), collectAllBreaks
 *     reports BOTH; the default reports only the first.
 *   - a clean chain reports zero orphans and zero breaks under both options.
 *
 * F-d4bcf5d0 (wave 10, HIGH) hardens collectOrphanRecords' membership check.
 * Pre-fix it indexed the ledger by run_id AND by path, treating a disk record
 * as accounted-for if EITHER matched. That fallback is unsound for this
 * codebase's own data model: a single run_id can legitimately own TWO on-disk
 * records at TWO different paths (records/_rejected/... AND records/... — the
 * accepted-after-a-prior-rejection resubmission flow F-0f9e4077/F-4036ae25/
 * F-f8952a50 build and test), each needing its OWN ledger line. Once ANY
 * entry for a run_id was ledgered, the fallback silently treated EVERY LATER
 * record sharing that run_id as accounted for too — including one at a
 * genuinely un-ledgered path, exactly the torn-write shape this pass exists
 * to catch. Fixed by dropping the run_id fallback and relying on path
 * identity alone (every ledger line carries an exact `path` field — see
 * lib/chain-manifest.js). See the 'shared run_id, different paths' test in
 * the INGEST-PROACT-001 describe block below for the regression proof.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync,
} from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecord } from './persist.js';
import { verifyChain } from './verify-chain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__proact_001_004_test__');

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0', policy_version: '1.0.0', run_id: 'chain-001',
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

describe('INGEST-PROACT-001 — orphan reconciliation', () => {
  it('flags a record on disk that is absent from the ledger (plain walk passes)', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'rec-a' }), TEST_ROOT);
    const { path: pB } = writeRecord(buildRecord({ run_id: 'rec-b' }), TEST_ROOT);

    // Simulate a torn persist: the record file landed, but the ledger append
    // never happened. We reproduce the orphan by writing a third record then
    // truncating the ledger back to two lines, leaving rec-c's FILE behind.
    const { path: pC } = writeRecord(buildRecord({ run_id: 'rec-c' }), TEST_ROOT);
    const manifestPath = resolve(TEST_ROOT, 'indexes', 'integrity', 'chain.jsonl');
    const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);
    writeFileSync(manifestPath, lines.slice(0, 2).join('\n') + '\n', 'utf-8');

    // The plain chain-walk only knows the two ledgered entries — it PASSES,
    // blind to the orphan rec-c file.
    const plain = verifyChain(TEST_ROOT);
    assert.equal(plain.ok, true, 'plain walk is blind to the orphan and passes');
    assert.equal(plain.count, 2);

    // Reconciliation DETECTS the orphan.
    const reconciled = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(reconciled.ok, false, 'reconciliation must fail on an orphan');
    assert.ok(Array.isArray(reconciled.orphans), 'orphans must be an array');
    assert.equal(reconciled.orphans.length, 1, 'exactly one orphan');
    const orphan = reconciled.orphans[0];
    assert.match(orphan.run_id, /rec-c/, 'the orphan names its run_id');
    assert.ok(orphan.path && orphan.path.includes('rec-c'),
      `the orphan names its file path; got ${JSON.stringify(orphan)}`);
    // The named path actually points at the leftover file.
    assert.ok(readFileSync(resolve(TEST_ROOT, orphan.path), 'utf-8').includes('rec-c'));
    void pB; void pC;
  });

  it('a clean chain reports zero orphans', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'clean-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'clean-b' }), TEST_ROOT);

    const result = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(result.ok, true);
    assert.equal(result.orphans.length, 0, 'no orphans on a clean chain');
  });

  it('shared run_id, different paths: a torn accepted-record write behind an already-ledgered rejected record for the SAME run_id is still an orphan', () => {
    // F-d4bcf5d0: the exact proven scenario. A single run_id legitimately owns
    // TWO on-disk records at TWO different paths — a prior rejection at
    // records/_rejected/..., then a corrected, accepted resubmission at
    // records/... — each with its OWN ledger line (the
    // F-0f9e4077/F-4036ae25/F-f8952a50 resubmission flow). Simulate a crash in
    // the torn window between the SECOND record's write and its ledger append:
    // the accepted record's FILE lands, but its line never makes it into
    // chain.jsonl, while the FIRST (rejected) record's ledger line for the
    // SAME run_id is still present and correct.
    setup();
    const RUN_ID = 'torn-after-rejected';
    writeRecord(buildRecord({
      run_id: RUN_ID,
      verification: {
        status: 'rejected', verified_at: '2026-03-19T15:45:13Z',
        provenance_confirmed: false, schema_valid: true, policy_valid: false,
        rejection_reasons: ['schema: /unexpected_field must NOT be present'],
      },
    }), TEST_ROOT);
    const { path: acceptedPath } = writeRecord(buildRecord({ run_id: RUN_ID }), TEST_ROOT);

    const manifestPath = resolve(TEST_ROOT, 'indexes', 'integrity', 'chain.jsonl');
    const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2, 'precondition: one ledger line per record, same run_id');

    // Drop ONLY the accepted record's ledger line (seq 1), leaving its FILE
    // on disk — the torn-write window this reconciliation pass exists to
    // catch. The rejected record's line (seq 0, SAME run_id) survives intact.
    writeFileSync(manifestPath, lines.slice(0, 1).join('\n') + '\n', 'utf-8');

    // Pre-fix: the run_id-only fallback saw RUN_ID in the ledger (via the
    // surviving rejected-record entry) and treated the accepted record as
    // accounted for — a FALSE CLEAN BILL OF HEALTH. Post-fix: path identity
    // alone decides, so the un-ledgered accepted record is caught.
    const reconciled = verifyChain(TEST_ROOT, { collectOrphans: true });
    assert.equal(reconciled.ok, false,
      'a torn accepted-record write must be caught even though an EARLIER record for the same run_id is ledgered');
    assert.equal(reconciled.orphans.length, 1, 'exactly one orphan — the accepted record, not the rejected one');
    const orphan = reconciled.orphans[0];
    assert.equal(orphan.run_id, RUN_ID);
    const expectedRelPath = relative(TEST_ROOT, acceptedPath).split(sep).join('/');
    assert.equal(orphan.path, expectedRelPath);
    assert.ok(!orphan.path.includes('_rejected'),
      'the flagged orphan must be the ACCEPTED record, not the still-correctly-ledgered rejected one');
  });
});

describe('INGEST-PROACT-004 — collect all independent breaks', () => {
  function tamper(path) {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    obj.notes = `tampered ${Math.random()}`;
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  }

  it('default stops at the first break; collectAllBreaks reports both', () => {
    setup();
    const { path: p0 } = writeRecord(buildRecord({ run_id: 'tA' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'tB' }), TEST_ROOT);
    const { path: p2 } = writeRecord(buildRecord({ run_id: 'tC' }), TEST_ROOT);

    // Two INDEPENDENT digest-mismatch breaks (seq 0 and seq 2). These are
    // per-record-independent: each record's digest is recomputed on its own, so
    // continuing past seq 0 still detects seq 2.
    tamper(p0);
    tamper(p2);

    const dflt = verifyChain(TEST_ROOT);
    assert.equal(dflt.ok, false);
    assert.equal(dflt.break.seq, 0, 'default fails at the first break (CI gate semantics)');
    assert.equal(dflt.breaks, undefined, 'default does not populate breaks[]');

    const all = verifyChain(TEST_ROOT, { collectAllBreaks: true });
    assert.equal(all.ok, false);
    assert.ok(Array.isArray(all.breaks), 'collectAllBreaks returns a breaks array');
    assert.equal(all.breaks.length, 2, `expected both breaks; got ${JSON.stringify(all.breaks)}`);
    const seqs = all.breaks.map(b => b.seq).sort();
    assert.deepEqual(seqs, [0, 2], 'both independent breaks reported');
    // `break` (singular) still carries the first for back-compat.
    assert.equal(all.break.seq, 0);
  });

  it('collectAllBreaks on a clean chain reports zero breaks and ok', () => {
    setup();
    writeRecord(buildRecord({ run_id: 'ok-a' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'ok-b' }), TEST_ROOT);

    const all = verifyChain(TEST_ROOT, { collectAllBreaks: true });
    assert.equal(all.ok, true);
    assert.equal(all.breaks.length, 0);
    assert.equal(all.break, null);
  });

  it('collectAllBreaks also collects independent missing-file breaks', () => {
    setup();
    const { path: p0 } = writeRecord(buildRecord({ run_id: 'mA' }), TEST_ROOT);
    writeRecord(buildRecord({ run_id: 'mB' }), TEST_ROOT);
    const { path: p2 } = writeRecord(buildRecord({ run_id: 'mC' }), TEST_ROOT);

    rmSync(p0, { force: true });
    rmSync(p2, { force: true });

    const all = verifyChain(TEST_ROOT, { collectAllBreaks: true });
    assert.equal(all.ok, false);
    assert.equal(all.breaks.length, 2, 'both missing-file breaks reported');
    void cpSync;
  });
});
