/**
 * doctor.test.js — `dogfood-init --check` onboarding preflight contract.
 *
 * Scaffolding writes the files; nothing told a consumer whether the wiring is
 * actually correct before they push and burn a CI run discovering it isn't. The
 * doctor audits the onboarding end-to-end and reports a structured checklist with
 * WARN-vs-FAIL severity, mirroring `swarm doctor`'s exit contract: exit non-zero
 * ONLY on a hard FAIL; a WARN (sub-ideal but usable) exits 0.
 *
 * The checks are driven via the importable `runOnboardingDoctor` seam (so the
 * suite asserts per-check status against real on-disk fixtures, no mocks) plus
 * one bin spawn to pin the exit-code contract a consumer's CI step depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOnboardingDoctor } from '@dogfood-lab/report/init.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const INIT_JS = resolve(__dirname, 'init.js');

const VALID_SCENARIO_RESULTS = [
  {
    scenario_id: 'cli-smoke',
    scenario_name: 'CLI builds and runs --help',
    scenario_version: '1.0.0',
    product_surface: 'cli',
    execution_mode: 'bot',
    verdict: 'pass',
    step_results: [{ step_id: 'build', status: 'pass' }],
    evidence: [{ kind: 'log', url: 'https://example.com/log' }],
  },
];

const WIRED_WORKFLOW = `name: dogfood
on:
  workflow_run:
    workflows: ["My Test Suite"]
    types: [completed]
`;

const PLACEHOLDER_WORKFLOW = `name: dogfood
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
`;

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'report-doctor-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Lay out a fully-correct onboarding dir; overrides let a test break one thing. */
function scaffoldGood(root, over = {}) {
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'workflows', 'dogfood.yml'),
    over.workflow ?? WIRED_WORKFLOW,
    'utf-8'
  );
  if (over.scenario !== null) {
    writeFileSync(
      join(root, 'scenario-results.json'),
      over.scenario ?? JSON.stringify(VALID_SCENARIO_RESULTS),
      'utf-8'
    );
  }
  if (over.policy !== null) {
    writeFileSync(join(root, 'policy.example.yaml'), 'repo: acme/widgets\n', 'utf-8');
  }
  // F-9106e1ec: a "complete, correctly-wired" onboarding now includes a
  // committed scenario definition (required-steps enforcement is opt-in;
  // without one the scenario-definitions check WARNs).
  if (over.scenarioDefinition !== null) {
    mkdirSync(join(root, 'dogfood', 'scenarios'), { recursive: true });
    writeFileSync(
      join(root, 'dogfood', 'scenarios', 'cli-smoke.yaml'),
      'scenario_id: cli-smoke\n',
      'utf-8'
    );
  }
}

function checkById(report, id) {
  return report.checks.find((c) => c.id === id);
}

describe('runOnboardingDoctor (FT-doctor)', () => {
  it('a complete, correctly-wired setup passes (exit 0)', () => {
    withTempDir((root) => {
      scaffoldGood(root);
      const report = runOnboardingDoctor({
        dir: root,
        slug: 'acme/widgets',
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      assert.equal(report.exitCode, 0, `complete setup must exit 0; ${JSON.stringify(report.checks)}`);
      assert.equal(report.overallStatus, 'pass');
      assert.equal(checkById(report, 'dogfood-token').status, 'pass');
      assert.equal(checkById(report, 'scenario-results').status, 'pass');
      assert.equal(checkById(report, 'workflow-trigger').status, 'pass');
    });
  });

  it('a missing DOGFOOD_TOKEN is a hard FAIL (exit nonzero)', () => {
    withTempDir((root) => {
      scaffoldGood(root);
      const report = runOnboardingDoctor({ dir: root, slug: 'acme/widgets', env: {} });
      assert.notEqual(report.exitCode, 0, 'missing token must fail the preflight');
      assert.equal(checkById(report, 'dogfood-token').status, 'fail');
    });
  });

  it('a malformed scenario-results.json is a hard FAIL naming the parse problem', () => {
    withTempDir((root) => {
      scaffoldGood(root, { scenario: '{ this is not json' });
      const report = runOnboardingDoctor({
        dir: root,
        slug: 'acme/widgets',
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      assert.notEqual(report.exitCode, 0, 'unparseable scenario file must fail');
      const c = checkById(report, 'scenario-results');
      assert.equal(c.status, 'fail');
      assert.match(c.message + (c.hint || ''), /parse|json/i);
    });
  });

  it('a scenario file that builds but fails precheck is a hard FAIL', () => {
    withTempDir((root) => {
      const bad = [{ ...VALID_SCENARIO_RESULTS[0], verdict: 'meh' }];
      scaffoldGood(root, { scenario: JSON.stringify(bad) });
      const report = runOnboardingDoctor({
        dir: root,
        slug: 'acme/widgets',
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      assert.notEqual(report.exitCode, 0, 'a precheck-failing scenario must fail the preflight');
      assert.equal(checkById(report, 'scenario-results').status, 'fail');
    });
  });

  it('the still-placeholder "CI" workflow trigger is a WARN, not a FAIL (exit 0)', () => {
    withTempDir((root) => {
      scaffoldGood(root, { workflow: PLACEHOLDER_WORKFLOW });
      const report = runOnboardingDoctor({
        dir: root,
        slug: 'acme/widgets',
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      assert.equal(checkById(report, 'workflow-trigger').status, 'warn',
        'an unedited "CI" placeholder is sub-ideal but usable → WARN');
      assert.equal(report.exitCode, 0, 'a WARN-only report must still exit 0 (doctor exit contract)');
    });
  });

  it('an undetectable repo slug is a WARN (exit 0)', () => {
    withTempDir((root) => {
      scaffoldGood(root);
      const report = runOnboardingDoctor({
        dir: root,
        slug: null,
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      assert.equal(checkById(report, 'repo-slug').status, 'warn');
      assert.equal(report.exitCode, 0);
    });
  });

  it('a missing scenario-results.json is a WARN, not a FAIL (the consumer may build it in CI)', () => {
    withTempDir((root) => {
      scaffoldGood(root, { scenario: null });
      const report = runOnboardingDoctor({
        dir: root,
        slug: 'acme/widgets',
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      const c = checkById(report, 'scenario-results');
      assert.equal(c.status, 'warn',
        'no scenario-results.json yet is normal pre-first-run → WARN, not FAIL');
      assert.equal(report.exitCode, 0);
    });
  });
});

function runInit(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [INIT_JS, ...args], {
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

describe('dogfood-init --check bin contract', () => {
  it('--check on a token-less setup exits nonzero and prints the checklist', () => {
    withTempDir((root) => {
      scaffoldGood(root);
      const { code, stdout } = runInit(['--check', '--dir', root], { env: {} });
      assert.notEqual(code, 0, 'missing DOGFOOD_TOKEN must fail --check');
      assert.match(stdout, /DOGFOOD_TOKEN/);
      assert.match(stdout, /\[FAIL\]/);
    });
  });

  it('--check on a complete setup exits 0', () => {
    withTempDir((root) => {
      scaffoldGood(root);
      const { code } = runInit(['--check', '--dir', root, '--slug', 'acme/widgets'], {
        env: { DOGFOOD_TOKEN: 'ghp_example' },
      });
      assert.equal(code, 0, 'a complete setup must pass --check');
    });
  });
});
