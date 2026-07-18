/**
 * f-a7c10cee-findings-status-filter.test.js
 *
 * F-a7c10cee [MEDIUM] — `swarm findings <run-id>` had no verb answering "show
 * me every finding currently in status X for this run" against the LIVE
 * control-plane DB: the default verb is wave-artifact-scoped (reads
 * swarms/<run>/wave-N/<domain>/output.json off disk) and `swarm status
 * --format=json` is aggregate-counts-only (cli.js:2088-2097's own comment).
 *
 * Fix: `--status=<status>[,<status>...]` is an ADDITIVE flag on the EXISTING
 * `swarm findings <run-id>` verb. When present it bypasses wave-artifact
 * resolution entirely and queries `findings` directly for run_id + the given
 * status set, reusing STATUS.finding (db/schema.js) as the enum's single
 * source of truth (case-insensitive-safe: `--status=Fixed,NEW` normalizes to
 * the canonical lowercase values the DB actually stores). Rendered via
 * cli.js's new renderFindingsByStatusText (text) or a lossless identity-
 * projection (--format=json).
 *
 * RED PROOF: every `it()` below that exercises `--status` was run against
 * this wave's pre-fix cli.js (git stash of packages/dogfood-swarm/cli.js
 * alone, this test file left in the working tree, `git stash pop` after) and
 * failed as follows:
 *   - `swarm findings <run> --status=fixed` (no wave-N dir on disk) exited 1
 *     with "Run directory not found: ..." — pre-fix, `--status` was not
 *     recognized as anything special, so args[1] (`--status=fixed`) fell
 *     through to the SAME waveArg-or-flag parse the no-flag path uses, and
 *     the function proceeded straight into wave-artifact resolution.
 *   - `parseFindingStatusFlag`/`queryFindingsByStatus`/
 *     `renderFindingsByStatusText` were not exported from cli.js at all —
 *     importing them threw `SyntaxError: The requested module './cli.js'
 *     does not provide an export named 'parseFindingStatusFlag'`.
 *
 * Byte-identical-without-the-flag proof: a STRUCTURAL check (source-anchored,
 * comment-stripped) that the `--status` bypass's `return` sits textually
 * BEFORE the pre-existing wave-artifact resolution block, so that block is
 * provably unreached whenever `--status` is absent — paired with a LIVE
 * check that the no-flag path still throws the identical
 * FINDINGS_RUN_DIR_NOT_FOUND error it always has, against a run with real DB
 * rows but no wave-N directory on disk (proving the OLD code path, not a
 * reimplementation, still runs unchanged).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { STATUS } from './db/schema.js';
import { parseFindingStatusFlag, queryFindingsByStatus, renderFindingsByStatusText } from './cli.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');
const CLI_SRC = stripComments(readFileSync(CLI_PATH, 'utf-8'));

const RUN_ID = 'status-filter-run';

function seedFinding(db, findingId, status, overrides = {}) {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
      file_path, line_number, symbol, description, recommendation,
      status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    RUN_ID, findingId, `fp-${findingId.toLowerCase()}`,
    overrides.severity ?? 'MEDIUM',
    overrides.category ?? 'quality',
    overrides.file_path ?? `packages/a/src/${findingId}.js`,
    overrides.line_number ?? 1,
    overrides.symbol ?? null,
    overrides.description ?? `${findingId} description`,
    overrides.recommendation ?? null,
    status,
    // first_seen_wave/last_seen_wave are `INTEGER REFERENCES waves(id)` —
    // NULL (no wave row seeded) rather than a guessed id, mirroring
    // f-a3af1ac5-reopen-transition-matrix.test.js's own seedFinding helper.
    // A non-existent wave id here throws SQLITE_CONSTRAINT_FOREIGNKEY.
    overrides.first_seen_wave ?? null,
    overrides.last_seen_wave ?? null,
  );
}

let dbDir, dbPath;
beforeEach(() => {
  // Fresh per-test temp dir, removed by this SAME test's own afterEach below
  // (not a suite-wide after() pool) — dbDir never outlives the test that
  // created it, so there is nothing for a separate tmpRoots array to track.
  dbDir = mkdtempSync(join(tmpdir(), 'status-filter-db-'));
  dbPath = join(dbDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', dbDir, 'a'.repeat(40), 'main', 'health-audit-a');
  closeDb(dbPath);
});
afterEach(() => {
  try { closeDb(dbPath); } catch { /* already closed */ }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
});

