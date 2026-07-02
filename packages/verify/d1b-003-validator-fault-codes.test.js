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
 *   - Validator-crashed → verify() THROWS a classified error whose message
 *     carries `'VALIDATOR_FAULT_<CLASS>: …'` and whose `.code` is
 *     `VALIDATOR_FAULT_<CLASS>`. (F-82429f90, wave 4: this superseded the
 *     original push-into-rejection_reasons behavior — persisting a
 *     validator crash as a `_rejected` record permanently poisoned the
 *     run_id via ingest's duplicate guard. Operational faults now
 *     propagate: both production callers map a verify() throw to exit 2
 *     with NOTHING persisted, so a clean resubmission after recovery is
 *     accepted.)
 *
 * Invariant (both halves enforced for each class):
 *   1. POSITIVE (validator-crashed): force the inner validator function to
 *      throw → verify() rejects with a `VALIDATOR_FAULT_<CLASS>` coded
 *      error whose message carries the underlying detail.
 *   2. POSITIVE (submission-bad): force a clean submission-rejection signal
 *      → `rejection_reasons` carries the existing `'<class>: '` prefix and
 *      NO fault is thrown.
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
  it('POSITIVE crash: a validator-internal throw PROPAGATES as a coded VALIDATOR_FAULT_SCHEMA fault (F-82429f90)', async () => {
    // Inject a fault via the test-only `validators` override hook (see
    // index.js JSDoc). The override is the seam D1B-003 introduces so a
    // simulated validator crash is reproducible without monkey-patching
    // ESM modules (which is a no-op for live bindings).
    await assert.rejects(
      verify(pilot0, {
        globalPolicy,
        repoPolicy,
        provenance: stubProvenance,
        policyVersion: '1.0.0',
        validators: {
          validateSubmissionSchema: () => {
            throw new Error('simulated ajv compile fault: out-of-memory');
          }
        }
      }),
      (err) => {
        assert.equal(err.code, 'VALIDATOR_FAULT_SCHEMA',
          `expected code VALIDATOR_FAULT_SCHEMA; got ${err.code} (${err.message})`);
        assert.match(err.message, /^VALIDATOR_FAULT_SCHEMA: /,
          'message must carry the greppable coded prefix');
        assert.ok(err.message.includes('simulated ajv compile fault'),
          'underlying error.message must be carried');
        return true;
      },
      'a validator crash is operational — it must propagate, never assemble a persisted rejected record'
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
  it('POSITIVE crash: a steps-validator throw PROPAGATES as a coded VALIDATOR_FAULT_STEPS fault (F-82429f90)', async () => {
    await assert.rejects(
      verify(pilot0, {
        globalPolicy,
        repoPolicy,
        provenance: stubProvenance,
        policyVersion: '1.0.0',
        validators: {
          validateStepResults: () => {
            throw new Error('simulated steps validator fault: stack overflow');
          }
        }
      }),
      (err) => {
        assert.equal(err.code, 'VALIDATOR_FAULT_STEPS');
        assert.match(err.message, /^VALIDATOR_FAULT_STEPS: /);
        assert.ok(err.message.includes('simulated steps validator fault'),
          'underlying error.message must be carried');
        return true;
      }
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
  it('POSITIVE crash: a policy-validator throw PROPAGATES as a coded VALIDATOR_FAULT_POLICY fault (F-82429f90)', async () => {
    await assert.rejects(
      verify(pilot0, {
        globalPolicy,
        repoPolicy,
        provenance: stubProvenance,
        policyVersion: '1.0.0',
        validators: {
          validatePolicy: () => {
            throw new Error('simulated policy validator fault: merge cycle');
          }
        }
      }),
      (err) => {
        assert.equal(err.code, 'VALIDATOR_FAULT_POLICY');
        assert.match(err.message, /^VALIDATOR_FAULT_POLICY: /);
        assert.ok(err.message.includes('simulated policy validator fault'),
          'underlying error.message must be carried');
        return true;
      }
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
