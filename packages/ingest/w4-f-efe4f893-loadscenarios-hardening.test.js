/**
 * w4-f-efe4f893-loadscenarios-hardening.test.js
 *
 * F-efe4f893 (wave 4 HIGH): loadScenarios runs BEFORE the schema gate on
 * untrusted consumer input (F-3bfc2885 wired the production fetch path), and
 * the old loop was not defensive:
 *   (a) scenario_results: [null] → `sr.scenario_id` threw an unhandled
 *       TypeError, which the CLI's outer catch misrouted as an OPERATIONAL
 *       incident (exit 2) with NO _rejected evidence record — a
 *       submission-bad payload classified as an ops fault, losing evidence.
 *   (b) a STRING scenario_results iterated CHARACTERS, and
 *       `/^[\w-]+$/.test(undefined)` coerced to the string 'undefined' and
 *       PASSED — issuing one real authenticated GitHub API request PER
 *       CHARACTER for dogfood/scenarios/undefined.yaml.
 *
 * Contract (coordinator-adjusted hardening route — no reorder):
 *   - non-array scenario_results → loadScenarios returns empty-handed,
 *     ZERO fetcher calls; verify() lands the authoritative schema rejection
 *     downstream. run.js step 3 additionally gates on Array.isArray in both
 *     ingest() and verifyOnly().
 *   - an entry that is not a non-null object with a string scenario_id is
 *     NEVER fetched; it pushes a typed `malformed_entry` error.
 *
 * DESIGN RULING (wave 4) — also pinned here because it governs this
 * finding: a true-404 definition (typed `not_found`) is NOT a rejection.
 * It surfaces on `warnings` and run.js lands it on verification.warnings
 * (the v1.6.0 accepted-with-warning channel); required-steps enforcement is
 * skipped for that scenario. Malformed committed files keep rejecting.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';
import { loadScenarios } from './load-context.js';
import { verifyOnly } from './run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

let pilot0;
before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(__dirname, '../verify/fixtures/pilot-0-submission.json'), 'utf-8'));
});

/** Fetcher that counts every call on both surfaces. */
function countingFetcher(result = { scenario: null, reason: 'not_found' }) {
  const calls = [];
  return {
    calls,
    async fetch(id) { calls.push(id); return null; },
    async fetchWithReason(id) { calls.push(id); return result; }
  };
}

describe('F-efe4f893 — loadScenarios is defensive against malformed pre-schema-gate input', () => {
  it('a [null] entry never crashes and never fetches — typed malformed_entry error', async () => {
    const fetcher = countingFetcher();
    const { scenarios, errors } = await loadScenarios({ scenario_results: [null] }, fetcher);
    assert.equal(scenarios.size, 0);
    assert.equal(fetcher.calls.length, 0, 'a null entry must NEVER reach the fetcher');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /reason: malformed_entry/);
  });

  it('a STRING scenario_results yields zero fetches (the per-character trap)', async () => {
    const fetcher = countingFetcher();
    const { scenarios, errors, warnings } = await loadScenarios({ scenario_results: 'abcde' }, fetcher);
    assert.equal(fetcher.calls.length, 0,
      'pre-fix this issued one authenticated GitHub fetch PER CHARACTER (undefined.yaml x5)');
    assert.equal(scenarios.size, 0);
    assert.deepEqual(errors, [], 'schema validation downstream is the authoritative rejection');
    assert.deepEqual(warnings, []);
  });

  it('a non-array object scenario_results yields zero fetches', async () => {
    const fetcher = countingFetcher();
    const result = await loadScenarios({ scenario_results: { a: 1 } }, fetcher);
    assert.equal(fetcher.calls.length, 0);
    assert.equal(result.scenarios.size, 0);
  });

  it('an entry with a non-string scenario_id is skipped with a typed error, never fetched', async () => {
    const fetcher = countingFetcher();
    const { errors } = await loadScenarios(
      { scenario_results: [{ scenario_id: 42 }, { a: 1 }, ['x']] },
      fetcher
    );
    assert.equal(fetcher.calls.length, 0);
    assert.equal(errors.length, 3);
    for (const e of errors) assert.match(e, /reason: malformed_entry/);
  });

  it('run.js gate: verifyOnly() with a string scenario_results never touches the fetcher and lands the schema rejection (exit-1 class)', async () => {
    const fetcher = countingFetcher();
    const submission = structuredClone(pilot0);
    submission.scenario_results = 'abcde';

    const result = await verifyOnly(submission, {
      repoRoot: REPO_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: fetcher
    });

    assert.equal(fetcher.calls.length, 0, 'the Array.isArray gate must keep a string payload away from the network');
    assert.equal(result.record.verification.status, 'rejected');
    assert.ok(
      result.record.verification.rejection_reasons.some(r => r.startsWith('schema:')),
      `expected the authoritative schema rejection; got ${JSON.stringify(result.record.verification.rejection_reasons)}`
    );
  });
});

describe('wave-4 DESIGN RULING — true-404 scenario definitions warn, never reject', () => {
  it('loadScenarios routes not_found to warnings[], not errors[]', async () => {
    const fetcher = countingFetcher({ scenario: null, reason: 'not_found' });
    const { scenarios, errors, warnings } = await loadScenarios(
      { scenario_results: [{ scenario_id: 'undeclared' }] },
      fetcher
    );
    assert.equal(scenarios.size, 0);
    assert.deepEqual(errors, [], 'nothing declared, nothing to enforce — not a rejection');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /scenario definition not found for "undeclared" — required_steps unenforced/);
  });

  it('malformed committed files (parse_error) still reject', async () => {
    const fetcher = countingFetcher({ scenario: null, reason: 'parse_error' });
    const { errors, warnings } = await loadScenarios(
      { scenario_results: [{ scenario_id: 'broken' }] },
      fetcher
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /reason: parse_error/);
    assert.deepEqual(warnings, []);
  });

  it('end-to-end: verifyOnly() accepts a submission whose definitions are absent, with the warning on verification.warnings', async () => {
    const fetcher = countingFetcher({ scenario: null, reason: 'not_found' });
    const submission = structuredClone(pilot0);
    submission.run_id = 'w4-notfound-warning-001';

    const result = await verifyOnly(submission, {
      repoRoot: REPO_ROOT,
      provenance: stubProvenance,
      scenarioFetcher: fetcher
    });

    assert.equal(result.record.verification.status, 'accepted',
      `reasons: ${JSON.stringify(result.record.verification.rejection_reasons)}`);
    assert.ok(Array.isArray(result.record.verification.warnings),
      'the v1.6.0 accepted-with-warning channel must carry the not-found note');
    assert.ok(
      result.record.verification.warnings.some(w => w.includes('required_steps unenforced')),
      `warnings: ${JSON.stringify(result.record.verification.warnings)}`
    );
  });
});
