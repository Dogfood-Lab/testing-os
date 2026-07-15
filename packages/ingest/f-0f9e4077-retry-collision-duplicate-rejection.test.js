/**
 * f-0f9e4077-retry-collision-duplicate-rejection.test.js
 *
 * F-0f9e4077 (HIGH) — WAVE-6 REGRESSION. isRetryableSchemaRejection()
 * (persist.js) makes isDuplicate()'s rejected-path branch return `false`
 * ("not a duplicate") whenever the ALREADY-PERSISTED `_rejected` record's
 * reasons are 100% schema:-class — built so a CORRECTED resubmission can
 * still reach an acceptance despite a stale rejection sitting at the
 * `_rejected` path (F-4036ae25). But computeRecordPath() is keyed on
 * (run_id, date, accepted|rejected), never on content: an UNCORRECTED retry
 * (still schema-invalid, same run_id + date) computes the IDENTICAL path as
 * attempt 1. isDuplicate() said "not a duplicate", so writeRecord() proceeds
 * to its exclusive-create `openSync(path, 'wx')`, which collides with
 * attempt 1's already-written file and throws DuplicateRunIdError — a
 * purely sequential, single-writer collision escaping as though it were the
 * two-writer TOCTOU race that error class exists for. ingest()'s
 * writeRecord() catch (run.js) recognizes UnsafeRecordPathError and
 * schema-invalid RecordValidationError but not DuplicateRunIdError, so the
 * throw escapes to the CLI's outer catch: exit 2 (not 1), failed_stage
 * 'cli_parse_payload' (stale — last stamped before ingest() was even
 * called), and a stage:error event for what is, semantically, a routine
 * duplicate rejection.
 *
 * Fix (persist.js, isDuplicate()): a `_rejected` record's path never depends
 * on WHICH violation triggered it, so once that path is occupied, any new
 * record whose OWN status is still 'rejected' is going to that exact same
 * path no matter what it reports. The retryable-schema carve-out only ever
 * mattered for a record now headed to a DIFFERENT (accepted) path — gate it
 * on `record.verification.status === 'accepted'`. A still-rejected collision
 * is unconditionally a duplicate, so writeRecord() short-circuits before
 * ever attempting the exclusive-create: no DuplicateRunIdError is reachable
 * for this class anymore, rather than being thrown-and-caught downstream.
 *
 * The finding's three probes, all covered below:
 *   1. Byte-identical uncorrected retry (in-process, `ingest()` x2).
 *   2. The same shape via two separate CLI subprocesses — the real
 *      ingest.yml shape (two independent `node run.js` invocations).
 *   3. Boundary probe — a DIFFERENT unexpected-field NAME on attempt 2 must
 *      also not crash (the collision is keyed on path, not content).
 *
 * Two invariants this fix must NOT regress (asserted here at the isDuplicate
 * unit level so this file is a self-contained proof of both sides of the
 * contract; the ingest()-level versions already live elsewhere):
 *   - a corrected resubmission (now accepted) still persists — the
 *     higher-level proof is schema-invalid-skip-persist.test.js's
 *     "a corrected resubmission after a persisted schema-class rejection is
 *     NOT blocked" test, in the "genuinely filable" describe block.
 *   - a genuine non-retry collision (the accepted-path TOCTOU race) still
 *     throws loudly — pinned in ingest.test.js's "writeRecord TOCTOU race"
 *     describe block, untouched by this fix (the change here only reads
 *     `record.verification.status`; the accepted-path branch of
 *     isDuplicate() is not modified at all).
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, mkdirSync, rmSync, readdirSync,
  copyFileSync, mkdtempSync, writeFileSync
} from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { ingest } from './run.js';
import { isDuplicate, computeRecordPath } from './persist.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = resolve(__dirname, '__test_root_f_0f9e4077__');
const FIXTURES = resolve(__dirname, '../verify/fixtures');
const RUN_JS = resolve(__dirname, 'run.js');

let pilot0;
const sandboxes = [];

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

/** Fresh sandbox repo root in the OS temp dir for CLI-subprocess probes — never the real tree. */
function makeSandboxRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ingest-f0f9e4077-'));
  copyDirSync(resolve(REPO_ROOT, 'policies'), join(root, 'policies'));
  mkdirSync(join(root, 'records', '_rejected'), { recursive: true });
  mkdirSync(join(root, 'indexes'), { recursive: true });
  sandboxes.push(root);
  return root;
}

/** Run the REAL run.js as a subprocess with stub provenance, CI markers cleared (matches stageA-seed2). */
function runCli(payload, env = {}) {
  return spawnSync(process.execPath, [RUN_JS, '--provenance', 'stub'], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '', ...env },
  });
}

const clone = () => JSON.parse(JSON.stringify(pilot0));

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  while (sandboxes.length) {
    rmSync(sandboxes.pop(), { recursive: true, force: true });
  }
});

