import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, mkdirSync, rmSync,
  readdirSync, copyFileSync, writeFileSync, openSync, closeSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest } from './run.js';
import { computeRecordPath, writeRecord } from './persist.js';
import { rebuildIndexes } from './rebuild-indexes.js';
import { validateRecord, RecordValidationError } from './validate-record.js';
import { stubProvenance, rejectingProvenance } from '@dogfood-lab/verify/validators/provenance.js';

/**
 * Build a fully-formed record that satisfies dogfood-record.schema.json.
 * Tests that need a near-valid record start here and mutate one field.
 */
function buildValidRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'persist-valid-001',
    repo: 'mcp-tool-shop-org/dogfood-labs',
    ref: { commit_sha: 'c5d6c4e0000000000000000000000000deadbeef' },
    source: {
      provider: 'github',
      workflow: 'dogfood.yml',
      provider_run_id: '9123456789',
      run_url: 'https://github.com/mcp-tool-shop-org/dogfood-labs/actions/runs/9123456789'
    },
    timing: {
      started_at: '2026-03-19T15:45:00Z',
      finished_at: '2026-03-19T15:45:12Z'
    },
    scenario_results: [{
      scenario_id: 'sanity',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'one', status: 'pass' }]
    }],
    overall_verdict: { proposed: 'pass', verified: 'pass' },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-19T15:45:13Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true
    },
    ...overrides
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = resolve(__dirname, '__test_root__');
const FIXTURES = resolve(__dirname, '../verify/fixtures');

let pilot0;

function copyDirSync(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

function setupTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  copyDirSync(resolve(REPO_ROOT, 'policies'), resolve(TEST_ROOT, 'policies'));
  // Schemas live in the @dogfood-lab/schemas workspace package now.
  copyDirSync(resolve(REPO_ROOT, 'packages/schemas/src/json'), resolve(TEST_ROOT, 'schemas'));
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });
}

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── Persist Layer ──────────────────────────────────────────────

describe('persist layer', () => {
  it('computes correct accepted path', () => {
    const record = {
      run_id: 'test-run-001',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const path = computeRecordPath(record, '/repo');
    assert.match(path, /records[/\\]mcp-tool-shop-org[/\\]dogfood-labs[/\\]2026[/\\]03[/\\]19[/\\]run-test-run-001\.json/);
    assert.ok(!path.includes('_rejected'));
  });

  it('computes correct rejected path', () => {
    const record = {
      run_id: 'test-run-001',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'rejected' }
    };
    const path = computeRecordPath(record, '/repo');
    assert.match(path, /_rejected[/\\]mcp-tool-shop-org/);
  });

  it('writes record atomically (no temp files left)', () => {
    setupTestRoot();
    const record = buildValidRecord({ run_id: 'atomic-test-001' });
    const { path, written } = writeRecord(record, TEST_ROOT);
    assert.ok(written);
    assert.ok(existsSync(path));
    // No .tmp files should remain
    const dir = dirname(path);
    const files = readdirSync(dir);
    assert.ok(files.every(f => !f.endsWith('.tmp')));
  });
});

// ── Persisted-record schema enforcement (F-246817-001 regression) ─────
//
// Bug: dogfood-record.schema.json was exported as the canonical contract
// for everything written under records/, but no production code path
// validated a record against it before write. The verify package validated
// the SUBMISSION schema only; persist.js wrote whatever the verifier
// returned. The schema's verification.provenance_remediation block has
// `required: [status, remediated_at]` + `additionalProperties: false`,
// so any future patch that touched that block could ship a partially-
// formed remediation block to disk silently.
//
// Fix: wire validateRecord (Ajv compile of dogfood-record.schema.json)
// into writeRecord pre-flight. These tests gate the enforcement.

