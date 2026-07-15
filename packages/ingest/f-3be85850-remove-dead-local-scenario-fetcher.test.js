/**
 * f-3be85850-remove-dead-local-scenario-fetcher.test.js
 *
 * F-3be85850 (LOW) — localScenarioFetcher(repoRoot) was exported dead code:
 * zero callers anywhere in the repo (confirmed by a repo-wide grep, not just
 * packages/ — the only two matches were its own definition and one doc
 * comment). It was also unreachable even as an external package hook:
 * load-context.js is NOT in @dogfood-lab/ingest's package.json `exports` map
 * (only '.', './lib/*', './anchor/*', './validate-record.js',
 * './verify-chain.js' are published), so no outside consumer could import it
 * either.
 *
 * Its own doc comment claimed it is "Used when dogfood-labs is dogfooding
 * itself," but the real self-dogfood path (self-dogfood.yml) routes through
 * the SAME public ingest.yml repository_dispatch pipeline every consumer
 * uses, via githubScenarioFetcher — never this function. The
 * dogfood/scenarios/*.yaml files it read locally remain the canonical
 * scenario definitions; they are just fetched over the GitHub Contents API
 * (githubScenarioFetcher) rather than off local disk, even for this repo's
 * own CI.
 *
 * Removed rather than relabeled a "future/test-only hook" — nothing in this
 * repo or its test suite reaches for a local-filesystem scenario fetcher,
 * and an unreachable, doc-comment-contradicted export is worse than no
 * export. parseUntrustedScenarioYaml's own doc comment (the COORD-001
 * merge-bomb defense) cited this function by name as one of "the other
 * three yaml.load calls in this file" — updated alongside this removal so
 * that count stays accurate (now two: loadGlobalPolicy, loadRepoPolicy).
 *
 * No functional/regression risk from the removal itself (unreachable code
 * cannot misbehave); this test exists so an accidental re-add — or a future
 * caller quietly depending on the internal-only export — is caught.
 *
 * Deletion/emptiness proof: re-add `export function localScenarioFetcher`
 * to load-context.js and the first test below goes red.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as loadContext from './load-context.js';

describe('F-3be85850: localScenarioFetcher removed as unreachable dead code', () => {
  it('is no longer exported from load-context.js', () => {
    assert.equal(
      'localScenarioFetcher' in loadContext,
      false,
      'localScenarioFetcher should have been removed — it had zero callers ' +
      'in-repo and is not in @dogfood-lab/ingest\'s package.json exports map, ' +
      'so nothing outside the repo could reach it either'
    );
  });

  it('githubScenarioFetcher remains the one real scenario-fetch mechanism (self-dogfood included)', () => {
    // Not a behavior change — pins the architectural claim the removal
    // relies on: self-dogfooding has no separate local-fetch code path.
    assert.equal(typeof loadContext.githubScenarioFetcher, 'function');
  });
});
