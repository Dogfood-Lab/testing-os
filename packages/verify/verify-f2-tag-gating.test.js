/**
 * verify-f2-tag-gating.test.js
 *
 * VERIFY-F2 (HIGH) — make the documented tag-based policy gate REAL.
 *
 * verify/README.md's `policy:` row has long CLAIMED the policy gate rejects
 * "forbidden tags", but no code enforced it: a scenario_result could carry a
 * `wip`/`flaky`/`skip-ci` tag and validate clean. This feature threads scenario
 * tags into the submission (schema work) and teaches `validatePolicy` to gate on
 * them via surface `evidence_requirements.forbidden_tags` / `required_tags`.
 *
 * Invariant:
 *   RED before the fix — a `wip`-tagged scenario_result under a forbidden_tags
 *   rule is accepted (validatePolicy ignores tags entirely).
 *   GREEN after — it is rejected with a `policy:`-shaped reason NAMING the tag,
 *   and a clean submission still passes; required_tags is enforced symmetrically.
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

/** Global policy carrying given evidence_requirements as the surface DEFAULT. */
function globalWithDefaultEvidence(evidenceRequirements) {
  return {
    defaults: { evidence_requirements: evidenceRequirements },
    global_rules: [],
  };
}

/** Repo policy carrying given evidence_requirements on the `cli` surface. */
function repoWithCliEvidence(evidenceRequirements) {
  return { surfaces: { cli: { evidence_requirements: evidenceRequirements } } };
}

describe('VERIFY-F2: forbidden_tags', () => {
  it('REJECTS a scenario_result carrying a forbidden tag, naming the tag', () => {
    const submission = structuredClone(pilot0);
    submission.scenario_results[0].tags = ['smoke', 'wip'];

    const { valid, errors } = validatePolicy(submission, {
      globalPolicy: { defaults: {}, global_rules: [] },
      repoPolicy: repoWithCliEvidence({ forbidden_tags: ['wip', 'flaky', 'skip-ci'] }),
    });

    assert.equal(valid, false, 'a forbidden-tagged scenario must not pass policy');
    const hit = errors.find(e => e.includes('wip'));
    assert.ok(hit, `expected a reason naming the forbidden tag; errors=${JSON.stringify(errors)}`);
    assert.match(hit, /forbidden tag/i, 'reason must describe a forbidden tag');
    assert.match(
      hit,
      /record-ingest-roundtrip/,
      'reason should name the offending scenario for actionability'
    );
  });

  it('ACCEPTS a clean submission with no forbidden tags', () => {
    const submission = structuredClone(pilot0);
    submission.scenario_results[0].tags = ['smoke', 'release'];

    const { valid, errors } = validatePolicy(submission, {
      globalPolicy: globalWithDefaultEvidence({ forbidden_tags: ['wip', 'flaky'] }),
      repoPolicy: null,
    });

    assert.equal(valid, true, `clean tags must pass; errors=${JSON.stringify(errors)}`);
  });

  it('ACCEPTS a scenario_result with no tags at all under a forbidden_tags rule', () => {
    const submission = structuredClone(pilot0);
    delete submission.scenario_results[0].tags;

    const { valid } = validatePolicy(submission, {
      globalPolicy: globalWithDefaultEvidence({ forbidden_tags: ['wip'] }),
      repoPolicy: null,
    });

    assert.equal(valid, true, 'absent tags cannot trip a forbidden_tags rule');
  });
});

describe('VERIFY-F2: required_tags', () => {
  it('REJECTS a scenario_result missing a required tag, naming the tag', () => {
    const submission = structuredClone(pilot0);
    submission.scenario_results[0].tags = ['smoke'];

    const { valid, errors } = validatePolicy(submission, {
      globalPolicy: globalWithDefaultEvidence({ required_tags: ['release'] }),
      repoPolicy: null,
    });

    assert.equal(valid, false, 'a scenario missing a required tag must not pass policy');
    const hit = errors.find(e => e.includes('release'));
    assert.ok(hit, `expected a reason naming the missing tag; errors=${JSON.stringify(errors)}`);
    assert.match(hit, /required tag/i, 'reason must describe a required tag');
  });

  it('REJECTS a scenario_result with no tags at all under a required_tags rule', () => {
    const submission = structuredClone(pilot0);
    delete submission.scenario_results[0].tags;

    const { valid, errors } = validatePolicy(submission, {
      globalPolicy: globalWithDefaultEvidence({ required_tags: ['release'] }),
      repoPolicy: null,
    });

    assert.equal(valid, false, 'a tagless scenario cannot satisfy a required_tags rule');
    assert.ok(errors.some(e => e.includes('release')), 'reason must name the missing required tag');
  });

  it('ACCEPTS a scenario_result carrying all required tags', () => {
    const submission = structuredClone(pilot0);
    submission.scenario_results[0].tags = ['release', 'smoke'];

    const { valid, errors } = validatePolicy(submission, {
      globalPolicy: globalWithDefaultEvidence({ required_tags: ['release'] }),
      repoPolicy: null,
    });

    assert.equal(valid, true, `all required tags present must pass; errors=${JSON.stringify(errors)}`);
  });
});
