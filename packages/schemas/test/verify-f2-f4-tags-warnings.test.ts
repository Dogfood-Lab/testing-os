/**
 * verify-f2-f4-tags-warnings.test.ts — backward-compatible contract additions
 * for the tag-gating (VERIFY-F2) and warn/info-severity (VERIFY-F4) features.
 *
 * VERIFY-F2 threads scenario tags into the payload so the policy validator can
 * gate on them: an OPTIONAL `tags` (array of strings) on each scenario_results
 * item in BOTH the submission and the persisted record schema. The contract
 * addition is backward-compatible — `tags` is optional and `additionalProperties`
 * stays false, so every record/fixture authored before the field existed still
 * validates clean. These tests pin that compatibility (the seam a future
 * accidental `required` or type-narrowing would break) AND the new acceptance.
 *
 * VERIFY-F4 adds an OPTIONAL `verification.warnings` (array of strings) channel
 * to the persisted record so warn-severity policy rules can record an
 * accepted-with-warning note instead of being silently dropped. Same
 * backward-compat invariant: a record with no warnings block validates clean.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePayload } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../verify/fixtures');

function loadSubmissionFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixturesDir, 'pilot-0-submission.json'), 'utf8'));
}

/**
 * Promote the pilot-0 SUBMISSION fixture to a minimally-valid persisted RECORD
 * by stamping the verifier-owned fields the record schema additionally requires.
 * Keeps the test self-contained instead of depending on a record fixture that
 * may drift.
 */
function makeRecord(): Record<string, unknown> {
  const sub = loadSubmissionFixture();
  return {
    ...sub,
    policy_version: '1.0.0',
    overall_verdict: { proposed: 'pass', verified: 'pass' },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-19T15:46:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
    },
  };
}

describe('VERIFY-F2 — scenario_results[].tags (submission schema)', () => {
  it('accepts a submission whose scenario_result omits tags (backward-compatible)', () => {
    const result = validatePayload('recordSubmission', loadSubmissionFixture());
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts a submission whose scenario_result carries a tags array', () => {
    const sub = loadSubmissionFixture();
    (sub.scenario_results as Record<string, unknown>[])[0].tags = ['smoke', 'release'];
    const result = validatePayload('recordSubmission', sub);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('REJECTS tags that are not an array of strings', () => {
    const sub = loadSubmissionFixture();
    (sub.scenario_results as Record<string, unknown>[])[0].tags = [1, 2];
    const result = validatePayload('recordSubmission', sub);
    expect(result.valid, 'numeric tags must be invalid').toBe(false);
  });
});

describe('VERIFY-F2 — scenario_results[].tags (record schema)', () => {
  it('accepts a record whose scenario_result omits tags (backward-compatible)', () => {
    const result = validatePayload('record', makeRecord());
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts a record whose scenario_result carries a tags array', () => {
    const rec = makeRecord();
    (rec.scenario_results as Record<string, unknown>[])[0].tags = ['wip'];
    const result = validatePayload('record', rec);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
});

describe('VERIFY-F4 — verification.warnings (record schema)', () => {
  it('accepts a record with no warnings block (backward-compatible)', () => {
    const result = validatePayload('record', makeRecord());
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts a record carrying verification.warnings string array', () => {
    const rec = makeRecord();
    (rec.verification as Record<string, unknown>).warnings = [
      'policy: prefer-attested: bot run accepted without attestation',
    ];
    const result = validatePayload('record', rec);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('REJECTS verification.warnings that is not an array of strings', () => {
    const rec = makeRecord();
    (rec.verification as Record<string, unknown>).warnings = 'just a string';
    const result = validatePayload('record', rec);
    expect(result.valid, 'non-array warnings must be invalid').toBe(false);
  });
});
