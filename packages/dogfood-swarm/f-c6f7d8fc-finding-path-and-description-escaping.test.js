/**
 * f-c6f7d8fc-finding-path-and-description-escaping.test.js -- F-c6f7d8fc
 * (HIGH, wave 24): a NINTH, undisclosed render site for the SAME
 * zero-privilege field family F-f1dae277 (wave 22) established the escaping
 * bar for -- that wave's own re-enumeration counted eight sites for
 * file_claims.file_path / ownership.violations[].file but never expanded to
 * the sibling findings.file_path / findings.description fields, which carry
 * the identical risk shape: agent-self-reported, schema-unconstrained free
 * text (agent-output.schema.json's findings[].file / .description have no
 * format, pattern, or length cap; commands/collect.js's own comment: "A
 * finding.file is attacker-adjacent -- it comes from agent JSON").
 *
 * TWO sites fixed this wave, both in cli.js:
 *
 *   1. cmdDispatch's "APPROVED FINDING(S) ROUTED TO NO AGENT" block
 *      (F-aa32371b) rendered f.file_path with zero escaping, on BOTH the
 *      --dry-run and real-apply paths of `swarm dispatch`, whenever an
 *      approved finding matches no owned domain glob -- an expected,
 *      non-exotic condition per F-aa32371b's own framing (anchorless/
 *      repo-level findings, or a path this run's domains do not own).
 *
 *   2. formatTrends's 'recurring' branch (`swarm trends --query recurring`)
 *      rendered r.description with zero escaping. r.description is
 *      MAX(findings.description) from lib/queries/cross-run-analytics.js's
 *      queryRecurringFindings. This second site was NOT named by the
 *      original finding text -- it surfaced from sweeping commands/**\/*.js
 *      + cli.js for every findings.file_path / findings.description render,
 *      per swarms/PROTOCOL.md's "fix a class, not an instance" discipline.
 *      (commands/dispatch.js's buildPriorMap/priorContext render of the same
 *      fields is a DIFFERENT, already-disclosed wave-22 debt item -- a
 *      document-based surface feeding a future wave's generated prompt file,
 *      not a terminal/receipt render -- and is deliberately not re-filed or
 *      touched here.)
 *
 * cli.js's cmd-prefixed and format-prefixed functions here are not exported
 * (this file's whole shape is a CLI argv dispatcher), so each render site gets BOTH a LIVE
 * proof that the raw payload reaches the DATA layer (dispatch()'s
 * result.unroutedApprovedFindings / queryRecurringFindings()'s row, both
 * REAL exported functions, never a reimplementation) and a source-anchored
 * GATE proving the escaping call sits at the exact render line -- the same
 * two-part technique f-f1dae277-ownership-violation-path-escaping.test.js
 * established for cli.js's cmdCollect. The GATE checks use an indexOf-based
 * anchor + substring search rather than one large regex spanning decorative
 * punctuation, so this file never needs to hand-type a non-ASCII character
 * to prove the wiring.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, openMemoryDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { queryRecurringFindings } from './lib/queries/cross-run-analytics.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = stripComments(readFileSync(join(__dirname, 'cli.js'), 'utf-8'));

const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const RTLO_PATH = `notes${RLO}fdp.exe${PDF}.txt`;
const NEWLINE_FORGERY_DESC = 'legit description\n(5 runs) F-000000 FORGED entirely fake recurring row';

describe('F-c6f7d8fc -- site 1: cmdDispatch\'s unrouted-findings block escapes f.file_path', () => {
  let tmpDir, dbPath;
  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ } }
  });

  /** @pins F-c6f7d8fc */
  it('LIVE: dispatch() carries a malicious, glob-unmatched file_path into result.unroutedApprovedFindings[].file_path RAW -- the exact value the GATE below must escape', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'f-c6f7d8fc-dispatch-'));
    dbPath = join(tmpDir, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES ('r1', 'org/evil-repo', ?, ?, 'main', 'pending')`).run(tmpDir, 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [{ name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' }]);
    freezeDomains(db, 'r1');
    // file_path matches NO owned glob -- this is what makes it "unrouted"
    // per F-aa32371b's own framing (anchorless/repo-level, or out-of-glob).
    db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES ('r1', 'F-EVIL-001', 'fp-evil-1', 'HIGH', 'bug', ?, 'x', 'approved')`).run(RTLO_PATH);
    closeDb(dbPath);

    const result = dispatch({ runId: 'r1', phase: 'health-amend-a', dbPath, outputDir: join(tmpDir, 'out'), dryRun: true });
    assert.equal(result.unroutedApprovedFindings.length, 1, 'expected exactly one unrouted approved finding');
    assert.equal(
      result.unroutedApprovedFindings[0].file_path, RTLO_PATH,
      'result.unroutedApprovedFindings[].file_path must carry the RAW, unescaped path -- data layers stay lossless; escaping happens only at the render (the GATE test below)',
    );
  });

  it('GATE: cmdDispatch\'s console.log for the unrouted-findings block routes f.file_path through escapePathForDisplay', () => {
    const anchorIdx = CLI_SRC.indexOf('APPROVED FINDING(S) ROUTED TO NO AGENT');
    assert.ok(anchorIdx > -1, 'expected to find the unrouted-findings banner text in cli.js');
    const nearby = CLI_SRC.slice(anchorIdx, anchorIdx + 500);
    assert.ok(
      nearby.includes("f.file_path ? escapePathForDisplay(f.file_path) : '(no file_path"),
      `cmdDispatch's unrouted-findings console.log must route f.file_path through escapePathForDisplay inside the ternary guarding an absent path -- mirroring f-f1dae277's own established GATE technique for a bare console.log inside a non-exported cmd* function. Nearby source:\n${nearby}`,
    );
  });
});

