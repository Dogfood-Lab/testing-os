/**
 * wave41-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 41 (feature-execute) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — no OWNED domain's globs match
 * `packages/dogfood-swarm/*.test.js` (swarm-cp-verbs owns only `commands/**`
 * + `cli.js`), so resolveExclusiveOwner returns null and checkOwnership's
 * bridge fallback grants ANY calling domain a valid claim — the same
 * rationale wave2/4/6/8/10/12/14/18/29/31/35/39's own pin files already
 * established for this identical situation.
 *
 * F-8a15be4c (CRITICAL) — commands/collect.js#scopeConfirmedToOwningDomain
 *   now carries the same filed_by_domain fallback lib/findings-filter.js#
 *   findingsForDomain already has for a file-less finding: a real row whose
 *   file_path column is genuinely NULL is now distinguishable from "no such
 *   id" (which stays dropped), and vouchable by precisely its filing
 *   domain. revalidate.js inherits the fix for free — it imports and calls
 *   this exact function, not a second copy.
 * F-c4d70660 (LOW)     — the stale "duplicated rather than imported"
 *   comment above scopeConfirmedToOwningDomain (contradicted by the same
 *   file's own normalizeFilePathForGlobMatch import one line above it) was
 *   rewritten as part of the F-8a15be4c edit; pinned here with a source scan.
 * F-648f8b51 (HIGH)    — cmdReopen's apply-success "Next: swarm approve
 *   ... --ids ..." hint now routes through report.eligible's DB-canonical
 *   finding_id values instead of echoing the raw --ids argv verbatim.
 * F-68cf9b48 (MEDIUM)  — USAGE.close (cli.js) now tells the truth:
 *   event_type mirrors --as (today always 'fixed'), not the never-written
 *   literal 'operator_closed'.
 * F-7793276e (HIGH)    — commands/resume.js's redispatch call to
 *   findingsForDomain now threads `name: ar.domain_name` alongside `globs`,
 *   so a file-less approved finding filed by/for the resumed domain
 *   survives into the rebuilt amend prompt instead of silently vanishing.
 * F-d875b3c1 (HIGH)    — `swarm roadmap compile --undo <sequence>` is the
 *   new compensator for compile's four-chained-write, no-dry-run posture;
 *   `swarm roadmap show` now fails loud with a named ROADMAP_ARTIFACT_MISSING
 *   error (not a raw ENOENT) when the ledger names a sequence whose file is
 *   absent on disk.
 * F-113eefea/F-520023e7 (MEDIUM) — commands/roadmap.js's CLI-facing artifact
 *   envelope: `notesPath` is repo-relative (not a machine-absolute path
 *   baked into a committed artifact), the timestamp field is named
 *   `compiled_at` (matching the schema's chosen name; the VALUE stays
 *   DB-derived), the redundant nested `sections` object is no longer
 *   persisted/returned, and `content_hash` is surfaced on both compile and
 *   show.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { scopeConfirmedToOwningDomain } from './commands/collect.js';
import { findingsForDomain } from './lib/findings-filter.js';
import { resume } from './commands/resume.js';
import {
  compileRoadmap, showRoadmap, undoRoadmapCompile,
} from './commands/roadmap.js';
import { USAGE } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
function cleanupTmpDirs() {
  for (const d of tmpRoots.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
}

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

// ──────────────────────────────────────────────────────────────
// F-8a15be4c — scopeConfirmedToOwningDomain's file-less fallback
// ──────────────────────────────────────────────────────────────

function seedRun(db, runId, localPath) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', localPath, 'a'.repeat(40));
  const wave = db.prepare(
    "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
  ).run(runId);
  return { runId, waveId: Number(wave.lastInsertRowid) };
}

let seq41 = 0;
function seedFindingRow(db, runId, waveId, { filePath = null, filedByDomain = null, status = 'approved', severity = 'HIGH' } = {}) {
  seq41 += 1;
  const findingId = `F-W41${String(seq41).padStart(5, '0')}`;
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave, filed_by_domain)
    VALUES (?, ?, ?, ?, 'bug', ?, 'a bug', ?, ?, ?, ?)
  `).run(runId, findingId, `fp-${findingId}`, severity, filePath, status, waveId, waveId, filedByDomain);
  return findingId;
}

/** @pins F-8a15be4c */
describe('F-8a15be4c — scopeConfirmedToOwningDomain: file-less finding fallback', () => {
  let tmp, dbPath, db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave41-scope-confirmed-'));
    dbPath = join(tmp, 'control-plane.db');
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  const domains = [
    { name: 'domain-a', globs: ['packages/a/**'] },
    { name: 'domain-b', globs: ['packages/b/**'] },
  ];

  it('RED-FIRST FIXTURE: a file-less approved finding filed by the confirming agent\'s own domain is vouchable', () => {
    const { runId, waveId } = seedRun(db, 'r-scope-1', '/repo');
    const fid = seedFindingRow(db, runId, waveId, { filePath: null, filedByDomain: 'domain-a' });

    const scoped = scopeConfirmedToOwningDomain(db, runId, domains, [
      { domain: 'domain-a', confirmed: [fid] },
    ]);

    assert.deepEqual(scoped, [fid], 'a file-less finding filed by the declaring domain must be vouchable');
  });

  it('a file-less finding filed by a DIFFERENT domain is NOT vouchable by the confirming agent', () => {
    const { runId, waveId } = seedRun(db, 'r-scope-2', '/repo');
    const fid = seedFindingRow(db, runId, waveId, { filePath: null, filedByDomain: 'domain-a' });

    const scoped = scopeConfirmedToOwningDomain(db, runId, domains, [
      { domain: 'domain-b', confirmed: [fid] },
    ]);

    assert.deepEqual(scoped, [], 'domain-b must not be able to vouch for a finding filed by domain-a');
  });

  it('a file-less finding with NO recorded filer (filed_by_domain IS NULL) stays unvouchable — fail-closed, unchanged from pre-fix', () => {
    const { runId, waveId } = seedRun(db, 'r-scope-3', '/repo');
    const fid = seedFindingRow(db, runId, waveId, { filePath: null, filedByDomain: null });

    const scoped = scopeConfirmedToOwningDomain(db, runId, domains, [
      { domain: 'domain-a', confirmed: [fid] },
    ]);

    assert.deepEqual(scoped, [], 'a pre-v10 / filer-less row must stay unvouchable — the honest answer, not a guess');
  });

  it('an id naming no finding in this run is still dropped (the `.has()` fix must not start accepting hallucinated ids)', () => {
    const { runId } = seedRun(db, 'r-scope-4', '/repo');

    const scoped = scopeConfirmedToOwningDomain(db, runId, domains, [
      { domain: 'domain-a', confirmed: ['F-DOES-NOT-EXIST'] },
    ]);

    assert.deepEqual(scoped, [], 'a hallucinated/typo\'d id must never vouch for anything');
  });

  it('a real, non-null file_path still matches via domain globs exactly as before (no regression on the pre-existing path)', () => {
    const { runId, waveId } = seedRun(db, 'r-scope-5', '/repo');
    const inDomain = seedFindingRow(db, runId, waveId, { filePath: 'packages/a/src/foo.js' });
    const outOfDomain = seedFindingRow(db, runId, waveId, { filePath: 'packages/b/src/bar.js' });

    const scoped = scopeConfirmedToOwningDomain(db, runId, domains, [
      { domain: 'domain-a', confirmed: [inDomain, outOfDomain] },
    ]);

    assert.deepEqual(scoped, [inDomain], 'file-path matching must be unaffected by the file-less fallback');
  });

  it('PASS-SCALE SHAPE: 40 file-less approved findings, all filed by the same domain, are ALL vouchable by that domain in one declaration (mirrors this wave\'s own live 40-for-40 evidence)', () => {
    const { runId, waveId } = seedRun(db, 'r-scope-6', '/repo');
    const ids = [];
    for (let i = 0; i < 40; i++) {
      ids.push(seedFindingRow(db, runId, waveId, { filePath: null, filedByDomain: 'domain-a' }));
    }

    const scoped = scopeConfirmedToOwningDomain(db, runId, domains, [
      { domain: 'domain-a', confirmed: ids },
    ]);

    assert.equal(scoped.length, 40);
    assert.deepEqual([...scoped].sort(), [...ids].sort());
  });

  it('CONTRACT PARITY: routing (findingsForDomain) and vouching (scopeConfirmedToOwningDomain) agree on every file-less/file-ful combination — "one rule", proven, not asserted', () => {
    const { runId, waveId } = seedRun(db, 'r-scope-7', '/repo');
    const fixtures = [
      { label: 'file-ful, matches domain-a', filePath: 'packages/a/src/x.js', filedByDomain: null },
      { label: 'file-ful, matches neither domain', filePath: 'packages/c/src/x.js', filedByDomain: null },
      { label: 'file-less, filed by domain-a', filePath: null, filedByDomain: 'domain-a' },
      { label: 'file-less, filed by domain-b', filePath: null, filedByDomain: 'domain-b' },
      { label: 'file-less, no filer', filePath: null, filedByDomain: null },
    ];

    for (const fx of fixtures) {
      const fid = seedFindingRow(db, runId, waveId, { filePath: fx.filePath, filedByDomain: fx.filedByDomain });
      const row = db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(fid);

      for (const domainName of ['domain-a', 'domain-b']) {
        const domain = domains.find(d => d.name === domainName);
        const routedTo = findingsForDomain(db, runId, { name: domainName, globs: domain.globs })
          .some(f => f.finding_id === fid);
        // Only THIS row's status matters for findingsForDomain (status='approved',
        // already the default seedFindingRow uses), so routing and vouching are
        // being compared over the identical single-row universe.
        const vouchedBy = scopeConfirmedToOwningDomain(db, runId, domains, [
          { domain: domainName, confirmed: [fid] },
        ]).includes(fid);

        assert.equal(
          vouchedBy, routedTo,
          `${fx.label}: routing (${routedTo}) and vouching (${vouchedBy}) disagree for ${domainName} — routing and vouching must answer to one rule`
        );
      }
    }
  });
});

