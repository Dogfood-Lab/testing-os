/**
 * w4-f-9106e1ec-scenario-onboarding.test.js
 *
 * F-9106e1ec code half (wave 4): nothing in the consumer onboarding path
 * mentioned scenario DEFINITIONS (dogfood/scenarios/<id>.yaml), so a
 * consumer had no way to learn that required-steps enforcement is opt-in —
 * or which posture (enforced vs skipped-with-warning) their repo is in.
 *
 * Contract:
 *   - `dogfood-init`'s next-steps block carries an OPTIONAL
 *     scenario-definition step (opt-in framing, per the wave-4 DESIGN
 *     RULING: absent definition → accepted with a warning), with the
 *     DOGFOOD_TOKEN step still LAST and most prominent;
 *   - `runOnboardingDoctor` (--check) reports a `scenario-definitions`
 *     check: WARN when absent (opt-in, not fatal), PASS when definitions
 *     are committed;
 *   - the bundled dogfood.yml template documents the opt-in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOnboardingDoctor } from '@dogfood-lab/report/init.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const INIT_JS = resolve(__dirname, 'init.js');

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'report-scenario-onboarding-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('F-9106e1ec — scaffold output teaches the scenario-definition opt-in', () => {
  it('next steps mention dogfood/scenarios/<scenario_id>.yaml with opt-in framing, token step still last', () => {
    withTempDir((root) => {
      const stdout = execFileSync(
        process.execPath,
        [INIT_JS, '--dir', root, '--slug', 'acme/widgets'],
        { encoding: 'utf-8' }
      );
      assert.ok(stdout.includes('dogfood/scenarios/<scenario_id>.yaml'),
        'the onboarding block must name the scenario-definition path');
      assert.ok(/OPTIONAL/.test(stdout),
        'enforcement is opt-in — the framing must say so');
      assert.ok(stdout.includes('accepts your submission with a warning'),
        'the accepted-with-warning posture must be stated');
      const scenarioIdx = stdout.indexOf('dogfood/scenarios/<scenario_id>.yaml');
      const tokenIdx = stdout.indexOf('THE STEP EVERYONE FORGETS');
      assert.ok(tokenIdx > scenarioIdx,
        'the DOGFOOD_TOKEN step must remain the LAST, most prominent step');
    });
  });

  it('the bundled dogfood.yml template documents the opt-in', () => {
    const template = readFileSync(resolve(__dirname, 'templates', 'dogfood.yml'), 'utf-8');
    assert.ok(template.includes('dogfood/scenarios/<scenario_id>.yaml'));
    assert.match(template, /accepted with a warning/);
  });
});

describe('F-9106e1ec — the onboarding doctor reports the scenario-definition posture', () => {
  it('no dogfood/scenarios/ → WARN (opt-in, exit 0 class)', () => {
    withTempDir((root) => {
      const report = runOnboardingDoctor({ dir: root, slug: 'acme/widgets', env: { DOGFOOD_TOKEN: 'tok' } });
      const check = report.checks.find((c) => c.id === 'scenario-definitions');
      assert.ok(check, 'the doctor must include a scenario-definitions check');
      assert.equal(check.status, 'warn');
      assert.match(check.message, /required-steps enforcement is skipped/);
    });
  });

  it('an empty dogfood/scenarios/ dir → WARN', () => {
    withTempDir((root) => {
      mkdirSync(join(root, 'dogfood', 'scenarios'), { recursive: true });
      const report = runOnboardingDoctor({ dir: root, slug: 'acme/widgets', env: { DOGFOOD_TOKEN: 'tok' } });
      const check = report.checks.find((c) => c.id === 'scenario-definitions');
      assert.equal(check.status, 'warn');
      assert.match(check.message, /no \.yaml scenario definitions/);
    });
  });

  it('committed definitions → PASS with a count', () => {
    withTempDir((root) => {
      mkdirSync(join(root, 'dogfood', 'scenarios'), { recursive: true });
      writeFileSync(join(root, 'dogfood', 'scenarios', 'cli-smoke.yaml'), 'scenario_id: cli-smoke\n', 'utf-8');
      writeFileSync(join(root, 'dogfood', 'scenarios', 'e2e.yml'), 'scenario_id: e2e\n', 'utf-8');
      const report = runOnboardingDoctor({ dir: root, slug: 'acme/widgets', env: { DOGFOOD_TOKEN: 'tok' } });
      const check = report.checks.find((c) => c.id === 'scenario-definitions');
      assert.equal(check.status, 'pass');
      assert.match(check.message, /2 scenario definitions/);
    });
  });

  it('the WARN never flips the doctor exit code (opt-in must not gate onboarding)', () => {
    withTempDir((root) => {
      // A fully-good onboarding except the (optional) scenario definitions.
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        join(root, '.github', 'workflows', 'dogfood.yml'),
        'name: dogfood\non:\n  workflow_run:\n    workflows: ["My Suite"]\n    types: [completed]\n',
        'utf-8'
      );
      writeFileSync(join(root, 'policy.example.yaml'), 'repo: acme/widgets\n', 'utf-8');
      const report = runOnboardingDoctor({ dir: root, slug: 'acme/widgets', env: { DOGFOOD_TOKEN: 'tok' } });
      assert.equal(report.exitCode, 0,
        `a missing scenario definition is WARN-class; checks=${JSON.stringify(report.checks)}`);
    });
  });
});
