/**
 * findings-A-002 — underscore-boundary slug collision in pattern_id and
 * finding_id generation.
 *
 * Both `buildPatternCandidate` (pattern-derivation.js) and `generateFindingId`
 * (ids.js) joined their distinct dimension components with a literal `-` and
 * then ran `.replace(/_/g, '-')` (or the sanitizer) AFTER concatenation. The
 * underscore boundary therefore became indistinguishable from the component
 * boundary:
 *   issue_kind='a_b' + root_cause='c'   → '...-a-b-c'
 *   issue_kind='a'   + root_cause='b_c' → '...-a-b-c'   (identical id!)
 * Distinct cluster keys collapsed to one id. The L3-001 guard caught it
 * fail-closed (a *_ID_COLLISION throw), but legitimate distinct inputs were
 * spuriously refused.
 *
 * AFTER FIX: a delimiter that survives sanitization (a short stable hash of
 * the canonical, explicitly-delimited component tuple) folds into the slug, so
 * the two inputs above produce DISTINCT ids.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateFindingId } from '../derive/ids.js';
import { buildPatternCandidate } from './pattern-derivation.js';

describe('findings-A-002: generateFindingId disambiguates underscore boundaries', () => {
  it('two inputs that share a flattened "-a-b-c" tail produce distinct ids', () => {
    // repoSlug='a_b' lesson='c'  vs  repoSlug='a' lesson='b_c'
    const collidingTailA = generateFindingId('a_b', 'c');
    const collidingTailB = generateFindingId('a', 'b_c');
    assert.notEqual(collidingTailA, collidingTailB,
      'distinct (repoSlug, lessonSlug) tuples must not collapse to the same finding_id');
  });

  it('is still stable for identical inputs', () => {
    assert.equal(generateFindingId('repo', 'slug'), generateFindingId('repo', 'slug'));
  });

  it('still produces dfind- prefixed, sanitized ids', () => {
    const id = generateFindingId('my_repo.name', 'weird/slug!');
    assert.match(id, /^dfind-[a-z0-9-]+$/);
  });
});

describe('findings-A-002: buildPatternCandidate disambiguates cluster-key boundaries', () => {
  function makeCluster(issue_kind, root_cause_kind) {
    const finding = {
      finding_id: `dfind-${issue_kind}-${root_cause_kind}`,
      repo: 'mcp-tool-shop-org/widget',
      product_surface: 'cli',
      issue_kind,
      root_cause_kind,
      remediation_kind: 'docs_change',
      transfer_scope: 'surface_archetype',
      source_record_ids: ['rec-1'],
    };
    return {
      issue_kind,
      root_cause_kind,
      remediation_kind: 'docs_change',
      findings: [finding, { ...finding, finding_id: `${finding.finding_id}-2`, source_record_ids: ['rec-2'] }],
    };
  }

  it('clusters differing only by an underscore boundary get distinct pattern_ids', () => {
    // 'a_b' + 'c'  flattens to the same tail as  'a' + 'b_c'  under naive -replace.
    const pA = buildPatternCandidate(makeCluster('a_b', 'c'));
    const pB = buildPatternCandidate(makeCluster('a', 'b_c'));
    assert.notEqual(pA.pattern_id, pB.pattern_id,
      'distinct cluster keys must yield distinct pattern_ids');
  });

  it('is deterministic for the same cluster dimensions', () => {
    const p1 = buildPatternCandidate(makeCluster('entrypoint_truth', 'contract_drift'));
    const p2 = buildPatternCandidate(makeCluster('entrypoint_truth', 'contract_drift'));
    assert.equal(p1.pattern_id, p2.pattern_id);
  });

  it('pattern_id stays in the dpat- sanitized shape', () => {
    const p = buildPatternCandidate(makeCluster('entrypoint_truth', 'contract_drift'));
    assert.match(p.pattern_id, /^dpat-[a-z0-9-]+$/);
  });
});
