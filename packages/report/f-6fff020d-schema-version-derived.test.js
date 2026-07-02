/**
 * F-6fff020d: the builder stamped `schema_version: '1.0.0'` as a hardcoded
 * literal. verify/index.js derives its record version from
 * SUPPORTED_SCHEMA_VERSIONS (F1-CONTRACTS-001: 'not a hardcoded literal that
 * can drift'); the builder must use the same single source of truth or every
 * scaffolded consumer emits CONTRACT_SCHEMA_TOO_OLD submissions after a major
 * bump until the literal is hunted down.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';
import { buildSubmission } from './build-submission.js';

describe('F-6fff020d: schema_version derives from the contract package', () => {
  it('stamps SUPPORTED_SCHEMA_VERSIONS.recordSubmission.current', () => {
    const submission = buildSubmission({
      repo: 'org/example',
      commitSha: 'c5d6c4e0000000000000000000000000deadbeef',
      workflow: 'dogfood.yml',
      providerRunId: '1',
      runUrl: 'https://github.com/org/example/actions/runs/1',
      startedAt: '2026-03-19T15:45:00Z',
      finishedAt: '2026-03-19T15:45:12Z',
      scenarioResults: [{
        scenario_id: 's',
        product_surface: 'cli',
        execution_mode: 'bot',
        verdict: 'pass',
        step_results: [{ step_id: 'one', status: 'pass' }]
      }],
      overallVerdict: 'pass'
    });
    assert.equal(
      submission.schema_version,
      SUPPORTED_SCHEMA_VERSIONS.recordSubmission.current,
      'builder must stamp the contract-current submission schema version, not a literal'
    );
  });
});
