/**
 * findings-filter-filed-by-domain-fallback.test.js — F-874c0683 / F-aa32371b
 * (C3 amendment): findingsForDomain must route a file-less approved finding
 * to whichever domain FILED it (findings.filed_by_domain), instead of
 * silently excluding it from every domain's amend queue forever.
 *
 * Background (proven at pass scale by this wave's own dispatch preview): a
 * finding with no file_path has no glob to match, so the pre-v10
 * file_path-only filter returned it for ZERO domains — an approved,
 * file-less finding was permanently unbuildable, yet still counted as OPEN
 * against the finding-severity advancement gate. dispatch.js's own
 * F-aa32371b comment names this class as a loud dispatch-time warning
 * because nothing could ever route (and therefore fix) it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { findingsForDomain } from './findings-filter.js';

function seedRun(db, runId = 'run-fbd') {
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`
  ).run(runId, 'a'.repeat(40));
  return runId;
}

function seedFinding(db, runId, { findingId, fingerprint, filePath, filedByDomain }) {
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, filed_by_domain)
     VALUES (?, ?, ?, 'HIGH', 'missing-feature', ?, 'a file-less feature finding', 'approved', ?)`
  ).run(runId, findingId, fingerprint, filePath ?? null, filedByDomain ?? null);
}

describe('findingsForDomain — file-less approved findings fall back to filed_by_domain (F-874c0683)', () => {
  it('routes a file-less finding to the domain that filed it', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedFinding(db, runId, { findingId: 'F-fileless', fingerprint: 'fp-fileless', filePath: null, filedByDomain: 'docs' });

    const routed = findingsForDomain(db, runId, { globs: ['packages/dogfood-swarm/lib/**'], name: 'docs' });
    assert.equal(routed.length, 1, 'the file-less finding must route to its filing domain');
    assert.equal(routed[0].finding_id, 'F-fileless');
  });

  it('does NOT route a file-less finding to a domain that did not file it', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedFinding(db, runId, { findingId: 'F-fileless', fingerprint: 'fp-fileless', filePath: null, filedByDomain: 'docs' });

    const routed = findingsForDomain(db, runId, { globs: ['packages/dogfood-swarm/lib/**'], name: 'swarm-cp-core' });
    assert.equal(routed.length, 0, 'a non-filing domain must not receive the file-less finding');
  });

  it('a pre-v10 file-less finding (filed_by_domain NULL) routes to NO domain — never guessed', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedFinding(db, runId, { findingId: 'F-legacy-fileless', fingerprint: 'fp-legacy-fileless', filePath: null, filedByDomain: null });

    const routedDocs = findingsForDomain(db, runId, { globs: ['site/**'], name: 'docs' });
    const routedCore = findingsForDomain(db, runId, { globs: ['packages/dogfood-swarm/lib/**'], name: 'swarm-cp-core' });
    assert.equal(routedDocs.length, 0, 'a NULL filed_by_domain must not guess-match any domain');
    assert.equal(routedCore.length, 0, 'a NULL filed_by_domain must not guess-match any domain');
  });

  it('a domain object missing `name` (e.g. commands/resume.js\'s bare {globs} shape) degrades safely: never a false match', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedFinding(db, runId, { findingId: 'F-fileless', fingerprint: 'fp-fileless', filePath: null, filedByDomain: 'docs' });

    const routed = findingsForDomain(db, runId, { globs: ['**/*'] });
    assert.equal(routed.length, 0, 'undefined domain.name must never equal a real filed_by_domain string');
  });

  it('a finding WITH a file_path is unaffected — still routed purely by glob match, filed_by_domain ignored', () => {
    const db = openMemoryDb();
    const runId = seedRun(db);
    seedFinding(db, runId, {
      findingId: 'F-has-file', fingerprint: 'fp-has-file',
      filePath: 'packages/dogfood-swarm/lib/foo.js', filedByDomain: 'docs',
    });

    // Owned by swarm-cp-core's glob, filed_by_domain says 'docs' — the
    // file_path match must win; filed_by_domain is a fallback, not an
    // override, for findings that DO have a path.
    const routedCore = findingsForDomain(db, runId, { globs: ['packages/dogfood-swarm/lib/**'], name: 'swarm-cp-core' });
    const routedDocs = findingsForDomain(db, runId, { globs: ['site/**'], name: 'docs' });
    assert.equal(routedCore.length, 1, 'file_path glob match must route to the owning domain');
    assert.equal(routedDocs.length, 0, 'filed_by_domain must not override a real file_path glob mismatch');
  });
});
