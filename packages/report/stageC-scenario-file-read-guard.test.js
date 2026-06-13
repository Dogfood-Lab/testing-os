/**
 * stageC-scenario-file-read-guard.test.js
 *
 * Stage C (humanization) — d3-ingest-B004.
 *
 * The build-submission CLI read+parsed --scenario-file with an unguarded
 *   `JSON.parse(readFileSync(resolve(scenarioFile), 'utf-8'))`.
 * A missing file (ENOENT), unreadable file (EACCES/EISDIR), or malformed JSON
 * threw a raw stack and exited 1 with no structured hint — inconsistent with
 * this same file's precheckSubmission, which returns a clean {valid, errors}
 * shape (F-721047-001), and with run.js's emitCliErrorEvent discipline for
 * --file read failures (cli_read_file stage).
 *
 * Fix: wrap the read+parse in a try/catch that prints a one-line, path-naming
 *   `Could not read/parse --scenario-file <path>: <message>` and exit 1 —
 * matching precheckSubmission's structured-rejection philosophy. The operator
 * sees WHICH file and WHAT went wrong, not a raw ENOENT/SyntaxError stack.
 *
 * Lens: the lowest-stakes boundary in scope (human/CI operator, known path,
 * fails fast and loud) still gets a legible message instead of a raw stack.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const BUILD_SUBMISSION_JS = resolve(__dirname, 'build-submission.js');

// A minimal valid scenario-results array so the NEGATIVE (healthy) case can
// reach precheck + write without tripping an unrelated failure.
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

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [BUILD_SUBMISSION_JS, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
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

// Args that satisfy the rest of buildSubmission's required params so the ONLY
// failure under test is the scenario-file read.
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

describe('build-submission --scenario-file read guard (d3-ingest-B004)', () => {
  it('POSITIVE: a MISSING scenario file exits 1 with a path-naming message, not a raw ENOENT stack', () => {
    const missing = resolve(tmpdir(), 'stageC-b004-does-not-exist-' + Date.now() + '.json');
    const { code, stderr } = runCli(baseArgs(missing));
    assert.equal(code, 1, `missing scenario file must exit 1; stderr=${stderr}`);
    assert.ok(stderr.includes(missing) || stderr.includes('does-not-exist'),
      `error must name the offending scenario file; got stderr=${stderr}`);
    assert.ok(/scenario.?file/i.test(stderr),
      `error must mention --scenario-file; got stderr=${stderr}`);
    // No raw uncaught Error stack frames as the ONLY signal.
    assert.ok(!/^\s*at\s+.*node:fs/m.test(stderr),
      `must not surface a raw fs stack; got stderr=${stderr}`);
  });

  it('POSITIVE: a MALFORMED-JSON scenario file exits 1 with a path-naming message, not a raw SyntaxError stack', () => {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b004-'));
    try {
      const badJson = join(root, 'results.json');
      writeFileSync(badJson, '{ this is not valid json', 'utf-8');
      const { code, stderr } = runCli(baseArgs(badJson));
      assert.equal(code, 1, `malformed scenario JSON must exit 1; stderr=${stderr}`);
      assert.ok(stderr.includes(badJson) || stderr.includes('results.json'),
        `error must name the offending scenario file; got stderr=${stderr}`);
      assert.ok(/scenario.?file/i.test(stderr),
        `error must mention --scenario-file; got stderr=${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('POSITIVE: an UNREADABLE scenario path (a directory) exits 1 with a path-naming message', () => {
    // A directory passed where a file is expected → readFileSync throws EISDIR,
    // a genuine read-time IO error (same class as EACCES/lock), cross-platform.
    const root = mkdtempSync(join(tmpdir(), 'stageC-b004-dir-'));
    try {
      const asDir = join(root, 'results.json');
      mkdirSync(asDir);
      const { code, stderr } = runCli(baseArgs(asDir));
      assert.equal(code, 1, `unreadable scenario path must exit 1; stderr=${stderr}`);
      assert.ok(stderr.includes(asDir) || stderr.includes('results.json'),
        `error must name the offending scenario file; got stderr=${stderr}`);
      assert.ok(/scenario.?file/i.test(stderr),
        `error must mention --scenario-file; got stderr=${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a healthy scenario file builds + writes a submission with exit 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b004-ok-'));
    try {
      const good = join(root, 'results.json');
      writeFileSync(good, JSON.stringify(VALID_SCENARIO_RESULTS), 'utf-8');
      const out = join(root, 'submission.json');
      const { code, stderr } = runCli([...baseArgs(good), '--output', out]);
      assert.equal(code, 0,
        `healthy scenario file must exit 0; stderr=${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
