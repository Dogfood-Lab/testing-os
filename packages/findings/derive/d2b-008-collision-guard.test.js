/**
 * d2b-008-collision-guard.test.js — fail-closed intra-batch finding_id
 * collision guard for `writeFindings` and the sibling pattern/recommendation/
 * doctrine writers (write-artifacts.js).
 *
 * AT HEAD (Stage B advisor-verified): two candidates in the same batch that
 * happen to share a generated `finding_id` (the same `dfind-<repoSlug>-<slug>`
 * is produced because the lesson slug is the same — `generateFindingId` does
 * NOT take `rule_id` into the slug yet; that structural fix is needs-design /
 * deferred) silently clobber each other on disk. The second `writeFinding`
 * call wins via the atomic-write temp+rename, and the CLI's "Written: N"
 * success line counts both — operator-invisible data loss.
 *
 * AFTER FIX: `writeFindings(rootDir, findings)` records the first occurrence
 * per `finding_id` and REFUSES the second write with a structured
 * `FINDING_ID_COLLISION` error routed via the existing `errors[]` channel
 * (same shape as the existing write-error branch). The first write still
 * lands on disk (so a single-finding batch keeps working), but a colliding
 * batch surfaces every refused id in `errors[]` and the CLI's existing
 * `if (errors.length > 0) process.exit(1)` propagates the non-zero exit.
 *
 * Counter-test (load-bearing): a batch with NO collision must continue to
 * write every finding cleanly — the guard cannot regress the happy path.
 *
 * Mirrors the same shape for the sibling write-artifacts writers via new
 * batch helpers `writePatterns` / `writeRecommendations` / `writeDoctrines`.
 *
 * STRUCTURAL CHANGE DEFERRED: the underlying generator (`generateFindingId`
 * → `dfind-<repoSlug>-<lessonSlug>` without `rule_id` in the slug) is the
 * proximate cause and a follow-on wave. This guard is the fail-closed
 * stopgap so the next collision does not silently destroy a finding.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import yaml from 'js-yaml';

import {
  writeFinding,
  writeFindings,
  resetSeenWrites,
  FindingIdCollisionError,
} from './write-findings.js';
import {
  writePattern,
  writeRecommendation,
  writeDoctrine,
  writePatterns,
  writeRecommendations,
  writeDoctrines,
  resetSeenArtifactWrites,
  PatternIdCollisionError,
  RecommendationIdCollisionError,
  DoctrineIdCollisionError,
} from '../synthesis/write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_d2b_008_collision_guard__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

/** Build a minimal schema-shaped finding with a chosen finding_id + summary. */
function makeFinding(findingId, summary, overrides = {}) {
  return {
    schema_version: '1.0.0',
    finding_id: findingId,
    title: 'D2B-008 collision-guard fixture finding',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'surface_archetype',
    summary,
    source_record_ids: ['test-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-001' }],
    derived: {
      method: 'deterministic_rule',
      rule_id: 'rule-test',
      derived_at: '2026-05-31T00:00:00.000Z',
      rationale: 'Test rationale for collision-guard',
    },
    created_at: '2026-05-31T00:00:00.000Z',
    updated_at: '2026-05-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('D2B-008: intra-batch finding_id collision guard (writeFindings)', () => {
  before(setup);
  after(teardown);

  it('REFUSES the second write when two findings in the batch share finding_id (FINDING_ID_COLLISION)', () => {
    const root = resolve(TEST_ROOT, 'finding-collision');
    mkdirSync(root, { recursive: true });

    const collidingId = 'dfind-test-repo-collision-fixture';
    const first = makeFinding(collidingId, 'First write — should land on disk per the D2B-008 invariant.');
    const second = makeFinding(collidingId, 'Second write — must be REFUSED, not silently clobber the first.');

    const { written, errors } = writeFindings(root, [first, second]);

    // First write succeeded.
    assert.equal(written.length, 1, 'exactly one write should land on disk');

    // The error array carries a structured collision record for the refused write.
    assert.equal(errors.length, 1, 'one error for the refused colliding write');
    const collision = errors[0];
    assert.equal(collision.findingId, collidingId, 'collision error names the colliding id');
    assert.equal(collision.code, 'FINDING_ID_COLLISION', 'structured code is FINDING_ID_COLLISION');
    assert.match(collision.error, /collision|already/i, 'human-legible message references the collision');

    // The on-disk file holds the FIRST write's payload — second was refused, not silently clobbered.
    const filePath = written[0];
    const onDisk = yaml.load(readFileSync(filePath, 'utf-8'));
    assert.equal(onDisk.summary, first.summary, 'first write preserved; no silent clobber');
  });

  it('non-zero exit signal: CLI-side process.exit(1) branch trips because errors.length > 0', () => {
    // The CLI at packages/findings/cli.js:429-435 already does:
    //   if (errors.length > 0) { ... process.exit(1); }
    // The collision-guard contract here is that the refused write surfaces
    // in `errors[]` so that existing exit branch fires. We assert the
    // observable surface — errors.length > 0 — rather than reaching into
    // the CLI process; the existing CLI test fixture covers the exit path.
    const root = resolve(TEST_ROOT, 'finding-nonzero');
    mkdirSync(root, { recursive: true });

    const id = 'dfind-test-repo-nonzero-fixture';
    const a = makeFinding(id, 'Nonzero-exit fixture A — first write should land cleanly.');
    const b = makeFinding(id, 'Nonzero-exit fixture B — second write must be refused.');

    const { errors } = writeFindings(root, [a, b]);
    assert.ok(errors.length > 0, 'errors.length > 0 — CLI exit-1 branch will trip');
  });

  // COUNTER-TEST: the guard cannot regress the happy path.
  it('no-collision batch: every finding writes successfully (errors stays empty)', () => {
    const root = resolve(TEST_ROOT, 'no-collision');
    mkdirSync(root, { recursive: true });

    const a = makeFinding('dfind-test-repo-aaa', 'Distinct A — happy-path counter-test fixture.');
    const b = makeFinding('dfind-test-repo-bbb', 'Distinct B — happy-path counter-test fixture.');
    const c = makeFinding('dfind-test-repo-ccc', 'Distinct C — happy-path counter-test fixture.');

    const { written, errors } = writeFindings(root, [a, b, c]);
    assert.equal(errors.length, 0, 'no collisions → no errors');
    assert.equal(written.length, 3, 'every finding written');

    // Verify each landed on disk with its own payload (no overwrite).
    const summaries = new Set();
    for (const p of written) {
      const d = yaml.load(readFileSync(p, 'utf-8'));
      summaries.add(d.summary);
    }
    assert.equal(summaries.size, 3, 'three distinct summaries on disk');
  });

  it('collision + clean writes interleaved: only colliders refused, clean ones land', () => {
    const root = resolve(TEST_ROOT, 'mixed');
    mkdirSync(root, { recursive: true });

    const idA = 'dfind-mix-a';
    const idB = 'dfind-mix-b';
    const findings = [
      makeFinding(idA, 'Mix A1 — first write should land cleanly.'),
      makeFinding(idB, 'Mix B unique — distinct id should land cleanly.'),
      makeFinding(idA, 'Mix A2 — collider, must be refused with structured error.'),
    ];

    const { written, errors } = writeFindings(root, findings);
    assert.equal(written.length, 2, 'A1 and B unique landed');
    assert.equal(errors.length, 1, 'A2 collision refused');
    assert.equal(errors[0].findingId, idA);
    assert.equal(errors[0].code, 'FINDING_ID_COLLISION');
  });
});

