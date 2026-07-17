/**
 * f-51780da9-contract-schema-too-new-upgrade-unblocks.test.js
 *
 * F-51780da9 (HIGH) — CONFIRMING AUDIT of wave-20's F-be0deacd fix.
 *
 * F-be0deacd (wave 20) correctly flipped CONTRACT_SCHEMA_TOO_NEW: from class
 * 'submission-bad' to 'operational' — a future-major submission means THIS
 * BUILD is behind, not the submitter, so the CLI's --explain routing was
 * genuinely fixed. But the SAME LITERAL_PREFIXES edit that flips `class` also
 * flips `retryable` to `false` — and packages/ingest/persist.js's
 * isRetryableRejection()/isDuplicate() consume `.retryable` generically for
 * every prefix, with no per-prefix re-evaluation. Consequence: once a
 * run_id's ONLY prior rejection is a CONTRACT_SCHEMA_TOO_NEW record,
 * isDuplicate() unconditionally blocks that run_id from EVER reaching the
 * accepted path again — not just for an unchanged resubmission (genuinely
 * un-fixable, correctly blocked), but PERMANENTLY, even after testing-os is
 * upgraded to understand the declared schema major and the identical run_id's
 * payload would now genuinely pass verify() cleanly.
 *
 * Fix (packages/ingest/persist.js): isRetryableRejection() no longer trusts
 * the frozen `retryable: false` boolean alone for this one prefix. A new
 * helper, reevaluateTooNewRetry(), re-parses the STORED rejection's declared
 * contract + major and re-runs the identical `declaredMajor > maxMajor`
 * comparison against the CURRENT build's SUPPORTED_SCHEMA_VERSIONS (the same
 * single source of truth validators/schema-version.js itself reads) — so a
 * stale TOO_NEW rejection unblocks exactly when an operator upgrade makes it
 * genuinely stale, and stays blocking otherwise. Every other prefix is
 * unaffected: reevaluateTooNewRetry returns false for any reason it does not
 * recognize, so isRetryableRejection's `.every()` falls back to the ORIGINAL
 * parseRejectionReason(r).retryable check for schema:/policy:/repo:/
 * provenance:/CONTRACT_SCHEMA_TOO_OLD:/etc., byte-identical to pre-fix.
 *
 * This file proves the fix directly against the real, unmutated
 * isDuplicate()/isRetryableRejection() (isolated temp repoRoot, no repo
 * writes) — the same methodology f-0f9e4077-retry-collision-duplicate-
 * rejection.test.js uses for the sibling prefixes. It deliberately reads
 * SUPPORTED_SCHEMA_VERSIONS.recordSubmission.maxMajor live rather than
 * hardcoding "1" so the tests stay correct if that ceiling is ever bumped —
 * this is exactly the "the operator upgraded testing-os" event the fix
 * exists to unblock, expressed without needing to actually mutate the
 * shipped @dogfood-lab/schemas package at test time.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDuplicate, computeRecordPath } from './persist.js';
import { SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_root_f_51780da9__');
const CURRENT_MAX_MAJOR = SUPPORTED_SCHEMA_VERSIONS.recordSubmission.maxMajor;

function setupTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** Seed a `_rejected` record on disk at the path `record` would compute, carrying `reasons`. */
function seedRejected(record, reasons) {
  const rejectedPath = computeRecordPath({ ...record, verification: { status: 'rejected' } }, TEST_ROOT);
  mkdirSync(dirname(rejectedPath), { recursive: true });
  writeFileSync(rejectedPath, JSON.stringify({
    verification: { status: 'rejected', rejection_reasons: reasons }
  }));
  return rejectedPath;
}

