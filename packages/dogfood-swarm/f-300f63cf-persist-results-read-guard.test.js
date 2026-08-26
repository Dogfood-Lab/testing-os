/**
 * f-300f63cf-persist-results-read-guard.test.js — F-300f63cf (MEDIUM, wave 37):
 * persist-results.js's three readJson/readJsonDir call sites (manifest.json,
 * audit/*.json, remediate/*.json) had no try/catch, so a malformed or
 * truncated file crashed with a raw, uncaught BoundedJsonError stack trace
 * and Node's default exit code 1 — inconsistent with every sibling
 * input-validation failure in this same file, which prints `ERROR: <reason>`
 * and exits 2 (missing manifest.json, missing required field, zero audit
 * results).
 *
 * Subprocess-level (not a direct import): readJson/readJsonDir/dieOnReadError
 * are module-private, and the crash this pins only exists in the CLI body
 * (guarded by `isCLI`), so a real child process is the only way to observe
 * the exit code and stderr shape the fix produces. Mirrors the established
 * spawnSync(process.execPath, [SCRIPT, ...args]) convention already used by
 * stageC-swarm-cli-operator-signal.test.js for the same class of CLI-seam
 * proof.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_RESULTS = join(__dirname, 'persist-results.js');

const VALID_MANIFEST = {
  repo: 'dogfood-lab/testing-os',
  commit_sha: 'abc123',
  branch: 'main',
  swarm_id: 'swarm-test',
  started_at: '2026-01-01T00:00:00Z',
  finished_at: '2026-01-01T00:05:00Z',
};

// A V8 stack frame line: leading whitespace + "at " + a symbol/paren
// location. No structured error this fix emits should ever produce one.
const STACK_FRAME_RE = /^\s+at\s+/m;

function runPersistResults(manifestDir) {
  // INGEST_REPO_ROOT pinned to the scratch dir as a belt-and-suspenders
  // guard (SEED-2's own convention): neither scenario below reaches the
  // ingest subprocess at all (the crash fires before Path A is built), but
  // pinning it means a future reordering that let execution continue past
  // the crash could never write against the real repo tree either.
  return spawnSync(process.execPath, [PERSIST_RESULTS, manifestDir], {
    encoding: 'utf-8',
    env: { ...process.env, INGEST_REPO_ROOT: manifestDir },
  });
}

describe('F-300f63cf — malformed manifest-dir JSON fails through this file\'s own ERROR:/exit-2 convention, not a raw stack', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'persist-results-read-guard-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** @pins F-300f63cf */
  it('GATE: a truncated manifest.json exits 2 with a structured ERROR line, not exit 1 with a raw stack', () => {
    writeFileSync(join(tmpDir, 'manifest.json'), '{not valid json', 'utf-8');

    const result = runPersistResults(tmpDir);

    assert.equal(result.status, 2,
      `pre-fix: an uncaught BoundedJsonError left Node's default exit code (1), not this file's own exit-2 convention — got status ${result.status}`);
    assert.match(result.stderr, /ERROR \[BOUNDED_JSON_PARSE_FAILED\]/,
      `expected a structured ERROR line naming the PARSE_FAILED kind — got stderr: ${result.stderr}`);
    assert.match(result.stderr, /manifest\.json/i);
    assert.doesNotMatch(result.stderr, STACK_FRAME_RE,
      `pre-fix: the raw BoundedJsonError stack trace leaked to stderr — got: ${result.stderr}`);
  });

  /** @pins F-300f63cf */
  it('GATE: a truncated audit/*.json exits 2 with a structured ERROR line naming the offending file, not exit 1 with a raw stack', () => {
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(VALID_MANIFEST), 'utf-8');
    mkdirSync(join(tmpDir, 'audit'));
    writeFileSync(join(tmpDir, 'audit', 'backend.json'), '{"component_id": "backend", "findings": [', 'utf-8');

    const result = runPersistResults(tmpDir);

    assert.equal(result.status, 2,
      `pre-fix: an uncaught BoundedJsonError left Node's default exit code (1), not this file's own exit-2 convention — got status ${result.status}`);
    assert.match(result.stderr, /ERROR \[BOUNDED_JSON_PARSE_FAILED\]/,
      `expected a structured ERROR line naming the PARSE_FAILED kind — got stderr: ${result.stderr}`);
    assert.match(result.stderr, /backend\.json/,
      `expected the offending file name in the error — got stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, STACK_FRAME_RE,
      `pre-fix: the raw BoundedJsonError stack trace leaked to stderr — got: ${result.stderr}`);
  });

  it('non-regression: a well-formed manifest + audit dir still reaches the pre-existing "no audit result files" check, not this fix\'s guard', () => {
    // Sanity: this fix must not change behavior for a manifest-dir shape
    // that was ALREADY handled (an empty audit/ directory is not a read
    // failure — readJsonDir returns [] and the pre-existing check at the
    // call site fires its own, unrelated ERROR message).
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(VALID_MANIFEST), 'utf-8');
    mkdirSync(join(tmpDir, 'audit'));

    const result = runPersistResults(tmpDir);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /ERROR: no audit result files found in audit\//);
    assert.doesNotMatch(result.stderr, /ERROR \[/, 'this is the PRE-EXISTING bare-ERROR path, not this fix\'s structured-kind path');
  });
});
