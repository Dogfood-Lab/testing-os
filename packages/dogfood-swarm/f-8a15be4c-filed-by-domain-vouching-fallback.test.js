/**
 * f-8a15be4c-filed-by-domain-vouching-fallback.test.js — wave-41 rider
 * (swarm-cp-tests domain), regression pin for F-8a15be4c.
 *
 * F-8a15be4c (CRITICAL, filed by swarm-cp-verbs this wave): commands/
 * collect.js's scopeConfirmedToOwningDomain resolves a declared confirmed[]
 * id via `const filePath = pathById.get(String(id).toUpperCase()); if
 * (filePath == null) continue;`. Map.get() returns undefined for an unknown
 * id and returns the column's genuine value (which legitimately can be
 * null) for a real row — `== null` matches BOTH, so a file-less finding's
 * confirmed[] declaration is dropped identically to a hallucinated id, for
 * EVERY domain, unconditionally. Proven live against the real
 * control-plane.db this wave: all 40 of this run's approved feature
 * findings have file_path IS NULL, and scopeConfirmedToOwningDomain returns
 * `[]` for every one of them regardless of which domain declares them.
 *
 * The routing side of this exact class (lib/findings-filter.js#
 * findingsForDomain, the C3/v10 amendment) already falls back to
 * `filed_by_domain` when file_path is NULL. F-8a15be4c's own text names the
 * gap precisely: "routing and vouching had better answer to one rule ...
 * yet only routing was fixed." This wave's swarm-cp-verbs lane gives
 * scopeConfirmedToOwningDomain the identical fallback: a file-less finding
 * becomes vouchable by the domain that filed it (`findings.filed_by_domain`,
 * stamped once at insert from `_declaringDomain` — lib/fingerprint.js#
 * upsertFindings) — and ONLY that domain.
 *
 * This is the F-18d0ef6d class pin (wave4-swarm-cp-pins.test.js:508, "a
 * domain cannot close a finding its own globs do not cover") extended to
 * the new fallback path. Two failure directions both matter and both are
 * pinned below:
 *
 *   - UNDER-permissive (the CRITICAL itself): the filing domain must be
 *     ABLE to vouch for its own file-less finding — pre-fix this is
 *     impossible for anyone, which is what makes it a CRITICAL and not a
 *     narrow permissions bug.
 *   - OVER-permissive (the regression the fix must not introduce): a
 *     domain that did NOT file the finding must still be refused, exactly
 *     as F-18d0ef6d already established for the file_path/glob path — a
 *     naive fix ("any file-less finding is fair game to whoever names it")
 *     would reopen the exact cross-domain-vouching hole F-18d0ef6d closed,
 *     one layer down. And a finding with NO recorded filer at all
 *     (file_path AND filed_by_domain both NULL — every pre-v10 row, or any
 *     row upserted before a caller threaded `_declaringDomain` through)
 *     must stay fail-closed for every domain: there is no legitimate owner
 *     to route the vouch to, so "nobody" is the honest answer, never a
 *     wildcard grant.
 *
 * F-8a15be4c's own fix note explicitly asks for exactly this: "add a
 * red-first fixture (a file-less approved finding + a confirming agent
 * whose domain equals filed_by_domain) proving the current code fails it
 * ... I did not add this fixture myself (audit-only pass, no tracked-file
 * writes)". This file is that fixture, written by the domain whose glob
 * actually owns *.test.js (swarm-cp-verbs owns commands/** + cli.js, not
 * test files) — the fix and its pin necessarily land in two different
 * wave-41 worktrees, merged by the coordinator.
 *
 * RED-NOW, GREEN-POST-MERGE: swarm-cp-verbs' fix lives in a sibling
 * worktree, not this one. On this worktree's current HEAD, EVERY file-less
 * finding is unvouchable by construction — so "the filing domain CAN
 * vouch" is RED today (see this domain's wave-41 output.json for the
 * scratch-worktree proof) and flips GREEN once the fallback ships. "A
 * non-filing domain CANNOT vouch" and "a null-null finding closes for
 * nobody" are already true today for the degenerate reason that NOTHING
 * can vouch for a file-less finding yet; they stay true post-merge for the
 * intended reason (fail-closed, not merely fail-everything). See
 * output.json for which assertions flip vs. which were already green.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { scopeConfirmedToOwningDomain, collect } from './commands/collect.js';
import { dispatch } from './commands/dispatch.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t.t']);
  git(repoPath, ['config', 'user.name', 't']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoPath, '.gitignore'), '.swarm/\n');
  writeFileSync(join(repoPath, 'README.md'), 'seed\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'seed']);
  return git(repoPath, ['rev-parse', 'HEAD']).trim();
}

const DOMAINS = [
  { name: 'domain-a', globs: ['packages/a/**'] },
  { name: 'domain-b', globs: ['packages/b/**'] },
];

function seedFileLessFinding(db, runId, { id, filedBy }) {
  db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, filed_by_domain, description, status)
    VALUES (?, ?, ?, 'HIGH', 'production-readiness', NULL, ?, 'a file-less finding', 'approved')`)
    .run(runId, id, `fp-${id}`, filedBy);
}

describe('F-8a15be4c: scopeConfirmedToOwningDomain file-less filed_by_domain fallback', () => {
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w41-vouch-'));
    dbPath = join(tmp, 'control-plane.db');
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  /** @pins F-8a15be4c */
  it('the filing domain CAN vouch for its own file-less finding', () => {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES ('r1', 'org/repo', '/tmp/x', ?, 'main', 'pending')`).run('a'.repeat(40));
    seedFileLessFinding(db, 'r1', { id: 'F-FILELESS-A', filedBy: 'domain-a' });

    const scoped = scopeConfirmedToOwningDomain(
      db, 'r1', DOMAINS,
      [{ domain: 'domain-a', confirmed: ['F-FILELESS-A'] }],
    );
    assert.deepEqual(scoped, ['F-FILELESS-A'],
      'pre-fix: EVERY file-less id is dropped unconditionally, even from the domain that filed it -- ' +
      'this is the CRITICAL itself: no lane, however careful, can ever close a file-less finding today');
  });

  it('a domain that did NOT file the finding cannot vouch for it through the fallback', () => {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES ('r2', 'org/repo', '/tmp/x', ?, 'main', 'pending')`).run('a'.repeat(40));
    seedFileLessFinding(db, 'r2', { id: 'F-FILELESS-B', filedBy: 'domain-a' });

    const scoped = scopeConfirmedToOwningDomain(
      db, 'r2', DOMAINS,
      [{ domain: 'domain-b', confirmed: ['F-FILELESS-B'] }],
    );
    assert.deepEqual(scoped, [],
      'a domain that did not file a file-less finding must not be able to close it through the fallback -- ' +
      'the F-18d0ef6d rule ("a domain cannot close a finding its own globs/filing does not cover") extends to ' +
      'filed_by_domain, not just file_path globs');
  });

  it('a null-null finding (no file_path, no filed_by_domain) stays fail-closed for every domain', () => {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES ('r3', 'org/repo', '/tmp/x', ?, 'main', 'pending')`).run('a'.repeat(40));
    seedFileLessFinding(db, 'r3', { id: 'F-FILELESS-NULLNULL', filedBy: null });

    const scopedA = scopeConfirmedToOwningDomain(
      db, 'r3', DOMAINS,
      [{ domain: 'domain-a', confirmed: ['F-FILELESS-NULLNULL'] }],
    );
    const scopedB = scopeConfirmedToOwningDomain(
      db, 'r3', DOMAINS,
      [{ domain: 'domain-b', confirmed: ['F-FILELESS-NULLNULL'] }],
    );
    assert.deepEqual(scopedA, [],
      'a finding with no recorded filer must never be treated as "anyone may vouch" -- fail closed, not fail open');
    assert.deepEqual(scopedB, []);
  });

  it('end-to-end through collect(): the filing domain\'s confirmed[] declaration closes its own file-less finding under full coverage', () => {
    const repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES ('r4', 'org/repo', ?, ?, 'main', 'pending')`).run(repoPath, 'a'.repeat(40));
    saveDomainDraft(db, 'r4', [
      { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
      { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, 'r4');
    seedFileLessFinding(db, 'r4', { id: 'F-FILELESS-E2E', filedBy: 'domain-a' });

    dispatch({ runId: 'r4', phase: 'health-audit-a', dbPath, outputDir: tmp });
    const outA = join(tmp, 'ea.json');
    const outB = join(tmp, 'eb.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a', stage: 'A', summary: 'clean', findings: [], confirmed: ['F-FILELESS-E2E'],
    }));
    writeFileSync(outB, JSON.stringify({ domain: 'domain-b', stage: 'A', summary: 'clean', findings: [] }));
    const report = collect({ runId: 'r4', dbPath, outputs: { 'domain-a': outA, 'domain-b': outB } });

    assert.equal(report.findings.fixed, 1,
      'pre-fix: collect() never marks a file-less finding fixed, no matter who correctly declares it');
    const row = db.prepare("SELECT status FROM findings WHERE run_id = 'r4' AND finding_id = 'F-FILELESS-E2E'").get();
    assert.equal(row.status, 'fixed');
  });
});