describe('D2B-008 siblings: pattern/recommendation/doctrine collision guards (write-artifacts.js)', () => {
  before(setup);
  after(teardown);

  function makePattern(id, summary) {
    return {
      schema_version: '1.0.0',
      pattern_id: id,
      title: 'Test pattern',
      status: 'candidate',
      pattern_kind: 'recurring_failure',
      summary,
      source_finding_ids: ['dfind-x', 'dfind-y'],
      support: { finding_count: 2, repo_count: 1, surface_count: 1 },
      dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
      transfer_scope: 'surface_archetype',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
  }

  function makeRecommendation(id, summary) {
    return {
      schema_version: '1.0.0',
      recommendation_id: id,
      title: 'Test recommendation',
      status: 'candidate',
      recommendation_kind: 'starter_check',
      summary,
      based_on_pattern_ids: ['dpat-x'],
      applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
      action: { type: 'add_check', target: 'rollout', details: 'Test action details' },
      confidence: 'emerging',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
  }

  function makeDoctrine(id, statement) {
    return {
      schema_version: '1.0.0',
      doctrine_id: id,
      title: 'Test doctrine',
      status: 'candidate',
      doctrine_kind: 'rollout_law',
      statement,
      rationale: 'Test rationale spanning enough characters to satisfy the schema.',
      based_on_pattern_ids: ['dpat-x'],
      transfer_scope: 'surface_archetype',
      strength: 'proven',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
  }

  it('writePatterns refuses intra-batch pattern_id collision with PATTERN_ID_COLLISION', () => {
    const root = resolve(TEST_ROOT, 'pattern-collision');
    mkdirSync(root, { recursive: true });

    const id = 'dpat-collision-fixture';
    const a = makePattern(id, 'Pattern A — first write should land cleanly on disk.');
    const b = makePattern(id, 'Pattern B — second write must be refused via collision guard.');

    const { written, errors } = writePatterns(root, [a, b]);
    assert.equal(written.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].patternId, id);
    assert.equal(errors[0].code, 'PATTERN_ID_COLLISION');

    const onDisk = yaml.load(readFileSync(written[0], 'utf-8'));
    assert.equal(onDisk.summary, a.summary, 'first pattern preserved; no silent clobber');
  });

  it('writePatterns happy path: no-collision batch writes every pattern', () => {
    const root = resolve(TEST_ROOT, 'pattern-no-collision');
    mkdirSync(root, { recursive: true });

    const a = makePattern('dpat-a', 'A unique — happy-path counter-test fixture.');
    const b = makePattern('dpat-b', 'B unique — happy-path counter-test fixture.');

    const { written, errors } = writePatterns(root, [a, b]);
    assert.equal(errors.length, 0);
    assert.equal(written.length, 2);
  });

  it('writeRecommendations refuses intra-batch recommendation_id collision', () => {
    const root = resolve(TEST_ROOT, 'rec-collision');
    mkdirSync(root, { recursive: true });

    const id = 'drec-collision-fixture';
    const a = makeRecommendation(id, 'Rec A — first write should land cleanly on disk.');
    const b = makeRecommendation(id, 'Rec B — second write must be refused via collision guard.');

    const { written, errors } = writeRecommendations(root, [a, b]);
    assert.equal(written.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].recommendationId, id);
    assert.equal(errors[0].code, 'RECOMMENDATION_ID_COLLISION');
  });

  it('writeRecommendations happy path: no-collision batch writes every recommendation', () => {
    const root = resolve(TEST_ROOT, 'rec-no-collision');
    mkdirSync(root, { recursive: true });

    const a = makeRecommendation('drec-a', 'A unique recommendation — happy-path counter-test fixture.');
    const b = makeRecommendation('drec-b', 'B unique recommendation — happy-path counter-test fixture.');

    const { written, errors } = writeRecommendations(root, [a, b]);
    assert.equal(errors.length, 0);
    assert.equal(written.length, 2);
  });

  it('writeDoctrines refuses intra-batch doctrine_id collision', () => {
    const root = resolve(TEST_ROOT, 'doc-collision');
    mkdirSync(root, { recursive: true });

    const id = 'ddoc-collision-fixture';
    const a = makeDoctrine(id, 'Doctrine statement A spanning enough characters for the schema.');
    const b = makeDoctrine(id, 'Doctrine statement B spanning enough characters for the schema.');

    const { written, errors } = writeDoctrines(root, [a, b]);
    assert.equal(written.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].doctrineId, id);
    assert.equal(errors[0].code, 'DOCTRINE_ID_COLLISION');
  });

  it('writeDoctrines happy path: no-collision batch writes every doctrine', () => {
    const root = resolve(TEST_ROOT, 'doc-no-collision');
    mkdirSync(root, { recursive: true });

    const a = makeDoctrine('ddoc-a', 'Doctrine statement A spanning enough characters for the schema.');
    const b = makeDoctrine('ddoc-b', 'Doctrine statement B spanning enough characters for the schema.');

    const { written, errors } = writeDoctrines(root, [a, b]);
    assert.equal(errors.length, 0);
    assert.equal(written.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────
// L3-001 (Wave A2 amend2) — family-seal: singleton writers refuse
// same-process same-id writes. Pre-fix the second writeFinding silently
// clobbered the first via atomicWriteFileSync; now it throws
// FindingIdCollisionError (and sibling errors for pattern/rec/doctrine).
// The fail-closed batch helper guard is now backstopped at the
// singleton path — any programmatic caller that loops over derive
// output and calls the singleton is also fail-closed.
// ─────────────────────────────────────────────────────────────────

describe('L3-001 family-seal: writeFinding singleton refuses same-process same-id', () => {
  before(setup);
  after(teardown);

  it('writeFinding throws FINDING_ID_COLLISION when called twice with the same finding_id', () => {
    const root = resolve(TEST_ROOT, 'singleton-finding-collision');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root); // Defensive: ensure no carry-over from a prior test.

    const id = 'dfind-singleton-collision-fixture';
    const first = makeFinding(id, 'First singleton write — must land on disk per the L3-001 invariant.');
    const second = makeFinding(id, 'Second singleton write — must be REFUSED via FindingIdCollisionError.');

    const path = writeFinding(root, first);
    assert.ok(existsSync(path), 'first write lands on disk');

    assert.throws(
      () => writeFinding(root, second),
      err => {
        assert.equal(err.code, 'FINDING_ID_COLLISION');
        assert.equal(err.name, 'FindingIdCollisionError');
        assert.equal(err.findingId, id);
        return true;
      },
      'second writeFinding with same id must throw FindingIdCollisionError'
    );

    // On-disk content holds the FIRST write's payload — second was refused.
    const onDisk = yaml.load(readFileSync(path, 'utf-8'));
    assert.equal(onDisk.summary, first.summary, 'first singleton write preserved; no silent clobber');
  });

  it('resetSeenWrites(rootDir) allows legitimate re-write after explicit opt-in', () => {
    const root = resolve(TEST_ROOT, 'singleton-finding-reset');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    const id = 'dfind-singleton-reset-fixture';
    const first = makeFinding(id, 'First write — establishes the seen-ids entry.');
    const second = makeFinding(id, 'Second write — after explicit reset, succeeds.');

    writeFinding(root, first);
    resetSeenWrites(root); // Operator-opt-in for legitimate re-write.

    const path = writeFinding(root, second);
    const onDisk = yaml.load(readFileSync(path, 'utf-8'));
    assert.equal(onDisk.summary, second.summary, 'post-reset write lands cleanly');
  });

  it('distinct ids still write cleanly through the singleton path', () => {
    const root = resolve(TEST_ROOT, 'singleton-finding-distinct');
    mkdirSync(root, { recursive: true });
    resetSeenWrites(root);

    const a = makeFinding('dfind-distinct-a', 'A — distinct id should write cleanly.');
    const b = makeFinding('dfind-distinct-b', 'B — distinct id should write cleanly.');

    writeFinding(root, a);
    writeFinding(root, b); // Different id — no collision.
  });
});

describe('L3-001 family-seal: writePattern/writeRecommendation/writeDoctrine singletons refuse same-process same-id', () => {
  before(setup);
  after(teardown);

  function makePattern(id, summary) {
    return {
      schema_version: '1.0.0',
      pattern_id: id,
      title: 'L3-001 fixture pattern',
      status: 'candidate',
      pattern_kind: 'recurring_failure',
      summary,
      source_finding_ids: ['dfind-x', 'dfind-y'],
      support: { finding_count: 2, repo_count: 1, surface_count: 1 },
      dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
      transfer_scope: 'surface_archetype',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
  }

  function makeRecommendation(id, summary) {
    return {
      schema_version: '1.0.0',
      recommendation_id: id,
      title: 'L3-001 fixture recommendation',
      status: 'candidate',
      recommendation_kind: 'starter_check',
      summary,
      based_on_pattern_ids: ['dpat-x'],
      applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
      action: { type: 'add_check', target: 'rollout', details: 'L3-001 fixture action details' },
      confidence: 'emerging',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
  }

  function makeDoctrine(id, statement) {
    return {
      schema_version: '1.0.0',
      doctrine_id: id,
      title: 'L3-001 fixture doctrine',
      status: 'candidate',
      doctrine_kind: 'rollout_law',
      statement,
      rationale: 'L3-001 fixture rationale spanning enough characters to satisfy the schema.',
      based_on_pattern_ids: ['dpat-x'],
      transfer_scope: 'surface_archetype',
      strength: 'proven',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
    };
  }

  it('writePattern throws PATTERN_ID_COLLISION on same-process same-id', () => {
    const root = resolve(TEST_ROOT, 'singleton-pattern-collision');
    mkdirSync(root, { recursive: true });
    resetSeenArtifactWrites(root);

    const id = 'dpat-singleton-collision-fixture';
    writePattern(root, makePattern(id, 'First singleton pattern write — must land on disk.'));
    assert.throws(
      () => writePattern(root, makePattern(id, 'Second singleton pattern write — must be REFUSED.')),
      err => {
        assert.equal(err.code, 'PATTERN_ID_COLLISION');
        assert.equal(err.name, 'PatternIdCollisionError');
        return true;
      }
    );
  });

  it('writeRecommendation throws RECOMMENDATION_ID_COLLISION on same-process same-id', () => {
    const root = resolve(TEST_ROOT, 'singleton-rec-collision');
    mkdirSync(root, { recursive: true });
    resetSeenArtifactWrites(root);

    const id = 'drec-singleton-collision-fixture';
    writeRecommendation(root, makeRecommendation(id, 'First singleton rec write — must land on disk.'));
    assert.throws(
      () => writeRecommendation(root, makeRecommendation(id, 'Second singleton rec write — must be REFUSED.')),
      err => {
        assert.equal(err.code, 'RECOMMENDATION_ID_COLLISION');
        assert.equal(err.name, 'RecommendationIdCollisionError');
        return true;
      }
    );
  });

  it('writeDoctrine throws DOCTRINE_ID_COLLISION on same-process same-id', () => {
    const root = resolve(TEST_ROOT, 'singleton-doc-collision');
    mkdirSync(root, { recursive: true });
    resetSeenArtifactWrites(root);

    const id = 'ddoc-singleton-collision-fixture';
    writeDoctrine(root, makeDoctrine(id, 'Doctrine statement A spanning enough characters for the schema.'));
    assert.throws(
      () => writeDoctrine(root, makeDoctrine(id, 'Doctrine statement B spanning enough characters for the schema.')),
      err => {
        assert.equal(err.code, 'DOCTRINE_ID_COLLISION');
        assert.equal(err.name, 'DoctrineIdCollisionError');
        return true;
      }
    );
  });
});
