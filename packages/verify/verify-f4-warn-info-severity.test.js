/**
 * verify-f4-warn-info-severity.test.js
 *
 * VERIFY-F4 (MEDIUM) — stop silently dropping warn/info severity policy rules.
 *
 * `validatePolicy` only ever looked at `severity: reject` rules; `warn` and
 * `info` rules were declared in global-policy.yaml and then dropped on the floor
 * (`if (rule.severity !== 'reject') continue`). An operator who wrote a
 * warn-severity rule got ZERO signal it ran. This mirrors the actionable-
 * diagnostic discipline PROACT-VERIFY-002 used for unenforced REJECT rules,
 * applied now to the warn/info channel.
 *
 * After the fix `validatePolicy` returns a third field, `warnings[]`. A matched
 * warn-rule pushes a `policy: <id>: <msg>`-shaped entry there (accepted WITH a
 * warning, NEVER a rejection). An info-rule logs only and never appears in
 * warnings or errors. Neither severity may ever cause rejection.
 *
 * Invariant:
 *   RED before — warn/info rules produce no warnings channel at all.
 *   GREEN after — a matched warn-rule yields valid:true + a populated
 *   warnings[] naming the rule; an info-rule logs only; neither rejects.
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

describe('VERIFY-F4: warn-severity rules surface a warning, never a rejection', () => {
  it('a matched warn-rule yields acceptance WITH a populated warnings[] naming the rule', () => {
    const submission = structuredClone(pilot0);
    const { valid, errors, warnings } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'prefer-attested', severity: 'warn', description: 'bot runs are best attested by a human' },
      ]),
      repoPolicy: null,
    });

    assert.equal(valid, true, 'a warn-severity rule must NEVER cause rejection');
    assert.deepEqual(errors, [], 'a warn-rule must not push to errors');
    assert.ok(Array.isArray(warnings), 'validatePolicy must expose a warnings channel');
    const hit = warnings.find(w => w.includes('prefer-attested'));
    assert.ok(hit, `expected a warning naming the rule; warnings=${JSON.stringify(warnings)}`);
    assert.match(hit, /bot runs are best attested/i, 'warning must carry the rule message');
  });

  it('the warning string shares the reject-rule message shape (rule id + message)', () => {
    const submission = structuredClone(pilot0);
    const { warnings } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'soft-coverage', severity: 'warn', description: 'coverage below target is tolerated for now' },
      ]),
      repoPolicy: null,
    });

    assert.equal(warnings.length, 1, 'exactly one warn-rule should yield one warning');
    assert.match(
      warnings[0],
      /soft-coverage/,
      'warning must name the rule id like the reject diagnostics name theirs'
    );
  });
});

describe('VERIFY-F4: info-severity rules log only', () => {
  it('an info-rule produces no warning and no rejection', () => {
    const submission = structuredClone(pilot0);
    const { valid, errors, warnings } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'fyi-note', severity: 'info', description: 'just a note for the operator' },
      ]),
      repoPolicy: null,
    });

    assert.equal(valid, true, 'an info-severity rule must NEVER cause rejection');
    assert.deepEqual(errors, [], 'an info-rule must not push to errors');
    assert.ok(
      !warnings.some(w => w.includes('fyi-note')),
      `an info-rule must NOT surface in warnings; warnings=${JSON.stringify(warnings)}`
    );
  });
});

describe('VERIFY-F4: warnings channel is always present and stable', () => {
  it('returns an empty warnings array when no warn/info rules are declared', () => {
    const submission = structuredClone(pilot0);
    const { valid, warnings } = validatePolicy(submission, {
      globalPolicy: policyWithRules([]),
      repoPolicy: null,
    });

    assert.equal(valid, true);
    assert.deepEqual(warnings, [], 'warnings defaults to an empty array');
  });

  it('a warn-rule does not flip an otherwise-rejected submission to accepted', () => {
    const submission = structuredClone(pilot0);
    submission.scenario_results = [];

    const { valid, errors, warnings } = validatePolicy(submission, {
      globalPolicy: policyWithRules([
        { id: 'scenario-minimum', severity: 'reject', description: 'at least one scenario required' },
        { id: 'prefer-attested', severity: 'warn', description: 'bot runs are best attested' },
      ]),
      repoPolicy: null,
    });

    assert.equal(valid, false, 'the reject rule still rejects');
    assert.ok(errors.some(e => e.includes('scenario-minimum')), 'the reject reason is present');
    assert.ok(
      warnings.some(w => w.includes('prefer-attested')),
      'the warn rule still records its warning alongside the rejection'
    );
  });
});
