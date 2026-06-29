/**
 * proact-verify-002-policy-unenforced-reject.test.js
 *
 * PROACT-VERIFY-002 (MED, resilience/humanization) — a global policy rule
 * declared `severity: reject` whose `id` the policy validator does not handle
 * used to hit the `default: break` arm and SILENTLY no-op. An operator who added
 * a new reject rule to global-policy.yaml got ZERO signal that the rule was
 * never enforced — the submission passed policy as if the rule did not exist.
 *
 * The fix keeps behavior IDENTICAL for known ids (locally-handled +
 * enforced-elsewhere) but, for an UNKNOWN id declared `severity: reject`, pushes
 * an actionable diagnostic naming the offending rule id so the gap is
 * operator-visible. The submission still rejects (a reject rule the build can't
 * enforce must not silently pass), and the message tells the operator exactly
 * which rule has no enforcement in this build.
 *
 * Invariant (RED before the fix — an unknown reject rule silently no-op'd and
 * the submission was policy_valid; GREEN after — an actionable reason names it):
 *   1. unknown id + severity reject → an actionable `rule "<id>"` diagnostic.
 *   2. a known locally-handled id (scenario-minimum) is unaffected.
 *   3. an enforced-elsewhere id (provenance-confirmed) does NOT trip the
 *      diagnostic (it is enforced by the verifier, not this validator).
 *   4. an unknown id with severity != reject is ignored (no diagnostic).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePolicy } from './validators/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

function policyWithRules(rules) {
  return { defaults: {}, global_rules: rules };
}

describe('PROACT-VERIFY-002: unenforced severity:reject rule surfaces a diagnostic', () => {
  it('an UNKNOWN reject rule id pushes an actionable diagnostic naming the rule', () => {
    const submission = structuredClone(pilot0);
    const { valid, errors } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'totally-new-gate', severity: 'reject', description: 'a brand-new gate' }
      ]),
      repoPolicy: null
    });

    const diag = errors.find(e => e.includes('totally-new-gate'));
    assert.ok(
      diag,
      `expected a diagnostic naming the unenforced rule; errors=${JSON.stringify(errors)}`
    );
    assert.match(diag, /no enforcement/i, 'diagnostic must say the rule has no enforcement in this build');
    assert.equal(valid, false, 'an unenforceable reject rule must not silently pass policy');
  });

  it('a known locally-handled id (scenario-minimum) does NOT trip the diagnostic', () => {
    const submission = structuredClone(pilot0);
    const { errors } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'scenario-minimum', severity: 'reject', description: 'at least one scenario' }
      ]),
      repoPolicy: null
    });
    assert.ok(
      !errors.some(e => /no enforcement/i.test(e)),
      `scenario-minimum is handled here — must NOT emit a no-enforcement diagnostic; errors=${JSON.stringify(errors)}`
    );
  });

  it('an enforced-elsewhere id (provenance-confirmed) does NOT trip the diagnostic', () => {
    const submission = structuredClone(pilot0);
    const { errors } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'provenance-confirmed', severity: 'reject', description: 'provenance must confirm' }
      ]),
      repoPolicy: null
    });
    assert.ok(
      !errors.some(e => /no enforcement/i.test(e)),
      `provenance-confirmed is enforced by the verifier — must NOT emit a no-enforcement diagnostic; errors=${JSON.stringify(errors)}`
    );
  });

  it('an unknown id with severity != reject is ignored (no diagnostic)', () => {
    const submission = structuredClone(pilot0);
    const { errors } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'totally-new-warn', severity: 'warn', description: 'a non-blocking gate' }
      ]),
      repoPolicy: null
    });
    assert.ok(
      !errors.some(e => /no enforcement/i.test(e)),
      `a non-reject rule must NOT emit a no-enforcement diagnostic; errors=${JSON.stringify(errors)}`
    );
  });
});
