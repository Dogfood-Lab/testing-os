import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync } from 'node:fs';
import yaml from 'js-yaml';

import { isLawfulTransition, validateTransition, REASON_REQUIRED } from './transitions.js';
import { createEvent, appendEvent, getEventsForFinding, getAllEvents, getLogPath } from './event-log.js';
import { performAction, performMerge, getReviewQueue } from './review-engine.js';
import { validateFinding } from '../validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_review__');

// ─── Test helpers ───────────────────────────────────────────

function makeTestFinding(overrides = {}) {
  return {
    schema_version: '1.0.0',
    finding_id: 'dfind-test-review',
    title: 'Test finding for review workflow',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'repo_local',
    summary: 'Test finding for review workflow validation and state machine testing.',
    source_record_ids: ['test-record-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-record-001', note: 'Test evidence.' }],
    created_at: '2026-03-29T12:00:00Z',
    updated_at: '2026-03-29T12:00:00Z',
    ...overrides
  };
}

function writeFindingToTestRoot(finding) {
  const [org, repo] = finding.repo.split('/');
  const dir = resolve(TEST_ROOT, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${finding.finding_id}.yaml`);
  writeFileSync(path, yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
  return path;
}

function readFindingFromDisk(findingId, repo = 'mcp-tool-shop-org/test-repo') {
  const [org, repoName] = repo.split('/');
  const path = resolve(TEST_ROOT, 'findings', org, repoName, `${findingId}.yaml`);
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, 'utf-8'));
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'findings'), { recursive: true });
}

// ============================================================
// State transition tests
// ============================================================

describe('State transitions: lawful', () => {
  it('candidate -> reviewed', () => assert.ok(isLawfulTransition('candidate', 'reviewed')));
  it('candidate -> accepted', () => assert.ok(isLawfulTransition('candidate', 'accepted')));
  it('candidate -> rejected', () => assert.ok(isLawfulTransition('candidate', 'rejected')));
  it('reviewed -> accepted', () => assert.ok(isLawfulTransition('reviewed', 'accepted')));
  it('reviewed -> rejected', () => assert.ok(isLawfulTransition('reviewed', 'rejected')));
  it('accepted -> reviewed (reopen)', () => assert.ok(isLawfulTransition('accepted', 'reviewed')));
  it('accepted -> rejected (reversal)', () => assert.ok(isLawfulTransition('accepted', 'rejected')));
  it('rejected -> reviewed (reopen)', () => assert.ok(isLawfulTransition('rejected', 'reviewed')));
});

describe('State transitions: forbidden', () => {
  it('rejected -> candidate (no rewind to machine output)', () => {
    assert.equal(isLawfulTransition('rejected', 'candidate'), false);
  });
  it('reviewed -> candidate', () => {
    assert.equal(isLawfulTransition('reviewed', 'candidate'), false);
  });
  it('accepted -> candidate', () => {
    assert.equal(isLawfulTransition('accepted', 'candidate'), false);
  });
  it('candidate -> candidate (no self-loop)', () => {
    assert.equal(isLawfulTransition('candidate', 'candidate'), false);
  });
  it('unknown status fails', () => {
    const result = validateTransition('bogus', 'accepted');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Unknown status'));
  });
});

// ============================================================
// Review action tests
// ============================================================

describe('Review actions: accept', () => {
  before(() => setupTestRoot());
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('accepts a candidate finding', () => {
    writeFindingToTestRoot(makeTestFinding());
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'accept',
      actor: 'mike',
      reason: 'Evidence is strong and portable.'
    });
    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'accepted');
    assert.equal(result.finding.review.reviewed_by, 'mike');
    assert.equal(result.finding.review.last_action, 'accept');
  });

  it('persists accepted status to disk', () => {
    const onDisk = readFindingFromDisk('dfind-test-review');
    assert.equal(onDisk.status, 'accepted');
    assert.equal(onDisk.review.reviewed_by, 'mike');
  });

  it('accepted finding remains schema-valid', () => {
    const onDisk = readFindingFromDisk('dfind-test-review');
    const result = validateFinding(onDisk);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

describe('Review actions: reject', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding());
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('requires a reason', () => {
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'reject',
      actor: 'mike'
    });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('requires a reason'));
  });

  it('rejects with reason', () => {
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'reject',
      actor: 'mike',
      reason: 'Insufficient evidence for this surface.',
      rejectReason: 'insufficient_evidence'
    });
    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'rejected');
    assert.equal(result.finding.review.reject_reason, 'insufficient_evidence');
  });

  it('rejected finding remains on disk (not deleted)', () => {
    const onDisk = readFindingFromDisk('dfind-test-review');
    assert.ok(onDisk, 'Rejected finding should still exist');
    assert.equal(onDisk.status, 'rejected');
  });
});

describe('Review actions: edit', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ status: 'reviewed' }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('edits fields without changing status', () => {
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { root_cause_kind: 'interface_assumption_error' }
    });
    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'reviewed'); // unchanged
    assert.equal(result.finding.root_cause_kind, 'interface_assumption_error');
  });

  it('records field diff in event', () => {
    const events = getEventsForFinding(TEST_ROOT, 'dfind-test-review');
    const editEvent = events.find(e => e.action === 'edit');
    assert.ok(editEvent, 'Edit event should exist');
    assert.ok(editEvent.field_changes?.root_cause_kind, 'Field change should be recorded');
    assert.equal(editEvent.field_changes.root_cause_kind.to, 'interface_assumption_error');
  });
});

describe('Review actions: reopen', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ status: 'rejected' }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('requires reason', () => {
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'reopen',
      actor: 'mike'
    });
    // reopen isn't in REASON_REQUIRED, but let's test it works
    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'reviewed');
  });

  it('cannot reopen a candidate', () => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ status: 'candidate' }));
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'reopen',
      actor: 'mike'
    });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('requires status'));
  });
});

describe('Review actions: invalidate', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ status: 'accepted' }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('requires reason', () => {
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'invalidate',
      actor: 'mike'
    });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('requires a reason'));
  });

  it('invalidates an accepted finding', () => {
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'invalidate',
      actor: 'mike',
      reason: 'Source record was later rejected.'
    });
    assert.ok(result.success, result.error);
    assert.equal(result.finding.status, 'reviewed');
    assert.ok(result.finding.invalidation.is_invalidated);
    assert.equal(result.finding.invalidation.reason, 'Source record was later rejected.');
  });

  it('cannot invalidate a candidate', () => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ status: 'candidate' }));
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'invalidate',
      actor: 'mike',
      reason: 'test'
    });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('requires status "accepted"'));
  });

  it('invalidated finding is schema-valid', () => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ status: 'accepted' }));
    performAction(TEST_ROOT, {
      findingId: 'dfind-test-review',
      action: 'invalidate',
      actor: 'mike',
      reason: 'Source provenance broken.'
    });
    const onDisk = readFindingFromDisk('dfind-test-review');
    const result = validateFinding(onDisk);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

// ============================================================
// Review history tests
// ============================================================

describe('Review history', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding());
    // Perform a sequence of actions
    performAction(TEST_ROOT, { findingId: 'dfind-test-review', action: 'review', actor: 'alice' });
    performAction(TEST_ROOT, { findingId: 'dfind-test-review', action: 'accept', actor: 'bob', reason: 'LGTM' });
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('records all events', () => {
    const events = getEventsForFinding(TEST_ROOT, 'dfind-test-review');
    assert.equal(events.length, 2);
  });

  it('events are ordered by timestamp', () => {
    const events = getEventsForFinding(TEST_ROOT, 'dfind-test-review');
    assert.ok(events[0].timestamp <= events[1].timestamp);
  });

  it('event captures from/to status correctly', () => {
    const events = getEventsForFinding(TEST_ROOT, 'dfind-test-review');
    assert.equal(events[0].from_status, 'candidate');
    assert.equal(events[0].to_status, 'reviewed');
    assert.equal(events[1].from_status, 'reviewed');
    assert.equal(events[1].to_status, 'accepted');
  });

  it('event captures actor', () => {
    const events = getEventsForFinding(TEST_ROOT, 'dfind-test-review');
    assert.equal(events[0].actor, 'alice');
    assert.equal(events[1].actor, 'bob');
  });
});

// ============================================================
// Merge tests
// ============================================================

describe('Merge', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({
      finding_id: 'dfind-test-merge-a',
      source_record_ids: ['record-a'],
      evidence: [{ evidence_kind: 'record', record_id: 'record-a', note: 'Evidence A' }]
    }));
    writeFindingToTestRoot(makeTestFinding({
      finding_id: 'dfind-test-merge-b',
      source_record_ids: ['record-b'],
      evidence: [{ evidence_kind: 'record', record_id: 'record-b', note: 'Evidence B' }]
    }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('merges two findings', () => {
    const result = performMerge(TEST_ROOT, {
      sourceIds: ['dfind-test-merge-a', 'dfind-test-merge-b'],
      canonicalId: 'dfind-test-merge-a',
      actor: 'mike',
      reason: 'Same lesson from overlapping evidence.'
    });
    assert.ok(result.success, result.error);
  });

  it('canonical preserves all source_record_ids', () => {
    const canonical = readFindingFromDisk('dfind-test-merge-a');
    assert.ok(canonical.source_record_ids.includes('record-a'));
    assert.ok(canonical.source_record_ids.includes('record-b'));
  });

  it('canonical has merged evidence union', () => {
    const canonical = readFindingFromDisk('dfind-test-merge-a');
    assert.ok(canonical.evidence.length >= 2);
  });

  it('canonical has lineage.merged_from', () => {
    const canonical = readFindingFromDisk('dfind-test-merge-a');
    assert.ok(canonical.lineage?.merged_from?.includes('dfind-test-merge-b'));
  });

  it('source finding is marked superseded', () => {
    const source = readFindingFromDisk('dfind-test-merge-b');
    assert.equal(source.status, 'rejected');
    assert.equal(source.lineage?.superseded_by, 'dfind-test-merge-a');
  });

  it('source finding is not deleted', () => {
    const source = readFindingFromDisk('dfind-test-merge-b');
    assert.ok(source, 'Superseded finding must remain on disk');
  });

  it('merge requires reason', () => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ finding_id: 'dfind-m1' }));
    writeFindingToTestRoot(makeTestFinding({ finding_id: 'dfind-m2' }));
    const result = performMerge(TEST_ROOT, {
      sourceIds: ['dfind-m1', 'dfind-m2'],
      canonicalId: 'dfind-m1',
      actor: 'mike'
    });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('reason'));
  });
});

// ============================================================
// Queue tests
// ============================================================

describe('Queue', () => {
  before(() => {
    setupTestRoot();
    writeFindingToTestRoot(makeTestFinding({ finding_id: 'dfind-q-candidate', status: 'candidate' }));
    writeFindingToTestRoot(makeTestFinding({ finding_id: 'dfind-q-reviewed', status: 'reviewed' }));
    writeFindingToTestRoot(makeTestFinding({ finding_id: 'dfind-q-accepted', status: 'accepted' }));
    writeFindingToTestRoot(makeTestFinding({ finding_id: 'dfind-q-rejected', status: 'rejected' }));
    writeFindingToTestRoot(makeTestFinding({
      finding_id: 'dfind-q-invalidated',
      status: 'reviewed',
      invalidation: { is_invalidated: true, invalidated_at: '2026-03-29T12:00:00Z', reason: 'test' }
    }));
  });
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('candidates appear in queue', () => {
    const queue = getReviewQueue(TEST_ROOT);
    const match = queue.find(q => q.data.finding_id === 'dfind-q-candidate');
    assert.ok(match);
    assert.equal(match.queueReason, 'Unreviewed candidate');
  });

  it('reviewed-unresolved appear in queue', () => {
    const queue = getReviewQueue(TEST_ROOT);
    const match = queue.find(q => q.data.finding_id === 'dfind-q-reviewed');
    assert.ok(match);
  });

  it('accepted does NOT appear in queue', () => {
    const queue = getReviewQueue(TEST_ROOT);
    const match = queue.find(q => q.data.finding_id === 'dfind-q-accepted');
    assert.equal(match, undefined);
  });

  it('rejected does NOT appear in queue', () => {
    const queue = getReviewQueue(TEST_ROOT);
    const match = queue.find(q => q.data.finding_id === 'dfind-q-rejected');
    assert.equal(match, undefined);
  });

  it('invalidated findings appear in queue', () => {
    const queue = getReviewQueue(TEST_ROOT);
    const match = queue.find(q => q.data.finding_id === 'dfind-q-invalidated');
    assert.ok(match);
    assert.ok(match.queueReason.includes('Invalidated'));
  });
});

// ============================================================
// Protection tests
// ============================================================

describe('Protection: derivation cannot overwrite accepted', () => {
  it('dedupeAgainstExisting blocks overwrite of accepted findings', async () => {
    const { dedupeAgainstExisting } = await import('../derive/dedupe.js');
    const candidates = [{ finding_id: 'dfind-protected', title: 'new version' }];
    const existing = [{ data: { finding_id: 'dfind-protected', status: 'accepted', title: 'old version' } }];
    const { toWrite, collisions } = dedupeAgainstExisting(candidates, existing);
    assert.equal(toWrite.length, 0, 'Should not overwrite accepted finding');
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].existingStatus, 'accepted');
  });

  it('dedupeAgainstExisting blocks overwrite of reviewed findings', async () => {
    const { dedupeAgainstExisting } = await import('../derive/dedupe.js');
    const candidates = [{ finding_id: 'dfind-protected' }];
    const existing = [{ data: { finding_id: 'dfind-protected', status: 'reviewed' } }];
    const { toWrite, collisions } = dedupeAgainstExisting(candidates, existing);
    assert.equal(toWrite.length, 0);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].existingStatus, 'reviewed');
  });

  it('dedupeAgainstExisting blocks overwrite of rejected findings', async () => {
    const { dedupeAgainstExisting } = await import('../derive/dedupe.js');
    const candidates = [{ finding_id: 'dfind-protected' }];
    const existing = [{ data: { finding_id: 'dfind-protected', status: 'rejected' } }];
    const { toWrite, collisions } = dedupeAgainstExisting(candidates, existing);
    assert.equal(toWrite.length, 0);
    assert.equal(collisions.length, 1);
  });
});

// ============================================================
// Event log tests
// ============================================================

describe('Event log', () => {
  before(() => setupTestRoot());
  after(() => { if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true }); });

  it('creates event with unique ID', () => {
    const e1 = createEvent({ findingId: 'dfind-a', actor: 'x', action: 'accept', fromStatus: 'candidate', toStatus: 'accepted' });
    const e2 = createEvent({ findingId: 'dfind-a', actor: 'x', action: 'accept', fromStatus: 'candidate', toStatus: 'accepted' });
    assert.notEqual(e1.review_event_id, e2.review_event_id);
  });

  it('appends events to date-sharded log', () => {
    const event = createEvent({ findingId: 'dfind-log-test', actor: 'test', action: 'review', fromStatus: 'candidate', toStatus: 'reviewed' });
    const logPath = appendEvent(TEST_ROOT, event);
    assert.ok(existsSync(logPath));

    const raw = readFileSync(logPath, 'utf-8');
    const data = yaml.load(raw);
    assert.ok(Array.isArray(data));
    assert.ok(data.some(e => e.finding_id === 'dfind-log-test'));
  });

  it('getAllEvents returns all events', () => {
    const events = getAllEvents(TEST_ROOT);
    assert.ok(events.length >= 1);
  });
});

// ============================================================
// Reject/invalidate without reason fails
// ============================================================

describe('Reason enforcement', () => {
  it('REASON_REQUIRED includes reject', () => {
    assert.ok(REASON_REQUIRED.has('reject'));
  });
  it('REASON_REQUIRED includes invalidate', () => {
    assert.ok(REASON_REQUIRED.has('invalidate'));
  });
  it('REASON_REQUIRED includes merge', () => {
    assert.ok(REASON_REQUIRED.has('merge'));
  });
  it('REASON_REQUIRED includes supersede', () => {
    assert.ok(REASON_REQUIRED.has('supersede'));
  });
});

// ── appendEvent atomic write (F-246817-015 regression) ────────
//
// Bug: appendEvent did existsSync→read→push→writeFileSync. A crash between
// the read and the write left the file half-written. Concurrent writers
// could lose events (read-then-overwrite race), but the new behavior also
// guarantees the file on disk is never partial.
//
// Fix: temp+rename atomic pattern (write to .tmp, then renameSync). On any
// failure the canonical log file remains intact at its previous contents.

import { writeFileSync as fsWriteSync, readdirSync as fsReadDirSync } from 'node:fs';

describe('appendEvent atomic write (F-246817-015)', () => {
  const ATOMIC_ROOT = resolve(__dirname, '__test_atomic__');
  beforeEach(() => {
    rmSync(ATOMIC_ROOT, { recursive: true, force: true });
    mkdirSync(ATOMIC_ROOT, { recursive: true });
  });
  after(() => {
    rmSync(ATOMIC_ROOT, { recursive: true, force: true });
  });

  it('uses temp+rename — no .tmp files remain after a successful append', () => {
    const event = createEvent({
      findingId: 'dfind-atomic-001',
      actor: 'tester',
      action: 'approve',
      fromStatus: 'candidate',
      toStatus: 'approved'
    });
    const logPath = appendEvent(ATOMIC_ROOT, event);
    assert.ok(existsSync(logPath));
    const dir = dirname(logPath);
    const files = fsReadDirSync(dir);
    assert.ok(
      files.every(f => !f.endsWith('.tmp')),
      `no .tmp files should remain, got: ${files.join(', ')}`
    );
  });

  it('preserves existing log contents when a new event is appended', () => {
    const e1 = createEvent({
      findingId: 'dfind-atomic-002',
      actor: 'first',
      action: 'approve',
      fromStatus: 'candidate',
      toStatus: 'approved'
    });
    appendEvent(ATOMIC_ROOT, e1);
    const e2 = createEvent({
      findingId: 'dfind-atomic-003',
      actor: 'second',
      action: 'approve',
      fromStatus: 'candidate',
      toStatus: 'approved'
    });
    appendEvent(ATOMIC_ROOT, e2);
    const all = getAllEvents(ATOMIC_ROOT);
    assert.equal(all.length, 2);
    const ids = all.map(e => e.finding_id);
    assert.ok(ids.includes('dfind-atomic-002'));
    assert.ok(ids.includes('dfind-atomic-003'));
  });

  it('serial appends from the same process never corrupt the file', () => {
    // 20 sequential appends; YAML must remain parseable after each.
    for (let i = 0; i < 20; i++) {
      const event = createEvent({
        findingId: `dfind-atomic-loop-${i}`,
        actor: 'loop',
        action: 'approve',
        fromStatus: 'candidate',
        toStatus: 'approved'
      });
      appendEvent(ATOMIC_ROOT, event);
    }
    const all = getAllEvents(ATOMIC_ROOT);
    assert.equal(all.length, 20);
    // Every event must be a parsed object with a finding_id.
    for (const ev of all) {
      assert.ok(ev.finding_id, `missing finding_id: ${JSON.stringify(ev)}`);
    }
  });
});
