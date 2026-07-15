/**
 * f-bbbe2e1f-unsafe-repo-segment-write-path.test.js
 *
 * F-bbbe2e1f (MEDIUM) — F-a37d36f5 (wave 2) wrapped writeRecord()'s FIRST
 * computeRecordPath() call — inside the premature isDuplicate() probe — in a
 * try/catch, so a computeRecordPath() throw there is treated as "not a
 * duplicate" and control falls through to validateRecord()'s authoritative
 * schema gate. But computeRecordPath() is called a SECOND time in the same
 * function, three lines after validateRecord(), and that second call was
 * left completely unguarded.
 *
 * The gap: computeRecordPath()'s isUnsafeSegment check (lib/unsafe-segment.js)
 * rejects an embedded `..` or a lone `.` path segment, but the record
 * schema's own `repo` pattern (`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`) is a
 * strict SUPERSET of that — it permits `../etc` (".." and "etc" both satisfy
 * `[a-zA-Z0-9_.-]+`). So a record whose repo is `../etc` sails cleanly
 * through validateRecord() (proven directly below, independent of
 * writeRecord) and then hits the SECOND, unguarded computeRecordPath() call,
 * which throws a bare, unclassified `Error: unsafe repo segment: ../etc` —
 * exactly the shape F-a37d36f5 was filed to eliminate, reached through a gap
 * the fix did not close.
 *
 * This is the ONE shape the existing F-a37d36f5 regression coverage
 * (f-a37d36f5-pre-verify-duplicate-throw.test.js) does not exercise: that
 * suite's malformed-repo case uses `repo: 'a/b/c'` (3 segments), which the
 * record schema rejects on its OWN slash-count pattern — so validateRecord()
 * throws the intended classified RecordValidationError before line 177 is
 * ever reached, and the isUnsafeSegment backstop never fires. `../etc` is
 * schema-VALID, so it reaches computeRecordPath()'s second call site instead.
 *
 * The fix: persist.js now wraps the second computeRecordPath() call and
 * re-throws a classified UnsafeRecordPathError (`.code ===
 * 'UNSAFE_RECORD_PATH'`) instead of letting the bare Error escape. Nothing
 * below that call site has touched the filesystem (mkdirSync/openSync/
 * writeFileSync all come after), so this remains fail-closed with no partial
 * write either way — only the error's classification changed.
 *
 * Deletion/emptiness proof: revert the try/catch around the second
 * computeRecordPath() call in persist.js's writeRecord() and the tests below
 * go red — the thrown/rejected error reverts to a bare Error with no `.code`
 * and `e.constructor.name === 'Error'`, failing the `instanceof
 * UnsafeRecordPathError` assertions.
 *
 * F-4acd28d8 (wave 6) follow-up: classifying the error was necessary but not
 * sufficient — nothing in run.js branched on `.code`, so `ingest()` still let
 * UnsafeRecordPathError escape uncaught to the CLI's outer catch, which
 * mislabeled it failed_stage:'cli_parse_payload' and exited 2 ("operator
 * error") for content that is squarely submission-bad. `ingest()` now catches
 * UnsafeRecordPathError itself and returns a clean rejected result (nothing
 * written — there IS no safe path) instead of throwing, so the CLI's ordinary
 * accepted/rejected exit-code logic (1, not 2) applies without a special case.
 * The end-to-end test below is updated accordingly — it now asserts on
 * `ingest()`'s RETURN, not a throw. The two `writeRecord()`-direct tests are
 * UNCHANGED: the low-level persist function still throws a classified
 * UnsafeRecordPathError when called directly; only the orchestration layer
 * (`ingest()`) learned to catch it.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest } from './run.js';
import { writeRecord, UnsafeRecordPathError } from './persist.js';
import { validateRecord } from './validate-record.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(__dirname, '../verify/fixtures');
const TEST_ROOT = resolve(__dirname, '.test-root-f-bbbe2e1f');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

function setupTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  cpSync(resolve(REPO_ROOT, 'policies'), resolve(TEST_ROOT, 'policies'), { recursive: true });
  cpSync(resolve(REPO_ROOT, 'packages/schemas/src/json'), resolve(TEST_ROOT, 'schemas'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** A fully schema-valid record whose repo is schema-valid but isUnsafeSegment-unsafe. */
function unsafeSegmentRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'f-bbbe2e1f-write-direct',
    repo: '../etc',
    ref: { commit_sha: 'a'.repeat(40) },
    source: {
      provider: 'github',
      workflow: 'x.yml',
      provider_run_id: '1',
      run_url: 'https://github.com/mcp-tool-shop-org/dogfood-labs/actions/runs/1'
    },
    timing: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z' },
    scenario_results: [
      {
        scenario_id: 'probe',
        product_surface: 'cli',
        execution_mode: 'bot',
        verdict: 'pass',
        step_results: [{ step_id: 'probe-step', status: 'pass' }]
      }
    ],
    overall_verdict: { proposed: 'pass', verified: 'pass', downgraded: false },
    verification: {
      status: 'accepted',
      verified_at: '2026-01-01T00:00:02Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true
    },
    ...overrides
  };
}

