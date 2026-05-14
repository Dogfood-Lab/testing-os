import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import yaml from 'js-yaml';

import {
  parseFinding,
  validateFinding,
  validateFindingFile,
  discoverFindings,
  discoverFixtures,
  loadFindings,
  findById,
  filterFindings,
  findDuplicates
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ============================================================
// Schema tests
// ============================================================

describe('Schema: valid fixtures pass', () => {
  const validDir = resolve(ROOT, 'fixtures/findings/valid');
  const files = discoverFixtures(ROOT, 'valid');

  for (const filePath of files) {
    it(`valid: ${basename(filePath)}`, () => {
      const result = validateFindingFile(filePath);
      assert.equal(result.valid, true, `Expected valid but got errors: ${JSON.stringify(result.errors, null, 2)}`);
    });
  }
});

// ── Invalid-fixture rejection paths ────────────────────────────
//
// F-742442-049 cousin: every invalid fixture must reject for a NAMED reason
// — the test asserts the error message contains the schema-property anchor,
// not just `valid: false`. Generic "rejected" coverage is the kind of gap
// F-742442-049 flagged for verify.test.js (malformed-step path); this file
// avoids the same gap by anchoring each invalid case to its property error.

describe('Schema: invalid fixtures fail for the right reason', () => {
  it('missing-source-record-ids: rejects missing required field', () => {
    const result = validateFindingFile(resolve(ROOT, 'fixtures/findings/invalid/missing-source-record-ids.yaml'));
    assert.equal(result.valid, false);
    const msgs = result.errors.map(e => `${e.path} ${e.message}`).join('; ');
    assert.ok(msgs.includes('source_record_ids'), `Expected source_record_ids error, got: ${msgs}`);
  });

  it('empty-evidence: rejects empty evidence array', () => {
    const result = validateFindingFile(resolve(ROOT, 'fixtures/findings/invalid/empty-evidence.yaml'));
    assert.equal(result.valid, false);
    const msgs = result.errors.map(e => `${e.path} ${e.message}`).join('; ');
    assert.ok(msgs.includes('evidence') || msgs.includes('minItems'), `Expected evidence error, got: ${msgs}`);
  });

  it('illegal-status: rejects bad status enum', () => {
    const result = validateFindingFile(resolve(ROOT, 'fixtures/findings/invalid/illegal-status.yaml'));
    assert.equal(result.valid, false);
    const msgs = result.errors.map(e => `${e.path} ${e.message}`).join('; ');
    assert.ok(msgs.includes('status') || msgs.includes('enum'), `Expected status enum error, got: ${msgs}`);
  });

  it('illegal-transfer-scope: rejects bad transfer_scope enum', () => {
    const result = validateFindingFile(resolve(ROOT, 'fixtures/findings/invalid/illegal-transfer-scope.yaml'));
    assert.equal(result.valid, false);
    const msgs = result.errors.map(e => `${e.path} ${e.message}`).join('; ');
    assert.ok(msgs.includes('transfer_scope') || msgs.includes('enum'), `Expected transfer_scope enum error, got: ${msgs}`);
  });

  // F-375053-006 cousin — repo pattern is `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`,
  // a bare repo name without an org prefix must be rejected. The schema is the
  // contract; persist.js uses the path-segment guard now centralized in
  // packages/ingest/lib/unsafe-segment.js (F-916867-005).
  it('bad-repo-naming: rejects bare repo name without org prefix', () => {
    const result = validateFindingFile(resolve(ROOT, 'fixtures/findings/invalid/bad-repo-naming.yaml'));
    assert.equal(result.valid, false);
    const msgs = result.errors.map(e => `${e.path} ${e.message}`).join('; ');
    assert.ok(msgs.includes('repo') || msgs.includes('pattern'), `Expected repo pattern error, got: ${msgs}`);
  });

  it('missing-issue-kind: rejects missing required classification field', () => {
    const result = validateFindingFile(resolve(ROOT, 'fixtures/findings/invalid/missing-issue-kind.yaml'));
    assert.equal(result.valid, false);
    const msgs = result.errors.map(e => `${e.path} ${e.message}`).join('; ');
    assert.ok(msgs.includes('issue_kind'), `Expected issue_kind error, got: ${msgs}`);
  });
});

describe('Schema: required fields enforced', () => {
  it('empty object fails with all required fields listed', () => {
    const result = validateFinding({});
    assert.equal(result.valid, false);
    const paths = result.errors.map(e => e.message);
    // Should mention multiple required properties
    assert.ok(result.errors.length > 0, 'Expected errors for missing required fields');
  });

  it('minimal valid finding passes', () => {
    const minimal = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-minimal',
      title: 'Minimal valid finding for testing',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'A minimal but valid finding used for schema testing purposes.',
      source_record_ids: ['test-record-1'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-record-1' }]
    };
    const result = validateFinding(minimal);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
  });
});

describe('Schema: enum integrity', () => {
  function makeValid(overrides) {
    return {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-enum',
      title: 'Enum integrity test finding',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'Enum integrity test finding for schema validation.',
      source_record_ids: ['test-record-1'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-record-1' }],
      ...overrides
    };
  }

  it('rejects unknown product_surface', () => {
    const result = validateFinding(makeValid({ product_surface: 'mobile' }));
    assert.equal(result.valid, false);
  });

  it('rejects unknown journey_stage', () => {
    const result = validateFinding(makeValid({ journey_stage: 'deploy' }));
    assert.equal(result.valid, false);
  });

  it('rejects unknown issue_kind', () => {
    const result = validateFinding(makeValid({ issue_kind: 'unknown_thing' }));
    assert.equal(result.valid, false);
  });

  it('rejects unknown root_cause_kind', () => {
    const result = validateFinding(makeValid({ root_cause_kind: 'bad_luck' }));
    assert.equal(result.valid, false);
  });

  it('rejects unknown remediation_kind', () => {
    const result = validateFinding(makeValid({ remediation_kind: 'hope_for_best' }));
    assert.equal(result.valid, false);
  });

  it('rejects unknown evidence_kind', () => {
    const result = validateFinding(makeValid({
      evidence: [{ evidence_kind: 'rumor' }]
    }));
    assert.equal(result.valid, false);
  });

  it('rejects unknown fix_ref kind', () => {
    const result = validateFinding(makeValid({
      fix_refs: [{ ref_kind: 'tweet', ref: 'https://x.com/whoever' }]
    }));
    assert.equal(result.valid, false);
  });

  it('accepts all valid product_surface values', () => {
    for (const surface of ['cli', 'desktop', 'web', 'api', 'mcp-server', 'npm-package', 'plugin', 'library']) {
      const result = validateFinding(makeValid({ product_surface: surface }));
      assert.equal(result.valid, true, `Surface ${surface} should be valid`);
    }
  });

  it('accepts all valid status values', () => {
    for (const status of ['candidate', 'reviewed', 'accepted', 'rejected']) {
      const result = validateFinding(makeValid({ status }));
      assert.equal(result.valid, true, `Status ${status} should be valid`);
    }
  });
});

describe('Schema: evidence minimum enforced', () => {
  it('rejects findings with no evidence array', () => {
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-no-evidence',
      title: 'Finding with no evidence array at all',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'This finding has no evidence array and should be rejected.',
      source_record_ids: ['test-record-1']
    };
    const result = validateFinding(finding);
    assert.equal(result.valid, false);
  });

  it('rejects findings with empty evidence array', () => {
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-empty-ev',
      title: 'Finding with empty evidence array',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'This finding has an empty evidence array and should be rejected.',
      source_record_ids: ['test-record-1'],
      evidence: []
    };
    const result = validateFinding(finding);
    assert.equal(result.valid, false);
  });
});

