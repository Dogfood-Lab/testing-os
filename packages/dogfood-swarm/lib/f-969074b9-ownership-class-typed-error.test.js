/**
 * F-969074b9 — invalid ownership_class rejects with a typed error that names
 * the live STATUS.ownership_class enum and carries .code/.hint so
 * renderTopLevelError emits ERROR [DOMAINS_INVALID_OWNERSHIP_CLASS]: + Next:.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { STATUS } from '../db/schema.js';
import { addDomain, editDomain } from './domains.js';
import { DomainsInvalidOwnershipError } from './errors.js';
import { renderTopLevelError } from './error-render.js';

const RUN_ID = 'f-969074b9-own';

function captureRender(err) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    renderTopLevelError(err);
  } finally {
    console.error = orig;
  }
  return lines;
}

describe('F-969074b9 — typed invalid ownership_class rejection', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  });

  afterEach(() => { try { db.close(); } catch { /* */ } });

  /** @pins F-969074b9 */
  it('addDomain rejects unknown ownership_class with DomainsInvalidOwnershipError naming the live enum', () => {
    let err = null;
    try {
      addDomain(db, RUN_ID, { name: 'backend', globs: ['src/**'], ownership_class: 'exclusive' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof DomainsInvalidOwnershipError);
    assert.equal(err.code, 'DOMAINS_INVALID_OWNERSHIP_CLASS');
    assert.equal(err.received, 'exclusive');
    assert.deepEqual(err.valid, [...STATUS.ownership_class]);
    for (const cls of STATUS.ownership_class) {
      assert.match(err.message, new RegExp(cls));
    }
    assert.match(err.hint, /owned\|shared\|bridge\|coordinator/);
  });

  /** @pins F-969074b9 */
  it('editDomain rejects unknown ownership_class the same way', () => {
    addDomain(db, RUN_ID, { name: 'backend', globs: ['src/**'], ownership_class: 'owned' });
    assert.throws(
      () => editDomain(db, RUN_ID, 'backend', { ownership_class: 'coordinater' }),
      (e) => e instanceof DomainsInvalidOwnershipError
        && e.code === 'DOMAINS_INVALID_OWNERSHIP_CLASS'
        && /owned\|shared\|bridge\|coordinator/.test(e.message)
        && /owned\|shared\|bridge\|coordinator/.test(e.hint),
    );
  });

  /** @pins F-969074b9 */
  it('renderTopLevelError emits ERROR [DOMAINS_INVALID_OWNERSHIP_CLASS]: and Next:', () => {
    let err = null;
    try {
      addDomain(db, RUN_ID, { name: 'x', globs: ['x/**'], ownership_class: 'garbage' });
    } catch (e) {
      err = e;
    }
    const lines = captureRender(err);
    assert.match(lines[0] || '', /ERROR \[DOMAINS_INVALID_OWNERSHIP_CLASS\]:/);
    assert.ok(lines.some((l) => l.trim().startsWith('Next:') && /owned\|shared\|bridge\|coordinator/.test(l)));
  });
});