describe('persisted-record schema enforcement', () => {
  it('rejects a record with a malformed verification.provenance_remediation block (missing remediated_at)', () => {
    setupTestRoot();
    const record = buildValidRecord({ run_id: 'bad-remediation-001' });
    // Partial remediation block — missing the required `remediated_at`.
    // This is exactly the near-miss the audit cited.
    record.verification.provenance_remediation = { status: 'stub_verified' };

    const expectedPath = computeRecordPath(record, TEST_ROOT);
    assert.throws(
      () => writeRecord(record, TEST_ROOT),
      err => {
        assert.ok(err instanceof RecordValidationError, 'must be RecordValidationError');
        assert.equal(err.code, 'RECORD_SCHEMA_INVALID');
        const dump = JSON.stringify(err.errors);
        assert.match(dump, /provenance_remediation|remediated_at/);
        return true;
      }
    );
    // Cleanup verification: NOTHING was written to disk, including no .tmp files.
    assert.ok(!existsSync(expectedPath), 'no record file should exist');
    if (existsSync(dirname(expectedPath))) {
      const files = readdirSync(dirname(expectedPath));
      assert.equal(files.length, 0, 'no temp files should remain in shard dir');
    }
  });

  it('accepts a record with NO provenance_remediation block (the field is optional)', () => {
    setupTestRoot();
    const record = buildValidRecord({ run_id: 'no-remediation-001' });
    // Default buildValidRecord has no provenance_remediation — exercise that path.
    assert.equal(record.verification.provenance_remediation, undefined);
    const { path, written } = writeRecord(record, TEST_ROOT);
    assert.ok(written);
    assert.ok(existsSync(path));
  });

  it('accepts a record with a well-formed provenance_remediation block', () => {
    setupTestRoot();
    const record = buildValidRecord({ run_id: 'good-remediation-001' });
    record.verification.provenance_remediation = {
      status: 'stub_verified',
      remediated_at: '2026-03-19T15:46:00Z',
      note: 'Provenance API was unreachable; stub-verified per policy.'
    };
    const { path, written } = writeRecord(record, TEST_ROOT);
    assert.ok(written);
    assert.ok(existsSync(path));
    // Round-trip the persisted bytes to confirm the remediation block was preserved.
    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(persisted.verification.provenance_remediation.status, 'stub_verified');
    assert.equal(persisted.verification.provenance_remediation.remediated_at, '2026-03-19T15:46:00Z');
  });

  it('validateRecord can be called directly and throws structured errors', () => {
    // Direct unit test of the helper, independent of writeRecord's IO.
    const bad = buildValidRecord();
    delete bad.schema_version; // required field
    assert.throws(
      () => validateRecord(bad),
      err => {
        assert.ok(err instanceof RecordValidationError);
        assert.ok(Array.isArray(err.errors));
        assert.ok(err.errors.length > 0);
        // Each error has the documented shape.
        for (const e of err.errors) {
          assert.equal(typeof e.path, 'string');
          assert.equal(typeof e.message, 'string');
          assert.equal(typeof e.keyword, 'string');
        }
        return true;
      }
    );
  });
});

// ── Full Pipeline ──────────────────────────────────────────────