describe('F-bbbe2e1f: writeRecord() classifies its second, post-validation computeRecordPath() failure', () => {
  it('PREMISE: validateRecord() alone accepts repo: "../etc" — the record schema pattern permits it', () => {
    // Nails down empirically (not just asserted in prose) that this class of
    // input is NOT caught by the schema gate — the record schema's repo
    // pattern is a strict superset of what isUnsafeSegment allows.
    assert.doesNotThrow(() => validateRecord(unsafeSegmentRecord()));
  });

  it('a direct writeRecord() call with repo: "../etc" throws a classified UnsafeRecordPathError, not a bare Error', () => {
    setupTestRoot();
    const record = unsafeSegmentRecord();

    assert.throws(
      () => writeRecord(record, TEST_ROOT),
      (e) => {
        assert.ok(e instanceof UnsafeRecordPathError,
          `expected UnsafeRecordPathError, got ${e.constructor.name}: ${e.message}`);
        assert.equal(e.code, 'UNSAFE_RECORD_PATH');
        assert.equal(e.repo, '../etc');
        assert.equal(e.runId, 'f-bbbe2e1f-write-direct');
        // The original computeRecordPath message must survive as the cause,
        // not be swallowed — an operator debugging this still sees exactly
        // which guard fired.
        assert.ok(e.cause instanceof Error);
        assert.match(e.cause.message, /unsafe repo segment/);
        return true;
      }
    );
  });

  it('end-to-end through ingest(): a schema-valid submission with repo: "../etc" is cleanly rejected (F-4acd28d8), not thrown', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f-bbbe2e1f-end-to-end';
    // Leaving source.run_url pointed at pilot0's original repo (mismatched
    // against repo:'../etc') reproduces the finding's own end-to-end proof:
    // verify() computes a clean `repo:mismatch` rejection reason (status:
    // 'rejected'), schemaResult.valid stays TRUE (the submission schema's
    // repo pattern also permits '../etc'), so _skipPersist is never set and
    // the record reaches writeRecord() for real.
    submission.repo = '../etc';

    // Deletion/emptiness proof (F-4acd28d8): remove the UnsafeRecordPathError
    // catch around writeRecord() in run.js's ingest() and this call rejects
    // instead of resolving — the promise assertions below go red.
    const result = await ingest(submission, { repoRoot: TEST_ROOT, provenance: stubProvenance });

    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.equal(result.duplicate, false);
    assert.equal(result.record.verification.status, 'rejected');

    const reasons = result.record.verification.rejection_reasons;
    // The pre-existing repo:mismatch reason (computed by verify(), BEFORE
    // writeRecord ever ran) must survive untouched.
    assert.ok(reasons.some(r => r.startsWith('repo:mismatch:')),
      `expected the pre-existing repo:mismatch reason to survive, got: ${JSON.stringify(reasons)}`);
    // Plus the new reason naming the actual persist-time failure.
    assert.ok(reasons.some(r => r.startsWith('unsafe-record-path:')),
      `expected an 'unsafe-record-path:' reason, got: ${JSON.stringify(reasons)}`);
  });

  it('end-to-end through ingest(): an otherwise-ACCEPTED submission with repo: "../etc" is downgraded to rejected, not thrown', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f-bbbe2e1f-end-to-end-accepted';
    // Point run_url at the SAME unsafe repo so verify()'s repo:mismatch guard
    // does not fire — this submission has NO other reason to reject, so
    // verify() would otherwise accept it. Proves the downgrade path (not just
    // the "reasons already existed" path exercised above).
    submission.repo = '../etc';
    submission.source.run_url = 'https://github.com/../etc/actions/runs/9123456789';

    const result = await ingest(submission, { repoRoot: TEST_ROOT, provenance: stubProvenance });

    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.equal(result.record.verification.status, 'rejected',
      'an accepted verdict must never survive an unwritable record');
    assert.equal(result.record.overall_verdict.verified, 'fail');
    assert.equal(result.record.overall_verdict.downgraded, true);
    assert.ok(
      result.record.overall_verdict.downgrade_reasons?.includes('record path could not be safely computed'),
      `expected a downgrade_reasons entry naming the path failure, got: ${JSON.stringify(result.record.overall_verdict.downgrade_reasons)}`
    );
    assert.ok(
      result.record.verification.rejection_reasons.some(r => r.startsWith('unsafe-record-path:')),
      `expected an 'unsafe-record-path:' reason, got: ${JSON.stringify(result.record.verification.rejection_reasons)}`
    );
  });

  it('GREEN: an ordinary well-formed record is unaffected (no false positive)', () => {
    setupTestRoot();
    const record = unsafeSegmentRecord({ repo: 'mcp-tool-shop-org/dogfood-labs', run_id: 'f-bbbe2e1f-green-path' });

    const result = writeRecord(record, TEST_ROOT);
    assert.equal(result.written, true);
  });
});
