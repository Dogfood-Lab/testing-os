/**
 * featF-INTEL-002 — preserve operator status across re-derivation.
 *
 * When the synthesis derive path re-writes artifacts (derive → writePatterns /
 * writeRecommendations / writeDoctrines), a freshly-derived `candidate` must NOT
 * clobber an existing PROMOTED artifact (status ∈ {reviewed, accepted, rejected,
 * invalidated}). This mirrors the findings dedupe (`derive/dedupe.js`
 * `dedupeAgainstExisting`), which preserves operator-set status across
 * re-derivation by treating a non-candidate existing id as a collision rather
 * than an overwrite.
 *
 * Before this fix, `findings patterns derive --write` after the operator had
 * accepted a pattern would silently overwrite the accepted artifact back to
 * `candidate` — erasing the operator's decision and breaking the loop closed in
 * F2-INTEL-001.
 *
 * TEST_ROOT temp dirs only.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { dedupeArtifactsAgainstExisting } from './dedupe-artifacts.js';
import { reviewArtifact } from '../review/review-artifacts.js';
import { resetSeenArtifactWrites, writePatterns, loadPatternsWithSkips } from './write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_preserve_status__');

function makeCandidatePattern(overrides = {}) {
  return {
    schema_version: '1.0.0',
    pattern_id: 'dpat-featf-002',
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

function writePatternFile(id, artifact) {
  const d = resolve(TEST_ROOT, 'patterns');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(artifact, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'patterns'), { recursive: true });
  resetSeenArtifactWrites(TEST_ROOT);
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  resetSeenArtifactWrites(TEST_ROOT);
}

describe('featF-INTEL-002: dedupeArtifactsAgainstExisting (mirror of derive/dedupe.js)', () => {
  it('new id (not on disk) is written', () => {
    const candidates = [makeCandidatePattern({ pattern_id: 'dpat-new' })];
    const { toWrite, collisions, skippedUnchanged } = dedupeArtifactsAgainstExisting(candidates, [], 'pattern_id');
    assert.equal(toWrite.length, 1);
    assert.equal(collisions.length, 0);
    assert.equal(skippedUnchanged, 0);
  });

  it('existing candidate id is refreshable (written)', () => {
    const existing = [{ data: makeCandidatePattern({ pattern_id: 'dpat-x', status: 'candidate' }) }];
    const candidates = [makeCandidatePattern({ pattern_id: 'dpat-x', summary: 'A refreshed summary that is also long enough to validate the pattern.' })];
    const { toWrite, collisions } = dedupeArtifactsAgainstExisting(candidates, existing, 'pattern_id');
    assert.equal(toWrite.length, 1, 'candidate-on-candidate refresh is allowed');
    assert.equal(collisions.length, 0);
  });

  it('existing ACCEPTED id is a collision — NOT overwritten', () => {
    const existing = [{ data: makeCandidatePattern({ pattern_id: 'dpat-x', status: 'accepted' }) }];
    const candidates = [makeCandidatePattern({ pattern_id: 'dpat-x', status: 'candidate' })];
    const { toWrite, collisions } = dedupeArtifactsAgainstExisting(candidates, existing, 'pattern_id');
    assert.equal(toWrite.length, 0, 'a freshly-derived candidate must not clobber an accepted artifact');
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].id, 'dpat-x');
    assert.equal(collisions[0].existingStatus, 'accepted');
  });

  it('existing REJECTED and INVALIDATED ids are collisions too', () => {
    const existing = [
      { data: makeCandidatePattern({ pattern_id: 'dpat-r', status: 'rejected' }) },
      { data: makeCandidatePattern({ pattern_id: 'dpat-i', status: 'invalidated' }) }
    ];
    const candidates = [
      makeCandidatePattern({ pattern_id: 'dpat-r' }),
      makeCandidatePattern({ pattern_id: 'dpat-i' })
    ];
    const { toWrite, collisions } = dedupeArtifactsAgainstExisting(candidates, existing, 'pattern_id');
    assert.equal(toWrite.length, 0);
    assert.equal(collisions.length, 2);
  });
});

describe('featF-INTEL-002: end-to-end — accept survives re-derivation', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('derive → accept → re-derive same id keeps status accepted + review intact', () => {
    // 1. First derivation writes a candidate.
    writePatternFile('dpat-featf-002', makeCandidatePattern());

    // 2. Operator accepts it (the F2-INTEL-001 loop-closure verb).
    const acc = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-featf-002', action: 'accept', actor: 'mike', reason: 'sound recurrence' });
    assert.equal(acc.success, true, acc.error);

    // 3. Re-derivation produces the SAME id as a fresh candidate.
    const reDerived = [makeCandidatePattern({ summary: 'A re-derived summary long enough to pass validation cleanly.' })];

    // 4. The derive-write path must consult the existing on-disk artifacts and
    //    REFUSE to clobber the accepted one.
    const { entries } = loadPatternsWithSkips(TEST_ROOT);
    const { toWrite, collisions } = dedupeArtifactsAgainstExisting(reDerived, entries, 'pattern_id');
    assert.equal(toWrite.length, 0, 'accepted artifact must not be re-written');
    assert.equal(collisions.length, 1);

    // 5. Materialize whatever survived dedupe (nothing here) — then assert disk.
    resetSeenArtifactWrites(TEST_ROOT);
    if (toWrite.length) writePatterns(TEST_ROOT, toWrite);

    const onDisk = yaml.load(readFileSync(resolve(TEST_ROOT, 'patterns', 'dpat-featf-002.yaml'), 'utf-8'));
    assert.equal(onDisk.status, 'accepted', 'operator status survives re-derivation');
    assert.ok(onDisk.review, 'operator review block survives re-derivation');
    assert.equal(onDisk.review.reviewed_by, 'mike');
    assert.equal(onDisk.review.decision_reason, 'sound recurrence');
  });
});
