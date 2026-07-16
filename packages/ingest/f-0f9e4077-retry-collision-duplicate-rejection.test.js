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
 *
 * ---
 *
 * F-f8952a50 (wave 10, HIGH) extends this file's lineage.
 * isRetryableSchemaRejection (persist.js) checked ONLY `parseRejectionReason
 * (r).prefix === 'schema:'` — ONE of the ten prefixes parse-rejection.js's
 * own "Prefix taxonomy" documents under `class: 'submission-bad'` ("the
 * submitter fixes the payload and resubmits"). Several of the other nine —
 * including `repo:` — were silently held to the PRE-F-0f9e4077 "permanently
 * consumes the run_id" behavior even though they are pure identity/addressing
 * mistakes, proven live with a `repo:mismatch` rejection: a corrected,
 * matching resubmission never even reached verify() a second time; the CLI
 * printed a bare `{"status":"duplicate"}` indistinguishable from a routine
 * re-delivery.
 *
 * Fixed by renaming the helper to isRetryableRejection and reading
 * `parseRejectionReason(r).retryable` — a NEW per-prefix flag on the
 * classifier's own taxonomy (parse-rejection.js), not `class` directly. This
 * is deliberately narrower than "every submission-bad prefix": `policy:` and
 * `provenance:` stay class `submission-bad` but `retryable: false` — they are
 * a rendered VERDICT on the run's own reported content (see
 * parse-rejection.js's file header), and the existing "REGRESSION GUARD" /
 * "persist-a-verdict doctrine is preserved" tests in
 * schema-invalid-skip-persist.test.js already pin that boundary as
 * intentional. The shape/addressing subset (schema:, repo:,
 * unsafe-record-path:, steps[<id>]:, policy-config:,
 * submission-contains-verifier-field:, CONTRACT_SCHEMA_TOO_NEW/OLD:) is what
 * becomes retryable. See the 'F-f8952a50' describe block below.
 * The wave-8 invariants above (an uncorrected retry stays a clean duplicate;
 * a corrected schema-class retry is unblocked) are UNCHANGED by this — the
 * retryable check is only ever consulted when the NEW record is headed to
 * the accepted path (the `!== 'accepted'` gate above it), which this fix
 * does not touch.
 *
 * F-7b97fbd4 (wave 10, MEDIUM) touches probe 1 / probe 3 and the
 * CLI-subprocess test below: ingest()'s final return (run.js) hardcoded
 * `duplicate: false` even when `written === false` because writeRecord()
 * blocked the write as a duplicate — disagreeing with persist_complete's
 * OWN log event a few lines earlier, which correctly computed `duplicate:
 * !written`. Fixed at the same site. The CLI-subprocess test's exit code
 * for an uncorrected retry changes from 1 (misclassified as a fresh
 * rejection, full payload) to 0 (correctly classified as a harmless no-op
 * duplicate, terse `{status:'duplicate'}`) as a DIRECT, INTENDED
 * consequence — updated below, not a regression.
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
    // F-7b97fbd4: written:false here is SPECIFICALLY because writeRecord()
    // blocked the write as a duplicate collision — the return value must
    // agree with persist_complete's own `duplicate: !written` log event.
    assert.equal(second.duplicate, true,
      'a written:false blocked resubmission must be reported as duplicate:true');
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
    // F-7b97fbd4: same agreement check as probe 1, on the boundary shape.
    assert.equal(secondResult.duplicate, true,
      'a written:false blocked resubmission must be reported as duplicate:true');
  });
});

