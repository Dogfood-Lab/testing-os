/**
 * Stage C B-003 — scope the collision-memory reset to the id under review.
 *
 * `reviewArtifact` re-writes an artifact whose id was almost certainly already
 * written this process (synthesis derived it, the operator now promotes it), so
 * it must clear the singleton collision guard for that id. It used to call
 * `resetSeenArtifactWrites(rootDir)`, which clears the guard for the WHOLE root
 * — every kind, every id. Harmless for today's single-action CLI, but a future
 * batch caller reviewing several ids in one process would have its silent-
 * clobber protection for the OTHER ids quietly disarmed. This proves reviewing
 * id A leaves id B's collision memory intact.
 *
 * TEST_ROOT temp dirs only.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import yaml from 'js-yaml';

import { reviewArtifact } from './review-artifacts.js';
import { resetSeenArtifactWrites, writePattern, PatternIdCollisionError } from '../synthesis/write-artifacts.js';

// F-072c3d77: scratch space lives in os.tmpdir() (the setupTestRoot /
// F-W1-SUBSTABLE-4 discipline), not inside the package source tree where a
// mid-test failure leaves a dirty `git status`.
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'b003-scoped-reset-'));

function makeCandidatePattern(id) {
  return {
    schema_version: '1.0.0',
    pattern_id: id,
    title: 'Recurring entrypoint truth gap across CLI repos',
    status: 'candidate',
    pattern_kind: 'recurring_failure',
    summary: 'Entrypoint truth drifts from docs repeatedly across CLI repos in the portfolio.',
    source_finding_ids: ['dfind-a', 'dfind-b'],
    support: { finding_count: 2, repo_count: 2, surface_count: 1 },
    dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
    transfer_scope: 'surface_archetype',
    pattern_strength: 'strong'
  };
}

function writeArtifactFile(id) {
  const d = resolve(TEST_ROOT, 'patterns');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(makeCandidatePattern(id), { lineWidth: 120, noRefs: true }), 'utf-8');
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

describe('Stage C B-003: reviewArtifact scopes the collision reset to one id', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('reviewing id A does NOT clear seen-memory for id B', () => {
    writeArtifactFile('dpat-aaa');

    // Prime the singleton collision guard for B by writing it once this process.
    writePattern(TEST_ROOT, makeCandidatePattern('dpat-bbb'));

    // Review A — this re-writes A, which legitimately needs A's guard cleared.
    const res = reviewArtifact(TEST_ROOT, { type: 'pattern', id: 'dpat-aaa', action: 'accept', actor: 'mike' });
    assert.equal(res.success, true, `accept should succeed: ${res.error}`);

    // B's guard must survive: a second write of B is still a refused clobber.
    assert.throws(
      () => writePattern(TEST_ROOT, makeCandidatePattern('dpat-bbb')),
      PatternIdCollisionError,
      'reviewing A must NOT disarm B’s silent-clobber guard'
    );
  });
});