describe('ingestion pipeline', () => {
  it('1. accepted path: valid dispatch → record in accepted path → indexes updated', async () => {
    setupTestRoot();
    const result = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.written, true);
    assert.equal(result.record.verification.status, 'accepted');
    assert.ok(existsSync(result.path));
    assert.ok(!result.path.includes('_rejected'));

    // Verify indexes were generated
    const latestPath = resolve(TEST_ROOT, 'indexes', 'latest-by-repo.json');
    assert.ok(existsSync(latestPath));
    const latest = JSON.parse(readFileSync(latestPath, 'utf-8'));
    assert.ok(latest['mcp-tool-shop-org/dogfood-labs']);
    assert.ok(latest['mcp-tool-shop-org/dogfood-labs']['cli']);
    assert.equal(latest['mcp-tool-shop-org/dogfood-labs']['cli'].run_id, pilot0.run_id);
    assert.equal(latest['mcp-tool-shop-org/dogfood-labs']['cli'].verified, 'pass');
  });

  it('2. rejected path: failed verification → record in _rejected path', async () => {
    setupTestRoot();
    const result = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: rejectingProvenance
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.written, true);
    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(result.path.includes('_rejected'));
    assert.ok(existsSync(result.path));
  });

  it('3. duplicate dispatch: same run_id twice → second is no-op', async () => {
    setupTestRoot();

    // First ingest
    const first = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });
    assert.equal(first.written, true);
    assert.equal(first.duplicate, false);

    // Second ingest (same run_id)
    const second = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.written, false);
    assert.equal(second.record, null);
  });

  it('4. missing repo policy: accepted with global defaults, not crash', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.repo = 'mcp-tool-shop-org/unknown-repo';
    submission.run_id = 'missing-policy-001';

    const result = await ingest(submission, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    // Should not crash — global policy applies
    assert.equal(result.duplicate, false);
    assert.ok(result.record);
    // May be accepted or rejected depending on global defaults,
    // but must not throw
    assert.ok(['accepted', 'rejected'].includes(result.record.verification.status));
  });

  it('5. missing scenario definition: rejected record, not crash', async () => {
    setupTestRoot();

    // Use a scenario fetcher that returns null for all scenarios
    const emptyFetcher = { async fetch() { return null; } };

    const result = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: emptyFetcher
    });

    assert.equal(result.duplicate, false);
    assert.ok(result.record);
    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(
      result.record.verification.rejection_reasons.some(r => r.includes('scenario-load'))
    );
  });

  it('6. index correctness: latest-by-repo picks newest per repo+surface', async () => {
    setupTestRoot();

    // Ingest first (older)
    const older = structuredClone(pilot0);
    older.run_id = 'older-run';
    older.timing.finished_at = '2026-03-18T10:00:00Z';
    older.timing.started_at = '2026-03-18T09:59:00Z';

    await ingest(older, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    // Ingest second (newer)
    const newer = structuredClone(pilot0);
    newer.run_id = 'newer-run';
    newer.timing.finished_at = '2026-03-19T15:45:12Z';
    newer.timing.started_at = '2026-03-19T15:45:00Z';

    await ingest(newer, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    const latest = JSON.parse(
      readFileSync(resolve(TEST_ROOT, 'indexes', 'latest-by-repo.json'), 'utf-8')
    );
    const entry = latest['mcp-tool-shop-org/dogfood-labs']['cli'];
    assert.equal(entry.run_id, 'newer-run');
  });

  it('7. persisted record is valid JSON', async () => {
    setupTestRoot();
    const result = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    const raw = readFileSync(result.path, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.run_id, pilot0.run_id);
    assert.ok(parsed.verification);
    assert.ok(parsed.overall_verdict.proposed);
    assert.ok(parsed.overall_verdict.verified);
  });

  it('8. indexes include failing and stale arrays', async () => {
    setupTestRoot();

    // Ingest a failing record
    const failing = structuredClone(pilot0);
    failing.run_id = 'failing-run';
    failing.overall_verdict = 'fail';
    failing.scenario_results[0].verdict = 'fail';
    failing.scenario_results[0].step_results[0].status = 'fail';

    await ingest(failing, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    const failingIndex = JSON.parse(
      readFileSync(resolve(TEST_ROOT, 'indexes', 'failing.json'), 'utf-8')
    );
    assert.ok(Array.isArray(failingIndex));
    assert.ok(failingIndex.length > 0);
    assert.equal(failingIndex[0].verified, 'fail');

    const staleIndex = JSON.parse(
      readFileSync(resolve(TEST_ROOT, 'indexes', 'stale.json'), 'utf-8')
    );
    assert.ok(Array.isArray(staleIndex));
  });
});

// ── Provenance Guards (lockdown regression tests) ─────────────

describe('provenance guards', () => {
  it('rejects ingestion when no provenance adapter is provided', async () => {
    setupTestRoot();
    await assert.rejects(
      () => ingest(pilot0, { repoRoot: TEST_ROOT }),
      { message: /Provenance adapter is required/ }
    );
  });

  it('rejects ingestion when provenance is null', async () => {
    setupTestRoot();
    await assert.rejects(
      () => ingest(pilot0, { repoRoot: TEST_ROOT, provenance: null }),
      { message: /Provenance adapter is required/ }
    );
  });

  it('rejects ingestion when provenance has no confirm method', async () => {
    setupTestRoot();
    await assert.rejects(
      () => ingest(pilot0, { repoRoot: TEST_ROOT, provenance: {} }),
      { message: /Provenance adapter is required/ }
    );
  });

  it('accepts ingestion when stubProvenance is explicitly passed', async () => {
    setupTestRoot();
    const result = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.written, true);
  });

  it('rejects ingestion with rejectingProvenance', async () => {
    setupTestRoot();
    const result = await ingest(pilot0, {
      repoRoot: TEST_ROOT,
      provenance: rejectingProvenance
    });
    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(result.record.verification.rejection_reasons.some(
      r => r.includes('provenance')
    ));
  });
});

