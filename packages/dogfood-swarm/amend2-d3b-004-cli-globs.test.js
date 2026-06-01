/**
 * amend2-d3b-004-cli-globs.test.js
 *
 * Wave A2 Stage C — D3B-004 invariant.
 *
 * Pre-fix history. `packages/dogfood-swarm/cli.js:141` (the `--edit
 * --globs <JSON>` path) and `cli.js:161` (the `--add --globs <JSON>` path)
 * both invoked `JSON.parse(args[idx + 1])` with no try/catch and no shape
 * check. An operator typo (`--globs '{not json'` or `--globs []`) yielded
 * a raw `SyntaxError: Unexpected token ...` or a downstream throw with
 * no actionable hint.
 *
 * The fix wraps the parse + shape-validate in a helper that throws a
 * typed CliInvalidGlobsError on failure (stable code
 * `CLI_INVALID_GLOBS_JSON`); the CLI's top-level seam catches it and
 * renders the standard `ERROR [<CODE>]: <message>` envelope with a
 * concrete hint.
 *
 * Invariants:
 *   - Invalid JSON (`'{not json'`) → exit non-zero, stderr contains the
 *     code and a hint pointing the operator at the correct shape.
 *   - Valid JSON, wrong shape (`'{}'`, `'[]'`, `'["a", 1]'`) → exit non-
 *     zero, stderr contains the code, hint explains "non-empty array of
 *     strings."
 *   - Counter-test: valid input (`'["packages/foo/**"]'`) parses
 *     successfully — the CLI proceeds past the parse (it may still fail
 *     for other reasons — e.g. run not found — but NOT with
 *     CLI_INVALID_GLOBS_JSON).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft } from './lib/domains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

const RUN_ID = 'test-d3b-004';

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, ...extraEnv },
  });
}

function setupRun(dbPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  saveDomainDraft(db, RUN_ID, [
    { name: 'd1', globs: ['packages/d1/**'], ownership_class: 'owned' },
  ]);
  closeDb(dbPath);
}

describe('D3B-004 — cli.js --globs JSON parse hardening', () => {
  it('--edit --globs <invalid-json> exits non-zero with CLI_INVALID_GLOBS_JSON code', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'd3b-004-edit-bad-'));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      setupRun(dbPath);
      const r = runCli(
        ['domains', RUN_ID, '--edit', 'd1', '--globs', '{not json'],
        { SWARM_DB: dbPath }
      );
      assert.notEqual(r.status, 0,
        `invalid JSON for --globs must exit non-zero; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /CLI_INVALID_GLOBS_JSON/,
        `stderr must name the code CLI_INVALID_GLOBS_JSON; got:\n${r.stderr}`);
      // Bare SyntaxError text (no envelope) was the pre-fix shape; the
      // post-fix path renders the structured envelope so the raw
      // "SyntaxError" word should NOT appear ABOVE the typed envelope.
      assert.match(r.stderr, /Next:/,
        `stderr must include an actionable Next: hint; got:\n${r.stderr}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('--add --globs <invalid-json> exits non-zero with CLI_INVALID_GLOBS_JSON code', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'd3b-004-add-bad-'));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      setupRun(dbPath);
      const r = runCli(
        ['domains', RUN_ID, '--add', 'd2', '--globs', '{bogus'],
        { SWARM_DB: dbPath }
      );
      assert.notEqual(r.status, 0,
        `invalid JSON for --globs must exit non-zero; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /CLI_INVALID_GLOBS_JSON/,
        `stderr must name the code CLI_INVALID_GLOBS_JSON; got:\n${r.stderr}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('--edit --globs {} (valid JSON, wrong shape) exits non-zero with CLI_INVALID_GLOBS_JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'd3b-004-edit-shape-'));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      setupRun(dbPath);
      const r = runCli(
        ['domains', RUN_ID, '--edit', 'd1', '--globs', '{}'],
        { SWARM_DB: dbPath }
      );
      assert.notEqual(r.status, 0,
        `wrong-shape JSON for --globs must exit non-zero; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /CLI_INVALID_GLOBS_JSON/,
        `stderr must name the code; got:\n${r.stderr}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('--add --globs [] (empty array) exits non-zero with CLI_INVALID_GLOBS_JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'd3b-004-add-empty-'));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      setupRun(dbPath);
      const r = runCli(
        ['domains', RUN_ID, '--add', 'd2', '--globs', '[]'],
        { SWARM_DB: dbPath }
      );
      assert.notEqual(r.status, 0,
        `empty array for --globs must exit non-zero; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /CLI_INVALID_GLOBS_JSON/,
        `stderr must name the code; got:\n${r.stderr}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('--add --globs ["a", 1] (mixed-type array) exits non-zero with CLI_INVALID_GLOBS_JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'd3b-004-add-mixed-'));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      setupRun(dbPath);
      const r = runCli(
        ['domains', RUN_ID, '--add', 'd2', '--globs', '["a", 1]'],
        { SWARM_DB: dbPath }
      );
      assert.notEqual(r.status, 0,
        `non-string array element must exit non-zero; got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /CLI_INVALID_GLOBS_JSON/,
        `stderr must name the code; got:\n${r.stderr}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('--add --globs ["packages/foo/**"] (valid input) parses past the globs gate', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'd3b-004-add-ok-'));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      setupRun(dbPath);
      const r = runCli(
        ['domains', RUN_ID, '--add', 'd2-new', '--globs', '["packages/foo/**"]'],
        { SWARM_DB: dbPath }
      );
      // The command may exit 0 (success) — or it may fail for an unrelated
      // reason (e.g. some other validation). The invariant is that
      // CLI_INVALID_GLOBS_JSON does NOT appear in stderr.
      assert.doesNotMatch(r.stderr || '', /CLI_INVALID_GLOBS_JSON/,
        `valid --globs must not trip the JSON-shape guard; got:\n${r.stderr}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
