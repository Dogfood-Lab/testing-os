/**
 * f-4a0354b4-close-contract.test.js
 *
 * F-4a0354b4 [HIGH] — C2 (docs/trajectory-and-closure.dispatch.md) pins
 * `swarm close`'s contract before the verb exists:
 *
 *   - Only OPEN-status rows are eligible (mirrors defer/reject's guard —
 *     cli.js's disposeFindings reuses isOpenFinding's status set; an id that
 *     EXISTS but is already closed is a silent 0-changes no-op, NOT a loud
 *     refusal — verified directly against disposeFindings/refuseIfNoIdsExist
 *     before writing this test, so this mirrors real precedent, not a guess).
 *   - --as accepts only 'fixed' (adjudicated: rejected/deferred stay with
 *     their own verbs); anything else is refused.
 *   - --verified-how accepts only independent|self_attested|operator_evidence
 *     and is NOT decoration — the dispatch says it predicts reopen risk
 *     (Zimmermann et al.), so this file asserts the value is actually
 *     PERSISTED and readable back, not merely accepted and discarded.
 *   - The "unowned files" scenario (the F-6a5eb347 class — a finding whose
 *     file_path matches ZERO domains, e.g. `packages/dogfood-swarm/
 *     package.json`, verified against collect.js's own documented comment
 *     before writing this fixture, not invented) is close's reason to exist:
 *     structurally unclosable by declaration, needs an operator disposal
 *     path.
 *
 * STATUS: RED IN ISOLATION for everything that needs the `swarm close` verb
 * itself (cli.js's `commands` map has no 'close' key as of this write).
 * BRIDGED for the v10 schema columns close needs to persist into
 * (`closure_kind`, `verified_how`) — this file ALTERs them onto the findings
 * table directly in test setup (try/catch-guarded against "duplicate
 * column", per this wave's bridging discipline) so this file's tests do not
 * ALSO block on swarm-cp-core's migration landing first; only the CLI verb
 * itself remains an unbridgeable dependency on swarm-cp-verbs.
 *
 * Every refusal assertion below checks SPECIFIC stderr content, never a bare
 * exit code — "Unknown command: 'close'." (today's real output) always exits
 * 1 regardless of which fixture is used, so a bare exit-code check would
 * pass every enum-refusal case vacuously for the wrong reason.
 */

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

const RUN_ID = 'close-contract-run';

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/**
 * Bridges the v10-additive findings columns C2/C3 need (`closure_kind`,
 * `verified_how`) directly onto the current v9 schema, so this file's tests
 * do not need to wait for swarm-cp-core's actual migration to land. Try/catch
 * against "duplicate column" so this is a no-op once the real migration DOES
 * land (idempotent either way).
 */