describe('F-0f9e4077: two separate CLI subprocesses (the real ingest.yml shape)', () => {
  it('process 1 exits 1 cleanly; process 2 (uncorrected retry) exits 0 as a clean duplicate — never 2 (F-7b97fbd4)', () => {
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
    // F-7b97fbd4: pre-fix, ingest()'s hardcoded `duplicate: false` return hid
    // this from the CLI wrapper's `if (result.duplicate)` branch, so it fell
    // through to the full rejected-record shape and exited 1 — "never 2" held,
    // but the shape was a fresh-looking rejection, not the harmless no-op
    // duplicate it actually was. Fixed: the CLI now takes the SAME terse
    // exit-0 branch an early-detected duplicate (the pre-verify probe) takes.
    const second = runCli(bad, { INGEST_REPO_ROOT: sandbox });
    assert.equal(second.status, 0,
      `attempt 2 (uncorrected retry) must exit 0 as a harmless no-op duplicate, never 2; ` +
      `stdout=${second.stdout} stderr=${second.stderr}`);

    const secondOut = JSON.parse(second.stdout.trim().split('\n').pop());
    assert.deepEqual(secondOut, { status: 'duplicate', run_id: RUN_ID },
      `expected the terse duplicate shape, got: ${second.stdout}`);

    // No stage:error event — this is a routine duplicate, not an operator incident.
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

  it('an accepted new record with a NON-schema, non-retryable submission-bad rejection (provenance:) IS still a duplicate (unchanged)', () => {
    // This is the original wave-9 pin, unaffected by F-f8952a50: `provenance:`
    // is class 'submission-bad' (the submitter's payload pointed at a run
    // that could not be confirmed) but it is a rendered VERDICT on the run's
    // own content, so parse-rejection.js flags it `retryable: false` — see
    // the file header and schema-invalid-skip-persist.test.js's "REGRESSION
    // GUARD" test for the end-to-end proof of the same boundary.
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

  it('an accepted new record with a policy: (verdict) rejection sitting at the rejected path IS still a duplicate', () => {
    // Second verdict-class prefix, same doctrine as provenance: above —
    // `policy:` evaluates the run's OWN reported scenario_results/tags
    // against declared rules, so a resubmission "correcting" it under the
    // same run_id would be laundering different self-reported content into
    // an acceptance rather than fixing an addressing mistake.
    setupTestRoot();
    const record = {
      run_id: 'f-f8952a50-unit-policy-block',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const rejectedPath = computeRecordPath({ ...record, verification: { status: 'rejected' } }, TEST_ROOT);
    mkdirSync(dirname(rejectedPath), { recursive: true });
    writeFileSync(rejectedPath, JSON.stringify({
      verification: { status: 'rejected', rejection_reasons: ['policy: forbidden tag "internal-only" present'] }
    }));

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'policy: is a rendered verdict (retryable: false) and must keep consuming its run_id');
  });

  it('an accepted new record with an OPERATIONAL-class rejection sitting at the rejected path IS still a duplicate', () => {
    // Operational reasons are never retryable regardless of how far the
    // shape/addressing carve-out grows — an ops fault is not the submitter's
    // to fix. Defensive coverage: F-82429f90's siblings throw instead of
    // persisting a `_rejected` record in production (see persist.js's doc
    // comment), so this path is not reachable live today, but the read/parse
    // path here still fails closed on it.
    setupTestRoot();
    const record = {
      run_id: 'f-0f9e4077-unit-operational-block',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const rejectedPath = computeRecordPath({ ...record, verification: { status: 'rejected' } }, TEST_ROOT);
    mkdirSync(dirname(rejectedPath), { recursive: true });
    writeFileSync(rejectedPath, JSON.stringify({
      verification: { status: 'rejected', rejection_reasons: ['provenance-fault: verification failed: GitHub API returned 503'] }
    }));

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'an operational-class reason must keep consuming its run_id regardless of the new record\'s status');
  });
});

describe('F-f8952a50: the retryable carve-out covers the shape/addressing subset of submission-bad, not just schema:', () => {
  it('unit level: a non-schema, shape/addressing submission-bad rejection (repo:) no longer blocks an accepted-bound retry', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-f8952a50-unit-repo-mismatch',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    const rejectedPath = computeRecordPath({ ...record, verification: { status: 'rejected' } }, TEST_ROOT);
    mkdirSync(dirname(rejectedPath), { recursive: true });
    writeFileSync(rejectedPath, JSON.stringify({
      verification: {
        status: 'rejected',
        rejection_reasons: [
          'repo:mismatch: submission.repo (mcp-tool-shop-org/dogfood-labs) does not match source.run_url repo (other-org/other-repo)'
        ]
      }
    }));

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, false,
      'repo: is parseRejectionReason retryable:true (pure addressing, not a content verdict) — a record now headed to the ACCEPTED path must not be blocked by it');
  });

  it('PROVEN SWALLOW, now fixed: a repo:mismatch rejection persists, then a corrected (matching run_url) resubmission reaches verify() again and is accepted', async () => {
    // Mirrors the finding's own live-probe proof exactly: attempt 1 claims a
    // repo whose source.run_url points somewhere else (repo:mismatch,
    // submission-bad and retryable, non-schema); attempt 2, same run_id,
    // run_url corrected to match repo — a submission that verify() would
    // accept cleanly. Pre-fix
    // the NDJSON log showed `dispatch_received` immediately followed by
    // `rejected_pre_persist reason:'duplicate'` — no `context_loaded`, no
    // `verify_complete` — proving verify() was never called on the corrected
    // payload. Post-fix it re-verifies and is accepted.
    setupTestRoot();
    const RUN_ID = 'f-f8952a50-repo-mismatch-retry';

    const mismatched = clone();
    mismatched.run_id = RUN_ID;
    mismatched.source.run_url = 'https://github.com/other-org/other-repo/actions/runs/9123456789';

    const first = await ingest(mismatched, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(first.record.verification.status, 'rejected');
    assert.equal(first.written, true,
      'precondition: the repo:mismatch rejection must persist (schema-valid, so it is filable)');
    assert.ok(
      first.record.verification.rejection_reasons.some(r => r.startsWith('repo:mismatch:')),
      `expected a 'repo:mismatch:' rejection reason, got: ${JSON.stringify(first.record.verification.rejection_reasons)}`
    );

    // Submitter fixes run_url to match `repo` and resubmits the SAME run_id.
    const corrected = clone();
    corrected.run_id = RUN_ID;

    const second = await ingest(corrected, { repoRoot: TEST_ROOT, provenance: stubProvenance });
    assert.equal(second.duplicate, false,
      'a repo:mismatch rejection (submission-bad, retryable, non-schema) must not permanently poison the run_id');
    assert.equal(second.written, true);
    assert.equal(second.record.verification.status, 'accepted');
    assert.ok(existsSync(second.path));
    // Both records survive, at their own distinct (rejected vs accepted) paths.
    assert.ok(existsSync(first.path));
    assert.notEqual(first.path, second.path);
  });
});
