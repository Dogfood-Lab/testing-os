/**
 * honor-reused-finding-ids.test.js — the CONFIRM queue's id-reuse promise,
 * made mechanical, with the authority rules its first adversarial review
 * demanded.
 *
 * The audit brief tells an agent re-verifying a still-present open prior:
 * "Report it again, reusing its id from below. That records it as recurring,
 * not as a duplicate." Before honorReusedFindingIds existed, that sentence
 * was not true: matching ran purely on the content fingerprint (category,
 * rule_id, path, symbol, line-context) — fields the queue does not show the
 * agent — and the agent-supplied id was never read. A faithful re-report with
 * a rewritten description and a re-derived line minted a NEW duplicate row
 * while its prior stayed open as `unverified`, a status `swarm approve`
 * cannot route to an amend. Measured on the live run this was built during:
 * 10 of 14 intended re-reports in one wave duplicated instead of recurring.
 * Content matching also cannot be patched into reliability: the context-hash
 * LOCATION component is recomputed from CURRENT source at every collect, so
 * any edit near the finding between waves breaks even a byte-faithful match.
 *
 * The first version of this helper was reviewed adversarially pre-ship and
 * returned DO-NOT-SHIP with live PoCs; the rules those PoCs forced are pinned
 * here alongside the original promise:
 *
 *   - OWNERSHIP: the queue is run-wide, so echoing an id+file proves only
 *     that an agent can read its own prompt. Honoring requires the DECLARING
 *     domain's globs to cover the prior's file — the same matchesAnyGlob
 *     authority the confirmed[] close path uses (F-18d0ef6d's rule).
 *   - THE APPROVED WINDOW: approved means queued-for-amend; recurring it
 *     would silently drop it out of amend routing. Never honored, logged.
 *   - KEEPER PRECEDENCE: a declared, honored reuse beats content heuristics
 *     in a same-wave collision group, so a coincidental fingerprint sibling
 *     can neither steal the prior's row nor push the true re-report into a
 *     salted duplicate.
 *
 * WHAT happens on a match stays with classifyFindings' existing branches —
 * recurring for open priors, regression-reopen for fixed (now owner-only),
 * status-preserving recurred_while_closed for deferred.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from '../db/connection.js';
import { saveDomainDraft, freezeDomains } from './domains.js';
import { classifyFindings, honorReusedFindingIds, computeFingerprint } from './fingerprint.js';
import { revalidate } from '../commands/revalidate.js';
import { collect } from '../commands/collect.js';

const DOMAINS = [
  { name: 'domain-a', globs: ['packages/a/**'] },
  { name: 'domain-b', globs: ['packages/b/**'] },
];

function priorRow(overrides = {}) {
  return {
    id: 1,
    finding_id: 'F-PRIOR9',
    fingerprint: 'fp-prior9',
    severity: 'MEDIUM',
    category: 'defensive',
    file_path: 'packages/a/x.js',
    line_number: 42,
    description: 'original wave-1 description of the defect',
    status: 'unverified',
    ...overrides,
  };
}

function priorMapOf(...rows) {
  return new Map(rows.map((r) => [r.fingerprint, r]));
}

// A faithful CONFIRM-queue re-report from the OWNING domain: same id, same
// file, everything else fresh — rewritten prose, re-derived line, a different
// category guess. The queue shows the agent only id + description + file, so
// this is the honest best an agent can produce.
function reReport(overrides = {}) {
  return {
    id: 'F-PRIOR9',
    severity: 'MEDIUM',
    category: 'ux',
    file: 'packages/a/x.js',
    line: 424,
    description: 'STILL PRESENT — re-verified live this wave with fresh proof',
    _declaringDomain: 'domain-a',
    ...overrides,
  };
}

describe('honorReusedFindingIds — declared-id reconciliation', () => {
  it('maps an owner re-report onto the prior fingerprint, raw file spelling, and honored stamp', () => {
    const prior = priorRow();
    const finding = { ...reReport(), fingerprint: computeFingerprint(reReport()) };
    const [out] = honorReusedFindingIds([finding], priorMapOf(prior), DOMAINS);

    assert.equal(out.fingerprint, 'fp-prior9', 'the prior fingerprint must be adopted');
    assert.equal(out.file, 'packages/a/x.js', 'the raw file spelling must align to the prior');
    assert.equal(out._idReuseHonored, true, 'the honored stamp drives keeper precedence');
    assert.equal(out.description, finding.description, 'the fresh description must survive');
    assert.notEqual(out, finding, 'the input object must not be mutated');
  });

  it('matches the id case-insensitively (the approve --ids convention)', () => {
    const [out] = honorReusedFindingIds(
      [{ ...reReport({ id: 'f-prior9' }), fingerprint: 'computed' }],
      priorMapOf(priorRow()),
      DOMAINS,
    );
    assert.equal(out.fingerprint, 'fp-prior9');
  });

  it('aligns a case-variant raw file spelling to the prior (no cross-wave salt bait)', () => {
    const [out] = honorReusedFindingIds(
      [{ ...reReport({ file: 'Packages/A/x.js' }), fingerprint: 'computed' }],
      priorMapOf(priorRow()),
      DOMAINS,
    );
    assert.equal(out.fingerprint, 'fp-prior9');
    assert.equal(out.file, 'packages/a/x.js',
      'raw spelling must become the prior\'s, or shouldSaltCrossWaveCollision re-splits the row');
  });

  it('OWNERSHIP GATE: a non-owning domain echoing the id+file from its prompt changes nothing', () => {
    const prior = priorRow();
    const echo = {
      ...reReport({ _declaringDomain: 'domain-b', severity: 'CRITICAL' }),
      fingerprint: 'computed',
    };
    const [out] = honorReusedFindingIds([echo], priorMapOf(prior), DOMAINS);
    assert.equal(out.fingerprint, 'computed',
      'domain-b owns none of packages/a/** — the reuse must be refused');
    assert.equal(out._idReuseHonored, undefined);
  });

  it('OWNERSHIP GATE fails closed: no domain attribution, unknown domain, or no map → refused', () => {
    const prior = priorRow();
    const cases = [
      { ...reReport({ _declaringDomain: undefined }), fingerprint: 'computed' },
      { ...reReport({ _declaringDomain: 'domain-z' }), fingerprint: 'computed' },
    ];
    for (const finding of cases) {
      const [out] = honorReusedFindingIds([finding], priorMapOf(prior), DOMAINS);
      assert.equal(out.fingerprint, 'computed');
    }
    const [noMap] = honorReusedFindingIds(
      [{ ...reReport(), fingerprint: 'computed' }], priorMapOf(prior),
    );
    assert.equal(noMap.fingerprint, 'computed', 'omitted domains param must honor nothing');
  });

  it('APPROVED WINDOW: an approved prior is never honored, even by its owner', () => {
    const prior = priorRow({ status: 'approved' });
    const [out] = honorReusedFindingIds(
      [{ ...reReport(), fingerprint: 'computed' }], priorMapOf(prior), DOMAINS,
    );
    assert.equal(out.fingerprint, 'computed',
      'recurring an approved prior would silently drop it out of amend routing');
    assert.equal(out._idReuseHonored, undefined);
  });

  it('refuses the id when the finding names a DIFFERENT file', () => {
    const finding = { ...reReport({ file: 'packages/a/other.js' }), fingerprint: 'computed' };
    const [out] = honorReusedFindingIds([finding], priorMapOf(priorRow()), DOMAINS);
    assert.equal(out.fingerprint, 'computed', 'a mismatched file must not inherit the prior identity');
  });

  it('leaves unknown ids, id-less findings, and empty prior maps untouched', () => {
    const prior = priorRow();
    const unknown = { ...reReport({ id: 'F-NOSUCH1' }), fingerprint: 'computed' };
    const idless = { severity: 'LOW', category: 'ux', file: 'packages/a/x.js', description: 'd', fingerprint: 'z', _declaringDomain: 'domain-a' };
    assert.equal(honorReusedFindingIds([unknown], priorMapOf(prior), DOMAINS)[0].fingerprint, 'computed');
    assert.equal(honorReusedFindingIds([idless], priorMapOf(prior), DOMAINS)[0].fingerprint, 'z');

    const findings = [unknown];
    assert.equal(honorReusedFindingIds(findings, new Map(), DOMAINS), findings,
      'an empty prior map must return the input array itself');
  });

  it('classifies an honored re-report as RECURRING — and documents that plain classify still cannot', () => {
    const prior = priorRow();
    const map = priorMapOf(prior);
    const finding = { ...reReport(), fingerprint: computeFingerprint(reReport()) };

    // The gap this helper exists for, kept green deliberately: WITHOUT the
    // reconciliation, a rewritten-description re-report has a fresh content
    // fingerprint, classifies as NEW, and duplicates its own still-open prior.
    const unaided = classifyFindings([finding], map);
    assert.equal(unaided.new.length, 1, 'plain content matching lands the re-report in new');
    assert.equal(unaided.recurring.length, 0);

    const classified = classifyFindings(honorReusedFindingIds([finding], map, DOMAINS), map);
    assert.equal(classified.recurring.length, 1, 'the honored re-report must be recurring');
    assert.equal(classified.new.length, 0, 'no duplicate row may be minted');
    assert.equal(classified.recurring[0].prior, prior, 'the prior must ride along for upsert');
    assert.equal(classified.unverified.length, 0,
      'the rediscovered prior must not simultaneously count as unverified');
  });

  it('keeps classifyFindings as the policy owner: fixed reopens (owner-only), deferred stays closed', () => {
    const fixedPrior = priorRow({ finding_id: 'F-FIXED01', fingerprint: 'fp-fixed', status: 'fixed' });
    const deferredPrior = priorRow({ finding_id: 'F-DEFER01', fingerprint: 'fp-defer', status: 'deferred' });
    const map = priorMapOf(fixedPrior, deferredPrior);

    const regression = { ...reReport({ id: 'F-FIXED01' }), fingerprint: 'computed-a' };
    const nagging = { ...reReport({ id: 'F-DEFER01' }), fingerprint: 'computed-b' };
    const classified = classifyFindings(honorReusedFindingIds([regression, nagging], map, DOMAINS), map);

    assert.equal(classified.recurring.length, 1, 'a fixed prior re-reported by its owner is a regression reopen');
    assert.equal(classified.recurring[0].prior, fixedPrior);
    assert.equal(classified.recurred_while_closed.length, 1,
      'a deferred prior re-reported by id stays with the status-preserving branch');
    assert.equal(classified.recurred_while_closed[0].prior, deferredPrior);
  });

  it('KEEPER PRECEDENCE: a coincidental same-fingerprint sibling cannot steal the prior from an honored reuse', () => {
    const prior = priorRow();
    const map = priorMapOf(prior);
    const honored = { ...reReport(), fingerprint: computeFingerprint(reReport()) };
    // An UNRELATED finding that lands on the prior's exact fingerprint by
    // collision (the no-source-fallback residual disambiguateFingerprints'
    // own header documents as live). Alphabetically-early description so the
    // content sort would pick IT as keeper if precedence were broken.
    const sibling = {
      severity: 'HIGH',
      category: 'security',
      file: 'packages/a/x.js',
      line: 7,
      description: 'aaa completely unrelated defect colliding by fingerprint accident',
      fingerprint: 'fp-prior9',
      _declaringDomain: 'domain-a',
    };

    const classified = classifyFindings(honorReusedFindingIds([sibling, honored], map, DOMAINS), map);

    assert.equal(classified.recurring.length, 1, 'exactly one member may merge into the prior');
    assert.equal(classified.recurring[0]._idReuseHonored, true,
      'the DECLARED reuse must be the one that merges — not the content-sort winner');
    assert.equal(classified.new.length, 1, 'the coincidental sibling must become its own row');
    assert.notEqual(classified.new[0].fingerprint, 'fp-prior9',
      'the sibling must be salted off the prior fingerprint, not dropped');
  });

  it('FORGED FLAG: an agent-supplied _idReuseHonored is stripped and cannot hijack the keeper', () => {
    const prior = priorRow();
    const map = priorMapOf(prior);
    const honored = { ...reReport(), fingerprint: computeFingerprint(reReport()) };
    // The findings schema is additionalProperties-open, so an agent CAN ship
    // this flag in its own output JSON. If it survived, chooseBareKeeper
    // would prefer the forger over the genuine declared reuse — re-opening
    // the cross-domain escalation the ownership gate closed.
    const forger = {
      severity: 'CRITICAL',
      category: 'security',
      file: 'packages/a/x.js',
      line: 7,
      description: 'aaa forged-flag hijack attempt',
      fingerprint: 'fp-prior9',
      _declaringDomain: 'domain-a',
      _idReuseHonored: true,
    };

    const classified = classifyFindings(honorReusedFindingIds([forger, honored], map, DOMAINS), map);
    assert.equal(classified.recurring.length, 1);
    assert.equal(classified.recurring[0].description, honored.description,
      'the genuine declared reuse must win the keeper — the forged flag must be inert');
    assert.equal(classified.new.length, 1, 'the forger is salted to its own row');
  });

  it('FORGED FLAG alone (no genuine reuse in the group) changes nothing vs the same input unflagged', () => {
    const prior = priorRow();
    const map = priorMapOf(prior);
    const base = {
      severity: 'CRITICAL',
      category: 'security',
      file: 'packages/a/x.js',
      line: 7,
      description: 'aaa collision without any declared reuse',
      fingerprint: 'fp-prior9',
      _declaringDomain: 'domain-b',
    };
    const bucketShape = (c) => ({
      new: c.new.map((f) => f.fingerprint),
      recurring: c.recurring.map((f) => f.fingerprint),
      unverified: c.unverified.map((f) => f.fingerprint),
    });

    const unflagged = classifyFindings(honorReusedFindingIds([{ ...base }], map, DOMAINS), map);
    const flagged = classifyFindings(
      honorReusedFindingIds([{ ...base, _idReuseHonored: true }], map, DOMAINS), map,
    );
    assert.deepEqual(bucketShape(flagged), bucketShape(unflagged),
      'a forged flag with no genuine reuse must be a byte-level no-op on classification');
  });
});

// ───────────────────────────────────────────────────────
// End-to-end through BOTH callers — collect() and revalidate()
// ───────────────────────────────────────────────────────

function gitIn(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(p) {
  mkdirSync(p, { recursive: true });
  gitIn(p, ['init', '-q', '-b', 'main']);
  gitIn(p, ['config', 'user.email', 't@t.t']);
  gitIn(p, ['config', 'user.name', 't']);
  gitIn(p, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(p, 'README.md'), 'seed\n');
  gitIn(p, ['add', '.']);
  gitIn(p, ['commit', '-q', '-m', 'seed']);
}

function seedTwoDomainRun({ tmp, dbPath, repoPath, runId, priorStatus, waveStatus }) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, 'org/r', ?, ?, 'main', 'health-audit-a')`).run(runId, repoPath, 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  db.prepare(
    "INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id) VALUES (1, ?, 'health-audit-a', 1, 'collected', 'snap')"
  ).run(runId);
  db.prepare(
    "INSERT INTO waves (id, run_id, phase, wave_number, status, domain_snapshot_id) VALUES (2, ?, 'health-audit-a', 2, ?, 'snap')"
  ).run(runId, waveStatus);
  const domA = db.prepare("SELECT id FROM domains WHERE run_id = ? AND name = 'domain-a'").get(runId);
  const domB = db.prepare("SELECT id FROM domains WHERE run_id = ? AND name = 'domain-b'").get(runId);
  const agentStatus = waveStatus === 'failed' ? 'invalid_output' : 'dispatched';
  db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, error_message) VALUES (2, ?, ?, ?)")
    .run(domA.id, agentStatus, waveStatus === 'failed' ? 'schema' : null);
  db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status, error_message) VALUES (2, ?, ?, ?)")
    .run(domB.id, agentStatus, waveStatus === 'failed' ? 'schema' : null);

  db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, status, first_seen_wave, last_seen_wave)
    VALUES (?, 'F-PRIOR9', 'fp-prior9', 'MEDIUM', 'defensive', 'packages/a/x.js', 42,
            'original wave-1 description', ?, 1, 1)`).run(runId, priorStatus);
  closeDb(dbPath);
}

function auditOutput(tmp, domain, findings) {
  const p = join(tmp, `${domain}.json`);
  writeFileSync(p, JSON.stringify({
    domain, stage: 'A', summary: 'confirm queue re-verification', confirmed: [], findings,
  }));
  return p;
}

const ownerReReport = {
  id: 'F-PRIOR9',
  severity: 'MEDIUM',
  category: 'ux',
  file: 'packages/a/x.js',
  line: 424,
  description: 'STILL PRESENT — re-verified live this wave, prose fully rewritten',
  recommendation: 'guard it',
};

describe('collect — id reuse end-to-end (the caller the first test round left unguarded)', () => {
  let tmp, dbPath, repoPath;
  const RUN = 'r-idreuse-collect';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'id-reuse-c-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('an owner re-report through the real collect() recurs the prior with no duplicate row', () => {
    seedTwoDomainRun({ tmp, dbPath, repoPath, runId: RUN, priorStatus: 'unverified', waveStatus: 'dispatched' });
    collect({
      runId: RUN, dbPath,
      outputs: {
        'domain-a': auditOutput(tmp, 'domain-a', [ownerReReport]),
        'domain-b': auditOutput(tmp, 'domain-b', []),
      },
    });

    const db = openDb(dbPath);
    const prior = db.prepare(
      "SELECT status FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR9'").get(RUN);
    const rows = db.prepare(
      "SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND file_path = 'packages/a/x.js'").get(RUN);
    closeDb(dbPath);

    assert.equal(prior.status, 'recurring', 'collect must honor the owner re-report');
    assert.equal(rows.n, 1, 'no duplicate row through the collect path');
  });

  it('CROSS-DOMAIN: a non-owner echoing the queue cannot touch the prior (status, severity, description)', () => {
    seedTwoDomainRun({ tmp, dbPath, repoPath, runId: RUN, priorStatus: 'new', waveStatus: 'dispatched' });
    collect({
      runId: RUN, dbPath,
      outputs: {
        'domain-a': auditOutput(tmp, 'domain-a', []),
        'domain-b': auditOutput(tmp, 'domain-b', [{
          ...ownerReReport,
          severity: 'CRITICAL',
          description: 'escalating this from the shared CONFIRM queue — domain-b agent',
        }]),
      },
    });

    const db = openDb(dbPath);
    const prior = db.prepare(
      "SELECT status, severity, description FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR9'").get(RUN);
    closeDb(dbPath);

    // The refused echo leaves the prior ABSENT from the wave, so the
    // pre-existing full-coverage absence rule applies: undeclared → unverified
    // (open, re-asked). What the gate must prevent is the echo ACTING on the
    // row: no recurrence, no severity escalation, no description overwrite.
    assert.equal(prior.status, 'unverified', 'a non-owner echo must not recur the prior');
    assert.equal(prior.severity, 'MEDIUM', 'a non-owner echo must not escalate severity');
    assert.equal(prior.description, 'original wave-1 description',
      'a non-owner echo must not touch the description');
  });

  it('APPROVED WINDOW through collect: an honest re-confirmation cannot un-approve a queued finding', () => {
    seedTwoDomainRun({ tmp, dbPath, repoPath, runId: RUN, priorStatus: 'approved', waveStatus: 'dispatched' });
    collect({
      runId: RUN, dbPath,
      outputs: {
        'domain-a': auditOutput(tmp, 'domain-a', [ownerReReport]),
        'domain-b': auditOutput(tmp, 'domain-b', []),
      },
    });

    const db = openDb(dbPath);
    const prior = db.prepare(
      "SELECT status, severity FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR9'").get(RUN);
    closeDb(dbPath);

    // The helper's contract: the re-confirmation must not become RECURRING
    // (updateRecurring would rewrite status+severity and drop the row out of
    // findingsForDomain's amend routing). The absent-prior fate is then the
    // pre-existing full-coverage rule — undeclared → unverified — which this
    // helper deliberately does not widen or narrow; byte-identical to the
    // pre-helper outcome for the same input (content fingerprints never
    // matched a rewritten re-report either).
    assert.notEqual(prior.status, 'recurring',
      'approved means queued-for-amend; id reuse must never flip it to recurring');
    assert.equal(prior.status, 'unverified',
      'the absent-prior fate stays the pre-existing absence rule, unchanged by the helper');
    assert.equal(prior.severity, 'MEDIUM', 'no severity rewrite through the skipped path');
  });
});

describe('revalidate — a repaired output re-reporting an open prior by id recurs it, no duplicate', () => {
  let tmp, dbPath, repoPath;
  const RUN = 'r-idreuse-reval';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'id-reuse-r-'));
    dbPath = join(tmp, 'control-plane.db');
    repoPath = join(tmp, 'repo');
    initGitRepo(repoPath);
    seedTwoDomainRun({ tmp, dbPath, repoPath, runId: RUN, priorStatus: 'unverified', waveStatus: 'failed' });
  });
  afterEach(() => { closeDb(dbPath); rmSync(tmp, { recursive: true, force: true }); });

  it('flips the prior to recurring through the repair path and inserts no duplicate row', () => {
    const report = revalidate({
      runId: RUN, dbPath,
      outputs: {
        'domain-a': auditOutput(tmp, 'domain-a', [ownerReReport]),
        'domain-b': auditOutput(tmp, 'domain-b', []),
      },
      reason: 'repair with an id-reusing re-report',
      apply: true,
    });
    assert.equal(report.waveStatusAfter, 'collected', 'the repair itself must succeed');

    const db = openDb(dbPath);
    const prior = db.prepare(
      "SELECT id, status FROM findings WHERE run_id = ? AND finding_id = 'F-PRIOR9'"
    ).get(RUN);
    const rowsForFile = db.prepare(
      "SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND file_path = 'packages/a/x.js'"
    ).get(RUN);
    const recurEvents = db.prepare(
      "SELECT COUNT(*) AS n FROM finding_events WHERE finding_id = ? AND event_type = 'recurred'"
    ).get(prior.id);
    closeDb(dbPath);

    assert.equal(prior.status, 'recurring',
      'the re-reported prior must recur — unverified is unroutable to an amend');
    assert.equal(rowsForFile.n, 1, 'the re-report must NOT mint a duplicate row');
    assert.equal(recurEvents.n, 1, 'the recurrence must leave its audit-trail event');
  });
});
