/**
 * w4-cli-ergonomics.test.js — Wave-4 (CLI ergonomics) feature pass.
 *
 * F4-CP-05 (MED): `swarm collect --all`. cmdCollect historically required the
 * operator to hand-type one `--domain=name:path` per dispatched agent, with the
 * path mirroring the deterministic dispatch layout
 * (swarms/<run>/wave-N/<domain>/output.json). `--all` resolves that map FROM
 * the control plane: it reads the latest dispatched wave, enumerates the
 * domains that have an agent_run in it (exactly the set collect() iterates —
 * dispatch skips `shared`), and builds the same { domain: path } map collect()
 * consumes. A domain whose output file is MISSING is a NON-FATAL structured
 * warning (mirrors the cli-002/003 unparseable-token warn discipline) — collect
 * proceeds with the present ones. `--all` and explicit `--domain` are mutually
 * exclusive; an explicit `--domain` overrides (the manual path is unchanged).
 *
 * F5-09 (LOW): `swarm doctor` preflight. cmdDoctor runs cheap, read-only
 * environment checks BEFORE a real dispatch wastes an operator's time:
 *   (1) Node >= 22 (the package `engines.node` floor)
 *   (2) the control-plane dir is writable AND hardlink-capable (the file-lock
 *       CAS in @dogfood-lab/findings/lib/file-lock.js uses linkSync; link()
 *       throws ENOTSUP on exFAT/FAT32 — the documented FS trap, see
 *       docs/m5-validation-2026-04-29.md)
 *   (3) the on-disk control-plane DB schema version is not NEWER than this
 *       build (reuses the openDb/ControlPlaneSchemaTooNewError logic — a
 *       too-new DB means "upgrade the tool", and a dispatch against it would
 *       fail-closed; doctor surfaces it as a preflight FAIL)
 * There is deliberately NO DOGFOOD_TOKEN check (it does not exist in the
 * codebase) and NO GITHUB_TOKEN check — the github provenance adapter
 * (packages/verify/validators/provenance.js) takes the token as an explicit
 * argument and reads nothing from the environment, so doctor has no provenance
 * env dependency to probe.
 *
 * Structured pass/warn/fail report; exit non-zero ONLY on a hard FAIL (warns
 * exit 0).
 *
 * Discipline: every subprocess assertion invokes the CLI the way an operator
 * does (`node cli.js <verb>` with SWARM_DB at a TEMP dir) and the output-file
 * resolution roots at the DB-path dirname (the same relationship the defaults
 * carry: DEFAULT_DB_PATH's dirname IS DEFAULT_SWARM_DIR). NEVER writes the real
 * records/indexes/control-plane.db tree.
 *
 * Pattern #10 (FAILS-then-PASSES proof gate): written + run against the pre-fix
 * cli.js FIRST (collect --all → "No outputs provided" exit 1; swarm doctor →
 * "unknown command" help/exit 1), then the wiring was added to GREEN.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { resolveAllDomainOutputs } from './commands/collect.js';
import { runDoctor } from './commands/doctor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

// A minimal VALID feature-execute (amend-class) agent output — domain +
// summary envelope, the only required keys. collect() validates against the
// canonical Ajv schema; this shape passes the gate.
function amendOutput(domain) {
  return JSON.stringify({
    domain,
    summary: `amend output for ${domain}`,
    fixes: [],
    files_changed: [],
  });
}

/**
 * Seed a run with a frozen domain map (backend + tests OWNED, config SHARED)
 * and a dispatched feature-execute wave whose agent_runs are the two OWNED
 * domains (dispatch never creates an agent for a `shared` domain). The swarm
 * dir is the DB-path dirname; this writes wave-N/<domain>/output.json under it.
 *
 * @param {object} opts
 * @param {boolean} opts.writeBackend — write the backend output file
 * @param {boolean} opts.writeTests — write the tests output file
 * @returns {{ tmp, dbPath, swarmDir, waveNumber }}
 */
