/**
 * stageA-ds-mut-003-ownership-bypass.test.js
 *
 * DS-MUT-003 (MED, Stage A amend):
 *
 * checkOwnership resolves a file's single exclusive owner via
 * resolveExclusiveOwner, but when that owner was a DIFFERENT owned domain than
 * the agent, it still fell through to the shared/bridge glob fallback. A file
 * EXCLUSIVELY owned by domain B was then ruled "valid (shared via <shared>)"
 * for agent A whenever a broad shared glob ALSO matched it — the classic case
 * being a root tsconfig.json claimed by an owned ci-tooling domain
 * (`tsconfig*.json`) AND the shared `*.json` glob. That silently bypasses
 * exclusive ownership.
 *
 * Post-fix: the shared/bridge fallback applies ONLY when the file has no
 * exclusive owner. A non-null exclusive owner that is a different domain than
 * the agent is a VIOLATION. Genuinely unowned/shared files keep their
 * shared-valid behavior, and the true owner editing its own file stays valid.
 *
 * Real in-memory control plane, real domains, real checkOwnership — no mocks.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { saveDomainDraft, checkOwnership } from './lib/domains.js';

describe('DS-MUT-003 — shared/bridge fallback must not override a non-null exclusive owner', () => {
  let db;
  const RUN_ID = 'ds-mut-003-run';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  });
  afterEach(() => db.close());

  it('a file exclusively owned by domain B is a VIOLATION for agent A even when a shared glob also matches it', () => {
    // tsconfig.json is claimed by the owned ci-tooling domain (`tsconfig*.json`)
    // AND by the broad shared `*.json` glob. Agent `docs` (owns `*.md`) edits
    // it — pre-fix the shared match ruled it "shared via shared" (bypass).
    saveDomainDraft(db, RUN_ID, [
      { name: 'ci-tooling', globs: ['tsconfig*.json'], ownership_class: 'owned' },
      { name: 'docs', globs: ['*.md'], ownership_class: 'owned' },
      { name: 'shared', globs: ['*.json'], ownership_class: 'shared' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'docs', ['tsconfig.json']);

    assert.equal(result.valid.length, 0, 'must NOT be ruled shared-valid');
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].actual_owner, 'ci-tooling',
      'the violation must name the true exclusive owner, not the shared domain');
  });

  it('a bridge glob likewise cannot override another domain\'s exclusive ownership', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'ci-tooling', globs: ['tsconfig*.json'], ownership_class: 'owned' },
      { name: 'docs', globs: ['*.md'], ownership_class: 'owned' },
      { name: 'shared-types', globs: ['*.json'], ownership_class: 'bridge' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'docs', ['tsconfig.json']);

    assert.equal(result.valid.length, 0, 'a bridge glob must not override an exclusive owner');
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].actual_owner, 'ci-tooling');
  });

  it('preserves shared-valid for a genuinely UNOWNED file (no owned domain claims it)', () => {
    // package.json is matched by NO owned glob (tsconfig*.json / *.md) — only
    // the shared *.json. It must still pass as shared-valid; the fix must not
    // over-correct and start flagging real shared files.
    saveDomainDraft(db, RUN_ID, [
      { name: 'ci-tooling', globs: ['tsconfig*.json'], ownership_class: 'owned' },
      { name: 'docs', globs: ['*.md'], ownership_class: 'owned' },
      { name: 'shared', globs: ['*.json'], ownership_class: 'shared' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'docs', ['package.json']);

    assert.equal(result.violations.length, 0);
    assert.equal(result.valid.length, 1);
    assert.equal(result.valid[0].reason, 'shared via shared');
  });

  it('the exclusive owner editing its OWN file stays valid (matches own domain)', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'ci-tooling', globs: ['tsconfig*.json'], ownership_class: 'owned' },
      { name: 'shared', globs: ['*.json'], ownership_class: 'shared' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'ci-tooling', ['tsconfig.json']);

    assert.equal(result.violations.length, 0);
    assert.equal(result.valid.length, 1);
    assert.equal(result.valid[0].reason, 'matches own domain');
  });
});