// ── Null/non-object submission (F-002109-027 regression) ──────

describe('null submission end-to-end', () => {
  it('drives a null submission through ingest without crashing computeRecordPath', async () => {
    setupTestRoot();
    const result = await ingest(null, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.ok(result.record, 'rejection record must be returned');
    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(
      result.record.verification.rejection_reasons.some(r => r.includes('null or not an object')),
      `rejection reason must surface, got: ${JSON.stringify(result.record.verification.rejection_reasons)}`
    );
    // _skipPersist is an internal marker — must not leak past ingest()
    assert.equal(result.record._skipPersist, undefined);
  });

  it('handles non-object input (string) without crashing', async () => {
    setupTestRoot();
    const result = await ingest('not-an-object', {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });
    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.written, false);
  });
});

// ── Index Generator ────────────────────────────────────────────

describe('index generator', () => {
  it('produces empty indexes for empty records dir', () => {
    setupTestRoot();
    const { latestByRepo, failing, stale } = rebuildIndexes(TEST_ROOT);
    assert.deepEqual(latestByRepo, {});
    assert.deepEqual(failing, []);
    assert.deepEqual(stale, []);
  });
});

// ── Corrupted-record surfacing (F-246817-004 regression) ──────
//
// Bug: rebuild-indexes.loadRecord swallowed JSON parse errors and returned
// null. The bad file was silently dropped from the index — operator never
// learned. Same went for records missing run_id.
//
// Fix: surface each problem via the return value (`corrupted`, `skipped`)
// AND log to stderr. The function still does NOT crash on a single bad
// file — the rest of the portfolio must keep building.

describe('rebuild-indexes corrupted-record surfacing (F-246817-004)', () => {
  it('returns the corrupted file in `corrupted` and continues building', () => {
    setupTestRoot();
    // Plant one valid record + one corrupted file under the same shard.
    const record = {
      schema_version: '1.0.0',
      run_id: 'good-001',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' },
      overall_verdict: { proposed: 'pass', verified: 'pass' },
      scenario_results: [{ scenario_id: 's', product_surface: 'cli', verdict: 'pass' }]
    };
    const goodPath = resolve(TEST_ROOT, 'records/mcp-tool-shop-org/dogfood-labs/2026/03/19/run-good-001.json');
    mkdirSync(dirname(goodPath), { recursive: true });
    writeFileSync(goodPath, JSON.stringify(record));
    const badPath = resolve(TEST_ROOT, 'records/mcp-tool-shop-org/dogfood-labs/2026/03/19/run-bad-001.json');
    writeFileSync(badPath, '{ this is not valid json');

    const captured = [];
    const origErr = console.error;
    console.error = (...args) => { captured.push(args.join(' ')); };

    let result;
    try {
      result = rebuildIndexes(TEST_ROOT);
    } finally {
      console.error = origErr;
    }

    assert.ok(Array.isArray(result.corrupted), 'corrupted must be an array');
    assert.equal(result.corrupted.length, 1, 'one corrupted file expected');
    assert.match(result.corrupted[0].path, /run-bad-001\.json$/);
    assert.ok(result.corrupted[0].error, 'corrupted entry must include error message');
    // The good record still made it into latestByRepo.
    assert.ok(result.latestByRepo['mcp-tool-shop-org/dogfood-labs']);
    // Stderr saw the bad file.
    assert.ok(
      captured.some(line => line.includes('[rebuild-indexes]') && line.includes('run-bad-001')),
      `expected stderr log for corrupted file, got: ${JSON.stringify(captured)}`
    );
  });

  it('surfaces records missing run_id via `skipped` array', () => {
    setupTestRoot();
    const record = {
      schema_version: '1.0.0',
      // run_id intentionally missing
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' }
    };
    const path = resolve(TEST_ROOT, 'records/mcp-tool-shop-org/dogfood-labs/2026/03/19/run-noid.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));

    const origErr = console.error;
    console.error = () => {};
    let result;
    try {
      result = rebuildIndexes(TEST_ROOT);
    } finally {
      console.error = origErr;
    }

    assert.ok(Array.isArray(result.skipped));
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /run_id/);
  });
});

