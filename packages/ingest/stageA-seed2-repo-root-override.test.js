/**
 * stageA-seed2-repo-root-override — SEED-2 (d3-ingest-002) + the CLI half of
 * SEED-1 operator output (d3-ingest-003).
 *
 * SEED-2: the ingest CLI hard-coded `repoRoot = resolve(__dirname, '../..')`
 * with no override, so ANY programmatic `node run.js` invocation wrote into the
 * REAL working tree (records/_rejected/… + a real-tree index rebuild). The fix
 * adds an `INGEST_REPO_ROOT` env override so callers/tests can sandbox the
 * write, retiring the brittle setupTempRunJs run.js-copy workaround.
 *
 * d3-ingest-003 (CLI surface): path-shaped CLI JSON output
 * (`would_persist_to`, `path`) must be forward-slash only across OSes — a
 * backslash there breaks downstream URL-builds / string-matches (dogfood-swarm
 * persist.js pivots on `path`).
 *
 * SAFETY: every subprocess here either runs `--verify-only` (writes NOTHING
 * anywhere) or sets `INGEST_REPO_ROOT` to a fresh per-test temp dir (so the
 * real working tree is never touched). `afterEach` deletes the sandbox. We
 * additionally assert the real records/_rejected tree gained no new entry.
 *
 * Test-first note: the side-effect-free verify-only assertion (Test A) is the
 * RED proof — on the pre-fix CLI `would_persist_to` reflects the hard-coded
 * REAL repo root, not the sandbox, so the `startsWith(sandbox)` assertion goes
 * RED without ever writing to disk. Test B/C exercise the real-write path,
 * which only became sandbox-safe BECAUSE of the override under test.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, mkdirSync, rmSync, readdirSync,
  copyFileSync, mkdtempSync,
} from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(__dirname, '../verify/fixtures');
const RUN_JS = resolve(__dirname, 'run.js');

let pilot0;
const sandboxes = [];

function copyDirSync(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, dstPath);
    else copyFileSync(srcPath, dstPath);
  }
}

/**
 * Make a fresh sandbox repo root in the OS temp dir (NEVER inside the real
 * tree) with the real `policies/` copied in so the verifier can accept the
 * pilot submission. Returns the absolute sandbox path.
 */
function makeSandboxRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ingest-seed2-'));
  copyDirSync(resolve(REPO_ROOT, 'policies'), join(root, 'policies'));
  // Schemas live in the @dogfood-lab/schemas workspace; validate-record loads
  // them from the package, not repoRoot, so no schema copy needed here.
  mkdirSync(join(root, 'records'), { recursive: true });
  mkdirSync(join(root, 'records', '_rejected'), { recursive: true });
  mkdirSync(join(root, 'indexes'), { recursive: true });
  sandboxes.push(root);
  return root;
}

/**
 * Run run.js as a subprocess with stub provenance and CI markers cleared.
 * `INGEST_REPO_ROOT` (when provided) redirects the write into the sandbox.
 */
function runCli(args, payload, env = {}) {
  return spawnSync(process.execPath, [RUN_JS, '--provenance', 'stub', ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '', ...env },
  });
}

function posix(p) {
  return p.split(sep).join('/');
}

/** Recursively count *.json record files under a records/ tree (excludes dirs). */
function countRecords(recordsDir) {
  if (!existsSync(recordsDir)) return 0;
  let n = 0;
  for (const e of readdirSync(recordsDir, { withFileTypes: true })) {
    const p = join(recordsDir, e.name);
    if (e.isDirectory()) n += countRecords(p);
    else if (e.name.endsWith('.json')) n += 1;
  }
  return n;
}

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  while (sandboxes.length) {
    rmSync(sandboxes.pop(), { recursive: true, force: true });
  }
});

