/**
 * proact-verify-002-policy-unenforced-reject.test.js
 *
 * PROACT-VERIFY-002 (MED, resilience/humanization) — a global policy rule
 * declared `severity: reject` whose `id` the policy validator does not handle
 * used to hit the `default: break` arm and SILENTLY no-op. An operator who added
 * a new reject rule to global-policy.yaml got ZERO signal that the rule was
 * never enforced — the submission passed policy as if the rule did not exist.
 *
 * F-3ef6b03e (this file's second fix): the FIRST fix (below, unchanged) pushed
 * an actionable diagnostic into `errors` for an UNKNOWN severity:reject id —
 * good, the gap became visible — but `errors` flows through index.js's `policy:`
 * prefix, which parseRejectionReason classifies 'submission-bad'. That is wrong
 * for THIS diagnostic: it fires because a MAINTAINER's global-policy.yaml
 * declares a rule the build cannot enforce, not because the submitter sent a
 * bad payload. Every submission in the fleet would reject with the submitter
 * told to "fix your payload and resubmit" for a fault that is not theirs.
 *
 * The corrected fix THROWS instead of pushing to `errors` — mirroring the
 * sibling GLOBAL-rule predicate-fault throw in verify-f1-custom-rules.test.js.
 * `runValidator('policy', ...)` in index.js wraps any throw from validatePolicy
 * as `VALIDATOR_FAULT_POLICY:`, which parseRejectionReason classifies
 * 'operational' by family match — exit 2, nothing persisted, no run_id
 * poisoned via the duplicate guard (F-82429f90's discipline, applied for free).
 *
 * Invariant (RED before the F-3ef6b03e fix — the diagnostic landed in `errors`,
 * a normal return, not a throw; GREEN after — validatePolicy throws and the
 * caught error still names the offending rule):
 *   1. unknown id + severity reject → validatePolicy THROWS naming the rule.
 *   2. the thrown message survives VALIDATOR_FAULT_POLICY: wrapping and
 *      classifies 'operational', never 'submission-bad'.
 *   3. a known locally-handled id (scenario-minimum) is unaffected (no throw).
 *   4. an enforced-elsewhere id (provenance-confirmed) does NOT trip the
 *      diagnostic (it is enforced by the verifier, not this validator).
 *   5. an unknown id with severity != reject is ignored (no diagnostic, no throw).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePolicy } from './validators/policy.js';
import { parseRejectionReason } from './parse-rejection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

function policyWithRules(rules) {
  return { defaults: {}, global_rules: rules };
}

describe('PROACT-VERIFY-002 / F-3ef6b03e: unenforced severity:reject rule throws operational, not submission-bad', () => {
  it('an UNKNOWN reject rule id THROWS an actionable diagnostic naming the rule (not a returned error)', () => {
    const submission = structuredClone(pilot0);

    // Deletion/emptiness proof: revert the `default:` arm from `throw` back to
    // `errors.push(...)` and this goes red — validatePolicy would return
    // normally instead of throwing.
    assert.throws(
      () => validatePolicy(submission, {
        globalPolicy: policyWithRules([
          { id: 'totally-new-gate', severity: 'reject', description: 'a brand-new gate' }
        ]),
        repoPolicy: null
      }),
      (e) => {
        assert.match(e.message, /totally-new-gate/, `thrown message must name the rule; got ${e.message}`);
        assert.match(e.message, /no enforcement/i, 'thrown message must say the rule has no enforcement in this build');
        return true;
      }
    );
  });

  it('the thrown diagnostic, wrapped as VALIDATOR_FAULT_POLICY:, classifies operational — never submission-bad', () => {
    const submission = structuredClone(pilot0);
    let caught = null;
    try {
      validatePolicy(submission, {
        globalPolicy: policyWithRules([
          { id: 'totally-new-gate', severity: 'reject', description: 'a brand-new gate' }
        ]),
        repoPolicy: null
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'validatePolicy must throw for an unenforced reject rule');

    // Reproduce runValidator's wrapping exactly (verify/index.js:76-87) so this
    // test is sensitive to the actual classification a real ingest run would
    // see, not just to validatePolicy's raw throw.
    const wrapped = `VALIDATOR_FAULT_POLICY: ${caught.message}`;
    const parsed = parseRejectionReason(wrapped);
    assert.equal(parsed.class, 'operational',
      `an unenforced global rule is a maintainer fault, not a submitter fault; got class="${parsed.class}"`);
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
