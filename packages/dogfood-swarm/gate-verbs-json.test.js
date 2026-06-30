/**
 * gate-verbs-json.test.js — --format=json on the gate/inspection verbs:
 *   - advance --check-only --format=json   → checkGates() structured object
 *   - receipt --format=json                → the receipt object
 *   - history --format=json                → history() structured report
 *
 * Mirrors the status/runs parseFormatFlag + buildXJSON identity-projection
 * seam. JSON must be PURE (JSON.parse on the whole stdout succeeds — no human
 * decoration on the JSON path). The text path stays the default.
 *
 * Every assertion invokes the CLI the way an operator does — `node cli.js
 * <verb> --format=json` as a child process with SWARM_DB pointed at a temp DB.
 * NEVER writes the real control-plane.db tree.
 *
 * Pattern #10 (FAILS-then-PASSES): pre-build these verbs ignored --format and
 * printed human text, so JSON.parse(stdout) throws; the wiring makes it GREEN.
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

const RUN_ID = 'test-gate-json';

/**
 * Seed a run + one collected wave with a complete agent + a domain, so:
 *   - checkGates returns a real verdict (gates array populated)
 *   - buildReceipt finds a wave
 *   - history finds the wave (id 1)
 * Returns { tmp, dbPath, waveId }.
 */
function seedFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'gate-json-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);

  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`)
    .run(RUN_ID, tmp, 'a'.repeat(40));

  const d = db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
     VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
  ).run(RUN_ID);

  const w = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(RUN_ID);
  const waveId = Number(w.lastInsertRowid);

  db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`)
    .run(waveId, Number(d.lastInsertRowid));

  closeDb(dbPath);
  return { tmp, dbPath, waveId };
}

describe('advance --check-only --format=json', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { rmSync(fx.tmp, { recursive: true, force: true }); });

  it('emits the checkGates() object as pure JSON', () => {
    const r = runCli(['advance', RUN_ID, '--check-only', '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `advance --check-only --format=json must emit parseable JSON; got:\n${r.stdout}`);
    assert.ok(typeof parsed.verdict === 'string', 'has a verdict');
    assert.ok(Array.isArray(parsed.gates), 'has a gates array (the structured shape)');
    assert.ok(parsed.gates.every(g => 'name' in g && 'passed' in g), 'gates carry name+passed');
  });

  it('text path stays default (no --format)', () => {
    const r = runCli(['advance', RUN_ID, '--check-only'], fx.dbPath);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Verdict:/, 'default check-only is human text');
    assert.throws(() => JSON.parse(r.stdout), 'default text path is not JSON');
  });
});

describe('receipt --format=json', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { rmSync(fx.tmp, { recursive: true, force: true }); });

  it('emits the receipt object as pure JSON', () => {
    const r = runCli(['receipt', RUN_ID, '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `receipt --format=json must emit parseable JSON; got:\n${r.stdout}`);
    assert.equal(parsed.receipt_version, '1.0.0');
    assert.ok(parsed.wave && parsed.wave.number === 1, 'receipt carries the wave object');
    assert.ok(Array.isArray(parsed.agents), 'receipt carries the agents array');
    assert.ok(parsed.recommendation && typeof parsed.recommendation.action === 'string');
  });
});

describe('history --format=json', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { rmSync(fx.tmp, { recursive: true, force: true }); });

  it('emits the history() report as pure JSON', () => {
    const r = runCli(['history', String(fx.waveId), '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `history --format=json must emit parseable JSON; got:\n${r.stdout}`);
    assert.equal(parsed.waveId, fx.waveId);
    assert.ok(parsed.wave && parsed.wave.id === fx.waveId, 'report carries the wave object');
    assert.ok(Array.isArray(parsed.events), 'report carries the events array');
  });

  it('text path stays default (no --format)', () => {
    const r = runCli(['history', String(fx.waveId)], fx.dbPath);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Wave /, 'default history is human text');
  });
});
