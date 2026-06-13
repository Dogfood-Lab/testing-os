/**
 * parse-rejection.test.js
 *
 * F1-CONTRACTS-003 (Wave 4, MED) — parseRejectionReason consumability.
 *
 * `verify/index.js` emits `verification.rejection_reasons` as an array of
 * STRINGS with stable prefixes. Operators discriminate failure class with
 * hand-rolled `.startsWith()` chains (see the old README "Operator hygiene"
 * block). Nothing exported a parser, so every consumer re-implemented the same
 * prefix taxonomy — a fresh drift source the moment a prefix is added.
 *
 * `parseRejectionReason(reason)` returns `{ class, prefix, detail }` where
 * `class` is one of:
 *   - 'submission-bad' — the submitter must fix and resubmit
 *       (schema / policy / steps / provenance / repo /
 *        submission-contains-verifier-field / CONTRACT_SCHEMA_TOO_NEW /
 *        CONTRACT_SCHEMA_TOO_OLD)
 *   - 'operational'    — the verifier/tooling faulted (VALIDATOR_FAULT_*)
 *   - 'ingest'         — ingest-side load fault (scenario-load)
 *   - 'unknown'        — unrecognized prefix
 *
 * The prefix set is enumerated from the ACTUAL emitters: verify/index.js,
 * validators/schema-version.js, and packages/ingest/run.js — not invented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRejectionReason } from './parse-rejection.js';

describe('parseRejectionReason (F1-CONTRACTS-003)', () => {
  // Each tuple: [reason string emitted by a real source, expected class, expected prefix]
  const cases = [
    // submission-bad — the submitter fixes the payload
    ['schema: /repo must be string', 'submission-bad', 'schema:'],
    ['policy: forbidden tag "wip"', 'submission-bad', 'policy:'],
    ['steps[step-1]: gate accumulation violated', 'submission-bad', 'steps[<id>]:'],
    ['provenance: source run could not be confirmed', 'submission-bad', 'provenance:'],
    [
      'repo:mismatch: submission.repo (a/b) does not match source.run_url repo (c/d)',
      'submission-bad',
      'repo:',
    ],
    [
      'submission-contains-verifier-field: verification',
      'submission-bad',
      'submission-contains-verifier-field:',
    ],
    [
      'CONTRACT_SCHEMA_TOO_NEW: recordSubmission schema v2.0.0 but this build supports v1.0.0',
      'submission-bad',
      'CONTRACT_SCHEMA_TOO_NEW:',
    ],
    [
      'CONTRACT_SCHEMA_TOO_OLD: recordSubmission schema v0.9.0 is below the supported floor',
      'submission-bad',
      'CONTRACT_SCHEMA_TOO_OLD:',
    ],

    // operational — the verifier itself faulted
    ['VALIDATOR_FAULT_SCHEMA: ajv compile failed', 'operational', 'VALIDATOR_FAULT_SCHEMA:'],
    ['VALIDATOR_FAULT_POLICY: merge cycle', 'operational', 'VALIDATOR_FAULT_POLICY:'],
    ['VALIDATOR_FAULT_STEPS: out of memory', 'operational', 'VALIDATOR_FAULT_STEPS:'],
    [
      'VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION: unknown contract "frobnicate"',
      'operational',
      'VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION:',
    ],

    // ingest — scenario load fault (ingest/run.js)
    ['scenario-load: not_found scenario-x', 'ingest', 'scenario-load:'],
  ];

  for (const [reason, expectedClass, expectedPrefix] of cases) {
    it(`maps "${reason.slice(0, 40)}…" → ${expectedClass} (${expectedPrefix})`, () => {
      const parsed = parseRejectionReason(reason);
      assert.equal(parsed.class, expectedClass, `class for: ${reason}`);
      assert.equal(parsed.prefix, expectedPrefix, `prefix for: ${reason}`);
    });
  }

  it('classifies the wave-2 CONTRACT_SCHEMA_TOO_NEW as submission-bad (not operational)', () => {
    const parsed = parseRejectionReason(
      'CONTRACT_SCHEMA_TOO_NEW: recordSubmission schema v2.0.0 — upgrade testing-os',
    );
    assert.equal(parsed.class, 'submission-bad');
    assert.equal(parsed.prefix, 'CONTRACT_SCHEMA_TOO_NEW:');
  });

  it('returns the detail with the prefix stripped', () => {
    const parsed = parseRejectionReason('schema: /repo must be string');
    assert.equal(parsed.detail, '/repo must be string');
  });

  it('strips the steps[<id>] prefix down to the bracketed id and detail intact', () => {
    const parsed = parseRejectionReason('steps[step-7]: ordering violated');
    assert.equal(parsed.class, 'submission-bad');
    assert.equal(parsed.prefix, 'steps[<id>]:');
    // The concrete `steps[step-7]:` is consumed; the human detail remains.
    assert.equal(parsed.detail, 'ordering violated');
  });

  it('maps an unrecognized prefix to unknown with the whole string as detail', () => {
    const parsed = parseRejectionReason('gremlins: something weird happened');
    assert.equal(parsed.class, 'unknown');
    assert.equal(parsed.prefix, null);
    assert.equal(parsed.detail, 'gremlins: something weird happened');
  });

  it('maps the bare null-submission reason (no prefix) to unknown', () => {
    // verify/index.js emits this prefix-less reason for null/non-object input.
    const parsed = parseRejectionReason('submission is null or not an object');
    assert.equal(parsed.class, 'unknown');
    assert.equal(parsed.prefix, null);
  });

  it('is defensive against non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const parsed = parseRejectionReason(bad);
      assert.equal(parsed.class, 'unknown');
      assert.equal(parsed.prefix, null);
    }
  });

  it('is exported from the package root (index.js) too', async () => {
    const mod = await import('./index.js');
    assert.equal(typeof mod.parseRejectionReason, 'function');
    assert.equal(mod.parseRejectionReason('schema: x').class, 'submission-bad');
  });
});