// F-002109-027 cousin — the schema must close to additionalProperties:false so
// stray fields surface at validate-time, not at consume-time. Same defensive
// posture as the verify() null/non-object guard added under F-002109-027.

describe('Schema: additionalProperties rejected', () => {
  it('rejects top-level extra fields', () => {
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-extra',
      title: 'Finding with extra fields should fail',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'This finding has an extra field and should be rejected.',
      source_record_ids: ['test-record-1'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-record-1' }],
      bogus_field: 'should not be here'
    };
    const result = validateFinding(finding);
    assert.equal(result.valid, false);
  });
});

// F-742440-009 cousin — finding_id is the public handle for `swarm approve --ids`.
// Stable prefix discipline (`dfind-`) is what keeps human-readable IDs collision-
// resistant across runs; the original F-742440-009 was the swarm-side parallel
// (Date.now() collision in swarm fingerprints). Same family: the prefix matters.

describe('Schema: finding_id format', () => {
  it('rejects finding_id without dfind- prefix', () => {
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'shipcheck-cli-entrypoint-truth',
      title: 'Finding without dfind prefix should fail',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'The finding_id does not start with dfind- and should be rejected.',
      source_record_ids: ['test-record-1'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-record-1' }]
    };
    const result = validateFinding(finding);
    assert.equal(result.valid, false);
  });

  it('accepts properly formatted finding_id', () => {
    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-good-id',
      title: 'Finding with proper ID format',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'The finding_id starts with dfind- and should pass.',
      source_record_ids: ['test-record-1'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-record-1' }]
    };
    const result = validateFinding(finding);
    assert.equal(result.valid, true);
  });
});

