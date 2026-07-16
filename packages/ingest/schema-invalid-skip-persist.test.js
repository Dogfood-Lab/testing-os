/**
 * schema-invalid-skip-persist.test.js
 *
 * A submission that fails the submission schema is data we could not
 * understand — not a verdict about a run. Before this fix every such
 * submission CRASHED the pipeline and persisted nothing, via one of two
 * unrelated guards:
 *
 *   Class A — the field is part of the record's storage PATH (repo, run_id,
 *     timing.finished_at). computeRecordPath's own guards threw a bare
 *     `Error` (no `.code`) from ingest()'s pre-verify duplicate probe, BEFORE
 *     verify() ever ran. `repo: "a/b/c"` is this class.
 *   Class B — the field is not a path component (ref.commit_sha,
 *     source.provider, a scenario verdict, step_id, an empty
 *     scenario_results). verify() copied it verbatim into the record, and
 *     dogfood-record.schema.json carries the same constraint as the
 *     submission schema, so validateRecord threw RecordValidationError at
 *     write time. `repo: "a b/c d"` is this class too — two segments, so the
 *     path guard passes and the charset check lands on the schema instead.
 *
 * Both classes reached the CLI's outer catch as exit 2 "operator error" —
 * the misclassification this fix removes. Ordinary bad input from a
 * submitter is not an internal invariant violation.
 *
 * Contract: a schema-invalid submission is REJECTED, not persisted, and does
 * NOT consume its run_id.
 *
 *   - verify() marks the record `_skipPersist` (the same sentinel it already
 *     used for a null/non-object submission — the same claim: we could not
 *     parse the submission, so there is nothing to file);
 *   - ingest() surfaces `rejected_pre_persist` with the reasons and returns
 *     `{ path: null, written: false }` — no throw, so run.js exits 1
 *     (rejected) rather than 2 (operator error);
 *   - the run_id stays REUSABLE: a corrected resubmission is ACCEPTED.
 *
 * That last point is why persisting a `_rejected` record here would be wrong
 * rather than merely expensive. isDuplicate checks the _rejected path, so a
 * persisted rejection permanently consumes the run_id and the corrected
 * resubmission is silently dropped as a duplicate with exit 0 — the exact
 * V2-CROSS-BO-001 / F-82429f90 pathology, reached from a new direction.
 *
 * The line _skipPersist draws: a submission we could not even PLACE on disk
 * (unfilable — Class A below) never persists and never touches the run_id.
 * A submission we COULD place always persists, rejected or not (see 'the
 * persist-a-verdict doctrine is preserved' below — unconditional, unaffected
 * by the rest of this note). Whether a persisted rejection also PERMANENTLY
 * consumes the run_id is the separate, narrower question persist.js's
 * isRetryableRejection answers per-prefix, via parse-rejection.js's
 * `retryable` flag (F-f8952a50, wave 10): the SHAPE/ADDRESSING subset of
 * submission-bad (schema:, repo:, unsafe-record-path:, steps[<id>]:,
 * policy-config:, submission-contains-verifier-field:,
 * CONTRACT_SCHEMA_TOO_NEW/OLD:) stays reusable for a genuinely corrected
 * resubmission — "we could not even read/place/shape your submission" is not
 * a verdict on what the run actually did. The CONTENT-VERDICT subset
 * (policy:, provenance:) does NOT become retryable: those two prefixes judge
 * the run's own reported content, and letting a resubmission retry past one
 * would let a submitter launder a genuinely-bad run into an accepted one by
 * resubmitting different self-reported content under the same run_id — see
 * the "REGRESSION GUARD" test and 'the persist-a-verdict doctrine is
 * preserved' below, both still pinning that boundary as intentional. An
 * operational fault never reaches this file at all (it throws instead of
 * persisting — F-82429f90). See
 * f-0f9e4077-retry-collision-duplicate-rejection.test.js's 'F-f8952a50'
 * describe block for the positive (now-retryable) shape/addressing proof.
 *
 * F-4036ae25 (wave 6) NARROWED which schema-invalid submissions get
 * `_skipPersist`: only the subset whose repo/run_id/timing.finished_at are
 * THEMSELVES unfilable (Class A above). The 10 cases pinned below are
 * UNCHANGED in observable outcome (still rejected, still nothing written,
 * still a reusable run_id) but for two DIFFERENT reasons depending on class:
 *
 *   - Class A cases still get `_skipPersist` directly from verify() — the
 *     mechanism this file was originally written to pin.
 *   - Class B cases NO LONGER get `_skipPersist` (verify() now considers them
 *     filable by identity) — but dogfood-record.schema.json mirrors the
 *     submission schema's constraints on every field verify() copies verbatim
 *     into the record (ref, source, timing, scenario_results,
 *     overall_verdict.proposed), so writeRecord()'s own validateRecord() gate
 *     independently re-rejects the SAME field and throws RecordValidationError.
 *     `ingest()` now catches that (alongside UnsafeRecordPathError — see
 *     F-4acd28d8) when `record.verification.schema_valid === false`, and
 *     returns the same clean non-throwing rejection shape. Net effect for
 *     these 10 cases: identical to before. The new
 *     'genuinely filable' describe block below is where the fix's actual
 *     value shows up — a schema violation that does NOT propagate into the
 *     record's own checked shape (e.g. an unexpected top-level property,
 *     silently dropped by verify()'s field allowlist) now persists for real.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest, verifyOnly } from './run.js';
import { loadGlobalPolicy, loadRepoPolicy } from './load-context.js';
import { verify } from '@dogfood-lab/verify';
import { stubProvenance, rejectingProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = resolve(__dirname, '__test_root_skip_persist__');
const FIXTURES = resolve(__dirname, '../verify/fixtures');

let pilot0;

function copyDirSync(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, dstPath);
    else copyFileSync(srcPath, dstPath);
  }
}

function setupTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  copyDirSync(resolve(REPO_ROOT, 'policies'), resolve(TEST_ROOT, 'policies'));
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });
}

/** Recursively count regular files under a dir. */
function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(p);
    else n += 1;
  }
  return n;
}