describe('F-c6f7d8fc sweep sibling -- site 2: formatTrends\'s recurring branch escapes r.description (findings.description)', () => {
  let db;
  afterEach(() => { if (db) { try { db.close(); } catch { /* */ } } });

  /** @pins F-c6f7d8fc */
  it('LIVE: queryRecurringFindings() carries a malicious, cross-run-recurring description RAW -- the exact value the GATE below must escape', () => {
    db = openMemoryDb();
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status, created_at)
      VALUES ('runA', 'org/repo-a', '/tmp/a', ?, 'health-audit-a', '2026-06-01 00:00:00')`).run('a'.repeat(40));
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status)
      VALUES ('runA','F-shared','fp-evil-shared','HIGH','bug', ?, 'new')`).run(NEWLINE_FORGERY_DESC);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status, created_at)
      VALUES ('runB', 'org/repo-b', '/tmp/b', ?, 'health-audit-a', '2026-06-05 00:00:00')`).run('b'.repeat(40));
    db.prepare(`INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status)
      VALUES ('runB','F-shared','fp-evil-shared','HIGH','bug', ?, 'recurring')`).run(NEWLINE_FORGERY_DESC);

    const rows = queryRecurringFindings(db);
    assert.equal(rows.length, 1, 'expected exactly one recurring fingerprint (seen in runA and runB)');
    assert.equal(
      rows[0].description, NEWLINE_FORGERY_DESC,
      'queryRecurringFindings()\'s description must carry the RAW, unescaped text -- lossless at the data layer; escaping happens only at the render (the GATE test below)',
    );
  });

  it('GATE: formatTrends\'s recurring-branch description line routes r.description through escapeReasonForDisplay', () => {
    const anchorIdx = CLI_SRC.indexOf("lines.push('Recurring findings (seen in more than one run):');");
    assert.ok(anchorIdx > -1, 'expected to find the formatTrends recurring-branch header in cli.js');
    const nearby = CLI_SRC.slice(anchorIdx, anchorIdx + 700);
    assert.ok(
      nearby.includes('escapeReasonForDisplay(r.description)'),
      `formatTrends's recurring-branch description line must call escapeReasonForDisplay(r.description). Nearby source:\n${nearby}`,
    );
  });
});
