/**
 * --verify-chain CLI contract tests.
 *
 * Proves the standalone audit command's exit-code contract end-to-end as a real
 * subprocess (mirrors stageA-seed2-repo-root-override.test.js's spawn idiom):
 *   - clean chain → exit 0, "integrity chain OK" on stdout.
 *   - tampered record → exit 1, "BROKEN" on stderr (the RED gate).
 *   - empty chain (no manifest) → exit 0 (trivially valid).
 *   - --verify-chain takes no submission and does NOT block on stdin or demand
 *     a --provenance flag (it is handled before stdin/provenance resolution).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { writeRecord } from './persist.js';
import { chainManifestPath } from './lib/chain-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_JS = resolve(__dirname, 'run.js');

const sandboxes = [];

function makeSandboxRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ingest-chain-cli-'));
  mkdirSync(join(root, 'records'), { recursive: true });
  mkdirSync(join(root, 'records', '_rejected'), { recursive: true });
  mkdirSync(join(root, 'indexes'), { recursive: true });
  sandboxes.push(root);
  return root;
}

function buildRecord(id) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: id,
    repo: 'dogfood-lab/testing-os',
    ref: { commit_sha: 'a'.repeat(40) },
    source: {
      provider: 'github',
      workflow: 'dogfood.yml',
      provider_run_id: '12345',
      run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
    },
    timing: { started_at: '2026-03-19T15:45:00Z', finished_at: '2026-03-19T15:45:12Z' },
    scenario_results: [{
      scenario_id: 'sanity',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'one', status: 'pass' }],
    }],
    overall_verdict: { proposed: 'pass', verified: 'pass' },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-19T15:45:13Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
    },
  };
}

/**
 * Run `run.js --verify-chain` as a subprocess against a sandbox root. No
 * --provenance, no stdin payload — the command must not require either. We still
 * pass empty stdin so the child never blocks waiting for it (proving the early
 * dispatch). `extraArgs` carries the modifier flags (`--reconcile`, `--all`).
 */
function runVerifyChain(root, extraArgs = []) {
  return spawnSync(process.execPath, [RUN_JS, '--verify-chain', ...extraArgs], {
    input: '',
    encoding: 'utf-8',
    env: {
      ...process.env,
      INGEST_REPO_ROOT: root,
      CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '',
    },
  });
}

/**
 * Truncate the sandbox chain ledger to its first `keep` lines, orphaning every
 * record whose ledger line was dropped (the record file stays on disk). This is
 * the torn-persist shape INGEST-PROACT-001 / --reconcile detects: the record was
 * written but its ledger append went missing.
 */
function truncateChainTo(root, keep) {
  const path = chainManifestPath(root);
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  writeFileSync(path, lines.slice(0, keep).join('\n') + '\n', 'utf-8');
}

afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true });
});

describe('--verify-chain CLI', () => {
  it('exits 0 and prints OK on a clean chain (no --provenance, no stdin payload)', () => {
    const root = makeSandboxRoot();
    writeRecord(buildRecord('cli-clean-a'), root);
    writeRecord(buildRecord('cli-clean-b'), root);

    const child = runVerifyChain(root);
    assert.equal(child.status, 0, `stderr: ${child.stderr}`);
    assert.match(child.stdout, /integrity chain OK: 2 record\(s\) verified/);
    assert.match(child.stdout, /head digest: [0-9a-f]{64}/);
  });

  it('exits 0 on an empty chain (no manifest yet)', () => {
    const root = makeSandboxRoot();
    const child = runVerifyChain(root);
    assert.equal(child.status, 0, `stderr: ${child.stderr}`);
    assert.match(child.stdout, /integrity chain OK: 0 record\(s\) verified/);
  });

  it('exits 1 and reports the break on a tampered record (RED gate)', () => {
    const root = makeSandboxRoot();
    writeRecord(buildRecord('cli-tamper-a'), root);
    const { path: p1 } = writeRecord(buildRecord('cli-tamper-b'), root);

    // Tamper: mutate the record content on disk without touching the manifest.
    const tampered = JSON.parse(readFileSync(p1, 'utf-8'));
    tampered.notes = 'injected after persist';
    writeFileSync(p1, JSON.stringify(tampered, null, 2) + '\n', 'utf-8');

    const child = runVerifyChain(root);
    assert.equal(child.status, 1, `expected exit 1, got ${child.status}; stdout: ${child.stdout}`);
    assert.match(child.stderr, /integrity chain BROKEN at seq 1/);
    assert.match(child.stderr, /cli-tamper-b/);
  });
});

describe('--verify-chain --reconcile (orphan reconciliation)', () => {
  it('exits 1 and prints the orphan when a record is absent from the ledger', () => {
    const root = makeSandboxRoot();
    writeRecord(buildRecord('cli-orphan-a'), root);
    writeRecord(buildRecord('cli-orphan-b'), root);
    writeRecord(buildRecord('cli-orphan-c'), root);

    // Torn persist: the third record's file is on disk but its ledger line never
    // landed. Drop it by truncating chain.jsonl to the first two lines.
    truncateChainTo(root, 2);

    const child = runVerifyChain(root, ['--reconcile']);
    assert.equal(child.status, 1, `expected exit 1, got ${child.status}; stdout: ${child.stdout}`);
    assert.match(child.stderr, /reconciliation: 1 orphan record\(s\)/);
    assert.match(child.stderr, /cli-orphan-c/);
  });

  it('exits 0 without --reconcile — the chain walk alone is blind to the orphan', () => {
    const root = makeSandboxRoot();
    writeRecord(buildRecord('cli-orphan-a'), root);
    writeRecord(buildRecord('cli-orphan-b'), root);
    writeRecord(buildRecord('cli-orphan-c'), root);
    truncateChainTo(root, 2);

    const child = runVerifyChain(root);
    assert.equal(child.status, 0, `expected exit 0, got ${child.status}; stderr: ${child.stderr}`);
    assert.match(child.stdout, /integrity chain OK: 2 record\(s\) verified/);
  });
});
