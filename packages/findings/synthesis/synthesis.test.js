import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { derivePatterns } from './pattern-derivation.js';
import { deriveRecommendations } from './recommendation-derivation.js';
import { deriveDoctrine } from './doctrine-derivation.js';
import { validatePattern, validateRecommendation, validateDoctrine } from './validate-artifacts.js';
import { writePattern, writeRecommendation, writeDoctrine, loadPatterns, loadRecommendations, loadDoctrines } from './write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_synthesis__');

// ─── Helpers ────────────────────────────────────────────────

function makeAcceptedFinding(overrides) {
  return {
    schema_version: '1.0.0',
    finding_id: `dfind-test-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test finding for synthesis',
    status: 'accepted',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'surface_archetype',
    summary: 'Test finding for synthesis testing that is long enough to pass validation.',
    source_record_ids: ['test-' + Math.random().toString(36).slice(2, 8)],
    evidence: [{ evidence_kind: 'record', record_id: 'test-001' }],
    ...overrides
  };
}

function writeFinding(rootDir, finding) {
  const [org, repo] = finding.repo.split('/');
  const dir = resolve(rootDir, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${finding.finding_id}.yaml`), yaml.dump(finding, { lineWidth: 120 }), 'utf-8');
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'findings'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'patterns'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'recommendations'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'doctrine'), { recursive: true });
}

// ============================================================
// Pattern derivation tests
// ============================================================

describe('Pattern derivation: clustering', () => {
  before(() => {
    setupTestRoot();
    // Two findings with same issue_kind + root_cause_kind from different repos
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-synth-a',
      repo: 'mcp-tool-shop-org/repo-a',
      source_record_ids: ['record-a'],
      issue_kind: 'interface_assumption',
      root_cause_kind: 'surface_misclassification'
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-synth-b',
      repo: 'mcp-tool-shop-org/repo-b',
      source_record_ids: ['record-b'],
      issue_kind: 'interface_assumption',
      root_cause_kind: 'surface_misclassification'
    }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('clusters 2+ accepted findings with shared dimensions', () => {
    const { patterns, stats } = derivePatterns(TEST_ROOT);
    assert.ok(patterns.length >= 1, `Expected at least 1 pattern, got ${patterns.length}`);
    assert.equal(stats.findingsConsidered, 2);
  });

  it('pattern has correct source_finding_ids', () => {
    const { patterns } = derivePatterns(TEST_ROOT);
    const p = patterns[0];
    assert.ok(p.source_finding_ids.includes('dfind-synth-a'));
    assert.ok(p.source_finding_ids.includes('dfind-synth-b'));
  });

  it('pattern has correct support counts', () => {
    const { patterns } = derivePatterns(TEST_ROOT);
    const p = patterns[0];
    assert.equal(p.support.finding_count, 2);
    assert.equal(p.support.repo_count, 2);
  });

  it('derived pattern is schema-valid', () => {
    const { patterns } = derivePatterns(TEST_ROOT);
    for (const p of patterns) {
      const result = validatePattern(p);
      assert.equal(result.valid, true, `${p.pattern_id}: ${JSON.stringify(result.errors)}`);
    }
  });
});

describe('Pattern derivation: exclusions', () => {
  it('excludes invalidated findings', () => {
    setupTestRoot();
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-inv-a',
      repo: 'mcp-tool-shop-org/repo-a',
      source_record_ids: ['record-a'],
      invalidation: { is_invalidated: true, invalidated_at: '2026-03-29T00:00:00Z', reason: 'test' }
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-inv-b',
      repo: 'mcp-tool-shop-org/repo-b',
      source_record_ids: ['record-b']
    }));
    const { patterns } = derivePatterns(TEST_ROOT);
    assert.equal(patterns.length, 0, 'Should not cluster when one finding is invalidated');
    rmSync(TEST_ROOT, { recursive: true });
  });

  it('excludes candidate/reviewed findings', () => {
    setupTestRoot();
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-cand-a',
      repo: 'mcp-tool-shop-org/repo-a',
      status: 'candidate',
      source_record_ids: ['record-a']
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-cand-b',
      repo: 'mcp-tool-shop-org/repo-b',
      status: 'reviewed',
      source_record_ids: ['record-b']
    }));
    const { patterns } = derivePatterns(TEST_ROOT);
    assert.equal(patterns.length, 0, 'Should not cluster non-accepted findings');
    rmSync(TEST_ROOT, { recursive: true });
  });

  it('rejects false recurrence from same source records', () => {
    setupTestRoot();
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-dup-a',
      repo: 'mcp-tool-shop-org/repo-a',
      source_record_ids: ['same-record']
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-dup-b',
      repo: 'mcp-tool-shop-org/repo-b',
      source_record_ids: ['same-record']
    }));
    const { patterns } = derivePatterns(TEST_ROOT);
    assert.equal(patterns.length, 0, 'Same source records = false recurrence');
    rmSync(TEST_ROOT, { recursive: true });
  });
});

