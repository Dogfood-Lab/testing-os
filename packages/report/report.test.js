import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSubmission, precheckSubmission } from './build-submission.js';

const BASE_PARAMS = {
  repo: 'mcp-tool-shop-org/dogfood-labs',
  commitSha: 'a'.repeat(40),
  branch: 'main',
  workflow: 'dogfood.yml',
  providerRunId: '12345',
  runUrl: 'https://github.com/mcp-tool-shop-org/dogfood-labs/actions/runs/12345',
  actor: 'ci-bot',
  startedAt: '2026-03-19T15:00:00Z',
  finishedAt: '2026-03-19T15:01:00Z',
  scenarioResults: [
    {
      scenario_id: 'record-ingest-roundtrip',
      scenario_name: 'Record ingest roundtrip',
      scenario_version: '1.0.0',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [
        { step_id: 'emit-submission', status: 'pass' },
        { step_id: 'verify-schema', status: 'pass' }
      ],
      evidence: [
        { kind: 'log', url: 'https://example.com/log' }
      ]
    }
  ],
  overallVerdict: 'pass',
  notes: 'Test run'
};

// ── Builder ────────────────────────────────────────────────────

describe('submission builder', () => {
  it('builds a valid submission from params', () => {
    const submission = buildSubmission(BASE_PARAMS);

    assert.equal(submission.schema_version, '1.0.0');
    assert.ok(submission.run_id);
    assert.equal(submission.repo, 'mcp-tool-shop-org/dogfood-labs');
    assert.equal(submission.ref.commit_sha, 'a'.repeat(40));
    assert.equal(submission.source.provider, 'github');
    assert.equal(submission.source.provider_run_id, '12345');
    assert.equal(submission.overall_verdict, 'pass');
    assert.equal(submission.scenario_results.length, 1);
    assert.equal(submission.timing.duration_ms, 60000);
  });

  it('generates unique run_ids', () => {
    const a = buildSubmission(BASE_PARAMS);
    const b = buildSubmission(BASE_PARAMS);
    assert.notEqual(a.run_id, b.run_id);
  });

  it('omits optional fields when not provided', () => {
    const minimal = buildSubmission({
      ...BASE_PARAMS,
      version: undefined,
      ciChecks: undefined,
      notes: undefined
    });
    assert.ok(!('version' in minimal.ref));
    assert.ok(!('ci_checks' in minimal));
    assert.ok(!('notes' in minimal));
  });

  it('includes ci_checks when provided', () => {
    const withCI = buildSubmission({
      ...BASE_PARAMS,
      ciChecks: [{ id: 'tests', kind: 'test', status: 'pass', value: 10 }]
    });
    assert.equal(withCI.ci_checks.length, 1);
  });
});

// F-882513-002 — duration_ms must be omitted (never null) when timing is invalid,
// so the result satisfies dogfood-record-submission.schema.json's
// `duration_ms: { type: 'integer', minimum: 0 }` contract.
describe('submission timing.duration_ms (F-882513-002)', () => {
  it('includes duration_ms as positive integer when timing is valid', () => {
    const sub = buildSubmission(BASE_PARAMS);
    assert.equal(sub.timing.duration_ms, 60000);
    assert.equal(Number.isInteger(sub.timing.duration_ms), true);
  });

  it('omits duration_ms when finishedAt is unparseable (NaN)', () => {
    const sub = buildSubmission({
      ...BASE_PARAMS,
      finishedAt: 'not-a-date'
    });
    assert.ok(!('duration_ms' in sub.timing),
      `duration_ms should be omitted, got ${JSON.stringify(sub.timing.duration_ms)}`);
  });

  it('omits duration_ms when finishedAt < startedAt (negative)', () => {
    const sub = buildSubmission({
      ...BASE_PARAMS,
      startedAt: '2026-03-19T15:01:00Z',
      finishedAt: '2026-03-19T15:00:00Z'
    });
    assert.ok(!('duration_ms' in sub.timing),
      `duration_ms should be omitted, got ${JSON.stringify(sub.timing.duration_ms)}`);
  });

  it('never serializes duration_ms as null', () => {
    const sub = buildSubmission({
      ...BASE_PARAMS,
      finishedAt: 'garbage'
    });
    assert.notEqual(sub.timing.duration_ms, null);
    const json = JSON.stringify(sub);
    assert.equal(json.includes('"duration_ms":null'), false,
      'submission JSON must not contain "duration_ms":null');
  });
});

// ── Precheck ───────────────────────────────────────────────────

