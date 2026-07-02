/**
 * F-41872706 (ingest observability): when scenario enforcement is ACTIVE,
 * the `scenario_enforcement` event logs `scenario_count` — the number of
 * scenarios the submission DECLARED. But an operator cannot tell from that
 * count whether any required_steps gate actually fired: a run showing
 * `active:true, scenario_count:2` is indistinguishable between "2 gates
 * enforced" and "2 scenarios, both true-404, enforcement skipped for every
 * one" without hand-parsing verification.warnings on the record.
 *
 * The residual gap F-b04473d5 left open: `loadScenarios` returns a
 * `scenarios` Map whose SIZE (definitions actually fetched) is consumed at
 * run.js and never emitted. This pin asserts the post-load `verify_complete`
 * event carries `scenarios_loaded` (the Map size) and
 * `required_steps_gates_fired` (loaded definitions with a non-empty
 * success_criteria.required_steps) so the loaded/enforceable count is
 * distinguishable from the declared count straight from the NDJSON stream.
 *
 * Observability-only: this changes no gate behavior and does not make
 * verify() emit logStage — verify() stays a pure function.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingest, verifyOnly } from './run.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEST_ROOT = resolve(__dirname, '__test_root_f41872706__');
const FIXTURES = resolve(__dirname, '../verify/fixtures');

let pilot0;

function copyDirSync(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, dstPath);
    else copyFileSync(srcPath, dstPath);
  }
}

function setupTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  copyDirSync(resolve(REPO_ROOT, 'policies'), resolve(TEST_ROOT, 'policies'));
  mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });
}

/**
 * Capture the NDJSON lines logStage writes to stderr (via console.error)
 * while `fn` runs, returning them parsed. Mirrors how ingest.yml's CI log
 * captures the stream, but in-process so the fake fetcher can drive a
 * deterministic mix of found + 404 scenarios.
 */
async function captureEvents(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines
    .filter(l => l.trimStart().startsWith('{'))
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * A submission that DECLARES two scenarios. The fetcher below resolves one
 * (carrying required_steps → a gate that fires) and 404s the other
 * (true-404 warning → enforcement skipped for that one). Declared count = 2,
 * loaded count = 1, gates fired = 1 — the three-way distinction the finding
 * is about.
 */
function mixedSubmission(runId) {
  const submission = structuredClone(pilot0);
  submission.run_id = runId;
  submission.scenario_results = [
    structuredClone(pilot0.scenario_results[0]),
    {
      ...structuredClone(pilot0.scenario_results[0]),
      scenario_id: 'scenario-deleted-upstream',
      scenario_name: 'Scenario whose definition 404s at the pinned commit',
    },
  ];
  return submission;
}

/**
 * fetchWithReason so a miss is a true-404 WARNING (not a scenario-load
 * error). The found definition carries required_steps satisfied by pilot-0's
 * step_results so the record still accepts — the point is the count fields,
 * not a rejection.
 */
const mixedFetcher = {
  async fetchWithReason(id) {
    if (id === 'record-ingest-roundtrip') {
      return { scenario: { success_criteria: { required_steps: ['emit-submission', 'write-record'] } } };
    }
    return { reason: 'not_found' };
  },
};

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('F-41872706: verify_complete distinguishes loaded gates from declared scenarios', () => {
  it('ingest() emits scenarios_loaded + required_steps_gates_fired reflecting the loaded, not declared, count', async () => {
    setupTestRoot();
    const submission = mixedSubmission('f41872706-ingest-001');

    let result;
    const events = await captureEvents(async () => {
      result = await ingest(submission, {
        repoRoot: TEST_ROOT,
        provenance: stubProvenance,
        scenarioFetcher: mixedFetcher,
      });
    });

    assert.equal(result.record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(result.record.verification.rejection_reasons)}`);

    const verifyComplete = events.find(e => e.stage === 'verify_complete');
    assert.ok(verifyComplete, `expected a verify_complete event; events=${JSON.stringify(events.map(e => e.stage))}`);

    assert.equal(verifyComplete.scenarios_loaded, 1,
      'loaded count is the Map size (1 fetched), not the declared count (2)');
    assert.equal(verifyComplete.required_steps_gates_fired, 1,
      'exactly one loaded definition carried a non-empty required_steps');
    assert.equal(verifyComplete.scenarios_warned, 1,
      'the true-404 definition is one warning');
    assert.equal(verifyComplete.scenarios_errored, 0);
  });

  it('verifyOnly() mirrors the loaded-count fields', async () => {
    setupTestRoot();
    const submission = mixedSubmission('f41872706-verifyonly-001');

    const events = await captureEvents(async () => {
      await verifyOnly(submission, {
        repoRoot: TEST_ROOT,
        provenance: stubProvenance,
        scenarioFetcher: mixedFetcher,
      });
    });

    const verifyComplete = events.find(e => e.stage === 'verify_complete');
    assert.ok(verifyComplete, `expected a verify_complete event; events=${JSON.stringify(events.map(e => e.stage))}`);
    assert.equal(verifyComplete.scenarios_loaded, 1);
    assert.equal(verifyComplete.required_steps_gates_fired, 1);
    assert.equal(verifyComplete.scenarios_warned, 1);
    assert.equal(verifyComplete.scenarios_errored, 0);
  });

  it('with no scenario fetcher (enforcement inactive) the fields are 0 — not absent', async () => {
    setupTestRoot();
    const submission = structuredClone(pilot0);
    submission.run_id = 'f41872706-inactive-001';

    const events = await captureEvents(async () => {
      await ingest(submission, {
        repoRoot: TEST_ROOT,
        provenance: stubProvenance,
        scenarioFetcher: null,
      });
    });

    const verifyComplete = events.find(e => e.stage === 'verify_complete');
    assert.ok(verifyComplete);
    assert.equal(verifyComplete.scenarios_loaded, 0);
    assert.equal(verifyComplete.required_steps_gates_fired, 0);
  });
});