function bridgeV10Columns(db) {
  const cols = db.prepare(`PRAGMA table_info(findings)`).all().map(c => c.name);
  if (!cols.includes('closure_kind')) {
    try { db.exec(`ALTER TABLE findings ADD COLUMN closure_kind TEXT`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  if (!cols.includes('verified_how')) {
    try { db.exec(`ALTER TABLE findings ADD COLUMN verified_how TEXT`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}

function seedFinding(db, findingId, status, filePath = 'packages/a/src/foo.js') {
  db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(RUN_ID, findingId, `fp-${findingId.toLowerCase()}`, 'HIGH', 'quality',
    filePath, 1, `${findingId} description`, 'fix it', status, null, null);
  return db.prepare(`SELECT id FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, findingId).id;
}

/**
 * F-837dcb2f pins reopen/close to the redrive.js/revalidate.js/clean.js
 * dry-run idiom: default = preview (no mutation), `--apply` = mutate. This
 * file is testing the CONTRACT (eligibility/enums/persistence/unowned-file),
 * not the dry-run mechanics (that is
 * f-837dcb2f-reopen-close-mutual-compensation.test.js's job), so `--apply` is
 * baked into this helper unconditionally — omitting it would make every
 * "status flips to X" assertion below fail against a CORRECTLY-implemented
 * verb, since a bare invocation would then be a no-op preview by design.
 */
function runClose(dbPath, args) {
  return spawnSync(process.execPath, [CLI_PATH, 'close', RUN_ID, ...args, '--apply'], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

let dbDir, dbPath;
beforeEach(() => {
  dbDir = makeTmpDir('close-db-');
  dbPath = join(dbDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', dbDir, 'a'.repeat(40), 'main', 'health-audit-a');
  bridgeV10Columns(db);
  closeDb(dbPath);
});
afterEach(() => {
  try { closeDb(dbPath); } catch { /* already closed */ }
});

/** @pins F-4a0354b4 */
describe('F-4a0354b4 — swarm close: open-only eligibility', () => {
  it('an OPEN finding (approved) is closeable', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-OPEN', 'approved');
    closeDb(dbPath);

    const r = runClose(dbPath, ['--ids', 'F-CL-OPEN', '--as', 'fixed', '--reason', 'coordinator-resolved, no anchor', '--evidence', 'verified in wave 12 receipt', '--verified-how', 'operator_evidence']);
    assert.equal(r.status, 0, `an open finding must be closeable; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-CL-OPEN');
    closeDb(dbPath);
    assert.equal(row.status, 'fixed', `status must flip to 'fixed'; got '${row.status}'`);
  });

  it('an ALREADY-CLOSED finding (rejected) is a SILENT 0-changes no-op, mirroring disposeFindings\' own idempotent-via-status-guard precedent — not a loud refusal', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-ALREADYCLOSED', 'rejected');
    closeDb(dbPath);

    const r = runClose(dbPath, ['--ids', 'F-CL-ALREADYCLOSED', '--as', 'fixed', '--reason', 'trying to re-close', '--evidence', 'n/a', '--verified-how', 'self_attested']);
    assert.equal(r.status, 0, `closing an already-closed id (that EXISTS) must NOT be a loud error — mirrors ` +
      `disposeFindings' refuseIfNoIdsExist, which only refuses on zero MATCHING ids, not on an already-terminal ` +
      `status; got exit ${r.status}, stderr:\n${r.stderr}`);
    assert.match(r.stdout, /\b0\b/, `stdout must report 0 findings closed; got stdout:\n${r.stdout}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-CL-ALREADYCLOSED');
    closeDb(dbPath);
    assert.equal(row.status, 'rejected', 'an already-closed finding\'s status must not change on a redundant close');
  });
});

describe('F-4a0354b4 — swarm close: --as enum', () => {
  // ADJUDICATED at the wave-39 merge: this test's first draft accepted all
  // three of fixed|rejected|deferred, written against the pass contract's
  // pre-dispute text. The verbs lane's wave-38 narrowing dispute was ACCEPTED
  // at triage (--as fixed only — rejected/deferred already have their own
  // verbs with a different evidence contract; two paths to one status is
  // drift bait), but the document wasn't amended until the merge caught the
  // omission. This test now pins the accepted contract.
  it('--as fixed is accepted; rejected/deferred are refused toward their own verbs', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-AS-FIXED', 'approved');
    seedFinding(db, 'F-CL-AS-REJECTED', 'approved');
    seedFinding(db, 'F-CL-AS-DEFERRED', 'approved');
    closeDb(dbPath);

    const ok = runClose(dbPath, ['--ids', 'F-CL-AS-FIXED', '--as', 'fixed', '--reason', 'valid enum value', '--evidence', 'n/a', '--verified-how', 'self_attested']);
    assert.equal(ok.status, 0, `--as fixed must be accepted; stderr:\n${ok.stderr}`);

    for (const [findingId, as] of [['F-CL-AS-REJECTED', 'rejected'], ['F-CL-AS-DEFERRED', 'deferred']]) {
      const r = runClose(dbPath, ['--ids', findingId, '--as', as, '--reason', 'narrowed enum', '--evidence', 'n/a', '--verified-how', 'self_attested']);
      assert.notEqual(r.status, 0, `--as ${as} must be refused (its transition belongs to swarm ${as === 'rejected' ? 'reject' : 'defer'}); got exit 0`);
      assert.match(r.stderr, /--as/, `refusal must name the flag; got stderr:\n${r.stderr}`);
    }
  });

  it('an invalid --as value is refused', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-AS-INVALID', 'approved');
    closeDb(dbPath);

    const r = runClose(dbPath, ['--ids', 'F-CL-AS-INVALID', '--as', 'wontfix', '--reason', 'invalid enum value', '--evidence', 'n/a', '--verified-how', 'self_attested']);
    assert.notEqual(r.status, 0, `an out-of-enum --as value must be refused; got exit 0`);
    assert.match(r.stderr, /--as/, `refusal must name the offending flag --as; got stderr:\n${r.stderr}`);
    assert.match(r.stderr, /wontfix/, `refusal must echo the bad value so the operator can see what was rejected; got stderr:\n${r.stderr}`);
  });
});

describe('F-4a0354b4 — swarm close: --verified-how enum + persistence', () => {
  it('--verified-how independent|self_attested|operator_evidence are each accepted', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-VH-INDEPENDENT', 'approved');
    seedFinding(db, 'F-CL-VH-SELF', 'approved');
    seedFinding(db, 'F-CL-VH-OPERATOR', 'approved');
    closeDb(dbPath);

    for (const [findingId, how] of [
      ['F-CL-VH-INDEPENDENT', 'independent'],
      ['F-CL-VH-SELF', 'self_attested'],
      ['F-CL-VH-OPERATOR', 'operator_evidence'],
    ]) {
      const r = runClose(dbPath, ['--ids', findingId, '--as', 'fixed', '--reason', 'valid verified-how', '--evidence', 'n/a', '--verified-how', how]);
      assert.equal(r.status, 0, `--verified-how ${how} must be accepted; stderr:\n${r.stderr}`);
    }
  });

  it('an invalid --verified-how value is refused', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-VH-INVALID', 'approved');
    closeDb(dbPath);

    const r = runClose(dbPath, ['--ids', 'F-CL-VH-INVALID', '--as', 'fixed', '--reason', 'invalid verified-how', '--evidence', 'n/a', '--verified-how', 'vibes']);
    assert.notEqual(r.status, 0, `an out-of-enum --verified-how value must be refused; got exit 0`);
    assert.match(r.stderr, /--verified-how/, `refusal must name the offending flag --verified-how; got stderr:\n${r.stderr}`);
    assert.match(r.stderr, /vibes/, `refusal must echo the bad value; got stderr:\n${r.stderr}`);
  });

  it('--verified-how is PERSISTED and readable back from the DB, not merely accepted at the CLI-parsing layer', () => {
    const db = openDb(dbPath);
    seedFinding(db, 'F-CL-VH-ROUNDTRIP', 'approved');
    closeDb(dbPath);

    const r = runClose(dbPath, ['--ids', 'F-CL-VH-ROUNDTRIP', '--as', 'fixed', '--reason', 'round-trip check', '--evidence', 'independently reviewed in PR #900', '--verified-how', 'independent']);
    assert.equal(r.status, 0, `close must succeed; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT verified_how FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-CL-VH-ROUNDTRIP');
    closeDb(dbPath);
    assert.equal(row.verified_how, 'independent',
      `verified_how must be PERSISTED (Zimmermann et al. — this field predicts reopen risk, so it must be ` +
      `reasoned about later, not discarded); got '${row.verified_how}'`);
  });
});

describe('F-4a0354b4 — swarm close: the unowned-file (F-6a5eb347) class', () => {
  it('a finding whose file_path matches ZERO domains (structurally unclosable by declaration) is closeable via the operator path', () => {
    const db = openDb(dbPath);
    // The REAL F-6a5eb347 shape (verified against collect.js's own documented
    // comment before writing this fixture): a nested package.json whose path
    // matches no domain's glob because `shared`'s globs are root-level
    // (`package.json`, `*.json`) and minimatch does not cross a path
    // separator without a globstar. Status 'unverified' is where this class
    // lands per that same comment.
    seedFinding(db, 'F-CL-UNOWNED', 'unverified', 'packages/dogfood-swarm/package.json');
    closeDb(dbPath);

    const r = runClose(dbPath, [
      '--ids', 'F-CL-UNOWNED', '--as', 'fixed',
      '--reason', 'no domain can vouch for this file by declaration; Director directs disposal',
      '--evidence', 'manually verified the fix landed in commit abc123',
      '--verified-how', 'operator_evidence',
    ]);
    assert.equal(r.status, 0,
      `an unowned-file finding (structurally unclosable by declaration) must be closeable via the ` +
      `operator path; stderr:\n${r.stderr}`);

    const db2 = openDb(dbPath);
    const row = db2.prepare(`SELECT status FROM findings WHERE run_id = ? AND finding_id = ?`).get(RUN_ID, 'F-CL-UNOWNED');
    closeDb(dbPath);
    assert.equal(row.status, 'fixed', `status must flip to 'fixed'; got '${row.status}'`);
  });
});
