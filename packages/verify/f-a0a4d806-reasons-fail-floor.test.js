/**
 * F-a0a4d806 — computeVerdict must treat non-empty rejection reasons as a fail
 * floor so status:'rejected' ⇒ overall_verdict.verified !== 'pass'.
 *
 * Pre-fix computeVerdict destructured context.reasons but never read it.
 * verify() set verification.status from reasons.length > 0 while verified was
 * computed only from schema/policy/provenance/scenario verdicts — a steps[...]
 * rejection left verified:'pass' next to a non-empty rejection_reasons list
 * (observed property noted in f-88fb37ff-reverse-verdict-consistency.test.js).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify } from './index.js';
import { computeVerdict } from './validators/verdict.js';
import { stubProvenance } from './validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const POLICIES = resolve(__dirname, '../../policies');

let pilot0;
let globalPolicy;
let repoPolicy;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
  globalPolicy = yaml.load(readFileSync(resolve(POLICIES, 'global-policy.yaml'), 'utf-8'));
  repoPolicy = yaml.load(
    readFileSync(resolve(POLICIES, 'repos/mcp-tool-shop-org/dogfood-labs.yaml'), 'utf-8')
  );
});

describe('F-a0a4d806: non-empty reasons force verified fail', () => {
  it('unit: computeVerdict floors to fail when reasons is non-empty even if scenarios pass', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'pass' }],
      reasons: ['steps[record-ingest-roundtrip]: scenario verdict is "pass" but steps have status fail/blocked']
    });
    assert.equal(result.verified, 'fail');
    assert.equal(result.downgraded, true);
    assert.ok(
      result.downgrade_reasons.some(r => /rejection reasons/i.test(r)),
      `expected a reasons-floor downgrade reason; got: ${JSON.stringify(result.downgrade_reasons)}`
    );
  });

  it('unit: empty reasons leave a clean pass intact', () => {
    const result = computeVerdict('pass', {
      schemaValid: true,
      policyValid: true,
      provenanceConfirmed: true,
      scenarioResults: [{ verdict: 'pass' }],
      reasons: []
    });
    assert.equal(result.verified, 'pass');
    assert.equal(result.downgraded, false);
  });

  it('e2e: status:rejected ⇒ overall_verdict.verified !== "pass"', async () => {
    const bad = structuredClone(pilot0);
    // Self-contradictory blocked + all-pass steps → steps[...] rejection,
    // status rejected, while scenario_results[].verdict stays non-pass... use
    // a pass-direction fail instead so scenario verdict remains 'pass' and the
    // pre-fix gap (verified still 'pass') is the one under test.
    bad.scenario_results[0].step_results[0].status = 'fail';

    const record = await verify(bad, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    assert.equal(record.verification.status, 'rejected');
    assert.ok(record.verification.rejection_reasons.length > 0);
    assert.notEqual(
      record.overall_verdict.verified,
      'pass',
      `rejected record must not advertise verified:'pass'; got ${JSON.stringify(record.overall_verdict)}`
    );
  });
});
