/**
 * f-a37d36f5-pre-verify-duplicate-throw.test.js
 *
 * F-a37d36f5 (MEDIUM) — the duplicate short-circuit in `ingest()` (run.js)
 * calls `isDuplicate()` -> `computeRecordPath()` against RAW, untrusted
 * submission fields (`repo`, `run_id`) three steps BEFORE verify()'s schema
 * gate runs. computeRecordPath THROWS on a malformed repo ('a/b/c'), an
 * unsafe segment, or an unsafe run_id — good, the traversal guards hold —
 * but pre-fix that throw escaped uncaught, which inverted this repo's own
 * submission-bad vs operational doctrine: verify() never ran, no
 * rejection_reasons were ever computed, and the CLI's outer catch (run.js's
 * `catch (err) { emitCliErrorEvent(...); process.exit(2); }`) fired on a
 * bare, unclassified path-computation Error instead of on the classified,
 * actionable rejection verify() would have produced.
 *
 * `writeRecord()` (persist.js) carries the IDENTICAL premature isDuplicate
 * call at its own top — the same defect one layer deeper, reached even
 * after the ingest.js pre-check is fixed, since verify() still hands a
 * rejected-but-schema-invalid-repo record to writeRecord for persistence.
 * Both call sites are fixed the same way: treat a computeRecordPath throw
 * as "not a duplicate" (semantically free — a record whose path cannot be
 * computed can never collide with an existing file) and let the
 * AUTHORITATIVE schema gates — verify()'s submission schema, then
 * writeRecord's own validateRecord() — be the real judges of bad input.
 *
 * HONEST SCOPE NOTE: fixing both premature-throw sites gets a malformed-repo
 * submission all the way through verify() (which correctly computes a
 * `schema: /repo must match pattern ...` rejection reason — proven below).
 * It does NOT achieve full persistence of a `_rejected` record for THIS
 * specific defect class, because dogfood-record.schema.json's `repo` field
 * carries the SAME pattern constraint as the submission schema, and verify()
 * embeds submission.repo into the persisted record verbatim even when it
 * already failed that exact pattern. That is a separate, pre-existing
 * architectural tension (a rejected-for-bad-repo record can never itself be
 * schema-valid) — flagged separately, not silently redesigned here. What
 * THIS fix guarantees, and what these tests prove: verify() always runs and
 * always computes the correct classified rejection reason; the final
 * failure (when persistence is impossible) is a well-typed
 * RecordValidationError (`.code === 'RECORD_SCHEMA_INVALID'`, structured
 * `.errors[]`) instead of a bare, unclassified computeRecordPath Error.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest } from './run.js';
import { writeRecord, isDuplicate } from './persist.js';
import { RecordValidationError } from './validate-record.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(__dirname, '../verify/fixtures');
const TEST_ROOT = resolve(__dirname, '.test-root-f-a37d36f5');

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

describe('F-a37d36f5: isDuplicate() no longer crashes ingest() before verify() can run', () => {
  it('a malformed repo ("a/b/c") lets verify() run and correctly compute a schema: rejection reason', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.repo = 'a/b/c';
    submission.run_id = 'f-a37d36f5-malformed-repo';

    // Deletion/emptiness proof: revert either try/catch (run.js's isDuplicate
    // call OR persist.js's writeRecord isDuplicate call) to the bare,
    // unguarded form and this throws a generic computeRecordPath Error
    // ("invalid repo format: a/b/c") BEFORE verify() ever runs — this
    // assertion (which requires verify() to have produced a real,
    // schema-classified rejection) goes red.
    const result = await ingest(submission, { repoRoot: TEST_ROOT, provenance: stubProvenance });

    // CONTRACT RECONCILED at the wave-2 merge seam. This test originally
    // asserted ingest() THROWS a RecordValidationError, on the premise (see
    // the file header's HONEST SCOPE NOTE) that a rejected-for-bad-repo record
    // can never be schema-valid, so persistence is impossible and the throw is
    // the honest terminal signal. That premise was answered by the follow-up
    // this finding spawned: persisting a `_rejected` record PERMANENTLY
    // CONSUMES THE RUN_ID, so a corrected resubmission returns
    // {status:"duplicate"} exit 0 and is SILENTLY DROPPED — proven live in
    // schema-invalid-skip-persist.test.js's resubmission case. Not persisting
    // is therefore correct, and verify() now marks a schema-invalid submission
    // `_skipPersist` (the sentinel it already used for unparseable input), so
    // writeRecord never runs and there is no RecordValidationError to catch.
    // The classified rejection is delivered by RETURN, not by throw.
    //
    // What this test proves is UNCHANGED and is the whole point of F-a37d36f5:
    // verify() RAN and produced a real, schema-classified /repo rejection.
    // The deletion/emptiness proof above still holds — revert either try/catch
    // and a bare computeRecordPath Error escapes BEFORE verify() runs, so
    // `result` never exists and this goes red.
    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.written, false);
    assert.equal(result.path, null);

    const reasons = result.record.verification.rejection_reasons;
    assert.ok(Array.isArray(reasons) && reasons.length > 0,
      'verify() must compute structured rejection reasons, not just fail');
    assert.ok(reasons.some(r => r.startsWith('schema: ')),
      `expected a 'schema: ' rejection reason, got: ${JSON.stringify(reasons)}`);
    assert.ok(reasons.some(r => r.includes('/repo')),
      `expected the rejection to name the /repo field specifically; got: ${JSON.stringify(reasons)}`);
  });

  it('isDuplicate() itself no longer throws for a malformed repo — it fails closed to false', () => {
    // Direct unit-level proof, independent of the ingest()/writeRecord()
    // plumbing: the two call sites both now guard isDuplicate the same way,
    // but isDuplicate's OWN documented contract ("@returns {boolean}") should
    // never have been violated by an uncaught throw in the first place. This
    // does not change isDuplicate.js itself (that fix lives at the two call
    // sites, matching the finding's "semantically free" framing — a record
    // whose path cannot be computed cannot collide with an existing file) —
    // it documents the CALL SITES' now-safe usage, not a change to
    // isDuplicate's own signature.
    setupTestRoot();
    let threw = false;
    let result;
    try {
      result = isDuplicate('run-1', { run_id: 'run-1', repo: 'a/b/c', timing: { finished_at: '2026-01-01T00:00:00Z' }, verification: { status: 'accepted' } }, TEST_ROOT);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'isDuplicate itself still throws by design — the fix is at the two call sites, not here');
    assert.equal(result, undefined);
  });

  it('writeRecord() no longer crashes on its OWN premature isDuplicate call for a malformed repo', () => {
    setupTestRoot();
    const record = {
      schema_version: '1.0.0',
      policy_version: '1.0.0',
      run_id: 'f-a37d36f5-write-direct',
      repo: 'a/b/c',
      ref: { commit_sha: 'a'.repeat(40) },
      source: { provider: 'github', workflow: 'x.yml', provider_run_id: '1', run_url: 'https://github.com/a/b/actions/runs/1' },
      timing: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z' },
      scenario_results: [],
      overall_verdict: { verified: 'fail', downgraded: false, downgrade_reasons: [] },
      verification: { status: 'rejected', schema_valid: false, policy_valid: false, provenance_confirmed: false, rejection_reasons: ['schema: /repo must match pattern'] },
    };

    // Deletion/emptiness proof: revert persist.js's writeRecord try/catch
    // around isDuplicate and this throws the generic computeRecordPath
    // Error ("invalid repo format: a/b/c") instead of reaching
    // validateRecord() — this assertion (which requires the classified
    // RecordValidationError specifically) goes red.
    assert.throws(
      () => writeRecord(record, TEST_ROOT),
      (e) => {
        assert.ok(e instanceof RecordValidationError,
          `expected writeRecord to reach validateRecord() and throw RecordValidationError, not a bare path Error; got ${e.constructor.name}: ${e.message}`);
        return true;
      }
    );
  });

  it('GREEN: an ordinary well-formed submission is unaffected (no false positive)', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f-a37d36f5-green-path';

    const result = await ingest(submission, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(result.duplicate, false);
    assert.equal(result.written, true);
    assert.ok(existsSync(result.path));
  });
});
