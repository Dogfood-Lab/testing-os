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
