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
 * The line this draws: the duplicate guard consumes a run_id when we rendered
 * a VERDICT on a run (policy/provenance rejections still persist — pinned
 * below), never when we could not understand the submission.
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

  it('verifyOnly reports would_persist_to=null for a schema-invalid submission', async () => {
    setupTestRoot();
    const bad = clone();
    bad.ref.commit_sha = 'nope';

    const result = await verifyOnly(bad, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(result.record.verification.status, 'rejected');
    assert.equal(result.would_persist_to, null);
    assert.equal('_skipPersist' in result.record, false);
    assert.equal(countFiles(resolve(TEST_ROOT, 'records')), 0);
  });
});

describe('verify() marks schema-invalid records _skipPersist', () => {
  it('sets the sentinel when the submission schema fails', async () => {
    setupTestRoot();
    const bad = clone();
    bad.ref.commit_sha = 'nope';

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
  // we UNDERSTOOD and ruled against is a verdict about a real run: it persists,
  // and consuming the run_id is the intended anti-retry behavior.
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
