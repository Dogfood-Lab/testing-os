/**
 * w3-trends-and-json-output.test.js — F4-CP-01 `trends` verb + F4-CP-02
 * `--format=json` on `status` / `runs`.
 *
 * F4-CP-01 (HIGH): the `trends` verb routes to the cross-run analytics query
 * functions via a `--query <recurring|history|recurrence>` flag, with
 * `--format text|json` (reusing parseFormatFlag). It is the first
 * cross-run-scoped verb; every other verb is single-runId scoped.
 *
 * F4-CP-02 (MED): `status` and `runs` already compute rich structured data
 * (status() RETURNS a structured object; cmdRuns iterates runs+counts) but
 * only ever print the text formatter. parseFormatFlag already exists. This
 * wires `--format=json` through both so a machine consumer gets the
 * structured object/array as JSON; default stays text; exit codes unchanged.
 *
 * Every assertion invokes the CLI the way an operator does — `node cli.js
 * <verb>` as a child process with SWARM_DB pointed at a temp DB. NEVER writes
 * the real control-plane.db tree.
 *
 * Pattern #10 (FAILS-then-PASSES proof gate): written + run against the
 * pre-fix cli.js FIRST (trends verb absent → "unknown command" help/exit 1;
 * status/runs --format=json emitting text not JSON → JSON.parse throws), then
 * the cli.js wiring was added to GREEN.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';

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

/**
 * Seed two runs that share a fingerprint (cross-run recurrence) plus an agent
 * row so status's agent table has content. Returns { tmp, dbPath }.
 */
function seedFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'w3-trends-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);

  // runA — older
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
     VALUES ('runA','org/repo-a','/tmp/a',?,'main','health-audit-a','2026-06-01 00:00:00')`
  ).run('a'.repeat(40));
  const dA = db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES ('runA','backend','["src/**"]','owned',1)`
  ).run();
  const wA = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('runA','health-audit-a',1,'collected')`
  ).run();
  const wAid = Number(wA.lastInsertRowid);
  db.prepare(
    `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`
  ).run(wAid, Number(dA.lastInsertRowid));
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
     VALUES ('runA','F-shared','fp-shared','HIGH','bug','shared regression','new',?,?)`
  ).run(wAid, wAid);

  // runB — newer, shares fp-shared
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
     VALUES ('runB','org/repo-b','/tmp/b',?,'main','feature-execute','2026-06-05 00:00:00')`
  ).run('b'.repeat(40));
  const wB = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('runB','health-audit-a',1,'collected')`
  ).run();
  const wBid = Number(wB.lastInsertRowid);
  db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
     VALUES ('runB','F-shared','fp-shared','HIGH','bug','shared regression','recurring',?,?)`
  ).run(wBid, wBid);

  closeDb(dbPath);
  return { tmp, dbPath };
}

// F-8ad2d58d: matches the Windows-tolerant teardown idiom established
// elsewhere in this package (redrive.test.js, rewind.test.js, every
// wave4/6/8/10/12-*-swarm-cp-pins.test.js) — the CLI subprocess spawned
// above can still hold the WAL sidecar lock for a beat after it exits.
function teardown(tmp) {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
}

// ═══════════════════════════════════════════
// F4-CP-01 — `swarm trends` verb
// ═══════════════════════════════════════════

describe('F4-CP-01: swarm trends verb routes to cross-run analytics', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { teardown(fx.tmp); });

  it('is a registered command (no-args prints Usage, exits 1 — not "unknown command" help)', () => {
    const r = runCli(['trends'], fx.dbPath);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js parse error:\n${r.stderr}`);
    assert.equal(r.status, 1, `trends with no --query should exit 1; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /Usage: swarm trends/,
      'trends must print its own Usage error, not fall through to the global help banner');
  });

  it('--query recurring --format json emits the cross-run recurring fingerprint', () => {
    const r = runCli(['trends', '--query', 'recurring', '--format', 'json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `trends --query recurring --format json must emit parseable JSON; got:\n${r.stdout}`);
    assert.ok(Array.isArray(parsed), 'recurring payload is a JSON array');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].fingerprint, 'fp-shared');
    assert.equal(parsed[0].run_count, 2);
  });

  it('--query history --format json emits a per-run array, newest first', () => {
    const r = runCli(['trends', '--query', 'history', '--format', 'json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].run_id, 'runB', 'newest run first');
    assert.equal(parsed[1].run_id, 'runA');
  });

  it('--query recurrence --format json emits the recurrence-rate stats object', () => {
    const r = runCli(['trends', '--query', 'recurrence', '--format', 'json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.total_runs, 2);
    assert.equal(parsed.recurring_fingerprints, 1);
    // This CLI fixture seeds only fp-shared (in both runs) — so the only
    // distinct fingerprint across the population is fp-shared. (The query-
    // module test in w3-cross-run-analytics.test.js seeds 3 distinct
    // fingerprints and pins distinct_fingerprints === 3 there.)
    assert.equal(parsed.distinct_fingerprints, 1);
  });

  it('default --query recurring renders human text (no --format)', () => {
    const r = runCli(['trends', '--query', 'recurring'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    // Text mode names the fingerprint + its cross-run count somewhere.
    assert.match(r.stdout, /fp-shared/);
    assert.match(r.stdout, /2/, 'run_count 2 should be visible in text mode');
    // Must NOT be raw JSON in the default text path.
    assert.doesNotMatch(r.stdout.trim(), /^\[\s*\{/, 'default mode must be text, not JSON');
  });

  it('an unknown --query value fails loud (exit 1), does not silently no-op', () => {
    const r = runCli(['trends', '--query', 'bogus'], fx.dbPath);
    assert.equal(r.status, 1, `unknown --query must exit 1; got ${r.status}`);
    assert.match(r.stderr, /recurring|history|recurrence|--query/,
      'error should name the valid --query values');
  });

  it('an out-of-enum --format is rejected by the shared parseFormatFlag', () => {
    const r = runCli(['trends', '--query', 'recurring', '--format', 'yaml'], fx.dbPath);
    assert.equal(r.status, 1, `bad --format must exit 1; got ${r.status}`);
    assert.match(r.stderr, /CLI_INVALID_FORMAT|text\|markdown\|json|--format/);
  });
});

// ═══════════════════════════════════════════
// F4-CP-02 — `--format=json` on status + runs
// ═══════════════════════════════════════════

describe('F4-CP-02: swarm status --format=json emits the structured object', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { teardown(fx.tmp); });

  it('emits parseable JSON carrying run / waves / agents (not the text frame)', () => {
    const r = runCli(['status', 'runA', '--format', 'json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `status --format json must emit parseable JSON; got:\n${r.stdout}`);

    // Carries the rich structured object status() returns.
    assert.equal(parsed.run.id, 'runA');
    assert.equal(parsed.run.repo, 'org/repo-a');
    assert.ok(parsed.waves, 'waves block present');
    assert.equal(parsed.waves.total, 1);
    assert.equal(parsed.waves.current.phase, 'health-audit-a');
    assert.ok(Array.isArray(parsed.agents), 'agents is an array');
    assert.equal(parsed.agents.length, 1);
    assert.equal(parsed.agents[0].domain, 'backend');
    assert.ok(parsed.findings, 'findings block present');
    assert.ok(parsed.assessment, 'assessment block present');

    // Must NOT contain the ASCII text frame.
    assert.doesNotMatch(r.stdout, /SWARM CONTROL PLANE/,
      'JSON mode must not emit the text status frame');
  });

  it('default status (no --format) still prints the text frame', () => {
    const r = runCli(['status', 'runA'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /SWARM CONTROL PLANE/, 'default status is text');
    assert.throws(() => JSON.parse(r.stdout), 'text mode is not JSON');
  });

  it('an out-of-enum --format on status is rejected (exit 1)', () => {
    const r = runCli(['status', 'runA', '--format', 'csv'], fx.dbPath);
    assert.equal(r.status, 1, `bad --format must exit 1; got ${r.status}`);
    assert.match(r.stderr, /CLI_INVALID_FORMAT|text\|markdown\|json|--format/);
  });
});

describe('F4-CP-02: swarm runs --format=json emits a JSON array', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { teardown(fx.tmp); });

  it('emits a parseable JSON array of run rollups (not the text listing)', () => {
    const r = runCli(['runs', '--format', 'json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `runs --format json must emit a parseable JSON array; got:\n${r.stdout}`);
    assert.ok(Array.isArray(parsed), 'runs JSON payload is an array');
    assert.equal(parsed.length, 2);

    // Each entry carries id/repo/status + wave/finding counts.
    const byId = Object.fromEntries(parsed.map(x => [x.id, x]));
    assert.ok(byId.runA, 'runA present');
    assert.ok(byId.runB, 'runB present');
    assert.equal(byId.runA.repo, 'org/repo-a');
    assert.equal(typeof byId.runA.waveCount, 'number');
    assert.equal(typeof byId.runA.findingCount, 'number');

    assert.doesNotMatch(r.stdout, /Swarm runs:/,
      'JSON mode must not emit the text "Swarm runs:" header');
  });

  it('default runs (no --format) still prints the text listing', () => {
    const r = runCli(['runs'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Swarm runs:/, 'default runs output is text');
  });

  it('runs --format=json on an empty DB emits [] (not the "No runs found." text)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w3-runs-empty-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath); void db; closeDb(dbPath);
    try {
      const r = runCli(['runs', '--format', 'json'], dbPath);
      assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.deepEqual(parsed, []);
    } finally {
      teardown(tmp);
    }
  });
});
