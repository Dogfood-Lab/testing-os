/**
 * proac-002-derive-skip-signal.test.js — FIND-PROAC-002.
 *
 * THE INVARIANT: the `derive` CLI handler loaded records via the array-shape
 * loaders (`loadRecordsForRepo` / `loadAllRecords`), which throw away the
 * `skipped[]` list the `*WithSkips` variants carry. A torn / unreadable record
 * JSON file therefore vanished — derivation ran on a quietly partial dataset
 * and the run was reported as clean (records processed count understated, exit
 * 0, no mention of the dropped file). That is a degraded run masquerading as a
 * success.
 *
 * AFTER FIX: the handler uses `loadRecordsForRepoWithSkips` /
 * `loadAllRecordsWithSkips`, prints a prominent
 * `N record(s) skipped (torn/unreadable)` line naming each file on stderr
 * (mirroring how ruleErrors are reported), and exits non-zero so a degraded
 * derive run is never reported as clean.
 *
 * The CLI hardcodes its root, so this test points it at a temp tree via the
 * FINDINGS_REPO_ROOT env override (mirrors verify/cli.js VERIFY_REPO_ROOT) —
 * the real records tree is never touched. Default dry-run (no --write) keeps
 * it read-only.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'cli.js');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TEST_ROOT = resolve(__dirname, '__test_proac_002__');

function firstRealRecord() {
  // Walk records/<org>/<repo>/**.json for any real accepted record to use as
  // a known-good fixture (proves good records still surface alongside the torn).
  const recordsDir = resolve(REPO_ROOT, 'records');
  const stack = [recordsDir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.name === '_rejected') continue;
      const full = resolve(d, name.name);
      if (name.isDirectory()) stack.push(full);
      else if (name.name.endsWith('.json')) return full;
    }
  }
  return null;
}

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  const repoDir = resolve(TEST_ROOT, 'records', 'org-x', 'repo-y');
  mkdirSync(repoDir, { recursive: true });

  const good = firstRealRecord();
  assert.ok(good, 'expected at least one real record to copy as a good fixture');
  cpSync(good, resolve(repoDir, 'run-good.json'));

  // Torn record — invalid JSON. Pre-fix it disappears silently.
  writeFileSync(resolve(repoDir, 'run-torn.json'), '{ this is not valid json', 'utf-8');
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, FINDINGS_REPO_ROOT: TEST_ROOT }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  }
}

describe('FIND-PROAC-002 — derive names torn records and does not report a clean run', () => {
  before(setup);
  after(teardown);

  it('derive --all: torn record is named on stderr and the run is NOT reported clean', () => {
    const r = run(['derive', '--all']);
    assert.notEqual(r.code, 0, 'a degraded derive run must not exit 0');
    assert.match(r.stderr, /run-torn\.json/, 'the offending torn record file must be named');
    assert.match(r.stderr, /skipped \(torn\/unreadable\)/i, 'a prominent skip-count line must be printed');
  });

  it('derive --repo: torn record is named on stderr and the run is NOT reported clean', () => {
    const r = run(['derive', '--repo', 'org-x/repo-y']);
    assert.notEqual(r.code, 0, 'a degraded derive run must not exit 0');
    assert.match(r.stderr, /run-torn\.json/, 'the offending torn record file must be named');
    assert.match(r.stderr, /skipped \(torn\/unreadable\)/i);
  });
});