function runFindings(args) {
  return spawnSync(process.execPath, [CLI_PATH, 'findings', RUN_ID, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

/** @pins F-a7c10cee */
describe('F-a7c10cee — swarm findings <run-id> --status=<status>[,...] bypasses wave-artifact resolution', () => {
  it('queries the LIVE DB directly with NO wave-N directory on disk at all — the "bypasses entirely" claim', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-STATUS01', 'fixed');
    closeDb(dbPath);

    // No swarms/<run>/wave-N directory was ever created for this run — the
    // pre-existing wave-artifact path would throw FINDINGS_RUN_DIR_NOT_FOUND
    // here (proven by the sibling test below). --status must succeed anyway.
    const r = runFindings(['--status=fixed']);
    assert.equal(r.status, 0, `expected exit 0; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /F-STATUS01/, 'the fixed finding must appear in the --status output');
  });

  it('filters by exactly the given status set — findings NOT in the set are excluded', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-KEEP0001', 'fixed');
    seedFinding(db, 'F-DROP0001', 'new');
    seedFinding(db, 'F-DROP0002', 'rejected');
    closeDb(dbPath);

    const r = runFindings(['--status=fixed']);
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /F-KEEP0001/, 'the fixed finding must be present');
    assert.doesNotMatch(r.stdout, /F-DROP0001/, 'a new finding must be excluded from a fixed-only filter');
    assert.doesNotMatch(r.stdout, /F-DROP0002/, 'a rejected finding must be excluded from a fixed-only filter');
  });

  it('accepts a comma-separated multi-status set', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-MULTI001', 'fixed');
    seedFinding(db, 'F-MULTI002', 'deferred');
    seedFinding(db, 'F-MULTI003', 'new');
    closeDb(dbPath);

    const r = runFindings(['--status=fixed,deferred']);
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /F-MULTI001/);
    assert.match(r.stdout, /F-MULTI002/);
    assert.doesNotMatch(r.stdout, /F-MULTI003/, 'new must be excluded when only fixed,deferred were requested');
  });

  it('validates --status CASE-INSENSITIVELY, per the finding\'s own recommendation', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CASE0001', 'fixed');
    closeDb(dbPath);

    const r = runFindings(['--status=Fixed']);
    assert.equal(r.status, 0, `mixed-case status must be accepted; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /F-CASE0001/);
  });

  it('an unknown status fails LOUD with a typed usage error naming the valid set, exit 1', () => {
    const r = runFindings(['--status=bogus']);
    assert.equal(r.status, 1, `expected exit 1; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /CLI_INVALID_STATUS/, 'must surface the typed error code');
    assert.match(r.stderr, /bogus/, 'must name the offending token');
    for (const s of STATUS.finding) {
      assert.match(r.stderr, new RegExp(s), `error must name valid status '${s}' in the enumerated set`);
    }
  });

  it('a MIXED valid+invalid --status list is rejected wholesale (fail closed, not partial)', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-PARTIAL1', 'fixed');
    closeDb(dbPath);

    const r = runFindings(['--status=fixed,bogus']);
    assert.equal(r.status, 1, `a partially-invalid list must reject entirely; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /CLI_INVALID_STATUS/);
  });

  it('zero matches is informational, not an error: exits 0 with a clear "no findings" message', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-ONLYNEW1', 'new');
    closeDb(dbPath);

    const r = runFindings(['--status=rejected']);
    assert.equal(r.status, 0, `a query that matches nothing is still a successful query; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /No findings with status rejected/);
  });

  it('--format=json emits the rows LOSSLESSLY (raw, unescaped) while text mode escapes the same field', () => {
    const RAW_NEWLINE_DESC = 'legit description\n(9001 runs) F-000000 FORGED entirely fake row';
    const db = openDb(dbPath);
    seedFinding(db, 'F-ESCAPE01', 'fixed', { description: RAW_NEWLINE_DESC });
    closeDb(dbPath);

    const jsonResult = runFindings(['--status=fixed', '--format=json']);
    assert.equal(jsonResult.status, 0, `stderr:\n${jsonResult.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(jsonResult.stdout); },
      `--format=json must emit parseable JSON; got:\n${jsonResult.stdout}`);
    const row = parsed.findings.find((f) => f.finding_id === 'F-ESCAPE01');
    assert.ok(row, 'the seeded finding must be present in the JSON findings array');
    assert.equal(row.description, RAW_NEWLINE_DESC, 'JSON path must carry the description LOSSLESSLY, raw newline included');

    const textResult = runFindings(['--status=fixed']);
    assert.equal(textResult.status, 0, `stderr:\n${textResult.stderr}`);
    assert.match(textResult.stdout, /\\n/, 'text mode must render the escaped \\n marker, not a raw newline');
    // The forged-row substring must never land as its own free-standing line —
    // if it did, a raw newline survived into the terminal output.
    const forgedLine = textResult.stdout.split('\n').find((l) => l.includes('FORGED entirely fake row') && !l.includes('legit description'));
    assert.equal(forgedLine, undefined, 'the injected text must never appear as its own unescaped line');
  });

  it('sorts by severity (CRITICAL..LOW) then finding_id — matches this package\'s established severity ordering', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-SEVLOW01', 'fixed', { severity: 'LOW' });
    seedFinding(db, 'F-SEVCRIT1', 'fixed', { severity: 'CRITICAL' });
    seedFinding(db, 'F-SEVHIGH1', 'fixed', { severity: 'HIGH' });
    closeDb(dbPath);

    const r = runFindings(['--status=fixed', '--format=json']);
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const ids = parsed.findings.map((f) => f.finding_id);
    assert.deepEqual(ids, ['F-SEVCRIT1', 'F-SEVHIGH1', 'F-SEVLOW01'],
      `expected CRITICAL, HIGH, LOW order; got ${JSON.stringify(ids)}`);
  });

  it('--help still documents both invocation forms', () => {
    const r = runFindings(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--status=<status>/);
    assert.match(r.stdout, new RegExp(STATUS.finding.join('\\|')), 'help text must enumerate the live status set');
  });
});

