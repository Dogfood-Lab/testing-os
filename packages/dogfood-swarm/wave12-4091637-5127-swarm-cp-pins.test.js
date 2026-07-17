/**
 * wave12-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pin
 * for wave 12 (health-amend-a) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: same rationale as the wave8/wave10 sibling pin files —
 * swarm-cp-verbs owns cli.js + commands/**, but package-root *.test.js is
 * swarm-cp-tests' bridge glob and the only location `node --test "*.test.js"
 * "lib/*.test.js"` discovers. Coordinator-authored against the merged tree: the
 * verbs amend agent proved F-51fa8e13 with an ad-hoc harness it deleted (it
 * cannot commit a root test from its isolated worktree), leaving the source pin
 * orphaned until this file landed.
 *
 *   F-51fa8e13 (MEDIUM) — `swarm advance <run> --history` rendered each
 *     promotion's overrides as `overrides.map(o => o.reason).join('; ')`,
 *     dropping the `.gate` field recordPromotion durably persists. So the
 *     retrospective audit view could not say WHICH gate an override consented
 *     to, and two gates masked by one identical --reason printed that reason
 *     twice — indistinguishable from two distinct justifications. The fix
 *     (formatOverrideGroups) groups gate names by identical reason and renders
 *     `gate1, gate2: reason`; `--format=json` (new) emits the getPromotions()
 *     array with `.gate` intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

function teardown(dir) {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock lag */ } }
}

// Seed a run with one wave and one promotion whose overrides mask TWO gates
// under a single identical reason — the exact shape the finding proved renders
// ambiguously pre-fix.
function seedPromotion(overrides) {
  const tmp = mkdtempSync(join(tmpdir(), 'w12-history-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);
  const RUN_ID = 'run-w12-history';
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
     VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
  ).run(RUN_ID, tmp, 'a'.repeat(40));
  const wave = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status)
     VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(RUN_ID);
  const waveId = Number(wave.lastInsertRowid);
  const gatesChecked = overrides.map(o => ({ name: o.gate, passed: false, overridden: true }));
  db.prepare(
    `INSERT INTO promotions (wave_id, run_id, from_phase, to_phase, authorized_by, gates_checked, overrides, finding_snapshot)
     VALUES (?, ?, 'health-audit-a', 'health-amend-a', 'director', ?, ?, NULL)`
  ).run(waveId, RUN_ID, JSON.stringify(gatesChecked), JSON.stringify(overrides));
  closeDb(dbPath);
  return { tmp, dbPath, RUN_ID };
}

test('F-51fa8e13: `advance --history` names WHICH gate each override targeted (not just the reason)', () => {
  const fx = seedPromotion([
    { gate: 'adjudication', reason: 'accepting both flags for this wave' },
    { gate: 'verification', reason: 'accepting both flags for this wave' },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    assert.equal(r.status, 0, `--history should render: ${r.stderr}`);
    // Pre-fix rendered `reason; reason` with the gate names dropped entirely.
    assert.match(r.stdout, /adjudication/, 'F-51fa8e13: the overridden gate name must appear');
    assert.match(r.stdout, /verification/, 'both overridden gate names must appear');
    // Grouped as `adjudication, verification: reason`, not the reason twice.
    assert.match(r.stdout, /adjudication, verification:/,
      'gates sharing one reason are grouped under it, not printed as two identical unlabelled clauses');
    // The pre-fix ambiguity — the reason printed twice — must be gone.
    assert.doesNotMatch(r.stdout, /this wave; accepting both flags for this wave/,
      'the pre-fix duplicate-reason rendering (reason repeated per gate) must not survive');
  } finally {
    teardown(fx.tmp);
  }
});

test('F-51fa8e13: `advance --history --format=json` emits a parseable array with .gate intact', () => {
  const fx = seedPromotion([
    { gate: 'adjudication', reason: 'disposing the advisory jury verdict' },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history', '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `--history --format=json should render: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed), 'the JSON history is an array (parseable by a scraper)');
    assert.equal(parsed.length, 1, 'the one seeded promotion is present');
    assert.equal(parsed[0].overrides[0].gate, 'adjudication',
      'F-51fa8e13: the .gate field the text view used to drop is preserved in JSON');
  } finally {
    teardown(fx.tmp);
  }
});

test('F-51fa8e13 lens: a run with no promotions renders an empty JSON array, not the text sentinel', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w12-history-empty-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES ('run-empty', 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(tmp, 'b'.repeat(40));
    closeDb(dbPath);
    const r = runCli(['advance', 'run-empty', '--history', '--format=json'], dbPath);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), [], 'empty history is a parseable [], matching buildRunsJSON');
  } finally {
    teardown(tmp);
  }
});