const clone = () => JSON.parse(JSON.stringify(pilot0));

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// Each case fails the SUBMISSION schema on exactly one field. `label` names
// the class only to document which guard used to fire — the contract asserted
// below is identical for both, which is the point of the fix.
const SCHEMA_INVALID_CASES = [
  ['A: repo has three segments', () => {
    const s = clone();
    s.repo = 'a/b/c';
    s.source.run_url = 'https://github.com/a/b/c/actions/runs/9123456789';
    return s;
  }],
  ['A: repo has no slash', () => { const s = clone(); s.repo = 'noslash'; return s; }],
  ['A: run_id has unsafe chars', () => { const s = clone(); s.run_id = 'bad id!'; return s; }],
  ['A: finished_at is not a date', () => { const s = clone(); s.timing.finished_at = 'xyz'; return s; }],
  ['B: repo has spaces', () => { const s = clone(); s.repo = 'a b/c d'; return s; }],
  ['B: commit_sha is not 40 hex', () => { const s = clone(); s.ref.commit_sha = 'nope'; return s; }],
  ['B: provider is not in the enum', () => { const s = clone(); s.source.provider = 'bitbucket'; return s; }],
  ['B: scenario_results is empty', () => { const s = clone(); s.scenario_results = []; return s; }],
  ['B: scenario verdict is not in the enum', () => {
    const s = clone(); s.scenario_results[0].verdict = 'maybe'; return s;
  }],
  ['B: step_id violates its pattern', () => {
    const s = clone(); s.scenario_results[0].step_results[0].step_id = 'BAD_ID'; return s;
  }],
];

