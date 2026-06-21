/**
 * cli.js — dogfood-report bin smoke + contract suite.
 *
 * FT-i (cli-ux) — @dogfood-lab/report shipped a builder module but no installed
 * command. cli.js is that command. These tests pin its operator contract by
 * spawning the real bin (no mocks): stdout must be pure submission JSON on
 * success, and an argument problem must exit 2 with the repo-wide
 * `ERROR [<CODE>]:` structured envelope on stderr.
 *
 * Run as a child process (not by importing `run`) because the contract under
 * test is exit codes + stdout/stderr separation — the things a consumer who
 * pipes `dogfood-report ... | jq` actually depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CLI_JS = resolve(__dirname, 'cli.js');

const VALID_SCENARIO_RESULTS = [
  {
    scenario_id: 'record-ingest-roundtrip',
    scenario_name: 'Record ingest roundtrip',
    scenario_version: '1.0.0',
    product_surface: 'cli',
    execution_mode: 'bot',
    verdict: 'pass',
    step_results: [{ step_id: 'emit-submission', status: 'pass' }],
    evidence: [{ kind: 'log', url: 'https://example.com/log' }],
  },
];

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_JS, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Strip the GitHub Actions env so flag fallbacks don't accidentally
      // satisfy a "missing flag" case from the runner's own environment.
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

function baseArgs(scenarioFile) {
  return [
    '--scenario-file', scenarioFile,
    '--repo', 'mcp-tool-shop-org/demo',
    '--commit', 'a'.repeat(40),
    '--branch', 'main',
    '--workflow', 'dogfood.yml',
    '--provider-run-id', '12345',
    '--run-url', 'https://github.com/mcp-tool-shop-org/demo/actions/runs/12345',
    '--actor', 'ci-bot',
    '--started-at', '2026-03-19T15:00:00Z',
    '--finished-at', '2026-03-19T15:01:00Z',
    '--verdict', 'pass',
  ];
}

function withScenarioFile(results, fn) {
  const root = mkdtempSync(join(tmpdir(), 'report-cli-'));
  try {
    const file = join(root, 'results.json');
    writeFileSync(file, JSON.stringify(results), 'utf-8');
    return fn(file, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('dogfood-report cli (FT-i)', () => {
  it('builds a valid submission from flags + scenario file and prints pure JSON to stdout', () => {
    withScenarioFile(VALID_SCENARIO_RESULTS, (file) => {
      const { code, stdout, stderr } = runCli(baseArgs(file));
      assert.equal(code, 0, `expected exit 0; stderr=${stderr}`);

      // stdout must be PURE JSON — parse it whole, no diagnostic prefix/suffix.
      let submission;
      assert.doesNotThrow(() => { submission = JSON.parse(stdout); },
        `stdout must be parseable JSON; got: ${stdout.slice(0, 200)}`);

      assert.equal(submission.repo, 'mcp-tool-shop-org/demo');
      assert.equal(submission.ref.commit_sha, 'a'.repeat(40));
      assert.equal(submission.schema_version, '1.0.0');
      assert.equal(submission.overall_verdict, 'pass');
      assert.equal(submission.scenario_results.length, 1);
      // The built submission satisfies precheck (which ran by default).
      assert.equal(submission.scenario_results[0].scenario_id, 'record-ingest-roundtrip');
    });
  });

  it('exits 2 with a structured ERROR [<CODE>]: line when a required flag is missing', () => {
    withScenarioFile(VALID_SCENARIO_RESULTS, (file) => {
      // Drop --repo (and ensure GITHUB_REPOSITORY is not present in env).
      const args = baseArgs(file).filter(
        (a, i, arr) => a !== '--repo' && arr[i - 1] !== '--repo'
      );
      const { code, stdout, stderr } = runCli(args);
      assert.equal(code, 2, `missing --repo must exit 2; stderr=${stderr}`);
      assert.match(stderr, /^ERROR \[MISSING_REQUIRED_FLAG\]:/m,
        `stderr must carry the structured envelope; got: ${stderr}`);
      assert.match(stderr, /--repo/, 'error must name the missing flag');
      // stdout stays clean — no partial JSON leaks on the failure path.
      assert.equal(stdout, '', `stdout must be empty on usage error; got: ${stdout}`);
    });
  });

  it('exits 2 with a structured error when --scenario-file is omitted entirely', () => {
    const args = baseArgs('placeholder').filter(
      (a, i, arr) => a !== '--scenario-file' && arr[i - 1] !== '--scenario-file'
    );
    const { code, stderr } = runCli(args);
    assert.equal(code, 2, `missing --scenario-file must exit 2; stderr=${stderr}`);
    assert.match(stderr, /^ERROR \[MISSING_REQUIRED_FLAG\]:/m);
    assert.match(stderr, /scenario-file/);
  });

  it('exits 2 with a structured error when --scenario-file points at a missing file', () => {
    const missing = resolve(tmpdir(), 'report-cli-nope-' + Date.now() + '.json');
    const { code, stderr } = runCli(baseArgs(missing));
    assert.equal(code, 2, `unreadable scenario file must exit 2; stderr=${stderr}`);
    assert.match(stderr, /^ERROR \[SCENARIO_FILE_UNREADABLE\]:/m);
    assert.ok(stderr.includes(missing) || /scenario-file/.test(stderr),
      `error must name the offending file; got: ${stderr}`);
  });

  it('exits 1 (not 2) when the built submission fails precheck', () => {
    // A scenario with an out-of-enum verdict builds fine but fails the verifier
    // contract — a different failure class than "called wrong".
    const badResults = [{ ...VALID_SCENARIO_RESULTS[0], verdict: 'meh' }];
    withScenarioFile(badResults, (file) => {
      const { code, stdout, stderr } = runCli(baseArgs(file));
      assert.equal(code, 1, `precheck failure must exit 1; stderr=${stderr}`);
      assert.match(stderr, /^ERROR \[PRECHECK_FAILED\]:/m);
      assert.equal(stdout, '', 'no JSON should be emitted when precheck fails');
    });
  });

  it('--no-precheck emits the submission even when it would fail precheck', () => {
    const badResults = [{ ...VALID_SCENARIO_RESULTS[0], verdict: 'meh' }];
    withScenarioFile(badResults, (file) => {
      const { code, stdout } = runCli([...baseArgs(file), '--no-precheck']);
      assert.equal(code, 0, '--no-precheck must skip validation and exit 0');
      const submission = JSON.parse(stdout);
      assert.equal(submission.scenario_results[0].verdict, 'meh');
    });
  });

  it('--help prints usage to stdout and exits 0', () => {
    const { code, stdout } = runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /dogfood-report/);
    assert.match(stdout, /--scenario-file/);
  });

  it('--output writes to a file and keeps stdout empty (pipe-safe)', () => {
    withScenarioFile(VALID_SCENARIO_RESULTS, (file, root) => {
      const out = join(root, 'submission.json');
      const { code, stdout } = runCli([...baseArgs(file), '--output', out]);
      assert.equal(code, 0);
      assert.equal(stdout, '', 'stdout must stay empty when writing to --output');
    });
  });
});
