/**
 * Ajv-validation harness for the eight contract schemas.
 *
 * Closes the gap that wave-1 F-005 raised and that wave-8 F-246817-002 amended:
 * the schemas package owns the contracts but historically only checked shape
 * (URI, title, required-array membership) without ever compiling a schema or
 * pushing a payload through validation. A schema-side regression — changed
 * pattern, dropped required, opened additionalProperties, broken $defs ref —
 * shipped green from this package and broke every consumer downstream.
 *
 * Coverage rule: each of the eight schemas gets at least one positive case
 * (a representative valid payload) and at least one negative case (a payload
 * that fails validation with the expected error path).
 */

import { describe, expect, it } from 'vitest';
import {
  compileSchema,
  validatePayload,
  type SchemaName,
} from '../src/index.js';

function expectError(
  result: ReturnType<typeof validatePayload>,
  predicate: (err: { path: string; message: string }) => boolean
): void {
  expect(result.valid, `expected invalid but got valid. Errors: ${JSON.stringify(result.errors)}`).toBe(false);
  expect(
    result.errors.some(predicate),
    `no matching error found. Got: ${JSON.stringify(result.errors)}`
  ).toBe(true);
}

describe('@dogfood-lab/schemas validation harness', () => {
  describe('compileSchema', () => {
    it('compiles every named schema without throwing', () => {
      const names: SchemaName[] = [
        'record',
        'recordSubmission',
        'finding',
        'pattern',
        'recommendation',
        'doctrine',
        'policy',
        'scenario',
      ];
      for (const name of names) {
        expect(() => compileSchema(name), `failed to compile ${name}`).not.toThrow();
      }
    });

    it('returns the same compiled validator on repeat calls (cache hit)', () => {
      const a = compileSchema('finding');
      const b = compileSchema('finding');
      expect(a).toBe(b);
    });

    it('throws on an unknown schema name', () => {
      expect(() => compileSchema('not-a-schema' as SchemaName)).toThrow(/Unknown schema/);
    });
  });

  // ---------------------------------------------------------------------------
  // recordSubmission — source-authored payload (no verification block)
  // ---------------------------------------------------------------------------

  describe('recordSubmission schema', () => {
    const valid = {
      schema_version: '1.0.0',
      run_id: 'run-01H8Y4ZC9XJWQ5N6',
      repo: 'dogfood-lab/testing-os',
      ref: { commit_sha: 'a'.repeat(40), branch: 'main' },
      source: {
        provider: 'github',
        workflow: 'dogfood.yml',
        provider_run_id: '12345',
        run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
      },
      timing: {
        started_at: '2026-04-26T18:00:00Z',
        finished_at: '2026-04-26T18:05:00Z',
      },
      scenario_results: [
        {
          scenario_id: 'cli-resolve-and-list',
          product_surface: 'cli',
          execution_mode: 'bot',
          verdict: 'pass',
          step_results: [{ step_id: 'install', status: 'pass' }],
        },
      ],
      overall_verdict: 'pass',
    };

    it('accepts a representative valid submission', () => {
      const result = validatePayload('recordSubmission', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a missing required field (run_id)', () => {
      const { run_id: _, ...bad } = valid;
      const result = validatePayload('recordSubmission', bad);
      expectError(result, e => /required/i.test(e.message) && /run_id/.test(JSON.stringify(e.params)));
    });

    it('rejects a malformed commit_sha (pattern violation)', () => {
      const bad = { ...valid, ref: { commit_sha: 'not-a-sha' } };
      const result = validatePayload('recordSubmission', bad);
      expectError(result, e => e.path.includes('/ref/commit_sha'));
    });

    it('rejects an unknown product_surface enum', () => {
      const bad = {
        ...valid,
        scenario_results: [
          { ...valid.scenario_results[0], product_surface: 'mainframe' },
        ],
      };
      const result = validatePayload('recordSubmission', bad);
      expectError(result, e => e.path.includes('product_surface') && /allowed values/.test(e.message));
    });
  });

  // ---------------------------------------------------------------------------
  // record — verifier-authored persisted record (envelope + verification)
  // ---------------------------------------------------------------------------

  describe('record schema (persisted)', () => {
    const valid = {
      schema_version: '1.0.0',
      policy_version: '1.0.0',
      run_id: 'run-01H8Y4ZC9XJWQ5N6',
      repo: 'dogfood-lab/testing-os',
      ref: { commit_sha: 'b'.repeat(40) },
      source: {
        provider: 'github',
        workflow: 'dogfood.yml',
        provider_run_id: '12345',
        run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
      },
      timing: {
        started_at: '2026-04-26T18:00:00Z',
        finished_at: '2026-04-26T18:05:00Z',
      },
      scenario_results: [
        {
          scenario_id: 'cli-resolve-and-list',
          product_surface: 'cli',
          execution_mode: 'bot',
          verdict: 'pass',
          step_results: [{ step_id: 'install', status: 'pass' }],
        },
      ],
      overall_verdict: { proposed: 'pass', verified: 'pass' },
      verification: {
        status: 'accepted',
        verified_at: '2026-04-26T18:06:00Z',
        provenance_confirmed: true,
        schema_valid: true,
        policy_valid: true,
      },
    };

    it('accepts a representative valid persisted record', () => {
      const result = validatePayload('record', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a record missing the verifier-owned verification block', () => {
      const { verification: _, ...bad } = valid;
      const result = validatePayload('record', bad);
      expectError(result, e => /required/i.test(e.message) && /verification/.test(JSON.stringify(e.params)));
    });

    it('rejects a partial provenance_remediation (missing remediated_at)', () => {
      const bad = {
        ...valid,
        verification: {
          ...valid.verification,
          provenance_remediation: {
            status: 'stub_verified',
            // remediated_at intentionally missing — this is the F-246817-001
            // near-miss that motivated this whole harness.
          },
        },
      };
      const result = validatePayload('record', bad);
      expectError(result, e => /required/i.test(e.message) && /remediated_at/.test(JSON.stringify(e.params)));
    });
  });

  // ---------------------------------------------------------------------------
  // finding — accepted lesson
  // ---------------------------------------------------------------------------

  describe('finding schema', () => {
    const valid = {
      schema_version: '1.0.0',
      finding_id: 'dfind-testing-os-schemas-validation-gap',
      title: 'Schemas package had no Ajv-validation tests',
      status: 'accepted',
      repo: 'dogfood-lab/testing-os',
      product_surface: 'npm-package',
      journey_stage: 'verification',
      issue_kind: 'verification_gap',
      root_cause_kind: 'tooling_gap',
      remediation_kind: 'verification_fix',
      transfer_scope: 'org_wide',
      summary:
        'The schemas package shipped with shape-only tests; no payload was ever compiled or validated, so contract drift was invisible.',
      source_record_ids: ['testing-os-w8-001'],
      evidence: [{ evidence_kind: 'doc', doc_ref: 'packages/schemas/test/validate.test.ts' }],
    };

    it('accepts a representative valid finding', () => {
      const result = validatePayload('finding', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a finding_id that violates the dfind- pattern', () => {
      const bad = { ...valid, finding_id: 'NOT_A_DFIND_ID' };
      const result = validatePayload('finding', bad);
      expectError(result, e => e.path.includes('/finding_id'));
    });

    it('rejects an empty source_record_ids array (minItems: 1)', () => {
      const bad = { ...valid, source_record_ids: [] };
      const result = validatePayload('finding', bad);
      expectError(result, e => e.path.includes('/source_record_ids'));
    });

    it('rejects an unknown additional property (additionalProperties: false)', () => {
      const bad = { ...valid, sneaky_field: 'should-not-be-allowed' };
      const result = validatePayload('finding', bad);
      expectError(result, e => /additional/i.test(e.message));
    });
  });

  // ---------------------------------------------------------------------------
  // pattern — recurring lesson backed by ≥2 findings
  // ---------------------------------------------------------------------------

  describe('pattern schema', () => {
    const valid = {
      schema_version: '1.0.0',
      pattern_id: 'dpat-build-output-mismatch',
      title: 'TypeScript CLIs ship source instead of dist',
      status: 'accepted',
      pattern_kind: 'recurring_failure',
      summary:
        'Multiple TypeScript CLI repos shipped scenarios that exercised src/ instead of the built dist/ entrypoint.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2 },
      dimensions: { issue_kinds: ['build_output_mismatch'] },
      transfer_scope: 'surface_archetype',
    };

    it('accepts a representative valid pattern', () => {
      const result = validatePayload('pattern', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a pattern with only one source_finding_id (minItems: 2)', () => {
      const bad = { ...valid, source_finding_ids: ['dfind-only-one'] };
      const result = validatePayload('pattern', bad);
      expectError(result, e => e.path.includes('/source_finding_ids'));
    });

    it('rejects a support.finding_count < 2', () => {
      const bad = { ...valid, support: { finding_count: 1, repo_count: 1 } };
      const result = validatePayload('pattern', bad);
      expectError(result, e => e.path.includes('/support/finding_count'));
    });
  });

  // ---------------------------------------------------------------------------
  // recommendation — actionable guidance derived from patterns
  // ---------------------------------------------------------------------------

  describe('recommendation schema', () => {
    const valid = {
      schema_version: '1.0.0',
      recommendation_id: 'drec-build-before-scenario',
      title: 'Run npm build before invoking dogfood scenarios',
      status: 'accepted',
      recommendation_kind: 'verification_rule',
      summary:
        'TypeScript CLI dogfood workflows must run the build step before the scenario invokes the published entrypoint.',
      applies_to: { product_surfaces: ['cli'] },
      based_on_pattern_ids: ['dpat-build-output-mismatch'],
      action: {
        type: 'add_check',
        target: '.github/workflows/dogfood.yml',
        details: 'Add "npm run build" as a step before scenario invocation.',
      },
    };

    it('accepts a representative valid recommendation', () => {
      const result = validatePayload('recommendation', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects an unknown action.type enum', () => {
      const bad = { ...valid, action: { ...valid.action, type: 'launch_missiles' } };
      const result = validatePayload('recommendation', bad);
      expectError(result, e => e.path.includes('/action/type'));
    });

    it('rejects a missing required action object', () => {
      const { action: _, ...bad } = valid;
      const result = validatePayload('recommendation', bad);
      expectError(result, e => /required/i.test(e.message) && /action/.test(JSON.stringify(e.params)));
    });
  });

  // ---------------------------------------------------------------------------
  // doctrine — hardened portfolio rule
  // ---------------------------------------------------------------------------

  describe('doctrine schema', () => {
    const valid = {
      schema_version: '1.0.0',
      doctrine_id: 'ddoc-built-artifact-truth',
      title: 'Scenarios must exercise built artifacts',
      status: 'accepted',
      doctrine_kind: 'verification_law',
      statement:
        'Dogfood scenarios for compiled languages must invoke the built artifact, never source files.',
      rationale:
        'Multiple repos shipped scenarios that ran against src/, hiding build-config drift from CI.',
      based_on_pattern_ids: ['dpat-build-output-mismatch'],
      transfer_scope: 'org_wide',
    };

    it('accepts a representative valid doctrine', () => {
      const result = validatePayload('doctrine', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a transfer_scope of repo_local (doctrine is portfolio-wide only)', () => {
      const bad = { ...valid, transfer_scope: 'repo_local' };
      const result = validatePayload('doctrine', bad);
      expectError(result, e => e.path.includes('/transfer_scope'));
    });

    it('rejects a too-short statement (minLength: 20)', () => {
      const bad = { ...valid, statement: 'too short' };
      const result = validatePayload('doctrine', bad);
      expectError(result, e => e.path.includes('/statement'));
    });
  });

  // ---------------------------------------------------------------------------
  // policy — global flavor (no repo field)
  // ---------------------------------------------------------------------------

  describe('policy schema (global)', () => {
    const valid = {
      policy_version: '1.0.0',
      enforcement: { mode: 'required' },
      defaults: {
        freshness: { max_age_days: 30, warn_age_days: 14 },
        ci_requirements: { coverage_min: null, tests_must_pass: true },
      },
      stale_thresholds: { critical: 90, warning: 30, healthy: 7 },
      global_rules: [
        { id: 'must-have-evidence', severity: 'reject', description: 'Every accepted record needs evidence.' },
      ],
    };

    it('accepts a representative valid global policy', () => {
      const result = validatePayload('policy', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects an unknown enforcement.mode enum', () => {
      const bad = { ...valid, enforcement: { mode: 'optional' } };
      const result = validatePayload('policy', bad);
      expectError(result, e => e.path.includes('/enforcement/mode'));
    });

    it('rejects a stale_thresholds value below minimum 1', () => {
      const bad = { ...valid, stale_thresholds: { ...valid.stale_thresholds, critical: 0 } };
      const result = validatePayload('policy', bad);
      expectError(result, e => e.path.includes('/stale_thresholds/critical'));
    });
  });

  // ---------------------------------------------------------------------------
  // policy — repo flavor (with repo field + surfaces)
  // ---------------------------------------------------------------------------

  describe('policy schema (repo)', () => {
    const valid = {
      repo: 'dogfood-lab/testing-os',
      policy_version: '1.0.0',
      surfaces: {
        'npm-package': {
          required_scenarios: ['publish-and-install'],
          freshness: { max_age_days: 30 },
          execution_mode_policy: { allowed: ['bot', 'mixed'] },
        },
      },
    };

    it('accepts a representative valid repo policy', () => {
      const result = validatePayload('policy', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a malformed repo (missing org/name slash)', () => {
      const bad = { ...valid, repo: 'just-a-name' };
      const result = validatePayload('policy', bad);
      expectError(result, e => e.path.includes('/repo'));
    });

    it('rejects a surfaces key that is not in the product_surface enum (propertyNames)', () => {
      const bad = {
        ...valid,
        surfaces: { mainframe: { required_scenarios: [] } },
      };
      const result = validatePayload('policy', bad);
      expectError(result, e => /property name must be valid|allowed values/i.test(e.message));
    });
  });

  // ---------------------------------------------------------------------------
  // scenario — authored exercise definition
  // ---------------------------------------------------------------------------

  describe('scenario schema', () => {
    const valid = {
      scenario_id: 'cli-resolve-and-list',
      scenario_name: 'Resolve loadout and list its packages',
      scenario_version: '1.0.0',
      product_surface: 'cli',
      execution_mode: 'bot',
      description: 'Exercises the resolve+list happy path for the published CLI artifact.',
      steps: [
        { id: 'install', action: 'npm install -g @mcptoolshop/ai-loadout' },
        { id: 'resolve', action: 'ai-loadout resolve <pack>', verifiable: true, expected: 'exit 0' },
      ],
      success_criteria: { required_steps: ['install', 'resolve'] },
    };

    it('accepts a representative valid scenario', () => {
      const result = validatePayload('scenario', valid);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it('rejects a scenario_id that violates the kebab-case pattern', () => {
      const bad = { ...valid, scenario_id: 'CLI_Resolve' };
      const result = validatePayload('scenario', bad);
      expectError(result, e => e.path.includes('/scenario_id'));
    });

    it('rejects an empty steps array (minItems: 1)', () => {
      const bad = { ...valid, steps: [] };
      const result = validatePayload('scenario', bad);
      expectError(result, e => e.path.includes('/steps'));
    });

    it('rejects a step missing the required action field', () => {
      const bad = { ...valid, steps: [{ id: 'install' }] };
      const result = validatePayload('scenario', bad);
      expectError(result, e => /required/i.test(e.message) && /action/.test(JSON.stringify(e.params)));
    });
  });
});