describe('Pattern derivation: pattern_id collision (regression)', () => {
  // Regression for F-742442-040: cluster key includes root_cause_kind but slug did not,
  // so two clusters that differ only by root_cause_kind produced identical pattern_id
  // values. writePattern() then silently overwrote the first pattern on disk.
  before(() => {
    setupTestRoot();
    // Cluster A: entrypoint_truth + contract_drift on cli surface
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-collide-a1',
      repo: 'mcp-tool-shop-org/repo-a',
      source_record_ids: ['record-a1'],
      product_surface: 'cli',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift'
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-collide-a2',
      repo: 'mcp-tool-shop-org/repo-b',
      source_record_ids: ['record-a2'],
      product_surface: 'cli',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift'
    }));
    // Cluster B: entrypoint_truth + surface_misclassification on cli surface
    // Same surface + issue_kind as Cluster A, but different root_cause_kind.
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-collide-b1',
      repo: 'mcp-tool-shop-org/repo-c',
      source_record_ids: ['record-b1'],
      product_surface: 'cli',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'surface_misclassification'
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-collide-b2',
      repo: 'mcp-tool-shop-org/repo-d',
      source_record_ids: ['record-b2'],
      product_surface: 'cli',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'surface_misclassification'
    }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('produces two distinct clusters', () => {
    const { patterns, stats } = derivePatterns(TEST_ROOT);
    assert.equal(stats.clustersFound, 2, 'cluster key includes root_cause_kind, so 2 distinct clusters');
    assert.equal(patterns.length, 2, 'both clusters meet 2-finding threshold');
  });

  it('emits unique pattern_id values for each cluster', () => {
    const { patterns } = derivePatterns(TEST_ROOT);
    const ids = patterns.map(p => p.pattern_id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length,
      `pattern_id collision: ${JSON.stringify(ids)} — slug must include root_cause_kind to match cluster key`);
  });

  it('persists both patterns to disk without overwrite', () => {
    const { patterns } = derivePatterns(TEST_ROOT);
    for (const p of patterns) writePattern(TEST_ROOT, p);
    const loaded = loadPatterns(TEST_ROOT);
    const collidedIds = patterns.map(p => p.pattern_id);
    for (const id of collidedIds) {
      assert.ok(loaded.some(x => x.pattern_id === id),
        `pattern ${id} missing on disk — second writePattern() overwrote the first`);
    }
    // Verify each persisted pattern carries its own root_cause_kind in dimensions
    const loadedRootCauses = new Set(
      loaded
        .filter(p => collidedIds.includes(p.pattern_id))
        .flatMap(p => p.dimensions.root_cause_kinds)
    );
    assert.ok(loadedRootCauses.has('contract_drift'),
      'contract_drift cluster should survive on disk');
    assert.ok(loadedRootCauses.has('surface_misclassification'),
      'surface_misclassification cluster should survive on disk');
  });
});

describe('Pattern derivation: thresholds', () => {
  it('single finding does not produce a pattern', () => {
    setupTestRoot();
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-solo',
      source_record_ids: ['record-solo']
    }));
    const { patterns, stats } = derivePatterns(TEST_ROOT);
    assert.equal(patterns.length, 0);
    assert.ok(stats.belowThreshold >= 1);
    rmSync(TEST_ROOT, { recursive: true });
  });

  it('different issue_kind does not cluster', () => {
    setupTestRoot();
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-diff-a',
      repo: 'mcp-tool-shop-org/repo-a',
      source_record_ids: ['record-a'],
      issue_kind: 'entrypoint_truth'
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-diff-b',
      repo: 'mcp-tool-shop-org/repo-b',
      source_record_ids: ['record-b'],
      issue_kind: 'schema_mismatch'
    }));
    const { patterns } = derivePatterns(TEST_ROOT);
    assert.equal(patterns.length, 0);
    rmSync(TEST_ROOT, { recursive: true });
  });
});

