/**
 * h4-reject-reason-conditional.test.ts — Contract spine: when a finding's
 * status is `rejected`, `review.reject_reason` MUST be present.
 *
 * H4 / F-stage-a-h4 — schema-engine pair invariant. AT HEAD the schema
 * carries the description "Required when status is rejected" but enforces
 * no `if/then` — so a rejected finding can ship without a reject_reason,
 * which the review CLI / pattern derivation / doctrine derivation all
 * silently absorb as "this got rejected for an unknown reason." The
 * downstream signal-loss is invisible.
 *
 * AFTER FIX (schema-side): the schema carries an additive `allOf`/`if`/
 * `then` that requires `review.reject_reason` whenever `status === 'rejected'`.
 *
 * Engine-side enforcement (the partner half) lives in the
 * `packages/findings/review/review-engine.js` test set.
 */

import { describe, expect, it } from 'vitest';
import { validatePayload } from '../src/index.js';

/** A minimal valid candidate finding we can use as a base for permutations. */
function makeFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    finding_id: 'dfind-h4-test',
    title: 'H4 schema if/then test base finding',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'repo_local',
    summary: 'A test finding used to exercise the reject_reason conditional invariant added in wave A1.',
    source_record_ids: ['test-record-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-record-001' }],
    ...overrides,
  };
}

describe('finding schema — H4 reject_reason conditional (if/then)', () => {
  it('accepts a non-rejected finding without review.reject_reason', () => {
    const finding = makeFinding({ status: 'accepted', review: { reviewed_by: 'op', last_action: 'accept' } });
    const result = validatePayload('finding', finding);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('REJECTS a finding with status="rejected" but no review.reject_reason', () => {
    const finding = makeFinding({
      status: 'rejected',
      review: { reviewed_by: 'op', last_action: 'reject' },
    });
    const result = validatePayload('finding', finding);
    expect(result.valid, 'expected rejected finding without reject_reason to be invalid').toBe(false);
    // Must surface the reject_reason field somewhere in the error envelope so
    // an operator can fix it without grepping the schema.
    const allText = JSON.stringify(result.errors);
    expect(allText, `expected reject_reason in error envelope; got ${allText}`).toMatch(/reject_reason/);
  });

  it('accepts a finding with status="rejected" AND review.reject_reason set', () => {
    const finding = makeFinding({
      status: 'rejected',
      review: { reviewed_by: 'op', last_action: 'reject', reject_reason: 'insufficient_evidence' },
    });
    const result = validatePayload('finding', finding);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts a merged/superseded rejection (reject_reason: "merged_into_canonical")', () => {
    const finding = makeFinding({
      status: 'rejected',
      review: { reviewed_by: 'op', last_action: 'merge', reject_reason: 'merged_into_canonical' },
    });
    const result = validatePayload('finding', finding);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('REJECTS a finding with status="rejected" and review present but reject_reason missing', () => {
    // Same shape as the second test but with a populated review block — this
    // is the realistic failure mode (operator forgot to fill reject_reason).
    const finding = makeFinding({
      status: 'rejected',
      review: {
        reviewed_by: 'op',
        reviewed_at: '2026-05-31T12:00:00Z',
        last_action: 'reject',
        decision_reason: 'manual reject without structured reason',
      },
    });
    const result = validatePayload('finding', finding);
    expect(result.valid, 'expected invalid').toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/reject_reason/);
  });
});