// ── ingest stage-transition logging (F-246817-016 regression) ──
//
// Bug: ingest emitted no logs for stage transitions. A submission that got
// rejected before persist left no log line beyond the final stdout JSON.
// Forensic investigation in CI runner logs was impossible.
//
// Fix: emit one structured JSON line per stage transition (NDJSON on stderr),
// tagged `component: "ingest"` and `stage: <name>`, including `submission_id`.

describe('ingest stage-transition logging (F-246817-016)', () => {
  function captureStderr(fn) {
    const captured = [];
    const orig = console.error;
    console.error = (...args) => { captured.push(args.join(' ')); };
    return fn().finally(() => { console.error = orig; }).then(result => ({ result, captured }));
  }

  it('emits dispatch_received, context_loaded, verify_complete, persist_complete, rebuild_indexes_complete for a happy path', async () => {
    setupTestRoot();
    const { result, captured } = await captureStderr(async () =>
      ingest(pilot0, { repoRoot: TEST_ROOT, provenance: stubProvenance })
    );
    assert.ok(result.written);

    const stageLines = captured
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(obj => obj && obj.component === 'ingest');

    const stages = stageLines.map(l => l.stage);
    for (const expected of ['dispatch_received', 'context_loaded', 'verify_complete', 'persist_complete', 'rebuild_indexes_complete']) {
      assert.ok(stages.includes(expected), `missing stage: ${expected} (got ${stages.join(', ')})`);
    }
    // Every line must carry submission_id.
    const dispatch = stageLines.find(l => l.stage === 'dispatch_received');
    assert.equal(dispatch.submission_id, pilot0.run_id);
  });

  it('emits rejected_pre_persist for null submissions', async () => {
    setupTestRoot();
    const { captured } = await captureStderr(async () =>
      ingest(null, { repoRoot: TEST_ROOT, provenance: stubProvenance })
    );
    const stageLines = captured
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(obj => obj && obj.component === 'ingest');
    assert.ok(stageLines.some(l => l.stage === 'rejected_pre_persist'));
  });
});

// ── writeRecord TOCTOU race (F-246817-020 regression) ─────────
//
// Bug: writeRecord checked isDuplicate, then later wrote to the canonical
// path. Two concurrent writers for the same run_id could both pass the check
// (no file yet) and both rename — second silently overwrote first.
//
// Fix: claim the canonical path with `open(path, 'wx')` (exclusive create).
// Loser throws DuplicateRunIdError instead of silently overwriting.
//
// Test strategy: simulating a true cross-process race in-process is brittle.
// We exercise (a) the OS-level open(wx) guard the fix relies on, (b) the
// DuplicateRunIdError shape, and (c) an end-to-end concurrent-promise test
// where two writeRecord calls race on the same canonical path.

import { DuplicateRunIdError } from './persist.js';

