/**
 * f-f1dae277-ownership-violation-path-escaping.test.js -- F-f1dae277 (HIGH, wave 22):
 * the zero-privilege trust boundary F-4773fb77 (wave 20) established for
 * probe.reason (target-repo package.json/Cargo.toml `name`) applies equally
 * to `file_claims.file_path` / `ownership.violations[].file` -- either a
 * name the reporting agent itself chose, or a path already sitting in the
 * audited repo's own tree. Proven live, unescaped, at eight render sites in
 * this domain before this wave: four DIRECT (a bare path, or a path-only
 * string, rendered as-is) and four INDIRECT (the same joined-path text
 * laundered through `agent_runs.error_message`, which collect.js's
 * `violMsg` writes for an 'ownership_violation' status agent_run, and none
 * of whose four independent readers escaped it).
 *
 * Every assertion here runs against the REAL exported functions (never a
 * reimplementation) -- either directly against a real, temp-DB-backed
 * report object built by the REAL data-producing function (buildReceipt /
 * status / resume), or against a minimal, hand-built report object matching
 * the REAL formatter's documented shape where the data-producing function
 * would need a much heavier fixture for no additional proof value
 * (formatRevalidate's `report.refusals[].reason` is a plain string by the
 * time it reaches the formatter -- its OWN construction site is a
 * completely different concern already covered by revalidate.js's own
 * inline comment).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { buildReceipt, formatReceiptMarkdown } from './commands/receipt.js';
import { formatRevalidate } from './commands/revalidate.js';
import { formatCleanClaims } from './commands/clean-claims.js';
import { status, formatStatus } from './commands/status.js';
import { resume, formatResume } from './commands/resume.js';
import { collect } from './commands/collect.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

// Two payloads matching the finding's own proven vectors -- an RLO/PDF
// bidi-reversal wrap (the classic RTLO extension-spoof: a bidi-aware viewer
// renders the substring between RLO...PDF visually reversed) and a raw
// newline that forges a second, fake line/bullet in whatever structure
// surrounds it. Built via \u{} escapes only -- never a raw glyph in this
// file's own source bytes (mirrors f-35a809f3-trojan-source-control-class.
// test.js's own stated rule for the identical reason).
const RLO = '\u{202E}';
const PDF = '\u{202C}';
const RTLO_PATH = `notes${RLO}fdp.exe${PDF}.txt`;
const NEWLINE_FORGERY_PATH = 'legit-file.js\n- **backend**: FORGED entirely fake bullet (edit)';

function seedMinimalOwnershipViolationRun(dbPath, { maliciousFilePath, agentStatus = 'ownership_violation', waveStatus = 'failed' }) {
  const db = openDb(dbPath);
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run('r1', 'org/evil-repo', dbPath, 'a'.repeat(40), 'main', 'dispatched');
  const domainId = db.prepare("INSERT INTO domains (run_id, name, globs) VALUES (?, ?, ?)")
    .run('r1', 'backend', '["packages/backend/**"]').lastInsertRowid;
  const waveId = db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, ?)")
    .run('r1', waveStatus).lastInsertRowid;
  // The exact shape collect.js's violMsg construction produces: a fixed
  // template joining ownership.violations[].file with zero escaping.
  const violMsg = `Out-of-domain edits: ${maliciousFilePath}`;
  const agentRunId = db.prepare(
    'INSERT INTO agent_runs (wave_id, domain_id, status, error_message) VALUES (?, ?, ?, ?)'
  ).run(waveId, domainId, agentStatus, violMsg).lastInsertRowid;
  db.prepare(
    'INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation) VALUES (?, ?, ?, ?, 1)'
  ).run(agentRunId, maliciousFilePath, 'edit', domainId);
  closeDb(dbPath);
  return { waveId, agentRunId, domainId };
}

/** @pins F-f1dae277 */
describe('F-f1dae277 -- ownership.violations[].file / file_claims.file_path escaped at every render site', () => {
  describe('direct sites (a bare path, or a path-only string, rendered as-is)', () => {
    it('receipt.js formatReceiptMarkdown: Ownership Violations section escapes v.file', () => {
      const r = {
        wave: { number: 1, phase: 'health-amend-a', status: 'failed', domain_snapshot_id: 'x', serial_verify_required: false, ownership_probe_degraded: false },
        run: { id: 'r1', repo: 'org/evil-repo', branch: 'main', commit_sha: 'a'.repeat(40) },
        generated_at: '2026-01-01T00:00:00.000Z',
        agents: [],
        state_transitions: [],
        ownership_violations: [{ domain: 'backend', file: NEWLINE_FORGERY_PATH, claim_type: 'edit' }],
        findings: { total: 0, by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, this_wave: { new: 0, recurring: 0, fixed: 0 }, by_status: {} },
        verification: null,
        recommendation: { action: 'FIX', reason: null },
      };
      const out = formatReceiptMarkdown(r);
      assert.ok(!out.includes(NEWLINE_FORGERY_PATH), `raw newline-forgery path must not survive -- got:\n${out}`);
      assert.ok(
        !out.split('\n').some((l) => l.trim() === '- **backend**: FORGED entirely fake bullet (edit)'),
        `the injected newline must not become its own real, forged Markdown bullet:\n${out}`,
      );
      assert.ok(out.includes('\\n'), `escaped \\n marker must be present (proves the value reached the escaping call):\n${out}`);
    });

    it('revalidate.js formatRevalidate: Refused list escapes the composite reason a path was joined into', () => {
      const report = {
        summary: 'Revalidate (DRY-RUN) -- Wave 1 (health-amend-a):',
        repairs: [],
        refusals: [{
          domain: 'backend',
          agent_run_id: 1,
          reason: `ownership (reported + git-observed): ${RTLO_PATH} -- revert the out-of-domain edits in the working tree; editing files_changed alone cannot clear an ownership_violation`,
        }],
        skipped: [],
      };
      const out = formatRevalidate(report);
      assert.ok(!out.includes(RTLO_PATH), `raw RLO/PDF-wrapped path must not survive -- got:\n${out}`);
      assert.ok(!out.includes(RLO), `raw RLO byte must not survive -- got:\n${JSON.stringify(out)}`);
      assert.ok(out.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${out}`);
    });

    it('clean-claims.js formatCleanClaims: per-claim file listing escapes c.file_path', () => {
      const report = {
        summary: 'Clean-claims (DRY-RUN) for r1:',
        apply: false,
        eligible: [{
          agent_run_id: 1, domain: 'backend', wave_number: 1, wave_status: 'advanced', phase: 'health-amend-a',
          agent_status: 'complete', claim_count: 1, applied: false,
          evidence: { event_count: 0, last_event: null },
          claims: [{ id: 1, file_path: RTLO_PATH, claim_type: 'edit', domain_id: 1 }],
        }],
        refused: [],
      };
      const out = formatCleanClaims(report);
      assert.ok(!out.includes(RTLO_PATH), `raw RLO/PDF-wrapped path must not survive -- got:\n${out}`);
      assert.ok(out.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${out}`);
    });

    it('cli.js `swarm collect` OWNERSHIP VIOLATIONS block: GATE -- the console.log call site routes v.file through escapePathForDisplay', () => {
      const src = stripComments(readFileSync(CLI_PATH, 'utf-8'));
      assert.match(
        src,
        /console\.log\(`  \$\{escapePathForDisplay\(v\.file\)\} — agent "\$\{v\.agent_domain\}" touched file owned by "\$\{v\.actual_owner\}"`\);/,
        'cmdCollect\'s OWNERSHIP VIOLATIONS console.log must call escapePathForDisplay(v.file) -- a source-match gate, mirroring f-bf28b667/f-d6cf96e4\'s own established technique for a bare console.log inside a non-exported cmd* function',
      );
    });

    it('cli.js `swarm collect`: LIVE proof a genuine, glob-detected ownership violation carries the raw malicious path into result.violations[].file -- the exact value the GATE above must escape', () => {
      const root = mkdtempSync(join(tmpdir(), 'f-f1dae277-collect-'));
      const dbPath = join(root, 'control-plane.db');
      try {
        const db = openDb(dbPath);
        db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)')
          .run('rc1', 'org/evil-repo', root, 'a'.repeat(40), 'main', 'pending');
        db.prepare("INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('rc1','backend','[\"packages/backend/**\"]','owned',1)").run();
        db.prepare("INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('rc1','frontend','[\"packages/frontend/**\"]','owned',1)").run();
        const waveId = db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('rc1', 'health-amend-a', 1, 'dispatched')").run().lastInsertRowid;
        const backendDomainId = db.prepare("SELECT id FROM domains WHERE run_id='rc1' AND name='backend'").get().id;
        const agentRunId = db.prepare(
          "INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')"
        ).run(waveId, backendDomainId).lastInsertRowid;
        closeDb(dbPath);

        // backend's agent declares a files_changed entry inside frontend's
        // EXCLUSIVE glob -- a genuine, live-detected cross-domain violation,
        // not a pre-seeded file_claims row.
        const outputPath = join(root, 'backend.json');
        writeFileSync(outputPath, JSON.stringify({
          domain: 'backend', summary: 'ok', fixes: [], files_changed: [`packages/frontend/${RTLO_PATH}`], verification_skipped: true,
        }));

        const result = collect({ runId: 'rc1', dbPath, outputs: { backend: outputPath } });
        assert.equal(result.violations.length, 1, 'expected exactly one live-detected ownership violation');
        assert.equal(result.violations[0].file, `packages/frontend/${RTLO_PATH}`, 'result.violations[].file must carry the RAW, unescaped path -- buildReceipt-shaped data layers stay lossless; escaping happens only at the render (the GATE test above)');
      } finally {
        try { closeDb(dbPath); } catch { /* */ }
        try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
      }
    });
  });

  describe('indirect sites (the same joined-path text, laundered through agent_runs.error_message)', () => {
    let tmpDir, dbPath;
    afterEach(() => {
      try { closeDb(dbPath); } catch { /* */ }
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ } }
    });

    it('receipt.js formatReceiptMarkdown: Agents table error column escapes a.error (agent_runs.error_message)', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'f-f1dae277-receipt-'));
      dbPath = join(tmpDir, 'control-plane.db');
      seedMinimalOwnershipViolationRun(dbPath, { maliciousFilePath: RTLO_PATH });
      const receipt = buildReceipt({ runId: 'r1', dbPath });
      const out = formatReceiptMarkdown(receipt);
      assert.ok(!out.includes(RTLO_PATH), `raw RLO/PDF-wrapped path must not survive in the Agents table error column -- got:\n${out}`);
      assert.ok(out.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${out}`);
    });

    it('status.js formatStatus: Agents list escapes a.error (agent_runs.error_message)', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'f-f1dae277-status-'));
      dbPath = join(tmpDir, 'control-plane.db');
      seedMinimalOwnershipViolationRun(dbPath, { maliciousFilePath: RTLO_PATH });
      const s = status({ runId: 'r1', dbPath });
      const out = formatStatus(s);
      assert.ok(!out.includes(RTLO_PATH), `raw RLO/PDF-wrapped path must not survive in the Agents list -- got:\n${out}`);
      assert.ok(out.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${out}`);
    });

    it('status.js formatStatus: BLOCKER line escapes the composed blocker string (falls back to a.error_message)', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'f-f1dae277-status-blocker-'));
      dbPath = join(tmpDir, 'control-plane.db');
      seedMinimalOwnershipViolationRun(dbPath, { maliciousFilePath: RTLO_PATH });
      const s = status({ runId: 'r1', dbPath });
      const out = formatStatus(s);
      assert.ok(out.includes('BLOCKER:'), `expected a BLOCKER line for the ownership_violation agent -- got:\n${out}`);
      assert.ok(!out.includes(RTLO_PATH), `raw RLO/PDF-wrapped path must not survive in the BLOCKER line -- got:\n${out}`);
      assert.ok(out.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${out}`);
    });

    it('resume.js formatResume: Blocked -- manual fix list escapes a.error (agent_runs.error_message)', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'f-f1dae277-resume-'));
      dbPath = join(tmpDir, 'control-plane.db');
      seedMinimalOwnershipViolationRun(dbPath, { maliciousFilePath: RTLO_PATH, waveStatus: 'dispatched' });
      const r = resume({ runId: 'r1', dbPath, outputDir: tmpDir });
      assert.equal(r.manual_fix.length, 1, 'expected exactly one manual_fix entry for the ownership_violation agent');
      const out = formatResume(r);
      assert.ok(!out.includes(RTLO_PATH), `raw RLO/PDF-wrapped path must not survive in the Blocked list -- got:\n${out}`);
      assert.ok(out.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${out}`);
    });
  });
});