/** @pins F-c4d70660 */
describe('F-c4d70660 — the stale duplicated-normalizePath comment is gone', () => {
  it('collect.js no longer claims normalizeFilePathForGlobMatch is a private, unexported duplicate', () => {
    const src = readFileSync(join(__dirname, 'commands', 'collect.js'), 'utf-8');
    assert.ok(
      !/duplicated rather than imported because that helper isn't exported/.test(src),
      'the stale "duplicated rather than imported" justification must not survive — the helper IS exported and imported'
    );
    assert.ok(
      src.includes("import { normalizeFilePathForGlobMatch } from '../lib/normalize-path.js';"),
      'collect.js must still import the shared helper (the thing the stale comment denied)'
    );
  });
});

// ──────────────────────────────────────────────────────────────
// F-648f8b51 — cmdReopen's Next: hint routes through validated finding_ids
// ──────────────────────────────────────────────────────────────

/** @pins F-648f8b51 */
describe('F-648f8b51 — cmdReopen apply-success hint never echoes raw --ids', () => {
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave41-reopen-hint-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r-hint', 'org/r', '/repo', 'a'.repeat(40));
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r-hint', 'health-audit-a', 1, 'collected')"
    ).run();
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
      VALUES ('r-hint', 'F-REALID01', 'fp-real', 'HIGH', 'bug', 'src/a.js', 'a bug', 'fixed', ?, ?)
    `).run(Number(wave.lastInsertRowid), Number(wave.lastInsertRowid));
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* not opened by this test */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('LIVE PROOF: a raw ANSI byte smuggled via a second, non-matching --ids entry never reaches stdout, and the hint names only the real, flipped id', () => {
    // Mirrors the audit's own live proof exactly: a real, closed id plus a
    // second comma-segment that matches no finding and carries a raw ESC
    // byte (the proven cursor-erase/forgery primitive this package's own
    // escaping discipline exists to neutralize).
    const injected = '\x1b[31mFAKE-INJECTED-LINE-must-not-render-raw\x1b[0m';
    const r = runCli([
      'reopen', 'r-hint',
      '--ids', `F-REALID01,${injected}`,
      '--reason', 'wrongly closed', '--evidence', 'repro still fails',
      '--apply',
    ], dbPath);

    assert.equal(r.status, 0, `expected success; stderr:\n${r.stderr}`);
    assert.ok(!r.stdout.includes('\x1b'), 'raw ESC byte must never reach stdout');
    assert.match(r.stdout, /Next: swarm approve r-hint --ids F-REALID01 to route into the next amend wave\./);
    assert.ok(
      !r.stdout.includes('FAKE-INJECTED-LINE'),
      'the unmatched, non-existent id must not be advertised as part of the next command to run'
    );
  });

  it('the raw operator --ids array is no longer the source for the hint — a single real id still renders correctly (precision guard)', () => {
    const r = runCli([
      'reopen', 'r-hint',
      '--ids', 'F-REALID01',
      '--reason', 'wrongly closed', '--evidence', 'repro still fails',
      '--apply',
    ], dbPath);

    assert.equal(r.status, 0, `expected success; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /Next: swarm approve r-hint --ids F-REALID01 to route into the next amend wave\./);
  });
});