describe('F-51780da9: a stale CONTRACT_SCHEMA_TOO_NEW rejection unblocks once testing-os is upgraded past the declared major', () => {
  /** @pins F-51780da9 */
  it('the exact bug, now fixed: seeding a TOO_NEW rejection whose declared major the CURRENT build already understands, then calling isDuplicate() with an accepted-status record (simulating the post-upgrade resubmission), returns false', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-upgraded-major',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    // The declared major equals the CURRENT build's ceiling — simulating a
    // rejection recorded back when testing-os only supported an OLDER major
    // (the "but this build supports v0.0.0" clause is the stale, historical
    // half of the message; only the declared major is re-derived).
    seedRejected(record, [
      `CONTRACT_SCHEMA_TOO_NEW: recordSubmission schema v${CURRENT_MAX_MAJOR}.0.0 but this build supports v0.0.0 (major 0–0) — upgrade testing-os`
    ]);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, false,
      'a TOO_NEW rejection whose declared major the CURRENT build already supports must not permanently poison the run_id — the operator upgraded testing-os, exactly what the original rejection demanded');
  });

  /** @pins F-51780da9 */
  it('REGRESSION GUARD: a TOO_NEW rejection whose declared major is STILL above the current ceiling keeps blocking, unweakened', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-still-too-new',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    // A declared major far beyond anything this build could plausibly
    // support today — this fix must NOT unblock a genuinely-still-too-new
    // rejection; only an already-resolved one.
    seedRejected(record, [
      `CONTRACT_SCHEMA_TOO_NEW: recordSubmission schema v${CURRENT_MAX_MAJOR + 99}.0.0 but this build supports v1.0.0 (major 1–1) — upgrade testing-os`
    ]);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a genuinely-still-too-new rejection must remain blocking — this fix only unblocks a rejection the build has since caught up to, not every TOO_NEW rejection unconditionally');
  });

  /** @pins F-51780da9 */
  it('a still-rejected new record (own status not yet "accepted") collides unconditionally regardless of TOO_NEW resolution — the untouched branch', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-still-rejected',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      // The NEW attempt's own status is still 'rejected' (e.g. it fails for
      // an unrelated reason too) — isDuplicate's pre-existing, untouched
      // `!== 'accepted'` branch must return true unconditionally, exactly as
      // it does for every other prefix (see F-0f9e4077's equivalent test).
      verification: { status: 'rejected' }
    };
    seedRejected(record, [
      `CONTRACT_SCHEMA_TOO_NEW: recordSubmission schema v${CURRENT_MAX_MAJOR}.0.0 but this build supports v0.0.0 (major 0–0) — upgrade testing-os`
    ]);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a record whose OWN status is still rejected can only ever land at the SAME occupied path, regardless of whether the stored TOO_NEW rejection has since resolved');
  });

  /** @pins F-51780da9 */
  it('sanity: the sibling CONTRACT_SCHEMA_TOO_OLD: prefix is unaffected — already retryable:true pre-fix, unblocks via the ordinary path', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-too-old-sibling',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    seedRejected(record, [
      'CONTRACT_SCHEMA_TOO_OLD: recordSubmission schema v0.1.0 is below the supported floor v1.0.0 (major 1–1) — re-emit against the current contract'
    ]);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, false,
      'CONTRACT_SCHEMA_TOO_OLD: was already retryable:true pre-fix (the submitter, not testing-os, is behind) — must still unblock via the ordinary parseRejectionReason path, untouched by this fix');
  });

  /** @pins F-51780da9 */
  it('a TOO_NEW-prefixed reason this parser cannot shape-match fails closed (still blocks), never guesses', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-malformed-too-new',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    // Missing the "<contract> schema v<major>.<minor>.<patch> " shape
    // entirely — reevaluateTooNewRetry must not guess a major out of this.
    seedRejected(record, ['CONTRACT_SCHEMA_TOO_NEW: unparseable garbage with no version']);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a TOO_NEW-prefixed reason this parser cannot parse must fail closed to blocking, never silently unblock on an unrecognized shape');
  });

  /** @pins F-51780da9 */
  it('an unrecognized contract key fails closed (still blocks) rather than assuming resolved', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-unknown-contract',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    seedRejected(record, [
      'CONTRACT_SCHEMA_TOO_NEW: notARealContract schema v1.0.0 but this build supports v1.0.0 (major 1–1) — upgrade testing-os'
    ]);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a contract key not registered in SUPPORTED_SCHEMA_VERSIONS must fail closed rather than being treated as resolved');
  });

  /** @pins F-51780da9 */
  it('multiple rejection_reasons: a resolved TOO_NEW reason alongside a genuine content-verdict (policy:) reason still blocks overall (every() semantics preserved)', () => {
    setupTestRoot();
    const record = {
      run_id: 'f-51780da9-mixed-reasons',
      repo: 'mcp-tool-shop-org/dogfood-labs',
      timing: { finished_at: '2026-03-19T15:45:12Z' },
      verification: { status: 'accepted' }
    };
    seedRejected(record, [
      `CONTRACT_SCHEMA_TOO_NEW: recordSubmission schema v${CURRENT_MAX_MAJOR}.0.0 but this build supports v0.0.0 (major 0–0) — upgrade testing-os`,
      'policy: forbidden tag "wip"'
    ]);

    const result = isDuplicate(record.run_id, record, TEST_ROOT);
    assert.equal(result, true,
      'a resolved TOO_NEW reason does not override a genuinely non-retryable sibling reason in the same record — isRetryableRejection requires EVERY reason to individually pass');
  });
});