describe('F-0f9e4077: an uncorrected retry of a schema-class rejection does not throw', () => {
  it('probe 1 — byte-identical resubmission: second ingest() resolves cleanly, does not throw', async () => {
    setupTestRoot();
    const RUN_ID = 'f-0f9e4077-identical-retry';
    const build = () => {
      const s = clone();
      s.run_id = RUN_ID;
      s.unexpected_field = 'oops';
      return s;
    };

    const first = await ingest(build(), { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(first.written, true, 'precondition: attempt 1 must persist the schema-class rejection');
    assert.equal(first.record.verification.status, 'rejected');

    // Attempt 2: identical, still-uncorrected submission, same run_id. Pre-fix
    // this THROWS DuplicateRunIdError out of ingest() — persist.js's
    // exclusive-create collides with attempt 1's file on disk. This call must
    // resolve normally instead of rejecting the returned promise.
    const second = await ingest(build(), { repoRoot: TEST_ROOT, provenance: stubProvenance });

    assert.equal(second.record.verification.status, 'rejected');
    assert.equal(second.written, false, 'nothing new was written — attempt 1 already occupies this path');
    // Attempt 1's evidence survives untouched (fail-closed: no overwrite).
    assert.ok(existsSync(first.path));
  });

  it('probe 3 (boundary) — a DIFFERENT unexpected-field NAME on attempt 2 still does not throw', async () => {
    // The collision is keyed on the computed PATH (run_id + date), not on
    // content, so this must fail identically to the byte-identical case —
    // proves the fix isn't a narrow special-case for exact resubmissions.
    setupTestRoot();
    const RUN_ID = 'f-0f9e4077-boundary-retry';

    const first = clone();
    first.run_id = RUN_ID;
    first.unexpected_field_alpha = 'oops';
    const firstResult = await ingest(first, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(firstResult.written, true, 'precondition: attempt 1 must persist');

    const second = clone();
    second.run_id = RUN_ID;
    second.unexpected_field_beta = 'nope'; // different field NAME than attempt 1
    const secondResult = await ingest(second, { repoRoot: TEST_ROOT, provenance: stubProvenance });

    assert.equal(secondResult.record.verification.status, 'rejected');
    assert.equal(secondResult.written, false);
  });
});

describe('F-0f9e4077: two separate CLI subprocesses (the real ingest.yml shape)', () => {
  it('process 1 exits 1 cleanly; process 2 (uncorrected retry) ALSO exits 1 — never 2', () => {
    const sandbox = makeSandboxRoot();
    const RUN_ID = 'f-0f9e4077-cli-retry';

    const bad = clone();
    bad.run_id = RUN_ID;
    bad.unexpected_field = 'oops';

    const first = runCli(bad, { INGEST_REPO_ROOT: sandbox });
    assert.equal(first.status, 1,
      `attempt 1 (schema-class rejection) must exit 1; stdout=${first.stdout} stderr=${first.stderr}`);
    const firstOut = JSON.parse(first.stdout.trim().split('\n').pop());
    assert.equal(firstOut.status, 'rejected');

    // SAME payload again, as a fresh subprocess — the uncorrected retry.
    const second = runCli(bad, { INGEST_REPO_ROOT: sandbox });
    assert.equal(second.status, 1,
      `attempt 2 (uncorrected retry) must ALSO exit 1, not 2 ("operator error"); ` +
      `stdout=${second.stdout} stderr=${second.stderr}`);

    const secondOut = JSON.parse(second.stdout.trim().split('\n').pop());
    assert.equal(secondOut.status, 'rejected');
    assert.ok(
      secondOut.rejection_reasons.some(r => r.startsWith('schema: ')),
      `expected the actual schema rejection reasons on the retry, got: ${JSON.stringify(secondOut.rejection_reasons)}`
    );

    // No stage:error event — this is a routine rejection, not an operator incident.
    const events = second.stderr
      .split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(o => o && o.component === 'ingest');
    const errorEvents = events.filter(e => e.stage === 'error');
    assert.equal(errorEvents.length, 0,
      `a routine duplicate rejection must not emit a stage:error event; got: ${JSON.stringify(errorEvents)}`);
  });
});

describe('F-0f9e4077: isDuplicate() rejected-path branch, unit level', () => {
  it('a still-rejected new record colliding with an existing schema-class rejection IS a duplicate', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-0f9e4077-unit-still-rejected',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'rejected', rejection_reasons: ['schema: /unexpected_field must NOT be present'] }
    };
    const rejectedPath = computeRecordPath({ ...record, verification: { ...record.verification, status: 'rejected' } }, TEST_ROOT);
    mkdirSync(dirname(rejectedPath), { recursive: true });
    writeFileSync(rejectedPath, JSON.stringify({
      verification: { status: 'rejected', rejection_reasons: ['schema: /unexpected_field must NOT be present'] }
    }));

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a record whose OWN status is still rejected can never land anywhere but the SAME occupied path');
  });

  it('an accepted new record with a schema-class rejection sitting at the rejected path is NOT a duplicate (F-4036ae25 preserved)', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-0f9e4077-unit-now-accepted',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const rejectedPath = computeRecordPath({ ...record, verification: { status: 'rejected' } }, TEST_ROOT);
    mkdirSync(dirname(rejectedPath), { recursive: true });
    writeFileSync(rejectedPath, JSON.stringify({
      verification: { status: 'rejected', rejection_reasons: ['schema: /unexpected_field must NOT be present'] }
    }));

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, false,
      'a record now headed to the ACCEPTED path must not be blocked by a stale schema-class rejection sitting elsewhere');
  });

  it('an accepted new record with a NON-schema rejection sitting at the rejected path IS still a duplicate (unchanged)', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-0f9e4077-unit-non-schema-block',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const rejectedPath = computeRecordPath({ ...record, verification: { status: 'rejected' } }, TEST_ROOT);
    mkdirSync(dirname(rejectedPath), { recursive: true });
    writeFileSync(rejectedPath, JSON.stringify({
      verification: { status: 'rejected', rejection_reasons: ['provenance: could not confirm run'] }
    }));

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a rendered (non-schema) verdict must keep consuming its run_id regardless of the new record\'s status');
  });
});