describe('F-a7c10cee — no-flag `swarm findings <run-id>` stays byte-identical to before this feature', () => {
  it('STRUCTURAL: the --status bypass return sits BEFORE the pre-existing wave-artifact resolution block in source', () => {
    // Anchors are real CODE tokens, not comment text — CLI_SRC is
    // comment-stripped (stripComments), so a comment-text anchor would never
    // match and this check would vacuously pass on a missing/moved anchor
    // instead of failing loud. `getOutputDir`-style dirname(getDbPath()) call
    // for swarmsDir is the first line of the pre-existing wave-artifact
    // resolution block; findLatestWave( is that block's own call site
    // (already proven singular by the sibling-sweep test below).
    const bypassAnchor = CLI_SRC.indexOf('const statusFilter = parseFindingStatusFlag(');
    const legacyAnchor = CLI_SRC.indexOf('const swarmsDir = dirname(getDbPath());');
    assert.ok(bypassAnchor > 0, 'the --status bypass call site must exist in cli.js');
    assert.ok(legacyAnchor > 0, 'the pre-existing wave-artifact resolution code must still exist, unmoved');
    assert.ok(bypassAnchor < legacyAnchor,
      'the --status bypass must be checked (and return) BEFORE the wave-artifact resolution code runs, ' +
      'so that code is provably unreached whenever --status is absent');
  });

  it('LIVE: with --status absent, a run with DB rows but NO wave-N directory still throws the ORIGINAL FINDINGS_RUN_DIR_NOT_FOUND error — proves the old code path runs unchanged, not a reimplementation', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-NOFLAG01', 'fixed');
    closeDb(dbPath);

    const r = runFindings([]);
    assert.equal(r.status, 1, `expected exit 1 (no wave artifacts on disk); stdout:\n${r.stdout}`);
    assert.match(r.stderr, /Run directory not found/, 'the pre-existing directory-resolution error must fire unchanged');
  });

  it('LIVE: --status is not confused with a stray positional wave-number argument', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-WAVEPOS1', 'fixed');
    closeDb(dbPath);

    // A [wave-number] positional plus --status: the bypass is total per its
    // own doc comment (any stray wave-number positional is ignored, not
    // reconciled), so this must still succeed via the live-DB path.
    const r = spawnSync(process.execPath, [CLI_PATH, 'findings', RUN_ID, '5', '--status=fixed'], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: dbPath },
    });
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /F-WAVEPOS1/);
  });
});