describe('writeRecord TOCTOU race (F-246817-020)', () => {
  it('open(wx) is the OS-level primitive the fix depends on', () => {
    setupTestRoot();
    const record = buildValidRecord({ run_id: 'race-os-001' });
    const expectedPath = computeRecordPath(record, TEST_ROOT);
    mkdirSync(dirname(expectedPath), { recursive: true });
    writeFileSync(expectedPath, '{}');
    assert.throws(
      () => {
        const fd = openSync(expectedPath, 'wx');
        closeSync(fd);
      },
      err => err.code === 'EEXIST'
    );
  });

  it('DuplicateRunIdError carries run_id + path + DUPLICATE_RUN_ID code', () => {
    const err = new DuplicateRunIdError('race-meta-001', '/tmp/path.json');
    assert.equal(err.name, 'DuplicateRunIdError');
    assert.equal(err.code, 'DUPLICATE_RUN_ID');
    assert.equal(err.runId, 'race-meta-001');
    assert.equal(err.path, '/tmp/path.json');
  });

  // F-091578-031: behavioral coverage on err.message — pin the actionable-hint
  // sub-pattern, NOT the exact string. Operators reading a CI log need the
  // "this is a duplicate, not a generic write failure" framing to know the
  // action is dedupe (re-mint run_id, drop the second submission, or look for
  // a concurrent writer) rather than a retry. Structural fields (name/code/
  // runId/path) are programmatic; the message is the human channel and the
  // ONLY signal that survives untyped catch blocks. If a future refactor drops
  // "duplicate" / "won the race" / the run_id from the message, this test
  // fails — that's the contract. Mirrors the wave-12 IsolationError gold
  // standard (wave12-observability.test.js:94-97 → assert.match(/--isolate/)).
  it('DuplicateRunIdError message preserves actionable-hint sub-pattern (F-091578-031)', () => {
    const err = new DuplicateRunIdError('race-msg-001', '/tmp/race.json');
    // Sub-pattern survives rewordings of "another writer won the race for X"
    // but fails if the duplicate framing is dropped (e.g. super('error')).
    assert.match(err.message, /run_id|duplicate/i,
      'message must carry "duplicate" framing so operators see action=dedupe, not action=retry');
    // The run_id MUST appear — without it the operator can't trace the offending submission.
    assert.match(err.message, /race-msg-001/,
      'message must carry the run_id so operators can locate the duplicate submission');
  });

  it('two parallel writeRecord calls for the same run_id: one wins, one is duplicate or throws', async () => {
    setupTestRoot();
    const recA = buildValidRecord({ run_id: 'race-parallel-001' });
    const recB = buildValidRecord({ run_id: 'race-parallel-001' });
    // Race them in-process — Node's sync FS calls don't truly interleave,
    // but Promise.allSettled lets us confirm BOTH calls return without
    // silent overwrite.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => writeRecord(recA, TEST_ROOT)),
      Promise.resolve().then(() => writeRecord(recB, TEST_ROOT))
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    // Either: one wrote + one returned written:false (isDuplicate caught it),
    // OR: one wrote + one threw DuplicateRunIdError (lost the open(wx) race).
    // What MUST NOT happen: both report written:true (silent overwrite).
    const writes = fulfilled.filter(r => r.value.written).length;
    assert.equal(writes, 1, `exactly one writer should win, got ${writes}`);
    if (rejected.length > 0) {
      assert.ok(rejected.every(r => r.reason instanceof DuplicateRunIdError),
        'any rejection must be DuplicateRunIdError, never silent overwrite');
    }
  });

  it('writeRecord short-circuits via isDuplicate when canonical exists pre-call', () => {
    setupTestRoot();
    const record = buildValidRecord({ run_id: 'race-precreate-001' });
    const expectedPath = computeRecordPath(record, TEST_ROOT);
    mkdirSync(dirname(expectedPath), { recursive: true });
    writeFileSync(expectedPath, JSON.stringify(record));
    const { written } = writeRecord(record, TEST_ROOT);
    assert.equal(written, false);
  });
});

// ── unsafeSegment over-broad rejection (F-375053-006 regression) ──
//
// Bug: persist.js used `/[.\\/]/` to guard org/repo segments, rejecting ANY
// dot. The submission schema's repo pattern `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`
// allows dots — and GitHub itself permits dotted org/repo names like
// `mcp-tool-shop.github.io` and `repo.io`. A schema-valid, provenance-confirmed
// submission for such a repo crashed inside writeRecord with no rejection
// record persisted. Fix mirrors the narrower load-context.js:37 check that
// blocks `..` and path separators while permitting single dots.