// ──────────────────────────────────────────────────────────────
// F-68cf9b48 — USAGE.close tells the truth about event_type
// ──────────────────────────────────────────────────────────────

/** @pins F-68cf9b48 */
describe('F-68cf9b48 — USAGE.close no longer claims event_type=\'operator_closed\'', () => {
  it('USAGE.close says event_type mirrors --as, not the never-written operator_closed literal', () => {
    assert.ok(
      !/event_type='operator_closed'/.test(USAGE.close) && !/event_type=\\'operator_closed\\'/.test(USAGE.close),
      'USAGE.close must not claim swarm close writes event_type=\'operator_closed\' — it never does (CLOSE_AS_VALUES is fixed-only)'
    );
    assert.match(USAGE.close, /event_type mirrors --as/, 'USAGE.close must state the true, current behavior');
  });
});

// ──────────────────────────────────────────────────────────────
// F-7793276e — resume.js redispatch threads `name` into findingsForDomain
// ──────────────────────────────────────────────────────────────

/** @pins F-7793276e */
describe('F-7793276e — resume() redispatch prompt includes a file-less finding filed by the resumed domain', () => {
  let tmp, dbPath, repoDir, outputDir, db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave41-resume-name-'));
    dbPath = join(tmp, 'control-plane.db');
    repoDir = join(tmp, 'repo');
    outputDir = join(tmp, 'out');
    mkdirSync(repoDir, { recursive: true });
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a redispatched failed agent\'s rebuilt amend prompt includes a file-less approved finding filed_by_domain === the resumed domain', () => {
    const runId = 'r-resume-name';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, branch) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 'org/r', repoDir, 'a'.repeat(40), 'main');
    const domainRow = db.prepare(`
      INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, 'swarm-cp-verbs', ?, 'owned', 1)
    `).run(runId, JSON.stringify(['packages/dogfood-swarm/commands/**', 'packages/dogfood-swarm/cli.js']));
    const domainId = Number(domainRow.lastInsertRowid);
    const wave = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'dispatched')
    `).run(runId);
    const waveId = Number(wave.lastInsertRowid);
    // Failed, non-isolated (worktree_path/branch NULL) — redispatchable
    // without any git/worktree recreation.
    db.prepare(`
      INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'failed')
    `).run(waveId, domainId);

    const fid = seedFindingRow(db, runId, waveId, {
      filePath: null, filedByDomain: 'swarm-cp-verbs', status: 'approved',
    });

    const report = resume({ runId, dbPath, outputDir });

    assert.equal(report.action, 'redispatched');
    assert.equal(report.redispatch.length, 1);
    const promptPath = report.redispatch[0].promptPath;
    assert.ok(existsSync(promptPath), `expected a rebuilt prompt at ${promptPath}`);
    const promptText = readFileSync(promptPath, 'utf-8');
    assert.ok(
      promptText.includes(fid),
      `redispatched amend prompt must include the file-less finding ${fid} filed by the resumed domain; got:\n${promptText}`
    );
  });
});

// ──────────────────────────────────────────────────────────────
// F-d875b3c1 — roadmap compile compensator + resilient show
// ──────────────────────────────────────────────────────────────

function seedRoadmapRun(db, runId, repoDir) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', repoDir, 'a'.repeat(40));
}

function writeArtifactFile(repoDir, runId, sequence, body) {
  const dir = join(repoDir, 'dogfood', 'roadmap');
  mkdirSync(dir, { recursive: true });
  const path = `dogfood/roadmap/${runId}.${sequence}.json`;
  writeFileSync(join(repoDir, path), JSON.stringify({ ...body, sequence }, null, 2));
  return path;
}

function insertLedgerRow(db, runId, sequence, path) {
  db.prepare(
    'INSERT INTO roadmap_artifacts (run_id, sequence_number, path, content_hash) VALUES (?, ?, ?, ?)'
  ).run(runId, sequence, path, `fake-hash-${sequence}`);
}

/** @pins F-d875b3c1 */
describe('F-d875b3c1 — swarm roadmap compile --undo (compensator) + resilient show', () => {
  let tmp, dbPath, repoDir, db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave41-roadmap-undo-'));
    dbPath = join(tmp, 'control-plane.db');
    repoDir = join(tmp, 'repo');
    mkdirSync(repoDir, { recursive: true });
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('RED-FIRST, LIVE-SHAPED FIXTURE: a ledger row whose file was reverted after commit makes `swarm roadmap show` throw ROADMAP_ARTIFACT_MISSING, not a raw ENOENT/BoundedJsonError', () => {
    const runId = 'r-orphan';
    seedRoadmapRun(db, runId, repoDir);
    const path1 = writeArtifactFile(repoDir, runId, 1, { runId, repo: 'org/r', compiled_at: '2026-07-17T12:08:20.000Z' });
    insertLedgerRow(db, runId, 1, path1);
    // Sequence 2: ledger row exists, file does NOT (the live orphan shape —
    // a wave-40-class lane compiled, then a `git checkout`/`git clean`
    // reverted the file-tree half without ever touching the DB row).
    insertLedgerRow(db, runId, 2, `dogfood/roadmap/${runId}.2.json`);

    let threw = null;
    try {
      showRoadmap({ runId, dbPath });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'showRoadmap must throw for an orphaned ledger row, not silently succeed');
    assert.equal(threw.code, 'ROADMAP_ARTIFACT_MISSING');
    assert.match(threw.message, /recorded in the ledger but missing on disk/);
    assert.ok(threw.hint && threw.hint.includes('--undo'), 'the error must name the --undo repair');

    // --version=1 still resolves (the underlying read mechanism is sound —
    // this is purely the missing-compensator gap, matching the audit's own
    // live proof that --version=1 worked while the bare `show` did not).
    const v1 = showRoadmap({ runId, dbPath, version: 1 });
    assert.equal(v1.compiled, true);
    assert.equal(v1.sequence, 1);
  });

  it('dry-run --undo reports the orphan accurately and mutates nothing', () => {
    const runId = 'r-undo-dry';
    seedRoadmapRun(db, runId, repoDir);
    const path1 = writeArtifactFile(repoDir, runId, 1, { runId, repo: 'org/r', compiled_at: 't1' });
    insertLedgerRow(db, runId, 1, path1);
    insertLedgerRow(db, runId, 2, `dogfood/roadmap/${runId}.2.json`);

    const report = undoRoadmapCompile({ runId, dbPath, sequence: 2, apply: false });

    assert.equal(report.dryRun, true);
    assert.equal(report.apply, false);
    assert.equal(report.target.sequence, 2);
    assert.equal(report.fileExists, false);
    assert.equal(report.wasLatest, true);
    assert.equal(report.removed, false);

    const stillThere = db.prepare('SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = 2').get(runId);
    assert.ok(stillThere, 'dry-run must not remove the ledger row');
  });

  it('--apply retires exactly the orphaned sequence, repoints latest.json to the prior sequence (whose file exists), and swarm roadmap show recovers', () => {
    const runId = 'r-undo-apply';
    seedRoadmapRun(db, runId, repoDir);
    const path1 = writeArtifactFile(repoDir, runId, 1, { runId, repo: 'org/r', compiled_at: 't1' });
    insertLedgerRow(db, runId, 1, path1);
    insertLedgerRow(db, runId, 2, `dogfood/roadmap/${runId}.2.json`);
    // Stale latest.json still names the orphaned sequence 2 (the exact live
    // shape IF the pointer write had survived; proves repointing, not just
    // deletion).
    mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });
    writeFileSync(
      join(repoDir, 'dogfood', 'roadmap', 'latest.json'),
      JSON.stringify({ run_id: runId, sequence: 2, path: `dogfood/roadmap/${runId}.2.json` }, null, 2)
    );

    const report = undoRoadmapCompile({ runId, dbPath, sequence: 2, apply: true });

    assert.equal(report.removed, true);
    assert.equal(report.newLatest.sequence, 1);
    assert.equal(report.latestJsonRepointed, true);
    assert.equal(report.warning, null);

    const gone = db.prepare('SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = 2').get(runId);
    assert.equal(gone, undefined, 'the orphaned row must be gone after --apply');
    const survivor = db.prepare('SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = 1').get(runId);
    assert.ok(survivor, 'sequence 1 must be untouched');

    const latestJson = JSON.parse(readFileSync(join(repoDir, 'dogfood', 'roadmap', 'latest.json'), 'utf-8'));
    assert.equal(latestJson.sequence, 1, 'latest.json must be repointed to the surviving sequence');
    assert.equal(latestJson.path, path1);

    // swarm roadmap show now recovers cleanly (no explicit --version needed).
    const recovered = showRoadmap({ runId, dbPath });
    assert.equal(recovered.compiled, true);
    assert.equal(recovered.sequence, 1);
  });

  it('undoing a MIDDLE (non-latest) sequence never touches latest.json or any other sequence', () => {
    const runId = 'r-undo-middle';
    seedRoadmapRun(db, runId, repoDir);
    const path1 = writeArtifactFile(repoDir, runId, 1, { runId, repo: 'org/r', compiled_at: 't1' });
    const path2 = writeArtifactFile(repoDir, runId, 2, { runId, repo: 'org/r', compiled_at: 't2' });
    const path3 = writeArtifactFile(repoDir, runId, 3, { runId, repo: 'org/r', compiled_at: 't3' });
    insertLedgerRow(db, runId, 1, path1);
    insertLedgerRow(db, runId, 2, path2);
    insertLedgerRow(db, runId, 3, path3);
    mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });
    const latestJsonPath = join(repoDir, 'dogfood', 'roadmap', 'latest.json');
    writeFileSync(latestJsonPath, JSON.stringify({ run_id: runId, sequence: 3, path: path3 }, null, 2));
    const beforeLatestJson = readFileSync(latestJsonPath, 'utf-8');

    const report = undoRoadmapCompile({ runId, dbPath, sequence: 2, apply: true });

    assert.equal(report.wasLatest, false);
    assert.equal(report.removed, true);
    assert.equal(report.newLatest, null, 'a non-latest undo must not compute/repoint a new latest');

    assert.equal(readFileSync(latestJsonPath, 'utf-8'), beforeLatestJson, 'latest.json must be byte-unchanged');
    const seq1 = db.prepare('SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = 1').get(runId);
    const seq3 = db.prepare('SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = 3').get(runId);
    assert.ok(seq1 && seq3, 'sequences 1 and 3 must be untouched');
    assert.ok(existsSync(join(repoDir, path1)) && existsSync(join(repoDir, path3)), 'sibling files must be untouched');
  });

  it('DOUBLE-ORPHAN: when the would-be new latest\'s own file is ALSO missing, --apply removes the row but warns instead of repointing latest.json', () => {
    const runId = 'r-undo-double-orphan';
    seedRoadmapRun(db, runId, repoDir);
    // Neither sequence's file exists on disk — both ledger-only.
    insertLedgerRow(db, runId, 1, `dogfood/roadmap/${runId}.1.json`);
    insertLedgerRow(db, runId, 2, `dogfood/roadmap/${runId}.2.json`);

    const report = undoRoadmapCompile({ runId, dbPath, sequence: 2, apply: true });

    assert.equal(report.removed, true);
    assert.equal(report.latestJsonRepointed, false);
    assert.ok(report.warning && /ALSO missing/.test(report.warning));
  });

  it('undoing a sequence with no ledger row throws ROADMAP_UNDO_NOT_FOUND and mutates nothing', () => {
    const runId = 'r-undo-missing';
    seedRoadmapRun(db, runId, repoDir);
    insertLedgerRow(db, runId, 1, writeArtifactFile(repoDir, runId, 1, { runId, repo: 'org/r', compiled_at: 't1' }));

    assert.throws(
      () => undoRoadmapCompile({ runId, dbPath, sequence: 7, apply: true }),
      (e) => e.code === 'ROADMAP_UNDO_NOT_FOUND'
    );
    const stillOne = db.prepare('SELECT COUNT(*) AS n FROM roadmap_artifacts WHERE run_id = ?').get(runId);
    assert.equal(stillOne.n, 1);
  });

  it('an invalid --sequence (non-positive-integer) is rejected before any DB read', () => {
    const runId = 'r-undo-invalid-seq';
    seedRoadmapRun(db, runId, repoDir);
    for (const bad of [0, -1, 1.5]) {
      assert.throws(
        () => undoRoadmapCompile({ runId, dbPath, sequence: bad, apply: true }),
        (e) => e.code === 'ROADMAP_UNDO_INVALID_SEQUENCE'
      );
    }
  });
});

// ──────────────────────────────────────────────────────────────
// F-113eefea/F-520023e7 — commands/roadmap.js CLI-facing envelope
// ──────────────────────────────────────────────────────────────

/** @pins F-113eefea, F-520023e7 */
describe('F-113eefea/F-520023e7 — compileRoadmap envelope: repo-relative notesPath, compiled_at naming, no sections duplication, content_hash', () => {
  let tmp, dbPath, repoDir, db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wave41-roadmap-envelope-'));
    dbPath = join(tmp, 'control-plane.db');
    repoDir = join(tmp, 'repo');
    mkdirSync(repoDir, { recursive: true });
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('compileRoadmap: notesPath is repo-relative, the timestamp field is compiled_at (ISO), sections is absent, content_hash is a sha256 hex digest', () => {
    const runId = 'r-envelope';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 'org/r', repoDir, 'a'.repeat(40), 'health-audit-a');
    db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(runId);

    const report = compileRoadmap({ runId, dbPath });

    assert.equal(report.notesPath, 'dogfood/roadmap-notes.json', 'notesPath must be repo-relative, forward-slash, not the machine-absolute default');
    assert.ok(!/^[A-Za-z]:[\\/]/.test(report.notesPath), 'notesPath must not carry a Windows drive letter');
    assert.ok(!report.notesPath.includes('\\'), 'notesPath must be forward-slash normalized');

    assert.equal(typeof report.compiled_at, 'string');
    assert.ok(!Number.isNaN(Date.parse(report.compiled_at)), 'compiled_at must be a parseable ISO timestamp');
    assert.equal(report.compiledAt, undefined, 'the old camelCase compiledAt key must be gone, not just aliased');

    assert.equal(report.sections, undefined, 'the redundant nested sections object must not be persisted/returned');

    assert.match(report.content_hash, /^[0-9a-f]{64}$/, 'content_hash must be a full sha256 hex digest');

    // The on-disk artifact body matches the same envelope shape (this is
    // what actually gets committed to the tree).
    const onDisk = JSON.parse(readFileSync(report.path, 'utf-8'));
    assert.equal(onDisk.notesPath, 'dogfood/roadmap-notes.json');
    assert.equal(typeof onDisk.compiled_at, 'string');
    assert.equal(onDisk.sections, undefined);
    assert.equal(onDisk.compiledAt, undefined);
  });

  it('showRoadmap surfaces the SAME content_hash compileRoadmap reported, looked up from the roadmap_artifacts ledger', () => {
    const runId = 'r-envelope-show';
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 'org/r', repoDir, 'a'.repeat(40), 'health-audit-a');
    db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')"
    ).run(runId);

    const compiled = compileRoadmap({ runId, dbPath });
    const shown = showRoadmap({ runId, dbPath });

    assert.equal(shown.content_hash, compiled.content_hash);
    assert.equal(shown.compiled_at, compiled.compiled_at);
    assert.equal(shown.notesPath, compiled.notesPath);
    assert.equal(shown.sections, undefined);
  });
});
