/**
 * w4-f-b04473d5-scenario-enforcement-visibility.test.js
 *
 * F-b04473d5 (wave 4): resolveScenarioFetcher returned null silently in
 * every ineligible branch (gitlab provider, missing token, non-string
 * repo/sha), and no NDJSON event recorded whether scenario definitions were
 * fetched / required_steps enforcement was active for a given ingest. An
 * operator auditing an accepted record could not distinguish "enforced and
 * satisfied" from "enforcement skipped" from the run log.
 *
 * Contract:
 *   - `resolveScenarioFetcherDecision` names the skip class per branch;
 *   - the CLI emits a structured `scenario_enforcement` NDJSON event
 *     (active + reason + scenario_count) alongside the pipeline stages.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';
import { resolveScenarioFetcher, resolveScenarioFetcherDecision } from './run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const realProvenance = { confirm: async () => true };
const githubSubmission = {
  repo: 'org/repo',
  ref: { commit_sha: 'deadbeef' },
  source: { provider: 'github' },
};
const ENV = { GITHUB_TOKEN: 'tok' };

let pilot0;
before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(__dirname, '../verify/fixtures/pilot-0-submission.json'), 'utf-8'));
});

describe('F-b04473d5 — resolveScenarioFetcherDecision names every skip class', () => {
  it('active path: github + real provenance + token → active:true, reason:null, fetcher present', () => {
    const d = resolveScenarioFetcherDecision(realProvenance, githubSubmission, ENV);
    assert.equal(d.active, true);
    assert.equal(d.reason, null);
    assert.ok(d.fetcher);
  });

  it('stub provenance → stub-provenance', () => {
    const d = resolveScenarioFetcherDecision(stubProvenance, githubSubmission, ENV);
    assert.deepEqual({ active: d.active, reason: d.reason, fetcher: d.fetcher },
      { active: false, reason: 'stub-provenance', fetcher: null });
  });

  it('gitlab provider → provider-unsupported (the documented gap, now visible)', () => {
    const sub = { ...githubSubmission, source: { provider: 'gitlab' } };
    assert.equal(resolveScenarioFetcherDecision(realProvenance, sub, ENV).reason, 'provider-unsupported');
  });

  it('missing token → no-token', () => {
    assert.equal(resolveScenarioFetcherDecision(realProvenance, githubSubmission, {}).reason, 'no-token');
  });

  it('malformed submission / missing fields name their class', () => {
    assert.equal(resolveScenarioFetcherDecision(realProvenance, null, ENV).reason, 'submission-malformed');
    assert.equal(resolveScenarioFetcherDecision(realProvenance, [], ENV).reason, 'submission-malformed');
    assert.equal(resolveScenarioFetcherDecision(realProvenance, { repo: 42, ref: { commit_sha: 'x' } }, ENV).reason, 'repo-not-string');
    assert.equal(resolveScenarioFetcherDecision(realProvenance, { repo: 'org/repo', ref: {} }, ENV).reason, 'commit-sha-not-string');
  });

  it('resolveScenarioFetcher stays a thin wrapper (V2-INVARIAN-004 contract preserved)', () => {
    assert.ok(resolveScenarioFetcher(realProvenance, githubSubmission, ENV));
    assert.equal(resolveScenarioFetcher(stubProvenance, githubSubmission, ENV), null);
  });
});

describe('F-b04473d5 — the CLI emits a scenario_enforcement NDJSON event', () => {
  it('stub-provenance verify-only run logs active:false with the reason and scenario_count', () => {
    const child = spawnSync(
      process.execPath,
      [resolve(__dirname, 'run.js'), '--provenance=stub', '--verify-only'],
      {
        input: JSON.stringify(pilot0),
        encoding: 'utf-8',
        env: {
          ...process.env,
          CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '',
          DOGFOOD_LOG_HUMAN: '0'
        }
      }
    );

    const events = child.stderr
      .split('\n')
      .filter(l => l.startsWith('{'))
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const enforcement = events.find(e => e.stage === 'scenario_enforcement');
    assert.ok(enforcement,
      `expected a scenario_enforcement event; stderr=${child.stderr.slice(0, 800)}`);
    assert.equal(enforcement.active, false);
    assert.equal(enforcement.reason, 'stub-provenance');
    assert.equal(enforcement.scenario_count, pilot0.scenario_results.length);
    assert.equal(enforcement.component, 'ingest');
  });
});
