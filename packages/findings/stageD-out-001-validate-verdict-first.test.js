/**
 * Stage D D-OUT-001 — `findings validate` is verdict-first.
 *
 * Every other verdict surface in testing-os leads with the verdict: swarm
 * findings-digest prints VERDICT first, swarm status frames the assessment at
 * the top, verify --explain leads with VERDICT. `findings validate` was the
 * odd one out — the pass/fail summary was buried under the scrolling per-file
 * PASS/FAIL wall, so an operator running it over a large tree had to scroll to
 * the bottom to learn the answer.
 *
 * This proves the fix: the output now opens with a one-line `VALIDATION:`
 * header (count of findings checked) and closes with a prominent `VERDICT:`
 * line (PASS, or FAIL (<n> failed)). The existing "N passed, N failed"
 * summary is kept. The exit code still matches the verdict.
 *
 * Driven through the real CLI as a subprocess against TEST_ROOT temp trees —
 * never the real findings tree. FINDINGS_REPO_ROOT points validate at the
 * temp root.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');
const TEST_ROOT = resolve(__dirname, '__test_dout001_validate_verdict__');
const REPO_ROOT = resolve(__dirname, '../..');

const VALID_FIXTURE = resolve(
  REPO_ROOT,
  'fixtures/findings/valid/dfind-shipcheck-cli-entrypoint-truth.yaml'
);
const INVALID_FIXTURE = resolve(
  REPO_ROOT,
  'fixtures/findings/invalid/missing-issue-kind.yaml'
);

function findingsDir() {
  return resolve(TEST_ROOT, 'findings', 'acme', 'widget');
}

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(findingsDir(), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function runValidate() {
  return spawnSync(process.execPath, [CLI, 'validate'], {
    env: { ...process.env, FINDINGS_REPO_ROOT: TEST_ROOT },
    encoding: 'utf-8'
  });
}

describe('Stage D D-OUT-001: findings validate is verdict-first', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('clean tree: opens with VALIDATION header, ends with VERDICT: PASS, exits 0', () => {
    copyFileSync(VALID_FIXTURE, resolve(findingsDir(), 'dfind-clean.yaml'));

    const res = runValidate();
    const out = res.stdout;
    const lines = out.split('\n').filter(l => l.trim().length > 0);

    assert.match(lines[0], /^VALIDATION:/, 'first output line must be the VALIDATION header');
    assert.match(lines[0], /\b1\b/, 'header should report the count of findings checked');

    assert.match(out, /VERDICT:\s*PASS/, 'must print a prominent VERDICT: PASS line');
    assert.match(lines[lines.length - 1], /^VERDICT:/, 'last output line must be the VERDICT line');

    assert.match(out, /1 passed, 0 failed/, 'existing N passed, N failed summary is kept');
    assert.equal(res.status, 0, 'exit code matches the PASS verdict');
  });

  it('failing tree: opens with VALIDATION header, ends with VERDICT: FAIL, exits 1', () => {
    copyFileSync(INVALID_FIXTURE, resolve(findingsDir(), 'dfind-broken.yaml'));

    const res = runValidate();
    const out = res.stdout;
    const lines = out.split('\n').filter(l => l.trim().length > 0);

    assert.match(lines[0], /^VALIDATION:/, 'first output line must be the VALIDATION header');

    assert.match(out, /VERDICT:\s*FAIL/, 'must print a prominent VERDICT: FAIL line');
    assert.match(out, /VERDICT:\s*FAIL\s*\(\d+ failed\)/, 'FAIL verdict names the failed count');
    assert.match(lines[lines.length - 1], /^VERDICT:/, 'last output line must be the VERDICT line');

    assert.match(out, /failed/, 'existing summary is kept');
    assert.equal(res.status, 1, 'exit code matches the FAIL verdict');
  });
});
