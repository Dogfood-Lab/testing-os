/**
 * Regression test for the ci.yml trigger-path coverage of honesty surfaces
 * (d6-infra-001).
 *
 * Why this file exists: ci.yml's push AND pull_request `paths:` filters gate the
 * doc-drift / sync-version / schema-conformance gates. Before this fix those
 * filters listed packages/**, package*.json, tsconfig*.json, .github/**, docs/,
 * site/, swarms/PROTOCOL.md, and scripts/ — but NOT the repo-root honesty
 * surfaces the gates exist to protect (README.md, SHIP_GATE.md, SCORECARD.md,
 * CLAUDE.md, HANDOFF.md) nor the schema-conformance fixture tree
 * (swarms/__schema-fixtures__/**). So a commit editing ONLY a root honesty
 * surface or ONLY a fixture triggered no CI run at all — the gate built to stop
 * honesty-surface drift was bypassed at the trigger level for the exact files
 * it guards (a Class-#11-shaped vacuity one layer up from the handler logic).
 *
 * Why text-token assertions and not a YAML parse: same rationale as
 * check-lockfile-drift-ci.test.mjs — parsing YAML in a regression test pulls a
 * dependency in just for one fixture. We extract the two `paths:` blocks by
 * structure and assert each required entry is present in BOTH. This goes RED if
 * any future edit drops a surface from either trigger leg.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ciPath = resolve(repoRoot, '.github/workflows/ci.yml');

// The honesty surfaces + fixture tree whose drift the doc-drift / sync-version
// / schema-conformance gates exist to catch. Each MUST appear in both the push
// and pull_request paths filter, else a doc-only / fixture-only edit lands on
// main with no CI run.
const REQUIRED_PATHS = [
  'README.md',
  'SHIP_GATE.md',
  'SCORECARD.md',
  'CLAUDE.md',
  'HANDOFF.md',
  'swarms/__schema-fixtures__/**',
  // F-f2058e44: VERIFY-F3 added 'policies/**' to both ci.yml paths legs so a
  // policy-only edit fires scripts/lint-policies.test.mjs (the author-time
  // policy lint, run via test:scripts). Pin it here too: without this entry a
  // future ci.yml edit could drop 'policies/**' from a trigger leg and a
  // malformed/schema-invalid policy would land on main with no lint run, while
  // this very guard — built to catch that trigger-gap class — stayed green
  // because the dropped path was never in its list.
  'policies/**',
  // F-CI-001 (amended by F-5d126106): 'swarms/swarm-*/wave-*/outputs/**' used
  // to be REQUIRED here too, on the theory that a push touching ONLY live-run
  // wave outputs needed its own trigger. That trigger was dead on arrival:
  // swarms/.gitignore ignores `swarm-*/` wholesale, so a push can never
  // contain a path under swarms/swarm-*/ in the first place — the entry was
  // removed from ci.yml's paths filters, and it is deliberately NOT listed
  // here anymore. Do not re-add it without first removing the swarm-*/
  // ignore rule (or scoping a negation for wave-*/outputs/ specifically).
  // F-362d4131: runtime data dirs the test suite reads as REAL fixtures
  // (CLAUDE.md rule 6). setupTestRoot() copies from fixtures/; the scenario
  // validation suite (dogfood/scenarios/*.test.mjs, run via test:scripts)
  // reads dogfood/. A commit editing ONLY a fixture or scenario file must
  // trigger CI, else a fixture reshape that breaks the ingest/verify suite
  // lands on main green-by-absence — the same trigger-gap class as
  // d6-infra-001 above.
  'fixtures/**',
  'dogfood/**',
];

/**
 * Extract the list of quoted path entries from the `paths:` block that follows
 * a given trigger key (`push:` or `pull_request:`) in ci.yml.
 *
 * Walks line-by-line so it is robust to comment lines interleaved in the block
 * (the real ci.yml has them). Stops at the next top-level key (a `pull_request:`
 * / `workflow_dispatch:` / `jobs:` / etc. at the trigger indentation).
 */
function extractPathsFor(text, triggerKey) {
  const lines = text.split(/\r?\n/);
  let inTrigger = false;
  let inPaths = false;
  const found = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    // A trigger key like `  push:` (2-space indent under `on:`).
    if (/^\s{2}\S/.test(line)) {
      inTrigger = new RegExp(`^\\s{2}${triggerKey}:`).test(line);
      inPaths = false;
      continue;
    }
    if (!inTrigger) continue;
    if (/^\s{4}paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    // A new 4-space key inside the trigger (e.g. `tags:`) ends the paths block.
    if (inPaths && /^\s{4}\S/.test(line)) {
      inPaths = false;
    }
    if (inPaths) {
      const m = line.match(/^\s{6,}-\s*'([^']+)'/) || line.match(/^\s{6,}-\s*"([^"]+)"/);
      if (m) found.push(m[1]);
    }
  }
  return found;
}

test('ci.yml exists', () => {
  assert.ok(existsSync(ciPath), `expected workflow at ${ciPath}`);
});

test('d6-infra-001: push paths filter covers every honesty surface + the schema-fixture tree', () => {
  const text = readFileSync(ciPath, 'utf8');
  const pushPaths = extractPathsFor(text, 'push');
  assert.ok(pushPaths.length > 0, 'failed to extract any push paths — block parse broke');
  for (const p of REQUIRED_PATHS) {
    assert.ok(
      pushPaths.includes(p),
      `ci.yml push paths must include '${p}' — otherwise a commit editing ONLY this honesty surface triggers no CI run and its doc-drift / schema gate is bypassed at the trigger level (d6-infra-001).`,
    );
  }
});

test('d6-infra-001: pull_request paths filter covers every honesty surface + the schema-fixture tree', () => {
  const text = readFileSync(ciPath, 'utf8');
  const prPaths = extractPathsFor(text, 'pull_request');
  assert.ok(prPaths.length > 0, 'failed to extract any pull_request paths — block parse broke');
  for (const p of REQUIRED_PATHS) {
    assert.ok(
      prPaths.includes(p),
      `ci.yml pull_request paths must include '${p}' — otherwise a PR editing ONLY this honesty surface is never checked by the doc-drift / schema gate (d6-infra-001).`,
    );
  }
});

test('d6-infra-001: the gated honesty-surface files actually exist at repo root (the gate is non-vacuous)', () => {
  // Pin the filter to reality: each gated root file must exist, else the path
  // entry is dead and the test would pass while protecting nothing.
  for (const p of ['README.md', 'SHIP_GATE.md', 'SCORECARD.md', 'CLAUDE.md', 'HANDOFF.md']) {
    assert.ok(existsSync(resolve(repoRoot, p)), `gated honesty surface ${p} must exist at repo root`);
  }
  // And the fixture tree the schema-conformance check globs must exist with at
  // least its negative fixture (the one whose break the gate is meant to catch).
  assert.ok(
    existsSync(resolve(repoRoot, 'swarms/__schema-fixtures__/invalid-missing-domain.json')),
    'the schema-conformance negative fixture must exist under swarms/__schema-fixtures__/',
  );
});

test('F-5d126106: neither paths filter lists the dead swarm-outputs trigger (structurally unmatchable — swarms/.gitignore ignores swarm-*/ wholesale)', () => {
  const text = readFileSync(ciPath, 'utf8');
  const gitignorePath = resolve(repoRoot, 'swarms/.gitignore');
  assert.ok(existsSync(gitignorePath), 'swarms/.gitignore must exist — this test\'s premise depends on it');
  const gitignore = readFileSync(gitignorePath, 'utf8');
  assert.match(
    gitignore,
    /^swarm-\*\/\s*$/m,
    'swarms/.gitignore must still ignore swarm-*/ wholesale — if this ever changes, the dead-trigger reasoning below no longer holds and the F-CI-001 removal should be revisited',
  );
  for (const trigger of ['push', 'pull_request']) {
    const paths = extractPathsFor(text, trigger);
    assert.ok(
      !paths.includes('swarms/swarm-*/wave-*/outputs/**'),
      `ci.yml ${trigger} paths must NOT list 'swarms/swarm-*/wave-*/outputs/**' — it can never match a tracked file (swarms/.gitignore ignores swarm-*/ wholesale) and re-adding it re-introduces the dead-trigger F-CI-001 documented gate coverage that never actually existed`,
    );
  }
});
