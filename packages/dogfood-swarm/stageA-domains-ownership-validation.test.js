/**
 * stageA-domains-ownership-validation.test.js — d5-swarm-cli-004 sibling.
 *
 * editDomain validated ownership_class against {owned,shared,bridge}; addDomain
 * did not, so a literal bad `--ownership` value persisted unvalidated. Pins that
 * addDomain now rejects an invalid ownership_class at the same boundary, accepts
 * the three valid classes, and still allows ownership_class to be omitted.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from './db/connection.js';
import { addDomain, getDomains } from './lib/domains.js';

const RUN_ID = 'stageA-own-validate';

describe('addDomain validates ownership_class (d5-swarm-cli-004)', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  });

  afterEach(() => { try { db.close(); } catch { /* */ } });

  it('rejects an invalid ownership_class (the gap: editDomain guarded, addDomain did not)', () => {
    assert.throws(
      () => addDomain(db, RUN_ID, { name: 'backend', globs: ['src/**'], ownership_class: 'garbage' }),
      /Invalid ownership class/,
      'a bad ownership_class must be rejected at the addDomain boundary',
    );
    // And nothing was persisted — the throw happened before INSERT.
    assert.equal(getDomains(db, RUN_ID).length, 0, 'no domain row persisted on rejection');
  });

  for (const cls of ['owned', 'shared', 'bridge']) {
    it(`accepts the valid ownership_class "${cls}"`, () => {
      assert.doesNotThrow(() => addDomain(db, RUN_ID, { name: `d-${cls}`, globs: ['src/**'], ownership_class: cls }));
      const rows = getDomains(db, RUN_ID);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ownership_class, cls);
    });
  }

  it('omitting ownership_class applies the schema default "owned" (not a NULL-constraint crash)', () => {
    assert.doesNotThrow(() => addDomain(db, RUN_ID, { name: 'nodefault', globs: ['src/**'] }));
    const rows = getDomains(db, RUN_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ownership_class, 'owned', 'omitted ownership_class defaults to "owned" per the schema');
  });
});