function seedDispatchedWave({ writeBackend = true, writeTests = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'w4-collect-all-'));
  // The swarm dir IS the DB-path dirname (mirrors DEFAULT_DB_PATH ↔
  // DEFAULT_SWARM_DIR). Put the DB directly in tmp so swarmDir === tmp.
  const swarmDir = tmp;
  const dbPath = join(swarmDir, 'control-plane.db');
  const db = openDb(dbPath);

  const RUN_ID = 'run-collect-all';
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
     VALUES (?, 'org/repo', ?, ?, 'main', 'feature-execute')`
  ).run(RUN_ID, tmp, 'c'.repeat(40));

  const dBackend = db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
     VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
  ).run(RUN_ID);
  const dTests = db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
     VALUES (?, 'tests', '["tests/**"]', 'owned', 1)`
  ).run(RUN_ID);
  // A shared domain — dispatch would NOT create an agent_run for it, so --all
  // must NOT enumerate it.
  db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
     VALUES (?, 'config', '["*.json"]', 'shared', 1)`
  ).run(RUN_ID);

  const waveNumber = 1;
  const wave = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status)
     VALUES (?, 'feature-execute', ?, 'dispatched')`
  ).run(RUN_ID, waveNumber);
  const waveId = Number(wave.lastInsertRowid);

  db.prepare(
    `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')`
  ).run(waveId, Number(dBackend.lastInsertRowid));
  db.prepare(
    `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')`
  ).run(waveId, Number(dTests.lastInsertRowid));

  closeDb(dbPath);

  const waveDir = join(swarmDir, RUN_ID, `wave-${waveNumber}`);
  if (writeBackend) {
    mkdirSync(join(waveDir, 'backend'), { recursive: true });
    writeFileSync(join(waveDir, 'backend', 'output.json'), amendOutput('backend'));
  }
  if (writeTests) {
    mkdirSync(join(waveDir, 'tests'), { recursive: true });
    writeFileSync(join(waveDir, 'tests', 'output.json'), amendOutput('tests'));
  }

  return { tmp, dbPath, swarmDir, waveNumber, RUN_ID };
}

// ════════════════════════════════════════════════════════════════
// F4-CP-05 — collect --all resolution (unit, pure helper)
// ════════════════════════════════════════════════════════════════

describe('F4-CP-05 resolveAllDomainOutputs (pure)', () => {
  let fx;
  afterEach(() => { if (fx) { try { rmSync(fx.tmp, { recursive: true, force: true }); } catch { /* */ } fx = null; } });

  it('enumerates the latest dispatched wave\'s OWNED domains, maps each to wave-N/<domain>/output.json, and reports the missing one', () => {
    fx = seedDispatchedWave({ writeBackend: true, writeTests: false });
    const { outputs, missing, waveNumber } = resolveAllDomainOutputs({
      runId: fx.RUN_ID,
      dbPath: fx.dbPath,
      swarmDir: fx.swarmDir,
    });

    assert.equal(waveNumber, 1, 'resolves the latest dispatched wave number');
    // shared 'config' domain is NOT enumerated (no agent_run for it).
    assert.deepEqual(Object.keys(outputs).sort(), ['backend'],
      'only domains with a present output file land in the map');
    assert.match(outputs.backend, /wave-1[\\/]backend[\\/]output\.json$/,
      'path follows the deterministic wave-N/<domain>/output.json layout');
    assert.deepEqual(missing.map(m => m.domain).sort(), ['tests'],
      'a domain whose output file is absent is reported as missing, not mapped');
    assert.match(missing[0].path, /wave-1[\\/]tests[\\/]output\.json$/,
      'the missing entry carries the path the agent was expected to write');
  });

  it('maps every domain when all output files are present', () => {
    fx = seedDispatchedWave({ writeBackend: true, writeTests: true });
    const { outputs, missing } = resolveAllDomainOutputs({
      runId: fx.RUN_ID,
      dbPath: fx.dbPath,
      swarmDir: fx.swarmDir,
    });
    assert.deepEqual(Object.keys(outputs).sort(), ['backend', 'tests']);
    assert.equal(missing.length, 0, 'no missing warnings when every file exists');
  });
});

// ════════════════════════════════════════════════════════════════
// F4-CP-05 — collect --all end-to-end (subprocess)
// ════════════════════════════════════════════════════════════════

