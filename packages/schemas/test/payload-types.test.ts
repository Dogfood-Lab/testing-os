/**
 * FT-h — the payload-interface drift seal.
 *
 * `src/payload-types.ts` hand-authors TypeScript interfaces for the four
 * contract payload shapes (Submission, ScenarioResult, Record, Finding). Two
 * independent checks must agree for those interfaces to be trustworthy, and a
 * future schema change that diverges from an interface must break at least one:
 *
 *   1. COMPILE-TIME — a value typed/`satisfies`-checked against the interface
 *      must compile. This file re-asserts `satisfies` on locally-authored
 *      payloads (vitest does not type-check by default, but `npm run verify`
 *      runs `tsc --build` over `src/`, where the load-bearing `satisfies`
 *      consts live; the assertions here document the contract for readers and
 *      fail any `vitest --typecheck` run too).
 *
 *   2. RUNTIME — the SAME payload, pushed through `validatePayload`, must be
 *      judged valid by the JSON schema. This is the half a plain interface
 *      cannot give you: it proves the interface and the schema agree on what a
 *      valid payload looks like, not just that the interface compiles.
 *
 * The two halves catch divergence in opposite directions:
 *   - interface DROPS a required field the schema still demands → the runtime
 *     check on a minimal payload still passes, but a payload that omits it no
 *     longer type-errors; the explicit "missing required field is rejected"
 *     cases below pin the schema side so the gap is visible.
 *   - interface ADDS/renames a field the schema forbids → `satisfies` keeps
 *     compiling but `validatePayload` rejects the example (additionalProperties:
 *     false), turning this suite RED.
 */

import { describe, expect, it } from 'vitest';
import {
  validatePayload,
  EXAMPLE_PAYLOADS,
  type Submission,
  type ScenarioResult,
  type Record,
  type Finding,
} from '../src/index.js';

