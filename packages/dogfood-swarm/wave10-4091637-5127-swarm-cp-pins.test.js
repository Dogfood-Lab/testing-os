/**
 * wave10-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 10 (health-amend-a) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: identical rationale to wave8-4091637-5127-swarm-cp-pins.test.js's
 * header — swarm-cp-verbs owns cli.js + commands/**, but package-root *.test.js
 * is swarm-cp-tests' bridge glob and the ONLY location `node --test "*.test.js"
 * "lib/*.test.js"` discovers, so a CLI-surface pin has to live here. These two
 * were authored by the coordinator against the merged tree (wave-8 precedent):
 * the verbs amend agent proved both fixes with an ad-hoc subprocess harness but
 * could not commit a root test file from its isolated worktree, leaving the
 * source pins orphaned until this file landed.
 *
 *   F-0a888394 (MEDIUM) — cmdAdvance's PROMOTED branch never echoed
 *     result.gates, so an operator who typed `advance --override --reason '...'`
 *     saw promotion happen but not which named gates their reason consented to
 *     mask (recoverable only via a second `--history` call). The fix renders
 *     the same per-gate PASS/FAIL breakdown the BLOCKED branch already had,
 *     plus an `[OVERRIDDEN]` tag on gates the override path marked.
 *
 *   F-1d972160 (HIGH) — the zero-match refusal hint for approve/defer/reject
 *     used to suggest `swarm status --format=json` for canonical finding ids —
 *     a dead end (status emits aggregate counts only, never an individual
 *     finding_id). The fix points at `swarm findings <run> --format=json`,
 *     whose annotateCanonicalFindingIds resolution actually emits ids.
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

// ── F-0a888394 — the PROMOTED branch echoes the per-gate breakdown ──
// A clean ADVANCE (all gates pass, no override) still carries result.gates;
// pre-fix the promoted branch printed nothing but PROMOTED/Verdict/Next. Seed
// the minimum promotable state: a collected health-audit-a wave with all
// agents complete, a passing verification receipt, and no open findings /
// violations, so checkGates returns ADVANCE and the Gates block must render.
test('F-0a888394: `swarm advance` prints the per-gate breakdown on a promoted advance', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-advance-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-advance';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'a'.repeat(40));
    const dom = db.prepare(
      `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
       VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
    ).run(RUN_ID);
    const wave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status)
       VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const waveId = Number(wave.lastInsertRowid);
    db.prepare(
      `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`
    ).run(waveId, Number(dom.lastInsertRowid));
    db.prepare(
      `INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
       VALUES (?, 'node', 'npm test', 0, 1, 100)`
    ).run(waveId);
    closeDb(dbPath);

    const r = runCli(['advance', RUN_ID], dbPath);
    assert.equal(r.status, 0, `advance should promote a clean wave: ${r.stderr}`);
    assert.match(r.stdout, /PROMOTED:/, 'the promotion still prints');
    // The fix: the promoted branch now echoes the gate breakdown in-place.
    assert.match(r.stdout, /Gates:/, 'F-0a888394: the promoted branch must echo the Gates breakdown, not only the BLOCKED branch');
    assert.match(r.stdout, /\[PASS\] verification/, 'each evaluated gate is shown with its PASS/FAIL state at the moment of promotion');
  } finally {
    teardown(tmp);
  }
});

// ── F-1d972160 — the zero-match hint names a verb that actually emits ids ──
test('F-1d972160: the --ids zero-match hint points at `swarm findings --format=json`, not the `swarm status` dead end', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-nomatch-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-nomatch';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'b'.repeat(40));
    const nmWave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status)
       VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const nmWaveId = Number(nmWave.lastInsertRowid);
    // One real finding so the run HAS findings — the hint fires on zero-MATCH,
    // not zero-findings.
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-realabcd', 'fp-real', 'HIGH', 'bug', 'src/a.js', 'a real finding', 'approved', ?, ?)`
    ).run(RUN_ID, nmWaveId, nmWaveId);
    closeDb(dbPath);

    const r = runCli(['approve', RUN_ID, '--ids', 'F-NOSUCHID'], dbPath);
    assert.notEqual(r.status, 0, 'a zero-match --ids must fail loudly (non-zero), not silently exit 0');
    assert.match(r.stderr, /swarm findings [^\n]*--format=json/, 'F-1d972160: the hint must name `swarm findings --format=json`, the verb that actually emits canonical ids');
    assert.doesNotMatch(r.stderr, /swarm status [^\n]*--format=json/, 'the pre-fix `swarm status --format=json` dead-end suggestion must be gone');
  } finally {
    teardown(tmp);
  }
});
