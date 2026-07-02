/**
 * v2-cross-bo-003-slug-guard.test.js
 *
 * V2-CROSS-BO-003 (wave-2 fix-up) — third unguarded `split('/')` site family.
 * F-54e5fde7 established the two-segment contract (nested GitLab subgroups
 * UNSUPPORTED; a 3+-segment slug fails closed) and fixed loadRepoPolicy +
 * verify cli.js. Two sites were missed:
 *
 *   1. githubScenarioFetcher (load-context.js): `const [org, repo] =
 *      repoSlug.split('/')` silently dropped the tail AND the authenticated
 *      URL was built from the RAW slug — `org/repo/extra` reached the
 *      Bearer-token GitHub API URL verbatim.
 *   2. computeRecordPath (persist.js): same destructure silently dropped the
 *      third segment, filing the record under a DIFFERENT repo's path.
 *
 * Fix contract pinned here: segments.length === 2 fail-closed guard at both
 * sites; the authenticated URL is built from the VALIDATED org/repo, never
 * the raw slug.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';

import { githubScenarioFetcher } from './load-context.js';
import { computeRecordPath } from './persist.js';

const VALID_SHA = 'deadbeef';

const VALID_SCENARIO_YAML = [
  'scenario_id: sanity',
  'scenario_name: Sanity smoke',
  'scenario_version: 1.0.0',
  'product_surface: cli',
  'execution_mode: bot',
  'description: Smoke-checks the CLI happy path.',
  'steps:',
  '  - id: one',
  '    action: run the CLI once',
  'success_criteria:',
  '  required_steps:',
  '    - one',
  ''
].join('\n');

describe('V2-CROSS-BO-003 — githubScenarioFetcher two-segment slug guard', () => {
  it('a 3-segment slug fails closed (invalid_id) and never reaches the authenticated fetch', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, async text() { return VALID_SCENARIO_YAML; } }; };
    const fetcher = githubScenarioFetcher('tok', 'org/repo/extra', VALID_SHA, { fetchImpl });

    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.scenario, null);
    assert.equal(result.reason, 'invalid_id',
      `a 3+-segment slug must fail closed; got ${JSON.stringify(result)}`);
    assert.equal(calls, 0, 'the raw slug must never reach the Bearer-token URL');
  });

  it('a 1-segment slug fails closed too', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, async text() { return VALID_SCENARIO_YAML; } }; };
    const fetcher = githubScenarioFetcher('tok', 'orgonly', VALID_SHA, { fetchImpl });
    const result = await fetcher.fetchWithReason('sanity');
    assert.equal(result.reason, 'invalid_id');
    assert.equal(calls, 0);
  });

  it('GREEN: a two-segment slug fetches, with the URL built from the validated org/repo', async () => {
    let fetchedUrl = null;
    const fetchImpl = async (url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, async text() { return VALID_SCENARIO_YAML; } };
    };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, { fetchImpl });

    const result = await fetcher.fetchWithReason('sanity');
    assert.ok(result.scenario, `two-segment slug must fetch; got ${JSON.stringify(result)}`);
    assert.match(fetchedUrl, /^https:\/\/api\.github\.com\/repos\/org\/repo\/contents\//,
      'URL must be built from the validated segments');
  });
});

describe('V2-CROSS-BO-003 — computeRecordPath two-segment fail-closed guard', () => {
  const baseRecord = {
    run_id: 'run-1',
    verification: { status: 'accepted' },
    timing: { finished_at: '2026-07-01T00:00:00Z' },
  };

  it('a 3-segment record.repo throws instead of silently dropping the tail', () => {
    assert.throws(
      () => computeRecordPath({ ...baseRecord, repo: 'group/subgroup/project' }, '/tmp/root'),
      /invalid repo format/,
      'org/repo/extra must fail closed — the old destructure filed it under org/repo'
    );
  });

  it('GREEN: a two-segment record.repo computes the canonical path', () => {
    const path = computeRecordPath({ ...baseRecord, repo: 'org/repo' }, '/tmp/root');
    assert.ok(path.includes(`${sep}org${sep}repo${sep}`),
      `expected the org/repo shard in ${path}`);
  });
});