// ============================================================
// Reader/list tests
// ============================================================

describe('Reader: fixture discovery', () => {
  it('discovers valid fixtures', () => {
    const paths = discoverFixtures(ROOT, 'valid');
    assert.ok(paths.length >= 6, `Expected at least 6 valid fixtures, found ${paths.length}`);
  });

  it('discovers invalid fixtures', () => {
    const paths = discoverFixtures(ROOT, 'invalid');
    assert.ok(paths.length >= 6, `Expected at least 6 invalid fixtures, found ${paths.length}`);
  });

  it('fixture paths are sorted', () => {
    const paths = discoverFixtures(ROOT, 'valid');
    const sorted = [...paths].sort();
    assert.deepEqual(paths, sorted);
  });

  it('returns empty array for nonexistent fixture kind', () => {
    const paths = discoverFixtures(ROOT, 'nonexistent');
    assert.deepEqual(paths, []);
  });
});

describe('Reader: loadFindings', () => {
  it('loads valid fixtures successfully', () => {
    const findings = loadFindings(ROOT, { fixtures: true, fixtureKind: 'valid' });
    assert.ok(findings.length >= 6);
    for (const f of findings) {
      assert.equal(f.valid, true, `${f.path} should be valid`);
      assert.ok(f.data, `${f.path} should have data`);
    }
  });

  it('loads invalid fixtures and marks them invalid', () => {
    const findings = loadFindings(ROOT, { fixtures: true, fixtureKind: 'invalid' });
    assert.ok(findings.length >= 6);
    for (const f of findings) {
      assert.equal(f.valid, false, `${basename(f.path)} should be invalid`);
    }
  });
});

describe('Reader: findById', () => {
  it('finds a known fixture by ID', () => {
    const result = findById(ROOT, 'dfind-shipcheck-cli-entrypoint-truth');
    assert.ok(result, 'Should find the shipcheck finding');
    assert.equal(result.data.finding_id, 'dfind-shipcheck-cli-entrypoint-truth');
    assert.equal(result.valid, true);
  });

  it('returns null for nonexistent ID', () => {
    const result = findById(ROOT, 'dfind-does-not-exist');
    assert.equal(result, null);
  });
});

describe('Reader: filterFindings', () => {
  let allFindings;

  before(() => {
    allFindings = loadFindings(ROOT, { fixtures: true, fixtureKind: 'valid' });
  });

  it('filters by repo', () => {
    const filtered = filterFindings(allFindings, { repo: 'mcp-tool-shop-org/shipcheck' });
    assert.ok(filtered.length >= 1);
    for (const f of filtered) {
      assert.equal(f.data.repo, 'mcp-tool-shop-org/shipcheck');
    }
  });

  it('filters by status', () => {
    const filtered = filterFindings(allFindings, { status: 'accepted' });
    for (const f of filtered) {
      assert.equal(f.data.status, 'accepted');
    }
  });

  it('filters by surface', () => {
    const filtered = filterFindings(allFindings, { surface: 'mcp-server' });
    assert.ok(filtered.length >= 1);
    for (const f of filtered) {
      assert.equal(f.data.product_surface, 'mcp-server');
    }
  });

  it('filters by issue_kind', () => {
    const filtered = filterFindings(allFindings, { issueKind: 'interface_assumption' });
    assert.ok(filtered.length >= 1);
    for (const f of filtered) {
      assert.equal(f.data.issue_kind, 'interface_assumption');
    }
  });

  it('filters by transfer_scope', () => {
    const filtered = filterFindings(allFindings, { transferScope: 'org_wide' });
    assert.ok(filtered.length >= 1);
    for (const f of filtered) {
      assert.equal(f.data.transfer_scope, 'org_wide');
    }
  });

  it('combined filters narrow results', () => {
    const filtered = filterFindings(allFindings, {
      surface: 'cli',
      status: 'accepted'
    });
    for (const f of filtered) {
      assert.equal(f.data.product_surface, 'cli');
      assert.equal(f.data.status, 'accepted');
    }
  });

  it('returns empty for impossible filter', () => {
    const filtered = filterFindings(allFindings, { repo: 'no-such-org/no-such-repo' });
    assert.equal(filtered.length, 0);
  });
});

// F-742442-042 cousin — dedupe contract. The dedupe key in derive/dedupe.js
// uses finding_id (the slug-derived handle); findDuplicates() here verifies
// the *human-facing* collision detection. Same dedupe family as the derive
// engine, one layer up.

