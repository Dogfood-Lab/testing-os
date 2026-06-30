/**
 * status.js — `dogfood-report --status` confirmation contract suite.
 *
 * The adoption audit's most dangerous silent failure was the one AFTER dispatch:
 * a consumer's CI fires the repository_dispatch, the workflow goes green, and the
 * submission is NEVER recorded (rejected on provenance/schema/policy, or lost) —
 * yet nothing in the consumer's own CI ever turns red. This command closes that
 * loop: it reads the receiver's PUBLIC served index (no auth) and answers, with
 * an exit code a CI step can gate on, "is my latest run recorded, accepted, and
 * fresh?".
 *
 * The index lives at
 *   https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/latest-by-repo.json
 * which ONLY ever contains accepted records — so an absent repo means the run was
 * rejected or never arrived, both of which must fail a consumer's confirm step.
 *
 * These tests drive the importable `runStatus` seam with an INJECTED fetch so the
 * suite is fully offline — it never touches the network — and also spawn the real
 * bin once to pin the exit-code + stdout/stderr contract a consumer depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStatus, buildStatusJSON } from '@dogfood-lab/report/status.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CLI_JS = resolve(__dirname, 'cli.js');

const REPO = 'acme/widgets';

const FRESH_ISO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const STALE_ISO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Build a fake fetch that serves the given index payloads from the
 * raw.githubusercontent.com base. Keyed by the index basename so a test can
 * supply latest-by-repo.json (and, where relevant, a served record) without a
 * live network. Returns 404 for any path it was not given.
 */
function fakeFetch(files) {
  return async (url) => {
    for (const [name, body] of Object.entries(files)) {
      if (url.endsWith(name)) {
        return {
          ok: true,
          status: 200,
          async json() { return body; },
          async text() { return JSON.stringify(body); },
        };
      }
    }
    return {
      ok: false,
      status: 404,
      async json() { throw new Error('not json'); },
      async text() { return 'Not Found'; },
    };
  };
}

function acceptedIndex({ verified = 'pass', finishedAt = FRESH_ISO } = {}) {
  return {
    [REPO]: {
      cli: {
        run_id: 'widgets-123-1',
        verified,
        verification_status: 'accepted',
        finished_at: finishedAt,
        path: `records/${REPO}/2026/06/29/run-widgets-123-1.json`,
      },
    },
  };
}

describe('dogfood-report --status (runStatus seam, offline)', () => {
  it('recorded + accepted + fresh → exit 0 and reports accepted/fresh', async () => {
    const result = await runStatus({
      repo: REPO,
      fetchImpl: fakeFetch({ 'latest-by-repo.json': acceptedIndex() }),
    });
    assert.equal(result.exitCode, 0, `accepted+fresh must exit 0; ${result.message}`);
    assert.equal(result.recorded, true);
    assert.equal(result.accepted, true);
    assert.equal(result.fresh, true);
    assert.match(result.message, /recorded/i);
    assert.match(result.message, /accepted/i);
    assert.match(result.message, /fresh/i);
  });

  it('recorded but the latest verified verdict is not pass → nonzero + names the rejection reason', async () => {
    const servedRecord = {
      run_id: 'widgets-123-1',
      repo: REPO,
      overall_verdict: { verified: 'fail' },
      verification: {
        status: 'accepted',
        rejection_reasons: ['policy: required surface "cli" downgraded to fail'],
      },
    };
    const result = await runStatus({
      repo: REPO,
      fetchImpl: fakeFetch({
        'latest-by-repo.json': acceptedIndex({ verified: 'fail' }),
        'run-widgets-123-1.json': servedRecord,
      }),
    });
    assert.notEqual(result.exitCode, 0, 'a failing verdict must fail the confirm step');
    assert.match(result.message + result.reasons.join(' '), /downgraded to fail/,
      'the surfaced reason must name why the run did not pass');
  });

  it('absent from the served index → nonzero + "no record found"', async () => {
    const result = await runStatus({
      repo: REPO,
      fetchImpl: fakeFetch({ 'latest-by-repo.json': { 'someone/else': {} } }),
    });
    assert.notEqual(result.exitCode, 0,
      'an unrecorded run must fail a consumer CI confirm step, not go green');
    assert.match(result.message, /no .*record/i);
  });

  it('recorded + accepted but STALE → nonzero + says stale', async () => {
    const result = await runStatus({
      repo: REPO,
      fetchImpl: fakeFetch({ 'latest-by-repo.json': acceptedIndex({ finishedAt: STALE_ISO }) }),
    });
    assert.notEqual(result.exitCode, 0, 'a stale latest run must fail the confirm step');
    assert.equal(result.fresh, false);
    assert.match(result.message, /stale/i);
  });

  it('buildStatusJSON is an identity projection of the status result (--format=json seam)', async () => {
    const result = await runStatus({
      repo: REPO,
      fetchImpl: fakeFetch({ 'latest-by-repo.json': acceptedIndex() }),
    });
    const json = buildStatusJSON(result);
    assert.equal(json.repo, REPO);
    assert.equal(json.recorded, true);
    assert.equal(json.accepted, true);
    assert.equal(json.fresh, true);
    // Round-trips through JSON.stringify without throwing (pure data).
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(json)));
  });
});

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_JS, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ...opts.env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

describe('dogfood-report --status bin contract', () => {
  it('--status without --repo exits 2 with a structured error', () => {
    const { code, stderr } = runCli(['--status']);
    assert.equal(code, 2, `missing --repo under --status must exit 2; stderr=${stderr}`);
    assert.match(stderr, /^ERROR \[MISSING_REQUIRED_FLAG\]:/m);
    assert.match(stderr, /--repo/);
  });

  it('--status against a local fixture index file resolves offline (--index-base file://...)', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-status-'));
    try {
      // A directory laid out like the served indexes/ tree, addressed via a
      // file:// base so the bin reads it with no network.
      const idxDir = join(root, 'indexes');
      execFileSync(process.execPath, ['-e',
        `require('node:fs').mkdirSync(${JSON.stringify(idxDir)},{recursive:true})`]);
      writeFileSync(
        join(idxDir, 'latest-by-repo.json'),
        JSON.stringify(acceptedIndex()),
        'utf-8'
      );
      const base = 'file://' + root.replace(/\\/g, '/') + '/';
      const { code, stdout } = runCli(['--status', '--repo', REPO, '--index-base', base]);
      assert.equal(code, 0, `accepted+fresh fixture must exit 0; stdout=${stdout}`);
      assert.match(stdout, /accepted/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
