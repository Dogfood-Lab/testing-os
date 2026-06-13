/**
 * featF-INTEL-001 — review verbs for synthesis artifacts (loop closure).
 *
 * The marquee proof: a candidate synthesis artifact (pattern / recommendation /
 * doctrine), once promoted to `accepted` via the new `reviewArtifact` verb, is
 * returned by the advise-layer query that previously surfaced ONLY accepted
 * artifacts. Before this feature there was no verb to make that promotion, so
 * the intelligence loop dead-ended at `candidate`.
 *
 * Mirrors the finding review machinery (review/review-engine.js +
 * review/transitions.js + review/event-log.js) and the synthesis writers
 * (synthesis/write-artifacts.js). TEST_ROOT temp dirs only — never the real
 * records/patterns/recommendations/doctrine tree.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { reviewArtifact, findArtifactById, getArtifactReviewQueue } from './review-artifacts.js';
import { resetSeenArtifactWrites } from '../synthesis/write-artifacts.js';
import { queryPatterns, queryRecommendations, queryDoctrine } from '../advise/query.js';
import { getAllEvents } from './event-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_review_artifacts__');

// ─── Fixtures (schema-valid candidate artifacts) ────────────

function makeCandidatePattern(overrides = {}) {
  return {
    schema_version: '1.0.0',
    pattern_id: 'dpat-featf-001',
    title: 'Recurring entrypoint truth gap across CLI repos',
    status: 'candidate',
    pattern_kind: 'recurring_failure',
    summary: 'Entrypoint truth drifts from docs repeatedly across CLI repos in the portfolio.',
    source_finding_ids: ['dfind-a', 'dfind-b'],
    support: { finding_count: 2, repo_count: 2, surface_count: 1 },
    dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
    transfer_scope: 'surface_archetype',
    pattern_strength: 'strong',
    ...overrides
  };
}

function makeCandidateRecommendation(overrides = {}) {
  return {
    schema_version: '1.0.0',
    recommendation_id: 'drec-featf-001',
    title: 'Add entrypoint truth verification to CLI rollout',
    status: 'candidate',
    recommendation_kind: 'starter_check',
    summary: 'New CLI repos should verify entrypoint truth before rollout assumptions are encoded.',
    applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
    based_on_pattern_ids: ['dpat-featf-001'],
    action: { type: 'add_check', target: 'rollout', details: 'Verify entrypoint contract before scenario authoring.' },
    confidence: 'strong',
    ...overrides
  };
}

function makeCandidateDoctrine(overrides = {}) {
  return {
    schema_version: '1.0.0',
    doctrine_id: 'ddoc-featf-001',
    title: 'Entrypoint truth is verified before rollout',
    status: 'candidate',
    doctrine_kind: 'verification_law',
    statement: 'Every CLI repo must verify entrypoint truth before encoding rollout assumptions.',
    rationale: 'Entrypoint truth gaps recur across the portfolio in CLI repos with measurable cost.',
    based_on_pattern_ids: ['dpat-featf-001'],
    transfer_scope: 'surface_archetype',
    strength: 'proven',
    ...overrides
  };
}

function writeArtifactFile(dir, id, artifact) {
  const d = resolve(TEST_ROOT, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(artifact, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'patterns'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'recommendations'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'doctrine'), { recursive: true });
  resetSeenArtifactWrites(TEST_ROOT);
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  resetSeenArtifactWrites(TEST_ROOT);
}

// ============================================================
// THE MARQUEE: the loop closes
// ============================================================

describe('featF-INTEL-001: loop closure — accept promotes candidate into advise surface', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('pattern: candidate is NOT in queryPatterns; after accept it IS', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());

    // Before: the candidate dead-ends — advise surfaces only accepted.
    const before = queryPatterns(TEST_ROOT, {});
    assert.equal(before.find(p => p.pattern_id === 'dpat-featf-001'), undefined,
      'candidate pattern must NOT be returned by queryPatterns');

    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'accept', actor: 'mike' });
    assert.equal(res.success, true, `accept should succeed: ${res.error}`);
    assert.equal(res.artifact.status, 'accepted');

    // After: the loop closes.
    const after = queryPatterns(TEST_ROOT, {});
    assert.ok(after.find(p => p.pattern_id === 'dpat-featf-001'),
      'accepted pattern MUST be returned by queryPatterns — the loop closes');
  });

  it('recommendation: candidate is NOT in queryRecommendations; after accept it IS', () => {
    writeArtifactFile('recommendations', 'drec-featf-001', makeCandidateRecommendation());

    const before = queryRecommendations(TEST_ROOT, {});
    assert.equal(before.find(r => r.recommendation_id === 'drec-featf-001'), undefined);

    const res = reviewArtifact(TEST_ROOT, { type: 'recommendation', id: 'drec-featf-001', action: 'accept', actor: 'mike' });
    assert.equal(res.success, true, `accept should succeed: ${res.error}`);
    assert.equal(res.artifact.status, 'accepted');

    const after = queryRecommendations(TEST_ROOT, {});
    assert.ok(after.find(r => r.recommendation_id === 'drec-featf-001'));
  });

  it('doctrine: candidate is NOT in queryDoctrine; after accept it IS', () => {
    writeArtifactFile('doctrine', 'ddoc-featf-001', makeCandidateDoctrine());

    const before = queryDoctrine(TEST_ROOT, {});
    assert.equal(before.find(d => d.doctrine_id === 'ddoc-featf-001'), undefined);

    const res = reviewArtifact(TEST_ROOT, { type: 'doctrine', id: 'ddoc-featf-001', action: 'accept', actor: 'mike' });
    assert.equal(res.success, true, `accept should succeed: ${res.error}`);
    assert.equal(res.artifact.status, 'accepted');

    const after = queryDoctrine(TEST_ROOT, {});
    assert.ok(after.find(d => d.doctrine_id === 'ddoc-featf-001'));
  });
});

// ============================================================
// Review metadata + event log
// ============================================================

describe('featF-INTEL-001: review metadata + event log', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('accept stamps review {reviewed_by, reviewed_at, last_action} and updated_at', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'accept', actor: 'mike', reason: 'sound' });
    assert.equal(res.success, true);
    assert.equal(res.artifact.review.reviewed_by, 'mike');
    assert.equal(res.artifact.review.last_action, 'accept');
    assert.ok(res.artifact.review.reviewed_at);
    assert.equal(res.artifact.review.decision_reason, 'sound');
    assert.ok(res.artifact.updated_at);
  });

  it('appends a review event carrying the artifact id + kind', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'accept', actor: 'mike' });
    assert.ok(res.event);
    const events = getAllEvents(TEST_ROOT);
    const ev = events.find(e => e.artifact_id === 'dpat-featf-001');
    assert.ok(ev, 'an event with artifact_id should be logged');
    assert.equal(ev.artifact_kind, 'pattern');
    assert.equal(ev.action, 'accept');
    assert.equal(ev.from_status, 'candidate');
    assert.equal(ev.to_status, 'accepted');
  });

  it('persists the promoted artifact to disk', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'accept', actor: 'mike' });
    const onDisk = yaml.load(readFileSync(resolve(TEST_ROOT, 'patterns', 'dpat-featf-001.yaml'), 'utf-8'));
    assert.equal(onDisk.status, 'accepted');
    assert.equal(onDisk.review.last_action, 'accept');
  });
});

// ============================================================
// Law enforcement (mirrors the finding engine)
// ============================================================

describe('featF-INTEL-001: law enforcement', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('reject requires a reason', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'reject', actor: 'mike' });
    assert.equal(res.success, false);
    assert.match(res.error, /reason/i);
  });

  it('reject with a reason succeeds and sets status rejected', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'reject', actor: 'mike', reason: 'not a real recurrence' });
    assert.equal(res.success, true);
    assert.equal(res.artifact.status, 'rejected');
  });

  it('unlawful transition is refused (rejected -> accepted has no lawful path)', () => {
    // The reused finding law (transitions.js) allows rejected -> reviewed ONLY;
    // rejected -> accepted is forbidden. Accept on a rejected artifact must be
    // refused with the same vocabulary the finding engine uses.
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern({ status: 'rejected' }));
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'accept', actor: 'mike' });
    assert.equal(res.success, false, 'rejected -> accepted must be refused');
    assert.match(res.error, /transition|Cannot/i);
  });

  it('invalidate requires the artifact to be accepted', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'invalidate', actor: 'mike', reason: 'source changed' });
    assert.equal(res.success, false, 'invalidate on a candidate must be refused');
    assert.match(res.error, /accepted/i);
  });

  it('invalidate on an accepted pattern sets status invalidated and drops it from queryPatterns', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern({ status: 'accepted' }));
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'invalidate', actor: 'mike', reason: 'source truth changed' });
    assert.equal(res.success, true, `invalidate should succeed: ${res.error}`);
    assert.equal(res.artifact.status, 'invalidated');
    assert.equal(res.artifact.review.last_action, 'invalidate');
    const after = queryPatterns(TEST_ROOT, {});
    assert.equal(after.find(p => p.pattern_id === 'dpat-featf-001'), undefined,
      'invalidated pattern must not be returned by queryPatterns');
  });

  it('unknown artifact id returns a structured not-found error', () => {
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-nope', action: 'accept', actor: 'mike' });
    assert.equal(res.success, false);
    assert.match(res.error, /not found/i);
  });

  it('missing actor is refused', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-001', action: 'accept' });
    assert.equal(res.success, false);
    assert.match(res.error, /actor/i);
  });
});

// ============================================================
// findArtifactById + getArtifactReviewQueue
// ============================================================

describe('featF-INTEL-001: lookup + queue', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('findArtifactById resolves data/path/type or null', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    const found = findArtifactById(TEST_ROOT, 'pattern', 'dpat-featf-001');
    assert.ok(found);
    assert.equal(found.type, 'pattern');
    assert.equal(found.data.pattern_id, 'dpat-featf-001');
    assert.ok(found.path.endsWith('dpat-featf-001.yaml'));
    assert.equal(findArtifactById(TEST_ROOT, 'pattern', 'dpat-missing'), null);
  });

  it('getArtifactReviewQueue returns candidate artifacts needing attention', () => {
    writeArtifactFile('patterns', 'dpat-featf-001', makeCandidatePattern());
    writeArtifactFile('patterns', 'dpat-featf-002', makeCandidatePattern({ pattern_id: 'dpat-featf-002', status: 'accepted', source_finding_ids: ['dfind-c', 'dfind-d'] }));
    const queue = getArtifactReviewQueue(TEST_ROOT, 'pattern');
    assert.ok(queue.find(q => q.data.pattern_id === 'dpat-featf-001'), 'candidate is in queue');
    assert.equal(queue.find(q => q.data.pattern_id === 'dpat-featf-002'), undefined, 'accepted is not in queue');
  });
});