// ============================================================
// Recommendation derivation tests
// ============================================================

describe('Recommendation derivation', () => {
  before(() => {
    setupTestRoot();
    // Write an accepted pattern
    writePattern(TEST_ROOT, {
      schema_version: '1.0.0',
      pattern_id: 'dpat-test-recurring',
      title: 'Test recurring pattern for recommendation derivation',
      status: 'accepted',
      pattern_kind: 'recurring_failure',
      summary: 'Test pattern summary that is long enough to pass the minimum length validation check.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2, surface_count: 1 },
      dimensions: { product_surfaces: ['mcp-server'], issue_kinds: ['interface_assumption'], root_cause_kinds: ['surface_misclassification'] },
      transfer_scope: 'surface_archetype',
      pattern_strength: 'strong'
    });
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('derives recommendation from accepted pattern', () => {
    const { recommendations, stats } = deriveRecommendations(TEST_ROOT);
    assert.equal(stats.patternsConsidered, 1);
    assert.ok(recommendations.length >= 1, 'Should emit at least 1 recommendation');
  });

  it('recommendation references source pattern', () => {
    const { recommendations } = deriveRecommendations(TEST_ROOT);
    assert.ok(recommendations[0].based_on_pattern_ids.includes('dpat-test-recurring'));
  });

  it('recommendation is schema-valid', () => {
    const { recommendations } = deriveRecommendations(TEST_ROOT);
    for (const r of recommendations) {
      const result = validateRecommendation(r);
      assert.equal(result.valid, true, `${r.recommendation_id}: ${JSON.stringify(result.errors)}`);
    }
  });

  it('recommendation has actionable details', () => {
    const { recommendations } = deriveRecommendations(TEST_ROOT);
    const r = recommendations[0];
    assert.ok(r.action.type);
    assert.ok(r.action.details.length >= 5);
  });

  it('does not derive from candidate patterns', () => {
    setupTestRoot();
    writePattern(TEST_ROOT, {
      schema_version: '1.0.0',
      pattern_id: 'dpat-test-candidate',
      title: 'Pattern still in candidate status should not produce recommendations',
      status: 'candidate',
      pattern_kind: 'recurring_failure',
      summary: 'This pattern is still candidate and should not produce recommendations from derivation.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2, surface_count: 1 },
      dimensions: { issue_kinds: ['test'] },
      transfer_scope: 'surface_archetype'
    });
    const { recommendations } = deriveRecommendations(TEST_ROOT);
    assert.equal(recommendations.length, 0);
    rmSync(TEST_ROOT, { recursive: true });
  });
});

// ============================================================
// Doctrine derivation tests
// ============================================================

describe('Doctrine derivation', () => {
  before(() => {
    setupTestRoot();
    // Write a strong accepted pattern
    writePattern(TEST_ROOT, {
      schema_version: '1.0.0',
      pattern_id: 'dpat-test-strong',
      title: 'Strong pattern for doctrine derivation testing purposes',
      status: 'accepted',
      pattern_kind: 'recurring_failure',
      summary: 'Strong pattern summary that represents a proven recurring failure class across repos.',
      source_finding_ids: ['dfind-a', 'dfind-b', 'dfind-c'],
      support: { finding_count: 3, repo_count: 3, surface_count: 2 },
      dimensions: { product_surfaces: ['cli', 'mcp-server'], issue_kinds: ['entrypoint_truth'], root_cause_kinds: ['contract_drift'], remediation_kinds: ['docs_change'] },
      transfer_scope: 'surface_archetype',
      pattern_strength: 'strong'
    });
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('derives doctrine from strong accepted pattern', () => {
    const { doctrines, stats } = deriveDoctrine(TEST_ROOT);
    assert.equal(stats.patternsConsidered, 1);
    assert.ok(doctrines.length >= 1, 'Should emit at least 1 doctrine');
  });

  it('doctrine references source pattern', () => {
    const { doctrines } = deriveDoctrine(TEST_ROOT);
    assert.ok(doctrines[0].based_on_pattern_ids.includes('dpat-test-strong'));
  });

  it('doctrine is schema-valid', () => {
    const { doctrines } = deriveDoctrine(TEST_ROOT);
    for (const d of doctrines) {
      const result = validateDoctrine(d);
      assert.equal(result.valid, true, `${d.doctrine_id}: ${JSON.stringify(result.errors)}`);
    }
  });

  it('doctrine has rule-like statement', () => {
    const { doctrines } = deriveDoctrine(TEST_ROOT);
    const d = doctrines[0];
    assert.ok(d.statement.length >= 20, 'Statement should be substantial');
    assert.ok(d.rationale.length >= 20, 'Rationale should be substantial');
  });

  it('does not derive from emerging patterns', () => {
    setupTestRoot();
    writePattern(TEST_ROOT, {
      schema_version: '1.0.0',
      pattern_id: 'dpat-test-weak',
      title: 'Emerging pattern should not produce doctrine from derivation pipeline',
      status: 'accepted',
      pattern_kind: 'recurring_failure',
      summary: 'This pattern is only emerging strength and should not produce doctrine from derivation.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2, surface_count: 1 },
      dimensions: { issue_kinds: ['test'], root_cause_kinds: ['test'] },
      transfer_scope: 'surface_archetype',
      pattern_strength: 'emerging'
    });
    const { doctrines } = deriveDoctrine(TEST_ROOT);
    assert.equal(doctrines.length, 0);
    rmSync(TEST_ROOT, { recursive: true });
  });

  it('org_wide doctrine requires 2+ patterns', () => {
    setupTestRoot();
    writePattern(TEST_ROOT, {
      schema_version: '1.0.0',
      pattern_id: 'dpat-test-single-org',
      title: 'Single strong pattern with org_wide scope should not produce org doctrine',
      status: 'accepted',
      pattern_kind: 'recurring_failure',
      summary: 'One pattern alone should not become org_wide doctrine even if it has strong strength.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2, surface_count: 1 },
      dimensions: { issue_kinds: ['test'], root_cause_kinds: ['unique_root'] },
      transfer_scope: 'org_wide',
      pattern_strength: 'strong'
    });
    const { doctrines, stats } = deriveDoctrine(TEST_ROOT);
    assert.equal(doctrines.length, 0, 'org_wide doctrine needs 2+ patterns');
    assert.ok(stats.belowThreshold >= 1);
    rmSync(TEST_ROOT, { recursive: true });
  });
});

// ============================================================
// Lineage tests
// ============================================================

describe('Lineage: full chain', () => {
  before(() => {
    setupTestRoot();
    // Write clusterable accepted findings
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-lineage-a',
      repo: 'mcp-tool-shop-org/repo-a',
      source_record_ids: ['record-la'],
      issue_kind: 'build_output_mismatch',
      root_cause_kind: 'build_config_error'
    }));
    writeFinding(TEST_ROOT, makeAcceptedFinding({
      finding_id: 'dfind-lineage-b',
      repo: 'mcp-tool-shop-org/repo-b',
      source_record_ids: ['record-lb'],
      issue_kind: 'build_output_mismatch',
      root_cause_kind: 'build_config_error'
    }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('pattern preserves source finding IDs', () => {
    const { patterns } = derivePatterns(TEST_ROOT);
    assert.ok(patterns.length >= 1);
    const ids = patterns[0].source_finding_ids;
    assert.ok(ids.includes('dfind-lineage-a'));
    assert.ok(ids.includes('dfind-lineage-b'));
  });

  it('recommendation preserves pattern IDs', () => {
    // Write the derived pattern as accepted
    const { patterns } = derivePatterns(TEST_ROOT);
    const p = { ...patterns[0], status: 'accepted', pattern_strength: 'strong' };
    writePattern(TEST_ROOT, p);

    const { recommendations } = deriveRecommendations(TEST_ROOT);
    assert.ok(recommendations.length >= 1);
    assert.ok(recommendations[0].based_on_pattern_ids.includes(p.pattern_id));
  });
});

// ============================================================
// Schema validation tests
// ============================================================

describe('Schema validation: patterns', () => {
  it('rejects pattern with fewer than 2 source findings', () => {
    const result = validatePattern({
      schema_version: '1.0.0',
      pattern_id: 'dpat-test',
      title: 'Pattern with only one source finding',
      status: 'candidate',
      pattern_kind: 'recurring_failure',
      summary: 'This pattern only has one source finding and should fail validation.',
      source_finding_ids: ['dfind-only-one'],
      support: { finding_count: 1, repo_count: 1 },
      dimensions: { issue_kinds: ['test'] },
      transfer_scope: 'surface_archetype'
    });
    assert.equal(result.valid, false);
  });

  it('rejects invalid pattern_kind', () => {
    const result = validatePattern({
      schema_version: '1.0.0',
      pattern_id: 'dpat-test',
      title: 'Pattern with bad kind value',
      status: 'candidate',
      pattern_kind: 'vibes',
      summary: 'This pattern has an invalid kind and should fail schema validation.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2 },
      dimensions: { issue_kinds: ['test'] },
      transfer_scope: 'surface_archetype'
    });
    assert.equal(result.valid, false);
  });
});

describe('Schema validation: recommendations', () => {
  it('rejects recommendation without action', () => {
    const result = validateRecommendation({
      schema_version: '1.0.0',
      recommendation_id: 'drec-test',
      title: 'Recommendation without action field',
      status: 'candidate',
      recommendation_kind: 'starter_check',
      summary: 'This recommendation has no action block and should fail validation.',
      applies_to: {},
      based_on_pattern_ids: ['dpat-test']
    });
    assert.equal(result.valid, false);
  });
});

describe('Schema validation: doctrine', () => {
  it('rejects doctrine without statement', () => {
    const result = validateDoctrine({
      schema_version: '1.0.0',
      doctrine_id: 'ddoc-test',
      title: 'Doctrine without statement field',
      status: 'candidate',
      doctrine_kind: 'rollout_law',
      rationale: 'This doctrine has no statement and should fail validation check.',
      based_on_pattern_ids: ['dpat-test'],
      transfer_scope: 'org_wide'
    });
    assert.equal(result.valid, false);
  });

  it('rejects doctrine with repo_local scope', () => {
    const result = validateDoctrine({
      schema_version: '1.0.0',
      doctrine_id: 'ddoc-test',
      title: 'Doctrine with wrong scope value',
      status: 'candidate',
      doctrine_kind: 'rollout_law',
      statement: 'Test statement that is long enough to pass.',
      rationale: 'Test rationale that is long enough to pass.',
      based_on_pattern_ids: ['dpat-test'],
      transfer_scope: 'repo_local'
    });
    assert.equal(result.valid, false);
  });
});

// ============================================================
// Write/load tests
// ============================================================

describe('Write and load artifacts', () => {
  before(() => setupTestRoot());
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('writes and loads pattern', () => {
    const p = {
      schema_version: '1.0.0', pattern_id: 'dpat-write-test',
      title: 'Write test pattern for disk materialization',
      status: 'candidate', pattern_kind: 'recurring_failure',
      summary: 'Test pattern for write and load round-trip verification.',
      source_finding_ids: ['dfind-a', 'dfind-b'],
      support: { finding_count: 2, repo_count: 2, surface_count: 1 },
      dimensions: { issue_kinds: ['test'] },
      transfer_scope: 'surface_archetype'
    };
    writePattern(TEST_ROOT, p);
    const loaded = loadPatterns(TEST_ROOT);
    assert.ok(loaded.some(x => x.pattern_id === 'dpat-write-test'));
  });

  it('writes and loads recommendation', () => {
    const r = {
      schema_version: '1.0.0', recommendation_id: 'drec-write-test',
      title: 'Write test recommendation for disk round-trip',
      status: 'candidate', recommendation_kind: 'starter_check',
      summary: 'Test recommendation for write and load verification.',
      applies_to: { product_surfaces: ['cli'] },
      based_on_pattern_ids: ['dpat-test'],
      action: { type: 'add_check', details: 'Test action details for verification.' }
    };
    writeRecommendation(TEST_ROOT, r);
    const loaded = loadRecommendations(TEST_ROOT);
    assert.ok(loaded.some(x => x.recommendation_id === 'drec-write-test'));
  });

  it('writes and loads doctrine', () => {
    const d = {
      schema_version: '1.0.0', doctrine_id: 'ddoc-write-test',
      title: 'Write test doctrine for disk round-trip',
      status: 'candidate', doctrine_kind: 'rollout_law',
      statement: 'Test doctrine statement that reads as a directive.',
      rationale: 'Test rationale that references recurrence evidence.',
      based_on_pattern_ids: ['dpat-test'],
      transfer_scope: 'org_wide'
    };
    writeDoctrine(TEST_ROOT, d);
    const loaded = loadDoctrines(TEST_ROOT);
    assert.ok(loaded.some(x => x.doctrine_id === 'ddoc-write-test'));
  });
});