describe('submission precheck', () => {
  it('passes valid submission', () => {
    const submission = buildSubmission(BASE_PARAMS);
    const result = precheckSubmission(submission);
    assert.equal(result.valid, true, `errors: ${result.errors.join(', ')}`);
  });

  it('rejects missing schema_version', () => {
    const bad = buildSubmission(BASE_PARAMS);
    delete bad.schema_version;
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('schema_version')));
  });

  it('rejects missing scenario_results', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.scenario_results = [];
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('scenario_results')));
  });

  it('rejects verifier-owned field: policy_version', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.policy_version = '1.0.0';
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('policy_version')));
  });

  it('rejects verifier-owned field: verification', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.verification = { status: 'accepted' };
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('verification')));
  });

  it('rejects overall_verdict as object', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.overall_verdict = { proposed: 'pass', verified: 'pass' };
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('overall_verdict')));
  });

  it('rejects missing commit_sha', () => {
    const bad = buildSubmission(BASE_PARAMS);
    delete bad.ref.commit_sha;
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('commit_sha')));
  });

  // ── F-246817-006 — precheck must mirror the central verifier ─────────
  //
  // Pre-fix precheck was a partial mirror of the wire schema and let
  // known-bad payloads through that the central verifier would reject:
  //   - step_id pattern '^[a-z0-9][a-z0-9-]*$'
  //   - product_surface enum
  //   - execution_mode enum
  //   - verdict enum
  //   - schema_version pattern '^\\d+\\.\\d+\\.\\d+$'
  // After the fix, precheck delegates to validatePayload from
  // @dogfood-lab/schemas and catches all of these locally.

  it('rejects step_id with capital letters and spaces (pattern, F-246817-006)', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.scenario_results[0].step_results = [
      { step_id: 'Verify Schema', status: 'pass' }
    ];
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false,
      'precheck must reject step_id that fails the schema pattern');
    assert.ok(result.errors.some(e => e.includes('step_id') || e.includes('pattern')),
      `error should mention step_id/pattern, got: ${result.errors.join(' | ')}`);
  });

  it('rejects unknown product_surface (enum, F-246817-006)', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.scenario_results[0].product_surface = 'mainframe';
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false,
      'precheck must reject product_surface outside the schema enum');
    assert.ok(result.errors.some(e => e.includes('product_surface') || e.includes('enum')),
      `error should mention product_surface/enum, got: ${result.errors.join(' | ')}`);
  });

  it('rejects unknown execution_mode (enum, F-246817-006)', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.scenario_results[0].execution_mode = 'cyborg';
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false,
      'precheck must reject execution_mode outside the schema enum');
    assert.ok(result.errors.some(e => e.includes('execution_mode') || e.includes('enum')),
      `error should mention execution_mode/enum, got: ${result.errors.join(' | ')}`);
  });

  it('rejects unknown verdict (enum, F-246817-006)', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.scenario_results[0].verdict = 'meh';
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false,
      'precheck must reject scenario verdict outside the schema enum');
    assert.ok(result.errors.some(e => e.includes('verdict') || e.includes('enum')),
      `error should mention verdict/enum, got: ${result.errors.join(' | ')}`);
  });

  it('rejects malformed schema_version (pattern, F-246817-006)', () => {
    const bad = buildSubmission(BASE_PARAMS);
    bad.schema_version = 'one-point-oh';
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false,
      'precheck must reject schema_version that fails the semver pattern');
    assert.ok(result.errors.some(e => e.includes('schema_version') || e.includes('pattern')),
      `error should mention schema_version/pattern, got: ${result.errors.join(' | ')}`);
  });

  it('rejects missing scenario_id (required field, F-246817-006)', () => {
    const bad = buildSubmission(BASE_PARAMS);
    delete bad.scenario_results[0].scenario_id;
    const result = precheckSubmission(bad);
    assert.equal(result.valid, false,
      'precheck must reject scenario_results entry missing scenario_id');
    assert.ok(result.errors.some(e => e.includes('scenario_id')),
      `error should mention scenario_id, got: ${result.errors.join(' | ')}`);
  });

  // ── F-721047-001 — null/non-object guard ──────────────────────────────
  //
  // Pre-fix `precheckSubmission(null)` threw `TypeError: Cannot use 'in'
  // operator to search for 'policy_version' in null` because the
  // VERIFIER_OWNED_FIELDS loop dereferenced the argument before the function
  // could return its documented {valid, errors} shape. Wave-8 F-246817-001
  // established the clean-rejection-not-crash philosophy; wave-9 imported
  // validatePayload but didn't add the null guard. These tests pin the
  // restored contract.

  it('rejects null submission with structured shape (F-721047-001)', () => {
    const result = precheckSubmission(null);
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.some(e => e.includes('null')),
      `error should mention null, got: ${result.errors.join(' | ')}`);
  });

  it('rejects undefined submission with structured shape (F-721047-001)', () => {
    const result = precheckSubmission(undefined);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('undefined')),
      `error should mention undefined, got: ${result.errors.join(' | ')}`);
  });

  it('rejects string submission with structured shape (F-721047-001)', () => {
    const result = precheckSubmission('not a submission');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('string')),
      `error should mention string, got: ${result.errors.join(' | ')}`);
  });

  it('rejects number submission with structured shape (F-721047-001)', () => {
    const result = precheckSubmission(42);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('number')),
      `error should mention number, got: ${result.errors.join(' | ')}`);
  });

  it('rejects array submission with structured shape (F-721047-001)', () => {
    const result = precheckSubmission([]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('array')),
      `error should mention array, got: ${result.errors.join(' | ')}`);
  });

  it('passes mixed/human submission with attested_by and evidence', () => {
    const mixed = buildSubmission({
      ...BASE_PARAMS,
      scenarioResults: [
        {
          scenario_id: 'export-roundtrip-16x16',
          scenario_name: 'Export roundtrip',
          scenario_version: '1.0.0',
          product_surface: 'desktop',
          execution_mode: 'mixed',
          attested_by: 'mike',
          verdict: 'pass',
          step_results: [
            { step_id: 'export-png', status: 'pass' },
            { step_id: 'reimport', status: 'pass' }
          ],
          evidence: [
            { kind: 'screenshot', url: 'https://example.com/screenshot.png' },
            { kind: 'artifact', url: 'https://example.com/export.png' }
          ],
          notes: 'Manual export verified'
        }
      ]
    });
    const result = precheckSubmission(mixed);
    assert.equal(result.valid, true, `errors: ${result.errors.join(', ')}`);
    assert.equal(mixed.scenario_results[0].attested_by, 'mike');
    assert.equal(mixed.scenario_results[0].evidence.length, 2);
  });
});