describe('F-a7c10cee — direct-function coverage (parseFindingStatusFlag / queryFindingsByStatus / renderFindingsByStatusText)', () => {
  it('parseFindingStatusFlag returns undefined when --status is absent (caller stays on the legacy path)', () => {
    assert.equal(parseFindingStatusFlag(['some-run', '3', '--format=json']), undefined);
  });

  it('parseFindingStatusFlag de-duplicates and normalizes to STATUS.finding\'s declared order regardless of input order', () => {
    const result = parseFindingStatusFlag(['--status=DEFERRED,fixed,fixed,New']);
    assert.deepEqual(result, ['new', 'fixed', 'deferred']);
  });

  it('queryFindingsByStatus only returns rows for the given run_id (run isolation)', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-THISRUN1', 'fixed');
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('other-run', 'org/repo2', dbDir, 'b'.repeat(40), 'main', 'health-audit-a');
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES ('other-run', 'F-OTHERRUN', 'fp-other', 'HIGH', 'quality', 'other run finding', 'fixed', NULL, NULL)
    `).run();

    const model = queryFindingsByStatus(db, RUN_ID, ['fixed']);
    closeDb(dbPath);
    assert.equal(model.count, 1, 'must not leak a finding from a different run_id');
    assert.equal(model.findings[0].finding_id, 'F-THISRUN1');
  });

  it('renderFindingsByStatusText renders a "no findings" line for an empty model', () => {
    const text = renderFindingsByStatusText({ runId: 'x', statuses: ['rejected'], count: 0, findings: [] });
    assert.match(text, /No findings with status rejected for x\./);
  });
});

/**
 * SIBLING SWEEP (per swarms/PROTOCOL.md's "fixing a class, not an instance"):
 * is there another verb with the same wave-artifact-vs-live-DB duality
 * `cmdFindings` had, which would want an equivalent `--status=` bypass?
 * `findLatestWave`/`loadDomainOutputs`/`buildDigestModel` (lib/findings-
 * digest.js) — the wave-artifact resolution machinery `--status` bypasses —
 * are imported and called ONLY from cmdFindings anywhere in cli.js (grepped
 * this pass). The four verify-* verbs (verify-fixed/verify-recurring/
 * verify-unverified/verify-approved) are already status-SPECIFIC by
 * construction (one fixed status each), so a --status filter is not a
 * meaningful addition there. `swarm trends` is run-scoped aggregate, not
 * finding-row-scoped. No sibling opportunity found.
 */
describe('F-a7c10cee — sibling sweep: no other verb shares the wave-artifact-vs-live-DB duality', () => {
  it('findLatestWave/loadDomainOutputs/buildDigestModel are called from cmdFindings only', () => {
    const helperNames = ['findLatestWave(', 'loadDomainOutputs(', 'buildDigestModel('];
    for (const name of helperNames) {
      // The `import { findLatestWave, loadDomainOutputs, buildDigestModel }
      // from './lib/findings-digest.js'` line is a named-import LIST — no
      // `(` immediately follows any of these three names there — so this
      // call-shape pattern (`name(`) matches ONLY real call sites, never the
      // import declaration itself. Exactly one call site (inside
      // cmdFindings) is the live, correct count today; a second would mean
      // an undisclosed second consumer this sibling sweep missed.
      const callSites = CLI_SRC.split(name).length - 1;
      assert.equal(callSites, 1,
        `${name} appears ${callSites} times as a call in cli.js — expected exactly the one call site inside ` +
        `cmdFindings; any other count means this sibling sweep's premise (cmdFindings is the sole consumer) is stale`);
    }
  });
});