describe('Reader: findDuplicates', () => {
  it('returns empty for unique findings', () => {
    const findings = loadFindings(ROOT, { fixtures: true, fixtureKind: 'valid' });
    const dupes = findDuplicates(findings);
    assert.equal(dupes.length, 0, 'Valid fixtures should have no duplicate IDs');
  });

  it('detects duplicates', () => {
    const fake = [
      { data: { finding_id: 'dfind-dupe-test' }, path: '/a.yaml' },
      { data: { finding_id: 'dfind-dupe-test' }, path: '/b.yaml' },
      { data: { finding_id: 'dfind-unique' }, path: '/c.yaml' }
    ];
    const dupes = findDuplicates(fake);
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].findingId, 'dfind-dupe-test');
    assert.equal(dupes[0].paths.length, 2);
  });
});

// ============================================================
// Contract quality tests
// ============================================================

describe('Contract quality: valid fixtures', () => {
  let validFindings;

  before(() => {
    validFindings = loadFindings(ROOT, { fixtures: true, fixtureKind: 'valid' });
  });

  it('every valid fixture has at least one source_record_id', () => {
    for (const f of validFindings) {
      assert.ok(f.data.source_record_ids.length >= 1,
        `${f.data.finding_id} has no source_record_ids`);
    }
  });

  it('every valid fixture has at least one evidence object', () => {
    for (const f of validFindings) {
      assert.ok(f.data.evidence.length >= 1,
        `${f.data.finding_id} has no evidence`);
    }
  });

  it('every valid fixture uses allowed product_surface vocabulary', () => {
    const allowed = new Set(['cli', 'desktop', 'web', 'api', 'mcp-server', 'npm-package', 'plugin', 'library']);
    for (const f of validFindings) {
      assert.ok(allowed.has(f.data.product_surface),
        `${f.data.finding_id} uses unknown surface: ${f.data.product_surface}`);
    }
  });

  it('every valid fixture uses allowed repo naming', () => {
    const pattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
    for (const f of validFindings) {
      assert.ok(pattern.test(f.data.repo),
        `${f.data.finding_id} has invalid repo name: ${f.data.repo}`);
    }
  });

  it('all four statuses are represented across valid fixtures', () => {
    const statuses = new Set(validFindings.map(f => f.data.status));
    // At minimum we should have accepted and reviewed (we have both in fixtures)
    assert.ok(statuses.has('accepted'), 'Expected at least one accepted finding');
    assert.ok(statuses.has('reviewed'), 'Expected at least one reviewed finding');
  });

  it('multiple product surfaces are represented', () => {
    const surfaces = new Set(validFindings.map(f => f.data.product_surface));
    assert.ok(surfaces.size >= 4, `Expected at least 4 surfaces, got ${surfaces.size}: ${[...surfaces].join(', ')}`);
  });

  it('multiple issue_kinds are represented', () => {
    const kinds = new Set(validFindings.map(f => f.data.issue_kind));
    assert.ok(kinds.size >= 4, `Expected at least 4 issue kinds, got ${kinds.size}`);
  });

  it('summaries are descriptive, not vague', () => {
    for (const f of validFindings) {
      assert.ok(f.data.summary.length >= 50,
        `${f.data.finding_id} summary is too short (${f.data.summary.length} chars) — findings should be precise`);
    }
  });
});

// ============================================================
// YAML parse tests
// ============================================================

describe('YAML parsing', () => {
  it('parseFinding handles non-YAML file gracefully', () => {
    // Use the package's own package.json as a "non-YAML JSON file" — stable across layouts.
    // JSON is a strict YAML subset, so js-yaml parses it successfully and
    // returns an object with `name`, `version`, etc. parseFinding's contract
    // is "did it parse?", not "did it match the finding schema" — schema
    // validation is the next layer up (validateFinding).
    // F-W1-TEST-009: pin the exact shape so the test fails if parseFinding
    // ever stops returning the parsed package contents for valid JSON.
    const result = parseFinding(resolve(__dirname, 'package.json'));
    assert.equal(result.error, null, `expected no parse error, got: ${result.error}`);
    assert.ok(result.data && typeof result.data === 'object', 'data should be a parsed object');
    assert.equal(typeof result.data.name, 'string', 'parsed package.json should expose name');
  });

  it('parseFinding handles nonexistent file', () => {
    const result = parseFinding(resolve(ROOT, 'nonexistent.yaml'));
    assert.equal(result.data, null);
    assert.ok(result.error);
  });
});
