/**
 * f-2710aadf-coordinator-ownership-class.test.js — GitHub #67 / F-2710aadf.
 *
 * Proves the ownership spine can express a class that is exclusive under
 * resolveExclusiveOwner/checkOwnership AND non-agent-bearing (skipped at
 * dispatch). Pre-fix HEAD only had owned/shared/bridge: every exclusive
 * class was agent-bearing, and the only skip class (shared) was multi-writer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { STATUS } from '../db/schema.js';
import {
  addDomain,
  checkOwnership,
  editDomain,
  isAgentBearingOwnershipClass,
  isExclusiveOwnershipClass,
  resolveExclusiveOwner,
} from './domains.js';

const RUN_ID = 'f-2710aadf-coordinator';

describe('F-2710aadf — coordinator ownership class (exclusive + non-agent-bearing)', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  });

  afterEach(() => { try { db.close(); } catch { /* */ } });

  /** @pins F-2710aadf */
  it('STATUS.ownership_class includes coordinator alongside owned/shared/bridge', () => {
    assert.deepEqual(
      [...STATUS.ownership_class].sort(),
      ['bridge', 'coordinator', 'owned', 'shared'].sort(),
      'pre-fix triad owned/shared/bridge cannot express exclusive+skipped',
    );
  });

  /** @pins F-2710aadf */
  it('addDomain and editDomain accept ownership_class "coordinator"', () => {
    assert.doesNotThrow(
      () => addDomain(db, RUN_ID, { name: 'docs', globs: ['docs/**', 'README.md'], ownership_class: 'coordinator' }),
      'addDomain must accept coordinator (GitHub #67)',
    );
    assert.doesNotThrow(
      () => editDomain(db, RUN_ID, 'docs', { ownership_class: 'coordinator' }),
      'editDomain must accept coordinator',
    );
  });

  /** @pins F-2710aadf */
  it('coordinator is exclusive and not agent-bearing; shared stays multi-writer', () => {
    assert.equal(isExclusiveOwnershipClass('coordinator'), true);
    assert.equal(isAgentBearingOwnershipClass('coordinator'), false,
      'coordinator must be skipped at dispatch (verbs filter consumes this helper)');

    assert.equal(isExclusiveOwnershipClass('owned'), true);
    assert.equal(isAgentBearingOwnershipClass('owned'), true);

    assert.equal(isExclusiveOwnershipClass('shared'), false);
    assert.equal(isAgentBearingOwnershipClass('shared'), false);

    assert.equal(isExclusiveOwnershipClass('bridge'), false);
    assert.equal(isAgentBearingOwnershipClass('bridge'), true);
  });

  /** @pins F-2710aadf */
  it('resolveExclusiveOwner + checkOwnership name the coordinator domain (not unassigned)', () => {
    addDomain(db, RUN_ID, { name: 'backend', globs: ['packages/**'], ownership_class: 'owned' });
    addDomain(db, RUN_ID, { name: 'docs', globs: ['docs/**', 'README.md'], ownership_class: 'coordinator' });
    addDomain(db, RUN_ID, { name: 'lockfiles', globs: ['package-lock.json'], ownership_class: 'shared' });

    const domains = [
      { name: 'backend', globs: ['packages/**'], ownership_class: 'owned' },
      { name: 'docs', globs: ['docs/**', 'README.md'], ownership_class: 'coordinator' },
      { name: 'lockfiles', globs: ['package-lock.json'], ownership_class: 'shared' },
    ];

    assert.equal(
      resolveExclusiveOwner(domains, 'docs/guide.md'),
      'docs',
      'pre-fix resolveExclusiveOwner only considered owned — SQL-forced coordinator returned null',
    );
    assert.equal(resolveExclusiveOwner(domains, 'README.md'), 'docs');
    assert.equal(resolveExclusiveOwner(domains, 'packages/a/index.js'), 'backend');
    assert.equal(resolveExclusiveOwner(domains, 'package-lock.json'), null,
      'shared must remain multi-writer (no exclusive owner)');

    const violation = checkOwnership(db, RUN_ID, 'backend', ['docs/guide.md', 'README.md']);
    assert.equal(violation.violations.length, 2);
    assert.equal(violation.violations[0].actual_owner, 'docs',
      'pre-fix checkOwnership reported actual_owner "unassigned" for coordinator-owned files');
    assert.equal(violation.violations[1].actual_owner, 'docs');

    const sharedOk = checkOwnership(db, RUN_ID, 'backend', ['package-lock.json']);
    assert.equal(sharedOk.violations.length, 0);
    assert.equal(sharedOk.valid[0].reason, 'shared via lockfiles',
      'shared must stay write-valid for every agent');
  });
});
