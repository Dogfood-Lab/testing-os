/**
 * f-4acd28d8-unsafe-record-path-cli-exit.test.js
 *
 * F-4acd28d8 (MEDIUM) — F-bbbe2e1f (wave 4) classified writeRecord()'s second
 * computeRecordPath() throw as a named UnsafeRecordPathError (`.code ===
 * 'UNSAFE_RECORD_PATH'`), replacing a bare Error. That was necessary but not
 * sufficient: nothing in run.js branched on `.code`, so the classified error
 * still fell through to the CLI's generic outer catch — a schema-valid but
 * traversal-unsafe repo (e.g. `../etc`) still exited 2 ("operator error" per
 * the CLI's own USAGE block) for content that is squarely submission-bad,
 * with `failed_stage:'cli_parse_payload'` (wrong — payload parsing succeeded
 * three stages earlier) and zero persisted evidence.
 *
 * The fix: `ingest()` now catches UnsafeRecordPathError around its
 * writeRecord() call and returns a normal `{ record, written: false, ... }`
 * result instead of throwing (see f-bbbe2e1f-unsafe-repo-segment-write-path
 * .test.js for the function-level proof). This file proves the CONSEQUENCE
 * the finding actually cared about: driven as a real CLI subprocess — the
 * same way the finding itself was proven — the process now exits 1 (not 2),
 * and the outer catch's stage:error event (with its misleading
 * failed_stage:'cli_parse_payload') never fires at all.
 *
 * `INGEST_REPO_ROOT` (SEED-2 / d3-ingest-002) lets this run against an
 * isolated sandbox without the setupTempRunJs source-copy dance — no fs
 * writes occur for this scenario (writeRecord's second computeRecordPath call
 * fails BEFORE anything touches disk), so a plain temp dir with just
 * `policies/` copied in is enough for the pipeline to reach verify().
 *
 * Deletion/emptiness proof: revert the UnsafeRecordPathError catch in
 * run.js's ingest() (packages/ingest/run.js, the writeRecord() try/catch) and
 * this goes red — the CLI reverts to exit 2 with a stage:error event.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(__dirname, '../verify/fixtures');
const TEST_ROOT = resolve(__dirname, '.test-root-f-4acd28d8-cli');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

function setupTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  cpSync(resolve(REPO_ROOT, 'policies'), resolve(TEST_ROOT, 'policies'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** Parse NDJSON `logStage` lines out of a captured stderr stream. */
function parseStageEvents(stderrText) {
  const events = [];
  for (const line of stderrText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.stage) events.push(parsed);
    } catch {
      // Tolerate non-JSON noise (e.g. WARNING: lines).
    }
  }
  return events;
}

function runCli(payload) {
  return spawnSync(process.execPath, [
    resolve(__dirname, 'run.js'),
    '--provenance', 'stub'
  ], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CI: '',
      GITHUB_ACTIONS: '',
      INGEST_REPO_ROOT: TEST_ROOT
    }
  });
}

describe('F-4acd28d8: the CLI exits 1 (not 2) for a schema-valid, traversal-unsafe repo', () => {
  it('a schema-valid submission with repo: "../etc" exits 1 with a rejected-status JSON body, not 2', () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f-4acd28d8-cli-unsafe-path';
    submission.repo = '../etc';
    submission.source.run_url = 'https://github.com/../etc/actions/runs/9123456789';

    const child = runCli(submission);

    assert.equal(child.status, 1,
      `expected exit 1 (rejected, submission-bad), got ${child.status}. ` +
      `stdout=${child.stdout} stderr=${child.stderr}`);

    const stdout = JSON.parse(child.stdout);
    assert.equal(stdout.status, 'rejected');
    assert.equal(stdout.written, false);
    assert.equal(stdout.path, null);
    assert.ok(
      stdout.rejection_reasons.some(r => r.startsWith('unsafe-record-path:')),
      `expected an 'unsafe-record-path:' reason in stdout, got: ${JSON.stringify(stdout.rejection_reasons)}`
    );

    // The whole point: the outer catch's stage:error event — which would
    // carry the misleading failed_stage:'cli_parse_payload' — must NEVER
    // fire for this submission-bad content.
    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter(e => e.stage === 'error');
    assert.equal(errorEvents.length, 0,
      `expected zero stage:error events; got ${errorEvents.length}. events=${JSON.stringify(events)}`);

    const rejectedEvent = events.find(e => e.stage === 'rejected_pre_persist');
    assert.ok(rejectedEvent, `expected a rejected_pre_persist event; got stages=${JSON.stringify(events.map(e => e.stage))}`);
    assert.equal(rejectedEvent.reason, 'unsafe_record_path');
  });

  it('GREEN: an ordinary well-formed submission still exits 0 through the same CLI path', () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f-4acd28d8-cli-green-path';

    const child = runCli(submission);

    assert.equal(child.status, 0,
      `expected exit 0 for a well-formed submission; got ${child.status}. ` +
      `stdout=${child.stdout} stderr=${child.stderr}`);
    const stdout = JSON.parse(child.stdout);
    assert.equal(stdout.status, 'accepted');
    assert.equal(stdout.written, true);
  });
});
