/**
 * F-3bfc2885 (ingest layer): the `scenarios` Map returned by loadScenarios must
 * reach verify() so success_criteria.required_steps is enforced end-to-end.
 * Before this fix, ingest()/verifyOnly() kept only `result.errors` and
 * discarded the loaded definitions — the `step-results-present` global reject
 * rule could never fire in a real ingest.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest, verifyOnly } from './run.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = resolve(__dirname, '__test_root_f3bfc2885__');
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

/** Fetcher whose scenario definition requires a step the submission omits. */
const strictFetcher = {
  async fetch() {
    return { success_criteria: { required_steps: ['emit-submission', 'step-nobody-ran'] } };
  }
};

/** Fetcher whose required steps are all reported in pilot-0. */
const satisfiedFetcher = {
  async fetch() {
    return { success_criteria: { required_steps: ['emit-submission', 'write-record'] } };
  }
};

describe('F-3bfc2885: ingest passes loaded scenarios to verify()', () => {
  it('ingest() rejects when a required step has no step_result', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f3bfc2885-ingest-001';

    const result = await ingest(submission, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: strictFetcher
    });

    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(
      result.record.verification.rejection_reasons.some(r =>
        r.includes('[step-results-present]') && r.includes('step-nobody-ran')
      ),
      `expected [step-results-present] reason, got: ${JSON.stringify(result.record.verification.rejection_reasons)}`
    );
  });

  it('ingest() accepts when every required step is reported', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f3bfc2885-ingest-002';

    const result = await ingest(submission, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: satisfiedFetcher
    });

    assert.equal(result.record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(result.record.verification.rejection_reasons)}`);
  });

  it('verifyOnly() mirrors the required-steps rejection', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f3bfc2885-verifyonly-001';

    const result = await verifyOnly(submission, {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: strictFetcher
    });

    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(
      result.record.verification.rejection_reasons.some(r => r.includes('[step-results-present]'))
    );
  });
});
