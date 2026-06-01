/**
 * load-records-skip.test.js — H2 silent-loader closure for the derive package
 * (F-721047-010 family, advisor-surfaced siblings at
 * derive/load-records.js:110 and :137).
 *
 * AT HEAD: `walkRecords` and `findRecordFile` both wrap `JSON.parse(readFileSync(...))`
 * in `try { ... } catch { /* skip * / }`. A torn JSON record file disappears
 * without signal — the derivation engine then runs on a quietly partial
 * dataset.
 *
 * AFTER FIX: each loader exposes a `*WithSkips` API returning
 * `{ entries: [...], skipped: [{ path, error }] }`. The legacy array-shape
 * `loadRecordsForRepo` / `loadAllRecords` remain so existing call sites
 * (rules.js, derive-findings.js) keep working.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import {
  loadRecordsForRepo,
  loadAllRecords,
  loadRecordsForRepoWithSkips,
  loadAllRecordsWithSkips,
} from './load-records.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_load_records_skip__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function writeGoodRecord(dirPath, fileName, runId) {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(
    resolve(dirPath, fileName),
    JSON.stringify({ run_id: runId, scenario_results: [] }, null, 2),
    'utf-8'
  );
}

function writeTornRecord(dirPath, fileName) {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(resolve(dirPath, fileName), '{ this is not valid json', 'utf-8');
}

describe('walkRecords — H2 silent-loader closure (load-records.js:110)', () => {
  before(setup);
  after(teardown);

  it('loadRecordsForRepo: good records surface; torn JSON is REPORTED, not silently dropped', () => {
    const root = resolve(TEST_ROOT, 'l1');
    const repoDir = resolve(root, 'records', 'org-x', 'repo-y');
    writeGoodRecord(repoDir, 'run-good.json', 'run-good');
    writeTornRecord(repoDir, 'run-torn.json');

    // Legacy array API — only good records, no throw.
    const arr = loadRecordsForRepo(root, 'org-x/repo-y');
    assert.equal(arr.length, 1, 'one good record surfaces');
    assert.equal(arr[0].record.run_id, 'run-good');

    // Structured API — surfaces torn file.
    const { entries, skipped } = loadRecordsForRepoWithSkips(root, 'org-x/repo-y');
    assert.equal(entries.length, 1, 'one good entry');
    assert.equal(skipped.length, 1, 'torn record reported');
    assert.match(skipped[0].path, /run-torn\.json$/);
    assert.match(skipped[0].error, /JSON parse error/);
  });

  it('loadAllRecords: torn JSON in either accepted or rejected tree surfaces in skipped', () => {
    const root = resolve(TEST_ROOT, 'l2');
    writeGoodRecord(resolve(root, 'records', 'org-a', 'repo-1'), 'good-acc.json', 'good-acc');
    writeTornRecord(resolve(root, 'records', 'org-a', 'repo-1'), 'torn-acc.json');
    writeGoodRecord(resolve(root, 'records', '_rejected', 'org-a', 'repo-1'), 'good-rej.json', 'good-rej');
    writeTornRecord(resolve(root, 'records', '_rejected', 'org-a', 'repo-1'), 'torn-rej.json');

    const arr = loadAllRecords(root);
    assert.equal(arr.length, 2, 'two good records (one accepted, one rejected)');

    const { entries, skipped } = loadAllRecordsWithSkips(root);
    assert.equal(entries.length, 2);
    assert.equal(skipped.length, 2, 'both torn files reported');
    const skippedPaths = skipped.map(s => s.path).sort();
    assert.match(skippedPaths[0], /torn-acc\.json$|torn-rej\.json$/);
    assert.match(skippedPaths[1], /torn-acc\.json$|torn-rej\.json$/);
  });
});