describe('unsafeSegment guard allows legitimate dotted names (F-375053-006)', () => {
  it('writeRecord persists a dotted repo (mcp-tool-shop.github.io/repo.io)', () => {
    setupTestRoot();
    const record = buildValidRecord({
      run_id: 'dotted-repo-001',
      repo: 'mcp-tool-shop.github.io/repo.io'
    });
    const { path, written } = writeRecord(record, TEST_ROOT);
    assert.equal(written, true);
    assert.ok(existsSync(path));
    assert.match(path, /mcp-tool-shop\.github\.io[/\\]repo\.io/);
  });

  it('computeRecordPath builds the expected sharded path for dotted segments', () => {
    const record = {
      run_id: 'dotted-001',
      repo: 'next.js/example.com',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const path = computeRecordPath(record, '/repo');
    assert.match(path, /records[/\\]next\.js[/\\]example\.com[/\\]2026[/\\]03[/\\]19[/\\]run-dotted-001\.json/);
  });

  it('still rejects `..` in either segment (path traversal)', () => {
    const recordOrgTraversal = {
      run_id: 'traversal-001',
      repo: '..test/repo',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    assert.throws(
      () => computeRecordPath(recordOrgTraversal, '/repo'),
      /unsafe repo segment/
    );

    const recordRepoTraversal = {
      run_id: 'traversal-002',
      repo: 'org/foo..bar',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    assert.throws(
      () => computeRecordPath(recordRepoTraversal, '/repo'),
      /unsafe repo segment/
    );
  });

  it('still rejects forward/back slashes inside a segment', () => {
    // NOTE: a literal `/` between org and repo is the splitter — we only
    // care about EXTRA slashes within a segment after the split. Building
    // a record with a backslash inside the repo segment is the cleanest test.
    const record = {
      run_id: 'slash-001',
      repo: 'org/foo\\bar',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    assert.throws(
      () => computeRecordPath(record, '/repo'),
      /unsafe repo segment/
    );
  });
});

// ── Mixed-precision ISO 8601 lex-compare (F-375053-009 regression) ──
//
// Bug: rebuild-indexes used `>` and `<` directly on ISO 8601 strings to
// pick "latest by repo" and "stale by cutoff." Lex-compare on ISO 8601 only
// agrees with chronological order when both strings share identical precision
// and timezone format. `2026-03-19T15:45:12Z` lex-compares AFTER
// `2026-03-19T15:45:12.500Z` because `Z` (0x5A) > `.` (0x2E) — so a
// millisecond-precision later record could be silently dropped from
// latest-by-repo in favor of an earlier second-precision record, and a record
// with no parseable finished_at would never be flagged stale (`undefined < cutoff`
// is false). Fix parses both sides via Date.getTime() and treats NaN as
// oldest/stale.

describe('rebuild-indexes mixed-precision timestamp compare (F-375053-009)', () => {
  function plantRecord(recordsRoot, repo, runId, finishedAt) {
    const [org, name] = repo.split('/');
    const path = resolve(recordsRoot, 'records', org, name, '2026/03/19', `run-${runId}.json`);
    mkdirSync(dirname(path), { recursive: true });
    const record = {
      schema_version: '1.0.0',
      run_id: runId,
      repo,
      timing: { finished_at: finishedAt },
      verification: { status: 'accepted' },
      overall_verdict: { proposed: 'pass', verified: 'pass' },
      scenario_results: [{ scenario_id: 's', product_surface: 'cli', verdict: 'pass' }]
    };
    writeFileSync(path, JSON.stringify(record));
    return path;
  }

  it('latest-by-repo picks the chronologically newer record across mixed precision', () => {
    setupTestRoot();
    const repo = 'mcp-tool-shop-org/mixed-prec';
    // The lex/numeric divergence: at the same nominal second, a millisecond-
    // precision string (`...12.500Z`) is chronologically LATER than the
    // second-precision (`...12Z`), but lex-compare puts `...12Z` higher
    // because `Z` (0x5A) > `.` (0x2E) at the 19th char. So if `older-s` is
    // ingested first and `newer-ms` is ingested second, lex-compare on
    // `finishedAt > existing.finished_at` rejects the newer record (newer
    // lex-compares as less), and latest-by-repo still points at older-s.
    // Numeric compare: 1742399112500 > 1742399112000 → newer-ms wins.
    plantRecord(TEST_ROOT, repo, 'older-s', '2026-03-19T15:45:12Z');
    plantRecord(TEST_ROOT, repo, 'newer-ms', '2026-03-19T15:45:12.500Z');

    const { latestByRepo } = rebuildIndexes(TEST_ROOT);
    const entry = latestByRepo[repo]?.cli;
    assert.ok(entry, 'expected an entry for repo+cli');
    assert.equal(entry.run_id, 'newer-ms', 'numeric compare must pick the chronologically newer record');
  });

  it('stale-detection flags records with unparseable finished_at', () => {
    setupTestRoot();
    const repo = 'mcp-tool-shop-org/no-timing';
    // A record whose finished_at parses to NaN — historically `NaN < cutoff`
    // is false, so the record was silently excluded from stale.json. With
    // the fix it must be flagged stale.
    plantRecord(TEST_ROOT, repo, 'no-time-001', 'not-a-real-timestamp');

    const { stale } = rebuildIndexes(TEST_ROOT);
    const entry = stale.find(s => s.repo === repo && s.surface === 'cli');
    assert.ok(entry, `expected stale entry for ${repo}, got: ${JSON.stringify(stale)}`);
    assert.equal(entry.run_id, 'no-time-001');
    assert.equal(entry.age_days, null, 'unparseable timestamp → null age');
  });
});