describe('schema-invalid submission → rejected, never persisted', () => {
  for (const [label, build] of SCHEMA_INVALID_CASES) {
    it(`${label} → rejected without a throw, nothing written`, async () => {
      setupTestRoot();
      const result = await ingest(build(), {
        repoRoot: TEST_ROOT,
        provenance: stubProvenance
      });

      assert.equal(result.record.verification.status, 'rejected');
      assert.equal(result.written, false);
      assert.equal(result.path, null);
      assert.equal(result.duplicate, false);

      // The submitter gets the actionable signal: which field, which rule.
      assert.ok(
        result.record.verification.rejection_reasons.some(r => r.startsWith('schema: ')),
        `expected a 'schema: ' rejection reason, got: ${JSON.stringify(result.record.verification.rejection_reasons)}`
      );

      // `_skipPersist` is an internal sentinel — it must never survive onto
      // the record the caller sees (ingest deletes it), or it would fail
      // dogfood-record.schema.json's additionalProperties:false if anything
      // downstream ever tried to write it.
      assert.equal('_skipPersist' in result.record, false);

      assert.equal(countFiles(resolve(TEST_ROOT, 'records')), 0);
    });
  }

  it('does not consume the run_id — a corrected resubmission is accepted', async () => {
    setupTestRoot();
    const RUN_ID = 'skip-persist-reuse-001';

    const bad = clone();
    bad.run_id = RUN_ID;
    bad.ref.commit_sha = 'nope';

    const first = await ingest(bad, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(first.record.verification.status, 'rejected');
    assert.equal(first.written, false);

    // Submitter fixes the sha and resubmits the SAME run_id.
    const corrected = clone();
    corrected.run_id = RUN_ID;

    const second = await ingest(corrected, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(second.duplicate, false, 'run_id was poisoned by the rejected submission');
    assert.equal(second.written, true);
    assert.equal(second.record.verification.status, 'accepted');
    assert.ok(existsSync(second.path));
  });

  it('verifyOnly reports would_persist_to=null for an UNFILABLE (Class A) schema-invalid submission', async () => {
    setupTestRoot();
    const bad = clone();
    bad.repo = 'a/b/c'; // computeRecordPath cannot place a 3-segment repo

    const result = await verifyOnly(bad, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.would_persist_to, null);
    assert.equal('_skipPersist' in result.record, false);
    assert.equal(countFiles(resolve(TEST_ROOT, 'records')), 0);
  });

  it('verifyOnly reports a REAL would_persist_to for a FILABLE (Class B) schema-invalid submission (F-4036ae25)', async () => {
    // F-4036ae25 narrowing surfaces a pre-existing asymmetry: verifyOnly()
    // never calls validateRecord() (only computeRecordPath(), directly) — see
    // run.js's verifyOnly(), step 5 — so for a Class B violation it reports
    // where the record WOULD land by identity, even though a real ingest()
    // would find writeRecord()'s validateRecord() gate rejects the SAME
    // field and persists nothing (pinned in the 'genuinely filable' describe
    // block below). would_persist_to is documented as an optimistic preview,
    // not a persistence guarantee; this test makes that asymmetry explicit
    // rather than leaving it as an unproven implication of the fix.
    setupTestRoot();
    const bad = clone();
    bad.ref.commit_sha = 'nope';

    const result = await verifyOnly(bad, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.record.verification.schema_valid, false);
    assert.notEqual(result.would_persist_to, null);
    assert.ok(result.would_persist_to.includes('_rejected'));
    assert.equal('_skipPersist' in result.record, false);
    // verifyOnly NEVER writes, regardless of what it reports would_persist_to.
    assert.equal(countFiles(resolve(TEST_ROOT, 'records')), 0);
  });
});

describe('verify() marks schema-invalid records _skipPersist', () => {
  // F-4036ae25 (wave 6): this used to assert the sentinel for ANY schema
  // failure, using a Class B field (ref.commit_sha — not a path-identity
  // field). That assertion is now WRONG by design: narrowing _skipPersist to
  // only the unfilable subset is the whole point of the fix. The Class A/B
  // split and the full matrix (including the additionalProperties case) is
  // pinned in @dogfood-lab/verify's own verify.test.js, right next to
  // hasFilablePathIdentity(); this block keeps ONE positive + ONE negative
  // case local so this file's own contract (what ingest() sees from verify())
  // stays self-evident without cross-package navigation.
  it('sets the sentinel when the invalid field IS a path-identity field (Class A)', async () => {
    setupTestRoot();
    const bad = clone();
    bad.repo = 'a/b/c'; // computeRecordPath cannot place a 3-segment repo

    const record = await verify(bad, {
      globalPolicy: loadGlobalPolicy(TEST_ROOT),
      repoPolicy: loadRepoPolicy(bad.repo, TEST_ROOT),
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record._skipPersist, true);
    assert.equal(record.verification.status, 'rejected');
    assert.equal(record.verification.schema_valid, false);
  });

  it('does NOT set the sentinel when the invalid field is unrelated to path identity (Class B)', async () => {
    setupTestRoot();
    const bad = clone();
    bad.ref.commit_sha = 'nope'; // repo/run_id/timing.finished_at are all fine

    const record = await verify(bad, {
      globalPolicy: loadGlobalPolicy(TEST_ROOT),
      repoPolicy: loadRepoPolicy(bad.repo, TEST_ROOT),
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record._skipPersist, undefined);
    assert.equal(record.verification.status, 'rejected');
    assert.equal(record.verification.schema_valid, false);
  });

  it('does NOT set the sentinel when the submission schema passes', async () => {
    setupTestRoot();
    const record = await verify(clone(), {
      globalPolicy: loadGlobalPolicy(TEST_ROOT),
      repoPolicy: loadRepoPolicy(pilot0.repo, TEST_ROOT),
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record._skipPersist, undefined);
    assert.equal(record.verification.schema_valid, true);
  });
});

describe('the persist-a-verdict doctrine is preserved', () => {
  // The fix must NOT widen into "no rejection is ever persisted". A submission
  // we UNDERSTOOD and ruled against is a verdict about a real run: it persists
  // regardless of whether a later corrected resubmission goes on to reuse the
  // run_id — and for `provenance:`/`policy:` specifically, it never does (see
  // the "REGRESSION GUARD" test below and F-f8952a50's `retryable: false`
  // split in parse-rejection.js).
  it('a schema-valid submission rejected on provenance still persists to _rejected', async () => {
    setupTestRoot();
    const result = await ingest(clone(), {
      repoRoot: TEST_ROOT,
      provenance: rejectingProvenance
    });

    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.written, true);
    assert.ok(result.path.includes('_rejected'));
    assert.ok(existsSync(result.path));
  });
});

// ── F-4036ae25: genuinely filable schema-invalid submissions persist ──
//
// The one class of schema violation that does NOT propagate into the
// persisted record's OWN checked shape: an unexpected TOP-LEVEL property.
// verify() assembles `persisted` from an explicit field allowlist (run_id,
// repo, ref, source, timing, ci_checks, scenario_results, overall_verdict,
// notes) rather than spreading `submission` wholesale, so an extra property
// is simply never copied — validateRecord() never sees it, and writeRecord()
// succeeds. This is where F-4036ae25's audit-trail promise is actually kept.

describe('a genuinely filable schema-invalid submission persists to _rejected (F-4036ae25)', () => {
  it('an unexpected top-level property is schema-invalid but persists for real', async () => {
    setupTestRoot();
    const bad = clone();
    bad.unexpected_field = 'oops';

    const result = await ingest(bad, { repoRoot: TEST_ROOT, provenance: stubProvenance });

    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.record.verification.schema_valid, false);
    assert.equal(result.written, true,
      'a filable-identity schema violation that does not touch the record shape must persist');
    assert.ok(result.path.includes('_rejected'));
    assert.ok(existsSync(result.path));
    assert.ok(
      result.record.verification.rejection_reasons.some(r => r.startsWith('schema: ')),
      `expected a 'schema: ' rejection reason, got: ${JSON.stringify(result.record.verification.rejection_reasons)}`
    );
    // The extra property must never leak into the persisted record — it would
    // fail dogfood-record.schema.json's own additionalProperties:false.
    const onDisk = JSON.parse(readFileSync(result.path, 'utf-8'));
    assert.equal('unexpected_field' in onDisk, false);
  });

  it('a corrected resubmission after a persisted schema-class rejection is NOT blocked (isDuplicate retry carve-out)', async () => {
    setupTestRoot();
    const RUN_ID = 'f-4036ae25-retry-schema-class';

    const bad = clone();
    bad.run_id = RUN_ID;
    bad.unexpected_field = 'oops';

    const first = await ingest(bad, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(first.written, true, 'precondition: the bad attempt must actually persist');
    assert.equal(first.record.verification.status, 'rejected');

    const corrected = clone();
    corrected.run_id = RUN_ID;

    const second = await ingest(corrected, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(second.duplicate, false,
      'a persisted schema-class rejection must not poison the run_id for a corrected retry');
    assert.equal(second.written, true);
    assert.equal(second.record.verification.status, 'accepted');
    assert.ok(existsSync(second.path));
    // Both records survive: the first attempt's rejection evidence is NOT
    // overwritten by the second attempt's acceptance (different paths).
    assert.ok(existsSync(first.path));
  });

  // F-f8952a50 (wave 10): this test's ORIGINAL title/framing ("a resubmission
  // after a persisted NON-schema rejection is STILL blocked") predates the
  // per-prefix `retryable` split parse-rejection.js now carries. Re-examined
  // for this wave, not just left alone: `provenance:` is class
  // 'submission-bad' (same class as `schema:`), but it is a rendered VERDICT
  // on the run's own reported content, not a shape/addressing mistake — see
  // parse-rejection.js's file header for the full split and
  // f-0f9e4077-retry-collision-duplicate-rejection.test.js's 'F-f8952a50'
  // describe block for the sibling proof that a shape/addressing prefix
  // (repo:) DOES become retryable. This assertion is therefore CONFIRMED
  // correct, not narrowed by the fix — restated here as a regression guard so
  // a future change to the retryable split cannot silently widen past this
  // boundary without a red test.
  it('REGRESSION GUARD: a resubmission after a persisted NON-schema, content-verdict rejection is STILL blocked', async () => {
    setupTestRoot();
    const RUN_ID = 'f-4036ae25-retry-non-schema-class';

    const bad = clone();
    bad.run_id = RUN_ID;
    // Schema-valid; rejected on provenance instead — a rendered verdict, not
    // "we could not understand the submission". The anti-retry doctrine must
    // still apply here, unaffected by the shape/addressing carve-out.
    const first = await ingest(bad, { repoRoot: TEST_ROOT, provenance: rejectingProvenance });
    assert.equal(first.written, true, 'precondition: the provenance rejection must persist');
    assert.ok(
      first.record.verification.rejection_reasons.some(r => r.startsWith('provenance:')),
      `expected a 'provenance:' rejection reason, got: ${JSON.stringify(first.record.verification.rejection_reasons)}`
    );

    const retry = clone();
    retry.run_id = RUN_ID;
    // Same submission, but now with provenance that WOULD confirm — proves
    // the block is isDuplicate's doing, not a second provenance failure.
    const second = await ingest(retry, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(second.duplicate, true,
      'a rendered content-verdict (provenance:) must keep consuming its run_id — the shape/addressing carve-out must not overreach');
  });
});
