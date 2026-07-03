/**
 * lint-scenario.test.js (F-BACKEND-003) — integration tests for
 * lintScenario(scenarioDoc, { file }): the author-time scenario check that runs the
 * structural schema gate + the required_steps/duplicate-id value checks + the
 * filename → scenario_id advisory over a whole scenario definition, with NO
 * submission. Mirrors lint-policy.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { lintScenario } from './validators/lint-scenario.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVALID = resolve(__dirname, 'fixtures/scenarios/invalid');
const VALID = resolve(__dirname, 'fixtures/scenarios/valid');
const load = (dir, f) => yaml.load(readFileSync(resolve(dir, f), 'utf-8'));

describe('lintScenario: required_steps naming an undeclared step is an ERROR', () => {
  const file = resolve(INVALID, 'required-step-undeclared.yaml');
  const res = lintScenario(load(INVALID, 'required-step-undeclared.yaml'), { file });
  it('is not ok', () => assert.equal(res.ok, false));
  it('reports a scenario-config: required_step_undeclared error naming the offending id', () => {
    const e = res.errors.find(e => e.code === 'required_step_undeclared');
    assert.ok(e, `expected a required_step_undeclared error, got ${JSON.stringify(res.errors)}`);
    assert.equal(e.label, 'scenario-config:');
    assert.match(e.location, /required_steps\[1\]/);
    assert.match(e.message, /verify-output/);
  });
});

describe('lintScenario: a duplicate step id is an ERROR', () => {
  const file = resolve(INVALID, 'duplicate-step-id.yaml');
  const res = lintScenario(load(INVALID, 'duplicate-step-id.yaml'), { file });
  it('is not ok', () => assert.equal(res.ok, false));
  it('reports a scenario-config: duplicate_step_id error naming the duplicated id', () => {
    const e = res.errors.find(e => e.code === 'duplicate_step_id');
    assert.ok(e, `expected a duplicate_step_id error, got ${JSON.stringify(res.errors)}`);
    assert.equal(e.label, 'scenario-config:');
    assert.match(e.message, /build/);
  });
});

describe('lintScenario: a clean scenario reports no errors', () => {
  const file = resolve(VALID, 'clean.yaml');
  const res = lintScenario(load(VALID, 'clean.yaml'), { file });
  it('is ok', () => assert.equal(res.ok, true, JSON.stringify(res.errors)));
  it('has no errors', () => assert.equal(res.errors.length, 0));
});

describe('lintScenario: the filename → scenario_id mismatch is a WARNING (never blocks)', () => {
  // clean.yaml has basename "clean" but scenario_id "clean-cli-smoke".
  const file = resolve(VALID, 'clean.yaml');
  const res = lintScenario(load(VALID, 'clean.yaml'), { file });
  it('warns but stays ok:true', () => {
    assert.equal(res.ok, true);
    const w = res.warnings.find(w => w.code === 'filename_scenario_id_mismatch');
    assert.ok(w, `expected a filename_scenario_id_mismatch warning, got ${JSON.stringify(res.warnings)}`);
    assert.equal(w.label, 'scenario-footgun:');
    assert.match(w.message, /clean-cli-smoke/);
    assert.match(w.suggestion, /clean-cli-smoke\.yaml/);
  });
  it('skips the filename check when no file is provided', () => {
    const res2 = lintScenario(load(VALID, 'clean.yaml'));
    assert.equal(res2.warnings.length, 0);
  });
});

describe('lintScenario: a structurally-invalid scenario is a scenario-schema: ERROR', () => {
  // The two invalid value-check fixtures are schema-CLEAN by design; construct a schema
  // violation inline (missing required scenario_name) to prove the structural gate fires.
  const res = lintScenario({ scenario_id: 'x', scenario_version: '1.0.0' });
  it('is not ok', () => assert.equal(res.ok, false));
  it('reports at least one scenario-schema: error', () => {
    assert.ok(res.errors.some(e => e.label === 'scenario-schema:'), JSON.stringify(res.errors));
  });
});

describe('lintScenario: honest coverage note', () => {
  const res = lintScenario(load(VALID, 'clean.yaml'), { file: resolve(VALID, 'clean.yaml') });
  it('states what static lint cannot catch (step_results are submission-dependent)', () => {
    assert.match(res.coverageNote, /step_results/);
    assert.match(res.coverageNote, /submission/);
  });
});

describe('lintScenario: origin is scenario', () => {
  const res = lintScenario(load(VALID, 'clean.yaml'), { file: resolve(VALID, 'clean.yaml') });
  it('sets origin to scenario', () => assert.equal(res.origin, 'scenario'));
});

// ── Golden pin: the committed scenario definitions + the example lint the way
//    the repo currently stands. record-ingest-roundtrip.yaml + the example are
//    schema-clean and MUST lint clean; swarm-audit.yaml previously carried an
//    undocumented success_criteria.all_steps_pass field that the scenario schema
//    rejected (a long-known deferred sibling), which task_321f8a44 dropped as
//    redundant — required_steps already lists all six steps and nothing read the
//    flag. This pin asserts each committed file's ACTUAL lint state so it fails
//    loudly the day either the file or the schema changes. ────────────────────
describe('lintScenario: committed scenario definitions (golden pin)', () => {
  const DOGFOOD = resolve(__dirname, '../../dogfood/scenarios');
  const EXAMPLES = resolve(__dirname, '../../examples');

  it('record-ingest-roundtrip.yaml lints clean (schema-valid, no undeclared/duplicate steps)', () => {
    const file = resolve(DOGFOOD, 'record-ingest-roundtrip.yaml');
    const res = lintScenario(load(DOGFOOD, 'record-ingest-roundtrip.yaml'), { file });
    assert.equal(res.ok, true, `expected clean, got errors: ${JSON.stringify(res.errors)}`);
  });

  it('examples/scenario.example.yaml lints clean (the copy-me template)', () => {
    const file = resolve(EXAMPLES, 'scenario.example.yaml');
    const res = lintScenario(load(EXAMPLES, 'scenario.example.yaml'), { file });
    assert.equal(res.ok, true, `expected clean, got errors: ${JSON.stringify(res.errors)}`);
  });

  it('swarm-audit.yaml lints clean now that all_steps_pass is dropped (task_321f8a44)', () => {
    const file = resolve(DOGFOOD, 'swarm-audit.yaml');
    const res = lintScenario(load(DOGFOOD, 'swarm-audit.yaml'), { file });
    assert.equal(res.ok, true, `expected clean, got errors: ${JSON.stringify(res.errors)}`);
    assert.equal(res.errors.length, 0);
  });
});
