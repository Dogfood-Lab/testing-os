/**
 * f-a9d91e67-build-submission-cli-parity.test.js
 *
 * F-a9d91e67 — build-submission.js shipped its own inline, isMain-gated CLI:
 * a second, less-hardened front door to the operation cli.js (the installed
 * `dogfood-report`/`report` bin) already provides. The public handbook
 * documents `node packages/report/build-submission.js ...` as a consumer's
 * FIRST command, and that front door had:
 *
 *   - no -h/--help (the flag fell into the missing---scenario-file branch:
 *     one bare usage line, exit 1 — not even cli.js's exit-2 convention);
 *   - no try/catch around buildSubmission(): an ordinary flag typo
 *     (--reop instead of --repo) surfaced a raw uncaught Node stack
 *     (`at buildSubmission (file:///...)`), Node's default exit 1, zero
 *     structured message, zero hint — the exact "no raw stacks" class
 *     SHIP_GATE hard gate B exists to catch, already fixed one file over
 *     in cli.js for this identical call.
 *
 * The fix delegates the entry point to cli.js's exported run(), so the
 * documented command keeps working and there is exactly ONE parser, one
 * USAGE block, one `ERROR [<CODE>]:` envelope, and one exit-code contract
 * (2 usage / 1 precheck) to keep in parity.
 *
 * Run as a child process (no mocks) because the contract under test is exit
 * codes + stdout/stderr separation — what the handbook-following operator
 * actually sees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const BUILD_SUBMISSION_JS = resolve(__dirname, 'build-submission.js');
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

function runEntry(entry, args) {
  try {
    const stdout = execFileSync(process.execPath, [entry, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Strip the GitHub Actions env so flag fallbacks (GITHUB_REPOSITORY
      // etc.) can't be satisfied by the test runner's own environment.
      env: { PATH: process.env.PATH },
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
  const root = mkdtempSync(join(tmpdir(), 'report-legacy-cli-'));
  try {
    const file = join(root, 'results.json');
    writeFileSync(file, JSON.stringify(results), 'utf-8');
    return fn(file, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @pins F-a9d91e67 */
describe('F-a9d91e67: node build-submission.js (the handbook-documented entry) has cli.js parity', () => {
  it('--help exits 0 with the SAME USAGE block the dogfood-report bin prints (one parser, byte-for-byte)', () => {
    const legacy = runEntry(BUILD_SUBMISSION_JS, ['--help']);
    const bin = runEntry(CLI_JS, ['--help']);
    assert.equal(legacy.code, 0,
      `--help must exit 0; stderr=${legacy.stderr}`);
    assert.match(legacy.stdout, /Usage:/,
      'help must include the multi-section USAGE block, not one bare usage line');
    assert.match(legacy.stdout, /Exit codes:/,
      'help must document the exit-code contract');
    assert.equal(legacy.stdout, bin.stdout,
      'both entry points must print the identical USAGE block — parity by construction, not by parallel maintenance');
  });

  it('an ordinary flag typo (--reop instead of --repo) exits 2 with the structured envelope, NOT a raw buildSubmission stack', () => {
    withScenarioFile(VALID_SCENARIO_RESULTS, (file) => {
      const args = baseArgs(file).map((a) => (a === '--repo' ? '--reop' : a));
      const { code, stdout, stderr } = runEntry(BUILD_SUBMISSION_JS, args);
      assert.equal(code, 2,
        `a flag typo is a usage error and must exit 2 (cli.js contract); got ${code}; stderr=${stderr}`);
      assert.match(stderr, /^ERROR \[[A-Z_]+\]:/m,
        `stderr must carry the repo-wide ERROR [<CODE>]: envelope; got: ${stderr}`);
      assert.match(stderr, /--reop/,
        'the error must name the offending flag so the operator can see the typo');
      assert.ok(!/at buildSubmission \(/.test(stderr),
        `must not surface a raw uncaught buildSubmission stack; got: ${stderr}`);
      assert.equal(stdout, '', 'stdout must stay pure (empty) on a usage error');
    });
  });

  it('a missing required flag (--repo dropped, env stripped) exits 2 with MISSING_REQUIRED_FLAG, not a raw stack', () => {
    withScenarioFile(VALID_SCENARIO_RESULTS, (file) => {
      const args = baseArgs(file).filter(
        (a, i, arr) => a !== '--repo' && arr[i - 1] !== '--repo'
      );
      const { code, stderr } = runEntry(BUILD_SUBMISSION_JS, args);
      assert.equal(code, 2,
        `missing --repo must exit 2; stderr=${stderr}`);
      assert.match(stderr, /^ERROR \[MISSING_REQUIRED_FLAG\]:/m,
        `stderr must carry the structured envelope; got: ${stderr}`);
      assert.match(stderr, /--repo/, 'error must name the missing flag');
      assert.ok(!/at buildSubmission \(/.test(stderr),
        `must not surface a raw uncaught buildSubmission stack; got: ${stderr}`);
    });
  });

  it('NEGATIVE control: the exact handbook-shaped healthy invocation still builds a submission on stdout, exit 0', () => {
    withScenarioFile(VALID_SCENARIO_RESULTS, (file) => {
      const { code, stdout, stderr } = runEntry(BUILD_SUBMISSION_JS, baseArgs(file));
      assert.equal(code, 0, `healthy invocation must exit 0; stderr=${stderr}`);
      let submission;
      assert.doesNotThrow(() => { submission = JSON.parse(stdout); },
        `stdout must be pure parseable JSON; got: ${stdout.slice(0, 200)}`);
      assert.equal(submission.repo, 'mcp-tool-shop-org/demo');
      assert.equal(submission.overall_verdict, 'pass');
      assert.equal(submission.scenario_results.length, 1);
    });
  });
});