describe('F4-CP-05 swarm collect --all (subprocess)', () => {
  let fx;
  afterEach(() => { if (fx) { try { rmSync(fx.tmp, { recursive: true, force: true }); } catch { /* */ } fx = null; } });

  it('discovers + collects the present domain(s), warns the missing one, and exits 0', () => {
    fx = seedDispatchedWave({ writeBackend: true, writeTests: false });
    const r = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);

    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js parse error:\n${r.stderr}`);
    assert.equal(r.status, 0,
      `collect --all with a partial wave should exit 0 (non-fatal missing); got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    // backend was collected (it appears in the wave summary as accepted).
    assert.match(r.stdout, /backend: complete/, 'present domain collected');
    // The missing tests domain is a non-fatal structured stderr warning naming
    // the domain + the expected path.
    assert.match(r.stderr, /WARNING/, 'missing output emits a WARNING');
    assert.match(r.stderr, /tests/, 'the warning names the missing domain');
  });

  it('collects every domain when all output files are present (exit 0)', () => {
    fx = seedDispatchedWave({ writeBackend: true, writeTests: true });
    const r = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /backend: complete/);
    assert.match(r.stdout, /tests: complete/);
  });

  it('--all and explicit --domain are mutually exclusive: --domain overrides --all', () => {
    // Both files present, but pass an explicit --domain for ONLY backend
    // alongside --all. The explicit path must win — tests must NOT be
    // auto-discovered (the manual path is unchanged when --domain is present).
    fx = seedDispatchedWave({ writeBackend: true, writeTests: true });
    const backendPath = join(fx.swarmDir, fx.RUN_ID, 'wave-1', 'backend', 'output.json');
    const r = runCli(
      ['collect', fx.RUN_ID, '--all', `--domain=backend:${backendPath}`],
      fx.dbPath
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /backend: complete/);
    // tests was NOT supplied (–-domain overrode --all) → its agent is reported
    // failed (Output file not found), which flips the wave to failed.
    assert.match(r.stdout, /tests: failed/,
      'explicit --domain overrides --all: undiscovered domains are not auto-resolved');
  });
});

// ════════════════════════════════════════════════════════════════
// F5-09 — swarm doctor (unit + subprocess)
// ════════════════════════════════════════════════════════════════

describe('F5-09 runDoctor (pure)', () => {
  let tmp;
  afterEach(() => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } tmp = null; } });

  it('a clean temp env passes every check (overallStatus pass, exit 0)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-doctor-ok-'));
    const dbPath = join(tmp, 'control-plane.db');
    openDb(dbPath); // create a current-schema DB
    closeDb(dbPath);

    const report = runDoctor({ dbPath });
    assert.equal(report.overallStatus, 'pass', JSON.stringify(report.checks, null, 2));
    assert.equal(report.exitCode, 0);

    // Structured shape: each check carries id, status, and an actionable hint.
    for (const c of report.checks) {
      assert.ok(c.id, 'check has an id');
      assert.ok(['pass', 'warn', 'fail'].includes(c.status), `check status enum: ${c.status}`);
      assert.equal(typeof c.message, 'string');
    }

    const ids = report.checks.map(c => c.id);
    assert.ok(ids.includes('node-version'), 'node-version check present');
    assert.ok(ids.includes('control-plane-writable'), 'writable+hardlink check present');
    assert.ok(ids.includes('schema-version'), 'schema-version check present');
    // No fictional checks: provenance reads no env, so doctor omits a token check.
    assert.ok(!ids.includes('github-token'), 'no GITHUB_TOKEN check (provenance reads no env)');
    assert.ok(!ids.includes('dogfood-token'), 'no DOGFOOD_TOKEN check (does not exist)');
  });

  it('a too-new control-plane DB schema FAILS the schema-version check (exit non-zero)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-doctor-toonew-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    // Bump the on-disk schema_version PAST what this build understands.
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION + 1));
    closeDb(dbPath);

    const report = runDoctor({ dbPath });
    const schemaCheck = report.checks.find(c => c.id === 'schema-version');
    assert.ok(schemaCheck, 'schema-version check present');
    assert.equal(schemaCheck.status, 'fail', 'too-new schema is a hard FAIL');
    assert.equal(report.overallStatus, 'fail');
    assert.notEqual(report.exitCode, 0, 'a hard FAIL exits non-zero');
  });
});

describe('F5-09 swarm doctor (subprocess)', () => {
  let tmp;
  afterEach(() => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } tmp = null; } });

  it('prints a structured report and exits 0 on a clean env', () => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-doctor-cli-ok-'));
    const dbPath = join(tmp, 'control-plane.db');
    openDb(dbPath);
    closeDb(dbPath);

    const r = runCli(['doctor'], dbPath);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js parse error:\n${r.stderr}`);
    assert.equal(r.status, 0, `clean doctor should exit 0; got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /\[PASS\]/, 'report renders per-check status sigils');
    assert.match(r.stdout, /node/i, 'node version check is named');
  });

  it('exits non-zero on a hard FAIL (too-new schema)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'w4-doctor-cli-fail-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION + 1));
    closeDb(dbPath);

    const r = runCli(['doctor'], dbPath);
    assert.notEqual(r.status, 0, `a hard FAIL must exit non-zero\nstdout: ${r.stdout}`);
    assert.match(r.stdout + r.stderr, /\[FAIL\]/, 'the failing check renders a FAIL sigil');
  });
});
