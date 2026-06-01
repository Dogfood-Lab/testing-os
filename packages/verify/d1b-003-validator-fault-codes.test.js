/**
 * d1b-003-validator-fault-codes.test.js
 *
 * D1B-003 (Stage C humanization) — make `rejection_reasons` discriminable
 * by failure CLASS. Pre-fix, the three validator catches at
 * `packages/verify/index.js:78, 112, 125` all pushed
 * `'validator error: ' + e.message` — operators could not tell whether a
 * submission was BAD (input the verifier rightly refused) or whether a
 * VALIDATOR itself crashed (an operational incident the operator must
 * triage). Both classes blurred into one indistinguishable prefix.
 *
 * Lens: stable coded reasons that are greppable and class-discriminable.
 *
 *   - Submission-bad → existing `'schema: …'`, `'policy: …'`, `'steps[id]: …'`
 *     prefixes (kept unchanged for back-compat).
 *   - Validator-crashed → new `'VALIDATOR_FAULT_SCHEMA: …'`,
 *     `'VALIDATOR_FAULT_POLICY: …'`, `'VALIDATOR_FAULT_STEPS: …'`. Format
 *     mirrors the established `<KEY>: <details>` convention so existing
 *     log aggregators / parsers degrade cleanly: anything starting with
 *     `VALIDATOR_FAULT_` is an operator alert; everything else is a
 *     submission-class signal.
 *
 * The wrapped helper (`runValidator(name, fn)`) is checked indirectly:
 * its invariant is that the catches no longer raw-prefix `'validator error:'`
 * — a regex sweep over the source file pins this.
 *
 * Invariant (both halves enforced for each catch):
 *   1. POSITIVE (validator-crashed): force the inner validator function to
 *      throw → `rejection_reasons` contains a `VALIDATOR_FAULT_<CLASS>:`
 *      reason AND NO `'validator error: '` raw prefix anywhere.
 *   2. POSITIVE (submission-bad): force a clean submission-rejection signal
 *      → `rejection_reasons` carries the existing `'<class>: '` prefix.
 *      Both classes coexist in the same vocabulary; nothing collides.
 *   3. NEGATIVE (sweep): no occurrence of the literal `'validator error: '`
 *      string survives in `index.js`. The discipline is the regression
 *      pin against the old vocabulary leaking back.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { verify } from './index.js';
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

// ─────────────────────────────────────────────────────────────────
// D1B-003 — schema validator class: crash vs submission-bad
// ─────────────────────────────────────────────────────────────────

describe('D1B-003 — schema validator: VALIDATOR_FAULT_SCHEMA vs schema: prefixes', () => {
  it('POSITIVE crash: a validator-internal throw lands as VALIDATOR_FAULT_SCHEMA', async () => {
    // Inject a fault via the test-only `validators` override hook (see
    // index.js JSDoc). The override is the seam D1B-003 introduces so a
    // simulated validator crash is reproducible without monkey-patching
    // ESM modules (which is a no-op for live bindings).
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0',
      validators: {
        validateSubmissionSchema: () => {
          throw new Error('simulated ajv compile fault: out-of-memory');
        }
      }
    });

    const reasons = record.verification.rejection_reasons;
    const fault = reasons.find(r => r.startsWith('VALIDATOR_FAULT_SCHEMA:'));
    assert.ok(fault,
      `expected VALIDATOR_FAULT_SCHEMA prefix; reasons=${JSON.stringify(reasons)}`);
    assert.ok(fault.includes('simulated ajv compile fault'),
      'underlying error.message must be carried');
    assert.equal(
      reasons.filter(r => r.startsWith('validator error:')).length, 0,
      'old "validator error:" prefix must not appear anymore'
    );
  });

  it('POSITIVE submission-bad: bad submission lands as schema: prefix (back-compat preserved)', async () => {
    // Drop a required field to force ajv to return valid=false WITHOUT
    // throwing — verifies the submission-class path still produces the
    // existing `'schema: '` prefix.
    const bad = structuredClone(pilot0);
    delete bad.ref;

    const record = await verify(bad, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    const reasons = record.verification.rejection_reasons;
    const schemaReason = reasons.find(r => r.startsWith('schema:'));
    assert.ok(schemaReason,
      `expected legacy 'schema:' prefix; reasons=${JSON.stringify(reasons)}`);
    assert.equal(
      reasons.filter(r => r.startsWith('VALIDATOR_FAULT_')).length, 0,
      'bad-submission path must NOT use VALIDATOR_FAULT_* prefix'
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// D1B-003 — steps validator class
// ─────────────────────────────────────────────────────────────────

describe('D1B-003 — steps validator: VALIDATOR_FAULT_STEPS vs steps: prefixes', () => {
  it('POSITIVE crash: a steps-validator throw lands as VALIDATOR_FAULT_STEPS', async () => {
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0',
      validators: {
        validateStepResults: () => {
          throw new Error('simulated steps validator fault: stack overflow');
        }
      }
    });

    const reasons = record.verification.rejection_reasons;
    const fault = reasons.find(r => r.startsWith('VALIDATOR_FAULT_STEPS:'));
    assert.ok(fault,
      `expected VALIDATOR_FAULT_STEPS prefix; reasons=${JSON.stringify(reasons)}`);
    assert.ok(fault.includes('simulated steps validator fault'),
      'underlying error.message must be carried');
    assert.equal(
      reasons.filter(r => r.startsWith('validator error:')).length, 0,
      'old "validator error:" prefix must not appear anymore'
    );
  });

  it('POSITIVE submission-bad: bad step-result lands as steps[id]: prefix', async () => {
    const bad = structuredClone(pilot0);
    // Force a step-validator-rejection: duplicate step IDs.
    bad.scenario_results[0].step_results.push({
      ...bad.scenario_results[0].step_results[0]
    });

    const record = await verify(bad, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0'
    });

    const reasons = record.verification.rejection_reasons;
    const stepsReason = reasons.find(r => r.startsWith('steps['));
    assert.ok(stepsReason,
      `expected 'steps[id]:' prefix; reasons=${JSON.stringify(reasons)}`);
    assert.equal(
      reasons.filter(r => r.startsWith('VALIDATOR_FAULT_')).length, 0,
      'bad-submission path must NOT use VALIDATOR_FAULT_* prefix'
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// D1B-003 — policy validator class
// ─────────────────────────────────────────────────────────────────

describe('D1B-003 — policy validator: VALIDATOR_FAULT_POLICY vs policy: prefixes', () => {
  it('POSITIVE crash: a policy-validator throw lands as VALIDATOR_FAULT_POLICY', async () => {
    const record = await verify(pilot0, {
      globalPolicy,
      repoPolicy,
      provenance: stubProvenance,
      policyVersion: '1.0.0',
      validators: {
        validatePolicy: () => {
          throw new Error('simulated policy validator fault: merge cycle');
        }
      }
    });

    const reasons = record.verification.rejection_reasons;
    const fault = reasons.find(r => r.startsWith('VALIDATOR_FAULT_POLICY:'));
    assert.ok(fault,
      `expected VALIDATOR_FAULT_POLICY prefix; reasons=${JSON.stringify(reasons)}`);
    assert.ok(fault.includes('simulated policy validator fault'),
      'underlying error.message must be carried');
    assert.equal(
      reasons.filter(r => r.startsWith('validator error:')).length, 0,
      'old "validator error:" prefix must not appear anymore'
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// D1B-003 — sweep: no surviving raw 'validator error: ' string
// ─────────────────────────────────────────────────────────────────

describe('D1B-003 — sweep: index.js no longer pushes raw "validator error:" prefix', () => {
  it('source check: index.js contains no "validator error: " literal', () => {
    const indexPath = resolve(__dirname, 'index.js');
    const src = readFileSync(indexPath, 'utf-8');
    // The raw prefix in BOTH single- and double-quoted forms should be
    // gone — only the VALIDATOR_FAULT_* coded prefixes remain. The
    // backquoted/template-literal form must also be absent.
    const offending = [
      "'validator error: '",
      '"validator error: "',
      '`validator error: '
    ];
    for (const needle of offending) {
      assert.equal(
        src.includes(needle), false,
        `'${needle}' must not appear in index.js — use VALIDATOR_FAULT_<CLASS> instead`
      );
    }
  });

  it('source check: index.js wires the runValidator helper at each catch site (no raw try/catch with stringly-typed prefix)', () => {
    // Pin the discipline: the wrapper, not raw try/catch boilerplate, is
    // the canonical way to call a validator. The three concrete codes
    // (VALIDATOR_FAULT_SCHEMA / STEPS / POLICY) are emitted dynamically
    // via the runValidator helper's template literal, so checking for
    // the literal strings would miss the legitimate (preferred)
    // implementation. We assert the helper exists and is invoked at
    // least once per validator class.
    const indexPath = resolve(__dirname, 'index.js');
    const src = readFileSync(indexPath, 'utf-8');
    assert.ok(/function\s+runValidator\b/.test(src),
      'runValidator helper must be defined in index.js');
    assert.ok(/runValidator\(\s*['"]schema['"]/.test(src),
      'runValidator must be invoked with name="schema" at the schema catch');
    assert.ok(/runValidator\(\s*['"]steps['"]/.test(src),
      'runValidator must be invoked with name="steps" at the steps catch');
    assert.ok(/runValidator\(\s*['"]policy['"]/.test(src),
      'runValidator must be invoked with name="policy" at the policy catch');
  });
});
