/**
 * f-4773fb77-probe-reason-escaping.test.js — F-4773fb77 (HIGH, wave 20):
 * formatVerify()/formatProbe() (commands/verify.js) rendered result.probe.reason
 * / p.reason UNESCAPED. Unlike every other `reason` render site in this
 * package, probe.reason is a ZERO-PRIVILEGE trust boundary: it embeds the
 * AUDITED TARGET REPO's own manifest content verbatim (node.js's probe()
 * reads package.json's `name` via plain JSON.parse with no character
 * restriction; rust.js's probe() extracts Cargo.toml's `name` via a regex
 * whose `[^"]` class matches raw newlines and ANSI bytes alike) — reachable
 * by simply being the repo `swarm verify` audits, no operator flag involved,
 * and with NO --format=json escape hatch for either verb. Fixed by routing
 * both render sites through escapeReasonForDisplay (commands/lib/escape-reason.js).
 *
 * Driven through the REAL adapter probes (lib/verify/registry.js's probeAll,
 * the same adapters `swarm verify` selects from) against REAL on-disk
 * manifests carrying the two proven payloads — a raw newline (forges a fake
 * adapter-probe row) and the ANSI cursor-erase primitive (\x1b[1A\x1b[2K,
 * already rated HIGH elsewhere in this package) — then through the CLI
 * subprocess exactly the way an operator would invoke it, mirroring the
 * scratch repro this fix was originally proven against
 * (scratchpad repro-f4773fb77.mjs, pre-dating this formal pin).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

function seedRun(dbPath, runId, repoDir) {
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
     VALUES (?, 'org/evil-repo', ?, ?, 'main', 'health-audit-a', '2026-06-01 00:00:00')`
  ).run(runId, repoDir, 'a'.repeat(40));
  db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(runId);
  closeDb(dbPath);
}

/** @pins F-4773fb77 */
describe('F-4773fb77 — probe.reason (target-repo-controlled) is escaped before it reaches the operator terminal', () => {
  it('node adapter: a package.json "name" carrying a raw newline cannot forge a fake row in `swarm verify --probe-only` or the default verify render', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'f4773fb77-node-'));
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(repoDir, { recursive: true });
    // A completely ordinary JSON escape (\n) — no exotic input needed, just
    // an attacker-controlled package.json `name` field, valid JSON.
    const forgedRow = 'failed        collected     2026-01-01 00:00:00  ok';
    const maliciousName = `legit-pkg\n${forgedRow}`;
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: maliciousName, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      'utf-8',
    );

    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runNode', repoDir);

    try {
      const rProbe = runCli(['verify', 'runNode', '--probe-only'], dbPath);
      const rVerify = runCli(['verify', 'runNode'], dbPath);

      assert.doesNotMatch(rProbe.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${rProbe.stderr}`);
      assert.ok(!rProbe.stdout.includes(maliciousName), `raw newline must not survive into --probe-only stdout:\n${rProbe.stdout}`);
      assert.ok(rProbe.stdout.includes('\\n'), `escaped \\n marker must be present (proves the value reached formatProbe):\n${rProbe.stdout}`);
      assert.ok(!rVerify.stdout.includes(maliciousName), `raw newline must not survive into default verify stdout:\n${rVerify.stdout}`);
      assert.ok(
        !rVerify.stdout.split('\n').some((l) => l.trim() === forgedRow),
        `the injected newline must not become its own real output line — that is the forged row this finding describes:\n${rVerify.stdout}`,
      );
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
  });

  it('rust adapter: a Cargo.toml "name" carrying the ANSI cursor-erase primitive (\\x1b[1A\\x1b[2K) never reaches stdout as a raw ESC byte', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'f4773fb77-rust-'));
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    const ESC = String.fromCharCode(0x1b);
    const maliciousName = `evil-crate${ESC}[1A${ESC}[2KTOTALLY LEGITIMATE`;
    // Cargo.toml is consumed via a raw-text regex scan (lib/verify/adapters/rust.js),
    // never a real TOML parser — so the raw ESC bytes land in the file text
    // verbatim, exactly the way an attacker-controlled Cargo.toml would.
    writeFileSync(join(repoDir, 'Cargo.toml'), `[package]\nname = "${maliciousName}"\nversion = "0.0.0"\n`, 'utf-8');
    writeFileSync(join(repoDir, 'src', 'main.rs'), 'fn main() {}\n', 'utf-8');

    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runRust', repoDir);

    try {
      const rProbe = runCli(['verify', 'runRust', '--probe-only'], dbPath);
      const rVerify = runCli(['verify', 'runRust', '--adapter', 'rust'], dbPath);
      const rawAnsiPresent = (s) => s.includes(`${ESC}[1A`) || s.includes(`${ESC}[2K`);

      assert.doesNotMatch(rProbe.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${rProbe.stderr}`);
      assert.ok(!rawAnsiPresent(rProbe.stdout), `raw ESC[1A/ESC[2K bytes must not survive into --probe-only stdout: ${JSON.stringify(rProbe.stdout.slice(0, 400))}`);
      assert.ok(rProbe.stdout.includes('\\x1b'), `escaped \\x1b marker must be present:\n${rProbe.stdout}`);
      assert.ok(!rawAnsiPresent(rVerify.stdout), `raw ESC[1A/ESC[2K bytes must not survive into default verify stdout: ${JSON.stringify(rVerify.stdout.slice(0, 400))}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
  });
});