describe('SEED-2 INGEST_REPO_ROOT override (d3-ingest-002)', () => {
  it('A (side-effect-free): --verify-only would_persist_to honors INGEST_REPO_ROOT', () => {
    const sandbox = makeSandboxRoot();
    const child = runCli(['--verify-only'], pilot0, { INGEST_REPO_ROOT: sandbox });

    assert.equal(child.status, 0,
      `verify-only of pilot0 must exit 0; stdout=${child.stdout} stderr=${child.stderr}`);
    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.equal(out.verify_only, true);
    assert.equal(typeof out.would_persist_to, 'string',
      'accepted pilot0 must surface a would_persist_to');

    // The override is honored: the computed path is anchored at the SANDBOX,
    // not the hard-coded real repo root. On the pre-fix CLI this is REPO_ROOT
    // and the assertion goes RED — with NO disk write (verify-only).
    assert.ok(
      out.would_persist_to.startsWith(posix(sandbox)),
      `would_persist_to must be anchored at the sandbox (${posix(sandbox)}), got: ${out.would_persist_to}`,
    );
    assert.ok(
      !out.would_persist_to.startsWith(posix(REPO_ROOT)),
      `would_persist_to must NOT leak the real repo root, got: ${out.would_persist_to}`,
    );
  });

  it('B: a real ingest writes the record under INGEST_REPO_ROOT, NOT the real tree', () => {
    const sandbox = makeSandboxRoot();
    const realRecordsBefore = countRecords(resolve(REPO_ROOT, 'records'));

    const child = runCli([], pilot0, { INGEST_REPO_ROOT: sandbox });
    assert.equal(child.status, 0,
      `real ingest must exit 0; stdout=${child.stdout} stderr=${child.stderr}`);

    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.equal(out.written, true, 'pilot0 must be written');

    // The record landed in the sandbox.
    assert.ok(
      out.path.startsWith(posix(sandbox)),
      `persisted path must be under the sandbox, got: ${out.path}`,
    );
    const sandboxRecords = countRecords(join(sandbox, 'records'));
    assert.equal(sandboxRecords, 1, 'exactly one record must exist in the sandbox');
    // Indexes were rebuilt in the sandbox, not the real tree.
    assert.ok(existsSync(join(sandbox, 'indexes', 'latest-by-repo.json')),
      'sandbox indexes/latest-by-repo.json must exist');

    // The real tree is untouched — same record count as before this test.
    const realRecordsAfter = countRecords(resolve(REPO_ROOT, 'records'));
    assert.equal(realRecordsAfter, realRecordsBefore,
      'the real records/ tree must gain no entries (no leak)');
  });

  it('B2: the override actually MOVES with the env var (not vacuous)', () => {
    // Two distinct sandboxes; each run targets its own. If the env var were
    // ignored (pre-fix), both writes would land in the same (real) place and
    // neither sandbox would hold exactly one record.
    const sandboxA = makeSandboxRoot();
    const sandboxB = makeSandboxRoot();

    const a = runCli([], pilot0, { INGEST_REPO_ROOT: sandboxA });
    // Same run_id in B → would be a duplicate IF both shared a root. Different
    // roots mean B sees an empty tree and writes fresh.
    const b = runCli([], pilot0, { INGEST_REPO_ROOT: sandboxB });

    assert.equal(a.status, 0, `A exit 0; ${a.stderr}`);
    assert.equal(b.status, 0, `B exit 0; ${b.stderr}`);
    assert.equal(countRecords(join(sandboxA, 'records')), 1, 'sandboxA holds its record');
    assert.equal(countRecords(join(sandboxB, 'records')), 1, 'sandboxB holds its record');

    const outB = JSON.parse(b.stdout.trim().split('\n').pop());
    assert.equal(outB.written, true,
      'B must be a fresh write (proves B used its own root, not a shared one where it would be a duplicate)');
  });
});

describe('SEED-1 CLI path output is forward-slash only (d3-ingest-003)', () => {
  it('verify-only would_persist_to has no backslash', () => {
    const sandbox = makeSandboxRoot();
    const child = runCli(['--verify-only'], pilot0, { INGEST_REPO_ROOT: sandbox });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.ok(
      !out.would_persist_to.includes('\\'),
      `would_persist_to must be forward-slash only, got: ${out.would_persist_to}`,
    );
  });

  it('real-ingest path has no backslash', () => {
    const sandbox = makeSandboxRoot();
    const child = runCli([], pilot0, { INGEST_REPO_ROOT: sandbox });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.ok(
      !out.path.includes('\\'),
      `persisted path output must be forward-slash only, got: ${out.path}`,
    );
  });

  it('persist_complete NDJSON log path has no backslash', () => {
    const sandbox = makeSandboxRoot();
    const child = runCli([], pilot0, { INGEST_REPO_ROOT: sandbox });
    assert.equal(child.status, 0, child.stderr);
    const persistLine = child.stderr
      .split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(o => o && o.component === 'ingest' && o.stage === 'persist_complete');
    assert.ok(persistLine, `expected a persist_complete NDJSON line; stderr=${child.stderr}`);
    assert.equal(typeof persistLine.path, 'string');
    assert.ok(
      !persistLine.path.includes('\\'),
      `persist_complete log path must be forward-slash only, got: ${persistLine.path}`,
    );
  });
});
