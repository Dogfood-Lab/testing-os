/**
 * stageA-policy-enforcement-conditional.test.ts — Contract spine: a policy
 * that opts a repo out of (or down from) Gate F MUST record a justification,
 * and an `exempt` opt-out MUST record a review date.
 *
 * d1-schemas-003 — the policy schema's own descriptions have always said
 *   enforcement.reason       "Required if mode is not 'required'."
 *   enforcement.review_after "Required if mode is 'exempt'."
 * but the schema enforced NEITHER (no allOf/if/then/dependentRequired), and
 * no consumer code backstops them (portfolio/generate.js defaults both to
 * null and never requires them). So a policy could mark a repo `exempt` —
 * opting it out of Gate F entirely — with reason:null and review_after:null
 * and validate clean: a governance opt-out with no recorded justification and
 * no scheduled review.
 *
 * This mirrors the H4 precedent the repo already set for findings
 * (dogfood-finding.schema.json allOf/if/then, sealed by
 * h4-reject-reason-conditional.test.ts). AFTER FIX: the policy schema carries
 * an additive allOf/if/then requiring `reason` whenever mode is warn-only or
 * exempt, and `review_after` whenever mode is exempt.
 */

import { describe, expect, it } from 'vitest';
import { validatePayload } from '../src/index.js';

/** A minimal valid policy with a given enforcement block. */
function makePolicy(enforcement?: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { policy_version: '1.0.0' };
  if (enforcement !== undefined) base.enforcement = enforcement;
  return base;
}

describe('policy schema — enforcement opt-out conditional (if/then)', () => {
  it('accepts a policy with no enforcement block (defaults to required)', () => {
    const result = validatePayload('policy', makePolicy());
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts enforcement.mode="required" with no reason / review_after', () => {
    const result = validatePayload('policy', makePolicy({ mode: 'required' }));
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('REJECTS mode="exempt" with no reason and no review_after', () => {
    const result = validatePayload('policy', makePolicy({ mode: 'exempt' }));
    expect(result.valid, 'expected exempt-without-reason to be invalid').toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/reason|review_after/);
  });

  it('REJECTS mode="exempt" with reason set but review_after missing', () => {
    const result = validatePayload(
      'policy',
      makePolicy({ mode: 'exempt', reason: 'legacy repo, no scenarios authored yet' }),
    );
    expect(result.valid, 'expected exempt-without-review_after to be invalid').toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/review_after/);
  });

  it('REJECTS mode="exempt" with reason:null (nullable does not satisfy required-with-value)', () => {
    // The property is typed [string,null]; the if/then upgrades it to a
    // *required* key. A literal null is still "present" for `required`, so the
    // value-type guard must reject null to make the justification meaningful.
    const result = validatePayload(
      'policy',
      makePolicy({ mode: 'exempt', reason: null, review_after: '2026-12-31' }),
    );
    expect(result.valid, 'expected exempt with reason:null to be invalid').toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/reason/);
  });

  it('REJECTS mode="warn-only" with no reason', () => {
    const result = validatePayload('policy', makePolicy({ mode: 'warn-only' }));
    expect(result.valid, 'expected warn-only-without-reason to be invalid').toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/reason/);
  });

  it('accepts mode="warn-only" with a reason (no review_after needed)', () => {
    const result = validatePayload(
      'policy',
      makePolicy({ mode: 'warn-only', reason: 'flaky CI under investigation' }),
    );
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts a fully-specified exempt policy (reason + review_after)', () => {
    const result = validatePayload(
      'policy',
      makePolicy({
        mode: 'exempt',
        reason: 'archived repo, retained for reference only',
        review_after: '2027-01-01',
      }),
    );
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
});
