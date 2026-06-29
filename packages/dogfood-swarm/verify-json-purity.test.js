/**
 * verify-json-purity.test.js — DSW-D-001 (Stage D output-polish).
 *
 * DSW-D-001 (MEDIUM): each verify-* handler in cli.js printed
 * `result.output` then UNCONDITIONALLY appended a blank line + a
 * `Delta written to: <path>` footer to stdout — including under
 * `--format=json`. That made `swarm verify-fixed <run> --format=json | jq`
 * fail, because the parseable JSON object was followed by a blank line and a
 * human footer line. Every other JSON-capable verb (status / runs / trends)
 * emits pure parseable JSON to stdout.
 *
 * The fix: in the json path, print ONLY `result.output` (the pure JSON
 * string the renderer returns) and skip the footer — mirroring cmdStatus /
 * cmdRuns, which `return` after the JSON. The human footer stays on the
 * text / TTY path.
 *
 * Every assertion invokes the CLI as an operator does — `node cli.js
 * <verb> <run> --format json` as a child process with SWARM_DB pointed at a
 * temp DB. A run with zero `fixed`/`recurring`/etc. findings still produces
 * a well-formed delta and exit code 0, which is all this purity check needs.
 *
 * Pattern #10 (FAILS-then-PASSES proof gate): confirmed RED against the
 * pre-fix cli.js (stdout had the trailing `Delta written to:` line →
 * JSON.parse throws), then GREEN after the wiring change.
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
 * Seed a single run with one wave so the verify-* verbs have a wave number
 * to pin and a real run row to load. No findings are needed — a run with
 * zero matching findings still emits a valid delta and exits 0, which is
 * exactly what a JSON-purity assertion wants.
 */
function seedFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsw-d-001-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);

  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
     VALUES ('runA','org/repo-a',?,?,'main','health-audit-a','2026-06-01 00:00:00')`
  ).run(tmp, 'a'.repeat(40));
  db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('runA','health-audit-a',1,'collected')`
  ).run();

  closeDb(dbPath);
  return { tmp, dbPath };
}

function teardown(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

const VERBS = ['verify-fixed', 'verify-recurring', 'verify-unverified', 'verify-approved'];

describe('DSW-D-001: verify-* --format=json emits pure parseable JSON (no footer)', () => {
  let fx;
  beforeEach(() => { fx = seedFixture(); });
  afterEach(() => { teardown(fx.tmp); });

  for (const verb of VERBS) {
    it(`${verb} --format json stdout is JSON.parse-able (no "Delta written to:" footer)`, () => {
      const r = runCli([verb, 'runA', '--format', 'json'], fx.dbPath);
      assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js parse error:\n${r.stderr}`);

      // The footer leaking onto stdout is the exact defect — assert it is gone.
      assert.doesNotMatch(r.stdout, /Delta written to:/,
        `${verb} --format json must not append the human footer to stdout; got:\n${r.stdout}`);

      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
        `${verb} --format json stdout must be a single parseable JSON value; got:\n${r.stdout}`);
      assert.equal(typeof parsed, 'object');
      assert.ok(parsed !== null, 'parsed JSON is a non-null object');
    });
  }

  it('verify-fixed default (no --format) still prints the human "Delta written to:" footer', () => {
    const r = runCli(['verify-fixed', 'runA'], fx.dbPath);
    assert.match(r.stdout, /Delta written to:/,
      'the text/TTY path must keep the human footer');
  });
});
