/**
 * verify-f1-custom-rules.test.js — VERIFY-F1 declarative custom rules, end to end
 * through validatePolicy, plus the policy-config: origin-classification contract.
 *
 * Covers the audit's named use cases (actor allowlists, forbidden tag combos), the
 * non-weakening invariant (custom rules can only ADD constraints), and the split
 * fault routing: a malformed REPO custom-rule predicate is a `policy-config:`
 * submission-bad reason; a malformed GLOBAL predicate throws (operational).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePolicy } from './validators/policy.js';
import { PredicateError } from './validators/predicate.js';
import { parseRejectionReason } from './parse-rejection.js';

const webSr = (over = {}) => ({
  scenario_id: 's1', product_surface: 'web', execution_mode: 'bot', verdict: 'pass', tags: [], ...over,
});
const submissionWith = (...srs) => ({ scenario_results: srs });

const repoWith = (customRules) => ({ surfaces: { web: { custom_rules: customRules } } });
const globalEmpty = { defaults: {}, global_rules: [] };

describe('VERIFY-F1 surface custom rules — the named use cases', () => {
  it('actor-allowlist: rejects a web scenario whose attested_by is not allowlisted', () => {
    const repoPolicy = repoWith([
      { id: 'actor-allowlist', severity: 'reject', description: 'web proof must come from an allowlisted actor',
        when: { field: 'attested_by', op: 'in', value: ['ci-bot', 'release-bot'] } },
    ]);
    // when describes the VIOLATION, so this rule fires when the actor IS allowlisted.
    // Author the real-world "not allowlisted" form: reject when NOT in the set.
    repoPolicy.surfaces.web.custom_rules[0].when = { field: 'attested_by', op: 'not_in', value: ['ci-bot', 'release-bot'] };

    const reject = validatePolicy(submissionWith(webSr({ attested_by: 'random-dev' })), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(reject.valid, false);
    assert.ok(reject.errors.some(e => e.includes('[actor-allowlist]')), JSON.stringify(reject.errors));

    const accept = validatePolicy(submissionWith(webSr({ attested_by: 'ci-bot' })), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(accept.valid, true);
  });

  it('forbidden tag combo: rejects a web scenario tagged wip, with a templated reason', () => {
    const repoPolicy = repoWith([
      { id: 'no-wip-on-web', severity: 'reject',
        when: { field: 'tags', op: 'contains', value: 'wip' },
        reason_template: 'scenario "{scenario_id}": web proof cannot be tagged wip' },
    ]);
    const res = validatePolicy(submissionWith(webSr({ scenario_id: 'sx', tags: ['wip'] })), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(res.valid, false);
    assert.deepEqual(res.errors, ['[no-wip-on-web] scenario "sx": web proof cannot be tagged wip']);
  });

  it('a warn custom rule is accepted-with-warning, never a rejection', () => {
    const repoPolicy = repoWith([
      { id: 'prefer-release', severity: 'warn', description: 'web proof is best tagged release',
        when: { field: 'tags', op: 'not_contains', value: 'release' } },
    ]);
    const res = validatePolicy(submissionWith(webSr({ tags: [] })), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(res.valid, true);
    assert.ok(res.warnings.some(w => w.includes('[prefer-release]')));
  });

  it('a surface custom rule does NOT apply to scenarios on other surfaces', () => {
    const repoPolicy = repoWith([
      { id: 'no-wip-on-web', severity: 'reject', when: { field: 'tags', op: 'contains', value: 'wip' } },
    ]);
    // A cli scenario tagged wip is untouched by the web custom rule.
    const cliWip = { scenario_id: 'c1', product_surface: 'cli', execution_mode: 'bot', verdict: 'pass', tags: ['wip'] };
    const res = validatePolicy(submissionWith(cliWip), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(res.valid, true);
  });
});

describe('VERIFY-F1 non-weakening: custom rules can only ADD constraints', () => {
  it('a repo custom rule cannot clear a global rejection', () => {
    const globalPolicy = {
      defaults: {},
      global_rules: [
        { id: 'attested-if-human', severity: 'reject', scope: 'scenario_result',
          when: { implies: [ { field: 'execution_mode', op: 'in', value: ['human', 'mixed'] }, { field: 'attested_by', op: 'exists' } ] },
          reason_template: 'scenario "{scenario_id}": execution_mode is "{execution_mode}" but attested_by is missing' },
      ],
    };
    // Even a permissive-looking custom rule (warn only — there is no accept verb) cannot
    // flip the global reject. The accepted set is the intersection of all gates.
    const repoPolicy = repoWith([
      { id: 'noise', severity: 'warn', description: 'noise', when: { field: 'verdict', op: 'equals', value: 'pass' } },
    ]);
    const res = validatePolicy(submissionWith(webSr({ execution_mode: 'human' })), { globalPolicy, repoPolicy });
    assert.equal(res.valid, false, 'the global reject still rejects');
    assert.ok(res.errors.some(e => e.includes('[attested-if-human]')));
  });
});

describe('VERIFY-F1 fault routing splits by predicate origin', () => {
  it('a malformed REPO custom-rule predicate is a policy-config: submission-bad reason (caught, not thrown)', () => {
    const repoPolicy = repoWith([
      { id: 'bad-type', severity: 'reject', when: { field: 'execution_mode', op: 'gt', value: 1 } },
    ]);
    const res = validatePolicy(submissionWith(webSr()), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(res.valid, false, 'a malformed predicate fails closed');
    assert.ok(Array.isArray(res.configErrors) && res.configErrors.length === 1, JSON.stringify(res.configErrors));
    assert.match(res.configErrors[0], /bad-type/);
    assert.match(res.configErrors[0], /type_mismatch|numeric/);
  });

  it('a malformed GLOBAL predicate THROWS (becomes operational VALIDATOR_FAULT_POLICY upstream)', () => {
    const globalPolicy = {
      defaults: {},
      global_rules: [
        { id: 'g-bad', severity: 'reject', scope: 'submission', when: { field: 'not_a_real_field', op: 'exists' } },
      ],
    };
    assert.throws(
      () => validatePolicy(submissionWith(webSr()), { globalPolicy, repoPolicy: null }),
      (e) => e instanceof PredicateError && e.code === 'unknown_field'
    );
  });

  it('parseRejectionReason classifies policy-config: as submission-bad', () => {
    const parsed = parseRejectionReason('policy-config: rule "bad-type": operator "gt" requires a numeric field value');
    assert.equal(parsed.class, 'submission-bad');
    assert.equal(parsed.prefix, 'policy-config:');
  });

  it('the policy: prefix still classifies as submission-bad and is not shadowed by policy-config:', () => {
    const parsed = parseRejectionReason('policy: [scenario-minimum] At least one scenario_result required');
    assert.equal(parsed.class, 'submission-bad');
    assert.equal(parsed.prefix, 'policy:');
  });
});

describe('VERIFY-F1 fail-closed absence checks use not(any(...)) (Phase 3)', () => {
  it('an absence rule phrased as not(any(...)) rejects a scenario with NO log evidence', () => {
    // The fail-CLOSED way to say "web proof must include a log evidence item". A naive
    // `evidence[].kind not_contains log` would fail OPEN on empty evidence (existential
    // vacuous truth — see docs/policy-dsl.md); not(any(... contains log)) fires on empty.
    const repoPolicy = repoWith([
      { id: 'require-log-evidence', severity: 'reject',
        description: 'web proof must include a log evidence item',
        when: { not: { any: [{ field: 'evidence[].kind', op: 'contains', value: 'log' }] } } },
    ]);
    const noEvidence = validatePolicy(submissionWith(webSr({ evidence: [] })), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(noEvidence.valid, false, 'no-evidence scenario is rejected (fail-closed)');
    assert.ok(noEvidence.errors.some(e => e.includes('require-log-evidence')));

    const hasLog = validatePolicy(submissionWith(webSr({ evidence: [{ kind: 'log', url: 'https://x/y' }] })), { globalPolicy: globalEmpty, repoPolicy });
    assert.equal(hasLog.valid, true, 'a scenario with a log evidence item passes');
  });
});