describe('FT-h payload-types — compile-time + runtime drift seal', () => {
  // -------------------------------------------------------------------------
  // Compile-time: a hand-authored value satisfies each interface. If an
  // interface drifts (a field changes type, a required field is added), THIS
  // FILE stops compiling under tsc/`vitest --typecheck`. The runtime assertion
  // on the same object then proves the schema agrees.
  // -------------------------------------------------------------------------

  it('Submission interface: a satisfies-typed payload validates against the schema', () => {
    const submission = {
      schema_version: '1.0.0',
      run_id: 'run-fth-001',
      repo: 'dogfood-lab/testing-os',
      ref: { commit_sha: 'c'.repeat(40), branch: 'main' },
      source: {
        provider: 'github',
        workflow: 'dogfood.yml',
        provider_run_id: '99',
        run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/99',
      },
      timing: { started_at: '2026-06-21T10:00:00Z', finished_at: '2026-06-21T10:01:00Z' },
      scenario_results: [
        {
          scenario_id: 'cli-smoke',
          product_surface: 'cli',
          execution_mode: 'bot',
          verdict: 'pass',
          step_results: [{ step_id: 'install', status: 'pass' }],
        },
      ],
      overall_verdict: 'pass',
    } satisfies Submission;

    const result = validatePayload('recordSubmission', submission);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('ScenarioResult interface: a satisfies-typed item validates as part of a submission', () => {
    const scenarioResult = {
      scenario_id: 'cli-resolve',
      product_surface: 'cli',
      execution_mode: 'mixed',
      attested_by: 'human-01',
      verdict: 'partial',
      step_results: [{ step_id: 'resolve', status: 'partial', notes: 'slow' }],
      evidence: [{ kind: 'log', url: 'https://example.com/run.log' }],
    } satisfies ScenarioResult;

    // ScenarioResult is not a registered payload schema on its own; it is
    // validated through the envelope it lives in. Embed it in a minimal
    // submission so the JSON schema judges the same object.
    const submission: Submission = {
      ...EXAMPLE_PAYLOADS.submission,
      scenario_results: [scenarioResult],
    };
    const result = validatePayload('recordSubmission', submission);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('Record interface: a satisfies-typed payload validates against the schema', () => {
    const record = {
      schema_version: '1.0.0',
      policy_version: '1.0.0',
      run_id: 'run-fth-002',
      repo: 'dogfood-lab/testing-os',
      ref: { commit_sha: 'd'.repeat(40) },
      source: {
        provider: 'github',
        workflow: 'dogfood.yml',
        provider_run_id: '99',
        run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/99',
      },
      timing: { started_at: '2026-06-21T10:00:00Z', finished_at: '2026-06-21T10:01:00Z' },
      scenario_results: [
        {
          scenario_id: 'cli-smoke',
          product_surface: 'cli',
          execution_mode: 'bot',
          verdict: 'pass',
          step_results: [{ step_id: 'install', status: 'pass' }],
        },
      ],
      overall_verdict: { proposed: 'pass', verified: 'pass', downgraded: false },
      verification: {
        status: 'accepted',
        verified_at: '2026-06-21T10:02:00Z',
        provenance_confirmed: true,
        schema_valid: true,
        policy_valid: true,
      },
    } satisfies Record;

    const result = validatePayload('record', record);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('Finding interface: a satisfies-typed payload validates against the schema', () => {
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-testing-os-fth-payload-types',
      title: 'Payload interfaces shipped with a drift seal',
      status: 'accepted',
      repo: 'dogfood-lab/testing-os',
      product_surface: 'npm-package',
      execution_mode: 'bot',
      journey_stage: 'verification',
      issue_kind: 'schema_mismatch',
      root_cause_kind: 'tooling_gap',
      remediation_kind: 'schema_fix',
      transfer_scope: 'org_wide',
      summary:
        'Hand-authored TypeScript interfaces now mirror the contract payload schemas, sealed by a satisfies + validatePayload pair.',
      source_record_ids: ['testing-os-fth-001'],
      evidence: [{ evidence_kind: 'doc', doc_ref: 'packages/schemas/src/payload-types.ts' }],
    } satisfies Finding;

    const result = validatePayload('finding', finding);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The exported EXAMPLE_PAYLOADS (the same consts the src/ `satisfies` seal
  // guards) must ALL validate. This is the canonical drift tripwire: edit a
  // schema in a way the interface examples no longer satisfy and this goes RED.
  // -------------------------------------------------------------------------

  it('every exported EXAMPLE_PAYLOADS entry validates against its schema', () => {
    expect(validatePayload('recordSubmission', EXAMPLE_PAYLOADS.submission).valid).toBe(true);
    expect(validatePayload('record', EXAMPLE_PAYLOADS.record).valid).toBe(true);
    expect(validatePayload('finding', EXAMPLE_PAYLOADS.finding).valid).toBe(true);

    // ScenarioResult validates only inside an envelope.
    const wrapped: Submission = {
      ...EXAMPLE_PAYLOADS.submission,
      scenario_results: [EXAMPLE_PAYLOADS.scenarioResult],
    };
    expect(validatePayload('recordSubmission', wrapped).valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Schema-side pins: the fields the interfaces mark required are also schema-
  // required. These guard the "interface silently drops a required field"
  // direction the compile-time check alone cannot see — if a future edit makes
  // one of these optional in the schema, the negative case below stops failing
  // and this test goes RED, forcing a conscious interface update.
  // -------------------------------------------------------------------------

  it('schema rejects a Submission missing run_id (interface marks it required)', () => {
    const { run_id: _omit, ...bad } = EXAMPLE_PAYLOADS.submission;
    const result = validatePayload('recordSubmission', bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /run_id/.test(JSON.stringify(e.params)))).toBe(true);
  });

  it('schema rejects a Record missing the verifier-owned verification block', () => {
    const { verification: _omit, ...bad } = EXAMPLE_PAYLOADS.record;
    const result = validatePayload('record', bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /verification/.test(JSON.stringify(e.params)))).toBe(true);
  });

  it('schema rejects a Finding with empty evidence (interface types it minItems:1)', () => {
    const bad: Finding = { ...EXAMPLE_PAYLOADS.finding, evidence: [] };
    const result = validatePayload('finding', bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path.includes('/evidence'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCHEMA-A-002 — the two record.verification mirrors that had drifted from
// dogfood-record.schema.json in spots the satisfies + validatePayload seal
// could not catch, because EXAMPLE_RECORD exercised NEITHER field:
//   (a) Verification OMITTED the optional `warnings?: string[]` the schema defines
//   (b) ProvenanceRemediation.status was `status?` while the schema REQUIRES it
// EXAMPLE_RECORD now references both, so both halves of the seal see them: the
// compile-time `satisfies` (warnings excess-property pin + the status-required
// pin in src/payload-types.ts) and the runtime validatePayload assertions here.
// ---------------------------------------------------------------------------

describe('SCHEMA-A-002 — record.verification TS mirror drift seal', () => {
  it('SCHEMA-A-002: EXAMPLE_RECORD exercises verification.warnings + provenance_remediation.status and still validates', () => {
    const v = EXAMPLE_PAYLOADS.record.verification;

    // Before the fix these fields were absent from the example, so the interface
    // could omit `warnings` and mark `status` optional with every check green.
    expect(Array.isArray(v.warnings)).toBe(true);
    expect(v.warnings?.length).toBeGreaterThan(0);
    expect(v.provenance_remediation?.status).toBe('stub_verified');

    // Runtime half: the JSON schema agrees the extended example is valid —
    // `warnings` is an allowed optional array and the remediation block carries
    // its schema-required `status` + `remediated_at`.
    const result = validatePayload('record', EXAMPLE_PAYLOADS.record);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('SCHEMA-A-002: schema REQUIRES provenance_remediation.status (interface mirrors it non-optional)', () => {
    const bad = structuredClone(EXAMPLE_PAYLOADS.record);
    const remediation = bad.verification.provenance_remediation!;
    delete (remediation as Partial<typeof remediation>).status;

    const result = validatePayload('record', bad);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(e => e.keyword === 'required' && e.params?.missingProperty === 'status'),
    ).toBe(true);
  });

  it('SCHEMA-A-002: verification.warnings is schema-OPTIONAL (interface mirrors it as `warnings?`)', () => {
    const withoutWarnings = structuredClone(EXAMPLE_PAYLOADS.record);
    delete (withoutWarnings.verification as { warnings?: unknown }).warnings;
    expect(validatePayload('record', withoutWarnings).valid).toBe(true);
  });
});
