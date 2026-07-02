/**
 * w4-f-82429f90-operational-fault-not-persisted.test.js
 *
 * F-82429f90 (wave 4 HIGH): an operational provenance fault (429/5xx after
 * exhausted retries, 401/403 token fault, timeout) THROWS from the adapter,
 * but verify() caught it and converted it into a `provenance-fault:`
 * REJECTION REASON — the record was assembled status='rejected' and ingest
 * PERSISTED it to records/_rejected/. isDuplicate checks that path, so a
 * clean resubmission under the same run_id was blocked FOREVER: during a
 * GitHub outage window every processed submission durably poisoned its
 * run_id, requiring manual record deletion to recover.
 *
 * Contract (mirrors the sibling scenario-fetch-fault semantics):
 *   - the fault propagates out of verify() as a coded PROVENANCE_FAULT
 *     error → ingest()/verifyOnly() propagate → the CLI's outer catch emits
 *     a structured operational error and exits 2;
 *   - NOTHING is persisted (records/ stays empty);
 *   - a resubmission of the same run_id after recovery is ACCEPTED (the
 *     duplicate guard was never poisoned).
 *
 * The same propagate-don't-persist treatment covers the mandatory siblings
 * (VALIDATOR_FAULT_SCHEMA / _CONTRACT_SCHEMA_VERSION / _STEPS / _POLICY) —
 * their verify()-level pins live in
 * packages/verify/d1b-003-validator-fault-codes.test.js.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest } from './run.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = resolve(__dirname, '__test_root_w4_82429f90__');
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

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

const faultingProvenance = {
  async confirm() {
    throw new Error('provenance: GitHub API returned 503');
  }
};

describe('F-82429f90 — provenance fault: propagate, persist nothing, never poison the run_id', () => {
  it('ingest() propagates the coded fault and writes NO record', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'w4-outage-run-001';

    await assert.rejects(
      ingest(submission, { repoRoot: TEST_ROOT, provenance: faultingProvenance }),
      (err) => {
        assert.equal(err.code, 'PROVENANCE_FAULT');
        assert.match(err.message, /^provenance-fault: verification failed: /);
        return true;
      },
      'an outage is an operational incident (exit 2 at the CLI), never a persisted rejection'
    );

    assert.equal(countFiles(resolve(TEST_ROOT, 'records')), 0,
      'records/ (including _rejected/) must stay empty during an outage window');
  });

  it('a clean resubmission of the SAME run_id after recovery is accepted — duplicate guard not poisoned', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'w4-outage-run-002';

    // Outage window: the fault propagates, nothing lands on disk.
    await assert.rejects(
      ingest(submission, { repoRoot: TEST_ROOT, provenance: faultingProvenance }),
      /provenance-fault:/
    );

    // Provider recovered: same run_id must go through cleanly.
    const retry = await ingest(structuredClone(submission), {
      repoRoot: TEST_ROOT,
      provenance: stubProvenance
    });
    assert.equal(retry.duplicate, false,
      'pre-fix the persisted outage rejection blocked this resubmission forever');
    assert.equal(retry.written, true);
    assert.equal(retry.record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(retry.record.verification.rejection_reasons)}`);
  });
});
